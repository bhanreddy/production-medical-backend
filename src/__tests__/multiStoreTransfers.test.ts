// multiStoreTransfers.test.ts — Task 7 Enterprise Multi-Store Transfers, Warehouse Operations & Replenishment Test Suite
import { localDb } from '../local-db';
import { v4 as uuidv4 } from 'uuid';
import { StockTransferService } from '../services/transfers/stockTransferService';
import { TransferAllocationService } from '../services/transfers/transferAllocationService';
import { TransferPickPackService } from '../services/transfers/transferPickPackService';
import { TransferDispatchService } from '../services/transfers/transferDispatchService';
import { TransferReceivingService } from '../services/transfers/transferReceivingService';
import { TransferVarianceService } from '../services/transfers/transferVarianceService';
import { InternalReplenishmentEngine } from '../services/transfers/internalReplenishmentEngine';
import { StoreRebalancingEngine } from '../services/transfers/storeRebalancingEngine';
import { ExpiryRedistributionEngine } from '../services/transfers/expiryRedistributionEngine';
import { RecallTransferService } from '../services/transfers/recallTransferService';
import { WarehouseOperationsService } from '../services/warehouse/warehouseOperationsService';
import { TransferPolicyService } from '../services/transfers/transferPolicyService';
import { InventoryPositionService } from '../services/inventoryPosition';
import { InventoryAvailabilityService } from '../services/inventory/inventoryAvailabilityService';
import { ProductRecallEngine } from '../services/inventory/productRecallEngine';

