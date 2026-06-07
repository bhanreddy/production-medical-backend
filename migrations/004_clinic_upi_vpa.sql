-- Store merchant UPI VPA on clinic for billing QR generation
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS upi_vpa TEXT;
