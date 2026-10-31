import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LOCAL_DB_PATH = process.env.LOCAL_DB_PATH || join(mkdtempSync(join(tmpdir(), 'medical-unit-')), 'runtime.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jwt_testing_1234567890';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'test-jwt-secret-at-least-32-chars-long';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
