import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { AppError } from '../../lib/appError';
import { postgresQuery } from '../../lib/postgresDb';

export interface StorageValidationResult {
  isValid: boolean;
  errorMessage?: string;
  mimeType?: string;
  fileExtension?: string;
  documentHash?: string;
  storageKey?: string;
}

export class PrescriptionStorageService {
  static getRoot(): string {
    return path.resolve(process.env.PRESCRIPTION_STORAGE_PATH || path.join(path.dirname(process.env.LOCAL_DB_PATH || path.join(__dirname, '../../../local.db')), 'prescription-files'));
  }
  static resolveFile(storageKey: string): string {
    if (!/^prescriptions\/[a-zA-Z0-9_-]+\/\d{4}\/[a-f0-9-]+\.(pdf|png|jpe?g|webp)$/.test(storageKey)) {
      throw new AppError(400, 'Invalid prescription document key');
    }
    return path.join(this.getRoot(), storageKey);
  }
  static async save(storageKey: string, buffer: Buffer): Promise<void> {
    const target = this.resolveFile(storageKey);
    if (process.env.DURABLE_RUNTIME === 'postgres') {
      await postgresQuery('INSERT INTO app_prescription_documents(storage_key, content) VALUES ($1, $2)', [storageKey, buffer]);
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
  }
  static async remove(storageKey: string): Promise<void> {
    if (process.env.DURABLE_RUNTIME === 'postgres') {
      this.resolveFile(storageKey);
      await postgresQuery('DELETE FROM app_prescription_documents WHERE storage_key = $1', [storageKey]);
      return;
    }
    await fs.unlink(this.resolveFile(storageKey)).catch(() => {});
  }
  static async read(storageKey: string): Promise<Buffer> {
    const target = this.resolveFile(storageKey);
    if (process.env.DURABLE_RUNTIME === 'postgres') {
      const [document] = await postgresQuery<{ content: Buffer }>('SELECT content FROM app_prescription_documents WHERE storage_key = $1', [storageKey]);
      if (!document) throw new AppError(404, 'Prescription document is unavailable');
      return document.content;
    }
    try { return await fs.readFile(target); }
    catch { throw new AppError(404, 'Prescription document is unavailable'); }
  }
  private static ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/pdf',
  ]);

  private static ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
  private static MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

  static validateAndGenerateKey(params: {
    fileName: string;
    mimeType: string;
    fileBuffer: Buffer;
    organizationId: string;
  }): StorageValidationResult {
    const { fileName, mimeType, fileBuffer, organizationId } = params;

    // 1. File Size Check
    if (fileBuffer.length > this.MAX_FILE_SIZE_BYTES) {
      return {
        isValid: false,
        errorMessage: 'File size exceeds maximum allowed limit of 10MB',
      };
    }

    if (fileBuffer.length === 0) {
      return {
        isValid: false,
        errorMessage: 'File is empty',
      };
    }

    // 2. MIME Type Validation
    const cleanMime = mimeType.toLowerCase().trim();
    if (!this.ALLOWED_MIME_TYPES.has(cleanMime)) {
      return {
        isValid: false,
        errorMessage: `Unsupported MIME type '${mimeType}'. Allowed formats: JPG, PNG, WEBP, PDF`,
      };
    }

    // 3. Extension Validation
    const ext = path.extname(fileName).toLowerCase();
    if (!this.ALLOWED_EXTENSIONS.has(ext)) {
      return {
        isValid: false,
        errorMessage: `Unsafe file extension '${ext}'. Allowed extensions: .jpg, .jpeg, .png, .webp, .pdf`,
      };
    }

    // 4. File Signature Validation (Magic Bytes)
    const isMagicValid = this.verifyMagicBytes(fileBuffer, cleanMime);
    if (!isMagicValid) {
      return {
        isValid: false,
        errorMessage: 'File content header does not match declared MIME type or format signature',
      };
    }

    // 5. Compute SHA-256 Hash for duplicate detection
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // 6. Generate Unique Key (never use raw user filename)
    const year = new Date().getFullYear();
    const randomUuid = crypto.randomUUID();
    const storageKey = `prescriptions/${organizationId}/${year}/${randomUuid}${ext}`;

    return {
      isValid: true,
      mimeType: cleanMime,
      fileExtension: ext,
      documentHash: hash,
      storageKey,
    };
  }

  private static verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
    if (mimeType === 'application/pdf') {
      // %PDF header
      return buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === '%PDF';
    }
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      // 0xFF 0xD8
      return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
    }
    if (mimeType === 'image/png') {
      // 0x89 PNG header
      return (
        buffer.length >= 4 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      );
    }
    if (mimeType === 'image/webp') {
      // RIFF ... WEBP
      return (
        buffer.length >= 12 &&
        buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
        buffer.slice(8, 12).toString('ascii') === 'WEBP'
      );
    }
    return true;
  }

  static getAuthenticatedUrl(storageKey: string, expirySeconds: number = 3600): string {
    // Generates an authenticated proxy route URL
    return `/api/prescriptions/document/signed-proxy?key=${encodeURIComponent(storageKey)}&expires=${Date.now() + expirySeconds * 1000}`;
  }
}
