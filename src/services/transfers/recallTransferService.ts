// recallTransferService.ts — Product Recall Stock Consolidation & Quarantine Transfer Engine
import { localDb } from '../../local-db';
import { StockTransfer } from '../../domain/transferTypes';
import { StockTransferService } from './stockTransferService';

export class RecallTransferService {
  /**
   * Create a consolidation transfer for recalled batches from branch store to central recall vault
   */
  static createRecallConsolidationTransfer(params: {
    organizationId: string;
    recallId: string;
    sourceStoreId: string;
    centralWarehouseId: string;
    requestedBy: string;
  }): StockTransfer {
    const { organizationId, recallId, sourceStoreId, centralWarehouseId, requestedBy } = params;

    const recall: any = localDb
      .prepare(
        `SELECT * FROM product_recalls 
         WHERE (id = ? OR _local_id = ?) AND (organization_id = ?) AND _deleted = 0`
      )
      .get(recallId, recallId, organizationId);

    if (!recall) throw new Error(`Product recall not found: ${recallId}`);

    const productId = recall.product_id || recall.medicine_id;
    const recalledPositions: any[] = localDb
      .prepare(
        `SELECT ip.*, mb.batch_number, mb.expiry_date, mb.purchase_price
         FROM inventory_positions ip
         JOIN medicine_batches mb ON mb.id = ip.batch_id OR mb._local_id = ip.batch_id
         WHERE (ip.organization_id = ?)
           AND (ip.store_id = ? OR ip.store_id = ?)
           AND (ip.medicine_id = ? OR ip.medicine_id = ?)
           ${recall.batch_number ? 'AND mb.batch_number = ?' : ''}
           AND ip.quantity_recalled > 0`
      )
      .all(
        ...(recall.batch_number
          ? [organizationId, sourceStoreId, sourceStoreId, productId, productId, recall.batch_number]
          : [organizationId, sourceStoreId, sourceStoreId, productId, productId])
      );

    if (recalledPositions.length === 0) {
      throw new Error(`No recalled stock found in store ${sourceStoreId} for recall ${recallId}`);
    }

    const items = [
      {
        medicineId: productId,
        requestedQuantity: recalledPositions.reduce((sum, p) => sum + Number(p.quantity_recalled), 0),
        notes: `Recalled batch consolidation under Recall #${recall.recall_reference || recall.recall_number || recall.id}`,
      },
    ];

    const transfer = StockTransferService.createTransfer({
      organizationId,
      transferType: 'RECALL_TRANSFER',
      sourceLocationType: 'STORE',
      sourceLocationId: sourceStoreId,
      destinationLocationType: 'WAREHOUSE',
      destinationLocationId: centralWarehouseId,
      priority: 'CRITICAL',
      reason: 'RECALL',
      stockStateTransferred: 'RECALLED',
      requestedBy,
      notes: `Statutory Recall Consolidation: ${recall.recall_number} (${recall.reason})`,
      items,
    });

    return transfer;
  }
}
