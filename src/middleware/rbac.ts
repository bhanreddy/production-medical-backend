import { Request, Response, NextFunction } from 'express';
import { Role } from '../types';

// Usage: router.get('/settings', requireAuth, requireRole('OWNER'), handler)
export const requireRole = (...roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
};
