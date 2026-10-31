import { z } from 'zod';
import { dateOnlySchema } from './date.schema';

const baseCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().regex(/^[6-9]\d{9}$/).optional().nullable(),
  email: z.string().email().optional().nullable(),
  credit_limit: z.number().finite().min(0).optional(),
  doctor_name: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  clinic_id: z.string().optional(),
});

export const createCustomerSchema = baseCustomerSchema.transform(({ clinic_id, ...rest }) => rest);
export const updateCustomerSchema = baseCustomerSchema.partial().transform(({ clinic_id, ...rest }) => rest);

export const recordPaymentSchema = z.object({
  amount: z.number().finite().positive(),
  payment_mode: z.enum(['cash', 'upi', 'card', 'bank_transfer']),
  note: z.string().optional(),
});

/** POST /customers/reminders — refill_reminders uses medicine_id + remind_on */
export const createRefillReminderSchema = z.object({
  customer_id: z.string().uuid(),
  medicine_name: z.string().trim().min(1).max(500),
  reminder_date: dateOnlySchema,
  notes: z.string().max(2000).optional(),
});
