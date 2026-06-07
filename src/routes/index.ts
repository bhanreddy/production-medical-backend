import { Router } from 'express';
import authRoutes from './auth.routes';
import { authenticateJWT } from '../middleware/authenticateJWT';

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

export const routes = Router();

// Public routes
routes.use('/auth', authRoutes);
routes.use('/health', healthRouter);

// Protected routes (Phase 2)
// routes.use(authenticateJWT);

// Mount operational routes
routes.use('/auth', authRouter);
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

