// productRecallEngine.ts — Enterprise Drug Recall, Multi-Location Quarantine & Full Sales/Rx Traceability
import { localDb } from '../../local-db';
import { v4 as uuidv4 } from 'uuid';
import {
  RecallType,
  RecallSeverity,
  RecallStatus,
  RecallTaskStatus,
} from '../../domain/inventoryTypes';
import { InventoryPositionService } from '../inventoryPosition';
import { AppError } from '../../lib/appError';

export interface CreateRecallParams {
  organizationId: string;
  recallReference: string;
  recallType?: RecallType;
  productId: string;
  batchId?: string | null;
  batchNumber?: string | null;
  manufacturer?: string;
  reason: string;
  severity?: RecallSeverity;
  createdBy: string;
  metadata?: any;
}

export class ProductRecallEngine {
  /**
   * Create a new product recall draft
   */
  static createRecall(params: CreateRecallParams): any {
    const {
      organizationId,
      recallReference,
      recallType = 'BATCH',
      productId,
      batchId = null,
      batchNumber = null,
      manufacturer = '',
      reason,
      severity = 'CLASS_I',
      createdBy,
      metadata = {},
    } = params;

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO product_recalls (
          id, _local_id, organization_id, recall_reference, recall_type,
          product_id, batch_id, batch_number, manufacturer, reason,
          severity, status, initiated_at, created_by, metadata,
          created_at, updated_at, _updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        id,
        organizationId,
        recallReference,
        recallType,
        productId,
        batchId,
        batchNumber,
        manufacturer,
        reason,
        severity,
        now,
        createdBy,
        JSON.stringify(metadata),
        now,
        now,
        now
      );

    return this.getRecall(id);
  }

  /**
   * Retrieve recall by ID
   */
  static getRecall(id: string): any {
    const row: any = localDb
      .prepare(
        `SELECT pr.*, m.name as product_name, m.generic_name
         FROM product_recalls pr
         JOIN medicines m ON m.id = pr.product_id
         WHERE pr.id = ? OR pr._local_id = ?`
      )
      .get(id, id);

    if (!row) return null;

    const tasks: any[] = localDb
      .prepare('SELECT * FROM recall_tasks WHERE recall_id = ? ORDER BY created_at ASC')
      .all(row.id);

    return {
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata,
      tasks,
    };
  }

