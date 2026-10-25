// transferPolicyService.ts — Transfer Policies & Approval Tier Evaluation
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { TransferPolicy, TransferType } from '../../domain/transferTypes';

export class TransferPolicyService {
  /**
   * Get policy for an organization with sensible defaults
   */
  static getPolicy(organizationId: string): TransferPolicy {
    const row: any = localDb
      .prepare(
        `SELECT * FROM transfer_policies
         WHERE (organization_id = ?) AND _deleted = 0 LIMIT 1`
      )
      .get(organizationId);

    if (row) {
      return {
        id: row.id,
        organizationId: row.organization_id,
        autoApproveRoutineTransfers: Boolean(row.auto_approve_routine_transfers),
        autoApproveValueLimitPaise: Number(row.auto_approve_value_limit_paise || 1000000),
        storeManagerApprovalLimitPaise: Number(row.store_manager_approval_limit_paise || 5000000),
        regionalManagerApprovalLimitPaise: Number(row.regional_manager_approval_limit_paise || 20000000),
        enforceMakerChecker: Boolean(row.enforce_maker_checker),
        requirePackVerification: Boolean(row.require_pack_verification ?? true),
        requireFefoAllocation: Boolean(row.require_fefo_allocation ?? true),
        minShelfLifeDaysTransfer: Number(row.min_shelf_life_days_transfer || 60),
        allowPartialReceipt: Boolean(row.allow_partial_receipt ?? true),
        autoCloseOnExactReceipt: Boolean(row.auto_close_on_exact_receipt ?? true),
      };
    }

    return {
      organizationId,
      autoApproveRoutineTransfers: false,
      autoApproveValueLimitPaise: 1000000, // ₹10,000 auto-approval limit
      storeManagerApprovalLimitPaise: 5000000, // ₹50,000 Store Manager limit
      regionalManagerApprovalLimitPaise: 20000000, // ₹2,00,000 Regional Manager limit
      enforceMakerChecker: false,
      requirePackVerification: true,
      requireFefoAllocation: true,
      minShelfLifeDaysTransfer: 60,
      allowPartialReceipt: true,
      autoCloseOnExactReceipt: true,
    };
  }

  /**
   * Set or update policy for an organization
   */
  static setPolicy(policy: Partial<TransferPolicy> & { organizationId: string }): TransferPolicy {
    const existing = this.getPolicy(policy.organizationId);
    const id = existing.id || uuidv4();

    localMutate({
      table: 'transfer_policies',
      operation: existing.id ? 'UPDATE' : 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: policy.organizationId,
        auto_approve_routine_transfers: policy.autoApproveRoutineTransfers !== undefined ? (policy.autoApproveRoutineTransfers ? 1 : 0) : (existing.autoApproveRoutineTransfers ? 1 : 0),
        auto_approve_value_limit_paise: policy.autoApproveValueLimitPaise ?? existing.autoApproveValueLimitPaise,
        store_manager_approval_limit_paise: policy.storeManagerApprovalLimitPaise ?? existing.storeManagerApprovalLimitPaise,
        regional_manager_approval_limit_paise: policy.regionalManagerApprovalLimitPaise ?? existing.regionalManagerApprovalLimitPaise,
        enforce_maker_checker: policy.enforceMakerChecker !== undefined ? (policy.enforceMakerChecker ? 1 : 0) : (existing.enforceMakerChecker ? 1 : 0),
        require_pack_verification: policy.requirePackVerification !== undefined ? (policy.requirePackVerification ? 1 : 0) : (existing.requirePackVerification ? 1 : 0),
        require_fefo_allocation: policy.requireFefoAllocation !== undefined ? (policy.requireFefoAllocation ? 1 : 0) : (existing.requireFefoAllocation ? 1 : 0),
        min_shelf_life_days_transfer: policy.minShelfLifeDaysTransfer ?? existing.minShelfLifeDaysTransfer,
        allow_partial_receipt: policy.allowPartialReceipt !== undefined ? (policy.allowPartialReceipt ? 1 : 0) : (existing.allowPartialReceipt ? 1 : 0),
        auto_close_on_exact_receipt: policy.autoCloseOnExactReceipt !== undefined ? (policy.autoCloseOnExactReceipt ? 1 : 0) : (existing.autoCloseOnExactReceipt ? 1 : 0),
      },
    });

    return this.getPolicy(policy.organizationId);
  }

  /**
   * Determine required approval role based on value and transfer type
   */
  static getRequiredApprovalRole(
    organizationId: string,
    amountPaise: number,
    transferType: TransferType,
    isControlled: boolean = false
  ): 'AUTO' | 'STORE_MANAGER' | 'REGIONAL_MANAGER' | 'HQ_PROCUREMENT' {
    const policy = this.getPolicy(organizationId);

    // Emergency and recall transfers can follow configured policies
    if (transferType === 'WAREHOUSE_TO_STORE' && policy.autoApproveRoutineTransfers && amountPaise <= policy.autoApproveValueLimitPaise && !isControlled) {
      return 'AUTO';
    }

    if (isControlled) {
      return 'HQ_PROCUREMENT';
    }

    if (amountPaise <= policy.storeManagerApprovalLimitPaise) {
      return 'STORE_MANAGER';
    }

    if (amountPaise <= policy.regionalManagerApprovalLimitPaise) {
      return 'REGIONAL_MANAGER';
    }

    return 'HQ_PROCUREMENT';
  }
}
