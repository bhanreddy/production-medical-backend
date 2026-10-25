import { localDb } from '../local-db';
import { AppError } from '../lib/appError';

export interface POSSessionContext {
  userId: string;
  userName: string;
  userRole: string;
  organizationId: string;
  organizationName: string;
  organizationGstin: string | null;
  organizationCurrency: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  storeGstin: string | null;
  counterId: string | null;
  counterCode: string | null;
  counterName: string | null;
  terminalId: string | null;
  terminalCode: string | null;
  terminalName: string | null;
  deviceUuid: string | null;
  permissions: {
    canDiscountOverride: boolean;
    canPriceOverride: boolean;
    canBatchOverride: boolean;
    canReturn: boolean;
    canCancel: boolean;
    canPark: boolean;
    canCrossCounterRecall: boolean;
    canSupervisorApprove: boolean;
  };
  connectionStatus: 'ONLINE' | 'OFFLINE';
  syncStatus: 'SYNCED' | 'PENDING' | 'CONFLICT';
}

export class POSSessionService {
  /**
   * Authoritatively resolve POS session context from authenticated user and optional terminal headers.
   * Ensures frontend cannot spoof store or organization ownership.
   */
  static resolveSession(params: {
    userId: string;
    clinicId?: string | null;
    requestedStoreId?: string | null;
    requestedCounterId?: string | null;
    requestedTerminalId?: string | null;
    deviceUuid?: string | null;
  }): POSSessionContext {
    const {
      userId,
      clinicId = null,
      requestedStoreId = null,
      requestedCounterId = null,
      requestedTerminalId = null,
      deviceUuid = null,
    } = params;

    // 1. Fetch User Record
    const userRow: any = localDb
      .prepare('SELECT * FROM users WHERE id = ? OR _local_id = ?')
      .get(userId, userId);

    if (!userRow) {
      throw new AppError(401, 'Authenticated user not found in local POS directory', 'USER_NOT_FOUND');
    }

    // 2. Resolve Organization Access
    const clinicOrganization = clinicId ? localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(clinicId, clinicId) as { organization_id?: string } | undefined : undefined;
    const orgAccess: any = clinicOrganization?.organization_id
      ? localDb.prepare('SELECT * FROM user_organization_access WHERE user_id = ? AND organization_id = ? AND is_active = 1 LIMIT 1').get(userId, clinicOrganization.organization_id)
      : localDb.prepare('SELECT * FROM user_organization_access WHERE user_id = ? AND is_active = 1 LIMIT 1').get(userId);

    let organizationId: string;
    let effectiveRole: string = userRow.role || 'CASHIER';

    if (orgAccess) {
      organizationId = orgAccess.organization_id;
      effectiveRole = orgAccess.role || effectiveRole;
    } else {
      // Fallback: Check clinic link if available
      const resolvedClinicId = clinicId || userRow.clinic_id;
      const clinicRow: any = resolvedClinicId
        ? localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(resolvedClinicId, resolvedClinicId)
        : null;

      if (clinicRow?.organization_id) {
        organizationId = clinicRow.organization_id;
      } else {
        throw new AppError(403, 'No organization assigned to this account', 'ORGANIZATION_NOT_ASSIGNED');
      }
    }

    const orgRow: any = localDb
      .prepare('SELECT * FROM organizations WHERE id = ? OR _local_id = ?')
      .get(organizationId, organizationId);

    // 3. Resolve Store Access
    let storeId: string;
    const isOrgAdmin = ['OWNER', 'SUPER_ADMIN', 'ORG_ADMIN', 'REGIONAL_MANAGER'].includes(effectiveRole);

    if (requestedStoreId) {
      // Verify user has access to requested store
      if (!isOrgAdmin) {
        const storeAccess: any = localDb
          .prepare('SELECT * FROM user_store_access WHERE user_id = ? AND (store_id = ? OR store_id IN (SELECT id FROM stores WHERE _local_id = ?)) AND is_active = 1')
          .get(userId, requestedStoreId, requestedStoreId);

        if (!storeAccess) {
          throw new AppError(403, 'Cross-store access denied: User not assigned to requested store', 'CROSS_STORE_ACCESS_DENIED');
        }
        storeId = storeAccess.store_id;
        effectiveRole = storeAccess.role || effectiveRole;
      } else {
        storeId = requestedStoreId;
      }
    } else {
      // Default Store Resolution
      const userDefaultStore: any = localDb
        .prepare('SELECT store_id, role FROM user_store_access WHERE user_id = ? AND organization_id = ? AND is_active = 1 ORDER BY is_default DESC LIMIT 1')
        .get(userId, organizationId);

      if (userDefaultStore) {
        storeId = userDefaultStore.store_id;
        effectiveRole = userDefaultStore.role || effectiveRole;
      } else {
        const defaultStore: any = localDb
          .prepare('SELECT id FROM stores WHERE organization_id = ? AND _deleted = 0 ORDER BY created_at ASC LIMIT 1')
          .get(organizationId);

        if (!defaultStore) {
          throw new AppError(404, 'No active store found for organization', 'STORE_NOT_FOUND');
        }
        storeId = defaultStore.id;
      }
    }

    const storeRow: any = localDb
      .prepare('SELECT * FROM stores WHERE id = ? OR _local_id = ?')
      .get(storeId, storeId);

    if (!storeRow) {
      throw new AppError(404, 'Resolved store not found', 'STORE_NOT_FOUND');
    }

    if (storeRow.organization_id !== organizationId || storeRow._deleted) {
      throw new AppError(403, 'Cross-organization store access denied', 'CROSS_STORE_ACCESS_DENIED');
    }

    // 4. Resolve Counter Context
    let counterId: string | null = null;
    let counterCode: string | null = null;
    let counterName: string | null = null;

    if (requestedCounterId) {
      const counterRow: any = localDb
        .prepare('SELECT * FROM counters WHERE (id = ? OR _local_id = ? OR counter_code = ?) AND store_id = ? AND _deleted = 0')
        .get(requestedCounterId, requestedCounterId, requestedCounterId, storeRow.id);
      if (counterRow) {
        counterId = counterRow.id || counterRow._local_id;
        counterCode = counterRow.counter_code;
        counterName = counterRow.name;
      }
    }
    if (!counterId) {
      const defaultCounter: any = localDb
        .prepare('SELECT * FROM counters WHERE store_id = ? AND _deleted = 0 ORDER BY created_at ASC LIMIT 1')
        .get(storeRow.id);
      if (defaultCounter) {
        counterId = defaultCounter.id || defaultCounter._local_id;
        counterCode = defaultCounter.counter_code;
        counterName = defaultCounter.name;
      }
    }

    // 5. Resolve Terminal Context
    let terminalId: string | null = null;
    let terminalCode: string | null = null;
    let terminalName: string | null = null;
    let resolvedDeviceUuid: string | null = deviceUuid;

    if (deviceUuid) {
      const terminalRow: any = localDb
        .prepare('SELECT * FROM terminals WHERE device_uuid = ? AND store_id = ? AND _deleted = 0')
        .get(deviceUuid, storeRow.id);
      if (terminalRow) {
        terminalId = terminalRow.id || terminalRow._local_id;
        terminalCode = terminalRow.terminal_code;
        terminalName = terminalRow.terminal_name;
      }
    }
    if (!terminalId && requestedTerminalId) {
      const terminalRow: any = localDb
        .prepare('SELECT * FROM terminals WHERE (id = ? OR _local_id = ? OR terminal_code = ?) AND store_id = ? AND _deleted = 0')
        .get(requestedTerminalId, requestedTerminalId, requestedTerminalId, storeRow.id);
      if (terminalRow) {
        terminalId = terminalRow.id || terminalRow._local_id;
        terminalCode = terminalRow.terminal_code;
        terminalName = terminalRow.terminal_name;
        resolvedDeviceUuid = terminalRow.device_uuid;
      }
    }
    if (!terminalId) {
      const defaultTerminal: any = localDb
        .prepare('SELECT * FROM terminals WHERE store_id = ? AND _deleted = 0 ORDER BY created_at ASC LIMIT 1')
        .get(storeRow.id);
      if (defaultTerminal) {
        terminalId = defaultTerminal.id || defaultTerminal._local_id;
        terminalCode = defaultTerminal.terminal_code;
        terminalName = defaultTerminal.terminal_name;
        resolvedDeviceUuid = defaultTerminal.device_uuid;
      }
    }

    // 6. Permissions Calculation
    const canSupervisor = ['OWNER', 'SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER'].includes(effectiveRole);
    const canPharmacist = canSupervisor || effectiveRole === 'PHARMACIST';

    const permissions = {
      canDiscountOverride: canSupervisor,
      canPriceOverride: canSupervisor,
      canBatchOverride: canPharmacist,
      canReturn: canPharmacist,
      canCancel: canSupervisor,
      canPark: true,
      canCrossCounterRecall: canPharmacist,
      canSupervisorApprove: canSupervisor,
    };

    // 7. Sync & Connection Status
    const unsyncedCountRow: any = localDb
      .prepare('SELECT COUNT(*) as count FROM sync_queue')
      .get();
    const hasPendingSync = (unsyncedCountRow?.count || 0) > 0;

    return {
      userId: userRow.id || userRow._local_id,
      userName: userRow.full_name || 'Cashier',
      userRole: effectiveRole,
      organizationId: orgRow?.id || organizationId,
      organizationName: orgRow?.legal_name || 'Pharmacy Organization',
      organizationGstin: orgRow?.gstin || null,
      organizationCurrency: orgRow?.currency || 'INR',
      storeId: storeRow.id || storeRow._local_id,
      storeCode: storeRow.store_code || 'MAIN',
      storeName: storeRow.name || 'Main Pharmacy Store',
      storeGstin: storeRow.gstin_override || orgRow?.gstin || null,
      counterId,
      counterCode,
      counterName,
      terminalId,
      terminalCode,
      terminalName,
      deviceUuid: resolvedDeviceUuid,
      permissions,
      connectionStatus: 'ONLINE',
      syncStatus: hasPendingSync ? 'PENDING' : 'SYNCED',
    };
  }
}
