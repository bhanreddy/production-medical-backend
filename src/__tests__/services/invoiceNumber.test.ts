import { generateInvoiceNumber } from '../../services/invoiceNumber';
import { supabaseAdmin } from '../../config/supabase';

jest.mock('../../config/supabase', () => ({
  supabaseAdmin: {
    rpc: jest.fn(),
    from: jest.fn(),
  },
}));

describe('generateInvoiceNumber', () => {
  const clinicId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses RPC sequence when available — format CLI-YYYYMMDD-0001', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: 1, error: null });
    const n = await generateInvoiceNumber(clinicId);
    const ymd = new Date().toISOString().split('T')[0].replace(/-/g, '');
    expect(n).toBe(`CLI-${ymd}-0001`);
    expect(supabaseAdmin.rpc).toHaveBeenCalled();
  });

  test('increments appear as separate RPC values', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValueOnce({ data: 2, error: null });
    const n = await generateInvoiceNumber(clinicId);
    expect(n.endsWith('-0002')).toBe(true);
  });

  test('concurrent RPC calls receive distinct sequences (mocked)', async () => {
    let seq = 0;
    (supabaseAdmin.rpc as jest.Mock).mockImplementation(async () => {
      seq += 1;
      return { data: seq, error: null };
    });
    const nums = await Promise.all([
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
      generateInvoiceNumber(clinicId),
    ]);
    expect(new Set(nums).size).toBe(10);
  });

  test('falls back to max query when RPC missing', async () => {
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'no function' } });
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      like: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
    };
    (supabaseAdmin.from as jest.Mock).mockReturnValue(chain);
    const n = await generateInvoiceNumber(clinicId);
    expect(n).toMatch(/^CLI-\d{8}-\d{4}$/);
  });
});
