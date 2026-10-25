import { ExtractedCandidate } from '../../domain/prescriptionTypes';

export interface ExtractionResult {
  prescriptionNumberCandidate?: string;
  doctorNameCandidate?: string;
  doctorRegistrationCandidate?: string;
  prescribedAtCandidate?: string;
  candidateLines: ExtractedCandidate[];
  overallConfidence: number;
  isVerifiedTruth: false; // Always false — OCR Safety Rule: output is never verified truth until pharmacist confirms
}

export class PrescriptionExtractionService {
  /**
   * Conceptual extraction boundary.
   * Parses structured candidate line items from raw OCR text or document metadata.
   */
  static extractCandidates(params: {
    rawDocumentText?: string;
    documentUrl?: string;
    mimeType?: string;
  }): ExtractionResult {
    const rawText = params.rawDocumentText || '';

    // If raw text is provided, perform basic pattern parsing
    const candidateLines: ExtractedCandidate[] = [];

    if (rawText.length > 0) {
      const lines = rawText.split('\n').filter((l) => l.trim().length > 0);
      lines.forEach((lineText, idx) => {
        const clean = lineText.trim();
        if (clean.toLowerCase().startsWith('rx:') || clean.toLowerCase().startsWith('tab') || clean.toLowerCase().startsWith('cap') || clean.toLowerCase().startsWith('syrup')) {
          candidateLines.push({
            raw_text: clean,
            prescribed_name: clean,
            confidence: 0.5,
          });
        }
      });
    }


    return {
      candidateLines,
      overallConfidence: candidateLines.length ? 0.5 : 0,
      isVerifiedTruth: false, // Critical OCR Safety Rule compliance
    };
  }
}
