-- rls.sql
-- Enable RLS on all tables
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;

-- Note: The backend uses the service_role key which bypasses RLS.
-- These policies are defense-in-depth and enforce the invariant that all queries must be filtered by clinic_id.

-- Function to get current clinic_id from JWT
CREATE OR REPLACE FUNCTION auth.clinic_id() RETURNS UUID AS $$
  SELECT NULLIF(auth.jwt() ->> 'clinic_id', '')::UUID;
$$ LANGUAGE SQL STABLE;

-- Clinics: Users can only see their own clinic
CREATE POLICY "Clinics are viewable by users who belong to that clinic"
ON clinics FOR SELECT USING (id = auth.clinic_id());

-- Clinic Users: Can view users in the same clinic
CREATE POLICY "Users can view other users in the same clinic"
ON clinic_users FOR SELECT USING (clinic_id = auth.clinic_id());

-- Generic policies for all other tables
CREATE POLICY "Patients viewable by clinic" ON patients FOR ALL USING (clinic_id = auth.clinic_id());
CREATE POLICY "Categories viewable by clinic" ON categories FOR ALL USING (clinic_id = auth.clinic_id());
CREATE POLICY "Products viewable by clinic" ON products FOR ALL USING (clinic_id = auth.clinic_id());
CREATE POLICY "Inventory batches viewable by clinic" ON inventory_batches FOR ALL USING (clinic_id = auth.clinic_id());
CREATE POLICY "Inventory transactions viewable by clinic" ON inventory_transactions FOR ALL USING (clinic_id = auth.clinic_id());
CREATE POLICY "Invoices viewable by clinic" ON invoices FOR ALL USING (clinic_id = auth.clinic_id());
CREATE POLICY "Invoice items viewable by clinic" ON invoice_items FOR ALL USING (clinic_id = auth.clinic_id());
CREATE POLICY "Prescriptions viewable by clinic" ON prescriptions FOR ALL USING (clinic_id = auth.clinic_id());
