import request from 'supertest';

jest.mock('../routes', () => {
  const routes = require('express').Router();
  routes.get('/health', (_req: unknown, res: any) => res.json({ status: 'ok' }));
  return { routes };
});
jest.mock('../routes/public', () => ({ publicRouter: require('express').Router() }));
jest.mock('../middleware/durableRuntime', () => ({ durableRuntime: (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../lib/sentry', () => ({ initSentry: jest.fn(), sentryErrorHandler: jest.fn() }));
import { createApp } from '../app';

const originalPort = process.env.X_ZOHO_CATALYST_LISTEN_PORT;
const originalOrigins = process.env.ALLOWED_ORIGINS;
afterEach(() => {
  if (originalPort === undefined) delete process.env.X_ZOHO_CATALYST_LISTEN_PORT;
  else process.env.X_ZOHO_CATALYST_LISTEN_PORT = originalPort;
  if (originalOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = originalOrigins;
});

test('AppSail leaves CORS response headers to Catalyst to avoid duplicate values', async () => {
  process.env.X_ZOHO_CATALYST_LISTEN_PORT = '9000';
  process.env.ALLOWED_ORIGINS = '*';
  const response = await request(createApp()).get('/api/health').set('Origin', 'https://nexmed.nexsyrus.com');
  expect(response.status).toBe(200);
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
  expect(response.headers['access-control-allow-credentials']).toBeUndefined();
});

test('other hosts retain configured CORS and authorization-header preflights', async () => {
  delete process.env.X_ZOHO_CATALYST_LISTEN_PORT;
  process.env.ALLOWED_ORIGINS = 'https://nexmed.nexsyrus.com';
  const app = createApp();
  const response = await request(app).options('/api/auth/login')
    .set('Origin', 'https://nexmed.nexsyrus.com')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type');
  expect(response.status).toBe(204);
  expect(response.headers['access-control-allow-origin']).toBe('https://nexmed.nexsyrus.com');
  expect(response.headers['access-control-allow-headers']).toBe('authorization,content-type');
  expect((await request(app).get('/api/health').set('Origin', 'https://nexmed.nexsyrus.com')).headers['access-control-allow-origin']).toBe('https://nexmed.nexsyrus.com');
});
