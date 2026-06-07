import { z } from 'zod';

export const disposeBatchSchema = z.object({
  reason: z.enum(['EXPIRED', 'DAMAGED', 'RECALL', 'OTHER']),
  notes: z.string().max(2000).optional().nullable(),
});
