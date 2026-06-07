import request from 'supertest';
import express from 'express';

// Minimal app setup for health check testing
const app = express();

// We import the actual health router
import { healthRouter } from '../routes/health';
app.use('/api/health', healthRouter);

describe('GET /api/health', () => {
  it('should return status ok with db and memory info', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptime_seconds');
    expect(res.body).toHaveProperty('db');
    expect(res.body.db).toHaveProperty('status');
    expect(res.body.db).toHaveProperty('latency_ms');
    expect(res.body).toHaveProperty('memory');
    expect(res.body.memory).toHaveProperty('rss_mb');
  });
});
