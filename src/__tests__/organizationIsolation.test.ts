import { randomUUID } from "node:crypto";
import { localDb } from "../local-db";
import { WarehouseOperationsService } from "../services/warehouse/warehouseOperationsService";
import { SupplierIntelligenceService } from "../services/procurement/supplierIntelligenceService";
import { POSSearchService } from "../services/posSearch";
const warehouse = randomUUID(),
  supplier = randomUUID(),
  medicine = randomUUID(),
  bin = randomUUID();
const org = randomUUID();
beforeAll(() => {
  const now = new Date().toISOString();
  localDb
    .prepare(
      "INSERT INTO warehouses(id,_local_id,organization_id,name,_updated_at) VALUES(?,?,?,?,?)",
    )
    .run(warehouse, warehouse, "default-org", "Other tenant warehouse", now);
  localDb
    .prepare(
      "INSERT INTO warehouse_bins(id,_local_id,organization_id,warehouse_id,bin_code,bin_name,_updated_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(bin, bin, "default-org", warehouse, "QA", "Isolation QA bin", now);
  localDb
    .prepare(
      "INSERT INTO suppliers(id,_local_id,organization_id,name,_updated_at) VALUES(?,?,?,?,?)",
    )
    .run(supplier, supplier, "default-org", "Other tenant supplier", now);
  localDb
    .prepare(
      "INSERT INTO medicines(id,_local_id,organization_id,name,is_active,_updated_at) VALUES(?,?,?,?,1,?)",
    )
    .run(
      medicine,
      medicine,
      "default-org",
      "Other tenant isolation medicine",
      now,
    );
});
afterAll(() => {
  for (const [table, id] of [
    ["warehouses", warehouse],
    ["warehouse_bins", bin],
    ["suppliers", supplier],
    ["medicines", medicine],
  ])
    localDb.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
});
test("warehouse and supplier lookups never include another default organization", () => {
  expect(WarehouseOperationsService.listBins(org, warehouse)).toEqual([]);
  expect(() =>
    WarehouseOperationsService.getWarehouseDashboard(org, warehouse),
  ).toThrow("Warehouse not found");
  expect(() =>
    SupplierIntelligenceService.getSupplierScorecard(org, supplier),
  ).toThrow("Supplier not found");
});
test("POS search does not expose medicines from default organization", () => {
  expect(
    POSSearchService.search({
      query: "Other tenant isolation medicine",
      organizationId: org,
      storeId: randomUUID(),
      limit: 25,
    }).results,
  ).toEqual([]);
});

import { InventoryAvailabilityService } from '../services/inventory/inventoryAvailabilityService';
import { InventoryValuationService } from '../services/inventory/inventoryValuationService';
import { InventoryClassificationEngine } from '../services/inventory/inventoryClassificationEngine';
import { InventoryReconciliationServiceV2 } from '../services/inventory/inventoryReconciliationV2';
import { ExpiryIntelligenceEngine } from '../services/inventory/expiryIntelligenceEngine';
const foreignBatch = randomUUID();
beforeAll(() => localDb.prepare(`INSERT INTO medicine_batches(id,_local_id,organization_id,medicine_id,batch_number,quantity_remaining,purchase_price,mrp,expiry_date,_updated_at)
  VALUES(?,?,?,?,?,24,10,20,'2025-01-01',?)`).run(foreignBatch,foreignBatch,'default-org',medicine,'PRIVATE-BATCH',new Date().toISOString()));
afterAll(() => localDb.prepare('DELETE FROM medicine_batches WHERE id=?').run(foreignBatch));
test('availability, valuation, ageing, expiry and reconciliation never include another organization’s batches',()=>{
 expect(()=>InventoryAvailabilityService.getAvailability({organizationId:org,medicineId:medicine,locationType:'STORE'})).toThrow('Medicine not found');
 expect(InventoryValuationService.getValuation({organizationId:org}).totalUnitsOnHand).toBe(0);
 expect(InventoryClassificationEngine.getAgeingAnalysis({organizationId:org}).totalStockCostPaise).toBe(0);
 expect(InventoryReconciliationServiceV2.reconcile({organizationId:org}).diagnostics).toEqual([]);
 expect(ExpiryIntelligenceEngine.getExpiryRiskItems({organizationId:org}).items).toEqual([]);
});
