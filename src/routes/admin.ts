import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../config/supabase";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { AppError } from "../lib/appError";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("SUPER_ADMIN"));
const profileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  owner_name: z.string().trim().max(200).optional(),
  address: z.string().max(1000).optional(),
  phone: z.string().max(30).optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  gstin: z.string().max(30).optional(),
  drug_licence_number: z.string().max(100).optional(),
  invoice_footer: z.string().max(2000).optional(),
  logo_url: z.string().max(1_000_000).nullable().optional(),
  signature_url: z.string().max(1_000_000).nullable().optional(),
});
adminRouter.get("/stats", async (_req, res, next) => {
  try {
    const [clinicsResult, usersResult] = await Promise.all([
      supabaseAdmin.from("clinics").select("id, plan, is_active"),
      supabaseAdmin.from("users").select("id", { count: "exact", head: true }),
    ]);
    if (clinicsResult.error) throw clinicsResult.error;
    if (usersResult.error) throw usersResult.error;
    const clinics = clinicsResult.data || [];
    const plans = new Map<string, number>();
    for (const clinic of clinics)
      plans.set(
        clinic.plan || "trial",
        (plans.get(clinic.plan || "trial") || 0) + 1,
      );
    res.json({
      total_clinics: clinics.length,
      active_clinics: clinics.filter((c) => c.is_active !== false).length,
      trial_clinics: clinics.filter((c) => !c.plan || c.plan === "trial")
        .length,
      paid_clinics: clinics.filter(
        (c) => !!c.plan && c.plan !== "trial" && c.plan !== "free",
      ).length,
      total_users: usersResult.count || 0,
      plan_distribution: Array.from(plans, ([plan, count]) => ({
        plan,
        count,
      })),
    });
  } catch (error) {
    next(error);
  }
});
adminRouter.get("/clinics", async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("clinics")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (error) {
    next(error);
  }
});
adminRouter.post("/clinics", async (req, res, next) => {
  try {
    const payload = profileSchema.parse(req.body);
    const { data, error } = await supabaseAdmin
      .from("clinics")
      .insert({
        ...payload,
        slug: `${
          payload.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60) || "clinic"
        }-${randomUUID().slice(0, 8)}`,
        plan: "trial",
        is_active: true,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (error) {
    next(error);
  }
});
adminRouter.get("/clinics/:id/profile", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("clinics")
      .select("*")
      .eq("id", z.string().uuid().parse(req.params.id))
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError(404, "Clinic not found");
    res.json({ data });
  } catch (error) {
    next(error);
  }
});
adminRouter.put("/clinics/:id/profile", async (req, res, next) => {
  try {
    const payload = profileSchema.parse(req.body);
    const { data, error } = await supabaseAdmin
      .from("clinics")
      .update(payload)
      .eq("id", z.string().uuid().parse(req.params.id))
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError(404, "Clinic not found");
    res.json({ data });
  } catch (error) {
    next(error);
  }
});
adminRouter.patch("/clinics/:id/status", async (req, res, next) => {
  try {
    const payload = z.object({ is_active: z.boolean() }).parse(req.body);
    const { data, error } = await supabaseAdmin
      .from("clinics")
      .update(payload)
      .eq("id", z.string().uuid().parse(req.params.id))
      .select("id, is_active")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError(404, "Clinic not found");
    res.json({ data });
  } catch (error) {
    next(error);
  }
});
adminRouter.get("/users", async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select(
        "id, full_name, phone, role, clinic_id, created_at, clinics(name)",
      )
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (error) {
    next(error);
  }
});
