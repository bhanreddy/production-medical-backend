import { Request, Response, NextFunction } from 'express';
import { localDb } from '../local-db';
import { AppError } from '../lib/appError';

export interface StoreContext {
  organizationId: string;
  storeId: string;
  counterId?: string | null;
  role: string;
  isOrgAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      storeContext?: StoreContext;
    }
  }
}

export interface RequireStoreAccessOptions {
  paramName?: string; // e.g., 'storeId' or 'id'
  allowOrgAdminBypass?: boolean;
}

export function requireStoreAccess(options: RequireStoreAccessOptions = {}) {
  const { paramName = 'store_id', allowOrgAdminBypass = true } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return next(new AppError(401, 'Unauthorized', 'UNAUTHORIZED'));
      }

      const userId = req.user.id;
      const clinicId = req.user.clinic_id;

      // Extract requested storeId from body, params, or query
      const requestedStoreId =
        req.body?.[paramName] ||
        req.params?.[paramName] ||
        (req.query?.[paramName] as string) ||
        null;

      // 1. Resolve Organization ID
      let organizationId: string | null = null;
      if (clinicId) {
        const clinicRow: any = localDb
          .prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?')
          .get(clinicId, clinicId);
        organizationId = clinicRow?.organization_id || null;
      }

      // Check User Organization Access
      const uoaRow: any = organizationId
        ? localDb
            .prepare(
              'SELECT role, is_active FROM user_organization_access WHERE user_id = ? AND organization_id = ?'
            )
            .get(userId, organizationId)
        : null;

      const isSuperAdmin = req.user.role === 'SUPER_ADMIN';
      const isOrgOwner =
        req.user.role === 'OWNER' ||
        uoaRow?.role === 'OWNER' ||
        uoaRow?.role === 'REGIONAL_MANAGER';

      // 2. If no store requested, resolve default store
      let targetStoreId = requestedStoreId;
      let counterId: string | null = null;
      let userStoreRole = req.user.role;

      if (!targetStoreId) {
        // Fetch default store from user_store_access
        const defaultAccess: any = localDb
          .prepare(
            'SELECT store_id, counter_id, role FROM user_store_access WHERE user_id = ? AND is_active = 1 ORDER BY is_default DESC LIMIT 1'
          )
          .get(userId);

        if (defaultAccess) {
          targetStoreId = defaultAccess.store_id;
          counterId = defaultAccess.counter_id;
          userStoreRole = defaultAccess.role;
        } else if (clinicId) {
          // Fallback to clinic default store
          const storeRow: any = localDb
            .prepare('SELECT id FROM stores WHERE clinic_id = ? OR organization_id = ? LIMIT 1')
            .get(clinicId, organizationId);
          if (storeRow) {
            targetStoreId = storeRow.id;
          }
        }
      }

      if (!targetStoreId) {
        return next(new AppError(400, 'Store context could not be resolved', 'STORE_REQUIRED'));
      }

      // 3. Verify user access to the specific store
      if (isSuperAdmin || (isOrgOwner && allowOrgAdminBypass)) {
        // Full org-wide access
        req.storeContext = {
          organizationId: organizationId || 'default-org',
          storeId: targetStoreId,
          counterId,
          role: userStoreRole,
          isOrgAdmin: true,
        };
        return next();
      }

      // Check specific store access grant
      const storeAccessRow: any = localDb
        .prepare(
          'SELECT role, counter_id, is_active FROM user_store_access WHERE user_id = ? AND store_id = ?'
        )
        .get(userId, targetStoreId);

      if (!storeAccessRow || storeAccessRow.is_active !== 1) {
        return next(
          new AppError(
            403,
            `Access denied to store: ${targetStoreId}`,
            'FORBIDDEN_STORE_ACCESS'
          )
        );
      }

      req.storeContext = {
        organizationId: organizationId || 'default-org',
        storeId: targetStoreId,
        counterId: storeAccessRow.counter_id || counterId,
        role: storeAccessRow.role || userStoreRole,
        isOrgAdmin: false,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
