import express from "express";
import request from "supertest";
const mockLimit = jest.fn();
const originalDatabaseUrl = process.env.DATABASE_URL;
beforeAll(() => { delete process.env.DATABASE_URL; });
afterAll(() => { if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl; });
jest.mock("../config/supabase", () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ limit: mockLimit }) }) },
}));
import { healthRouter } from "../routes/health";
const app = express();
app.use("/health", healthRouter);
test("returned database errors report a degraded health state", async () => {
  mockLimit.mockResolvedValue({ error: { message: "Offline" } });
  const response = await request(app).get("/health");
  expect(response.body.status).toBe("degraded");
  expect(response.body.db.status).toBe("disconnected");
});
test("healthy responses report a connected database", async () => {
  mockLimit.mockResolvedValue({ error: null });
  expect((await request(app).get("/health")).body.db.status).toBe("connected");
});
