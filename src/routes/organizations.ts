import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { localDb } from '../local-db';
import { v4 as uuidv4 } from 'uuid';
import { InventoryReconciliationService } from '../services/inventoryReconciliation';
import { OrganizationMigrationService } from '../services/organizationMigration';

export const organizationsRouter = Router();

// GET /api/organizations
organizationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user!.clinic_id;
    let orgs: any[] = [];
    if (clinicId) {
      const clinic: any = localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(clinicId, clinicId);
      if (clinic?.organization_id) {
        orgs = localDb.prepare('SELECT * FROM organizations WHERE id = ? OR _local_id = ?').all(clinic.organization_id, clinic.organization_id);
      }
    }
    if (orgs.length === 0) {
      orgs = localDb.prepare('SELECT * FROM organizations WHERE _deleted = 0').all();
    }
    res.json({ data: orgs });
  } catch (err) {
    next(err);
  }
});

// POST /api/organizations
organizationsRouter.post('/', requireAuth, requireRole('SUPER_ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const {
      legal_name,
      display_name,
      code,
      gstin,
      pan,
      registered_address,
      billing_address,
      phone,
      email,
      timezone = 'Asia/Kolkata',
      currency = 'INR',
      financial_year_start = '04-01',
      default_state_code = '36',
    } = req.body;

    if (!legal_name || !code) {
      return res.status(400).json({ error: 'legal_name and code are required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO organizations (
           id, _local_id, legal_name, display_name, code, gstin, pan, registered_address, billing_address,
           phone, email, status, timezone, currency, financial_year_start, default_state_code,
           created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        id,
        legal_name,
        display_name || legal_name,
        code,
        gstin || null,
        pan || null,
        registered_address || null,
        billing_address || null,
        phone || null,
        email || null,
        timezone,
        currency,
        financial_year_start,
        default_state_code,
        now,
        now,
        now
      );

    const created = localDb.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/organizations/:id/stores
organizationsRouter.get('/:id/stores', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.params.id;
    const stores = localDb
      .prepare('SELECT * FROM stores WHERE (organization_id = ? OR organization_id IN (SELECT id FROM organizations WHERE _local_id = ?)) AND _deleted = 0')
      .all(orgId, orgId);
    res.json({ data: stores });
  } catch (err) {
    next(err);
  }
});

// POST /api/organizations/:id/stores
organizationsRouter.post('/:id/stores', requireAuth, requireRole('SUPER_ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const orgId = req.params.id;
    const {
      store_code,
      name,
      display_name,
      region_id,
      address,
      locality,
      city,
      district,
      state,
      state_code,
      pincode,
      gstin_override,
      drug_licence_number,
      phone,
      email,
      opening_time = '09:00',
      closing_time = '22:00',
    } = req.body;

    if (!store_code || !name) {
      return res.status(400).json({ error: 'store_code and name are required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO stores (
           id, _local_id, organization_id, region_id, store_code, name, display_name,
           address, locality, city, district, state, state_code, pincode, gstin_override,
           drug_licence_number, phone, email, opening_time, closing_time, status,
           fulfilment_enabled, created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
      )
      .run(
        id,
        id,
        orgId,
        region_id || null,
        store_code,
        name,
        display_name || name,
        address || null,
        locality || null,
        city || null,
        district || null,
        state || null,
        state_code || null,
        pincode || null,
        gstin_override || null,
        drug_licence_number || null,
        phone || null,
        email || null,
        opening_time,
        closing_time,
        now,
        now,
        now
      );

    const created = localDb.prepare('SELECT * FROM stores WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/organizations/:id/regions
organizationsRouter.get('/:id/regions', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.params.id;
    const regions = localDb.prepare('SELECT * FROM regions WHERE organization_id = ? AND _deleted = 0').all(orgId);
    res.json({ data: regions });
  } catch (err) {
    next(err);
  }
});

// POST /api/organizations/:id/regions
organizationsRouter.post('/:id/regions', requireAuth, requireRole('SUPER_ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const orgId = req.params.id;
    const { code, name, parent_region_id, manager_user_id } = req.body;
    if (!code || !name) {
      return res.status(400).json({ error: 'code and name are required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO regions (
           id, _local_id, organization_id, code, name, parent_region_id, manager_user_id,
           status, created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(id, id, orgId, code, name, parent_region_id || null, manager_user_id || null, now, now, now);

    const created = localDb.prepare('SELECT * FROM regions WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/organizations/:id/warehouses
organizationsRouter.get('/:id/warehouses', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.params.id;
    const warehouses = localDb.prepare('SELECT * FROM warehouses WHERE organization_id = ? AND _deleted = 0').all(orgId);
    res.json({ data: warehouses });
  } catch (err) {
    next(err);
  }
});

// POST /api/organizations/:id/warehouses
organizationsRouter.post('/:id/warehouses', requireAuth, requireRole('SUPER_ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const orgId = req.params.id;
    const { warehouse_code, name, address, gstin, state_code, cold_storage_supported = false } = req.body;
    if (!warehouse_code || !name) {
      return res.status(400).json({ error: 'warehouse_code and name are required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO warehouses (
           id, _local_id, organization_id, warehouse_code, name, address, gstin,
           state_code, status, cold_storage_supported, created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(
        id,
        id,
        orgId,
        warehouse_code,
        name,
        address || null,
        gstin || null,
        state_code || null,
        cold_storage_supported ? 1 : 0,
        now,
        now,
        now
      );

    const created = localDb.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/stores/:id/counters
organizationsRouter.get('/stores/:id/counters', requireAuth, async (req, res, next) => {
  try {
    const storeId = req.params.id;
    const counters = localDb.prepare('SELECT * FROM counters WHERE store_id = ? AND _deleted = 0').all(storeId);
    res.json({ data: counters });
  } catch (err) {
    next(err);
  }
});

// POST /api/stores/:id/counters
organizationsRouter.post('/stores/:id/counters', requireAuth, requireRole('SUPER_ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const storeId = req.params.id;
    const { counter_code, name } = req.body;
    if (!counter_code || !name) {
      return res.status(400).json({ error: 'counter_code and name are required' });
    }

    const store: any = localDb.prepare('SELECT organization_id FROM stores WHERE id = ? OR _local_id = ?').get(storeId, storeId);
    const orgId = store?.organization_id || 'default-org';
    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO counters (
           id, _local_id, organization_id, store_id, counter_code, name, status,
           created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(id, id, orgId, storeId, counter_code, name, now, now, now);

    const created = localDb.prepare('SELECT * FROM counters WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/stores/:id/terminals
organizationsRouter.get('/stores/:id/terminals', requireAuth, async (req, res, next) => {
  try {
    const storeId = req.params.id;
    const terminals = localDb.prepare('SELECT * FROM terminals WHERE store_id = ? AND _deleted = 0').all(storeId);
    res.json({ data: terminals });
  } catch (err) {
    next(err);
  }
});

// POST /api/stores/:id/terminals
organizationsRouter.post('/stores/:id/terminals', requireAuth, async (req, res, next) => {
  try {
    const storeId = req.params.id;
    const { device_uuid, terminal_code, terminal_name, platform = 'WEB', counter_id, app_version } = req.body;
    if (!device_uuid || !terminal_code || !terminal_name) {
      return res.status(400).json({ error: 'device_uuid, terminal_code, and terminal_name are required' });
    }

    const store: any = localDb.prepare('SELECT organization_id FROM stores WHERE id = ? OR _local_id = ?').get(storeId, storeId);
    const orgId = store?.organization_id || 'default-org';
    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT INTO terminals (
           id, _local_id, organization_id, store_id, counter_id, device_uuid,
           terminal_code, terminal_name, platform, app_version, last_seen_at, status,
           created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        id,
        id,
        orgId,
        storeId,
        counter_id || null,
        device_uuid,
        terminal_code,
        terminal_name,
        platform,
        app_version || '1.0.0',
        now,
        now,
        now,
        now
      );

    const created = localDb.prepare('SELECT * FROM terminals WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// POST /api/stores/:id/users (Assign user to store)
organizationsRouter.post('/stores/:id/users', requireAuth, requireRole('SUPER_ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const storeId = req.params.id;
    const { user_id, role = 'CASHIER', counter_id = null, is_default = false } = req.body;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const store: any = localDb.prepare('SELECT organization_id FROM stores WHERE id = ? OR _local_id = ?').get(storeId, storeId);
    const orgId = store?.organization_id || 'default-org';
    const id = uuidv4();
    const now = new Date().toISOString();

    localDb
      .prepare(
        `INSERT OR REPLACE INTO user_store_access (
           id, _local_id, user_id, organization_id, store_id, counter_id, role,
           is_default, is_active, created_at, updated_at, _updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(id, id, user_id, orgId, storeId, counter_id, role, is_default ? 1 : 0, now, now, now);

    const created = localDb.prepare('SELECT * FROM user_store_access WHERE id = ?').get(id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/organizations/reconciliation
organizationsRouter.get('/inventory/reconciliation', requireAuth, async (req, res, next) => {
  try {
    const batchId = req.query.batch_id as string;
    const storeId = req.query.store_id as string;
    if (!batchId) {
      return res.status(400).json({ error: 'batch_id query parameter is required' });
    }

    const report = InventoryReconciliationService.reconcileBatch({ batchId, storeId });
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
});

// POST /api/organizations/migrate-tenant
organizationsRouter.post('/migrate-tenant', requireAuth, requireRole('SUPER_ADMIN', 'OWNER'), async (req, res, next) => {
  try {
    const clinicId = req.body.clinic_id || req.user!.clinic_id;
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id is required' });
    }
    const result = OrganizationMigrationService.migrateClinic(clinicId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default organizationsRouter;
