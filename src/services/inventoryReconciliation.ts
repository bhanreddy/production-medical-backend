import { localDb } from '../local-db';

export type ReconciliationStatus = 'MATCHED' | 'MISMATCH' | 'LEGACY_ONLY' | 'LEDGER_ONLY';

export interface ReconciliationReport {
  batchId: string;
  medicineId: string;
  storeId?: string | null;
  status: ReconciliationStatus;
  legacyQuantity: number | null;
  inventoryPositionQuantity: number | null;
  ledgerCalculatedQuantity: number | null;
  discrepancyDelta: number;
  diagnostics: string;
}

export class InventoryReconciliationService {
  /**
   * Reconciles inventory for a specific batch and store location
   */
  static reconcileBatch(params: {
    batchId: string;
    medicineId?: string;
    storeId?: string | null;
    organizationId?: string;
  }): ReconciliationReport {
    const { batchId, storeId = null } = params;

    // 1. Fetch Legacy Batch Stock
    const batchRow: any = localDb
      .prepare('SELECT * FROM medicine_batches WHERE id = ? OR _local_id = ?')
      .get(batchId, batchId);

    const legacyQty = batchRow ? Number(batchRow.quantity_remaining ?? 0) : null;
    const medicineId = batchRow?.medicine_id || params.medicineId || '';

    // 2. Fetch Inventory Position Stock
    let posRow: any = null;
    if (storeId) {
      posRow = localDb
        .prepare('SELECT * FROM inventory_positions WHERE batch_id = ? AND store_id = ?')
        .get(batchId, storeId);
    } else {
      posRow = localDb
        .prepare('SELECT * FROM inventory_positions WHERE batch_id = ?')
        .get(batchId);
    }
    const posQty = posRow ? Number(posRow.quantity_on_hand ?? 0) : null;

    // 3. Compute Ledger Sum of Movements
    let ledgerRows: any[] = [];
    if (storeId) {
      ledgerRows = localDb
        .prepare('SELECT quantity_delta FROM stock_ledger WHERE batch_id = ? AND store_id = ?')
        .all(batchId, storeId);
    } else {
      ledgerRows = localDb
        .prepare('SELECT quantity_delta FROM stock_ledger WHERE batch_id = ?')
        .all(batchId);
    }

    let ledgerQty: number | null = null;
    if (ledgerRows.length > 0) {
      ledgerQty = ledgerRows.reduce((acc, row) => acc + Number(row.quantity_delta || 0), 0);
    }

    // 4. Determine Reconciliation Diagnostic State
    let status: ReconciliationStatus = 'MATCHED';
    let discrepancyDelta = 0;
    let diagnostics = 'Stock positions and ledger movements are fully consistent.';

    if (legacyQty !== null && posQty === null && ledgerQty === null) {
      status = 'LEGACY_ONLY';
      diagnostics = 'Batch exists in legacy storage but no inventory position or stock ledger rows recorded.';
      discrepancyDelta = legacyQty;
    } else if (legacyQty === null && (posQty !== null || ledgerQty !== null)) {
      status = 'LEDGER_ONLY';
      diagnostics = 'Ledger or position records exist for a non-existent or deleted physical batch.';
      discrepancyDelta = (posQty || 0) - (ledgerQty || 0);
    } else {
      const activeLegacy = legacyQty ?? 0;
      const activePos = posQty ?? 0;
      const activeLedger = ledgerQty ?? activeLegacy; // fallback if ledger hasn't backfilled historical movements

      if (activeLegacy === activePos && (ledgerQty === null || activeLegacy === activeLedger)) {
        status = 'MATCHED';
        discrepancyDelta = 0;
      } else {
        status = 'MISMATCH';
        discrepancyDelta = Math.abs(activeLegacy - activePos) + (ledgerQty !== null ? Math.abs(activePos - activeLedger) : 0);
        diagnostics = `Discrepancy detected: Legacy=${activeLegacy}, Position=${activePos}, LedgerNet=${ledgerQty}`;
      }
    }

    return {
      batchId,
      medicineId,
      storeId,
      status,
      legacyQuantity: legacyQty,
      inventoryPositionQuantity: posQty,
      ledgerCalculatedQuantity: ledgerQty,
      discrepancyDelta,
      diagnostics,
    };
  }
}
