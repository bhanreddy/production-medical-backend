const postgres = require('postgres');
const request = require('supertest');
const express = require('express');

// We will mock requireAuth middleware before importing app
const authModule = require('./src/middleware/auth');

const sql = postgres({
  host: 'aws-1-ap-south-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  username: 'postgres.mlbdrcdsalbrpcwyidqw',
  password: 'Dengeyr@p00ka',
  ssl: 'require',
  connect_timeout: 15,
});

async function main() {
  try {
    // Get a valid clinic and user from DB
    const [userRow] = await sql`SELECT id, clinic_id, role FROM users LIMIT 1`;
    if (!userRow) {
      console.error("No users found in database");
      return;
    }
    console.log("Using mock user:", userRow);

    // Mock requireAuth to bypass Supabase auth and inject our mock user
    authModule.requireAuth = (req, res, next) => {
      req.user = {
        id: userRow.id,
        clinic_id: userRow.clinic_id,
        role: userRow.role,
        email: 'mock-owner@example.com',
        isImpersonating: false
      };
      next();
    };

    // Also mock authenticateJWT in authenticateJWT.ts
    const authenticateJWTModule = require('./src/middleware/authenticateJWT');
    authenticateJWTModule.authenticateJWT = authModule.requireAuth;

    // Load createApp
    const { createApp } = require('./src/app');
    const app = createApp();

    console.log("\n=== Testing GET /api/reports/dashboard ===");
    const resDash = await request(app)
      .get('/api/reports/dashboard')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resDash.status);
    console.log("Body/Error:", JSON.stringify(resDash.body || resDash.text).slice(0, 1000));

    console.log("\n=== Testing GET /api/bills/recent ===");
    const resRecent = await request(app)
      .get('/api/bills/recent')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resRecent.status);
    console.log("Body/Error:", JSON.stringify(resRecent.body || resRecent.text).slice(0, 1000));

    console.log("\n=== Testing GET /api/reports/weekly ===");
    const resWeekly = await request(app)
      .get('/api/reports/weekly')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resWeekly.status);
    console.log("Body/Error:", JSON.stringify(resWeekly.body || resWeekly.text).slice(0, 1000));

    console.log("\n=== Testing GET /api/shortbook ===");
    const resShort = await request(app)
      .get('/api/shortbook')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resShort.status);
    console.log("Body/Error:", JSON.stringify(resShort.body || resShort.text).slice(0, 1000));

    console.log("\n=== Testing GET /api/clinics/me ===");
    const resClinic = await request(app)
      .get('/api/clinics/me')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resClinic.status);
    console.log("Body/Error:", JSON.stringify(resClinic.body || resClinic.text).slice(0, 1000));

    console.log("\n=== Testing GET /api/inventory ===");
    const resInv = await request(app)
      .get('/api/inventory')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resInv.status);
    console.log("Body/Error:", JSON.stringify(resInv.body || resInv.text).slice(0, 1000));

    console.log("\n=== Testing GET /api/inventory/summary ===");
    const resInvSum = await request(app)
      .get('/api/inventory/summary')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resInvSum.status);
    console.log("Body/Error:", JSON.stringify(resInvSum.body || resInvSum.text).slice(0, 1000));

    console.log("\n=== Testing GET /api/inventory/expiring ===");
    const resInvExp = await request(app)
      .get('/api/inventory/expiring')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resInvExp.status);
    console.log("Body/Error:", JSON.stringify(resInvExp.body || resInvExp.text).slice(0, 1000));

  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
