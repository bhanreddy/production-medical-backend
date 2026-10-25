import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { queryAll, queryRaw } from "../lib/postgresDb";
import sql from "../db";
import { AppError } from "../lib/appError";
import { z } from "zod";

export const backupRouter = Router();
// Parent records precede their children. No credentials or platform users are exported.
const TABLES = [
  "suppliers",
  "customers",
  "medicines",
  "purchases",
  "medicine_batches",
  "purchase_items",
  "sales",
  "sale_items",
  "expenses",
  "shortbook",
  "purchase_orders",
  "purchase_returns",
  "purchase_return_lines",
  "stock_ledger",
  "audit_logs",
];
const REFERENCES: Record<string, string> = {
  supplier_id: "suppliers",
  customer_id: "customers",
  medicine_id: "medicines",
  batch_id: "medicine_batches",
  purchase_id: "purchases",
  sale_id: "sales",
  return_of: "sales",
  return_id: "purchase_returns",
  sale_item_id: "sale_items",
  store_id: "stores",
};

backupRouter.get(
  "/export",
  requireAuth,
  requireRole("OWNER", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const clinicId = req.user?.clinic_id;
      if (!clinicId)
        throw new AppError(400, "Choose a clinic before exporting.");
      const columns = await queryRaw<{ table_name: string }>(
        "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'clinic_id'",
      );
      const available = new Set(columns.map((row) => row.table_name));
      const data: Record<string, unknown[]> = {};
      const missingTables = TABLES.filter((table) => !available.has(table));
      for (const table of TABLES)
        if (available.has(table))
          data[table] = await queryAll(table, "clinic_id = ?", [clinicId]);
      res.json({
        success: true,
        version: 2,
        exportedAt: new Date().toISOString(),
        clinicId,
        complete: missingTables.length === 0,
        missingTables,
        data,
      });
    } catch (error) {
      next(error);
    }
  },
);

backupRouter.post(
  "/import",
  requireAuth,
  requireRole("OWNER", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      const clinicId = req.user?.clinic_id;
      if (!clinicId)
        throw new AppError(400, "Choose a clinic before restoring.");
      const data = z
        .record(
          z.string(),
          z.array(z.record(z.string(), z.unknown())).max(50_000),
        )
        .parse(req.body.data);
      const unknownTables = Object.keys(data).filter(
        (table) => !TABLES.includes(table),
      );
      if (unknownTables.length)
        throw new AppError(400, "Backup contains unsupported tables.");
      if (!Object.keys(data).length)
        throw new AppError(400, "Backup is empty.");
      await sql.begin(async (tx) => {
        const columns = await tx<
          { table_name: string; column_name: string }[]
        >`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
        const schema = new Map<string, Set<string>>();
        for (const column of columns) {
          if (!schema.has(column.table_name))
            schema.set(column.table_name, new Set());
          schema.get(column.table_name)!.add(column.column_name);
        }
        // Validate every identity before changing any records.
        for (const [table, rows] of Object.entries(data)) {
          if (!schema.get(table)?.has("clinic_id"))
            throw new AppError(
              409,
              "Apply database migrations before restoring this backup.",
            );
          for (const row of rows) {
            const id = z.string().uuid().parse(row.id);
            if (row.clinic_id && row.clinic_id !== clinicId)
              throw new AppError(403, "This backup belongs to another clinic.");
            const existing =
              await tx`SELECT clinic_id FROM ${tx(table)} WHERE id = ${id}`;
            if (existing.some((record) => record.clinic_id !== clinicId))
              throw new AppError(403, "Backup conflicts with another clinic.");
          }
        }
        for (const table of TABLES)
          for (const row of [...(data[table] || [])].sort(
            (a, b) =>
              Number(Boolean(a.return_of || a.sale_item_id)) -
              Number(Boolean(b.return_of || b.sale_item_id)),
          )) {
            const payload: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row))
              if (schema.get(table)?.has(key) && value !== undefined)
                payload[key] = value;
            payload.clinic_id = clinicId;
            if (schema.get(table)?.has("updated_at"))
              payload.updated_at = new Date().toISOString();
            for (const [field, parent] of Object.entries(REFERENCES))
              if (payload[field]) {
                const id = z.string().uuid().parse(payload[field]);
                const target =
                  await tx`SELECT clinic_id FROM ${tx(parent)} WHERE id = ${id}`;
                if (
                  !target.length ||
                  target.some((record) => record.clinic_id !== clinicId)
                )
                  throw new AppError(
                    403,
                    `Backup contains an unavailable ${field}.`,
                  );
              }
            for (const field of ["counter_id", "terminal_id"])
              if (payload[field]) {
                const parent =
                  field === "counter_id" ? "counters" : "terminals";
                const target =
                  await tx`SELECT s.clinic_id FROM ${tx(parent)} p JOIN stores s ON s.id = p.store_id WHERE p.id = ${z.string().uuid().parse(payload[field])}`;
                if (
                  !target.length ||
                  target.some((record) => record.clinic_id !== clinicId)
                )
                  throw new AppError(
                    403,
                    `Backup contains an unavailable ${field}.`,
                  );
              }
            if (payload.organization_id) {
              const clinic =
                await tx`SELECT organization_id FROM clinics WHERE id = ${clinicId}`;
              if (clinic[0]?.organization_id !== payload.organization_id)
                throw new AppError(
                  403,
                  "Backup contains an unavailable organization.",
                );
            }
            // Upsert avoids deleting unrelated records or breaking invoice references.
            const update = { ...payload };
            delete update.id;
            await tx`INSERT INTO ${tx(table)} ${tx(payload as never)} ON CONFLICT(id) DO UPDATE SET ${tx(update as never)}`;
          }
      });
      res.json({
        success: true,
        message: "Backup records restored successfully.",
      });
    } catch (error) {
      next(error);
    }
  },
);

export default backupRouter;
