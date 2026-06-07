import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import mongoSanitize from 'express-mongo-sanitize';
import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// 1. Helmet — HTTP security headers
export const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "*.supabase.co"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
});

// 2. Rate limiters (per-IP, not per-user — covers unauthenticated attacks)
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,    // 15 minutes
  max: 10,                       // 10 login attempts per 15 min
  message: { error: { message: 'Too many login attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' } },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,          // 1 minute
  max: 300,                      // 300 requests per minute
  skip: (req: any) => req.user?.role === 'SUPER_ADMIN',
});

export const billScanRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,    // 1 hour
  max: 20,                       // 20 OCR scans per hour (Anthropic API cost control)
  message: { error: { message: 'Bill scan limit reached. Try again in an hour.', code: 'OCR_LIMIT' } },
});

// 3. Slow down brute force (slows response, doesn't block)
export const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 5,
  delayMs: () => 500, // delay 500ms after 5 hits
});

// 4. Input sanitization — strip $ and . from keys (NoSQL injection prevention edge case via Zod bypassing)
export const sanitizeInput = mongoSanitize();

// 5. UUID validation helper — use on all :id params
export function validateUUID(id: string): boolean {
  return z.string().uuid().safeParse(id).success;
}

export const requireValidUUID = (req: Request, res: Response, next: NextFunction) => {
  if (req.params.id && req.params.id !== 'returns') {
    if (!validateUUID(req.params.id)) {
      return res.status(400).json({ error: { message: 'Invalid ID format' } });
    }
  }
  next();
};
