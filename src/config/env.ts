import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load the exact .env file depending on NODE_ENV, fallback to default .env
const nodeEnv = process.env.NODE_ENV || 'development';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${nodeEnv}`) });
// Also load generic .env as fallback for missing vars like DB passwords locally
dotenv.config();

const envSchema = z.object({
  PORT:                     z.string().default('5001'),
  NODE_ENV:                 z.enum(['development', 'staging', 'production', 'test']).default('development'),
  SUPABASE_URL:             z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET:      z.string().min(1),
  ALLOWED_ORIGINS:          z.string().min(1),
  ANTHROPIC_API_KEY:        z.string().optional(), // optional just in case OCR is delayed
  CRON_SECRET:              z.string().min(1).optional(), // making it optional because we might not have set it yet, but best practice is .min(1)
  LOG_LEVEL:                z.enum(['debug','info','warn','error']).default('info'),
  WHATSAPP_API_KEY:         z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  PHONEPE_ENV:                  z.string().optional(),
  PHONEPE_CLIENT_ID:            z.string().optional(),
  PHONEPE_CLIENT_SECRET:        z.string().optional(),
  PHONEPE_CLIENT_VERSION:       z.string().optional(),
  PHONEPE_MERCHANT_ID:          z.string().optional(),
  PHONEPE_CLINIC_REDIRECT_URL:  z.string().url().optional(),
  PHONEPE_WEBHOOK_USERNAME:     z.string().optional(),
  PHONEPE_WEBHOOK_PASSWORD:     z.string().optional(),
  APP_URL:                  z.string().url().optional(),
  SENTRY_DSN:               z.string().url().optional(),
});

export const env = envSchema.parse(process.env);
