import './types';
import { Router } from 'express';
import { v1SyncRouter } from './sync/syncRouter';
import { v1SeedRouter } from './seedRouter';
import { v1InvoiceRouter } from './invoiceRouter';
import { v1HealthRouter } from './healthRouter';

export const v1Router = Router();

v1Router.use(v1HealthRouter);
v1Router.use('/sync', v1SyncRouter);
v1Router.use('/seed', v1SeedRouter);
v1Router.use('/invoice', v1InvoiceRouter);
