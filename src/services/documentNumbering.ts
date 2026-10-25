import { localDb } from '../local-db';
import { v4 as uuidv4 } from 'uuid';
import { DocumentType } from '../domain/units';

export interface GenerateDocNumberOptions {
  organizationId: string;
  storeId?: string | null;
  documentType: DocumentType;
  financialYearId?: string | null;
  date?: Date;
  customPrefix?: string;
}

export class DocumentNumberingService {
  /**
   * Helper to derive standard Indian Financial Year code (e.g., "26-27" for FY 2026-2027)
   */
  static getFinancialYearCode(date: Date = new Date()): string {
    const month = date.getMonth(); // 0-indexed (0 = Jan, 3 = Apr)
    const year = date.getFullYear();
    const startYear = month >= 3 ? year : year - 1;
    const endYear = startYear + 1;
    const startStr = String(startYear).slice(-2);
    const endStr = String(endYear).slice(-2);
    return `${startStr}-${endStr}`;
  }

  /**
   * Default prefix mappings per document type
   */
  static getDefaultPrefix(documentType: DocumentType, storeCode: string = 'MAIN'): string {
    const code = storeCode.toUpperCase();
    switch (documentType) {
      case 'SALE_INVOICE':
        return `${code}/INV`;
      case 'SALE_RETURN':
        return `${code}/RET`;
      case 'PURCHASE':
        return `${code}/PUR`;
      case 'PURCHASE_RETURN':
        return `${code}/PRET`;
      case 'PURCHASE_ORDER':
        return `${code}/PO`;
      case 'PURCHASE_REQUISITION':
        return `${code}/REQ`;
      case 'PURCHASE_QUOTATION':
        return `${code}/QTN`;
      case 'PURCHASE_INVOICE':
        return `${code}/PINV`;
      case 'GRN':
        return `${code}/GRN`;
      case 'SUPPLIER_PAYMENT':
        return `${code}/PAY`;
      case 'TRANSFER':
        return `${code}/TRF`;
      case 'STOCK_ADJUSTMENT':
        return `${code}/ADJ`;
      case 'CREDIT_NOTE':
        return `${code}/CN`;
      case 'DEBIT_NOTE':
        return `${code}/DN`;
      case 'DELIVERY_ORDER':
        return `${code}/DO`;
      case 'ORDER':
        return `${code}/ORD`;
      default:
        return `${code}/DOC`;
    }
  }

  /**
   * Generates the next sequential document number atomically.
   */
  static generate(options: GenerateDocNumberOptions): string {
    const {
      organizationId,
      storeId = null,
      documentType,
      financialYearId = null,
      date = new Date(),
      customPrefix,
    } = options;

    const fyCode = this.getFinancialYearCode(date);
    const nowIso = new Date().toISOString();

    // Resolve store_code if storeId provided
    let storeCode = 'MAIN';
    if (storeId) {
      const storeRow: any = localDb
        .prepare('SELECT store_code FROM stores WHERE id = ? OR _local_id = ?')
        .get(storeId, storeId);
      if (storeRow?.store_code) {
        storeCode = storeRow.store_code;
      }
    }

    const defaultPrefix = customPrefix || this.getDefaultPrefix(documentType, storeCode);

    // Atomically find or create sequence record inside transaction
    const getNextNumberTx = localDb.transaction(() => {
      // Find matching sequence configuration
      let seqRow: any;
      if (storeId && financialYearId) {
        seqRow = localDb
          .prepare(
            `SELECT * FROM document_sequences 
             WHERE organization_id = ? AND store_id = ? AND document_type = ? AND financial_year_id = ?
             LIMIT 1`
          )
          .get(organizationId, storeId, documentType, financialYearId);
      } else if (storeId && !financialYearId) {
        seqRow = localDb
          .prepare(
            `SELECT * FROM document_sequences 
             WHERE organization_id = ? AND store_id = ? AND document_type = ?
             LIMIT 1`
          )
          .get(organizationId, storeId, documentType);
      } else if (!storeId && financialYearId) {
        seqRow = localDb
          .prepare(
            `SELECT * FROM document_sequences 
             WHERE organization_id = ? AND store_id IS NULL AND document_type = ? AND financial_year_id = ?
             LIMIT 1`
          )
          .get(organizationId, documentType, financialYearId);
      } else {
        seqRow = localDb
          .prepare(
            `SELECT * FROM document_sequences 
             WHERE organization_id = ? AND store_id IS NULL AND document_type = ?
             LIMIT 1`
          )
          .get(organizationId, documentType);
      }

      if (!seqRow) {
        // Insert new sequence configuration
        const newSeqId = uuidv4();
        localDb
          .prepare(
            `INSERT OR REPLACE INTO document_sequences (
               id, _local_id, organization_id, store_id, document_type, financial_year_id,
               prefix, suffix, padding, current_sequence, created_at, updated_at, _updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 4, 1, ?, ?, ?)`
          )
          .run(
            newSeqId,
            newSeqId,
            organizationId,
            storeId,
            documentType,
            financialYearId,
            defaultPrefix,
            nowIso,
            nowIso,
            nowIso
          );

        return {
          prefix: defaultPrefix,
          suffix: '',
          padding: 4,
          sequence: 1,
        };
      } else {
        // Increment sequence atomically
        const newSeq = (seqRow.current_sequence || 0) + 1;
        localDb
          .prepare(
            `UPDATE document_sequences 
             SET current_sequence = ?, updated_at = ?, _updated_at = ?
             WHERE _local_id = ? OR id = ?`
          )
          .run(newSeq, nowIso, nowIso, seqRow._local_id, seqRow.id);

        return {
          prefix: seqRow.prefix || defaultPrefix,
          suffix: seqRow.suffix || '',
          padding: seqRow.padding || 4,
          sequence: newSeq,
        };
      }
    });

    const result = getNextNumberTx();
    const paddedSeq = String(result.sequence).padStart(result.padding, '0');
    
    // Format: PREFIX/FY/SEQUENCE or PREFIX-SEQUENCE
    if (result.prefix.includes('/')) {
      return `${result.prefix}/${fyCode}/${paddedSeq}${result.suffix}`;
    }
    return `${result.prefix}-${fyCode}-${paddedSeq}${result.suffix}`;
  }
}
