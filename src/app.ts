import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import compression from 'compression';
import { routes } from './routes';

import { publicRouter } from './routes/public';
import { errorHandler } from './middleware/errorHandler';
import { helmetConfig, authRateLimit, apiRateLimit, sanitizeInput, validateUUID } from './middleware/security';
import { initSentry, sentryErrorHandler } from './lib/sentry';

dotenv.config();

export function createApp(): express.Application {
  initSentry();

  const app = express();
  // gzip holds small writes until its window fills, which would delay live events indefinitely.
  app.use(compression({
    filter: (req, res) =>
      !String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream') && compression.filter(req, res),
  }));

  app.param('id', (req, res, next, id) => {
    if (id !== 'returns' && !validateUUID(id)) {
      return res.status(400).json({ error: { message: 'Invalid ID format' } });
    }
    next();
  });

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const corsAllowAll = allowedOrigins.includes('*');

  app.use(
    cors(
      corsAllowAll
        ? { origin: true }
        : {
            origin(origin, callback) {
              if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
              } else {
                callback(new Error('Not allowed by CORS'));
              }
            },
          },
    ),
  );

  app.use(helmetConfig);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ limit: '2mb', extended: true }));
  app.use(sanitizeInput);
  morgan.token('url', req => { const url = 'originalUrl' in req && typeof req.originalUrl === 'string' ? req.originalUrl : req.url || ''; return url.replace(/([?&]token=)[^&]+/gi, '$1[redacted]'); });
  app.use(morgan('dev'));

  app.use('/public', publicRouter);

  app.use(['/api/auth/login', '/api/auth/register'], authRateLimit);
  app.use('/api', apiRateLimit, routes);

  sentryErrorHandler(app);
  app.use(errorHandler);

  return app;
}

