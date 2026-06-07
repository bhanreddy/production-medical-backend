import { Request, Response, NextFunction } from 'express';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Must run after requireAuth. Validates device + clinic headers.
 */
export function validateV1Headers(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.clinic_id) {
    return res.status(403).json({ error: 'Clinic context required for v1 API' });
  }

  const deviceId = (req.headers['x-device-id'] as string)?.trim();
  const clinicHeader = (req.headers['x-clinic-id'] as string)?.trim();
  const lastSyncAt = (req.headers['x-last-sync-at'] as string)?.trim() || 'never';
  const clientVersion = (req.headers['x-client-version'] as string)?.trim() || '0.0.0';

  if (!deviceId || deviceId.length > 64) {
    return res.status(400).json({ error: 'Missing or invalid X-Device-ID' });
  }
  if (!clinicHeader || !UUID_RE.test(clinicHeader)) {
    return res.status(400).json({ error: 'Missing or invalid X-Clinic-ID' });
  }
  if (clinicHeader !== req.user.clinic_id) {
    return res.status(403).json({ error: 'X-Clinic-ID does not match authenticated clinic' });
  }

  req.v1 = {
    deviceId,
    clinicId: req.user.clinic_id,
    lastSyncAt,
    clientVersion,
  };
  next();
}
