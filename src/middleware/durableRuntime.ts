import type { RequestHandler } from 'express';
import { withDurableRuntime } from '../lib/durableRuntime';
import { logger } from '../lib/logger';

class RejectedResponse extends Error {}

/** Buffer the response until both cloud SQL and embedded state are durably committed. */
export const durableRuntime: RequestHandler = async (req, res, next) => {
  if (process.env.DURABLE_RUNTIME !== 'postgres' ||
      req.path === '/health' || req.path === '/events/stream') return next();

  const originalWrite = res.write;
  const originalEnd = res.end;
  const originalFlushHeaders = res.flushHeaders;
  const chunks: Buffer[] = [];
  let callbacks: Array<() => void> = [];
  let complete!: () => void;
  const ended = new Promise<void>(resolve => { complete = resolve; });
  let capturedEnd = false;

  function append(chunk: any, encoding?: any) {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined));
    }
  }
  res.write = function(chunk: any, encoding?: any, callback?: any) {
    append(chunk, encoding);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  } as typeof res.write;
  res.end = function(chunk?: any, encoding?: any, callback?: any) {
    if (capturedEnd) return res;
    capturedEnd = true;
    append(chunk, encoding);
    const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
    if (done) callbacks.push(done);
    complete();
    return res;
  } as typeof res.end;
  res.flushHeaders = () => {};

  try {
    await withDurableRuntime(async () => {
      next();
      await ended;
      if (res.statusCode >= 400 || res.destroyed) throw new RejectedResponse();
    });
  } catch (error) {
    if (!(error instanceof RejectedResponse)) {
      logger.error('Durable request failed', { message: error instanceof Error ? error.message : String(error) });
      chunks.length = 0;
      callbacks = [];
      res.statusCode = 503;
      for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Location', 'Set-Cookie']) res.removeHeader(name);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      chunks.push(Buffer.from(JSON.stringify({ error: { code: 'DURABLE_STORAGE_UNAVAILABLE', message: 'Unable to commit this request. Please retry.' } })));
    }
  } finally {
    res.write = originalWrite;
    res.end = originalEnd;
    res.flushHeaders = originalFlushHeaders;
  }
  if (!res.destroyed) {
    res.once('finish', () => { for (const callback of callbacks) callback(); });
    for (const chunk of chunks) res.write(chunk);
    res.end();
  }
};
