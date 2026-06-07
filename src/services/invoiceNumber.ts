import { supabaseAdmin } from '../config/supabase';

function yyyymmdd(d: Date): string {
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

function dayDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export async function generateInvoiceNumber(clinicId: string): Promise<string> {
  const today = new Date();
  const prefix = `CLI-${yyyymmdd(today)}`;
  const pDay = dayDateStr(today);

  const { data: seqRaw, error: rpcErr } = await supabaseAdmin.rpc('next_clinic_invoice_seq', {
    p_clinic_id: clinicId,
    p_day: pDay,
  });

  const seq =
    typeof seqRaw === 'number'
      ? seqRaw
      : Array.isArray(seqRaw) && typeof seqRaw[0] === 'number'
        ? seqRaw[0]
        : seqRaw != null && !Number.isNaN(Number(seqRaw))
          ? Number(seqRaw)
          : null;

  if (!rpcErr && seq != null) {
    return `${prefix}-${String(seq).padStart(4, '0')}`;
  }

  const { data: sales, error } = await supabaseAdmin
    .from('sales')
    .select('invoice_number')
    .eq('clinic_id', clinicId)
    .like('invoice_number', `${prefix}-%`)
    .order('invoice_number', { ascending: false })
    .limit(1);

  if (error) throw error;

  let nextSequence = 1;
  if (sales && sales.length > 0) {
    const lastInvoiceNumber = sales[0].invoice_number;
    const parts = lastInvoiceNumber.split('-');
    if (parts.length === 3) {
      const sequence = parseInt(parts[2], 10);
      if (!Number.isNaN(sequence)) {
        nextSequence = sequence + 1;
      }
    }
  }

  return `${prefix}-${String(nextSequence).padStart(4, '0')}`;
}
