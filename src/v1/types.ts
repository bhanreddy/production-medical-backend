import type { Request } from 'express';

export type V1SyncTable =
  | 'medicines'
  | 'customers'
  | 'suppliers'
  | 'expenses'
  | 'purchases'
  | 'invoices'
  | 'invoice_items';

export interface V1RequestContext {
  deviceId: string;
  clinicId: string;
  lastSyncAt: string;
  clientVersion: string;
}

declare global {
  namespace Express {
    interface Request {
      v1?: V1RequestContext;
    }
  }
}

export function getV1(req: Request): V1RequestContext {
  if (!req.v1) throw new Error('v1 context missing');
  return req.v1;
}
