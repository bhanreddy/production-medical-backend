// procurement.ts — Enterprise Procurement, GRN, 3-Way Match & Supplier Intelligence Routes
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { PurchaseRequisitionService } from '../services/procurement/purchaseRequisitionService';
import { SupplierCatalogService } from '../services/procurement/supplierCatalogService';
import { PurchaseOrderService } from '../services/procurement/purchaseOrderService';
import { GoodsReceiptService } from '../services/procurement/goodsReceiptService';
import { PurchaseInvoiceService } from '../services/procurement/purchaseInvoiceService';
import { ThreeWayMatchingService } from '../services/procurement/threeWayMatchingService';
import { SupplierPayableService } from '../services/procurement/supplierPayableService';
import { PurchaseReturnService } from '../services/procurement/purchaseReturnService';
import { SupplierIntelligenceService } from '../services/procurement/supplierIntelligenceService';
import { ProcurementPolicyService } from '../services/procurement/procurementPolicyService';

import { POSSessionService } from '../services/posSession';
import { AppError } from '../lib/appError';
export const procurementRouter = Router();

// Helper to extract organizationId and storeId safely
function getOrgAndStore(req: any) {
  const context = POSSessionService.resolveSession({ userId: req.user.id, clinicId: req.user.clinic_id, requestedStoreId: req.headers['x-store-id'] || null });
  if (req.headers['x-organization-id'] && req.headers['x-organization-id'] !== context.organizationId) throw new AppError(403, 'Cross-organization access denied');
  return { organizationId: context.organizationId, storeId: context.storeId };
}

// -------------------------------------------------------------
// 1. PROCUREMENT DASHBOARD & POLICIES
// -------------------------------------------------------------
procurementRouter.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const summary = SupplierIntelligenceService.getDashboardSummary(organizationId, storeId);
    res.json({ data: summary });
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/policy', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const policy = ProcurementPolicyService.getPolicy(organizationId);
    res.json({ data: policy });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/policy', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const policy = ProcurementPolicyService.setPolicy({ ...req.body, organizationId });
    res.json({ data: policy });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 2. PURCHASE REQUISITIONS
