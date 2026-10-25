// transfers.ts — Enterprise Multi-Store Transfers & Central Replenishment Router
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { StockTransferService } from '../services/transfers/stockTransferService';
import { TransferAllocationService } from '../services/transfers/transferAllocationService';
import { TransferPickPackService } from '../services/transfers/transferPickPackService';
import { TransferDispatchService } from '../services/transfers/transferDispatchService';
import { TransferReceivingService } from '../services/transfers/transferReceivingService';
import { TransferVarianceService } from '../services/transfers/transferVarianceService';
import { InternalReplenishmentEngine } from '../services/transfers/internalReplenishmentEngine';
import { StoreRebalancingEngine } from '../services/transfers/storeRebalancingEngine';
import { ExpiryRedistributionEngine } from '../services/transfers/expiryRedistributionEngine';
import { LocationService } from '../services/transfers/locationService';
import { TransferPolicyService } from '../services/transfers/transferPolicyService';
import { localDb } from '../local-db';

const router = Router();

// Helper to resolve orgId from request
function getOrgId(req: any): string {
  return req.user?.organizationId || req.user?.clinic_id || 'default-org';
}

// ──────────────────────────────────────────
// 1. TRANSFER LIST & DETAIL
// ──────────────────────────────────────────
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const { status, transferType, priority, sourceLocationId, destinationLocationId, search, page, limit } = req.query;
    const result = StockTransferService.listTransfers({
      organizationId: orgId,
      status: status as string,
      transferType: transferType as string,
      priority: priority as string,
      sourceLocationId: sourceLocationId as string,
      destinationLocationId: destinationLocationId as string,
      search: search as string,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/locations', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const locs = LocationService.listLocations(orgId);
    res.json(locs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/policy', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const policy = TransferPolicyService.getPolicy(orgId);
    res.json(policy);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/policy', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const updated = TransferPolicyService.setPolicy({ ...req.body, organizationId: orgId });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/dashboard/summary', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const requestedCount = localDb
      .prepare(`SELECT COUNT(*) as cnt FROM stock_transfers WHERE organization_id = ? AND status = 'REQUESTED' AND _deleted = 0`)
      .get(orgId) as any;
    const approvedCount = localDb
      .prepare(`SELECT COUNT(*) as cnt FROM stock_transfers WHERE organization_id = ? AND status = 'APPROVED' AND _deleted = 0`)
      .get(orgId) as any;
    const readyToPickCount = localDb
      .prepare(`SELECT COUNT(*) as cnt FROM stock_transfers WHERE organization_id = ? AND status IN ('READY_TO_PICK', 'PICKING') AND _deleted = 0`)
      .get(orgId) as any;
    const inTransitCount = localDb
      .prepare(`SELECT COUNT(*) as cnt FROM stock_transfers WHERE organization_id = ? AND status IN ('DISPATCHED', 'IN_TRANSIT') AND _deleted = 0`)
      .get(orgId) as any;
    const varianceCount = localDb
      .prepare(`SELECT COUNT(*) as cnt FROM transfer_variances WHERE organization_id = ? AND status = 'REPORTED' AND _deleted = 0`)
      .get(orgId) as any;

    res.json({
      requestedCount: Number(requestedCount?.cnt || 0),
      approvedCount: Number(approvedCount?.cnt || 0),
      readyToPickCount: Number(readyToPickCount?.cnt || 0),
      inTransitCount: Number(inTransitCount?.cnt || 0),
      varianceCount: Number(varianceCount?.cnt || 0),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const transfer = StockTransferService.getTransferById(req.params.id, orgId);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    res.json(transfer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// 2. LIFECYCLE MUTATIONS
// ──────────────────────────────────────────
router.post('/', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const transfer = StockTransferService.createTransfer({
      ...req.body,
      organizationId: orgId,
      requestedBy: req.user?.id || 'USER',
    });
    res.status(201).json(transfer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/approve', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const transfer = StockTransferService.approveTransfer({
      transferId: req.params.id,
      organizationId: orgId,
      approvedBy: req.user?.id || 'MANAGER',
      userRole: req.user?.role,
    });
    res.json(transfer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reject', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const transfer = StockTransferService.rejectTransfer({
      transferId: req.params.id,
      organizationId: orgId,
      rejectedBy: req.user?.id || 'MANAGER',
      rejectionReason: req.body.reason || 'Rejected by supervisor',
    });
    res.json(transfer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/allocate', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const allocs = TransferAllocationService.allocateTransfer({
      transferId: req.params.id,
      organizationId: orgId,
      allocatedBy: req.user?.id || 'USER',
      customAllocations: req.body.customAllocations,
    });
    res.json(allocs);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/picklist', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const pickList = TransferPickPackService.generatePickList(req.params.id, orgId);
    res.json(pickList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/pick', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const result = TransferPickPackService.recordPick({
      transferId: req.params.id,
      allocationId: req.body.allocationId,
      organizationId: orgId,
      scannedBarcode: req.body.scannedBarcode,
      scannedBatchNumber: req.body.scannedBatchNumber,
      quantityPicked: Number(req.body.quantityPicked),
      pickedBy: req.user?.id || 'PICKER',
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/complete-pick', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const result = TransferPickPackService.completePicking(req.params.id, orgId, req.user?.id || 'PICKER');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/pack', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const pkg = TransferPickPackService.createPackage({
      transferId: req.params.id,
      organizationId: orgId,
      packageType: req.body.packageType,
      isColdChain: req.body.isColdChain,
      items: req.body.items,
      packedBy: req.user?.id || 'PACKER',
      weightKg: req.body.weightKg,
      specialInstructions: req.body.specialInstructions,
    });
    res.status(201).json(pkg);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/dispatch', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const transfer = TransferDispatchService.dispatchTransfer({
      transferId: req.params.id,
      organizationId: orgId,
      dispatchedBy: req.user?.id || 'DISPATCHER',
      carrierName: req.body.carrierName,
      trackingReference: req.body.trackingReference,
      estimatedArrivalAt: req.body.estimatedArrivalAt,
      idempotencyKey: req.body.idempotencyKey,
      notes: req.body.notes,
    });
    res.json(transfer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/receive', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const result = TransferReceivingService.receiveTransfer({
      transferId: req.params.id,
      organizationId: orgId,
      receivedBy: req.user?.id || 'RECEIVER',
      conditionStatus: req.body.conditionStatus,
      items: req.body.items,
      idempotencyKey: req.body.idempotencyKey,
      notes: req.body.notes,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/cancel', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const transfer = StockTransferService.cancelTransfer({
      transferId: req.params.id,
      organizationId: orgId,
      cancelledBy: req.user?.id || 'USER',
      cancellationReason: req.body.reason,
    });
    res.json(transfer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/return', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const returnTrf = StockTransferService.createReturnTransfer({
      originalTransferId: req.params.id,
      organizationId: orgId,
      reason: req.body.reason || 'Rejected destination delivery',
      returnedBy: req.user?.id || 'RECEIVER',
      lines: req.body.lines,
    });
    res.status(201).json(returnTrf);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// 3. VARIANCES
// ──────────────────────────────────────────
router.get('/variances/list', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const { transferId, status } = req.query;
    const variances = TransferVarianceService.listVariances({
      organizationId: orgId,
      transferId: transferId as string,
      status: status as string,
    });
    res.json(variances);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/variances/:id/resolve', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const resolved = TransferVarianceService.resolveVariance({
      varianceId: req.params.id,
      organizationId: orgId,
      resolution: req.body.resolution,
      resolutionNotes: req.body.resolutionNotes || 'Variance resolved',
      resolvedBy: req.user?.id || 'SUPERVISOR',
      userRole: req.user?.role,
    });
    res.json(resolved);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// 4. INTELLIGENCE ENGINES
// ──────────────────────────────────────────
router.get('/replenishment/recommendations', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const { storeId, lookbackDays } = req.query;
    if (!storeId) return res.status(400).json({ error: 'storeId is required' });
    const decisions = InternalReplenishmentEngine.evaluateStoreReplenishment({
      organizationId: orgId,
      destinationStoreId: storeId as string,
      lookbackDays: lookbackDays ? Number(lookbackDays) : 30,
    });
    res.json(decisions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/replenishment/generate-transfers', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const transfers = InternalReplenishmentEngine.createTransferFromReplenishment({
      organizationId: orgId,
      destinationStoreId: req.body.storeId,
      decisions: req.body.decisions,
      requestedBy: req.user?.id || 'SYSTEM',
    });
    res.status(201).json(transfers);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/rebalancing/recommendations', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const recs = StoreRebalancingEngine.evaluateRebalancing({ organizationId: orgId });
    res.json(recs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/expiry/redistributions', requireAuth, async (req: any, res) => {
  try {
    const orgId = getOrgId(req);
    const plans = ExpiryRedistributionEngine.evaluateExpiryRedistribution({ organizationId: orgId });
    res.json(plans);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
