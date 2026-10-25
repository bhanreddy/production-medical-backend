// inventoryReconciliationV2.ts — Enterprise Multi-Layer Reconciliation Engine V2
import { localDb } from '../../local-db';
import { v4 as uuidv4 } from 'uuid';
import { LocationType } from '../../domain/units';
import { InventoryPositionService } from '../inventoryPosition';
import { AppError } from '../../lib/appError';

export type ReconciliationStatusV2 =
  | 'MATCHED'
  | 'POSITION_MISMATCH'
  | 'LEDGER_MISMATCH'
  | 'LEGACY_MISMATCH'
  | 'ORPHAN_LEDGER'
  | 'ORPHAN_POSITION'
  | 'INVALID_NEGATIVE';

export interface ReconciliationDiagnosticItem {
  medicineId: string;
  medicineName: string;
  batchId: string;
  batchNumber: string;
  storeId: string | null;
  warehouseId: string | null;
  ledgerBalance: number;
  positionOnHand: number;
  positionAvailable: number;
  legacyBatchRemaining: number;
  status: ReconciliationStatusV2;
  discrepancyDelta: number;
  actionRequired: boolean;
}

export class InventoryReconciliationServiceV2 {
  /**
   * Run 3-way diagnostic reconciliation across Ledger, Positions, and Legacy Batches
   */
  static reconcile(params: {
    organizationId: string;
    storeId?: string | null;
    warehouseId?: string | null;
    medicineId?: string | null;
  }): {
    summary: {
      totalBatchesChecked: number;
      matchedCount: number;
      mismatchCount: number;
      invalidNegativeCount: number;
    };
    diagnostics: ReconciliationDiagnosticItem[];
  } {
    const { organizationId, storeId = null, warehouseId = null, medicineId = null } = params;

    const locationCol = storeId ? 'store_id' : 'warehouse_id';
    const targetId = storeId || warehouseId;

    let medClause = '';
    const queryParams: any[] = [organizationId];

    if (medicineId) {
      medClause = ' AND mb.medicine_id = ?';
      queryParams.push(medicineId);
    }

    const batchesQuery = `
      SELECT mb.id as batch_id, mb.batch_number, mb.medicine_id, m.name as medicine_name,
             COALESCE(mb.quantity_remaining, 0) as legacy_remaining,
             COALESCE(ip.quantity_on_hand, 0) as pos_on_hand,
             COALESCE(ip.quantity_available, 0) as pos_available
      FROM medicine_batches mb
      JOIN medicines m ON m.id = mb.medicine_id
      LEFT JOIN inventory_positions ip ON ip.batch_id = mb.id 
        AND ip.organization_id = ? 
        AND ${targetId ? `ip.${locationCol} = ?` : `ip.${locationCol} IS NULL`}
      WHERE (mb._deleted = 0 OR mb._deleted IS NULL) AND (mb.is_disposed = 0 OR mb.is_disposed IS NULL)
      ${medClause}
    `;

    const allParams = targetId
      ? [organizationId, targetId, ...(medicineId ? [medicineId] : [])]
      : [organizationId, ...(medicineId ? [medicineId] : [])];

    const batchRows: any[] = localDb.prepare(batchesQuery).all(...allParams);

    const diagnostics: ReconciliationDiagnosticItem[] = [];
    let matchedCount = 0;
    let mismatchCount = 0;
    let invalidNegativeCount = 0;

    for (const row of batchRows) {
      // Calculate expected quantity from Stock Ledger sum
      let ledgerQuery = `
        SELECT COALESCE(SUM(quantity_delta), 0) as net_delta
        FROM stock_ledger
        WHERE batch_id = ? AND organization_id = ?
      `;
      const ledgerParams: any[] = [row.batch_id, organizationId];
      if (targetId) {
        ledgerQuery += ` AND ${locationCol} = ?`;
        ledgerParams.push(targetId);
      }

      const ledgerResult: any = localDb.prepare(ledgerQuery).get(...ledgerParams);
      const ledgerBalance = Number(ledgerResult?.net_delta || 0);
      const positionOnHand = Number(row.pos_on_hand || 0);
      const legacyRemaining = Number(row.legacy_remaining || 0);

      let status: ReconciliationStatusV2 = 'MATCHED';
      let discrepancyDelta = 0;

      if (positionOnHand < 0 || ledgerBalance < 0 || legacyRemaining < 0) {
        status = 'INVALID_NEGATIVE';
        discrepancyDelta = positionOnHand - ledgerBalance;
        invalidNegativeCount++;
      } else if (positionOnHand === ledgerBalance && positionOnHand === legacyRemaining) {
        status = 'MATCHED';
        matchedCount++;
      } else if (positionOnHand !== ledgerBalance && positionOnHand === legacyRemaining) {
        status = 'LEDGER_MISMATCH';
        discrepancyDelta = positionOnHand - ledgerBalance;
        mismatchCount++;
      } else if (positionOnHand !== legacyRemaining && positionOnHand === ledgerBalance) {
        status = 'LEGACY_MISMATCH';
        discrepancyDelta = positionOnHand - legacyRemaining;
        mismatchCount++;
      } else {
        status = 'POSITION_MISMATCH';
        discrepancyDelta = positionOnHand - ledgerBalance;
        mismatchCount++;
      }

      diagnostics.push({
        medicineId: row.medicine_id,
        medicineName: row.medicine_name,
        batchId: row.batch_id,
        batchNumber: row.batch_number,
        storeId,
        warehouseId,
        ledgerBalance,
        positionOnHand,
        positionAvailable: Number(row.pos_available || 0),
        legacyBatchRemaining: legacyRemaining,
        status,
        discrepancyDelta,
        actionRequired: status !== 'MATCHED',
      });
    }

    return {
      summary: {
        totalBatchesChecked: batchRows.length,
        matchedCount,
        mismatchCount,
        invalidNegativeCount,
      },
      diagnostics,
    };
  }

