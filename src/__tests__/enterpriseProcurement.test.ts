// enterpriseProcurement.test.ts — Comprehensive Test Suite for Enterprise Procurement, GRN, 3-Way Match & Supplier Intelligence
import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { Money } from '../lib/money';
import { v4 as uuidv4 } from 'uuid';

import { ProcurementPolicyService } from '../services/procurement/procurementPolicyService';
import { PurchaseRequisitionService } from '../services/procurement/purchaseRequisitionService';
import { SupplierCatalogService } from '../services/procurement/supplierCatalogService';
import { PurchaseOrderService } from '../services/procurement/purchaseOrderService';
import { GoodsReceiptService } from '../services/procurement/goodsReceiptService';
import { ThreeWayMatchingService } from '../services/procurement/threeWayMatchingService';
import { PurchaseInvoiceService } from '../services/procurement/purchaseInvoiceService';
import { SupplierPayableService } from '../services/procurement/supplierPayableService';
import { PurchaseReturnService } from '../services/procurement/purchaseReturnService';
import { SupplierIntelligenceService } from '../services/procurement/supplierIntelligenceService';
import { InventoryPositionService } from '../services/inventoryPosition';

describe('Enterprise Procurement & Supplier Intelligence Engine', () => {
  const orgId = 'test-org-procure-' + Date.now();
  const storeId = 'store-procure-1';
  const warehouseId = 'warehouse-procure-1';
  let medicineAId: string;
  let medicineBId: string;
  let supplierAlphaId: string;
  let supplierBetaId: string;

  beforeAll(() => {
    // 1. Seed Organization & Store
    localMutate({
      table: 'organizations',
      operation: 'INSERT',
      data: {
        id: orgId,
        _local_id: orgId,
        display_name: 'Procurement Test Org',
        legal_name: 'Procurement Test Org Pvt Ltd',
        code: 'PTO',
      },
    });

    localMutate({
      table: 'stores',
      operation: 'INSERT',
      data: {
        id: storeId,
        _local_id: storeId,
        organization_id: orgId,
        name: 'Downtown Pharmacy',
        display_name: 'Downtown Pharmacy',
        store_code: 'DP01',
      },
    });

    // 2. Seed Test Medicines
    medicineAId = uuidv4();
    medicineBId = uuidv4();

    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: {
        id: medicineAId,
        _local_id: medicineAId,
        organization_id: orgId,
        clinic_id: 'default-clinic',
        name: 'Amoxicillin 500mg',
        generic_name: 'Amoxicillin',
        hsn_code: '30041010',
        gst_rate: 12.0,
        purchase_price: 80.0,
        mrp: 120.0,
        unit: 'strip',
      },
    });

    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: {
        id: medicineBId,
        _local_id: medicineBId,
        organization_id: orgId,
        clinic_id: 'default-clinic',
        name: 'Paracetamol 650mg',
        generic_name: 'Paracetamol',
        hsn_code: '30049099',
        gst_rate: 12.0,
        purchase_price: 25.0,
        mrp: 40.0,
        unit: 'strip',
      },
    });

    // 3. Seed Test Suppliers
    supplierAlphaId = uuidv4();
    supplierBetaId = uuidv4();

    localMutate({
      table: 'suppliers',
      operation: 'INSERT',
      data: {
        id: supplierAlphaId,
        _local_id: supplierAlphaId,
        organization_id: orgId,
        clinic_id: 'default-clinic',
        name: 'Alpha Pharma Distributors',
        phone: '9876543210',
        gstin: '29ABCDE1234F1Z5',
        lead_time_days: 2,
        outstanding_balance: 0,
      },
    });

    localMutate({
      table: 'suppliers',
      operation: 'INSERT',
      data: {
        id: supplierBetaId,
        _local_id: supplierBetaId,
        organization_id: orgId,
        clinic_id: 'default-clinic',
        name: 'Beta Healthcare Wholesale',
        phone: '9876543211',
        gstin: '29ABCDE1234F1Z6',
        lead_time_days: 4,
        outstanding_balance: 0,
      },
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 1: PROCUREMENT POLICIES & APPROVAL THRESHOLDS
  // -------------------------------------------------------------------------
  describe('1. Procurement Policies & Threshold Verification', () => {
    test('Sets and retrieves custom organizational procurement policy', () => {
      const policy = ProcurementPolicyService.setPolicy({
        organizationId: orgId,
        storeManagerApprovalLimitPaise: 5000000, // 50,000 INR -> Store Manager
        regionalManagerApprovalLimitPaise: 20000000, // 200,000 INR -> Regional Manager
        enforceMakerChecker: true,
        priceVarianceTolerancePct: 3.0,
        quantityVarianceTolerancePct: 5.0,
        minShelfLifeDaysReceipt: 180,
      });

      expect(policy.organizationId).toBe(orgId);
      expect(policy.priceVarianceTolerancePct).toBe(3.0);
      expect(policy.minShelfLifeDaysReceipt).toBe(180);
    });

    test('Validates approval role requirements based on value tiers', () => {
      // 10,000 INR -> Store Manager
      expect(ProcurementPolicyService.getRequiredApprovalRole(orgId, 1000000)).toBe('STORE_MANAGER');
      // 100,000 INR -> Regional Manager
      expect(ProcurementPolicyService.getRequiredApprovalRole(orgId, 10000000)).toBe('REGIONAL_MANAGER');
      // 300,000 INR -> HQ Procurement
      expect(ProcurementPolicyService.getRequiredApprovalRole(orgId, 30000000)).toBe('HQ_PROCUREMENT');
      // 600,000 INR -> HQ Procurement (Enterprise policy ceiling)
      expect(ProcurementPolicyService.getRequiredApprovalRole(orgId, 60000000)).toBe('HQ_PROCUREMENT');
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 2: PURCHASE REQUISITIONS & CONSOLIDATION
  // -------------------------------------------------------------------------
  describe('2. Purchase Requisitions & Multi-Store Consolidation', () => {
    let req1Id: string;
    let req2Id: string;

    test('Creates purchase requisition with on-hand inventory context', () => {
      const req = PurchaseRequisitionService.createRequisition({
        organizationId: orgId,
        storeId,
        source: 'MANUAL',
        priority: 'HIGH',
        requestedBy: 'user-pharmacist-1',
        notes: 'Monthly regular restock',
        items: [
          {
            medicineId: medicineAId,
            requestedQuantity: 50,
            justification: 'Antibiotic demand increase',
          },
          {
            medicineId: medicineBId,
            requestedQuantity: 100,
            justification: 'Fever clinic high turnover',
          },
        ],
      });

      req1Id = req.id;
      expect(req.requisition_number).toContain('/REQ/');
      expect(req.status).toBe('DRAFT');
      expect(req.items?.length).toBe(2);
      expect(req.items?.[0].current_stock).toBe(0);
      expect(req.items?.[0].estimated_cost_paise).toBe(400000); // 50 * 80.00 = 4,000 INR
    });

    test('Submits requisition for approval', () => {
      const submitted = PurchaseRequisitionService.submitRequisition(req1Id, orgId);
      expect(submitted.status).toBe('PENDING_APPROVAL');
    });

    test('Approves requisition within authorized role threshold', () => {
      const approved = PurchaseRequisitionService.approveRequisition({
        requisitionId: req1Id,
        organizationId: orgId,
        approvedBy: 'user-manager-1',
        userRole: 'STORE_MANAGER',
      });
      expect(approved.status).toBe('APPROVED');
      expect(approved.approved_by).toBe('user-manager-1');
    });

    test('Creates second requisition and rejects it with reason', () => {
      const req2 = PurchaseRequisitionService.createRequisition({
        organizationId: orgId,
        storeId,
        source: 'MANUAL',
        priority: 'LOW',
        requestedBy: 'user-pharmacist-1',
        items: [
          {
            medicineId: medicineAId,
            requestedQuantity: 10,
          },
        ],
      });
      req2Id = req2.id;
      PurchaseRequisitionService.submitRequisition(req2Id, orgId);

      const rejected = PurchaseRequisitionService.rejectRequisition({
        requisitionId: req2Id,
        organizationId: orgId,
        rejectedBy: 'user-manager-1',
        rejectionReason: 'Adequate safety stock in warehouse',
      });

      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejection_reason).toBe('Adequate safety stock in warehouse');
    });

    test('Creates requisition from Reorder Engine recommendations', () => {
      const autoReq = PurchaseRequisitionService.createRequisitionFromRecommendations({
        organizationId: orgId,
        storeId,
        requestedBy: 'system-auto-reorder',
        recommendations: [
          {
            medicineId: medicineAId,
            recommendedQuantity: 60,
            reason: 'Reorder point breached (ROP: 20)',
          },
        ],
      });

      expect(autoReq.source).toBe('REORDER_ENGINE');
      expect(autoReq.items?.[0].requested_quantity).toBe(60);
      expect(autoReq.items?.[0].justification).toContain('Reorder point breached');
    });

    test('Consolidates store requisitions into central warehouse requisition', () => {
      const storeReq = PurchaseRequisitionService.createRequisition({
        organizationId: orgId,
        storeId,
        source: 'MANUAL',
        priority: 'MEDIUM',
        requestedBy: 'user-store-lead',
        items: [
          {
            medicineId: medicineBId,
            requestedQuantity: 40,
          },
        ],
      });

      const consolidated = PurchaseRequisitionService.consolidateRequisitions({
        organizationId: orgId,
        warehouseId,
        sourceRequisitionIds: [storeReq.id],
        requestedBy: 'hq-procurement-officer',
        notes: 'Central warehouse bulk replenishment',
      });

      expect(consolidated.source).toBe('WAREHOUSE_REPLENISHMENT');
      expect(consolidated.status).toBe('DRAFT');
      expect(consolidated.items?.[0].requested_quantity).toBe(40);
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 3: SUPPLIER CATALOG & COMPARISON ENGINE
  // -------------------------------------------------------------------------
  describe('3. Supplier-Product Catalog & Comparison Engine', () => {
    beforeAll(() => {
      SupplierCatalogService.upsertSupplierProduct({
        organizationId: orgId,
        supplierId: supplierAlphaId,
        medicineId: medicineAId,
        supplierSku: 'ALPHA-AMOX-500',
        standardRatePaise: 8000,
        moq: 10,
        leadTimeDays: 2,
      });

      SupplierCatalogService.upsertSupplierProduct({
        organizationId: orgId,
        supplierId: supplierBetaId,
        medicineId: medicineAId,
        supplierSku: 'BETA-AMOX-500',
        standardRatePaise: 7200,
        moq: 20,
        leadTimeDays: 4,
      });
    });

    test('Retrieves catalog mappings and price history', () => {
      const history = SupplierCatalogService.getPriceHistory({
        organizationId: orgId,
        medicineId: medicineAId,
      });
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    test('Compares suppliers and calculates effective cost', () => {
      const results = SupplierCatalogService.compareSuppliersForProduct({
        organizationId: orgId,
        medicineId: medicineAId,
        requestedQuantity: 50,
      });

      expect(results.length).toBe(2);

      const alphaComp = results.find((r) => r.supplierId === supplierAlphaId);
      expect(alphaComp).toBeDefined();
      expect(alphaComp?.standardRatePaise).toBe(8000);

      const betaComp = results.find((r) => r.supplierId === supplierBetaId);
      expect(betaComp).toBeDefined();
      expect(betaComp?.standardRatePaise).toBe(7200);

      // Best price rank
      expect(results[0].supplierId).toBe(supplierBetaId);
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 4: PURCHASE ORDERS & VERSIONING
  // -------------------------------------------------------------------------
  describe('4. Purchase Orders, Idempotency & Version History', () => {
    let poId: string;
    const idempotencyKey = 'po-idemp-' + Date.now();

    test('Generates Purchase Order with multi-line items and rate calculation', () => {
      const po = PurchaseOrderService.createPurchaseOrder({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        paymentTerms: 'NET_30',
        expectedDeliveryDate: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10),
        idempotencyKey,
        createdBy: 'user-buyer-1',
        items: [
          {
            medicineId: medicineAId,
            orderedQuantity: 50,
            purchaseRatePaise: 8000,
            gstRate: 12.0,
          },
          {
            medicineId: medicineBId,
            orderedQuantity: 100,
            purchaseRatePaise: 2500,
            gstRate: 12.0,
          },
        ],
      });

      poId = po.id;
      expect(po.po_number).toContain('/PO/');
      expect(po.status).toBe('DRAFT');
      expect(po.version).toBe(1);
      expect(po.items?.length).toBe(2);

      // Subtotal = 50 * 80.00 + 100 * 25.00 = 4,000 + 2,500 = 6,500 INR (650,000 paise)
      // GST (12%) = 78,000 paise. Total = 728,000 paise
      expect(po.subtotal_paise).toBe(650000);
      expect(po.gst_paise).toBe(78000);
      expect(po.total_paise).toBe(728000);
    });

    test('Prevents duplicate PO generation via Idempotency Key', () => {
      const duplicatePo = PurchaseOrderService.createPurchaseOrder({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        idempotencyKey,
        createdBy: 'user-buyer-1',
        items: [
          {
            medicineId: medicineAId,
            orderedQuantity: 50,
            purchaseRatePaise: 8000,
          },
        ],
      });

      // Must return existing PO ID without creating a duplicate record
      expect(duplicatePo.id).toBe(poId);
    });

    test('Approves Purchase Order', () => {
      const approved = PurchaseOrderService.approvePurchaseOrder({
        poId,
        organizationId: orgId,
        approvedBy: 'user-manager-1',
        userRole: 'STORE_MANAGER',
      });
      expect(approved.status).toBe('APPROVED');
    });

    test('Amends Purchase Order and generates version snapshot in purchase_order_versions', () => {
      const amended = PurchaseOrderService.amendPurchaseOrder({
        poId,
        organizationId: orgId,
        amendedBy: 'user-buyer-1',
        changeReason: 'Increased Paracetamol quantity due to doctor prescription surge',
        items: [
          {
            medicineId: medicineAId,
            orderedQuantity: 50,
            purchaseRatePaise: 8000,
            gstRate: 12.0,
          },
          {
            medicineId: medicineBId,
            orderedQuantity: 150, // Amended from 100 to 150
            purchaseRatePaise: 2500,
            gstRate: 12.0,
          },
        ],
      });

      expect(amended.version).toBe(2);
      expect(amended.versions?.length).toBe(2);
      expect(amended.versions?.[1].change_reason).toContain('Increased Paracetamol quantity');

      // Re-approve amended PO
      PurchaseOrderService.approvePurchaseOrder({
        poId,
        organizationId: orgId,
        approvedBy: 'user-manager-1',
        userRole: 'STORE_MANAGER',
      });
    });

    test('Records Supplier Confirmation', () => {
      const confirmed = PurchaseOrderService.recordSupplierConfirmation({
        poId,
        organizationId: orgId,
        expectedDeliveryDate: new Date().toISOString().slice(0, 10),
        notes: 'Confirmed by sales rep via WhatsApp',
      });
      expect(confirmed.status).toBe('CONFIRMED');
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 5: GOODS RECEIPT NOTE (GRN) & STOCK INWARD
  // -------------------------------------------------------------------------
  describe('5. Goods Receipt Note (GRN), Batch Creation & Physical Stock Inward', () => {
    let grnId: string;
    let targetPo: any;

    test('Creates GRN with batch segregation, free quantity and damage capture', () => {
      const poRows = PurchaseOrderService.listPurchaseOrders({ organizationId: orgId });
      targetPo = poRows.data[0];

      const grn = GoodsReceiptService.createGoodsReceipt({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        poId: targetPo.id,
        supplierDeliveryNote: 'DN-ALPHA-8812',
        receivedBy: 'user-pharmacist-receiving',
        items: [
          {
            poItemId: targetPo.items?.[0].id,
            medicineId: medicineAId,
            batchNumber: 'AMX-B901',
            expiryDate: '2028-06-30',
            orderedQuantity: 50,
            receivedPaidQuantity: 50,
            freeQuantity: 10, // Received 10 free units as per scheme
            damagedQuantity: 2, // 2 units damaged in transit
            rejectedQuantity: 0,
            purchaseRatePaise: 8000,
            mrpPaise: 12000,
          },
          {
            poItemId: targetPo.items?.[1].id,
            medicineId: medicineBId,
            batchNumber: 'PCM-B402',
            expiryDate: '2028-12-31',
            orderedQuantity: 150,
            receivedPaidQuantity: 150,
            freeQuantity: 0,
            damagedQuantity: 0,
            rejectedQuantity: 0,
            purchaseRatePaise: 2500,
            mrpPaise: 4000,
          },
        ],
      });

      grnId = grn.id;
      expect(grn.grn_number).toContain('/GRN/');
      expect(grn.status).toBe('RECEIVING');
      expect(grn.items?.length).toBe(2);

      // Item 1: Total Received = 50 + 10 = 60. Damaged = 2. Accepted = 58.
      const it1 = grn.items?.[0];
      expect(it1?.accepted_quantity).toBe(58);
      expect(it1?.effective_cost_paise).toBe(6897);
    });

    test('Posts GRN: commits batches, updates inventory positions, and writes stock ledger', () => {
      const posted = GoodsReceiptService.postGoodsReceipt({
        grnId,
        organizationId: orgId,
        postedBy: 'user-pharmacist-receiving',
      });

      expect(posted.status).toBe('POSTED');

      // Verify Medicine A Batch in medicine_batches
      const batchA: any = localDb
        .prepare(`SELECT * FROM medicine_batches WHERE batch_number = 'AMX-B901' AND organization_id = ?`)
        .get(orgId);

      expect(batchA).toBeDefined();
      // Available batch remaining must equal accepted units (58)
      expect(batchA.quantity_remaining).toBe(58);
      expect(batchA.cost_price_paise).toBe(6897); // Blended weighted purchase cost

      // Verify Multi-State Inventory Position for Medicine A
      const posA = InventoryPositionService.getOrCreatePosition({
        organizationId: orgId,
        medicineId: medicineAId,
        batchId: batchA.id,
        locationType: 'STORE',
        storeId,
      });

      expect(posA.quantity_on_hand).toBe(60); // 58 accepted + 2 damaged on hand
      expect(posA.quantity_available).toBe(58); // Available for POS sale
      expect(posA.quantity_damaged).toBe(2); // Isolated in damaged state

      // Verify Stock Ledger Movement (PURCHASE_RECEIPT)
      const ledgerRows: any[] = localDb
        .prepare(
          `SELECT * FROM stock_ledger WHERE reference_id = ? AND movement_type = 'PURCHASE_RECEIPT'`
        )
        .all(grnId);

      expect(ledgerRows.length).toBe(2);
      expect(ledgerRows[0].quantity_delta).toBe(58);

      // Verify PO received quantity updated
      const updatedPo = PurchaseOrderService.getPoById(targetPo.id, orgId);
      expect(updatedPo?.items?.[0].received_quantity).toBe(50);
      expect(updatedPo?.status).toBe('RECEIVED');
    });

    test('Flags GRN receipt with short shelf-life into REVIEW status', () => {
      // Short expiry date: 1 month from now (< 180 days policy)
      const shortExpDate = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);

      const reviewGrn = GoodsReceiptService.createGoodsReceipt({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        receivedBy: 'user-pharmacist-receiving',
        items: [
          {
            medicineId: medicineAId,
            batchNumber: 'EXPIRED-BATCH-001',
            expiryDate: shortExpDate,
            receivedPaidQuantity: 10,
            purchaseRatePaise: 8000,
          },
        ],
      });

      expect(reviewGrn.status).toBe('REVIEW');
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 6: THREE-WAY MATCHING & PURCHASE INVOICES
  // -------------------------------------------------------------------------
  describe('6. Three-Way Matching (PO vs GRN vs Invoice) & Supplier Invoices', () => {
    let invoiceId: string;
    let invoiceNumber = 'INV-ALPHA-' + Date.now();

    test('Performs 3-way matching and creates purchase invoice liability WITHOUT double-adding stock', () => {
      const poRows = PurchaseOrderService.listPurchaseOrders({ organizationId: orgId });
      const targetPo = poRows.data[0];
      const grnRows = GoodsReceiptService.listGoodsReceipts({ organizationId: orgId, poId: targetPo.id });
      const targetGrn = grnRows.data[0];

      // Capture stock before invoice posting
      const batchBefore: any = localDb
        .prepare(`SELECT quantity_remaining FROM medicine_batches WHERE batch_number = 'AMX-B901' AND organization_id = ?`)
        .get(orgId);
      const stockCountBefore = batchBefore?.quantity_remaining || 0;

      // 1. Create Purchase Invoice matching PO & GRN
      const invoice = PurchaseInvoiceService.createInvoice({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        invoiceNumber,
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10),
        poId: targetPo.id,
        grnId: targetGrn.id,
        createdBy: 'user-accountant-1',
        items: [
          {
            poItemId: targetPo.items?.[0].id,
            grnItemId: targetGrn.items?.[0].id,
            medicineId: medicineAId,
            quantity: 50,
            freeQuantity: 10,
            purchaseRatePaise: 8000,
            gstRate: 12.0,
          },
          {
            poItemId: targetPo.items?.[1].id,
            grnItemId: targetGrn.items?.[1].id,
            medicineId: medicineBId,
            quantity: 150,
            freeQuantity: 0,
            purchaseRatePaise: 2500,
            gstRate: 12.0,
          },
        ],
      });

      invoiceId = invoice.id;
      expect(invoice.match_status).toBe('MATCHED');
      expect(invoice.status).toBe('MATCHED');

      // 2. Post Invoice to create supplier liability
      const postedInvoice = PurchaseInvoiceService.postInvoice({
        invoiceId,
        organizationId: orgId,
        postedBy: 'user-accountant-1',
      });

      expect(postedInvoice.status).toBe('POSTED');

      // 3. Verify Supplier Outstanding Balance updated in suppliers table
      const supplierRow: any = localDb
        .prepare(`SELECT outstanding_balance FROM suppliers WHERE id = ?`)
        .get(supplierAlphaId);

      expect(Number(supplierRow.outstanding_balance)).toBe(Money.toRupees(postedInvoice.total_paise));

      // 4. CRITICAL AUDIT RULE: Stock in medicine_batches MUST NOT change upon invoice posting
      const batchAfter: any = localDb
        .prepare(`SELECT quantity_remaining FROM medicine_batches WHERE batch_number = 'AMX-B901' AND organization_id = ?`)
        .get(orgId);
      expect(batchAfter.quantity_remaining).toBe(stockCountBefore);
    });

    test('Rejects duplicate supplier invoice number', () => {
      expect(() => {
        PurchaseInvoiceService.createInvoice({
          organizationId: orgId,
          storeId,
          supplierId: supplierAlphaId,
          invoiceNumber, // Same invoice number
          invoiceDate: new Date().toISOString().slice(0, 10),
          createdBy: 'user-accountant-1',
          items: [
            {
              medicineId: medicineAId,
              quantity: 10,
              purchaseRatePaise: 8000,
            },
          ],
        });
      }).toThrow(/Duplicate Supplier Invoice/);
    });

    test('Flags price mismatch exceeding variance tolerance', () => {
      const poRows = PurchaseOrderService.listPurchaseOrders({ organizationId: orgId });
      const targetPo = poRows.data[0];

      const mismatchInv = PurchaseInvoiceService.createInvoice({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        invoiceNumber: 'INV-MISMATCH-' + Date.now(),
        invoiceDate: new Date().toISOString().slice(0, 10),
        poId: targetPo.id,
        createdBy: 'user-accountant-1',
        items: [
          {
            poItemId: targetPo.items?.[0].id,
            medicineId: medicineAId,
            quantity: 50,
            purchaseRatePaise: 9500, // ₹95 vs PO ₹80 (18.75% price hike, exceeds 3% tolerance)
          },
        ],
      });

      expect(mismatchInv.match_status).toBe('PRICE_VARIANCE');

      // Cannot post mismatched invoice without supervisor override
      expect(() => {
        PurchaseInvoiceService.postInvoice({
          invoiceId: mismatchInv.id,
          organizationId: orgId,
          postedBy: 'user-accountant-1',
        });
      }).toThrow(/Cannot post invoice with unmatched variance/);

      // Supervisor approves variance exception
      ThreeWayMatchingService.approveMatchException({
        matchResultId: mismatchInv.match_result!.id,
        organizationId: orgId,
        approvedBy: 'user-owner-1',
        userRole: 'OWNER',
        reason: 'Authorized manufacturer price revision pass-through',
      });

      const updated = PurchaseInvoiceService.getInvoiceById(mismatchInv.id, orgId);
      expect(updated?.match_status).toBe('MATCHED');
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 7: SUPPLIER PAYABLES & MULTI-INVOICE FIFO PAYMENTS
  // -------------------------------------------------------------------------
  describe('7. Supplier Payable Ledger, FIFO Payment Allocation & Ageing', () => {
    test('Records supplier payment and performs multi-invoice FIFO allocation', () => {
      const payRes = SupplierPayableService.recordPayment({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        paymentDate: new Date().toISOString().slice(0, 10),
        paymentMode: 'BANK_TRANSFER',
        referenceNumber: 'NEFT-AXIS-9921',
        amountPaise: 400000, // Partial payment of ₹4,000 (400,000 paise)
        notes: 'Partial payment against open invoices',
        recordedBy: 'user-cashier-1',
      });

      expect(payRes.payment_number).toContain('/PAY/');
      expect((payRes as any).allocations?.length).toBeGreaterThanOrEqual(1);

      // Verify running ledger statement
      const statement = SupplierPayableService.getLedgerStatement({
        organizationId: orgId,
        supplierId: supplierAlphaId,
      });

      expect(statement.data.length).toBeGreaterThanOrEqual(2);
      expect(statement.total).toBeGreaterThanOrEqual(2);
    });

    test('Computes 5-bucket supplier overdue ageing breakdown', () => {
      const ageing = SupplierPayableService.getSupplierAgeing({
        organizationId: orgId,
        supplierId: supplierAlphaId,
      });

      expect(ageing.length).toBeGreaterThanOrEqual(1);
      expect(ageing[0].supplierName).toBe('Alpha Pharma Distributors');
      expect(ageing[0].totalOutstandingPaise).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 8: PURCHASE RETURNS & DEBIT NOTES
  // -------------------------------------------------------------------------
  describe('8. Purchase Returns, Batch Reduction & Statutory Debit Notes', () => {
    test('Executes Purchase Return against batch, reduces stock, and issues Debit Note', () => {
      const batchA: any = localDb
        .prepare(`SELECT * FROM medicine_batches WHERE batch_number = 'AMX-B901' AND organization_id = ?`)
        .get(orgId);

      const stockBefore = batchA?.quantity_remaining || 58; // 58 units

      const returnDoc = PurchaseReturnService.createPurchaseReturn({
        organizationId: orgId,
        storeId,
        supplierId: supplierAlphaId,
        reason: 'DAMAGED_RECEIPT',
        notes: 'Damaged packaging discovered during quality inspection',
        createdBy: 'user-pharmacist-1',
        lines: [
          {
            medicineId: medicineAId,
            batchId: batchA.id,
            quantity: 8, // Return 8 units to supplier
            ratePaise: 8000,
            gstRate: 12.0,
          },
        ],
      });

      expect(returnDoc.return_number).toContain('/PRET/');
      expect(returnDoc.status).toBe('POSTED');

      // 1. Verify Batch stock decremented
      const batchAfter: any = localDb
        .prepare(`SELECT * FROM medicine_batches WHERE id = ?`)
        .get(batchA.id);
      expect(batchAfter.quantity_remaining).toBe(stockBefore - 8);

      // 2. Verify Stock Ledger has PURCHASE_RETURN movement
      const retLedger: any = localDb
        .prepare(`SELECT * FROM stock_ledger WHERE reference_id = ? AND movement_type = 'PURCHASE_RETURN'`)
        .get(returnDoc.id);
      expect(retLedger).toBeDefined();
      expect(retLedger.quantity_delta).toBe(-8);

      // 3. Verify Debit Note generated
      const debitNotes = PurchaseReturnService.listDebitNotes({
        organizationId: orgId,
        supplierId: supplierAlphaId,
      });
      expect(debitNotes.length).toBeGreaterThanOrEqual(1);
      expect(debitNotes[0].debit_note_number).toContain('/DN/');

      // 4. Verify DEBIT_NOTE entry created in supplier_payable_ledger
      const ledgerDN: any = localDb
        .prepare(`SELECT * FROM supplier_payable_ledger WHERE reference_id = ? AND transaction_type = 'DEBIT_NOTE'`)
        .get(debitNotes[0].id);
      expect(ledgerDN).toBeDefined();
      expect(ledgerDN.debit_paise).toBe(returnDoc.lines?.[0]?.total_paise);
    });

    test('Prevents Purchase Return exceeding available batch stock', () => {
      const batchA: any = localDb
        .prepare(`SELECT * FROM medicine_batches WHERE batch_number = 'AMX-B901' AND organization_id = ?`)
        .get(orgId);

      expect(() => {
        PurchaseReturnService.createPurchaseReturn({
          organizationId: orgId,
          storeId,
          supplierId: supplierAlphaId,
          reason: 'RECALL',
          createdBy: 'user-pharmacist-1',
          lines: [
            {
              medicineId: medicineAId,
              batchId: batchA.id,
              quantity: 9999, // Exceeds stock
            },
          ],
        });
      }).toThrow(/Insufficient stock for batch/);
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 9: SUPPLIER INTELLIGENCE & SCORECARD
  // -------------------------------------------------------------------------
  describe('9. Supplier Intelligence Scorecards & Procurement Dashboard', () => {
    test('Calculates comprehensive supplier scorecard and rating grade', () => {
      const scorecard = SupplierIntelligenceService.getSupplierScorecard(orgId, supplierAlphaId);

      expect(scorecard.supplierName).toBe('Alpha Pharma Distributors');
      expect(scorecard.totalOrders).toBeGreaterThanOrEqual(1);
      expect(scorecard.totalPurchaseValuePaise).toBeGreaterThan(0);
      expect(scorecard.observedAvgLeadTimeDays).toBeDefined();
      expect(scorecard.fillRatePct).toBeGreaterThan(0);
      expect(scorecard.schemeFulfilmentRatePct).toBe(100.0);
      expect(scorecard.overallScore).toBeGreaterThanOrEqual(70);
      expect(['A+', 'A', 'B', 'C', 'D']).toContain(scorecard.ratingGrade);
    });

    test('Aggregates Procurement Command Center Dashboard Summary KPIs', () => {
      const summary = SupplierIntelligenceService.getDashboardSummary(orgId, storeId);

      expect(summary).toBeDefined();
      expect(typeof summary.openRequisitionsCount).toBe('number');
      expect(typeof summary.openPurchaseOrdersCount).toBe('number');
      expect(summary.totalSupplierOutstandingPaise).toBeGreaterThanOrEqual(0);
      expect(summary.schemeSavingsMonthPaise).toBeGreaterThanOrEqual(0);
    });
  });
});
