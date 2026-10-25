import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import sql from "../db";
import { queryRaw } from "../lib/postgresDb";

export const clinicsRouter = Router();

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
      const {
        name,
        address,
        phone,
        email,
        gstin,
        drug_licence_number,
        logo_url,
        signature_url,
        invoice_footer,
        upi_vpa,
      } = req.body;

      // Only allow specific fields to be updated
      const payload: Record<string, any> = {
        name,
        address,
        phone,
        email,
        gstin,
        drug_licence_number,
        logo_url,
        signature_url,
        invoice_footer,
        upi_vpa,
      };

      // Remove undefined values
      Object.keys(payload).forEach(
        (key) => payload[key] === undefined && delete payload[key],
      );

      const [data] = await sql<any[]>`
      UPDATE clinics
      SET ${sql(payload)}
      WHERE id = ${req.user!.clinic_id!}
      RETURNING *
    `;

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