// -------------------------------------------------------------
procurementRouter.get('/requisitions', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const { status, source, limit, offset } = req.query;
    const result = PurchaseRequisitionService.listRequisitions({
      organizationId,
      storeId: req.query.store_id ? String(req.query.store_id) : storeId,
      status: status as any,
      source: source as any,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/requisitions', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const reqData = PurchaseRequisitionService.createRequisition({
      ...req.body,
      organizationId,
      storeId: req.body.storeId || storeId,
      requestedBy: req.user!.id,
    });
    res.status(201).json({ data: reqData });
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/requisitions/:id', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const reqData = PurchaseRequisitionService.getRequisitionById(req.params.id, organizationId);
    if (!reqData) return res.status(404).json({ error: 'Requisition not found' });
    res.json({ data: reqData });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/requisitions/:id/submit', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const updated = PurchaseRequisitionService.submitRequisition(req.params.id, organizationId);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/requisitions/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const userRole = (req.user as any)?.role || 'OWNER';
    const updated = PurchaseRequisitionService.approveRequisition({
      requisitionId: req.params.id,
      organizationId,
      approvedBy: req.user!.id,
      userRole,
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/requisitions/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const { rejectionReason } = req.body;
    const updated = PurchaseRequisitionService.rejectRequisition({
      requisitionId: req.params.id,
      organizationId,
      rejectedBy: req.user!.id,
      rejectionReason,
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/requisitions/consolidate', requireAuth, requireRole('OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const { warehouseId, sourceRequisitionIds, notes } = req.body;
    const consolidated = PurchaseRequisitionService.consolidateRequisitions({
      organizationId,
      warehouseId,
      sourceRequisitionIds,
      requestedBy: req.user!.id,
      notes,
    });
    res.status(201).json({ data: consolidated });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/requisitions/from-recommendations', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const { recommendations } = req.body;
    const reqData = PurchaseRequisitionService.createRequisitionFromRecommendations({
      organizationId,
      storeId: req.body.storeId || storeId,
      recommendations: recommendations || [],
      requestedBy: req.user!.id,
    });
    res.status(201).json({ data: reqData });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/requisitions/from-shortbook', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const { shortbookItems } = req.body;
    const reqData = PurchaseRequisitionService.createRequisitionFromShortbook({
      organizationId,
      storeId: req.body.storeId || storeId,
      shortbookItems: shortbookItems || [],
      requestedBy: req.user!.id,
    });
    res.status(201).json({ data: reqData });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 3. SUPPLIER CATALOG & COMPARISON
// -------------------------------------------------------------
procurementRouter.get('/compare', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const medicineId = String(req.query.medicine_id || '');
    const requestedQuantity = req.query.quantity ? Number(req.query.quantity) : 10;
    if (!medicineId) return res.status(400).json({ error: 'medicine_id is required' });

    const results = SupplierCatalogService.compareSuppliersForProduct({
      organizationId,
      medicineId,
      requestedQuantity,
    });
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/price-history', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const medicineId = req.query.medicine_id ? String(req.query.medicine_id) : undefined;
    const supplierId = req.query.supplier_id ? String(req.query.supplier_id) : undefined;
    const history = SupplierCatalogService.getPriceHistory({
      organizationId,
      medicineId,
      supplierId,
    });
    res.json({ data: history });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/catalog', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const entry = SupplierCatalogService.upsertSupplierProduct({
      ...req.body,
      organizationId,
    });
    res.status(201).json({ data: entry });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 4. PURCHASE ORDERS
// -------------------------------------------------------------
procurementRouter.get('/purchase-orders', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const { supplier_id, status, limit, offset } = req.query;
    const result = PurchaseOrderService.listPurchaseOrders({
      organizationId,
      storeId: req.query.store_id ? String(req.query.store_id) : storeId,
      supplierId: supplier_id ? String(supplier_id) : undefined,
      status: status as any,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/purchase-orders', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const po = PurchaseOrderService.createPurchaseOrder({
      ...req.body,
      organizationId,
      storeId: req.body.storeId || storeId,
      createdBy: req.user!.id,
    });
    res.status(201).json({ data: po });
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/purchase-orders/:id', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const po = PurchaseOrderService.getPoById(req.params.id, organizationId);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/purchase-orders/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const userRole = (req.user as any)?.role || 'STORE_MANAGER';
    const po = PurchaseOrderService.approvePurchaseOrder({
      poId: req.params.id,
      organizationId,
      approvedBy: req.user!.id,
      userRole,
    });
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/purchase-orders/:id/amend', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const po = PurchaseOrderService.amendPurchaseOrder({
      ...req.body,
      poId: req.params.id,
      organizationId,
      amendedBy: req.user!.id,
    });
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/purchase-orders/:id/confirm', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const po = PurchaseOrderService.recordSupplierConfirmation({
      ...req.body,
      poId: req.params.id,
      organizationId,
    });
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/purchase-orders/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const po = PurchaseOrderService.cancelPurchaseOrder({
      poId: req.params.id,
      organizationId,
      cancelledBy: req.user!.id,
      reason: req.body.reason || 'Cancelled by buyer',
    });
    res.json({ data: po });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 5. GOODS RECEIPT NOTES (GRN)
// -------------------------------------------------------------
procurementRouter.get('/grn', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const { supplier_id, po_id, status, limit, offset } = req.query;
    const result = GoodsReceiptService.listGoodsReceipts({
      organizationId,
      storeId: req.query.store_id ? String(req.query.store_id) : storeId,
      supplierId: supplier_id ? String(supplier_id) : undefined,
      poId: po_id ? String(po_id) : undefined,
      status: status as any,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/grn', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const grn = GoodsReceiptService.createGoodsReceipt({
      ...req.body,
      organizationId,
      storeId: req.body.storeId || storeId,
      receivedBy: req.user!.id,
    });
    res.status(201).json({ data: grn });
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/grn/:id', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const grn = GoodsReceiptService.getGrnById(req.params.id, organizationId);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });
    res.json({ data: grn });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/grn/:id/post', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const grn = GoodsReceiptService.postGoodsReceipt({
      grnId: req.params.id,
      organizationId,
      postedBy: req.user!.id,
    });
    res.json({ data: grn });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 6. PURCHASE INVOICES & 3-WAY MATCH
