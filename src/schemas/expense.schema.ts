import { z } from 'zod';

const baseExpenseSchema = z.object({
  category: z.enum(['rent', 'salary', 'utilities', 'supplies', 'maintenance', 'misc']),
  description: z.string().optional().nullable(),
  amount: z.number().positive(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_mode: z.enum(['cash', 'upi', 'card', 'bank_transfer']).default('cash'),
  store_id: z.string().optional().nullable(),
  counter_id: z.string().optional().nullable(),
  terminal_id: z.string().optional().nullable(),
  clinic_id: z.string().optional(),
  _local_id: z.string().optional(),
});

export const createExpenseSchema = baseExpenseSchema.transform(({ clinic_id, ...rest }) => rest);
export const updateExpenseSchema = baseExpenseSchema.partial().transform(({ clinic_id, ...rest }) => rest);
