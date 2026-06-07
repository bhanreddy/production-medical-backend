import { z } from 'zod';

const baseMedicineSchema = z.object({
  name: z.string().min(1).max(300),
  generic_name: z.string().optional().nullable(),
  manufacturer: z.string().optional().nullable(),
  category: z.enum(['tablet','syrup','injection','capsule','cream','drops','other']).default('tablet'),
  hsn_code: z.string().optional().nullable(),
  gst_rate: z.number().refine(v => [0,5,12,18].includes(v)).default(0),
  unit: z.string().default('strip'),
  is_schedule_h1: z.boolean().default(false),
  low_stock_threshold: z.number().int().positive().default(10),
  barcode: z.string().optional().nullable(),
  clinic_id: z.string().optional(),
});

export const createMedicineSchema = baseMedicineSchema.transform(({ clinic_id, ...rest }) => rest);
export const updateMedicineSchema = baseMedicineSchema.partial().transform(({ clinic_id, ...rest }) => rest);
