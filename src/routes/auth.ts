import { Router } from 'express';
import { requireAuth } from '../middleware/auth';

import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireRole } from '../middleware/auth';

export const authRouter = Router();

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

import { enforcePlan } from '../middleware/planEnforcement';

// POST /invite - Invite user to clinic
authRouter.post('/invite', requireAuth, requireRole(['SUPER_ADMIN', 'OWNER']), enforcePlan, async (req, res, next) => {
  try {
    const { email, role, clinic_id } = req.body;
    // For OWNERs, force clinic_id to their own clinic
    const assignedClinic = req.user?.role === 'SUPER_ADMIN' ? clinic_id : req.user?.clinic_id;

    // Phase 6: Max users enforcement
    if (req.user?.role === 'OWNER') {
        const { count } = await supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('clinic_id', assignedClinic);
        const limits = (req as any).planLimits;
        if (count !== null && count >= (limits?.max_users || 1)) {
            return res.status(402).json({ error: { message: `Plan user limit (${limits?.max_users}) reached. Upgrade your plan.` } });
        }
    }

    // Send magic link invite
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
    if (authError) throw authError;

    // Insert user record with pending values (they will update full_name on first login or via settings later ideally)
    const { data: user, error: userError } = await supabaseAdmin.from('users').insert([{
      id: authData.user.id,
      clinic_id: assignedClinic,
      full_name: email.split('@')[0], // placeholder
      role
    }]).select().single();
    if (userError) throw userError;

    res.json({ user });
  } catch (err) {
    next(err);
  }
});
