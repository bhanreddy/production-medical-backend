import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';

const mockSingle = jest.fn();
jest.mock('../config/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ single: mockSingle }) }) }),
  },
}));
import { refresh } from '../controllers/auth.controller';

function response() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    cookie: jest.fn().mockReturnThis(),
  };
  return res;
}
function token(extra = {}) {
  return jwt.sign(
    {
      sub: 'operator',
      clinic_id: 'old-store',
      role: 'OWNER',
      plan: 'trial',
      ...extra,
    },
    process.env.JWT_REFRESH_SECRET ||
      process.env.JWT_SECRET ||
      'fallback_secret_do_not_use_in_prod',
    { expiresIn: '30d' },
  );
}
beforeEach(() => jest.clearAllMocks());

test('a database outage keeps the refresh credential valid and returns a retryable response', async () => {
  mockSingle.mockResolvedValue({
    data: null,
    error: { code: 'PGRST000', message: 'Connection failed' },
  });
  const res = response();
  await refresh(
    { body: { refreshToken: token() } } as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.cookie).not.toHaveBeenCalled();
});
test('a thrown transport error is not reported as invalid credentials', async () => {
  mockSingle.mockRejectedValue(new Error('Network down'));
  const res = response();
  await refresh(
    { body: { refreshToken: token() } } as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(503);
});
test('renewal retains short-lived access tokens and uses the current role/store', async () => {
  mockSingle.mockResolvedValue({
    data: { id: 'operator', clinic_id: 'current-store', role: 'CASHIER' },
    error: null,
  });
  const res = response();
  await refresh(
    { body: { refreshToken: token() } } as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(200);
  const data = res.json.mock.calls[0][0].data;
  const claims = jwt.verify(
    data.accessToken,
    process.env.JWT_SECRET || 'fallback_secret_do_not_use_in_prod',
  ) as jwt.JwtPayload;
  expect(claims.role).toBe('CASHIER');
  expect(claims.clinic_id).toBe('current-store');
  expect(claims.exp! - claims.iat!).toBe(900);
  expect(data.refreshToken).toBeTruthy();
});
test('an invalid refresh token is still rejected, without any user query', async () => {
  const res = response();
  await refresh(
    { body: { refreshToken: 'invalid-token' } } as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(401);
  expect(mockSingle).not.toHaveBeenCalled();
});
test('a deleted account cannot renew its credentials', async () => {
  mockSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
  const res = response();
  await refresh(
    { body: { refreshToken: token() } } as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(401);
});

test('the mobile refresh credential takes precedence over a stale browser cookie', async () => {
  mockSingle.mockResolvedValue({
    data: { id: 'operator', clinic_id: 'store', role: 'CASHIER' },
    error: null,
  });
  const res = response();
  await refresh(
    {
      body: { refreshToken: token() },
      cookies: { refreshToken: 'stale-cookie' },
    } as unknown as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(200);
});
test('a missing refresh credential is rejected cleanly', async () => {
  const res = response();
  await refresh({} as Request, res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(mockSingle).not.toHaveBeenCalled();
});
test('expired refresh credentials still cannot renew server access', async () => {
  const expired = jwt.sign(
    { sub: 'operator' },
    process.env.JWT_REFRESH_SECRET ||
      process.env.JWT_SECRET ||
      'fallback_secret_do_not_use_in_prod',
    { expiresIn: -1 },
  );
  const res = response();
  await refresh(
    { body: { refreshToken: expired } } as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(401);
  expect(mockSingle).not.toHaveBeenCalled();
});
