import express from 'express';import request from 'supertest';import {randomUUID} from 'node:crypto';
import {inventoryRouter} from '../routes/inventory';import {localDb} from '../local-db';import {errorHandler} from '../middleware/errorHandler';
const org=randomUUID(),foreign=randomUUID();const records:Record<string,string>={};
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:'owner',clinic_id:'own-clinic',organization_id:org,role:'OWNER',email:''};next();});app.use('/inventory',inventoryRouter);app.use(errorHandler);
beforeAll(()=>{
 const now=new Date().toISOString();
 const fixtures={
  stocktake_sessions:{name:'Private count',initiated_by:'other-owner',reference_timestamp:now},
  product_recalls:{recall_reference:'PRIVATE-QA',product_id:'private-medicine',reason:'QA',created_by:'other-owner'},
  inventory_alerts:{alert_type:'LOW_STOCK',title:'Private alert',message:'Private'},
  inventory_reservations:{location_type:'STORE',medicine_id:'private-medicine',quantity:1,source_type:'MANUAL',source_id:'QA',expires_at:'2099-01-01'},
 };
 for(const [table,fields] of Object.entries(fixtures)){
  const id=randomUUID();records[table]=id;const row={id,_local_id:id,organization_id:foreign,_updated_at:now,...fields};
  localDb.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 }
});
afterAll(()=>{for(const [table,id]of Object.entries(records))localDb.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);});
test('another organization’s stocktake and recall IDs cannot be read or acted upon',async()=>{
 for(const path of [`/stocktakes/${records.stocktake_sessions}`,`/recalls/${records.product_recalls}`,`/recalls/${records.product_recalls}/trace/prescriptions`])expect((await request(app).get('/inventory'+path)).status).toBe(404);
 expect((await request(app).post(`/inventory/stocktakes/${records.stocktake_sessions}/start`)).status).toBe(404);
});
test('alerts and reservations from another organization cannot be modified',async()=>{
 expect((await request(app).patch(`/inventory/alerts/${records.inventory_alerts}`).send({status:'RESOLVED'})).status).toBe(404);
 expect((await request(app).delete(`/inventory/reservations/${records.inventory_reservations}`)).status).toBe(404);
});
