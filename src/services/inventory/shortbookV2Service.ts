// shortbookV2Service.ts — Shortbook V2 Multi-Source Request Consolidation Service
import { localDb } from '../../local-db';
import { v4 as uuidv4 } from 'uuid';
import { ShortbookConsolidatedItem } from '../../domain/inventoryTypes';

export class ShortbookV2Service {
  /**
   * Add or aggregate an out-of-stock request into Shortbook V2
   */
  static recordShortageRequest(params: {
    clinicId?: string | null;
    medicineId: string;
    quantityNeeded?: number;
    reason?: string;
    source?: 'LOW_STOCK' | 'STOCKOUT' | 'CUSTOMER_REQUEST' | 'PRESCRIPTION_UNAVAILABLE' | 'MANUAL';
    preferredSupplierId?: string | null;
  }): any {
    const {
      clinicId = 'default-clinic',
      medicineId,
      quantityNeeded = 1,
      reason = 'Out of Stock',
      source = 'CUSTOMER_REQUEST',
      preferredSupplierId = null,
    } = params;

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO shortbook (
          id, _local_id, clinic_id, medicine_id, reason, quantity_needed,
          preferred_supplier_id, is_ordered, created_at, _updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        id,
        clinicId,
        medicineId,
        `[${source}] ${reason}`,
        quantityNeeded,
        preferredSupplierId,
        now,
        now
      );

    return { id, medicineId, quantityNeeded, source, recordedAt: now };
  }

  /**
   * Fetch consolidated shortbook entries aggregating repeat requests
   */
  static getConsolidatedShortbook(clinicId?: string | null): ShortbookConsolidatedItem[] {
    let query = `
      SELECT sb.*, m.name as medicine_name, m.generic_name,
             s.name as supplier_name
      FROM shortbook sb
      JOIN medicines m ON m.id = sb.medicine_id
      LEFT JOIN suppliers s ON s.id = sb.preferred_supplier_id
      WHERE sb.is_ordered = 0
    `;
    const params: any[] = [];
    if (clinicId) {
      query += ` AND sb.clinic_id = ?`;
      params.push(clinicId);
    }
    query += ` ORDER BY sb.created_at DESC`;

    const rows: any[] = localDb.prepare(query).all(...params);

    const consolidatedMap = new Map<string, ShortbookConsolidatedItem>();

    for (const r of rows) {
      const existing = consolidatedMap.get(r.medicine_id);
      const isCustomerReq = String(r.reason || '').includes('CUSTOMER_REQUEST');
      const isRxShortage = String(r.reason || '').includes('PRESCRIPTION_UNAVAILABLE');
      const sourceTag = String(r.reason || '').startsWith('[')
        ? String(r.reason).split(']')[0].replace('[', '')
        : 'MANUAL';

      if (!existing) {
        consolidatedMap.set(r.medicine_id, {
          medicineId: r.medicine_id,
          medicineName: r.medicine_name,
          genericName: r.generic_name,
          totalQuantityNeeded: Number(r.quantity_needed || 1),
          requestCount: 1,
          customerRequestCount: isCustomerReq ? 1 : 0,
          prescriptionShortageCount: isRxShortage ? 1 : 0,
          firstRequestedAt: r.created_at,
          lastRequestedAt: r.created_at,
          sources: [sourceTag],
          preferredSupplierId: r.preferred_supplier_id,
          preferredSupplierName: r.supplier_name,
        });
      } else {
        existing.totalQuantityNeeded += Number(r.quantity_needed || 1);
        existing.requestCount += 1;
        if (isCustomerReq) existing.customerRequestCount += 1;
        if (isRxShortage) existing.prescriptionShortageCount += 1;
        if (!existing.sources.includes(sourceTag)) existing.sources.push(sourceTag);
        if (new Date(r.created_at) < new Date(existing.firstRequestedAt)) {
          existing.firstRequestedAt = r.created_at;
        }
        if (new Date(r.created_at) > new Date(existing.lastRequestedAt)) {
          existing.lastRequestedAt = r.created_at;
        }
      }
    }

    return Array.from(consolidatedMap.values());
  }
}
