import { businessDate } from '../lib/businessDate';
test('Indian business dates cross midnight before the UTC server date', () => {
  expect(businessDate(new Date('2026-10-07T20:00:00Z'))).toBe('2026-10-08');
  expect(businessDate(new Date('2026-10-07T18:29:59Z'))).toBe('2026-10-07');
});
test('the configured organization timezone determines the business date', () => {
  expect(businessDate(new Date('2026-10-08T02:00:00Z'), 'America/New_York')).toBe('2026-10-07');
});
