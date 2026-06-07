import { z } from 'zod';

const baseSupplierSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().regex(/^[6-9]\d{9}$/).optional().nullable(),
  email: z.string().email().optional().nullable(),
  gstin: z.string().length(15).optional().nullable(),
  drug_licence_number: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  clinic_id: z.string().optional(),
});

export const createSupplierSchema = baseSupplierSchema.transform(({ clinic_id, ...rest }) => rest);
export const updateSupplierSchema = baseSupplierSchema.partial().transform(({ clinic_id, ...rest }) => rest);
