export type Gstr1Item = {
  num: number;
  itm_det: {
    txval: number;
    rt: number;
    camt: number;
    samt: number;
  };
};

export type Gstr1B2BInvoice = {
  inum: string;
  idt: string;
  val: number;
  pos: string;
  rchrg: 'N';
  itms: Gstr1Item[];
};

export type Gstr1Payload = {
  gstin: string;
  fp: string;
  b2b: Array<{ ctin: string; inv: Gstr1B2BInvoice[] }>;
  b2cs: Array<{ sply_ty: 'INTRA' | 'INTER'; pos: string; rt: number; txval: number; camt: number; samt: number }>;
  hsn: {
    data: Array<{
      num: number;
      hsn_sc: string;
      desc: string;
      uqc: string;
      qty: number;
      val: number;
      txval: number;
      camt: number;
      samt: number;
    }>;
  };
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function filingPeriod(month: number, year: number): string {
  return `${pad2(month)}${year}`;
}

export function posFromGstin(gstin: string | null | undefined, fallback: string): string {
  if (gstin && /^[0-9]{2}/.test(gstin)) {
    return gstin.slice(0, 2);
  }
  return fallback;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type SaleRowForGstr1 = {
  invoice_number: string;
  sale_date: string;
  net_amount: number;
  customer_gstin: string | null;
  items: Array<{
    total: number;
    gst_rate: number;
    quantity: number;
    hsn_code: string | null;
    medicine_name: string;
  }>;
};

export function buildGstr1Payload(
  clinicGstin: string,
  month: number,
  year: number,
  sales: SaleRowForGstr1[]
): Gstr1Payload {
  const fp = filingPeriod(month, year);
  const defaultPos = posFromGstin(clinicGstin, '27');

  const b2bMap = new Map<string, Gstr1B2BInvoice[]>();
  const b2csMap = new Map<string, { pos: string; rt: number; txval: number; camt: number; samt: number }>();
  const hsnMap = new Map<
    string,
    { hsn_sc: string; desc: string; qty: number; val: number; txval: number; camt: number; samt: number }
  >();

  let hsnNum = 0;

  for (const sale of sales) {
    const idt = new Date(sale.sale_date);
    const idtStr = `${pad2(idt.getDate())}-${pad2(idt.getMonth() + 1)}-${idt.getFullYear()}`;
    const invBase = {
      inum: sale.invoice_number,
      idt: idtStr,
      pos: defaultPos,
      rchrg: 'N' as const,
    };

    let invVal = 0;
    const itms: Gstr1Item[] = [];
    let lineNum = 0;

    for (const line of sale.items) {
      const txval = round2(Number(line.total));
      const rt = Number(line.gst_rate);
      const gst = round2((txval * rt) / 100);
      const half = round2(gst / 2);
      lineNum += 1;
      itms.push({
        num: lineNum,
        itm_det: { txval, rt, camt: half, samt: half },
      });
      invVal = round2(invVal + txval + gst);

      const hsnKey = line.hsn_code || 'NA';
      const cur = hsnMap.get(hsnKey) || {
        hsn_sc: hsnKey === 'NA' ? '3004' : hsnKey,
        desc: line.medicine_name?.slice(0, 30) || 'Medicines',
        qty: 0,
        val: 0,
        txval: 0,
        camt: 0,
        samt: 0,
      };
      cur.qty += line.quantity;
      cur.val = round2(cur.val + txval + gst);
      cur.txval = round2(cur.txval + txval);
      cur.camt = round2(cur.camt + half);
      cur.samt = round2(cur.samt + half);
      hsnMap.set(hsnKey, cur);
    }

    const invoice: Gstr1B2BInvoice = {
      ...invBase,
      val: invVal,
      itms,
    };

    if (sale.customer_gstin && sale.customer_gstin.length >= 15) {
      const ctin = sale.customer_gstin.toUpperCase();
      const list = b2bMap.get(ctin) || [];
      list.push(invoice);
      b2bMap.set(ctin, list);
    } else {
      for (const line of sale.items) {
        const txval = round2(Number(line.total));
        const rt = Number(line.gst_rate);
        const gst = round2((txval * rt) / 100);
        const half = round2(gst / 2);
        const key = `${defaultPos}|${rt}`;
        const cur = b2csMap.get(key) || { pos: defaultPos, rt, txval: 0, camt: 0, samt: 0 };
        cur.txval = round2(cur.txval + txval);
        cur.camt = round2(cur.camt + half);
        cur.samt = round2(cur.samt + half);
        b2csMap.set(key, cur);
      }
    }
  }

  const b2b = Array.from(b2bMap.entries()).map(([ctin, inv]) => ({ ctin, inv }));
  const b2cs = Array.from(b2csMap.values()).map((row) => ({
    sply_ty: 'INTRA' as const,
    pos: row.pos,
    rt: row.rt,
    txval: row.txval,
    camt: row.camt,
    samt: row.samt,
  }));

  const hsnData = Array.from(hsnMap.values()).map((row) => {
    hsnNum += 1;
    return {
      num: hsnNum,
      hsn_sc: row.hsn_sc,
      desc: row.desc,
      uqc: 'NOS',
      qty: row.qty,
      val: row.val,
      txval: row.txval,
      camt: row.camt,
      samt: row.samt,
    };
  });

  return {
    gstin: clinicGstin || '',
    fp,
    b2b,
    b2cs,
    hsn: { data: hsnData },
  };
}
