import type { Request, Response } from 'express';
const mockSignup = jest.fn(), mockDelete = jest.fn();
const mockSql: any = jest.fn();
mockSql.begin = jest.fn();
jest.mock('../db', () => ({ __esModule: true, default: (...args: unknown[]) => mockSql(...args) }));
// Keep the transaction property on the callable exported by the module.
jest.mock('../config/supabase', () => ({supabaseAdmin:{auth:{admin:{deleteUser:(...args:unknown[])=>mockDelete(...args)}}}}));
jest.mock('@supabase/supabase-js', () => ({createClient: () => ({auth:{signUp:(...args:unknown[])=>mockSignup(...args)}})}));
import sql from '../db';
import { register, login } from '../controllers/auth.controller';
(sql as any).begin = (...args: unknown[]) => mockSql.begin(...args);
const input={email:'qa@example.invalid',password:'local-test-password',full_name:'QA Owner',clinic_name:'QA Pharmacy',phone:'9876543210'};
function response() { return {status:jest.fn().mockReturnThis(),json:jest.fn().mockReturnThis()}; }
beforeEach(()=>{jest.clearAllMocks();mockSql.mockResolvedValue([]);mockDelete.mockResolvedValue({error:null});mockSignup.mockResolvedValue({data:{user:{id:'qa-user',identities:[{}]},session:null},error:null});});
test('invalid registration and login input is rejected before upstream or database operations',async()=>{
 const res=response();await register({body:{...input,phone:'123'}} as Request,res as unknown as Response);expect(res.status).toHaveBeenCalledWith(400);expect(mockSignup).not.toHaveBeenCalled();expect(mockSql).not.toHaveBeenCalled();
 await login({body:{email:[],password:'value'}} as Request,res as unknown as Response);expect(res.status).toHaveBeenCalledWith(400);
});
test('the full_name form provisions one OWNER, clinic and finite trial in a transaction',async()=>{
 const tx=jest.fn().mockResolvedValueOnce([{id:'clinic'}]).mockResolvedValueOnce([{id:'qa-user',role:'OWNER'}]).mockResolvedValueOnce([]);
 mockSql.begin.mockImplementation((operation:any)=>operation(tx));const res=response();
 await register({body:input} as Request,res as unknown as Response);
 expect(res.status).toHaveBeenCalledWith(201);expect(tx).toHaveBeenCalledTimes(3);expect(res.json.mock.calls[0][0].data.requiresEmailConfirmation).toBe(true);
 expect(tx.mock.calls[1][0].join('')).toContain('INSERT INTO users');expect(tx.mock.calls[1][0].join('')).toContain("'OWNER'");
});
test('failed business provisioning compensates the newly created authentication account',async()=>{
 mockSql.begin.mockRejectedValue(new Error('database unavailable'));const res=response();await register({body:input} as Request,res as unknown as Response);
 expect(res.status).toHaveBeenCalledWith(503);expect(mockDelete).toHaveBeenCalledWith('qa-user');
});
test('existing accounts and obfuscated signup responses never create another clinic',async()=>{
 mockSql.mockResolvedValueOnce([{id:'existing'}]);let res=response();await register({body:input} as Request,res as unknown as Response);expect(res.status).toHaveBeenCalledWith(409);expect(mockSignup).not.toHaveBeenCalled();
 mockSignup.mockResolvedValueOnce({data:{user:{id:'fake',identities:[]}},error:null});res=response();await register({body:input} as Request,res as unknown as Response);expect(res.status).toHaveBeenCalledWith(409);expect(mockSql.begin).not.toHaveBeenCalled();expect(mockDelete).not.toHaveBeenCalled();
});
