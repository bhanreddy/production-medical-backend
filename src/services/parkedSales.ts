import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../lib/appError';

export interface ParkSaleParams {
  organizationId: string;
  storeId: string;
  counterId?: string | null;
  terminalId?: string | null;
  cashierId: string;
  customerId?: string | null;
  cartSnapshot: any;
  customerSnapshot?: any;
  totalsSnapshot?: any;
  notes?: string;
  expiresInMinutes?: number;
}

export class ParkedSalesService {
  /**
   * Generates next sequential park token for store (e.g., P101, P102)
   */
  private static generateToken(storeId: string): string {
    const todayStr = new Date().toISOString().split('T')[0];
    const countRow: any = localDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM parked_sales 
         WHERE store_id = ? AND created_at >= ?`
      )
      .get(storeId, todayStr);

    const seq = (countRow?.cnt || 0) + 1;
    return `P${String(seq).padStart(3, '0')}`;
  }

  /**
   * Parks an active transaction
   */
  static parkSale(params: ParkSaleParams) {
    const {
      organizationId,
      storeId,
      counterId = null,
      terminalId = null,
      cashierId,
      customerId = null,
      cartSnapshot,
      customerSnapshot = {},
      totalsSnapshot = {},
      notes = '',
      expiresInMinutes = 1440, // 24 hours
    } = params;

    const id = uuidv4();
    const token = this.generateToken(storeId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000).toISOString();

    const record = localMutate({
      table: 'parked_sales',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: organizationId,
        store_id: storeId,
        counter_id: counterId,
        terminal_id: terminalId,
        cashier_id: cashierId,
        customer_id: customerId,
        park_token: token,
        cart_snapshot: typeof cartSnapshot === 'string' ? cartSnapshot : JSON.stringify(cartSnapshot),
        customer_snapshot: typeof customerSnapshot === 'string' ? customerSnapshot : JSON.stringify(customerSnapshot),
        totals_snapshot: typeof totalsSnapshot === 'string' ? totalsSnapshot : JSON.stringify(totalsSnapshot),
        notes,
        status: 'PARKED',
        expires_at: expiresAt,
      },
    });

    return {
      ...record,
      park_token: token,
      expires_at: expiresAt,
    };
  }

  /**
   * Lists active parked sales for a store
   */
  static listParked(storeId: string) {
    const nowIso = new Date().toISOString();
    const rows: any[] = localDb
      .prepare(
        `SELECT * FROM parked_sales 
         WHERE store_id = ? AND status = 'PARKED' AND expires_at > ? AND _deleted = 0
         ORDER BY created_at DESC`
      )
      .all(storeId, nowIso);

    return rows.map(r => ({
      ...r,
      cart_snapshot: typeof r.cart_snapshot === 'string' ? JSON.parse(r.cart_snapshot) : r.cart_snapshot,
      customer_snapshot: typeof r.customer_snapshot === 'string' ? JSON.parse(r.customer_snapshot) : r.customer_snapshot,
      totals_snapshot: typeof r.totals_snapshot === 'string' ? JSON.parse(r.totals_snapshot) : r.totals_snapshot,
    }));
  }

  /**
   * Resumes a parked sale (supports cross-counter recall in the same store)
   */
  static resumeParked(params: {
    parkedId: string;
    storeId: string;
    resumingCounterId?: string | null;
    resumingTerminalId?: string | null;
    resumingUserId: string;
  }) {
    const { parkedId, storeId, resumingCounterId = null, resumingTerminalId = null, resumingUserId } = params;

    const row: any = localDb
      .prepare('SELECT * FROM parked_sales WHERE (id = ? OR _local_id = ? OR park_token = ?) AND store_id = ? AND _deleted = 0')
      .get(parkedId, parkedId, parkedId, storeId);

    if (!row) {
      throw new AppError(404, `Parked bill not found in this store: ${parkedId}`, 'PARKED_BILL_NOT_FOUND');
    }

    if (row.status !== 'PARKED') {
      throw new AppError(400, `Parked bill is already ${row.status}`, 'PARKED_BILL_NOT_ACTIVE');
    }

    const nowIso = new Date().toISOString();
    if (row.expires_at && row.expires_at < nowIso) {
      localMutate({
        table: 'parked_sales',
        operation: 'UPDATE',
        data: {
          _local_id: row._local_id || row.id,
          status: 'EXPIRED',
        },
      });
      throw new AppError(400, 'Parked bill has expired', 'PARKED_BILL_EXPIRED');
    }

    // Mark as resumed
    localMutate({
      table: 'parked_sales',
      operation: 'UPDATE',
      data: {
        _local_id: row._local_id || row.id,
        status: 'RESUMED',
        resumed_at: nowIso,
        resumed_counter_id: resumingCounterId,
        resumed_terminal_id: resumingTerminalId,
        resumed_by: resumingUserId,
      },
    });

    return {
      id: row.id || row._local_id,
      park_token: row.park_token,
      cart_snapshot: typeof row.cart_snapshot === 'string' ? JSON.parse(row.cart_snapshot) : row.cart_snapshot,
      customer_snapshot: typeof row.customer_snapshot === 'string' ? JSON.parse(row.customer_snapshot) : row.customer_snapshot,
      totals_snapshot: typeof row.totals_snapshot === 'string' ? JSON.parse(row.totals_snapshot) : row.totals_snapshot,
      original_counter_id: row.counter_id,
      original_cashier_id: row.cashier_id,
    };
  }

  /**
   * Cancels a parked sale
   */
  static cancelParked(parkedId: string, storeId: string) {
    const row: any = localDb
      .prepare('SELECT * FROM parked_sales WHERE (id = ? OR _local_id = ?) AND store_id = ?')
      .get(parkedId, parkedId, storeId);

    if (!row) throw new AppError(404, 'Parked bill not found', 'PARKED_BILL_NOT_FOUND');

    localMutate({
      table: 'parked_sales',
      operation: 'UPDATE',
      data: {
        _local_id: row._local_id || row.id,
        status: 'CANCELLED',
      },
    });

    return { success: true };
  }
}