// -------------------------------------------------------------
procurementRouter.get('/invoices', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const { supplier_id, status, payment_status, limit, offset } = req.query;
    const result = PurchaseInvoiceService.listInvoices({
      organizationId,
      storeId: req.query.store_id ? String(req.query.store_id) : storeId,
      supplierId: supplier_id ? String(supplier_id) : undefined,
      status: status ? String(status) : undefined,
      paymentStatus: payment_status ? String(payment_status) : undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/invoices', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const invoice = PurchaseInvoiceService.createInvoice({
      ...req.body,
      organizationId,
      storeId: req.body.storeId || storeId,
      createdBy: req.user!.id,
    });
    res.status(201).json({ data: invoice });
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/invoices/:id', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const invoice = PurchaseInvoiceService.getInvoiceById(req.params.id, organizationId);
    if (!invoice) return res.status(404).json({ error: 'Purchase invoice not found' });
    res.json({ data: invoice });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/invoices/:id/approve-variance', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const userRole = (req.user as any)?.role || 'STORE_MANAGER';
    const invoice = PurchaseInvoiceService.getInvoiceById(req.params.id, organizationId);
    if (!invoice || !invoice.match_result) return res.status(404).json({ error: 'Match result not found' });

    const updatedMatch = ThreeWayMatchingService.approveMatchException({
      matchResultId: invoice.match_result.id,
      organizationId,
      approvedBy: req.user!.id,
      userRole,
      reason: req.body.reason || 'Variance approved by supervisor',
    });
    res.json({ data: updatedMatch });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/invoices/:id/post', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const invoice = PurchaseInvoiceService.postInvoice({
      invoiceId: req.params.id,
      organizationId,
      postedBy: req.user!.id,
    });
    res.json({ data: invoice });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 7. PAYABLES & PAYMENTS
// -------------------------------------------------------------
procurementRouter.get('/payables/ledger', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const supplierId = String(req.query.supplier_id || '');
    if (!supplierId) return res.status(400).json({ error: 'supplier_id is required' });

    const statement = SupplierPayableService.getLedgerStatement({
      organizationId,
      supplierId,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json(statement);
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/payables/ageing', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const supplierId = req.query.supplier_id ? String(req.query.supplier_id) : undefined;
    const ageing = SupplierPayableService.getSupplierAgeing({
      organizationId,
      supplierId,
    });
    res.json({ data: ageing });
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/payments', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const payment = SupplierPayableService.recordPayment({
      ...req.body,
      organizationId,
      storeId: req.body.storeId || storeId,
      recordedBy: req.user!.id,
    });
    res.status(201).json({ data: payment });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 8. PURCHASE RETURNS & DEBIT NOTES
// -------------------------------------------------------------
procurementRouter.get('/returns', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const { supplier_id, limit, offset } = req.query;
    const result = PurchaseReturnService.listPurchaseReturns({
      organizationId,
      storeId: req.query.store_id ? String(req.query.store_id) : storeId,
      supplierId: supplier_id ? String(supplier_id) : undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

procurementRouter.post('/returns', requireAuth, async (req, res, next) => {
  try {
    const { organizationId, storeId } = getOrgAndStore(req);
    const ret = PurchaseReturnService.createPurchaseReturn({
      ...req.body,
      organizationId,
      storeId: req.body.storeId || storeId,
      createdBy: req.user!.id,
    });
    res.status(201).json({ data: ret });
  } catch (err) {
    next(err);
  }
});

procurementRouter.get('/debit-notes', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const supplierId = req.query.supplier_id ? String(req.query.supplier_id) : undefined;
    const debitNotes = PurchaseReturnService.listDebitNotes({
      organizationId,
      supplierId,
    });
    res.json({ data: debitNotes });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 9. SUPPLIER SCORECARD & INTELLIGENCE
// -------------------------------------------------------------
procurementRouter.get('/supplier-scorecard', requireAuth, async (req, res, next) => {
  try {
    const { organizationId } = getOrgAndStore(req);
    const supplierId = String(req.query.supplier_id || '');
    if (!supplierId) return res.status(400).json({ error: 'supplier_id is required' });

    const scorecard = SupplierIntelligenceService.getSupplierScorecard(organizationId, supplierId);
    res.json({ data: scorecard });
  } catch (err) {
    next(err);
  }
});

export default procurementRouter;
