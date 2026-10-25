import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { PatientAllergy, SafetyWarningEvent, SubstitutionEvent, SubstitutionPolicy } from '../../domain/prescriptionTypes';
import { v4 as uuidv4 } from 'uuid';

export class PatientAllergyService {
  static recordAllergy(params: {
    organizationId: string;
    patientId: string;
    allergen: string;
    allergenType?: 'INGREDIENT' | 'DRUG_CLASS' | 'FOOD' | 'OTHER';
    reactionText?: string;
    severity?: 'MILD' | 'MODERATE' | 'SEVERE' | 'ANAPHYLAXIS';
    recordedBy?: string;
    source?: string;
  }): PatientAllergy {
    const id = uuidv4();
    const record = localMutate({
      table: 'patient_allergies',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: params.organizationId,
        patient_id: params.patientId,
        allergen: params.allergen.trim(),
        allergen_type: params.allergenType || 'INGREDIENT',
        reaction_text: params.reactionText || null,
        severity: params.severity || 'MODERATE',
        recorded_by: params.recordedBy || null,
        source: params.source || 'MANUAL_ENTRY',
        active: 1,
        created_at: new Date().toISOString(),
      },
    });

    return record as PatientAllergy;
  }

  static getPatientAllergies(patientId: string, organizationId?: string): PatientAllergy[] {
    const rows: any[] = localDb
      .prepare('SELECT * FROM patient_allergies WHERE patient_id = ? AND active = 1 AND _deleted = 0' + (organizationId ? ' AND organization_id = ?' : ''))
      .all(patientId, ...(organizationId ? [organizationId] : []));
    return rows as PatientAllergy[];
  }

  static checkAllergyMatch(params: {
    patientId: string;
    medicineName: string;
    composition?: string | null;
  }): { hasMatch: boolean; matchedAllergen?: string; warningMessage?: string } {
    const allergies = this.getPatientAllergies(params.patientId);
    if (allergies.length === 0) {
      return { hasMatch: false };
    }

    const medText = `${params.medicineName} ${params.composition || ''}`.toUpperCase();

    for (const alg of allergies) {
      const target = alg.allergen.toUpperCase().trim();
      if (target.length > 0 && medText.includes(target)) {
        return {
          hasMatch: true,
          matchedAllergen: alg.allergen,
          warningMessage: `Recorded allergy match — pharmacist review required: Patient has recorded allergy to '${alg.allergen}'`,
        };
      }
    }

    return { hasMatch: false };
  }
}

export class DuplicateIngredientGuard {
  static checkDuplicateIngredients(params: {
    cartItems: Array<{ medicineName: string; composition?: string | null }>;
  }): { hasDuplicate: boolean; duplicateIngredient?: string; warningMessage?: string } {
    const ingredientCounts = new Map<string, number>();

    params.cartItems.forEach((item) => {
      const comp = item.composition || item.medicineName;
      if (comp) {
        // Split by standard delimiters and strip numerical strengths (e.g. 650mg, 500 mg)
        const parts = comp
          .replace(/\d+\s*(mg|g|mcg|ml|iu|vial|ampoule|tablets?)/gi, '')
          .split(/[+/,\-]/)
          .map((p) => p.trim().toUpperCase())
          .filter((p) => p.length > 2);

        parts.forEach((ing) => {
          ingredientCounts.set(ing, (ingredientCounts.get(ing) || 0) + 1);
        });
      }
    });

    for (const [ing, count] of ingredientCounts.entries()) {
      if (count > 1) {
        return {
          hasDuplicate: true,
          duplicateIngredient: ing,
          warningMessage: `Potential duplicate active ingredient: '${ing}' is present in multiple cart items`,
        };
      }
    }

    return { hasDuplicate: false };
  }
}

export interface DrugKnowledgeProvider {
  status: 'DISABLED_NO_KNOWLEDGE_PROVIDER' | 'ENABLED';
  getInteractions(params: { productIds: string[] }): any[];
}

export class DefaultDrugKnowledgeProvider implements DrugKnowledgeProvider {
  status: 'DISABLED_NO_KNOWLEDGE_PROVIDER' = 'DISABLED_NO_KNOWLEDGE_PROVIDER';

  getInteractions(): any[] {
    // Complies with Trusted Knowledge Source Rule: Returns empty interactions list when no external provider is configured
    return [];
  }
}

export class SubstitutionEngine {
  static evaluateSubstitution(params: {
    prescribedProductId?: string | null;
    dispensedProductId: string;
    substitutionAllowedOnRx: boolean;
  }): { isSubstitution: boolean; policyStatus: SubstitutionPolicy } {
    const { prescribedProductId, dispensedProductId, substitutionAllowedOnRx } = params;

    if (!prescribedProductId || prescribedProductId === dispensedProductId) {
      return { isSubstitution: false, policyStatus: 'ALLOWED' };
    }

    if (!substitutionAllowedOnRx) {
      return { isSubstitution: true, policyStatus: 'NOT_ALLOWED' };
    }

    return { isSubstitution: true, policyStatus: 'PHARMACIST_APPROVAL_REQUIRED' };
  }

  static recordSubstitution(params: {
    organizationId: string;
    prescriptionId: string;
    prescriptionItemId: string;
    saleId?: string | null;
    prescribedProductId?: string | null;
    prescribedName: string;
    dispensedProductId: string;
    dispensedName: string;
    substitutedBy: string;
    reason: string;
    customerConfirmed?: boolean;
    doctorConfirmed?: boolean;
  }): SubstitutionEvent {
    const id = uuidv4();
    const record = localMutate({
      table: 'substitution_events',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: params.organizationId,
        prescription_id: params.prescriptionId,
        prescription_item_id: params.prescriptionItemId,
        sale_id: params.saleId || null,
        prescribed_product_id: params.prescribedProductId || null,
        prescribed_name: params.prescribedName,
        dispensed_product_id: params.dispensedProductId,
        dispensed_name: params.dispensedName,
        substituted_by: params.substitutedBy,
        reason: params.reason,
        customer_confirmed: params.customerConfirmed ? 1 : 0,
        doctor_confirmed: params.doctorConfirmed ? 1 : 0,
        created_at: new Date().toISOString(),
      },
    });

    return record as SubstitutionEvent;
  }
}
