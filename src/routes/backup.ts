import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { queryAll } from '../lib/postgresDb';
import sql from '../db';

export const backupRouter = Router();

const TABLES = [
  'medicines',
  'medicine_batches',
  'sales',
  'sale_items',
  'purchases',
  'expenses',
  'customers',
  'suppliers',
  'shortbook',
  'purchase_orders',
  'supplier_ledger',
  'purchase_returns',
  'purchase_return_lines'
];

/**
 * GET /api/backup/export
 * Fetches all operational data belonging to the authenticated user's clinic.
 */
backupRouter.get('/export', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user?.clinic_id;
    if (!clinicId) {
      return res.status(400).json({ error: 'No clinic associated with this user.' });
    }

    const payload: Record<string, any[]> = {};

    for (const table of TABLES) {
      payload[table] = await queryAll(table, 'clinic_id = ?', [clinicId]);
    }

    res.json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/backup/import
 * Restores/upserts operational clinic data, safe under a single database transaction.
 */
backupRouter.post('/import', requireAuth, async (req, res, next) => {
  try {
    const clinicId = req.user?.clinic_id;
    if (!clinicId) {
      return res.status(400).json({ error: 'No clinic associated with this user.' });
    }

    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid backup data payload.' });
    }

    // Perform database transaction
    await sql.begin(async (tx) => {
      for (const table of TABLES) {
        const rows = data[table];
        if (!rows || !Array.isArray(rows)) continue;

        // Clear existing rows for this clinic to prevent duplication
        await tx`DELETE FROM ${tx(table)} WHERE clinic_id = ${clinicId}`;

        // Bulk insert imported rows
        for (const row of rows) {
          // Remove auto-generated columns or standard metadata if needed, but keeping original UUID keys
          const payload = {
            ...row,
            clinic_id: clinicId, // Enforce tenant boundaries
            _synced: 1,
            _updated_at: new Date().toISOString()
          };

          // Remove database-specific fields that might cause collision if they are identity columns (like pg serial id)
          if ('id_seq' in payload) {
            delete (payload as any).id_seq;
          }

          await tx`INSERT INTO ${tx(table)} ${tx(payload)}`;
        }
      }
    });

    res.json({ success: true, message: 'Restore completed successfully.' });
  } catch (err) {
    next(err);
  }
});

export default backupRouter;
