const raw = jest.fn();
jest.mock('../lib/postgresDb', () => ({ queryRaw: (...args: unknown[]) => raw(...args) }));
import { localDb, initLocalDb } from '../local-db';
import { ensureCloudReferenceCatalog, invalidateCloudReferenceCatalog } from '../services/cloudReferenceCatalog';
const clinic = 'catalog-test-clinic', organization = 'catalog-test-org';
const medicine = 'ca000000-0000-4000-8000-000000000001';
let row: Record<string, unknown> = { id: medicine, clinic_id: clinic, name:'QA Catalog Medicine', gst_rate:12, is_active:true, created_at:'2026-10-08T00:00:00Z' };
beforeAll(() => initLocalDb());
afterAll(() => localDb.prepare('DELETE FROM medicines WHERE clinic_id = ?').run(clinic));
beforeEach(() => { raw.mockReset(); raw.mockImplementation(async (sql: string) => {
  if (sql.includes('CURRENT_TIMESTAMP')) return [{ now:'2026-10-08 00:00:00+00' }];
  if (sql.includes('FROM medicines')) return [row];
  return [];
}); });
test('concurrent operational requests share a tenant-scoped read projection without enqueuing cloud writes', async () => {
  const queue = (localDb.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as {n:number}).n;
  await Promise.all([ensureCloudReferenceCatalog(clinic, organization),ensureCloudReferenceCatalog(clinic, organization)]);
  expect(raw).toHaveBeenCalledTimes(4);
  expect(raw.mock.calls.filter(([sql]) => !sql.includes('CURRENT_TIMESTAMP')).every(([,params]) => params[0] === clinic)).toBe(true);
  const projected = localDb.prepare('SELECT * FROM medicines WHERE id = ?').get(medicine) as any;
  expect(projected.name).toBe('QA Catalog Medicine'); expect(projected.organization_id).toBe(organization); expect(projected._synced).toBe(1);
  expect((localDb.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as {n:number}).n).toBe(queue);
});
test('fresh reads use the cache; invalidation refreshes names and deleted records', async () => {
  await ensureCloudReferenceCatalog(clinic,organization); expect(raw).not.toHaveBeenCalled();
  invalidateCloudReferenceCatalog(clinic);
  row = {...row, name:'Updated QA Catalog', deleted_at:'2026-10-08T01:00:00Z'};
  await ensureCloudReferenceCatalog(clinic,organization);
  const updated = localDb.prepare('SELECT name, _deleted FROM medicines WHERE id = ?').get(medicine) as any;
  expect(updated.name).toBe('Updated QA Catalog'); expect(updated._deleted).toBe(1);
});
test('pending native catalog edits survive a cloud read refresh', async () => {
  localDb.prepare('UPDATE medicines SET name = ?, _synced = 0 WHERE id = ?').run('Pending native edit',medicine);
  invalidateCloudReferenceCatalog(clinic); await ensureCloudReferenceCatalog(clinic,organization);
  expect((localDb.prepare('SELECT name FROM medicines WHERE id = ?').get(medicine) as any).name).toBe('Pending native edit');
});
