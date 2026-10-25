import { localDb } from '../../local-db';
import { POSSearchService } from '../../services/posSearch';

// This suite owns an isolated in-memory database; it never touches shop data.
jest.mock('../../local-db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE medicines (
      id TEXT, _local_id TEXT PRIMARY KEY, organization_id TEXT, name TEXT,
      brand_name TEXT, generic_name TEXT, composition TEXT, manufacturer TEXT,
      hsn_code TEXT, primary_barcode TEXT, is_active INTEGER DEFAULT 1,
      _deleted INTEGER DEFAULT 0
    );
    CREATE TABLE medicine_batches (
      id TEXT, _local_id TEXT PRIMARY KEY, medicine_id TEXT, store_id TEXT,
      batch_number TEXT, expiry_date TEXT, quantity_remaining REAL, purchase_price REAL,
      mrp REAL, is_disposed INTEGER DEFAULT 0, _deleted INTEGER DEFAULT 0
    );
    CREATE TABLE product_barcodes (
      id TEXT, _local_id TEXT, organization_id TEXT, medicine_id TEXT, barcode TEXT,
      barcode_type TEXT, unit_type TEXT, conversion_factor REAL, _deleted INTEGER DEFAULT 0
    );
  `);
  return { localDb: db };
});

const context = { organizationId: 'org-a', storeId: 'store-a' };

function medicine(id: string, name: string, generic: string | null = null, localId = id) {
  localDb.prepare('INSERT INTO medicines (id, _local_id, organization_id, name, generic_name) VALUES (?, ?, ?, ?, ?)')
    .run(id, localId, context.organizationId, name, generic);
}

function batch(id: string, medicineId: string, quantity = 10, expiry = '2099-12-31', store: string | null = context.storeId) {
  localDb.prepare(`INSERT INTO medicine_batches
    (id, _local_id, medicine_id, store_id, batch_number, expiry_date, quantity_remaining, mrp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id, medicineId, store, id, expiry, quantity, 25);
}

beforeEach(() => {
  localDb.exec('DELETE FROM medicines; DELETE FROM medicine_batches; DELETE FROM product_barcodes;');
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => localDb.close());

test('stock queries stay constant with 40 matches and 15 substitutes', () => {
  for (let i = 0; i < 40; i++) {
    medicine(`med-${i}`, `Cough medicine ${i}`, 'Cough');
    batch(`batch-${i}`, `med-${i}`);
  }
  const prepare = jest.spyOn(localDb, 'prepare');
  const result = POSSearchService.search({ ...context, query: 'Cough' });
  expect(result.results).toHaveLength(25);
  expect(result.substitutes).toHaveLength(15);
  expect(prepare.mock.calls.filter(([query]) => /FROM medicine_batches/.test(query))).toHaveLength(2);
  expect(prepare).toHaveBeenCalledTimes(4);
});

test('stock includes both medicine IDs and excludes expired, disposed, empty, deleted and other-store batches', () => {
  medicine('cloud-med', 'Unique product', null, 'local-med');
  batch('late', 'cloud-med', 7);
  batch('early', 'local-med', 3, '2098-01-01', null);
  batch('expired', 'cloud-med', 100, '2000-01-01');
  batch('disposed', 'cloud-med', 100);
  batch('deleted', 'cloud-med', 100);
  batch('other-store', 'cloud-med', 100, '2099-12-31', 'store-b');
  batch('empty', 'cloud-med', 0);
  localDb.prepare("UPDATE medicine_batches SET is_disposed = 1 WHERE id = 'disposed'").run();
  localDb.prepare("UPDATE medicine_batches SET _deleted = 1 WHERE id = 'deleted'").run();
  const result = POSSearchService.search({ ...context, query: 'Unique' }).results[0];
  expect(result.total_available_stock).toBe(10);
  expect(result.nearest_expiry).toBe('2098-01-01');
  expect(result.batches.map(b => b.id)).toEqual(['early', 'late']);
});

test('substitutes use the same disposed-batch exclusions', () => {
  medicine('original', 'Original medicine', 'Shared');
  medicine('alternative', 'Alternative medicine', 'Shared');
  batch('alternative-stock', 'alternative', 8);
  batch('disposed-alternative', 'alternative', 100);
  localDb.prepare("UPDATE medicine_batches SET is_disposed = 1 WHERE id = 'disposed-alternative'").run();
  const result = POSSearchService.search({ ...context, query: 'Original' });
  expect(result.substitutes[0].total_available_stock).toBe(8);
  expect(result.substitutes[0].batches).toHaveLength(1);
});

test('alternate barcodes preserve the medicine ID and pack conversion', () => {
  medicine('med', 'Barcode medicine');
  batch('stock', 'med');
  localDb.prepare(`INSERT INTO product_barcodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('barcode-row', 'barcode-local', 'org-a', 'med', '123456', 'PACK', 'BOX', 100, 0);
  const result = POSSearchService.search({ ...context, barcode: '123456' }).results[0];
  expect(result.id).toBe('med');
  expect(result.total_available_stock).toBe(10);
  expect(result.matched_barcode).toMatchObject({ barcode: '123456', unit_type: 'BOX', conversion_factor: 100 });
});

test('deleted and foreign-organization barcode rows do not match', () => {
  medicine('med', 'Barcode medicine');
  localDb.prepare('INSERT INTO product_barcodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('deleted', 'deleted', 'org-a', 'med', '123456', 'PACK', 'BOX', 100, 1);
  expect(POSSearchService.search({ ...context, barcode: '123456' }).results).toHaveLength(0);
  localDb.prepare("UPDATE product_barcodes SET _deleted = 0, organization_id = 'org-b'").run();
  expect(POSSearchService.search({ ...context, barcode: '123456' }).results).toHaveLength(0);
});

test('an exact name ranks ahead of more than 100 partial matches', () => {
  for (let i = 0; i < 110; i++) medicine(`partial-${i}`, `Other aspirin ${i}`);
  medicine('exact', 'Aspirin');
  expect(POSSearchService.search({ ...context, query: 'Aspirin', limit: 1 }).results[0].id).toBe('exact');
});

test('typo tolerance still finds misspellings and bounds invalid limits', () => {
  medicine('para', 'Paracetamol');
  expect(POSSearchService.search({ ...context, query: 'paracetmol', limit: -5 }).results[0].id).toBe('para');
  expect(POSSearchService.search({ ...context, query: '  ' })).toEqual({ results: [], substitutes: [] });
});
