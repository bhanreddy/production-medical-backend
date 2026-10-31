import { z } from 'zod';

export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return value.slice(0, 4) !== '0000' && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date');
