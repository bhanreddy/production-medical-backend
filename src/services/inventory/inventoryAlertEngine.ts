// inventoryAlertEngine.ts — Deterministic Inventory Alert Generator & Lifecycle Manager
import { localDb } from '../../local-db';
import { v4 as uuidv4 } from 'uuid';
import { AlertType, AlertSeverity, AlertStatus } from '../../domain/inventoryTypes';

export interface CreateAlertParams {
  organizationId: string;
  storeId?: string | null;
  warehouseId?: string | null;
  medicineId?: string | null;
  batchId?: string | null;
  alertType: AlertType;
  severity?: AlertSeverity;
  title: string;
  message: string;
  metadata?: any;
  dedupKey?: string;
}

export class InventoryAlertEngine {
  /**
   * Create or update a deduplicated inventory alert
   */
  static createOrUpdateAlert(params: CreateAlertParams): any {
    const {
      organizationId,
      storeId = null,
      warehouseId = null,
      medicineId = null,
      batchId = null,
      alertType,
      severity = 'WARNING',
      title,
      message,
      metadata = {},
      dedupKey = `${organizationId}_${storeId || 'all'}_${medicineId || 'all'}_${batchId || 'all'}_${alertType}`,
    } = params;

    const existing: any = localDb
      .prepare('SELECT * FROM inventory_alerts WHERE dedup_key = ?')
      .get(dedupKey);

    const now = new Date().toISOString();

    if (existing) {
      if (existing.status === 'RESOLVED' || existing.status === 'DISMISSED') {
        localDb
          .prepare(
            `UPDATE inventory_alerts 
             SET status = 'OPEN', severity = ?, title = ?, message = ?,
                 metadata = ?, updated_at = ?, _updated_at = ?
             WHERE id = ?`
          )
          .run(severity, title, message, JSON.stringify(metadata), now, now, existing.id);
      }
      return localDb.prepare('SELECT * FROM inventory_alerts WHERE id = ?').get(existing.id);
    }

    const id = uuidv4();
    localDb
      .prepare(
        `INSERT INTO inventory_alerts (
          id, _local_id, organization_id, store_id, warehouse_id, medicine_id, batch_id,
          alert_type, severity, title, message, status, metadata, dedup_key,
          created_at, updated_at, _updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        id,
        organizationId,
        storeId,
        warehouseId,
        medicineId,
        batchId,
        alertType,
        severity,
        title,
        message,
        JSON.stringify(metadata),
        dedupKey,
        now,
        now,
        now
      );

    return localDb.prepare('SELECT * FROM inventory_alerts WHERE id = ?').get(id);
  }

  /**
   * Acknowledge or Resolve an alert
   */
  static updateAlertStatus(params: {
    alertId: string;
    status: AlertStatus;
    acknowledgedBy?: string;
  }): any {
    const { alertId, status, acknowledgedBy = 'USER' } = params;
    const now = new Date().toISOString();

    localDb
      .prepare(
        `UPDATE inventory_alerts 
         SET status = ?, acknowledged_by = ?, acknowledged_at = ?,
             updated_at = ?, _updated_at = ?
         WHERE id = ? OR _local_id = ?`
      )
      .run(status, acknowledgedBy, now, now, now, alertId, alertId);

    return localDb.prepare('SELECT * FROM inventory_alerts WHERE id = ?').get(alertId);
  }

  /**
   * List active alerts
   */
  static listAlerts(params: {
    organizationId: string;
    storeId?: string | null;
    status?: AlertStatus;
  }): any[] {
    const { organizationId, storeId = null, status = 'OPEN' } = params;

    let query = `
      SELECT ia.*, m.name as medicine_name
      FROM inventory_alerts ia
      LEFT JOIN medicines m ON m.id = ia.medicine_id
      WHERE ia.organization_id = ? AND ia.status = ?
    `;
    const queryParams: any[] = [organizationId, status];

    if (storeId) {
      query += ` AND (ia.store_id = ? OR ia.store_id IS NULL)`;
      queryParams.push(storeId);
    }

    query += ` ORDER BY CASE ia.severity WHEN 'CRITICAL' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, ia.created_at DESC`;

    return localDb.prepare(query).all(...queryParams);
  }
}
