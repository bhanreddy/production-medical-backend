/**
 * sync.ts — Express routes for offline-first sync engine.
 *
 * POST /api/sync/push  — Accepts batched operations from clients
 * GET  /api/sync/pull  — Returns delta rows since last pull
 * POST /api/sync/verify — Confirms records exist on server
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';
import { auditLog } from '../services/auditLog';
import {
  pushBodySchema,
  pullQuerySchema,
  verifyBodySchema,
  isValidSyncTable,
  isCriticalTable,
  validateBillingPayload,
  type PushBody,
  type PullQuery,
  type SyncableTable,
} from '../schemas/sync.schema';

export const syncRouter = Router();

/* ─── Column Exclusions ───────────────────────────────── */

/**
 * Columns that should NOT be forwarded from client payload to Supabase insert/update.
 * These are local-only tracking columns or computed server-side.
 */
const LOCAL_ONLY_COLUMNS = new Set([
  'id',            // Client uses local UUID as id; server has its own auto-generated id
  '_synced',
  '_deleted',
  '_updated_at',
  'server_id',
  'last_modified', // Dexie-only epoch timestamp
]);

/**
 * Strip local-only columns from a payload before sending to Supabase.
 * Maps `_local_id` from client to the `_local_id` column in Supabase.
 */
function cleanPayloadForSupabase(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (LOCAL_ONLY_COLUMNS.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/* ═══════════════════════════════════════════════════════
   POST /api/sync/push — Batched push from client
   ═══════════════════════════════════════════════════════ */

syncRouter.post('/push', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = pushBodySchema.parse(req.body);
    const clinicId = req.user?.clinic_id;
    const userId = req.user!.id;

    if (!clinicId) {
      return res.status(400).json({
        success: false,
        error: 'No clinic associated with this account. Please complete registration or contact support.',
      });
    }

    const results: Array<{
      table: string;
      queue_id: string;
      status: 'ok' | 'error';
      error?: string;
      server_id?: string;
    }> = [];

    let processedCount = 0;

    for (const batch of parsed.batches) {
      const { table, operations } = batch;

      // Validate table name
      if (!isValidSyncTable(table)) {
        for (const op of operations) {
          results.push({
            table,
            queue_id: op.queue_id,
            status: 'error',
            error: `Invalid sync table: ${table}`,
          });
        }
        continue;
      }

      for (const op of operations) {
        try {
          const payload = cleanPayloadForSupabase(op.payload);

          // Ensure clinic_id is always the authenticated user's clinic
          payload.clinic_id = clinicId;

          // Server-side validation for critical tables
          if (isCriticalTable(table)) {
            const validation = validateBillingPayload(table, payload);
            if (!validation.valid) {
              results.push({
                table,
                queue_id: op.queue_id,
                status: 'error',
                error: `Validation failed: ${validation.error}`,
              });
              continue;
            }
          }

          const localId = String(payload._local_id ?? '');

          // Verify ownership of existing row by localId if it exists to prevent cross-tenant overwrites
          if (localId) {
            const { data: existingRow, error: checkError } = await supabaseAdmin
              .from(table)
              .select('clinic_id')
              .eq('_local_id', localId)
              .maybeSingle();

            if (checkError) throw checkError;
            if (existingRow && existingRow.clinic_id !== clinicId) {
              results.push({
                table,
                queue_id: op.queue_id,
                status: 'error',
                error: 'Unauthorized: Record belongs to another clinic',
              });
              continue;
            }
          }

          if (op.op === 'INSERT') {
            // Upsert using _local_id as idempotency key
            const { data, error } = await supabaseAdmin
              .from(table)
              .upsert(payload, { onConflict: '_local_id' })
              .select('id')
              .single();

            if (error) throw error;

            await auditLog({
              clinicId,
              userId,
              action: 'CREATE',
              table,
              recordId: data?.id,
              newData: payload,
            });

            results.push({
              table,
              queue_id: op.queue_id,
              status: 'ok',
              server_id: data?.id,
            });
            processedCount++;

          } else if (op.op === 'UPDATE') {
            // Update by _local_id (idempotency key)
            const { data, error } = await supabaseAdmin
              .from(table)
              .update(payload)
              .eq('_local_id', localId)
              .eq('clinic_id', clinicId)
              .select('id')
              .single();

            if (error) {
              // If no row found by _local_id, try upsert (record may have been
              // created on another device that shared the _local_id)
              if (error.code === 'PGRST116') {
                const { data: upserted, error: uErr } = await supabaseAdmin
                  .from(table)
                  .upsert(payload, { onConflict: '_local_id' })
                  .select('id')
                  .single();

                if (uErr) throw uErr;

                results.push({
                  table,
                  queue_id: op.queue_id,
                  status: 'ok',
                  server_id: upserted?.id,
                });
                processedCount++;
                continue;
              }
              throw error;
            }

            await auditLog({
              clinicId,
              userId,
              action: 'UPDATE',
              table,
              recordId: data?.id,
              newData: payload,
            });

            results.push({
              table,
              queue_id: op.queue_id,
              status: 'ok',
              server_id: data?.id,
            });
            processedCount++;

          } else if (op.op === 'DELETE') {
            // Soft delete — set deleted_at, never hard delete
            const { data, error } = await supabaseAdmin
              .from(table)
              .update({ deleted_at: new Date().toISOString() })
              .eq('_local_id', localId)
              .eq('clinic_id', clinicId)
              .select('id')
              .single();

            if (error && error.code !== 'PGRST116') throw error;

            await auditLog({
              clinicId,
              userId,
              action: 'DELETE',
              table,
              recordId: data?.id,
              oldData: payload,
            });

            results.push({
              table,
              queue_id: op.queue_id,
              status: 'ok',
              server_id: data?.id,
            });
            processedCount++;
          }
        } catch (opError: any) {
          console.error(`[Sync Push] Error processing ${table}/${op.op}:`, opError.message);
          results.push({
            table,
            queue_id: op.queue_id,
            status: 'error',
            error: opError.message || 'Unknown error',
          });
        }
      }
    }

    res.json({
      success: true,
      processed: processedCount,
      results,
    });
  } catch (err) {
    next(err);
  }
});

