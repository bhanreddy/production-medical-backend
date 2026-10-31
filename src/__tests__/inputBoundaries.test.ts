import express from 'express';
import request from 'supertest';
import { dateOnlySchema } from '../schemas/date.schema';
import { createExpenseSchema } from '../schemas/expense.schema';
import { createPurchaseSchema } from '../schemas/purchase.schema';
import { purchasesRouter } from '../routes/purchases';
import { errorHandler } from '../middleware/errorHandler';
jest.mock('../middleware/auth',()=>({requireAuth:(req:any,_res:any,next:()=>void)=>{req.user={id:'qa',clinic_id:'qa',role:'OWNER'};next();}}));
const app=express();app.use('/purchases',purchasesRouter);app.use(errorHandler);
test.each(['2026-02-30','2026-13-01','0000-01-01','2026-2-1','2025-02-29'])('invalid calendar date %s is rejected before SQL execution',value=>expect(dateOnlySchema.safeParse(value).success).toBe(false));
test.each(['2024-02-29','2026-12-31'])('valid calendar date %s is accepted',value=>expect(dateOnlySchema.safeParse(value).success).toBe(true));
test('non-finite monetary values and impossible purchase expiry dates are invalid',()=>{
 expect(createExpenseSchema.safeParse({category:'misc',amount:Infinity,expense_date:'2026-10-26'}).success).toBe(false);
 expect(createPurchaseSchema.safeParse({items:[{medicine_id:'qa',batch_number:'QA',expiry_date:'2026-02-30',quantity:1,purchase_price:10,mrp:20}]}).success).toBe(false);
});
test('oversize CSV uploads return an actionable 413 response',async()=>{
 const response=await request(app).post('/purchases/import-csv').attach('file',Buffer.alloc(10*1024*1024+1),{filename:'oversize.csv',contentType:'text/csv'});
 expect(response.status).toBe(413);expect(response.body.error.code).toBe('LIMIT_FILE_SIZE');
});
