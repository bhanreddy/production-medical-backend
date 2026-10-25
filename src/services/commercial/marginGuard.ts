import { localDb } from '../../local-db';
import { Money } from '../../lib/money';
import { MarginGuardResult } from '../../domain/commercialTypes';

export interface EvaluateMarginParams {
  organizationId: string;
  storeId?: string | null;
  medicineId: string;
  batchId?: string | null;
  sellingPricePaise: number;
  mrpPaise: number;
  discountPct?: number;
  conversionFactor?: number;
}

export class MarginGuard {
  // Configurable standard enterprise thresholds
  private static readonly MARGIN_HEALTHY_PCT = 15.0;
  private static readonly MARGIN_WARNING_PCT = 10.0;
  private static readonly MARGIN_SUPERVISOR_PCT = 5.0;
  private static readonly MAX_UNSUPERVISED_DISCOUNT_PCT = 15.0;

  /**
   * Evaluates gross margin and MRP protection rules for a line item
   */
  static evaluate(params: EvaluateMarginParams): MarginGuardResult {
    const {
      medicineId,
      batchId,
      sellingPricePaise,
      mrpPaise,
      discountPct = 0,
      conversionFactor = 1.0,
    } = params;

    // 1. MRP Violation Guardrail: Selling price cannot exceed MRP
    if (sellingPricePaise > mrpPaise) {
      const msg = `Selling price (₹${Money.toRupees(sellingPricePaise)}) exceeds statutory MRP (₹${Money.toRupees(mrpPaise)})`;
      return {
        costPaise: 0,
        costSource: 'DEFAULT_COST',
        sellingPricePaise,
        grossMarginPaise: 0,
        grossMarginPct: 0,
        status: 'BLOCKED',
        warningMessage: msg,
        requiresSupervisorApproval: true,
        approvalReason: msg,
      };
    }

    // 2. Fetch Effective Batch Acquisition Cost
    let costPaise = 0;
    let costSource: MarginGuardResult['costSource'] = 'DEFAULT_COST';

    let batchRow: any = null;
    if (batchId) {
      batchRow = localDb
        .prepare('SELECT * FROM medicine_batches WHERE id = ? OR _local_id = ?')
        .get(batchId, batchId);
    } else {
      batchRow = localDb
        .prepare(
          `SELECT * FROM medicine_batches 
           WHERE (medicine_id = ? OR medicine_id = ?) AND quantity_remaining > 0 
           ORDER BY expiry_date ASC LIMIT 1`
        )
        .get(medicineId, medicineId);
    }

    if (batchRow) {
      if (batchRow.cost_price_paise != null && Number(batchRow.cost_price_paise) > 0) {
        costPaise = Math.round(Number(batchRow.cost_price_paise) * conversionFactor);
        costSource = 'SUPPLIER_SCHEME_EFFECTIVE_COST';
      } else {
        const purchasePrice = Number(batchRow.purchase_price || 0);
        costPaise = Money.toPaise(purchasePrice * conversionFactor);
        costSource = 'BATCH_COST';
      }
    } else {
      // Fallback: estimate 70% of MRP if cost unknown
      costPaise = Math.round(mrpPaise * 0.7);
      costSource = 'DEFAULT_COST';
    }

    // 3. Compute Gross Margin
    const grossMarginPaise = sellingPricePaise - costPaise;
    const grossMarginPct = sellingPricePaise > 0
      ? Money.round2((grossMarginPaise / sellingPricePaise) * 100)
      : 0;

    let status: MarginGuardResult['status'] = 'ALLOWED';
    let warningMessage: string | undefined = undefined;
    let requiresSupervisorApproval = false;
    let approvalReason: string | undefined = undefined;

    // Check discount threshold
    if (discountPct > this.MAX_UNSUPERVISED_DISCOUNT_PCT) {
      requiresSupervisorApproval = true;
      approvalReason = `Discount of ${discountPct}% exceeds standard authorization threshold (${this.MAX_UNSUPERVISED_DISCOUNT_PCT}%)`;
    }

    // Check margin thresholds
    if (grossMarginPct < 0) {
      status = 'MANAGER_APPROVAL_REQUIRED';
      requiresSupervisorApproval = true;
      approvalReason = `Negative gross margin (${grossMarginPct}%). Selling below cost price (₹${Money.toRupees(costPaise)})`;
      warningMessage = approvalReason;
    } else if (grossMarginPct < this.MARGIN_SUPERVISOR_PCT) {
      status = 'SUPERVISOR_APPROVAL_REQUIRED';
      requiresSupervisorApproval = true;
      approvalReason = `Gross margin (${grossMarginPct}%) is below minimum threshold (${this.MARGIN_SUPERVISOR_PCT}%)`;
      warningMessage = approvalReason;
    } else if (grossMarginPct < this.MARGIN_WARNING_PCT) {
      status = 'SUPERVISOR_APPROVAL_REQUIRED';
      requiresSupervisorApproval = true;
      approvalReason = `Low gross margin (${grossMarginPct}%). Requires supervisor approval`;
      warningMessage = approvalReason;
    } else if (grossMarginPct < this.MARGIN_HEALTHY_PCT) {
      status = 'WARNING';
      warningMessage = `Moderate gross margin: ${grossMarginPct}% (Warning)`;
    }

    return {
      costPaise,
      costSource,
      sellingPricePaise,
      grossMarginPaise,
      grossMarginPct,
      status,
      warningMessage,
      requiresSupervisorApproval,
      approvalReason,
    };
  }
}
