import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { validateV1Headers } from './middleware/requireV1Context';
import { getV1 } from './types';
import { generateInvoiceNumber } from '../services/invoiceNumber';

export const v1InvoiceRouter = Router();

v1InvoiceRouter.get('/next-number', requireAuth, validateV1Headers, async (req, res, next) => {
  try {
    const v1 = getV1(req);
    const invoiceNumber = await generateInvoiceNumber(v1.clinicId);
    res.json({ invoiceNumber, reservedAt: new Date().toISOString() });
  } catch (e) {
    next(e);
  }
});
