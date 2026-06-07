import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';

export const publicRouter = Router();

// GET /public/invoice/:sale_id
// No auth required, explicitly returns an HTML invoice given the UUID.
// Will add caching headers for 24 hours.
publicRouter.get('/invoice/:sale_id', async (req, res, next) => {
  try {
    const saleId = req.params.sale_id;

    const { data: sale, error } = await supabaseAdmin
      .from('sales')
      .select('*, customers(*), sale_items(*, medicines(name, hsn_code), medicine_batches(batch_number, expiry_date))')
      .eq('id', saleId)
      .single();

    if (error || !sale) {
      return res.status(404).send('<h1>Invoice Not Found</h1>');
    }

    const { data: clinic } = await supabaseAdmin
      .from('clinics')
      .select('*')
      .eq('id', sale.clinic_id)
      .single();

    // Cache headers: Cache-Control: public, max-age=86400
    res.setHeader('Cache-Control', 'public, max-age=86400');

    // Return the HTML Invoice
    const html = `
      <html>
        <head>
          <style>
            body { font-family: 'Helvetica', sans-serif; padding: 20px; max-width: 800px; margin: auto; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
            .right { text-align: right; }
            .header-info { margin-bottom: 20px; }
            .total-row th { background-color: #f8f9fa; }
          </style>
        </head>
        <body>
          <div class="header-info">
            <h2>${clinic?.name || 'Clinic'}</h2>
            <p>${clinic?.address || ''}<br/>
            <strong>GSTIN:</strong> ${clinic?.gstin || 'N/A'}<br/>
            <strong>DL No:</strong> ${clinic?.drug_licence_number || 'N/A'}</p>
          </div>
          <hr />
          <h3>Invoice #${sale.invoice_number}</h3>
          <p>
             <strong>Date:</strong> ${new Date(sale.sale_date).toLocaleString()}<br/>
             <strong>Customer:</strong> ${sale.customers?.name || 'Walk-in'}
          </p>
          <table>
             <thead>
               <tr>
                 <th>Item</th>
                 <th>Batch / Exp</th>
                 <th>Qty</th>
                 <th class="right">MRP</th>
                 <th class="right">Total</th>
               </tr>
             </thead>
             <tbody>
             ${sale.sale_items.map((i: any) => `
                <tr>
                  <td>${i.medicines?.name}</td>
                  <td>${i.medicine_batches?.batch_number} / ${new Date(i.medicine_batches?.expiry_date).toISOString().substring(0, 7)}</td>
                  <td>${i.quantity}</td>
                  <td class="right">${Number(i.mrp).toFixed(2)}</td>
                  <td class="right">${Number(i.total).toFixed(2)}</td>
                </tr>
             `).join('')}
             </tbody>
             <tfoot>
               <tr class="total-row"><th colspan="4" class="right">Subtotal</th><th class="right">${Number(sale.subtotal).toFixed(2)}</th></tr>
               <tr class="total-row"><th colspan="4" class="right">Discount</th><th class="right">${Number(sale.discount).toFixed(2)}</th></tr>
               <tr class="total-row"><th colspan="4" class="right">GST</th><th class="right">${Number(sale.gst_amount).toFixed(2)}</th></tr>
               <tr class="total-row"><th colspan="4" class="right"><strong>Grand Total</strong></th><th class="right"><strong>${Number(sale.net_amount).toFixed(2)}</strong></th></tr>
             </tfoot>
          </table>
          <p style="margin-top:40px; font-size:12px; color: #555; text-align: center;">${clinic?.invoice_footer || ''}</p>
        </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    next(err);
  }
});
