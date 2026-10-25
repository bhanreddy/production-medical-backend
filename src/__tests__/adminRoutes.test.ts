import express from "express";
import request from "supertest";
const mockResult = { data: null as unknown, error: null as unknown, count: 0 };
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockQuery: any = {};
for (const name of ["select", "eq", "order", "limit", "single", "maybeSingle"])
  mockQuery[name] = jest.fn(() => mockQuery);
mockQuery.insert = mockInsert.mockImplementation(() => mockQuery);
mockQuery.update = mockUpdate.mockImplementation(() => mockQuery);
mockQuery.then = (resolve: (value: unknown) => unknown) =>
  Promise.resolve(mockResult).then(resolve);
jest.mock("../config/supabase", () => ({
  supabaseAdmin: { from: () => mockQuery },
}));
jest.mock("../middleware/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.headers["x-test-role"])
      return res.status(401).json({ error: "Sign in" });
    req.user = { id: "test", role: req.headers["x-test-role"] };
    next();
  },
}));
import { adminRouter } from "../routes/admin";
import { errorHandler } from "../middleware/errorHandler";
const app = express();
app.use(express.json());
app.use("/admin", adminRouter);
app.use(errorHandler);
const clinicId = "da000000-0000-4000-8000-000000000001";
beforeEach(() => {
  mockResult.data = [];
  mockResult.error = null;
  mockResult.count = 4;
  jest.clearAllMocks();
});
test("administrative routes reject anonymous and clinic owners", async () => {
  expect((await request(app).get("/admin/stats")).status).toBe(401);
  expect(
    (await request(app).get("/admin/clinics").set("x-test-role", "OWNER"))
      .status,
  ).toBe(403);
  expect(mockInsert).not.toHaveBeenCalled();
});
test("statistics handle all plan categories", async () => {
  mockResult.data = [
    { plan: "trial", is_active: true },
    { plan: "pro", is_active: false },
    { plan: null, is_active: true },
  ];
  const response = await request(app)
    .get("/admin/stats")
    .set("x-test-role", "SUPER_ADMIN");
  expect(response.status).toBe(200);
  expect(response.body.total_clinics).toBe(3);
  expect(response.body.active_clinics).toBe(2);
  expect(response.body.paid_clinics).toBe(1);
});
test("clinic creation validates input and supplies the mandatory unique slug", async () => {
  expect(
    (
      await request(app)
        .post("/admin/clinics")
        .set("x-test-role", "SUPER_ADMIN")
        .send({ name: "" })
    ).status,
  ).toBe(400);
  mockResult.data = { id: clinicId, name: "QA Clinic" };
  expect(
    (
      await request(app)
        .post("/admin/clinics")
        .set("x-test-role", "SUPER_ADMIN")
        .send({ name: "QA Clinic" })
    ).status,
  ).toBe(201);
  expect(mockInsert).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "QA Clinic",
      slug: expect.stringMatching(/^qa-clinic-[a-f0-9]{8}$/),
      plan: "trial",
    }),
  );
});
test("profile lookup validates IDs and reports missing clinics", async () => {
  expect(
    (
      await request(app)
        .get("/admin/clinics/not-a-uuid/profile")
        .set("x-test-role", "SUPER_ADMIN")
    ).status,
  ).toBe(400);
  mockResult.data = null;
  expect(
    (
      await request(app)
        .get(`/admin/clinics/${clinicId}/profile`)
        .set("x-test-role", "SUPER_ADMIN")
    ).status,
  ).toBe(404);
});
test("profile updates can remove image assets and status updates require booleans", async () => {
  mockResult.data = { id: clinicId };
  expect(
    (
      await request(app)
        .put(`/admin/clinics/${clinicId}/profile`)
        .set("x-test-role", "SUPER_ADMIN")
        .send({ name: "QA", logo_url: null })
    ).status,
  ).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith({ name: "QA", logo_url: null });
  expect(
    (
      await request(app)
        .patch(`/admin/clinics/${clinicId}/status`)
        .set("x-test-role", "SUPER_ADMIN")
        .send({ is_active: "true" })
    ).status,
  ).toBe(400);
});
test("database failures propagate as failures instead of empty success responses", async () => {
  mockResult.error = new Error("Unavailable");
  expect(
    (await request(app).get("/admin/users").set("x-test-role", "SUPER_ADMIN"))
      .status,
  ).toBe(500);
});