/* ═══════════════════════════════════════════════════════
   GET /api/sync/pull — Delta pull for client
   ═══════════════════════════════════════════════════════ */

syncRouter.get('/pull', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { since, tables: tablesStr } = pullQuerySchema.parse(req.query);
    const clinicId = req.user?.clinic_id;

    if (!clinicId) {
      return res.status(400).json({
        error: { message: 'No clinic associated with this account.', code: 'NO_CLINIC' },
      });
    }

    const requestedTables = tablesStr.split(',').map((t) => t.trim());
    const validTables = requestedTables.filter(isValidSyncTable);

    if (validTables.length === 0) {
      return res.status(400).json({
        error: { message: 'No valid tables specified', code: 'INVALID_TABLES' },
      });
    }

    const result: Record<string, unknown[]> = {};

    await Promise.all(
      validTables.map(async (table) => {
        try {
          // Fetch all rows updated after `since` for this clinic
          const { data, error } = await supabaseAdmin
            .from(table)
            .select('*')
            .eq('clinic_id', clinicId)
            .gt('updated_at', since)
            .order('updated_at', { ascending: true })
            .limit(1000); // Safety cap per table

          if (error) {
            console.error(`[Sync Pull] Error fetching ${table}:`, error.message);
            result[table] = [];
            return;
          }

          result[table] = data || [];
        } catch (tableError: any) {
          console.error(`[Sync Pull] Exception on ${table}:`, tableError.message);
          result[table] = [];
        }
      })
    );

    res.json({
      tables: result,
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/* ═══════════════════════════════════════════════════════
   POST /api/sync/verify — Verify records exist on server
   ═══════════════════════════════════════════════════════ */

syncRouter.post('/verify', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { local_ids } = verifyBodySchema.parse(req.body);
    const clinicId = req.user!.clinic_id!;

    // Search across all syncable tables for these _local_ids
    const verified: Array<{ _local_id: string; confirmed: boolean; table?: string }> = [];

    // Batch check: query each table for any matching _local_ids
    const found = new Set<string>();

    for (const table of [
      'suppliers', 'customers', 'medicines', 'medicine_batches',
      'purchases', 'purchase_items', 'sales', 'sale_items',
      'expenses', 'shortbook', 'refill_reminders',
    ] as const) {
      try {
        const { data, error } = await supabaseAdmin
          .from(table)
          .select('_local_id')
          .eq('clinic_id', clinicId)
          .in('_local_id', local_ids);

        if (!error && data) {
          for (const row of data) {
            if (row._local_id) {
              found.add(row._local_id);
            }
          }
        }
      } catch {
        // Continue checking other tables
      }
    }

    for (const localId of local_ids) {
      verified.push({
        _local_id: localId,
        confirmed: found.has(localId),
      });
    }

    res.json({ verified });
  } catch (err) {
    next(err);
  }
});

/* ═══════════════════════════════════════════════════════
   GET /api/sync/conflicts — List unresolved conflicts for admin review
   ═══════════════════════════════════════════════════════ */

syncRouter.get('/conflicts', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // This endpoint is informational — the actual conflict queue lives on the CLIENT.
    // For admin review, clients can push their manual_review items to a server-side table.
    // For now, return a placeholder response.
    res.json({
      message: 'Conflict data is stored client-side in sync_queue with status=manual_review. Use the verify endpoint to check specific records.',
    });
  } catch (err) {
    next(err);
  }
});

export default syncRouter;
