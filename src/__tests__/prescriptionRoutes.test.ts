import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
jest.mock('../middleware/auth', () => ({ requireAuth: (req: any, res: any, next: any) => {
  req.user = { id: 'rx-test-operator', role: req.headers['x-test-role'] || 'OWNER', clinic_id: req.headers['x-test-clinic'] || 'rx-test-clinic' }; next();
} }));
import { doctorsRouter } from '../routes/doctors';
import { patientsRouter } from '../routes/patients';
import { DoctorService } from '../services/prescription/doctorService';
import { prescriptionsRouter } from '../routes/prescriptions';
import { errorHandler } from '../middleware/errorHandler';
import { localDb, initLocalDb } from '../local-db';
import { PrescriptionService } from '../services/prescription/prescriptionService';
import { PrescriptionExtractionService } from '../services/prescription/prescriptionExtractionService';
const app = express(); app.use(express.json()); app.use('/rx', prescriptionsRouter); app.use('/doctors', doctorsRouter); app.use('/patients', patientsRouter); app.use(errorHandler);
const fixture = { doctor_name: 'QA Doctor', doctor_registration_number: 'QA-REG', items_json: [{ raw_text: 'QA medication as entered', prescribed_name: 'QA medication as entered', prescribed_quantity: 2 }] };
let documentKey: string, rxId: string, storageRoot: string;
const savedPath = process.env.PRESCRIPTION_STORAGE_PATH;
beforeAll(async () => { initLocalDb(); storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'medical-rx-tests-')); process.env.PRESCRIPTION_STORAGE_PATH = storageRoot; });
afterAll(async () => {
  localDb.exec("DELETE FROM prescription_items WHERE prescription_id IN (SELECT id FROM prescriptions WHERE organization_id IN ('rx-test-clinic','rx-other-clinic')); DELETE FROM prescriptions WHERE organization_id IN ('rx-test-clinic','rx-other-clinic'); DELETE FROM doctors WHERE organization_id IN ('rx-test-clinic','rx-other-clinic');");
  await fs.rm(storageRoot, { recursive: true, force: true });
  if (savedPath === undefined) delete process.env.PRESCRIPTION_STORAGE_PATH; else process.env.PRESCRIPTION_STORAGE_PATH = savedPath;
});
test('manual entry preserves the supplied medicine and quantity without a fabricated document', async () => {
  const result = await request(app).post('/rx').send(fixture);
  expect(result.status).toBe(201); rxId = result.body.data.id;
  expect(result.body.data.document_url).toBe('');
  expect(result.body.data.source).toBe('MANUAL_ENTRY');
  expect(result.body.data.items[0].prescribed_name).toBe('QA medication as entered');
  expect(result.body.data.items[0].prescribed_quantity).toBe(2);
});
test('file upload persists an original that only the owning clinic can download', async () => {
  const pdf = Buffer.from('%PDF-1.4\nSynthetic QA document\n%%EOF');
  const result = await request(app).post('/rx').field('doctor_name','QA Doctor').field('doctor_registration_number','QA-REG').field('items_json', JSON.stringify(fixture.items_json)).attach('file',pdf,{ filename:'qa.pdf', contentType:'application/pdf' });
  expect(result.status).toBe(201); documentKey = result.body.data.document_url;
  expect(await fs.readFile(path.join(storageRoot, documentKey))).toEqual(pdf);
  const download = await request(app).get('/rx/document/signed-proxy').query({ key: documentKey });
  expect(download.status).toBe(200); expect(download.headers['content-type']).toContain('application/pdf'); expect(download.headers['cache-control']).toBe('private, no-store');
  expect((await request(app).get('/rx/document/signed-proxy').set('x-test-clinic','rx-other-clinic').query({key:documentKey})).status).toBe(404);
});
test('every prescription detail and action rejects a different clinic', async () => {
  for (const endpoint of ['', '/dispensing']) expect((await request(app).get(`/rx/${rxId}${endpoint}`).set('x-test-clinic','rx-other-clinic')).status).toBe(404);
  for (const endpoint of ['/claim','/verify','/reject','/extract']) expect((await request(app).post(`/rx/${rxId}${endpoint}`).set('x-test-clinic','rx-other-clinic').send({rejection_reason:'OTHER'})).status).toBe(404);
});
test('viewer cannot upload or verify and malformed items are not silently discarded', async () => {
  expect((await request(app).post('/rx').set('x-test-role','VIEWER').send(fixture)).status).toBe(403);
  expect((await request(app).post(`/rx/${rxId}/verify`).set('x-test-role','CASHIER').send({})).status).toBe(403);
  expect((await request(app).post('/rx').send({...fixture,items_json:'invalid-json'})).status).toBe(400);
  expect((await request(app).post('/rx').send({...fixture,doctor_name:''})).status).toBe(400);
});
test('verification cannot modify another prescription item or accept negative quantities', async () => {
  const other = PrescriptionService.createPrescription({ organizationId:'rx-other-clinic', doctorName:'QA Other', doctorRegistrationNumber:'QA-OTHER', documentUrl:'', items:[{raw_text:'Other',prescribed_name:'Other', prescribed_quantity:3}] });
  const response = await request(app).post(`/rx/${rxId}/verify`).send({ item_updates:[{itemId:other.prescription.items![0].id,prescribedQuantity:999}] });
  expect(response.status).toBe(400);
  expect(PrescriptionService.getPrescriptionById(other.prescription.id!)!.items![0].prescribed_quantity).toBe(3);
  expect((await request(app).post(`/rx/${rxId}/verify`).send({item_updates:[{itemId:crypto.randomUUID(),prescribedQuantity:-1}]})).status).toBe(400);
});
test('extraction never invents a medicine, dose, quantity or doctor from a document URL', () => {
  const empty = PrescriptionExtractionService.extractCandidates({documentUrl:'prescriptions/unreadable.pdf'});
  expect(empty.candidateLines).toEqual([]); expect(empty.overallConfidence).toBe(0); expect(empty.doctorNameCandidate).toBeUndefined();
  const supplied = PrescriptionExtractionService.extractCandidates({rawDocumentText:'Tab QA medicine 100mg'});
  expect(supplied.candidateLines[0].raw_text).toBe('Tab QA medicine 100mg'); expect(supplied.candidateLines[0].suggested_quantity).toBeUndefined(); expect(supplied.candidateLines[0].dose_text).toBeUndefined();
});

