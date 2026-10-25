import { Router } from 'express';
import { adminRouter } from './admin';
import authRoutes from './auth.routes';
import { requireAuth } from '../middleware/auth';
import { localDb } from '../local-db';
import { ensureCloudReferenceCatalog, invalidateCloudReferenceCatalog } from '../services/cloudReferenceCatalog';

// Import all operational routers
import { healthRouter } from './health';
import { authRouter } from './auth';
import salesRouter from './sales';
import purchasesRouter from './purchases';
import expensesRouter from './expenses';
import inventoryRouter from './inventory';
import suppliersRouter from './suppliers';
import customersRouter from './customers';
import { devicesRouter } from './devices';
import eventsRouter from './events';
import reportsRouter from './reports';
import accountingRouter from './accounting';
import { analyticsRouter } from './analytics';
import shortbookRouter from './shortbook';
import { subscriptionsRouter } from './subscriptions';
import { whatsappRouter } from './whatsapp';
import medicineMasterRouter from './medicineMaster';
import billsRouter from './bills';
import { userRouter } from './user';
import { bulkRouter } from './bulk';
import { medicalSuperadminRouter } from './medicalSuperadmin';
import backupRouter from './backup';
import { clinicsRouter } from './clinics';
import organizationsRouter from './organizations';
import barcodesRouter from './barcodes';
import { posRouter } from './pos';
import { commercialRouter } from './commercial';
import { doctorsRouter } from './doctors';
import { prescriptionsRouter } from './prescriptions';
import { patientsRouter } from './patients';
import { procurementRouter } from './procurement';
import transfersRouter from './transfers';
import warehouseRouter from './warehouse';
import { ordersRouter } from './orders';

export const routes = Router();

routes.use((req, res, next) => {
  if (req.method !== 'GET' && /^\/(inventory|suppliers|customers|sales|purchases)(\/|$)/.test(req.path)) res.on('finish', () => {
    if (res.statusCode < 400 && req.user?.clinic_id) invalidateCloudReferenceCatalog(req.user.clinic_id);
  });
  next();
});
routes.use(['/procurement', '/commercial', '/prescriptions', '/patients', '/doctors', '/orders'], requireAuth, async (req, _res, next) => {
  try {
    if (process.env.NODE_ENV === 'test' && process.env.CLOUD_REFERENCE_CATALOG_ENABLED !== 'true') return next();
    if (req.user?.clinic_id) {
      const clinic = localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(req.user.clinic_id, req.user.clinic_id) as { organization_id?: string } | undefined;
      await ensureCloudReferenceCatalog(req.user.clinic_id, clinic?.organization_id || req.user.clinic_id);
    }
    next();
  } catch (error) { next(error); }
});

// Public routes
routes.use('/auth', authRoutes);
routes.use('/health', healthRouter);

// Protected routes (Phase 2)
// routes.use(authenticateJWT);

// Mount operational routes
routes.use('/auth', authRouter);
routes.use('/admin', adminRouter);
routes.use('/sales', salesRouter);
routes.use('/purchases', purchasesRouter);
routes.use('/expenses', expensesRouter);
routes.use('/inventory', inventoryRouter);
routes.use('/suppliers', suppliersRouter);
routes.use('/customers', customersRouter);
routes.use('/devices', devicesRouter);
routes.use('/events', eventsRouter);
routes.use('/reports', reportsRouter);
routes.use('/accounting', accountingRouter);
routes.use('/analytics', analyticsRouter);
routes.use('/shortbook', shortbookRouter);
routes.use('/subscriptions', subscriptionsRouter);
routes.use('/whatsapp', whatsappRouter);
routes.use('/', medicineMasterRouter); // Mounted at / because it contains the prefix '/master'
routes.use('/bills', billsRouter);
routes.use('/user', userRouter);
routes.use('/bulk', bulkRouter);
routes.use('/superadmin', medicalSuperadminRouter);
routes.use('/backup', backupRouter);
routes.use('/clinics', clinicsRouter);
routes.use('/organizations', organizationsRouter);
routes.use('/barcodes', barcodesRouter);
routes.use('/pos', posRouter);
routes.use('/commercial', commercialRouter);
routes.use('/doctors', doctorsRouter);
routes.use('/prescriptions', prescriptionsRouter);
routes.use('/patients', patientsRouter);
routes.use('/procurement', procurementRouter);
routes.use('/transfers', transfersRouter);
routes.use('/warehouse', warehouseRouter);
routes.use('/orders', ordersRouter);
