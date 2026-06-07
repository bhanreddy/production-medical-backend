import dotenv from 'dotenv';
dotenv.config();

import sql from '../db';

async function run() {
  try {
    console.log('Creating database indexes...');
    await sql`CREATE INDEX IF NOT EXISTS idx_sales_clinic_created ON sales(clinic_id, created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_purchases_clinic_created ON purchases(clinic_id, created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_medicines_clinic_id ON medicines(clinic_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_medicine_batches_medicine_id ON medicine_batches(medicine_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_expenses_clinic_created ON expenses(clinic_id, created_at DESC);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_customers_clinic_id ON customers(clinic_id);`;
    console.log('Indexes created successfully!');
  } catch (err) {
    console.error('Error creating indexes:', err);
  } finally {
    await sql.end();
  }
}

run();
