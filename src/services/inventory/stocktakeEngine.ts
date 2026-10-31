// stocktakeEngine.ts — Enterprise Stocktake & Physical Counting Engine
import { localDb } from '../../local-db';
import { v4 as uuidv4 } from 'uuid';
import {
  StocktakeType,
  CountingMode,
  StocktakeStatus,
  VarianceReason,
  StocktakeSessionRecord,
  StocktakeItemRecord,
} from '../../domain/inventoryTypes';
import { InventoryPositionService } from '../inventoryPosition';
import { AppError } from '../../lib/appError';

export interface CreateStocktakeParams {
  organizationId: string;
  storeId?: string | null;
  warehouseId?: string | null;
  name: string;
  type?: StocktakeType;
  scope?: {
    category?: string;
    medicineIds?: string[];
    rackIds?: string[];
    abcClass?: string;
  };
  countingMode?: CountingMode;
  isBlindCount?: boolean;
  isDoubleCount?: boolean;
  initiatedBy: string;
  notes?: string;
}

export class StocktakeEngine {
  /**
   * Create a new stocktake session
   */
  static createSession(params: CreateStocktakeParams): StocktakeSessionRecord {
    const {
      organizationId,
      storeId = null,
      warehouseId = null,
      name,
      type = 'FULL',
      scope = {},
      countingMode = 'LIVE_COUNT',
      isBlindCount = false,
      isDoubleCount = false,
      initiatedBy,
      notes = '',
    } = params;

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO stocktake_sessions (
          id, _local_id, organization_id, store_id, warehouse_id, name, type,
          scope, counting_mode, is_blind_count, is_double_count, status,
          initiated_by, reference_timestamp, created_at, updated_at, _updated_at, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        id,
        organizationId,
        storeId,
        warehouseId,
        name,
        type,
        JSON.stringify(scope),
        countingMode,
        isBlindCount ? 1 : 0,
        isDoubleCount ? 1 : 0,
        initiatedBy,
        now,
        now,
        now,
        now,
        notes
      );

    return this.getSession(id)!;
  }

  /**
   * Retrieve session by ID
   */
  static getSession(id: string): StocktakeSessionRecord | null {
    const row: any = localDb
      .prepare('SELECT * FROM stocktake_sessions WHERE id = ? OR _local_id = ?')
      .get(id, id);

    if (!row) return null;

    return {
      ...row,
      scope: typeof row.scope === 'string' ? JSON.parse(row.scope || '{}') : row.scope,
      is_blind_count: Boolean(row.is_blind_count),
      is_double_count: Boolean(row.is_double_count),
    } as StocktakeSessionRecord;
  }

