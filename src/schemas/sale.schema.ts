import { z } from 'zod';

export const saleItemSchema = z.object({
  medicine_id: z.string().uuid(),
  batch_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  mrp: z.number().positive(),
  discount_pct: z.number().min(0).max(100).default(0),
  gst_rate: z.number().refine(v => [0,5,12,18].includes(v)).default(0),
});

export const createSaleSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  discount: z.number().min(0).default(0),
  payment_mode: z.enum(['cash','upi','card','credit']).default('cash'),
  payment_status: z.enum(['paid','partial','credit']).default('paid'),
  paid_amount: z.number().min(0),
  items: z.array(saleItemSchema).min(1),
  clinic_id: z.string().optional(),
}).transform(({ clinic_id, ...rest }) => rest);

export const saleReturnSchema = z.object({
  original_sale_id: z.string().uuid(),
  items: z.array(z.object({
    sale_item_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    reason: z.string().optional(),
  })).min(1),
});