  /**
   * Activate recall: Immediately locks inventory across all stores/warehouses and creates location quarantine tasks
   */
  static activateRecall(recallId: string, activatedBy: string): any {
    const recall = this.getRecall(recallId);
    if (!recall) throw new AppError(404, 'Recall not found', 'NOT_FOUND');

    const now = new Date().toISOString();

    // 1. Locate all inventory positions across stores and warehouses with stock for this product/batch
    let posQuery = `
      SELECT ip.*, s.name as store_name, w.name as warehouse_name
      FROM inventory_positions ip
      LEFT JOIN stores s ON s.id = ip.store_id
      LEFT JOIN warehouses w ON w.id = ip.warehouse_id
      WHERE ip.organization_id = ? AND ip.medicine_id = ? AND ip.quantity_on_hand > 0
    `;
    const posParams: any[] = [recall.organization_id, recall.product_id];

    if (recall.batch_id) {
      posQuery += ` AND ip.batch_id = ?`;
      posParams.push(recall.batch_id);
    }

    const affectedPositions: any[] = localDb.prepare(posQuery).all(...posParams);

    // 2. Lock stock in inventory_positions & create location tasks
    for (const pos of affectedPositions) {
      const onHand = Number(pos.quantity_on_hand || 0);

      // Lock as recalled in position
      InventoryPositionService.updateStateQuantities({
        organizationId: recall.organization_id,
        medicineId: pos.medicine_id,
        batchId: pos.batch_id,
        locationType: pos.location_type,
        storeId: pos.store_id,
        warehouseId: pos.warehouse_id,
        recalledDelta: onHand - Number(pos.quantity_recalled || 0),
      });

      // Create location recall task
      const taskId = uuidv4();
      localDb
        .prepare(
          `INSERT INTO recall_tasks (
            id, _local_id, recall_id, organization_id, store_id, warehouse_id,
            location_type, expected_units, quarantined_units, discrepancy_units,
            status, assigned_to, created_at, updated_at, _updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'PENDING', ?, ?, ?, ?)`
        )
        .run(
          taskId,
          taskId,
          recall.id,
          recall.organization_id,
          pos.store_id,
          pos.warehouse_id,
          pos.location_type,
          onHand,
          activatedBy,
          now,
          now,
          now
        );
    }

    // 3. Update recall status to ACTIVE
    localDb
      .prepare(
        `UPDATE product_recalls 
         SET status = 'ACTIVE', updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, recall.id);

    return this.getRecall(recallId);
  }

  /**
   * Complete a recall task for a location (quarantine count confirmed)
   */
  static completeTask(params: {
    taskId: string;
    quarantinedUnits: number;
    completedBy: string;
    notes?: string;
  }): any {
    const { taskId, quarantinedUnits, completedBy, notes = '' } = params;
    const task: any = localDb.prepare('SELECT * FROM recall_tasks WHERE id = ?').get(taskId);
    if (!task) throw new AppError(404, 'Recall task not found', 'NOT_FOUND');

    const expected = Number(task.expected_units || 0);
    const discrepancy = expected - quarantinedUnits;
    const now = new Date().toISOString();

    localDb
      .prepare(
        `UPDATE recall_tasks 
         SET quarantined_units = ?, discrepancy_units = ?, status = 'COMPLETED',
             completed_by = ?, completed_at = ?, notes = ?, updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(quarantinedUnits, discrepancy, completedBy, now, notes, now, now, taskId);

    return localDb.prepare('SELECT * FROM recall_tasks WHERE id = ?').get(taskId);
  }

  /**
   * Trace historical sales and customer records associated with the recalled product/batch
   */
  static traceHistoricalSales(params: {
    organizationId: string;
    productId: string;
    batchId?: string | null;
  }): {
    totalUnitsSold: number;
    totalInvoicesCount: number;
    identifiedCustomersCount: number;
    anonymousCustomersCount: number;
    invoices: {
      saleId: string;
      invoiceNumber: string;
      saleDate: string;
      storeId: string;
      quantitySold: number;
      customerName: string;
      customerPhone: string;
      isPrescription: boolean;
    }[];
  } {
    const { organizationId, productId, batchId = null } = params;

    let query = `
      SELECT si.sale_id, si.quantity as sold_qty, si.unit_type,
             s.invoice_number, s.sale_date, s.store_id, s.customer_id,
             s.prescription_required, s.prescription_number,
             c.name as customer_name, c.phone as customer_phone
      FROM sale_items si
      JOIN sales s ON (s.id = si.sale_id OR s._local_id = si.sale_id) AND (s.is_return = 0 OR s.is_return IS NULL)
      LEFT JOIN customers c ON (c.id = s.customer_id OR c._local_id = s.customer_id)
      WHERE s.organization_id = ? AND (si.medicine_id = ? OR si.medicine_id = ?)
    `;
    const queryParams: any[] = [organizationId, productId, productId];

    if (batchId) {
      query += ` AND si.batch_id = ?`;
      queryParams.push(batchId);
    }

    query += ` ORDER BY s.sale_date DESC`;

    const rows: any[] = localDb.prepare(query).all(...queryParams);

    let totalUnitsSold = 0;
    let identifiedCustomersCount = 0;
    let anonymousCustomersCount = 0;
    const seenCustomers = new Set<string>();

    const invoices = rows.map((r) => {
      const qty = Number(r.sold_qty || 0);
      totalUnitsSold += qty;

      if (r.customer_name && r.customer_name !== 'Walk-in Customer') {
        if (!seenCustomers.has(r.customer_name)) {
          seenCustomers.add(r.customer_name);
          identifiedCustomersCount++;
        }
      } else {
        anonymousCustomersCount++;
      }

      return {
        saleId: r.sale_id,
        invoiceNumber: r.invoice_number || 'N/A',
        saleDate: r.sale_date || '',
        storeId: r.store_id || '',
        quantitySold: qty,
        customerName: r.customer_name || 'Walk-in Customer',
        customerPhone: r.customer_phone || '',
        isPrescription: Boolean(r.prescription_required || r.prescription_number),
      };
    });

    return {
      totalUnitsSold,
      totalInvoicesCount: invoices.length,
      identifiedCustomersCount,
      anonymousCustomersCount,
      invoices,
    };
  }

  /**
   * Trace prescription dispensing events associated with the recalled product/batch
   */
  static tracePrescriptionDispensing(params: {
    organizationId: string;
    productId: string;
    batchId?: string | null;
  }): any[] {
    const { organizationId, productId, batchId = null } = params;

    let query = `
      SELECT de.*, p.prescription_number, p.doctor_name_snapshot, p.doctor_registration_number_snapshot,
             c.name as patient_name, c.phone as patient_phone
      FROM dispensing_events de
      JOIN prescriptions p ON p.id = de.prescription_id
      LEFT JOIN customers c ON c.id = p.patient_id
      WHERE de.organization_id = ? AND de.product_id = ?
    `;
    const queryParams: any[] = [organizationId, productId];

    if (batchId) {
      query += ` AND de.batch_id = ?`;
      queryParams.push(batchId);
    }

    query += ` ORDER BY de.dispensed_at DESC`;

    return localDb.prepare(query).all(...queryParams);
  }
}
