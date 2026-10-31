import { z } from 'zod';

export const saleItemSchema = z.object({
  medicine_id: z.string(),
  batch_id: z.string(),
  quantity: z.number().int().positive(),
  mrp: z.number().finite().positive(),
  discount_pct: z.number().finite().min(0).max(100).default(0),
  gst_rate: z.number().refine(v => [0, 5, 12, 18, 28].includes(v)).default(12),
  _local_id: z.string().optional(),
});

export const createSaleSchema = z.object({
  customer_id: z.string().optional().nullable(),
  store_id: z.string().optional().nullable(),
  counter_id: z.string().optional().nullable(),
  terminal_id: z.string().optional().nullable(),
  discount: z.number().finite().min(0).default(0),
  price_includes_tax: z.boolean().default(false),
  payment_mode: z.enum(['cash', 'upi', 'card', 'credit']).default('cash'),
  payment_status: z.enum(['paid', 'partial', 'credit', 'returned']).default('paid'),
  paid_amount: z.number().finite().min(0).default(0),
  items: z.array(saleItemSchema).min(1),
  clinic_id: z.string().optional(),
  _local_id: z.string().optional(),
}).transform(({ clinic_id, ...rest }) => rest);

export const saleReturnSchema = z.object({
  original_sale_id: z.string(),
  store_id: z.string().optional().nullable(),
  counter_id: z.string().optional().nullable(),
  terminal_id: z.string().optional().nullable(),
  _local_id: z.string().optional(),
  items: z.array(
    z.object({
      sale_item_id: z.string(),
      quantity: z.number().int().positive(),
      reason: z.string().optional(),
      _local_id: z.string().optional(),
    })
  ).min(1),
});
