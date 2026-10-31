import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import sql from "../db";
import { queryRaw } from "../lib/postgresDb";

export const clinicsRouter = Router();
const profileUpdate = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  address: z.string().max(2000).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().email().or(z.literal('')).nullable().optional(),
  gstin: z.string().trim().length(15).or(z.literal('')).nullable().optional(),
  drug_licence_number: z.string().max(250).nullable().optional(),
  logo_url: z.string().max(1500000).nullable().optional(),
  signature_url: z.string().max(1500000).nullable().optional(),
  invoice_footer: z.string().max(2000).nullable().optional(),
  upi_vpa: z.string().trim().max(255).nullable().optional(),
}).refine(value => Object.keys(value).length > 0, 'Choose at least one setting to update');

// GET /api/clinics/me
clinicsRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    // Try fetching from local clinics table using id
    const clinics = await queryRaw("SELECT * FROM clinics WHERE id = ?", [
      req.user!.clinic_id!,
    ]);
    let profileData = clinics[0];

    if (!profileData) {
      // Fallback: Return a temporary store if no record found
      profileData = {
        id: req.user?.clinic_id || "temp-id",
        name:
          req.user?.role === "SUPER_ADMIN"
            ? "Super Admin Dashboard"
            : "My Medical Store",
        owner_name: req.user?.email || "Store Owner",
        gstin: "Not configured",
        drug_licence_number: "Not configured",
        address: "Not configured",
        phone: "Not configured",
        email: req.user?.email || "Not configured",
        is_active: true,
        logo_url: null,
      };
    }

    res.json({ data: profileData });
  } catch (err) {
    next(err);
  }
});

// PUT /api/clinics/me
clinicsRouter.put(
  "/me",
  requireAuth,
  requireRole("OWNER", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      if (!req.user?.clinic_id) return res.status(400).json({ error: 'Choose a clinic first.' });
      const payload = profileUpdate.parse(req.body);

      const [data] = await sql<any[]>`
      UPDATE clinics
      SET ${sql(payload)}
      WHERE id = ${req.user!.clinic_id!}
      RETURNING *
    `;

      if (!data) return res.status(404).json({ error: 'Clinic not found.' });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  },
);

// Staff directory is restricted to the current tenant and never exposes credentials.
clinicsRouter.get(
  "/users",
  requireAuth,
  requireRole("OWNER", "SUPER_ADMIN"),
  async (req, res, next) => {
    try {
      if (!req.user?.clinic_id)
        return res.status(400).json({ error: "Choose a clinic first." });
      const data = await queryRaw(
        "SELECT id, full_name, phone, role, is_active, created_at FROM users WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY full_name ASC",
        [req.user.clinic_id],
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);
