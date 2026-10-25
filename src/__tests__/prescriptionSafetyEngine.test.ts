import request from 'supertest';
import { createApp } from '../app';
import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { DoctorService } from '../services/prescription/doctorService';
import { PrescriptionStorageService } from '../services/prescription/prescriptionStorageService';
import { PrescriptionExtractionService } from '../services/prescription/prescriptionExtractionService';
import { PrescriptionService } from '../services/prescription/prescriptionService';
import { DispensingEngine } from '../services/prescription/dispensingEngine';
import {
  PatientAllergyService,
  DuplicateIngredientGuard,
  DefaultDrugKnowledgeProvider,
  SubstitutionEngine,
} from '../services/prescription/pharmacySafetyEngine';
import { PatientMedicationHistoryService } from '../services/prescription/patientMedicationHistoryService';
import { ReturnsEngine } from '../services/returnsEngine';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const app = createApp();
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jwt_testing_1234567890';

describe('Task 4 — Prescription Management, Pharmacist Verification & Pharmacy Safety Engine', () => {
  let orgId: string;
  let storeAId: string;
  let storeBId: string;
  let counterId: string;
  let terminalId: string;
  let pharmacistId: string;
  let cashierId: string;
  let patientId: string;
  let medParacetamolId: string;
  let medAzithromycinId: string;
  let batchPara1Id: string;
  let batchAzithro1Id: string;

  let pharmacistToken: string;
  let cashierToken: string;

  beforeAll(() => {
    orgId = `org_rx_${Date.now()}`;
    storeAId = `store_rx_a_${Date.now()}`;
    storeBId = `store_rx_b_${Date.now()}`;
    counterId = `cnt_rx_${Date.now()}`;
    terminalId = `trm_rx_${Date.now()}`;
    pharmacistId = `usr_pharm_${Date.now()}`;
    cashierId = `usr_cash_${Date.now()}`;
    patientId = `cust_rx_pat_${Date.now()}`;
    medParacetamolId = `med_para_${Date.now()}`;
    medAzithromycinId = `med_azithro_${Date.now()}`;
    batchPara1Id = `btc_para_${Date.now()}`;
    batchAzithro1Id = `btc_azithro_${Date.now()}`;

    // 1. Setup Organization & Stores
    localMutate({
      table: 'organizations',
      operation: 'INSERT',
      data: {
        id: orgId,
        _local_id: orgId,
        legal_name: 'Rx Test Organization',
        display_name: 'Rx Test Org',
        code: `ORG_RX_${Date.now()}`,
        gstin: '36AAACR1234A1Z5',
        status: 'ACTIVE',
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'stores',
      operation: 'INSERT',
      data: {
        id: storeAId,
        _local_id: storeAId,
        organization_id: orgId,
        store_code: 'HYD01',
        name: 'Hyderabad Retail Pharmacy',
        address: 'Banjara Hills',
        city: 'Hyderabad',
        state: 'Telangana',
        state_code: '36',
        pincode: '500034',
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'stores',
      operation: 'INSERT',
      data: {
        id: storeBId,
        _local_id: storeBId,
        organization_id: orgId,
        store_code: 'SEC01',
        name: 'Secunderabad Branch',
        address: 'MG Road',
        city: 'Secunderabad',
        state: 'Telangana',
        state_code: '36',
        pincode: '500003',
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'counters',
      operation: 'INSERT',
      data: {
        id: counterId,
        _local_id: counterId,
        organization_id: orgId,
        store_id: storeAId,
        counter_code: 'C1',
        name: 'Counter 1',
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'terminals',
      operation: 'INSERT',
      data: {
        id: terminalId,
        _local_id: terminalId,
        organization_id: orgId,
        store_id: storeAId,
        counter_id: counterId,
        device_uuid: uuidv4(),
        terminal_code: 'T1',
        terminal_name: 'Terminal 1',
        created_at: new Date().toISOString(),
      },
    });

    // 2. Setup Cashier & Pharmacist Users
    localMutate({
      table: 'users',
      operation: 'INSERT',
      data: {
        id: pharmacistId,
        _local_id: pharmacistId,
        clinic_id: orgId,
        full_name: 'Dr. Pharmacist',
        role: 'PHARMACIST',
        is_active: 1,
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'users',
      operation: 'INSERT',
      data: {
        id: cashierId,
        _local_id: cashierId,
        clinic_id: orgId,
        full_name: 'Cashier User',
        role: 'CASHIER',
        is_active: 1,
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'user_organization_access',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        _local_id: uuidv4(),
        user_id: pharmacistId,
        organization_id: orgId,
        role: 'PHARMACIST',
        is_active: 1,
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'user_organization_access',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        _local_id: uuidv4(),
        user_id: cashierId,
        organization_id: orgId,
        role: 'CASHIER',
        is_active: 1,
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'user_store_access',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        _local_id: uuidv4(),
        user_id: pharmacistId,
        organization_id: orgId,
        store_id: storeAId,
        role: 'PHARMACIST',
        is_default: 1,
        is_active: 1,
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'user_store_access',
      operation: 'INSERT',
      data: {
        id: uuidv4(),
        _local_id: uuidv4(),
        user_id: cashierId,
        organization_id: orgId,
        store_id: storeAId,
        role: 'CASHIER',
        is_default: 1,
        is_active: 1,
        created_at: new Date().toISOString(),
      },
    });

    // 3. Setup Patient & Medicines
    localMutate({
      table: 'customers',
      operation: 'INSERT',
      data: {
        id: patientId,
        _local_id: patientId,
        organization_id: orgId,
        name: 'Rahul Sharma',
        phone: '9876543210',
        created_at: new Date().toISOString(),
      },
    });

    // Paracetamol (OTC)
    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: {
        id: medParacetamolId,
        _local_id: medParacetamolId,
        organization_id: orgId,
        name: 'Paracetamol 650mg',
        composition: 'Paracetamol 650 mg',
        gst_rate: 0,
        prescription_required: 0,
        is_schedule_h1: 0,
        schedule_classification: 'NONE',
        created_at: new Date().toISOString(),
      },
    });

    // Azithromycin (Rx Required)
    localMutate({
      table: 'medicines',
      operation: 'INSERT',
      data: {
        id: medAzithromycinId,
        _local_id: medAzithromycinId,
        organization_id: orgId,
        name: 'Azithromycin 500mg',
        composition: 'Azithromycin 500 mg',
        prescription_required: 1,
        is_schedule_h1: 1,
        schedule_classification: 'SCHEDULE_H1',
        created_at: new Date().toISOString(),
      },
    });

    // Batches
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchPara1Id,
        _local_id: batchPara1Id,
        organization_id: orgId,
        store_id: storeAId,
        medicine_id: medParacetamolId,
        batch_number: 'PARA-001',
        quantity_remaining: 100,
        mrp: 30,
        purchase_price: 20.0,
        expiry_date: futureDate,
        created_at: new Date().toISOString(),
      },
    });

    localMutate({
      table: 'medicine_batches',
      operation: 'INSERT',
      data: {
        id: batchAzithro1Id,
        _local_id: batchAzithro1Id,
        organization_id: orgId,
        store_id: storeAId,
        medicine_id: medAzithromycinId,
        batch_number: 'AZI-001',
        quantity_remaining: 100,
        mrp: 120,
        purchase_price: 80.0,
        expiry_date: futureDate,
        created_at: new Date().toISOString(),
      },
    });

    // 4. User Tokens
    pharmacistToken = jwt.sign(
      { sub: pharmacistId, id: pharmacistId, role: 'PHARMACIST', clinic_id: orgId, email: 'pharmacist@rx.test' },
      JWT_SECRET
    );

    cashierToken = jwt.sign(
      { sub: cashierId, id: cashierId, role: 'CASHIER', clinic_id: orgId, email: 'cashier@rx.test' },
      JWT_SECRET
    );
  });

  // ── 1. Doctor Master & Snapshot Retention ───────────────────
  describe('1. Doctor Master & Snapshot Preservation', () => {
    test('creates doctor master record and finds by registration number', () => {
      const regNum = `MCI-TEST-${Date.now()}`;
      const doc = DoctorService.createDoctor({
        organizationId: orgId,
        name: 'Dr. Vikram Seth',
        registrationNumber: regNum,
        specialization: 'Pulmonology',
        clinicHospital: 'Apollo Hospital',
      });

      expect(doc.name).toBe('Dr. Vikram Seth');
      expect(doc.registration_number).toBe(regNum);

      const found = DoctorService.findOrCreateByRegistration({
        organizationId: orgId,
        name: 'Dr. Vikram Seth Updated',
        registrationNumber: regNum,
      });

      expect(found.id || found._local_id).toBe(doc.id || doc._local_id);
    });

    test('retains doctor name and registration snapshots on prescription creation', () => {
      const { prescription } = PrescriptionService.createPrescription({
        organizationId: orgId,
        doctorName: 'Dr. Historical Snapshot',
        doctorRegistrationNumber: 'REG-HIST-100',
        documentUrl: 'prescriptions/hist.pdf',
        items: [{ raw_text: 'Tab Paracetamol 650mg', prescribed_name: 'Paracetamol 650mg', prescribed_quantity: 10 }],
      });

      expect(prescription.doctor_name_snapshot).toBe('Dr. Historical Snapshot');
      expect(prescription.doctor_registration_number_snapshot).toBe('REG-HIST-100');
    });
  });

  // ── 2. Document Storage, Validation & Duplicate Hash Warning ─────────────────
  describe('2. Document Storage, Validation & Duplicate Hash Warning', () => {
    test('validates MIME type, file size, extension and magic bytes', () => {
      const validPdfBuffer = Buffer.from('%PDF-1.4 header content here for valid magic bytes test');
      const valRes = PrescriptionStorageService.validateAndGenerateKey({
        fileName: 'rx_sample.pdf',
        mimeType: 'application/pdf',
        fileBuffer: validPdfBuffer,
        organizationId: orgId,
      });

      expect(valRes.isValid).toBe(true);
      expect(valRes.documentHash).toBeDefined();
      expect(valRes.storageKey).toMatch(/^prescriptions\//);

      const invalidMime = PrescriptionStorageService.validateAndGenerateKey({
        fileName: 'script.exe',
        mimeType: 'application/x-executable',
        fileBuffer: Buffer.from('test'),
        organizationId: orgId,
      });

      expect(invalidMime.isValid).toBe(false);
      expect(invalidMime.errorMessage).toContain('Unsupported MIME type');
    });

    test('warns when duplicate document hash is uploaded', () => {
      const docHash = 'hash_duplicate_12345';
      const rx1 = PrescriptionService.createPrescription({
        organizationId: orgId,
        doctorName: 'Dr. Hash',
        doctorRegistrationNumber: 'REG-HASH',
        documentUrl: 'prescriptions/hash1.pdf',
        documentHash: docHash,
      });
      expect(rx1.isDuplicateHashWarning).toBe(false);

      const rx2 = PrescriptionService.createPrescription({
        organizationId: orgId,
        doctorName: 'Dr. Hash 2',
        doctorRegistrationNumber: 'REG-HASH',
        documentUrl: 'prescriptions/hash2.pdf',
        documentHash: docHash,
      });
      expect(rx2.isDuplicateHashWarning).toBe(true);
    });
  });

  // ── 3. OCR / Candidate Extraction Architecture ────────────────
  describe('3. OCR / Candidate Extraction Architecture', () => {
    test('extracts structured candidate line items with confidence scores', () => {
      const extraction = PrescriptionExtractionService.extractCandidates({
        rawDocumentText: 'Rx: Tab Azithromycin 500mg 1-0-0 x 3 days',
      });

      expect(extraction.candidateLines.length).toBeGreaterThan(0);
      expect(extraction.overallConfidence).toBeGreaterThan(0);
      expect(extraction.isVerifiedTruth).toBe(false); // Compliance with OCR Safety Rule
    });
  });

  // ── 4. Pharmacist Verification Queue, Review & Rejection ────────────
  describe('4. Pharmacist Verification Queue, Review & Rejection', () => {
    let testRxId: string;

    test('creates prescription in NEEDS_REVIEW status and assigns to queue', () => {
      const { prescription } = PrescriptionService.createPrescription({
        organizationId: orgId,
        storeId: storeAId,
        patientId,
        doctorName: 'Dr. Queue Test',
        doctorRegistrationNumber: 'REG-QUEUE-100',
        documentUrl: 'prescriptions/q.pdf',
        items: [{ raw_text: 'Tab Azithromycin 500mg 1-0-0 x 3 days', prescribed_name: 'Azithromycin 500mg', matched_product_id: medAzithromycinId, prescribed_quantity: 5 }],
      });

      testRxId = prescription.id || prescription._local_id!;
      expect(prescription.status).toBe('NEEDS_REVIEW');
      expect(prescription.verification_status).toBe('UNVERIFIED');
    });

    test('pharmacist claims prescription queue item', () => {
      const claimed = PrescriptionService.claimPrescription({
        prescriptionId: testRxId,
        pharmacistId,
      });

      expect(claimed.assigned_to).toBe(pharmacistId);
      expect(claimed.verification_status).toBe('IN_REVIEW');
    });

    test('pharmacist verifies prescription item match and updates status', () => {
      const verified = PrescriptionService.verifyPrescription({
        prescriptionId: testRxId,
        verifiedBy: pharmacistId,
        itemUpdates: [{
          itemId: PrescriptionService.getPrescriptionById(testRxId)!.items![0].id!,
          matchedProductId: medAzithromycinId,
          prescribedQuantity: 5,
        }],
        notes: 'Verified against doctor registration database',
      });

      expect(verified.verification_status).toBe('VERIFIED');
      expect(verified.status).toBe('VERIFIED');
      expect(verified.verified_by).toBe(pharmacistId);
    });

    test('pharmacist rejects invalid prescription with structured reason', () => {
      const { prescription } = PrescriptionService.createPrescription({
        organizationId: orgId,
        doctorName: 'Dr. Blur',
        doctorRegistrationNumber: 'REG-BLUR',
        documentUrl: 'prescriptions/blur.pdf',
      });

      const pId = prescription.id || prescription._local_id!;
      const rejected = PrescriptionService.rejectPrescription({
        prescriptionId: pId,
        rejectedBy: pharmacistId,
        rejectionReason: 'UNREADABLE',
        notes: 'Image is completely blurry',
      });

      expect(rejected.status).toBe('REJECTED');
      expect(rejected.verification_status).toBe('REJECTED');
      expect(rejected.rejection_reason).toBe('UNREADABLE');
    });
  });

  // ── 5. Dispensing Engine, Limits & Partial Dispensing ──────────────
  describe('5. Dispensing Engine, Limits & Partial Dispensing', () => {
    let rxId: string;
    let rxItemId: string;

    beforeAll(() => {
      const { prescription } = PrescriptionService.createPrescription({
        organizationId: orgId,
        storeId: storeAId,
        patientId,
        doctorName: 'Dr. Dispense',
        doctorRegistrationNumber: 'REG-DISP-100',
        documentUrl: 'prescriptions/disp.pdf',
        items: [{ raw_text: 'Tab Azithromycin 500mg 1-0-0 x 30 days', prescribed_name: 'Azithromycin 500mg', matched_product_id: medAzithromycinId, prescribed_quantity: 30, repeats_authorized: 1 }],
      });

      rxId = prescription.id || prescription._local_id!;
      PrescriptionService.verifyPrescription({ prescriptionId: rxId, verifiedBy: pharmacistId });
      rxItemId = PrescriptionService.getPrescriptionById(rxId)!.items![0].id!;
    });

    test('allows partial dispensing of 10 tablets and updates status to PARTIALLY_DISPENSED', () => {
      const val = DispensingEngine.validateDispensing({
        prescriptionId: rxId,
        prescriptionItemId: rxItemId,
        requestedQuantity: 10,
      });

      expect(val.allowed).toBe(true);

      const event = DispensingEngine.recordDispensing({
        organizationId: orgId,
        storeId: storeAId,
        terminalId,
        prescriptionId: rxId,
        prescriptionItemId: rxItemId,
        productId: medAzithromycinId,
        batchId: batchAzithro1Id,
        quantityDispensed: 10,
        dispensedBy: pharmacistId,
      });

      expect(event.quantity_dispensed).toBe(10);
      const updatedRx = PrescriptionService.getPrescriptionById(rxId)!;
      expect(updatedRx.status).toBe('PARTIALLY_DISPENSED');
      expect(updatedRx.items![0].dispensed_quantity).toBe(10);
    });

    test('blocks over-dispensing beyond remaining allowed quantity', () => {
      // Total allowed = 30 * (1 + 1 repeat) = 60. Already dispensed: 10. Remaining: 50.
      const overVal = DispensingEngine.validateDispensing({
        prescriptionId: rxId,
        prescriptionItemId: rxItemId,
        requestedQuantity: 51,
      });

      expect(overVal.allowed).toBe(false);
      expect(overVal.errorMessage).toContain('Dispensing limit exceeded');

      expect(() => {
        DispensingEngine.recordDispensing({
          organizationId: orgId,
          storeId: storeAId,
          prescriptionId: rxId,
          prescriptionItemId: rxItemId,
          productId: medAzithromycinId,
          batchId: batchAzithro1Id,
          quantityDispensed: 51,
          dispensedBy: pharmacistId,
        });
      }).toThrow('Dispensing limit exceeded');
    });

    test('dispenses remaining 50 units and updates status to DISPENSED', () => {
      DispensingEngine.recordDispensing({
        organizationId: orgId,
        storeId: storeAId,
        prescriptionId: rxId,
        prescriptionItemId: rxItemId,
        productId: medAzithromycinId,
        batchId: batchAzithro1Id,
        quantityDispensed: 50,
        dispensedBy: pharmacistId,
      });

      const updatedRx = PrescriptionService.getPrescriptionById(rxId)!;
      expect(updatedRx.status).toBe('DISPENSED');
      expect(updatedRx.items![0].dispensed_quantity).toBe(60);

      // Verify Refill Eligibility transition to EXHAUSTED
      const refill = DispensingEngine.getRefillEligibility(rxId, rxItemId);
      expect(refill.status).toBe('EXHAUSTED');
    });
  });

  // ── 6. POS Prescription Gating Integration & Mixed Cart ─────────────
  describe('6. POS Prescription Gating Integration & Mixed Cart', () => {
    let verifiedRxId: string;

    beforeAll(() => {
      const { prescription } = PrescriptionService.createPrescription({
        organizationId: orgId,
        storeId: storeAId,
        patientId,
        doctorName: 'Dr. Gating Test',
        doctorRegistrationNumber: 'REG-GATE-100',
        documentUrl: 'prescriptions/gate.pdf',
        items: [{ raw_text: 'Tab Azithromycin 500mg x 5 days', prescribed_name: 'Azithromycin 500mg', matched_product_id: medAzithromycinId, prescribed_quantity: 5 }],
      });

      verifiedRxId = prescription.id || prescription._local_id!;
      PrescriptionService.verifyPrescription({ prescriptionId: verifiedRxId, verifiedBy: pharmacistId });
    });

    test('allows OTC product checkout without prescription requirement', async () => {
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', counterId)
        .set('x-terminal-id', terminalId)
        .send({
          items: [{ medicine_id: medParacetamolId, quantity: 2 }],
          payments: [{ tender_type: 'CASH', amount: 60 }],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.sale).toBeDefined();
    });

    test('blocks prescription-required medicine checkout when no verified prescription is supplied', async () => {
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', counterId)
        .set('x-terminal-id', terminalId)
        .send({
          items: [{ medicine_id: medAzithromycinId, quantity: 5 }],
          payments: [{ tender_type: 'CASH', amount: 600 }],
        });

      expect(res.status).toBe(400);
      const errMsg = typeof res.body.error === 'string' ? res.body.error : (res.body.error?.message || '');
      expect(errMsg).toContain('Verified prescription required');
    });

    test('allows Rx-required medicine checkout when valid verified prescription_id is supplied', async () => {
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', counterId)
        .set('x-terminal-id', terminalId)
        .send({
          prescription_id: verifiedRxId,
          customer_id: patientId,
          items: [{ medicine_id: medAzithromycinId, quantity: 5 }],
          payments: [{ tender_type: 'CASH', amount: 600 }],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.sale).toBeDefined();

      // Verify Dispensing Event was automatically created
      const history = DispensingEngine.getDispensingHistory(verifiedRxId);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].product_id).toBe(medAzithromycinId);
    });

    test('handles mixed cart with OTC items and verified Rx items cleanly', async () => {
      const { prescription: mixRx } = PrescriptionService.createPrescription({
        organizationId: orgId,
        storeId: storeAId,
        patientId,
        doctorName: 'Dr. Mixed',
        doctorRegistrationNumber: 'REG-MIX-100',
        documentUrl: 'prescriptions/mix.pdf',
        items: [{ raw_text: 'Tab Azithromycin 500mg x 3 days', prescribed_name: 'Azithromycin 500mg', matched_product_id: medAzithromycinId, prescribed_quantity: 3 }],
      });

      const mRxId = mixRx.id || mixRx._local_id!;
      PrescriptionService.verifyPrescription({ prescriptionId: mRxId, verifiedBy: pharmacistId });

      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', counterId)
        .set('x-terminal-id', terminalId)
        .send({
          prescription_id: mRxId,
          customer_id: patientId,
          items: [
            { medicine_id: medParacetamolId, quantity: 1 },
            { medicine_id: medAzithromycinId, quantity: 3 },
          ],
          payments: [{ tender_type: 'CASH', amount: 500 }],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.sale).toBeDefined();
    });
  });

  // ── 7. Pharmacy Safety: Allergy, Duplicate Ingredient & Drug Knowledge ─
  describe('7. Pharmacy Safety: Allergy, Duplicate Ingredient & Drug Knowledge', () => {
    test('records patient allergy and generates warning match during checking', () => {
      PatientAllergyService.recordAllergy({
        organizationId: orgId,
        patientId,
        allergen: 'Azithromycin',
        allergenType: 'INGREDIENT',
        severity: 'SEVERE',
      });

      const match = PatientAllergyService.checkAllergyMatch({
        patientId,
        medicineName: 'Azithromycin 500mg Tablet',
        composition: 'Azithromycin 500 mg',
      });

      expect(match.hasMatch).toBe(true);
      expect(match.matchedAllergen).toBe('Azithromycin');
      expect(match.warningMessage).toContain('Recorded allergy match — pharmacist review required');
    });

    test('flags potential duplicate active ingredient across cart lines', () => {
      const dupCheck = DuplicateIngredientGuard.checkDuplicateIngredients({
        cartItems: [
          { medicineName: 'Dolo 650', composition: 'Paracetamol 650mg' },
          { medicineName: 'Calpol 500', composition: 'Paracetamol 500mg' },
        ],
      });

      expect(dupCheck.hasDuplicate).toBe(true);
      expect(dupCheck.duplicateIngredient).toBe('PARACETAMOL');
      expect(dupCheck.warningMessage).toContain('Potential duplicate active ingredient');
    });

    test('returns DISABLED_NO_KNOWLEDGE_PROVIDER status when unconfigured', () => {
      const provider = new DefaultDrugKnowledgeProvider();
      expect(provider.status).toBe('DISABLED_NO_KNOWLEDGE_PROVIDER');
      expect(provider.getInteractions()).toEqual([]);
    });

    test('evaluates substitution policy and logs substitution event', () => {
      const evalRes = SubstitutionEngine.evaluateSubstitution({
        prescribedProductId: medParacetamolId,
        dispensedProductId: medAzithromycinId,
        substitutionAllowedOnRx: true,
      });

      expect(evalRes.isSubstitution).toBe(true);
      expect(evalRes.policyStatus).toBe('PHARMACIST_APPROVAL_REQUIRED');

      const subEvent = SubstitutionEngine.recordSubstitution({
        organizationId: orgId,
        prescriptionId: uuidv4(),
        prescriptionItemId: uuidv4(),
        prescribedProductId: medParacetamolId,
        prescribedName: 'Dolo 650',
        dispensedProductId: medAzithromycinId,
        dispensedName: 'Calpol 650',
        substitutedBy: pharmacistId,
        reason: 'Original brand out of stock',
        customerConfirmed: true,
      });

      expect(subEvent.prescribed_name).toBe('Dolo 650');
      expect(subEvent.dispensed_name).toBe('Calpol 650');
    });
  });

  // ── 8. Returns & Medication History Integration ──────────────────
  describe('8. Returns & Medication History Integration', () => {
    test('preserves historical dispensing events when sale return occurs', async () => {
      const { prescription: retRx } = PrescriptionService.createPrescription({
        organizationId: orgId,
        storeId: storeAId,
        patientId,
        doctorName: 'Dr. Ret',
        doctorRegistrationNumber: 'REG-RET',
        documentUrl: 'prescriptions/ret.pdf',
        items: [{ raw_text: 'Tab Azithromycin 500mg x 10', prescribed_name: 'Azithromycin 500mg', matched_product_id: medAzithromycinId, prescribed_quantity: 10 }],
      });

      const rRxId = retRx.id || retRx._local_id!;
      PrescriptionService.verifyPrescription({ prescriptionId: rRxId, verifiedBy: pharmacistId });

      // Checkout
      const chkRes = await request(app)
        .post('/api/pos/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('x-store-id', storeAId)
        .set('x-counter-id', counterId)
        .set('x-terminal-id', terminalId)
        .send({
          prescription_id: rRxId,
          customer_id: patientId,
          items: [{ medicine_id: medAzithromycinId, quantity: 10 }],
          payments: [{ tender_type: 'CASH', amount: 1200 }],
        });

      const sale = chkRes.body.data.sale;
      const saleItem = chkRes.body.data.items[0];

      // Process Return of 2 items
      const processRes = ReturnsEngine.processReturn({
        originalSaleId: sale.id || sale._local_id,
        items: [{
          sale_item_id: saleItem.id || saleItem._local_id,
          quantity: 2,
          reason_code: 'CUSTOMER_RETURN',
        }],
        refundMethod: 'CASH',
        organizationId: orgId,
        storeId: storeAId,
        performedBy: cashierId,
      });

      expect(processRes.creditNoteNumber).toBeDefined();

      // Verify dispensing events history remains intact (8 net physically retained, original 10 event preserved)
      const history = DispensingEngine.getDispensingHistory(rRxId);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].quantity_dispensed).toBe(10);
    });

    test('derives comprehensive patient medication history and active medications list', () => {
      const history = PatientMedicationHistoryService.getPatientHistory(patientId);
      expect(history.patientId).toBe(patientId);
      expect(history.allergies.length).toBeGreaterThan(0);
      expect(history.prescriptions.length).toBeGreaterThan(0);
      expect(history.dispensingTimeline.length).toBeGreaterThan(0);
      expect(history.activeMedications.length).toBeGreaterThan(0);
    });
  });
});
