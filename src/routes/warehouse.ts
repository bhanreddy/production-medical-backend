// warehouse.ts — Warehouse Bins & Operations Router
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { WarehouseOperationsService } from "../services/warehouse/warehouseOperationsService";

const router = Router();

function getOrgId(req: any): string {
  return req.user?.organizationId || req.user?.clinic_id || "default-org";
}

router.get("/bins", requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const { warehouseId } = req.query;
    if (!warehouseId)
      return res.status(400).json({ error: "warehouseId is required" });
    const bins = WarehouseOperationsService.listBins(
      orgId,
      warehouseId as string,
    );
    res.json(bins);
  } catch (err: any) {
    res
      .status(typeof err.status === "number" ? err.status : 500)
      .json({
        error: err.status ? err.message : "Unable to load warehouse data",
      });
  }
});

router.post("/bins", requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const bin = WarehouseOperationsService.createBin({
      ...req.body,
      organizationId: orgId,
    });
    res.status(201).json(bin);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/operations/dashboard", requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const { warehouseId } = req.query;
    if (!warehouseId)
      return res.status(400).json({ error: "warehouseId is required" });
    const dashboard = WarehouseOperationsService.getWarehouseDashboard(
      orgId,
      warehouseId as string,
    );
    res.json(dashboard);
  } catch (err: any) {
    res
      .status(typeof err.status === "number" ? err.status : 500)
      .json({
        error: err.status ? err.message : "Unable to load warehouse data",
      });
  }
});

export default router;
