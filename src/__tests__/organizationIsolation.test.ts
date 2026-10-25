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
