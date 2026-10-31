import request from 'supertest';
import { createApp } from '../app';
const { routeManifest } = require('../../scripts/route-manifest.cjs');

type Route = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
const publicPaths = new Set(['/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/subscriptions/plans', '/api/subscriptions/webhook']);
const unique = new Map<string, Route>();
for (const route of routeManifest() as Route[]) {
  if (!publicPaths.has(route.path)) unique.set(`${route.method} ${route.path}`, route);
}
const app = createApp();
test.each([...unique.values()])('$method $path rejects unauthenticated access before executing a workflow', async ({ method, path }) => {
  const url = path.replace(/:[^/]+/g, '11111111-1111-4111-8111-111111111111');
  const response = await request(app)[method.toLowerCase() as 'get'](url).set('Connection', 'close').send({});
  expect([401, 403]).toContain(response.status);
});
test('unknown API paths return structured JSON instead of an HTML error page', async () => {
  const response = await request(app).get('/api/does-not-exist');
  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('NOT_FOUND');
});
