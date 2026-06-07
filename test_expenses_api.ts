import postgres from 'postgres';
import request from 'supertest';

// 1. Mock requireAuth BEFORE importing app
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
    console.log("Using mock user clinic_id:", userRow.clinic_id);

    // Override requireAuth middleware implementation
    authModule.requireAuth = (req: any, res: any, next: any) => {
      req.user = {
        id: userRow.id,
        clinic_id: userRow.clinic_id,
        role: userRow.role,
        email: 'mock-owner@example.com',
        isImpersonating: false
      };
      next();
    };

    // Override authenticateJWT just in case it is used
    try {
      const authenticateJWTModule = require('./src/middleware/authenticateJWT');
      authenticateJWTModule.authenticateJWT = authModule.requireAuth;
    } catch (e) {
      // ignore if not present
    }

    // 2. Load createApp dynamically AFTER mocking
    const { createApp } = require('./src/app');
    const app = createApp();

    console.log("\n=== Testing GET /api/expenses (Normal Clinic) ===");
    const resExp = await request(app)
      .get('/api/expenses')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resExp.status);
    console.log("Returned expenses count:", resExp.body?.data?.length);
    console.log("Data snippet:", JSON.stringify(resExp.body?.data).slice(0, 1000));

    console.log("\n=== Testing GET /api/expenses/summary (Normal Clinic) ===");
    const resSummary = await request(app)
      .get('/api/expenses/summary')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status:", resSummary.status);
    console.log("Returned summary:", JSON.stringify(resSummary.body?.data));

    // Test with a dummy clinic_id to verify tenant isolation
    console.log("\n=== Testing tenant isolation: Mocking foreign clinic ===");
    authModule.requireAuth = (req: any, res: any, next: any) => {
      req.user = {
        id: userRow.id,
        clinic_id: 'd9999999-9999-9999-9999-999999999999', // foreign/non-existent clinic
        role: userRow.role,
        email: 'mock-owner@example.com',
        isImpersonating: false
      };
      next();
    };

    const resForeignExp = await request(app)
      .get('/api/expenses')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status with foreign clinic:", resForeignExp.status);
    console.log("Returned expenses count with foreign clinic:", resForeignExp.body?.data?.length);

    const resForeignSummary = await request(app)
      .get('/api/expenses/summary')
      .set('Authorization', 'Bearer dummy-token');
    
    console.log("Status with foreign clinic:", resForeignSummary.status);
    console.log("Returned summary with foreign clinic grand_total:", resForeignSummary.body?.data?.grand_total);

  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
    process.exit(0);
  }
}

main();
