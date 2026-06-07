/**
 * Optional Redis pub/sub for sync wakeups. No-op when REDIS_URL is unset or ioredis unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;

async function getClient(): Promise<any> {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (client) return client;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require('ioredis');
    client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    await client.connect?.().catch?.(() => null);
    return client;
  } catch {
    return null;
  }
}

export async function publishSyncEvent(clinicId: string, event: string, payload: Record<string, unknown>) {
  const c = await getClient();
  if (!c) return;
  try {
    await c.publish(`sync:clinic:${clinicId}`, JSON.stringify({ event, payload, at: new Date().toISOString() }));
  } catch {
    /* ignore */
  }
}