  /**
   * Start a stocktake session and snapshot expected inventory at reference_timestamp
   */
  static startSession(sessionId: string, userId: string): StocktakeSessionRecord {
    const session = this.getSession(sessionId);
    if (!session) throw new AppError(404, 'Stocktake session not found', 'NOT_FOUND');

    if (session.status !== 'DRAFT' && session.status !== 'PLANNED') {
      throw new AppError(400, `Cannot start session in status ${session.status}`, 'INVALID_STATUS');
    }

    const now = new Date().toISOString();
    const locationCol = session.store_id ? 'store_id' : 'warehouse_id';
    const locationId = session.store_id || session.warehouse_id;

    // Fetch candidate batches based on scope
    let medicineClause = '';
    const queryParams: any[] = [session.organization_id];

    if (session.scope?.medicineIds && session.scope.medicineIds.length > 0) {
      const placeholders = session.scope.medicineIds.map(() => '?').join(',');
      medicineClause += ` AND m.id IN (${placeholders})`;
      queryParams.push(...session.scope.medicineIds);
    } else if (session.scope?.category) {
      medicineClause += ` AND m.category = ?`;
      queryParams.push(session.scope.category);
    }    let batchQuery = `
      SELECT mb.id as batch_id, mb.batch_number, mb.expiry_date, mb.medicine_id,
             mb.purchase_price,
             COALESCE(ip.quantity_on_hand, mb.quantity_remaining, 0) as expected_qty
      FROM medicines m
      JOIN medicine_batches mb ON (mb.medicine_id = m.id OR mb.medicine_id = m._local_id) 
        AND (mb._deleted = 0 OR mb._deleted IS NULL) 
        AND (mb.is_disposed = 0 OR mb.is_disposed IS NULL)
      LEFT JOIN inventory_positions ip ON ip.batch_id = mb.id 
        AND ip.organization_id = ? 
        AND ${locationId ? `ip.${locationCol} = ?` : `ip.${locationCol} IS NULL`}
      WHERE (m._deleted = 0 OR m._deleted IS NULL) AND (m.organization_id = ?)
      ${medicineClause}
    `;

    const allParams = locationId
      ? [session.organization_id, locationId, ...queryParams]
      : [session.organization_id, ...queryParams];

    const candidateBatches: any[] = localDb.prepare(batchQuery).all(...allParams);

    // Populate stocktake_items snapshot
    const insertStmt = localDb.prepare(`
      INSERT INTO stocktake_items (
        id, _local_id, stocktake_id, organization_id, medicine_id, batch_id,
        batch_number, expiry_date, expected_quantity, physical_quantity, difference,
        unit_cost_paise, value_difference_paise, recount_status, created_at, updated_at, _updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'NONE', ?, ?, ?)
    `);

    for (const b of candidateBatches) {
      const itemId = uuidv4();
      const expectedQty = Number(b.expected_qty || 0);
      const unitCost = Math.round((Number(b.purchase_price) || 0) * 100);
      const diff = -expectedQty; // initially 0 physical - expected
      const valueDiff = diff * unitCost;

      insertStmt.run(
        itemId,
        itemId,
        sessionId,
        session.organization_id,
        b.medicine_id,
        b.batch_id,
        b.batch_number,
        b.expiry_date,
        expectedQty,
        diff,
        unitCost,
        valueDiff,
        now,
        now,
        now
      );
    }

    localDb
      .prepare(
        `UPDATE stocktake_sessions 
         SET status = 'IN_PROGRESS', started_at = ?, reference_timestamp = ?, updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, now, now, session.id);

    return this.getSession(sessionId)!;
  }

  /**
   * Log a physical count entry (Barcode scan, manual count, or double count)
   */
  static recordCount(params: {
    stocktakeId: string;
    medicineId: string;
    batchId?: string | null;
    counterName?: string;
    userId: string;
    scannedBarcode?: string;
    rawQuantity: number;
    unitType?: string;
    conversionFactor?: number;
    deviceId?: string;
    isOfflineSync?: boolean;
    counterRole?: 'COUNTER_A' | 'COUNTER_B';
  }): { countId: string; stocktakeItemId: string; physicalQuantity: number; difference: number } {
    const {
      stocktakeId,
      medicineId,
      batchId = null,
      counterName = 'Default Counter',
      userId,
      scannedBarcode = '',
      rawQuantity,
      unitType = 'BASE',
      conversionFactor = 1.0,
      deviceId = 'POS-1',
      isOfflineSync = false,
      counterRole = 'COUNTER_A',
    } = params;

    const session = this.getSession(stocktakeId);
    if (!session) throw new AppError(404, 'Stocktake session not found', 'NOT_FOUND');
    if (session.status !== 'IN_PROGRESS') {
      throw new AppError(400, `Cannot record count in status ${session.status}`, 'INVALID_STATUS');
    }

    const baseQuantity = rawQuantity * conversionFactor;
    const now = new Date().toISOString();

    // Find or create matching stocktake_item
    let item: any = batchId
      ? localDb
          .prepare(
            `SELECT * FROM stocktake_items 
             WHERE stocktake_id = ? AND medicine_id = ? AND batch_id = ?`
          )
          .get(stocktakeId, medicineId, batchId)
      : localDb
          .prepare(
            `SELECT * FROM stocktake_items 
             WHERE stocktake_id = ? AND medicine_id = ?`
          )
          .get(stocktakeId, medicineId);

    let stocktakeItemId = item?.id;
    if (!item) {
      stocktakeItemId = uuidv4();
      const medCost: any = localDb
        .prepare('SELECT purchase_price, mrp FROM medicines WHERE id = ?')
        .get(medicineId);
      const unitCost = Math.round((medCost?.purchase_price || 0) * 100);

      localDb
        .prepare(
          `INSERT INTO stocktake_items (
            id, _local_id, stocktake_id, organization_id, medicine_id, batch_id,
            expected_quantity, physical_quantity, difference, unit_cost_paise,
            value_difference_paise, recount_status, created_at, updated_at, _updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 'NONE', ?, ?, ?)`
        )
        .run(
          stocktakeItemId,
          stocktakeItemId,
          stocktakeId,
          session.organization_id,
          medicineId,
          batchId,
          unitCost,
          now,
          now,
          now
        );

      item = localDb
        .prepare('SELECT * FROM stocktake_items WHERE id = ?')
        .get(stocktakeItemId);
    }

    // Insert count entry
    const countId = uuidv4();
    localDb
      .prepare(
        `INSERT INTO stocktake_counts (
          id, _local_id, stocktake_id, stocktake_item_id, medicine_id, batch_id,
          counter_name, user_id, scanned_barcode, raw_quantity, unit_type,
          conversion_factor, base_quantity, device_id, is_offline_sync, counted_at, created_at, _updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        countId,
        countId,
        stocktakeId,
        stocktakeItemId,
        medicineId,
        batchId,
        counterName,
        userId,
        scannedBarcode,
        rawQuantity,
        unitType,
        conversionFactor,
        baseQuantity,
        deviceId,
        isOfflineSync ? 1 : 0,
        now,
        now,
        now
      );

    // Double count logic
    let recountStatus = item.recount_status || 'NONE';
    let recountA = item.recount_count_a;
    let recountB = item.recount_count_b;

    if (session.is_double_count) {
      if (counterRole === 'COUNTER_A') {
        recountA = (recountA || 0) + baseQuantity;
      } else {
        recountB = (recountB || 0) + baseQuantity;
      }

      if (recountA !== undefined && recountB !== undefined) {
        if (recountA === recountB) {
          recountStatus = 'COMPLETED';
        } else {
          recountStatus = 'CONFLICT';
        }
      }
    }

    // Recompute total physical quantity for item
    const totalCountRow: any = localDb
      .prepare(
        `SELECT SUM(base_quantity) as total_qty 
         FROM stocktake_counts 
         WHERE stocktake_item_id = ?`
      )
      .get(stocktakeItemId);

    const totalPhysical = Number(totalCountRow?.total_qty || 0);
    const difference = totalPhysical - Number(item.expected_quantity || 0);
    const valueDifference = Math.round(difference * Number(item.unit_cost_paise || 0));

    localDb
      .prepare(
        `UPDATE stocktake_items 
         SET physical_quantity = ?, difference = ?, value_difference_paise = ?,
             recount_status = ?, recount_count_a = ?, recount_count_b = ?,
             updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(
        totalPhysical,
        difference,
        valueDifference,
        recountStatus,
        recountA,
        recountB,
        now,
        now,
        stocktakeItemId
      );

    return {
      countId,
      stocktakeItemId,
      physicalQuantity: totalPhysical,
      difference,
    };
  }

  /**
   * Get all items and variances for a session (with blind count support)
   */
  static getSessionItems(sessionId: string, isManager = false): StocktakeItemRecord[] {
    const session = this.getSession(sessionId);
    if (!session) throw new AppError(404, 'Stocktake session not found', 'NOT_FOUND');

    const rows: any[] = localDb
      .prepare(
        `SELECT si.*, m.name as medicine_name, m.generic_name, m.category
         FROM stocktake_items si
         JOIN medicines m ON m.id = si.medicine_id
         WHERE si.stocktake_id = ?
         ORDER BY m.name ASC`
      )
      .all(sessionId);

    // If blind count is active and session is still IN_PROGRESS and user is not manager, hide expected quantity & difference
    const hideExpected = session.is_blind_count && session.status === 'IN_PROGRESS' && !isManager;

    return rows.map((r) => ({
      ...r,
      expected_quantity: hideExpected ? 0 : Number(r.expected_quantity || 0),
      physical_quantity: Number(r.physical_quantity || 0),
      difference: hideExpected ? 0 : Number(r.difference || 0),
      unit_cost_paise: Number(r.unit_cost_paise || 0),
      value_difference_paise: hideExpected ? 0 : Number(r.value_difference_paise || 0),
    })) as StocktakeItemRecord[];
  }

  /**
   * Approve stocktake session with variance limit checks
   */
  static approveSession(params: {
    sessionId: string;
    approvedBy: string;
    userRole: string;
    notes?: string;
  }): StocktakeSessionRecord {
    const { sessionId, approvedBy, userRole, notes = '' } = params;
    const session = this.getSession(sessionId);
    if (!session) throw new AppError(404, 'Stocktake session not found', 'NOT_FOUND');

    const items = this.getSessionItems(sessionId, true);
    const totalAbsVariancePaise = items.reduce(
      (sum, it) => sum + Math.abs(Number(it.value_difference_paise || 0)),
      0
    );

    // Role-based variance authorization limits (e.g. > ₹5,000 (500000 paise) requires OWNER/SUPER_ADMIN)
    if (totalAbsVariancePaise > 500000 && userRole !== 'OWNER' && userRole !== 'SUPER_ADMIN') {
      throw new AppError(
        403,
        `High variance value (₹${(totalAbsVariancePaise / 100).toFixed(2)}) requires OWNER or SUPER_ADMIN approval.`,
        'AUTHORIZATION_REQUIRED'
      );
    }

    const now = new Date().toISOString();
    localDb
      .prepare(
        `UPDATE stocktake_sessions 
         SET status = 'APPROVED', approved_by = ?, approved_at = ?, notes = COALESCE(notes, '') || ' ' || ?,
             updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(approvedBy, now, notes, now, now, sessionId);

    return this.getSession(sessionId)!;
  }

  /**
   * Post approved stock adjustments to ledger and inventory positions
   */
  static postAdjustments(params: {
    sessionId: string;
    postedBy: string;
    userRole: string;
  }): { postedMovementsCount: number; netValueImpactPaise: number } {
    const { sessionId, postedBy, userRole } = params;
    const session = this.getSession(sessionId);
    if (!session) throw new AppError(404, 'Stocktake session not found', 'NOT_FOUND');

    if (session.status !== 'APPROVED') {
      throw new AppError(400, 'Only APPROVED stocktake sessions can be posted.', 'NOT_APPROVED');
    }

    const items = this.getSessionItems(sessionId, true);
    const now = new Date().toISOString();
    let postedMovementsCount = 0;
    let netValueImpactPaise = 0;

    const locationType = session.store_id ? 'STORE' : 'WAREHOUSE';

    for (const item of items) {
      const diff = Number(item.difference || 0);
      if (diff === 0) continue; // No adjustment needed for zero variance

      // Record stock ledger movement
      const ledgerId = uuidv4();
      localDb
        .prepare(
          `INSERT INTO stock_ledger (
            id, _local_id, organization_id, store_id, warehouse_id,
            source_location_type, source_location_id,
            destination_location_type, destination_location_id,
            medicine_id, batch_id, movement_type, quantity_delta,
            balance_after, reference_id, notes, performed_by, created_at, _updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STOCKTAKE_CORRECTION', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ledgerId,
          ledgerId,
          session.organization_id,
          session.store_id,
          session.warehouse_id,
          locationType,
          session.store_id || session.warehouse_id,
          locationType,
          session.store_id || session.warehouse_id,
          item.medicine_id,
          item.batch_id,
          diff,
          item.physical_quantity,
          session.id,
          `Stocktake ${session.name} adjustment. Reason: ${item.variance_reason || 'COUNT_CORRECTION'}`,
          postedBy,
          now,
          now
        );

      // Adjust inventory position
      if (item.batch_id) {
        InventoryPositionService.adjustStock({
          organizationId: session.organization_id,
          medicineId: item.medicine_id,
          batchId: item.batch_id,
          locationType,
          storeId: session.store_id,
          warehouseId: session.warehouse_id,
          quantityDelta: diff,
        });

        // Also update legacy medicine_batches quantity_remaining for backward compatibility
        localDb
          .prepare(
            `UPDATE medicine_batches 
             SET quantity_remaining = MAX(0, quantity_remaining + ?), _updated_at = ?
             WHERE id = ?`
          )
          .run(diff, now, item.batch_id);
      }

      postedMovementsCount++;
      netValueImpactPaise += Number(item.value_difference_paise || 0);
    }

    localDb
      .prepare(
        `UPDATE stocktake_sessions 
         SET status = 'POSTED', posted_at = ?, updated_at = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, now, sessionId);

    return {
      postedMovementsCount,
      netValueImpactPaise,
    };
  }
}