  /**
   * Execute compensating repair adjustment movement for a diagnosed discrepancy
   */
  static repairDiscrepancy(params: {
    organizationId: string;
    medicineId: string;
    batchId: string;
    locationType: LocationType;
    storeId?: string | null;
    warehouseId?: string | null;
    targetPhysicalQuantity: number;
    reason: string;
    approvedBy: string;
  }): { repairedMovementId: string; newOnHandQuantity: number } {
    const {
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId = null,
      warehouseId = null,
      targetPhysicalQuantity,
      reason,
      approvedBy,
    } = params;

    const pos = InventoryPositionService.getOrCreatePosition({
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId,
      warehouseId,
    });

    const currentOnHand = Number(pos.quantity_on_hand || 0);
    const delta = targetPhysicalQuantity - currentOnHand;
    const now = new Date().toISOString();

    if (delta === 0) {
      throw new AppError(400, 'Target physical quantity matches current on hand; no adjustment needed.', 'NO_OP');
    }

    const ledgerId = uuidv4();
    localDb
      .prepare(
        `INSERT INTO stock_ledger (
          id, _local_id, organization_id, store_id, warehouse_id,
          source_location_type, source_location_id,
          destination_location_type, destination_location_id,
          medicine_id, batch_id, movement_type, quantity_delta,
          balance_after, reference_id, notes, performed_by, created_at, _updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECONCILIATION_CORRECTION', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ledgerId,
        ledgerId,
        organizationId,
        storeId,
        warehouseId,
        locationType,
        storeId || warehouseId,
        locationType,
        storeId || warehouseId,
        medicineId,
        batchId,
        delta,
        targetPhysicalQuantity,
        ledgerId,
        `Reconciliation repair: ${reason}`,
        approvedBy,
        now,
        now
      );

    // Update inventory position
    InventoryPositionService.adjustStock({
      organizationId,
      medicineId,
      batchId,
      locationType,
      storeId,
      warehouseId,
      quantityDelta: delta,
    });

    // Update legacy batch balance
    localDb
      .prepare(
        `UPDATE medicine_batches 
         SET quantity_remaining = ?, _updated_at = ?
         WHERE id = ?`
      )
      .run(targetPhysicalQuantity, now, batchId);

    return {
      repairedMovementId: ledgerId,
      newOnHandQuantity: targetPhysicalQuantity,
    };
  }
}
