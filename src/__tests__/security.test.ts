import { validateUUID } from '../middleware/security';

describe('Security Middleware', () => {
  describe('validateUUID', () => {
    it('should accept valid UUID v4', () => {
      expect(validateUUID('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    });

    it('should accept valid UUID v4 with uppercase', () => {
      expect(validateUUID('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(validateUUID('')).toBe(false);
    });

    it('should reject random strings', () => {
      expect(validateUUID('not-a-uuid')).toBe(false);
    });

    it('should reject SQL injection attempts', () => {
      expect(validateUUID("'; DROP TABLE users; --")).toBe(false);
    });

    it('should reject partial UUIDs', () => {
      expect(validateUUID('f47ac10b-58cc-4372')).toBe(false);
    });
  });
});