test('doctor registration matching stays within the organization and ignores spoofed query access', async () => {
  const first = DoctorService.findOrCreateByRegistration({organizationId:'rx-test-clinic',name:'QA First',registrationNumber:'QA-SHARED'});
  const second = DoctorService.findOrCreateByRegistration({organizationId:'rx-other-clinic',name:'QA Second',registrationNumber:'QA-SHARED'});
  expect(second.id).not.toBe(first.id);
  expect((await request(app).get('/doctors').query({organization_id:'rx-other-clinic'})).status).toBe(403);
  expect((await request(app).get(`/doctors/${second.id}`)).status).toBe(404);
});
test('patient history and allergies do not reveal or modify records from another clinic', async () => {
  const allergyId = crypto.randomUUID(); const now = new Date().toISOString();
  localDb.prepare('INSERT INTO patient_allergies(id,_local_id,organization_id,patient_id,allergen,active,_updated_at) VALUES(?,?,?,?,?,1,?)').run(allergyId,allergyId,'rx-other-clinic','qa-patient','QA Restricted Allergen',now);
  try {
    const history = await request(app).get('/patients/qa-patient/medication-history');
    expect(history.status).toBe(404);
    expect((await request(app).get('/patients/qa-patient/allergies')).status).toBe(404);
    expect((await request(app).post('/patients/qa-patient/allergies').send({allergen:'QA Allergy'})).status).toBe(404);
  } finally { localDb.prepare('DELETE FROM patient_allergies WHERE id = ?').run(allergyId); }
});

test('patient history resolves a real patient and accepts every severity exposed in the form', async () => {
 const id=crypto.randomUUID(),now=new Date().toISOString();
 localDb.prepare('INSERT INTO customers(id,_local_id,organization_id,clinic_id,name,_updated_at) VALUES(?,?,?,?,?,?)').run(id,id,'rx-test-clinic','rx-test-clinic','QA named patient',now);
 try {
  const history=await request(app).get(`/patients/${id}/medication-history`);expect(history.status).toBe(200);expect(history.body.data.patientName).toBe('QA named patient');
  expect((await request(app).post(`/patients/${id}/allergies`).send({allergen:'QA synthetic allergen',severity:'ANAPHYLAXIS'})).status).toBe(201);
 } finally {localDb.prepare('DELETE FROM patient_allergies WHERE patient_id=?').run(id);localDb.prepare('DELETE FROM customers WHERE id=?').run(id);}
});
