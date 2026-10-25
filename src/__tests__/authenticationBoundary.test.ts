import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'crypto';
const mockGetUser = jest.fn();
const mockProfile = { data:null as any, error:null as any };
const mockLocal = { current:null as any };
const mockQuery:any = {};
for (const name of ['select','eq']) mockQuery[name] = jest.fn(() => mockQuery);
mockQuery.single = jest.fn(async () => mockProfile);
jest.mock('../config/supabase', () => ({ supabaseAdmin:{ auth:{ getUser:(...args:unknown[]) => mockGetUser(...args) },from:jest.fn(() => mockQuery) } }));
jest.mock('../local-db', () => ({ localDb:{ prepare:() => ({ get:() => mockLocal.current }) } }));
jest.mock('../services/cloudPosDirectory', () => ({ ensureCloudPosDirectory:jest.fn(async () => 'organization') }));
import { requireAuth } from '../middleware/auth';
import { resetSupabaseIdentityCache } from '../lib/supabaseIdentity';
const app = express(); app.get('/protected',requireAuth,(req,res) => res.json(req.user));
const secret = 'isolated-auth-boundary-test-secret';
const originalSecret = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET=secret; });
afterAll(() => { if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret; });
beforeEach(() => { resetSupabaseIdentityCache(); mockQuery.single.mockClear(); mockGetUser.mockReset(); mockLocal.current=null; mockProfile.data=null; mockProfile.error=null;
 mockGetUser.mockResolvedValue({data:{user:{id:'operator',email:'qa@example.invalid',user_metadata:{}}},error:null});
});
test('anonymous requests are rejected', async () => { expect((await request(app).get('/protected')).status).toBe(401); expect(mockGetUser).not.toHaveBeenCalled(); });
test('a stale role or clinic JWT claim cannot override the current account directory', async () => {
 mockLocal.current={id:'operator',clinic_id:'clinic-current',role:'OWNER'};
 const token=jwt.sign({sub:'operator',clinic_id:'clinic-old',role:'SUPER_ADMIN'},secret);
 const response=await request(app).get('/protected').set('Authorization',`Bearer ${token}`).set('x-impersonate-clinic','clinic-other');
 expect(response.status).toBe(200); expect(response.body.role).toBe('OWNER');expect(response.body.clinic_id).toBe('clinic-current');expect(response.body.isImpersonating).toBe(false);
});
test('unconfigured cloud profiles do not silently create or grant an OWNER account', async () => {
 mockProfile.error={code:'PGRST116'};
 const response=await request(app).get('/protected').set('Authorization','Bearer supabase-test');
 expect(response.status).toBe(403);expect(response.body.error.code).toBe('PROFILE_NOT_CONFIGURED');
});
test('cloud authentication and profile outages report retryable failure', async () => {
 mockGetUser.mockResolvedValueOnce({data:{user:null},error:{status:503,message:'Temporary outage'}});
 expect((await request(app).get('/protected').set('Authorization','Bearer supabase-test')).status).toBe(503);
 mockProfile.error={code:'NETWORK_ERROR'};
 expect((await request(app).get('/protected').set('Authorization','Bearer supabase-test')).status).toBe(503);
});
test('current cloud roles authenticate and SUPER_ADMIN impersonation remains request-scoped', async () => {
 mockProfile.data={clinic_id:'clinic-current',role:'SUPER_ADMIN',full_name:'QA Admin'};
 const first=await request(app).get('/protected').set('Authorization','Bearer supabase-test').set('x-impersonate-clinic','clinic-other');
 const second=await request(app).get('/protected').set('Authorization','Bearer supabase-test');
 expect(first.body.clinic_id).toBe('clinic-other'); expect(first.body.isImpersonating).toBe(true); expect(second.body.clinic_id).toBe('clinic-current');expect(second.body.isImpersonating).toBe(false);
});
const session = (claims:object = {}, key:any = process.env.SUPABASE_JWT_SECRET, options:jwt.SignOptions = {}) =>
 jwt.sign({sub:'operator',role:'authenticated',aud:'authenticated',email:'qa@example.invalid',exp:Math.floor(Date.now()/1000)+3600,...claims},key,options);
test('signed Supabase sessions are verified in-process and share one profile lookup', async () => {
 mockProfile.data={clinic_id:'clinic-current',role:'OWNER',full_name:'QA Owner'};
 const token=session();
 const responses=await Promise.all([1,2,3].map(() => request(app).get('/protected').set('Authorization',`Bearer ${token}`)));
 expect(responses.map(r => r.status)).toEqual([200,200,200]);
 expect(responses[0].body).toMatchObject({id:'operator',email:'qa@example.invalid',role:'OWNER',clinic_id:'clinic-current'});
 expect(mockGetUser).not.toHaveBeenCalled(); expect(mockQuery.single).toHaveBeenCalledTimes(1);
});
test('asymmetric Supabase sessions are verified with the published signing keys', async () => {
 const { privateKey, publicKey } = generateKeyPairSync('ec',{namedCurve:'P-256'});
 const keys=[{...publicKey.export({format:'jwk'}),kid:'signing-key',alg:'ES256',use:'sig'}];
 const fetchMock=jest.spyOn(globalThis,'fetch').mockImplementation(async () => new Response(JSON.stringify({keys})));
 try {
  mockProfile.data={clinic_id:'clinic-current',role:'PHARMACIST',full_name:null};
  const token=session({},privateKey,{algorithm:'ES256',keyid:'signing-key'});
  for (let i=0;i<2;i++) { const response=await request(app).get('/protected').set('Authorization',`Bearer ${token}`); expect(response.status).toBe(200); expect(response.body.role).toBe('PHARMACIST'); }
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toBe(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
 } finally { fetchMock.mockRestore(); }
});
test('API keys, expired sessions and foreign signatures are still decided by Supabase Auth', async () => {
 mockGetUser.mockResolvedValue({data:{user:null},error:{status:401,message:'invalid JWT'}});
 const secret=process.env.SUPABASE_JWT_SECRET!;
 const tokens=[jwt.sign({role:'anon',iss:'supabase'},secret), jwt.sign({role:'service_role',iss:'supabase'},secret),
  session({exp:Math.floor(Date.now()/1000)-60}), session({},'not-the-project-secret')];
 for (const token of tokens) expect((await request(app).get('/protected').set('Authorization',`Bearer ${token}`)).status).toBe(401);
 expect(mockGetUser).toHaveBeenCalledTimes(tokens.length);
});