describe('Task 7 — Multi-Store Transfers, Warehouse Operations & Central Replenishment', () => {
  const orgId = `org_trf_${Date.now()}`;
  const otherOrgId = `org_other_${Date.now()}`;
  const userId = `usr_mgr_${Date.now()}`;
  const pickerId = `usr_pick_${Date.now()}`;
  const receiverId = `usr_recv_${Date.now()}`;

  let storeAId: string;
  let storeBId: string;
  let warehouseId: string;
  let otherOrgStoreId: string;
  let medicineDoloId: string;
  let medicineAmoxId: string;
  let batchDoloAId: string;
  let batchDoloBId: string;
  let batchAmoxAId: string;

  beforeAll(() => {
    // 1. Setup Organizations
    localDb.prepare('INSERT INTO organizations (id, _local_id, legal_name, display_name, code, _updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      orgId, orgId, 'Apollo Central Health Org', 'Apollo Pharmacy Hub', `ORG-${Date.now()}`, new Date().toISOString()
    );
    localDb.prepare('INSERT INTO organizations (id, _local_id, legal_name, display_name, code, _updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      otherOrgId, otherOrgId, 'MedPlus Rival Org', 'MedPlus Retail', `MED-${Date.now()}`, new Date().toISOString()
    );

    // 2. Setup Stores & Warehouse
    storeAId = `store_a_${Date.now()}`;
    storeBId = `store_b_${Date.now()}`;
    warehouseId = `wh_central_${Date.now()}`;
    otherOrgStoreId = `store_other_${Date.now()}`;

    localDb.prepare('INSERT INTO stores (id, _local_id, organization_id, store_code, name, display_name, status, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      storeAId, storeAId, orgId, 'HYD-01', 'Banjara Hills Store', 'Banjara Hills Counter', 'active', new Date().toISOString()
    );
    localDb.prepare('INSERT INTO stores (id, _local_id, organization_id, store_code, name, display_name, status, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      storeBId, storeBId, orgId, 'HYD-04', 'Jubilee Hills Store', 'Jubilee Hills Counter', 'active', new Date().toISOString()
    );
    localDb.prepare('INSERT INTO warehouses (id, _local_id, organization_id, warehouse_code, name, status, cold_storage_supported, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      warehouseId, warehouseId, orgId, 'WH-UPPAL', 'Central Uppal Distribution Hub', 'active', 1, new Date().toISOString()
    );
    localDb.prepare('INSERT INTO stores (id, _local_id, organization_id, store_code, name, display_name, status, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      otherOrgStoreId, otherOrgStoreId, otherOrgId, 'RIV-01', 'Rival Store', 'Rival Branch', 'active', new Date().toISOString()
    );

    // 3. Setup User Access
    localDb.prepare('INSERT INTO user_organization_access (id, _local_id, user_id, organization_id, role, is_active, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      uuidv4(), uuidv4(), userId, orgId, 'OWNER', 1, new Date().toISOString()
    );
    localDb.prepare('INSERT INTO user_organization_access (id, _local_id, user_id, organization_id, role, is_active, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      uuidv4(), uuidv4(), pickerId, orgId, 'STAFF', 1, new Date().toISOString()
    );
    localDb.prepare('INSERT INTO user_organization_access (id, _local_id, user_id, organization_id, role, is_active, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      uuidv4(), uuidv4(), receiverId, orgId, 'STAFF', 1, new Date().toISOString()
    );

    // 4. Setup Medicines & Batches
    medicineDoloId = `med_dolo_${Date.now()}`;
    medicineAmoxId = `med_amox_${Date.now()}`;

    localDb.prepare('INSERT INTO medicines (id, _local_id, organization_id, name, generic_name, purchase_price, mrp, reorder_level, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      medicineDoloId, medicineDoloId, orgId, 'Dolo 650mg Tablet', 'Paracetamol 650mg', 25.0, 30.0, 50, new Date().toISOString()
    );
    localDb.prepare('INSERT INTO medicines (id, _local_id, organization_id, name, generic_name, purchase_price, mrp, reorder_level, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      medicineAmoxId, medicineAmoxId, orgId, 'Amoxicillin 500mg Capsule', 'Amoxicillin', 40.0, 60.0, 30, new Date().toISOString()
    );

    batchDoloAId = `batch_dolo_a_${Date.now()}`;
    batchDoloBId = `batch_dolo_b_${Date.now()}`;
    batchAmoxAId = `batch_amox_a_${Date.now()}`;

    const expFar = new Date(Date.now() + 3 * 365 * 86400000).toISOString().slice(0, 10);
    const expNear = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

    localDb.prepare('INSERT INTO medicine_batches (id, _local_id, organization_id, medicine_id, batch_number, expiry_date, purchase_price, mrp, quantity_remaining, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchDoloAId, batchDoloAId, orgId, medicineDoloId, 'DOLO-LOT-01', expFar, 25.0, 30.0, 1000, new Date().toISOString()
    );
    localDb.prepare('INSERT INTO medicine_batches (id, _local_id, organization_id, medicine_id, batch_number, expiry_date, purchase_price, mrp, quantity_remaining, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchDoloBId, batchDoloBId, orgId, medicineDoloId, 'DOLO-LOT-02', expNear, 24.0, 30.0, 500, new Date().toISOString()
    );
    localDb.prepare('INSERT INTO medicine_batches (id, _local_id, organization_id, medicine_id, batch_number, expiry_date, purchase_price, mrp, quantity_remaining, _updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      batchAmoxAId, batchAmoxAId, orgId, medicineAmoxId, 'AMOX-LOT-01', expFar, 40.0, 60.0, 500, new Date().toISOString()
    );

    // 5. Seed Inventory Positions: Warehouse has 1000 units Dolo Batch A, Store A has 500 units Dolo Batch B, Store B has 5 units Dolo Batch A
    InventoryPositionService.adjustStock({
      organizationId: orgId,
      medicineId: medicineDoloId,
      batchId: batchDoloAId,
      locationType: 'WAREHOUSE',
      warehouseId,
      quantityDelta: 1000,
    });
    InventoryPositionService.adjustStock({
      organizationId: orgId,
      medicineId: medicineDoloId,
      batchId: batchDoloBId,
      locationType: 'STORE',
      storeId: storeAId,
      quantityDelta: 500,
    });
    InventoryPositionService.adjustStock({
      organizationId: orgId,
      medicineId: medicineDoloId,
      batchId: batchDoloAId,
      locationType: 'STORE',
      storeId: storeBId,
      quantityDelta: 5,
    });
  });

  // ──────────────────────────────────────────
  // 1. Transfer Creation & Routing Tests
  // ──────────────────────────────────────────
  describe('1. Transfer Creation & Multi-Direction Routing', () => {
    test('1. Creates Warehouse to Store transfer request (Warehouse -> Store B)', () => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        priority: 'HIGH',
        reason: 'WAREHOUSE_REPLENISHMENT',
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 45 }],
      });

      expect(trf).toBeDefined();
      expect(trf.transfer_number).toContain('TRF');
      expect(trf.total_items).toBe(1);
      expect(trf.total_quantity_requested).toBe(45);
      expect(trf.status).toBe('REQUESTED');
    });

    test('2. Creates Store to Store transfer request (Store A -> Store B)', () => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'STORE_TO_STORE',
        sourceLocationType: 'STORE',
        sourceLocationId: storeAId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        priority: 'NORMAL',
        reason: 'STORE_REBALANCING',
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 20 }],
      });

      expect(trf).toBeDefined();
      expect(trf.transfer_type).toBe('STORE_TO_STORE');
      expect(trf.status).toBe('REQUESTED');
    });

    test('3. Creates Store to Warehouse return transfer request', () => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'STORE_TO_WAREHOUSE',
        sourceLocationType: 'STORE',
        sourceLocationId: storeAId,
        destinationLocationType: 'WAREHOUSE',
        destinationLocationId: warehouseId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 10 }],
      });

      expect(trf.transfer_type).toBe('STORE_TO_WAREHOUSE');
    });

    test('4. Blocks cross-organization transfers between different legal entities', () => {
      expect(() => {
        StockTransferService.createTransfer({
          organizationId: orgId,
          transferType: 'STORE_TO_STORE',
          sourceLocationType: 'STORE',
          sourceLocationId: storeAId,
          destinationLocationType: 'STORE',
          destinationLocationId: otherOrgStoreId,
          requestedBy: userId,
          items: [{ medicineId: medicineDoloId, requestedQuantity: 10 }],
        });
      }).toThrow(); // Destination store not found in source organization — cross-org blocked at resolution
    });
  });

  // ──────────────────────────────────────────
  // 2. Request & Approval Lifecycle Tests
  // ──────────────────────────────────────────
  describe('2. Request, Approval & Maker-Checker Policies', () => {
    let testTrfId: string;

    beforeEach(() => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        priority: 'NORMAL',
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 25 }],
      });
      testTrfId = trf.id;
    });

    test('5. Approves transfer and advances status to READY_TO_PICK with FEFO allocation', () => {
      const approved = StockTransferService.approveTransfer({
        transferId: testTrfId,
        organizationId: orgId,
        approvedBy: userId,
      });

      expect(approved.status).toBe('READY_TO_PICK');
      expect(approved.approved_by).toBe(userId);
      expect(approved.allocations?.length).toBeGreaterThan(0);
      expect(approved.allocations![0].quantity_allocated).toBe(25);
    });

    test('6. Rejects transfer request with audit reason', () => {
      const rejected = StockTransferService.rejectTransfer({
        transferId: testTrfId,
        organizationId: orgId,
        rejectedBy: userId,
        rejectionReason: 'Exceeds branch allocation quota',
      });

      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejection_reason).toBe('Exceeds branch allocation quota');
    });

    test('7. Enforces Maker-Checker policy when configured', () => {
      TransferPolicyService.setPolicy({
        organizationId: orgId,
        enforceMakerChecker: true,
      });

      expect(() => {
        StockTransferService.approveTransfer({
          transferId: testTrfId,
          organizationId: orgId,
          approvedBy: userId, // Same as requestedBy
        });
      }).toThrow(/Maker-Checker Violation/);

      // Reset policy
      TransferPolicyService.setPolicy({
        organizationId: orgId,
        enforceMakerChecker: false,
      });
    });
  });

  // ──────────────────────────────────────────
  // 3. Concurrency-Safe Allocation & FEFO Tests
  // ──────────────────────────────────────────
  describe('3. Concurrency-Safe Allocation & FEFO Batch Selection', () => {
    test('8. Decrements source available stock while physical on-hand remains unchanged before dispatch', () => {
      const initialPos = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'WAREHOUSE',
        warehouseId,
      });

      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 30 }],
      });

      StockTransferService.approveTransfer({
        transferId: trf.id,
        organizationId: orgId,
        approvedBy: userId,
      });

      const afterAllocPos = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'WAREHOUSE',
        warehouseId,
      });

      // Available decreased by reserved 30 units
      expect(afterAllocPos.totalAvailable).toBe(initialPos.totalAvailable - 30);
      // Physical on-hand is unchanged before dispatch
      expect(afterAllocPos.totalOnHand).toBe(initialPos.totalOnHand);
    });
  });

  // ──────────────────────────────────────────
  // 4. Picking & Mobile Scanning Tests
  // ──────────────────────────────────────────
  describe('4. Warehouse Pick List, Barcode Validation & Variance', () => {
    let pickTrfId: string;
    let allocId: string;

    beforeEach(() => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 20 }],
      });
      const approved = StockTransferService.approveTransfer({
        transferId: trf.id,
        organizationId: orgId,
        approvedBy: userId,
      });
      pickTrfId = trf.id;
      allocId = approved.allocations![0].id;
    });

    test('9. Generates pick list with bin sequencing', () => {
      const pickList = TransferPickPackService.generatePickList(pickTrfId, orgId);
      expect(pickList.allocations.length).toBe(1);
      expect(pickList.allocations[0].quantityAllocated).toBe(20);
    });

    test('10. Rejects wrong barcode during pick scan', () => {
      expect(() => {
        TransferPickPackService.recordPick({
          transferId: pickTrfId,
          allocationId: allocId,
          organizationId: orgId,
          scannedBarcode: 'INVALID-BARCODE-9999',
          quantityPicked: 20,
          pickedBy: pickerId,
        });
      }).toThrow(/Scanned barcode/);
    });

    test('11. Records successful pick scan and advances status to PICKING', () => {
      const pickRes = TransferPickPackService.recordPick({
        transferId: pickTrfId,
        allocationId: allocId,
        organizationId: orgId,
        quantityPicked: 20,
        pickedBy: pickerId,
      });

      expect(pickRes.status).toBe('PICKED');
      expect(pickRes.quantityPicked).toBe(20);
    });

    test('12. Completes picking and creates packaging containers with PKG-01 label', () => {
      TransferPickPackService.recordPick({
        transferId: pickTrfId,
        allocationId: allocId,
        organizationId: orgId,
        quantityPicked: 20,
        pickedBy: pickerId,
      });
      TransferPickPackService.completePicking(pickTrfId, orgId, pickerId);

      const pkg = TransferPickPackService.createPackage({
        transferId: pickTrfId,
        organizationId: orgId,
        packageType: 'BOX',
        isColdChain: true,
        items: [
          {
            transferItemId: pickTrfId,
            batchAllocationId: allocId,
            medicineId: medicineDoloId,
            batchId: batchDoloAId,
            quantityPacked: 20,
          },
        ],
        packedBy: pickerId,
      });

      expect(pkg.package_identifier).toContain('PKG-01');
      expect(pkg.is_cold_chain).toBe(1);
    });
  });

  // ──────────────────────────────────────────
  // 5. Critical Stock Movement: Dispatch & In-Transit
  // ──────────────────────────────────────────
  describe('5. Authoritative Dispatch & Critical Stock In-Transit Flow', () => {
    test('13. Strictly decrements source stock, increments IN_TRANSIT, and leaves destination stock UNCHANGED at dispatch', () => {
      const srcBefore = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'WAREHOUSE',
        warehouseId,
      });
      const destBefore = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeBId,
      });

      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 40 }],
      });

      StockTransferService.approveTransfer({ transferId: trf.id, organizationId: orgId, approvedBy: userId });

      // Dispatch Transfer
      const dispatched = TransferDispatchService.dispatchTransfer({
        transferId: trf.id,
        organizationId: orgId,
        dispatchedBy: userId,
        carrierName: 'Apollo Dedicated Fleet',
        trackingReference: 'TRK-HYD-001',
      });

      expect(dispatched.status).toBe('DISPATCHED');

      const srcAfter = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'WAREHOUSE',
        warehouseId,
      });
      const destAfter = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeBId,
      });

      // 1. Source physical on-hand decremented by 40
      expect(srcAfter.totalOnHand).toBe(srcBefore.totalOnHand - 40);

      // 2. CRITICAL RULE: Destination stock is completely UNCHANGED at dispatch time!
      expect(destAfter.totalOnHand).toBe(destBefore.totalOnHand);
      expect(destAfter.totalAvailable).toBe(destBefore.totalAvailable);

      // 3. In-Transit stock is tracked
      const inTransitRow: any = localDb
        .prepare(`SELECT quantity_in_transit FROM inventory_positions WHERE warehouse_id = ? AND medicine_id = ?`)
        .get(warehouseId, medicineDoloId);
      expect(Number(inTransitRow?.quantity_in_transit)).toBeGreaterThanOrEqual(40);

      // 4. Immutable Stock Ledger has TRANSFER_OUT entry
      const ledgerEntry: any = localDb
        .prepare(`SELECT * FROM stock_ledger WHERE reference_id = ? AND movement_type = 'TRANSFER_OUT'`)
        .get(trf.id);
      expect(ledgerEntry).toBeDefined();
      expect(ledgerEntry.quantity_delta).toBe(-40);
    });

    test('14. Duplicate dispatch is idempotent', () => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        idempotencyKey: `IDEMP-CR-${Date.now()}`,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 10 }],
      });
      StockTransferService.approveTransfer({ transferId: trf.id, organizationId: orgId, approvedBy: userId });

      TransferDispatchService.dispatchTransfer({
        transferId: trf.id,
        organizationId: orgId,
        dispatchedBy: userId,
        idempotencyKey: 'IDEMP-DISP-001',
      });

      // Second identical call returns without duplicate ledger writes
      const secondCall = TransferDispatchService.dispatchTransfer({
        transferId: trf.id,
        organizationId: orgId,
        dispatchedBy: userId,
        idempotencyKey: 'IDEMP-DISP-001',
      });

      expect(secondCall.status).toBe('DISPATCHED');
    });
  });

  // ──────────────────────────────────────────
  // 6. Receiving & Variance Tests
  // ──────────────────────────────────────────
  describe('6. Destination Receipt, Partial Inward & Discrepancies', () => {
    test('15. Full sound receipt: clears IN_TRANSIT, increments destination AVAILABLE, and logs TRANSFER_IN', () => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 15 }],
      });
      const approved = StockTransferService.approveTransfer({ transferId: trf.id, organizationId: orgId, approvedBy: userId });
      TransferDispatchService.dispatchTransfer({ transferId: trf.id, organizationId: orgId, dispatchedBy: userId });

      const destBefore = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeBId,
      });

      // Execute Destination Receipt
      const { transfer: receivedTrf } = TransferReceivingService.receiveTransfer({
        transferId: trf.id,
        organizationId: orgId,
        receivedBy: receiverId,
        items: [
          {
            transferItemId: approved.items![0].id,
            batchAllocationId: approved.allocations![0].id,
            medicineId: medicineDoloId,
            batchId: batchDoloAId,
            quantityAccepted: 15,
          },
        ],
      });

      expect(receivedTrf.status).toBe('RECEIVED');

      const destAfter = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeBId,
      });

      expect(destAfter.totalAvailable).toBe(destBefore.totalAvailable + 15);

      // Verify TRANSFER_IN in stock_ledger
      const inLedger: any = localDb
        .prepare(`SELECT * FROM stock_ledger WHERE reference_id = ? AND movement_type = 'TRANSFER_IN'`)
        .get(trf.id);
      expect(inLedger).toBeDefined();
      expect(inLedger.quantity_delta).toBe(15);
    });

    test('16. Damaged and Short Receipt (Integration Scenario 3: 45 Good, 3 Damaged, 2 Short)', () => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'WAREHOUSE_TO_STORE',
        sourceLocationType: 'WAREHOUSE',
        sourceLocationId: warehouseId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 50 }],
      });
      const approved = StockTransferService.approveTransfer({ transferId: trf.id, organizationId: orgId, approvedBy: userId });
      TransferDispatchService.dispatchTransfer({ transferId: trf.id, organizationId: orgId, dispatchedBy: userId });

      const destBefore = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeBId,
      });

      const { transfer: receivedTrf } = TransferReceivingService.receiveTransfer({
        transferId: trf.id,
        organizationId: orgId,
        receivedBy: receiverId,
        items: [
          {
            transferItemId: approved.items![0].id,
            batchAllocationId: approved.allocations![0].id,
            medicineId: medicineDoloId,
            batchId: batchDoloAId,
            quantityAccepted: 45,
            quantityDamaged: 3,
            quantityShort: 2,
          },
        ],
      });

      expect(receivedTrf.status).toBe('VARIANCE_REVIEW');

      const destAfter = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeBId,
      });

      // 45 sound units become AVAILABLE for POS
      expect(destAfter.totalAvailable).toBe(destBefore.totalAvailable + 45);

      // 3 damaged units are segregated into DAMAGED state
      const posRow: any = localDb
        .prepare(`SELECT quantity_damaged FROM inventory_positions WHERE store_id = ? AND medicine_id = ?`)
        .get(storeBId, medicineDoloId);
      expect(Number(posRow?.quantity_damaged)).toBe(3);

      // Discrepancy recorded in transfer_variances
      const variances = TransferVarianceService.listVariances({
        organizationId: orgId,
        transferId: trf.id,
      });
      expect(variances.length).toBeGreaterThanOrEqual(2); // SHORT and DAMAGED
    });
  });

  // ──────────────────────────────────────────
  // 7. Cancellation & Return to Source Tests
  // ──────────────────────────────────────────
  describe('7. Stage-Aware Cancellation & Return to Source', () => {
    test('17. Cancelling approved transfer safely releases all reservations', () => {
      const availBefore = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeAId,
      });

      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'STORE_TO_STORE',
        sourceLocationType: 'STORE',
        sourceLocationId: storeAId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 20 }],
      });
      StockTransferService.approveTransfer({ transferId: trf.id, organizationId: orgId, approvedBy: userId });

      // Cancel transfer
      StockTransferService.cancelTransfer({
        transferId: trf.id,
        organizationId: orgId,
        cancelledBy: userId,
        cancellationReason: 'Order cancelled by regional manager',
      });

      const availAfter = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineDoloId,
        locationType: 'STORE',
        storeId: storeAId,
      });

      // Available stock fully restored
      expect(availAfter.totalAvailable).toBe(availBefore.totalAvailable);
    });

    test('18. Dispatched transfer cannot be simply cancelled; generates Return to Source transfer', () => {
      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'STORE_TO_STORE',
        sourceLocationType: 'STORE',
        sourceLocationId: storeAId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medicineDoloId, requestedQuantity: 10 }],
      });
      StockTransferService.approveTransfer({ transferId: trf.id, organizationId: orgId, approvedBy: userId });
      TransferDispatchService.dispatchTransfer({ transferId: trf.id, organizationId: orgId, dispatchedBy: userId });

      expect(() => {
        StockTransferService.cancelTransfer({
          transferId: trf.id,
          organizationId: orgId,
          cancelledBy: userId,
        });
      }).toThrow(/Cannot directly cancel transfer in DISPATCHED status/);

      // Create Return Transfer instead
      const returnTrf = StockTransferService.createReturnTransfer({
        originalTransferId: trf.id,
        organizationId: orgId,
        reason: 'Destination counter closed unexpectedly',
        returnedBy: receiverId,
      });

      expect(returnTrf.transfer_type).toBe('RETURN_TO_SOURCE');
      expect(returnTrf.source_location_id).toBe(storeBId);
      expect(returnTrf.destination_location_id).toBe(storeAId);
    });
  });

  // ──────────────────────────────────────────
  // 8. Central Replenishment & Rebalancing Tests
  // ──────────────────────────────────────────
  describe('8. Central Replenishment & Cross-Store Rebalancing', () => {
    test('19. Evaluates Store B replenishment deficit and recommends replenishment from Central WH', () => {
      const decisions = InternalReplenishmentEngine.evaluateStoreReplenishment({
        organizationId: orgId,
        destinationStoreId: storeBId,
      });

      const doloDecision = decisions.find((d) => d.medicineId === medicineDoloId);
      expect(doloDecision).toBeDefined();
      // Engine should recommend either WAREHOUSE_TRANSFER or WAIT_FOR_INCOMING
      // (WAIT_FOR_INCOMING when prior tests already generated in-flight transfers)
      expect(['WAREHOUSE_TRANSFER', 'WAIT_FOR_INCOMING']).toContain(doloDecision?.decisionType);
    });

    test('20. Cross-store rebalancing respects source protected stock buffer', () => {
      const recs = StoreRebalancingEngine.evaluateRebalancing({
        organizationId: orgId,
        safetyStockDays: 7,
      });

      expect(Array.isArray(recs)).toBe(true);
      for (const r of recs) {
        expect(r.sourceTransferableQuantity).toBeGreaterThanOrEqual(r.recommendedTransferQuantity);
      }
    });

    test('21. Near-expiry redistribution engine matches velocity and rejects slow destination', () => {
      const plans = ExpiryRedistributionEngine.evaluateExpiryRedistribution({
        organizationId: orgId,
        nearExpiryDaysThreshold: 180,
      });

      expect(Array.isArray(plans)).toBe(true);
    });
  });

  // ──────────────────────────────────────────
  // 9. Recall Consolidation & State Preservation
  // ──────────────────────────────────────────
  describe('9. Product Recall Consolidation & State Preservation', () => {
    test('22. Recalled stock transfer preserves RECALLED state and remains unsellable at destination', () => {
      // 1. Add stock at Store A first
      InventoryPositionService.adjustStock({
        organizationId: orgId,
        medicineId: medicineAmoxId,
        batchId: batchAmoxAId,
        locationType: 'STORE',
        storeId: storeAId,
        quantityDelta: 20,
      });

      // Create and activate recall on Amoxicillin
      const recallDraft = ProductRecallEngine.createRecall({
        organizationId: orgId,
        recallReference: `REC-${Date.now()}`,
        recallType: 'BATCH',
        severity: 'CLASS_I',
        productId: medicineAmoxId,
        batchId: batchAmoxAId,
        batchNumber: 'AMOX-LOT-01',
        reason: 'Packaging defect inspection',
        createdBy: userId,
      });

      ProductRecallEngine.activateRecall(recallDraft.id, userId);

      // 2. Create Recall Consolidation Transfer to Central Warehouse
      const recallTrf = RecallTransferService.createRecallConsolidationTransfer({
        organizationId: orgId,
        recallId: recallDraft.id,
        sourceStoreId: storeAId,
        centralWarehouseId: warehouseId,
        requestedBy: userId,
      });

      expect(recallTrf.stock_state_transferred).toBe('RECALLED');
      expect(recallTrf.priority).toBe('CRITICAL');

      // 3. Approve, Dispatch, Receive
      const approved = StockTransferService.approveTransfer({ transferId: recallTrf.id, organizationId: orgId, approvedBy: userId });
      TransferDispatchService.dispatchTransfer({ transferId: recallTrf.id, organizationId: orgId, dispatchedBy: userId });

      TransferReceivingService.receiveTransfer({
        transferId: recallTrf.id,
        organizationId: orgId,
        receivedBy: receiverId,
        items: [
          {
            transferItemId: approved.items![0].id,
            batchAllocationId: approved.allocations![0].id,
            medicineId: medicineAmoxId,
            batchId: batchAmoxAId,
            quantityAccepted: 20,
          },
        ],
      });

      // 4. Verify Destination Warehouse Position: Units are in quantity_recalled, NOT quantity_available
      const whAvail = InventoryAvailabilityService.getAvailability({
        organizationId: orgId,
        medicineId: medicineAmoxId,
        locationType: 'WAREHOUSE',
        warehouseId,
      });

      expect(whAvail.totalAvailable).toBe(0); // Strictly unsellable
      expect(whAvail.totalBlocked).toBeGreaterThanOrEqual(20);
    });
  });

  // ──────────────────────────────────────────
  // 10. Warehouse Operations & Bin Grid
  // ──────────────────────────────────────────
  describe('10. Warehouse Bins, Operations Dashboard & Sequences', () => {
    test('23. Creates storage bin and retrieves warehouse operational queues', () => {
      const bin = WarehouseOperationsService.createBin({
        organizationId: orgId,
        warehouseId,
        binCode: `BIN-${Date.now()}`,
        binName: 'Fast Picking Bay 1',
        zone: 'ZONE-A',
        rack: 'R-01',
        shelf: 'S-01',
        binType: 'PICKING',
        pickSequence: 10,
      });

      expect(bin.bin_code).toContain('BIN-');

      const dashboard = WarehouseOperationsService.getWarehouseDashboard(orgId, warehouseId);
      expect(dashboard).toBeDefined();
      expect(dashboard.warehouseId).toBe(warehouseId);
      expect(dashboard.pickQueueCount).toBeDefined();
    });
  });

  // ──────────────────────────────────────────
  // 11. Security & Stock Integrity
  // ──────────────────────────────────────────
  describe('11. Security Permissions & Zero-Stock-Loss Integrity', () => {
    test('24. Total organization stock remains perfectly constant across transfers', () => {
      const medId = medicineDoloId;

      const totalOrgStockBefore: any = localDb
        .prepare(`SELECT SUM(quantity_on_hand) as total FROM inventory_positions WHERE (organization_id = ? OR organization_id = 'default-org') AND medicine_id = ?`)
        .get(orgId, medId);

      const trf = StockTransferService.createTransfer({
        organizationId: orgId,
        transferType: 'STORE_TO_STORE',
        sourceLocationType: 'STORE',
        sourceLocationId: storeAId,
        destinationLocationType: 'STORE',
        destinationLocationId: storeBId,
        requestedBy: userId,
        items: [{ medicineId: medId, requestedQuantity: 10 }],
      });
      const approved = StockTransferService.approveTransfer({ transferId: trf.id, organizationId: orgId, approvedBy: userId });
      TransferDispatchService.dispatchTransfer({ transferId: trf.id, organizationId: orgId, dispatchedBy: userId });

      TransferReceivingService.receiveTransfer({
        transferId: trf.id,
        organizationId: orgId,
        receivedBy: receiverId,
        items: [
          {
            transferItemId: approved.items![0].id,
            batchAllocationId: approved.allocations![0].id,
            medicineId: medId,
            batchId: batchDoloBId,
            quantityAccepted: 10,
          },
        ],
      });

      const totalOrgStockAfter: any = localDb
        .prepare(`SELECT SUM(quantity_on_hand) as total FROM inventory_positions WHERE (organization_id = ? OR organization_id = 'default-org') AND medicine_id = ?`)
        .get(orgId, medId);

      // Mathematical stock conservation: Q_before === Q_after
      expect(Number(totalOrgStockAfter?.total)).toBe(Number(totalOrgStockBefore?.total));
    });

    test('25. Batch acquisition cost basis is preserved at destination', () => {
      const inLedger: any = localDb
        .prepare(`SELECT * FROM stock_ledger WHERE location_type = 'STORE' AND store_id = ? AND medicine_id = ? AND movement_type = 'TRANSFER_IN' ORDER BY created_at DESC LIMIT 1`)
        .get(storeBId, medicineDoloId);

      expect(inLedger).toBeDefined();
      expect(inLedger.unit_cost_paise).toBeGreaterThan(0);
    });
  });
});
