import { Response } from 'express';

/**
 * SSE (Server-Sent Events) Manager
 *
 * Maintains a map of clinicId → connected SSE clients.
 * Used to broadcast real-time events (e.g. EXPENSE_ADDED) to all
 * connected mobile and desktop clients for that clinic.
 */

// Map of clinicId → array of connected SSE response objects
const clients: Map<string, Response[]> = new Map();

/**
 * Register a new SSE client for a given clinic.
 */
export function addClient(clinicId: string, res: Response): void {
  if (!clients.has(clinicId)) clients.set(clinicId, []);
  clients.get(clinicId)!.push(res);
  console.log(`[SSE] Client added for clinic ${clinicId} (total: ${clients.get(clinicId)!.length})`);
}

/**
 * Remove a disconnected SSE client.
 */
export function removeClient(clinicId: string, res: Response): void {
  const list = clients.get(clinicId) || [];
  clients.set(clinicId, list.filter(r => r !== res));
  console.log(`[SSE] Client removed for clinic ${clinicId} (remaining: ${clients.get(clinicId)?.length ?? 0})`);
}

/**
 * Broadcast an event to all connected SSE clients for a clinic.
 */
export function broadcastToClinic(clinicId: string, event: object): void {
  const list = clients.get(clinicId) || [];
  if (list.length === 0) return;

  const data = `data: ${JSON.stringify(event)}\n\n`;
  let sent = 0;

  list.forEach(res => {
    try {
      res.write(data);
      sent++;
    } catch {
      /* client disconnected — will be cleaned up on 'close' event */
    }
  });

  console.log(`[SSE] Broadcast ${(event as any).type ?? 'event'} to ${sent}/${list.length} clients for clinic ${clinicId}`);
}
