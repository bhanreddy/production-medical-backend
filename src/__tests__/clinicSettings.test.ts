import express from 'express';
import request from 'supertest';
const mockSql=jest.fn();
jest.mock('../db',()=>({__esModule:true,default:(...args:unknown[])=>mockSql(...args)}));
jest.mock('../lib/postgresDb',()=>({queryRaw:jest.fn()}));
jest.mock('../middleware/auth',()=>({requireAuth:(req:any,_res:any,next:()=>void)=>{req.user={id:'owner',clinic_id:'own-clinic',role:'OWNER'};next();}}));
import {clinicsRouter} from '../routes/clinics';import {errorHandler} from '../middleware/errorHandler';
const app=express();app.use(express.json());app.use('/clinics',clinicsRouter);app.use(errorHandler);
beforeEach(()=>{mockSql.mockReset();mockSql.mockReturnValue([]);});
test.each([{}, {name:'   '}, {email:'invalid'}, {role:'SUPER_ADMIN',clinic_id:'other-clinic'}])('invalid profile patch %j never executes SQL',async body=>{
 const response=await request(app).put('/clinics/me').send(body);expect(response.status).toBe(400);expect(mockSql).not.toHaveBeenCalled();
});
test('missing clinics return 404 instead of an empty success response',async()=>{
 const response=await request(app).put('/clinics/me').send({name:'QA pharmacy'});expect(response.status).toBe(404);
});
