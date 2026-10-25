import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { DoctorService } from '../services/prescription/doctorService';
import { AppError } from '../lib/appError';
import { requireRole } from '../middleware/rbac';
import { localDb } from '../local-db';
import { z } from 'zod';

export const doctorsRouter = Router();

doctorsRouter.use(requireAuth);
function organizationId(req: any): string {
  if (!req.user?.clinic_id) throw new AppError(403, 'No clinic assigned');
  const clinic = localDb.prepare('SELECT organization_id FROM clinics WHERE id = ? OR _local_id = ?').get(req.user.clinic_id, req.user.clinic_id) as { organization_id?: string } | undefined;
  return clinic?.organization_id || req.user.clinic_id;
}

doctorsRouter.get('/', async (req, res, next) => {
  try {
    const orgId = organizationId(req);
    if (req.query.organization_id && req.query.organization_id !== orgId) throw new AppError(403, 'Cross-organization access denied');
    const query = req.query.q as string;
    const doctors = DoctorService.getDoctors({ organizationId: orgId, query });
    res.json({ success: true, data: doctors });
  } catch (err) {
    next(err);
  }
});

doctorsRouter.get('/:id', async (req, res, next) => {
  try {
    const doctor = DoctorService.getDoctorById(req.params.id);
    if (!doctor || ![organizationId(req), req.user!.clinic_id].includes(doctor.organization_id || '')) {
      throw new AppError(404, 'Doctor not found', 'DOCTOR_NOT_FOUND');
    }
    res.json({ success: true, data: doctor });
  } catch (err) {
    next(err);
  }
});

doctorsRouter.post('/', requireRole('OWNER', 'PHARMACIST', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { name, registration_number, registration_authority, specialization, phone, clinic_hospital, address } = z.object({ name: z.string().trim().min(1).max(200), registration_number: z.string().trim().min(1).max(100), registration_authority: z.string().max(200).optional(), specialization: z.string().max(200).optional(), phone: z.string().max(30).optional(), clinic_hospital: z.string().max(200).optional(), address: z.string().max(2000).optional() }).parse(req.body);
    if (!name || !registration_number) {
      throw new AppError(400, 'Doctor name and registration number are required', 'MISSING_FIELDS');
    }

    const doctor = DoctorService.createDoctor({
      organizationId: organizationId(req),
      name,
      registrationNumber: registration_number,
      registrationAuthority: registration_authority,
      specialization,
      phone,
      clinicHospital: clinic_hospital,
      address,
    });

    res.status(201).json({ success: true, data: doctor });
  } catch (err) {
    next(err);
  }
});
