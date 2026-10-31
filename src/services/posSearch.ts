import { localDb } from '../local-db';

export interface POSSearchResult {
  id: string;
  _local_id: string;
  name: string;
  brand_name: string | null;
  generic_name: string | null;
  composition: string | null;
  dosage_form: string | null;
  strength: string | null;
  pack_size: string | null;
  manufacturer: string | null;
  category: string | null;
  hsn_code: string | null;
  gst_rate: number;
  prescription_required: boolean;
  schedule_classification: string;
  cold_chain_required: boolean;
  base_unit: string;
  sale_unit: string;
  conversion_factor: number;
  mrp: number;
  selling_price: number;
  total_available_stock: number;
  nearest_expiry: string | null;
  matched_barcode?: {
    barcode: string;
    barcode_type: string;
    unit_type: string;
    conversion_factor: number;
  } | null;
  batches: Array<{
    id: string;
    batch_number: string;
    expiry_date: string;
    quantity_remaining: number;
    purchase_price: number;
    mrp: number;
    rack_id?: string | null;
  }>;
  match_rank: number; // 1 = exact barcode, 2 = exact name, 3 = prefix, 4 = brand, 5 = generic, 6 = partial, 7 = typo
}

export class POSSearchService {
  /**
   * Fast Normalized Levenshtein distance for typo tolerance
   */
  private static levenshtein(a: string, b: string): number {
    const s1 = a.toLowerCase();
    const s2 = b.toLowerCase();
    const m = s1.length;
    const n = s2.length;
    if (Math.abs(m - n) > 3) return 99;

    // Two rows keep memory linear even for longer product names.
    let previous = Array.from({ length: n + 1 }, (_, i) => i);
    let current = new Array<number>(n + 1);
    for (let i = 1; i <= m; i++) {
      current[0] = i;
      for (let j = 1; j <= n; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
          previous[j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1));
      }
      [previous, current] = [current, previous];
    }
    return previous[n];
  }

  /** Fetch stock once for a candidate set, supporting cloud and local IDs. */
  private static loadBatches(medicines: any[], storeId: string, today: string): Map<string, any[]> {
    const ids = [...new Set(medicines.flatMap(med => [med.id, med._local_id]).filter(Boolean))];
    const grouped = new Map<string, any[]>();
    if (ids.length === 0) return grouped;
    const batches: any[] = localDb.prepare(
      `SELECT id, _local_id, medicine_id, batch_number, expiry_date,
              quantity_remaining, purchase_price, mrp
       FROM medicine_batches
       WHERE medicine_id IN (${ids.map(() => '?').join(',')})
         AND (store_id = ? OR store_id IS NULL)
         AND quantity_remaining > 0
         AND (is_disposed = 0 OR is_disposed IS NULL)
         AND expiry_date >= ? AND _deleted = 0
       ORDER BY expiry_date ASC, _local_id ASC`
    ).all(...ids, storeId, today);
    for (const batch of batches) {
      const group = grouped.get(batch.medicine_id);
      if (group) group.push(batch);
      else grouped.set(batch.medicine_id, [batch]);
    }
    return grouped;
  }

  private static batchesFor(med: any, grouped: Map<string, any[]>): any[] {
    const batches = [...(grouped.get(med.id) || [])];
    if (med._local_id && med._local_id !== med.id) batches.push(...(grouped.get(med._local_id) || []));
    return batches.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) ||
      String(a._local_id).localeCompare(String(b._local_id)));
  }

  /**
   * Main unified search method
   */
  static search(params: {
    query?: string;
    barcode?: string;
    organizationId: string;
    storeId: string;
    limit?: number;
  }): { results: POSSearchResult[]; substitutes: POSSearchResult[] } {
    const { query = '', barcode = '', organizationId, storeId } = params;
    const limit = Math.max(1, Math.min(Math.trunc(params.limit || 25), 100));
    const cleanQ = query.trim().toLowerCase();
    const cleanBarcode = barcode.trim();

    if (!cleanQ && !cleanBarcode) {
      return { results: [], substitutes: [] };
    }

    const matchedMedicines = new Map<string, { med: any; rank: number; matchedBarcode?: any }>();

    // ── 1. EXACT BARCODE LOOKUP ─────────────────────────────────────────────
    if (cleanBarcode) {
      // Check product_barcodes table
      const barcodeRows: any[] = localDb
        .prepare(
          `SELECT m.*, pb.barcode as matched_barcode_value, pb.barcode_type,
                  pb.unit_type, pb.conversion_factor as barcode_conversion
           FROM product_barcodes pb
           JOIN medicines m ON pb.medicine_id = m.id OR pb.medicine_id = m._local_id
           WHERE pb.barcode = ? AND (pb.organization_id = ?) AND pb._deleted = 0
             AND (m.organization_id = ?)
             AND m.is_active = 1 AND m._deleted = 0`
        )
        .all(cleanBarcode, organizationId, organizationId);

      for (const row of barcodeRows) {
        matchedMedicines.set(row.id || row._local_id, {
          med: row,
          rank: 1,
          matchedBarcode: {
            barcode: row.matched_barcode_value,
            barcode_type: row.barcode_type,
            unit_type: row.unit_type,
            conversion_factor: row.barcode_conversion || row.conversion_factor || 1.0,
          },
        });
      }

      // Check primary_barcode on medicines table
      const primaryBarcodeRows: any[] = localDb
        .prepare(
          `SELECT * FROM medicines 
           WHERE primary_barcode = ? AND (organization_id = ?) AND is_active = 1 AND _deleted = 0`
        )
        .all(cleanBarcode, organizationId);

      for (const row of primaryBarcodeRows) {
        if (!matchedMedicines.has(row.id || row._local_id)) {
          matchedMedicines.set(row.id || row._local_id, {
            med: row,
            rank: 1,
            matchedBarcode: {
              barcode: row.primary_barcode,
              barcode_type: 'PRIMARY',
              unit_type: row.sale_unit || row.unit || 'STRIP',
              conversion_factor: 1.0,
            },
          });
        }
      }
    }

    // ── 2. TEXT & CODE SEARCH ───────────────────────────────────────────────
    if (cleanQ) {
      // 2a. Direct SQL Matches (Name, Generic, Brand, Category, HSN)
      const sqlRows: any[] = localDb
        .prepare(
          `SELECT * FROM medicines 
           WHERE (organization_id = ?)
             AND is_active = 1 
             AND _deleted = 0
             AND (
               LOWER(name) LIKE ? OR
               LOWER(brand_name) LIKE ? OR
               LOWER(generic_name) LIKE ? OR
               LOWER(composition) LIKE ? OR
               LOWER(manufacturer) LIKE ? OR
               hsn_code LIKE ?
             )
           ORDER BY CASE
             WHEN LOWER(name) = ? THEN 2
             WHEN LOWER(name) LIKE ? THEN 3
             WHEN LOWER(brand_name) LIKE ? THEN 4
             WHEN LOWER(generic_name) LIKE ? THEN 5
             ELSE 6 END, name COLLATE NOCASE, _local_id
           LIMIT 100`
        )
        .all(
          organizationId,
          `%${cleanQ}%`,
          `%${cleanQ}%`,
          `%${cleanQ}%`,
          `%${cleanQ}%`,
          `%${cleanQ}%`,
          `%${cleanQ}%`,
          cleanQ, `${cleanQ}%`, `${cleanQ}%`, `%${cleanQ}%`
        );

      for (const row of sqlRows) {
        const id = row.id || row._local_id;
        const nameLower = (row.name || '').toLowerCase();
        const genericLower = (row.generic_name || '').toLowerCase();
        const brandLower = (row.brand_name || '').toLowerCase();

        let rank = 6;
        if (nameLower === cleanQ) rank = 2;
        else if (nameLower.startsWith(cleanQ)) rank = 3;
        else if (brandLower.startsWith(cleanQ) || brandLower === cleanQ) rank = 4;
        else if (genericLower.includes(cleanQ)) rank = 5;

        if (!matchedMedicines.has(id) || matchedMedicines.get(id)!.rank > rank) {
          matchedMedicines.set(id, { med: row, rank });
        }
      }

      // 2b. Typo-Tolerant Search (if few exact matches found)
      if (matchedMedicines.size < 5 && cleanQ.length >= 4) {
        const candidatePool: any[] = localDb
          .prepare(
            `SELECT * FROM medicines 
             WHERE (organization_id = ?)
               AND is_active = 1 AND _deleted = 0
             LIMIT 300`
          )
          .all(organizationId);

        for (const row of candidatePool) {
          const id = row.id || row._local_id;
          if (matchedMedicines.has(id)) continue;

          const nameWords = (row.name || '').toLowerCase().split(/[\s,/-]+/);
          const genericWords = (row.generic_name || '').toLowerCase().split(/[\s,/-]+/);
          const allWords = [...nameWords, ...genericWords].filter(w => w.length >= 3);

          let isTypoMatch = false;
          for (const word of allWords) {
            const dist = this.levenshtein(cleanQ, word);
            if (dist <= 2) {
              isTypoMatch = true;
              break;
            }
          }

          if (isTypoMatch) {
            matchedMedicines.set(id, { med: row, rank: 7 });
          }
        }
      }
    }

    // ── 3. ATTACH BATCHES, POSITIONS & NEAREST EXPIRY ─────────────────────────
    const results: POSSearchResult[] = [];
    const todayStr = new Date().toISOString().split('T')[0];
    const batchGroups = this.loadBatches([...matchedMedicines.values()].map(entry => entry.med), storeId, todayStr);

    for (const { med, rank, matchedBarcode } of matchedMedicines.values()) {
      const batches = this.batchesFor(med, batchGroups);

      const totalStock = batches.reduce((sum, b) => sum + Number(b.quantity_remaining || 0), 0);
      const nearestExpiry = batches.length > 0 ? batches[0].expiry_date : null;
      const defaultMrp = batches.length > 0 ? Number(batches[0].mrp || 0) : Number(med.mrp || 0);
      const defaultPrice = defaultMrp;

      results.push({
        id: med.id || med._local_id,
        _local_id: med._local_id || med.id,
        name: med.name,
        brand_name: med.brand_name || null,
        generic_name: med.generic_name || null,
        composition: med.composition || null,
        dosage_form: med.dosage_form || null,
        strength: med.strength || null,
        pack_size: med.pack_size || null,
        manufacturer: med.manufacturer || null,
        category: med.category || null,
        hsn_code: med.hsn_code || null,
        gst_rate: Number(med.gst_rate ?? 12),
        prescription_required: Boolean(med.prescription_required || med.is_schedule_h1),
        schedule_classification: med.schedule_classification || (med.is_schedule_h1 ? 'SCHEDULE_H1' : 'NONE'),
        cold_chain_required: Boolean(med.cold_chain_required),
        base_unit: med.base_unit || 'tablet',
        sale_unit: med.sale_unit || med.unit || 'strip',
        conversion_factor: Number(med.conversion_factor ?? 1.0),
        mrp: defaultMrp,
        selling_price: defaultPrice,
        total_available_stock: totalStock,
        nearest_expiry: nearestExpiry,
        matched_barcode: matchedBarcode || null,
        batches: batches.map(b => ({
          id: b.id || b._local_id,
          batch_number: b.batch_number,
          expiry_date: b.expiry_date,
          quantity_remaining: Number(b.quantity_remaining || 0),
          purchase_price: Number(b.purchase_price || 0),
          mrp: Number(b.mrp || 0),
          rack_id: b.rack_id || null,
        })),
        match_rank: rank,
      });
    }

    // Sort results by match_rank ASC, then total_available_stock DESC
    results.sort((a, b) => {
      if (a.match_rank !== b.match_rank) return a.match_rank - b.match_rank;
      return b.total_available_stock - a.total_available_stock || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });

    const finalResults = results.slice(0, limit);

    // ── 4. FIND GENERIC SUBSTITUTES ──────────────────────────────────────────
    const substitutes: POSSearchResult[] = [];
    const genericNames = finalResults.map(r => r.generic_name).filter(Boolean) as string[];

    if (genericNames.length > 0) {
      const topGeneric = genericNames[0];
      const resultIds = new Set(finalResults.map(r => r.id));

      const subRows: any[] = localDb
        .prepare(
          `SELECT * FROM medicines 
           WHERE LOWER(generic_name) = LOWER(?) 
             AND (organization_id = ?)
             AND id NOT IN (${finalResults.map(() => '?').join(',')}) 
             AND is_active = 1 
             AND _deleted = 0
           LIMIT 15`
        )
        .all(topGeneric, organizationId, ...finalResults.map(r => r.id));

      const substituteBatches = this.loadBatches(subRows, storeId, todayStr);
      for (const row of subRows) {
        if (resultIds.has(row.id || row._local_id)) continue;
        const batches = this.batchesFor(row, substituteBatches);

        const totalStock = batches.reduce((sum, b) => sum + Number(b.quantity_remaining || 0), 0);
        substitutes.push({
          id: row.id || row._local_id,
          _local_id: row._local_id || row.id,
          name: row.name,
          brand_name: row.brand_name || null,
          generic_name: row.generic_name || null,
          composition: row.composition || null,
          dosage_form: row.dosage_form || null,
          strength: row.strength || null,
          pack_size: row.pack_size || null,
          manufacturer: row.manufacturer || null,
          category: row.category || null,
          hsn_code: row.hsn_code || null,
          gst_rate: Number(row.gst_rate ?? 12),
          prescription_required: Boolean(row.prescription_required || row.is_schedule_h1),
          schedule_classification: row.schedule_classification || (row.is_schedule_h1 ? 'SCHEDULE_H1' : 'NONE'),
          cold_chain_required: Boolean(row.cold_chain_required),
          base_unit: row.base_unit || 'tablet',
          sale_unit: row.sale_unit || 'strip',
          conversion_factor: Number(row.conversion_factor ?? 1.0),
          mrp: batches.length > 0 ? Number(batches[0].mrp) : 0,
          selling_price: batches.length > 0 ? Number(batches[0].mrp) : 0,
          total_available_stock: totalStock,
          nearest_expiry: batches.length > 0 ? batches[0].expiry_date : null,
          batches: batches.map(b => ({
            id: b.id || b._local_id,
            batch_number: b.batch_number,
            expiry_date: b.expiry_date,
            quantity_remaining: Number(b.quantity_remaining || 0),
            purchase_price: Number(b.purchase_price || 0),
            mrp: Number(b.mrp || 0),
          })),
          match_rank: 5,
        });
      }
    }

    return { results: finalResults, substitutes };
  }
}
