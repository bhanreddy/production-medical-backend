import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { AppError } from '../lib/appError';
import { MulterError } from 'multer';

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', {
    message: err.message,
    stack: env.NODE_ENV !== 'production' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    clinic_id: (req as any).user?.clinic_id,
    user_id: (req as any).user?.id,
  });

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        message: err.message,
        code: err.code,
      },
    });
  }

  if (err instanceof MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: {
      code: err.code, message: err.code === 'LIMIT_FILE_SIZE' ? 'This file is too large. Choose a file smaller than 10 MB.' : 'Upload one file at a time and try again.',
    } });
  }
  if (typeof err.code === 'string' && err.code.startsWith('CSV_')) {
    return res.status(400).json({ error: { code: 'INVALID_CSV', message: 'This CSV could not be read. Check the column headers and quoted values, then try again.' } });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.errors,
    });
  }

  const status = typeof err.status === 'number' ? err.status : 500;
  if (status !== 500) {
    return res.status(status).json({
      error: {
        message: err.message || 'Request failed',
        code: err.code,
      },
    });
  }

  return res.status(500).json({
    error: 'Internal Server Error',
  });
};
