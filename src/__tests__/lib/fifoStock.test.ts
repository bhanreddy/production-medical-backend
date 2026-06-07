import { planFifoDeductions, sortBatchesForFifo, isBatchExpired } from '../../lib/fifoStock';
import { AppError } from '../../lib/appError';

describe('fifoStock', () => {
  const today = new Date('2026-06-15T12:00:00Z');

  test('sortBatchesForFifo orders by expiry, skips expired and zero qty', () => {
    const batches = [
      { id: 'a', medicine_id: 'm', expiry_date: '2027-01-01', quantity_remaining: 5 },
      { id: 'b', medicine_id: 'm', expiry_date: '2026-08-01', quantity_remaining: 5 },
      { id: 'c', medicine_id: 'm', expiry_date: '2026-07-01', quantity_remaining: 0 },
      { id: 'd', medicine_id: 'm', expiry_date: '2025-01-01', quantity_remaining: 10 },
    ];
    const sorted = sortBatchesForFifo(batches, today);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'a']);
  });

  test('planFifoDeductions takes from earliest expiry first', () => {
    const batches = [
      { id: 'near', medicine_id: 'm', expiry_date: '2026-07-01', quantity_remaining: 5 },
      { id: 'far', medicine_id: 'm', expiry_date: '2027-07-01', quantity_remaining: 5 },
    ];
    const plan = planFifoDeductions(batches, 3, today);
    expect(plan).toEqual([{ batch_id: 'near', quantity: 3 }]);
  });

  test('planFifoDeductions spans multiple batches', () => {
    const batches = [
      { id: 'a', medicine_id: 'm', expiry_date: '2026-07-01', quantity_remaining: 3 },
      { id: 'b', medicine_id: 'm', expiry_date: '2027-07-01', quantity_remaining: 5 },
    ];
    const plan = planFifoDeductions(batches, 7, today);
    expect(plan).toEqual([
      { batch_id: 'a', quantity: 3 },
      { batch_id: 'b', quantity: 4 },
    ]);
  });

  test('planFifoDeductions throws INSUFFICIENT_STOCK when not enough', () => {
    const batches = [{ id: 'a', medicine_id: 'm', expiry_date: '2027-07-01', quantity_remaining: 2 }];
    expect(() => planFifoDeductions(batches, 5, today)).toThrow(AppError);
    try {
      planFifoDeductions(batches, 5, today);
    } catch (e: any) {
      expect(e.code).toBe('INSUFFICIENT_STOCK');
    }
  });

  test('isBatchExpired true for yesterday', () => {
    expect(isBatchExpired('2026-06-14', new Date('2026-06-15T12:00:00Z'))).toBe(true);
  });
});
