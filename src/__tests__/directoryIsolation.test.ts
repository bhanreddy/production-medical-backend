import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { localDb } from '../local-db';
import { barcodesRouter } from '../routes/barcodes';
import { organizationsRouter } from '../routes/organizations';
import { errorHandler } from '../middleware/errorHandler';
const actor = { id: randomUUID(), clinic_id: randomUUID(), role: 'OWNER' };
jest.mock('../middleware/auth', () => ({ requireAuth: (req: any, _res: any, next: () => void) => { req.user = actor; next(); } }));
const org = randomUUID(), other = randomUUID(), ownMedicine = randomUUID(), foreignMedicine = randomUUID(), foreignStore = randomUUID();
const app = express(); app.use(express.json()); app.use('/barcodes', barcodesRouter); app.use('/organizations', organizationsRouter); app.use(errorHandler);
beforeAll(() => {
  const now = new Date().toISOString();
  for (const id of [org, other]) localDb.prepare('INSERT INTO organizations(id,_local_id,code,legal_name,_updated_at) VALUES(?,?,?,?,?)').run(id,id,id,id,now);
  localDb.prepare('INSERT INTO clinics(id,_local_id,name,organization_id,_updated_at) VALUES(?,?,?,?,?)').run(actor.clinic_id,actor.clinic_id,'QA',org,now);
  for (const [id, organization, code] of [[ownMedicine,org,'OWN-CODE'],[foreignMedicine,other,'FOREIGN-CODE']]) {
    localDb.prepare('INSERT INTO medicines(id,_local_id,organization_id,name,primary_barcode,is_active,_updated_at) VALUES(?,?,?,?,?,1,?)').run(id,id,organization,'QA medicine',code,now);
    const barcode = randomUUID();
    localDb.prepare('INSERT INTO product_barcodes(id,_local_id,organization_id,medicine_id,barcode,_updated_at) VALUES(?,?,?,?,?,?)').run(barcode,barcode,organization,id,`${code}-ALT`,now);
  }
  localDb.prepare('INSERT INTO stores(id,_local_id,organization_id,name,_updated_at) VALUES(?,?,?,?,?)').run(foreignStore,foreignStore,other,'Other store',now);
});
test('primary and alternate barcodes only resolve within the current organization', async () => {
  expect((await request(app).get('/barcodes/lookup?code=OWN-CODE')).status).toBe(200);
  expect((await request(app).get('/barcodes/lookup?code=OWN-CODE-ALT')).status).toBe(200);
  expect((await request(app).get('/barcodes/lookup?code=FOREIGN-CODE')).status).toBe(404);
  expect((await request(app).get('/barcodes/lookup?code=FOREIGN-CODE-ALT')).status).toBe(404);
});
test('barcode detail and registration reject medicines from another organization', async () => {
  expect((await request(app).get(`/barcodes/medicine/${foreignMedicine}`)).status).toBe(404);
  expect((await request(app).post('/barcodes').send({medicine_id:foreignMedicine,barcode:'CROSS-TENANT'})).status).toBe(404);
  expect((await request(app).post('/barcodes').send({medicine_id:ownMedicine,barcode:'INVALID',conversion_factor:-1})).status).toBe(400);
});
test('organization directory and nested resources never fall back to every tenant', async () => {
  const response = await request(app).get('/organizations');
  expect(response.body.data.map((row: {id:string}) => row.id)).toEqual([org]);
  for (const resource of ['stores','regions','warehouses']) {
    expect((await request(app).get(`/organizations/${other}/${resource}`)).status).toBe(404);
    expect((await request(app).post(`/organizations/${other}/${resource}`).send({name:'Intruder'})).status).toBe(404);
  }
  for (const resource of ['counters','terminals']) expect((await request(app).get(`/organizations/stores/${foreignStore}/${resource}`)).status).toBe(404);
});
test('an owner cannot inspect reconciliation of another tenant batch', async () => {
  const id = randomUUID();
  localDb.prepare('INSERT INTO medicine_batches(id,_local_id,organization_id,clinic_id,medicine_id,_updated_at) VALUES(?,?,?,?,?,?)').run(id,id,other,'foreign-clinic',foreignMedicine,new Date().toISOString());
  expect((await request(app).get(`/organizations/inventory/reconciliation?batch_id=${id}`)).status).toBe(404);
});
