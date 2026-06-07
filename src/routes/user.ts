import { Router } from 'express';
import { requireAuth } from '../middleware/auth';

export const userRouter = Router();

userRouter.get('/profile', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
