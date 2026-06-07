import { z } from 'zod';

export const addToShortbookSchema = z.object({
  medicine_id: z.string().uuid(),
  reason: z.enum(['low_stock','expired','manual']).default('manual'),
  quantity_needed: z.number().int().positive().optional(),
  preferred_supplier_id: z.string().uuid().optional().nullable(),
  clinic_id: z.string().optional(),
}).transform(({ clinic_id, ...rest }) => rest);
