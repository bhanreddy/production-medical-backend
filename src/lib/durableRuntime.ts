import { gzipSync, gunzipSync } from 'node:zlib';
import { localDb, restoreLocalDb } from '../local-db';
import { beforePostgresCommit, postgresQuery, withPostgresTransaction } from './postgresDb';

// A process has one synchronous embedded engine. Never let two requests replace its working copy.
let queue: Promise<void> = Promise.resolve();
const initialImage = gzipSync(localDb.serialize());

/**
 * PostgreSQL is the durable owner of the embedded engine, not the instance disk.
 * A row lock serializes replicas; business SQL, documents and the checkpoint commit together.
 * This compatibility bridge serializes operations and is intended for modest POS workloads.
 */
export async function withDurableRuntime<T>(operation: () => Promise<T>): Promise<T> {
  const preceding = queue;
  let release!: () => void;
  queue = new Promise<void>(resolve => { release = resolve; });
  await preceding;
  try {
    return await withPostgresTransaction(async () => {
      const name = process.env.DURABLE_RUNTIME_KEY || 'medical-pos';
      await postgresQuery('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`medical-pos:${name}`]);
      let [checkpoint] = await postgresQuery<{ image: Buffer }>(
        'SELECT image FROM app_runtime_checkpoints WHERE name = $1 FOR UPDATE', [name],
      );
      if (!checkpoint) {
        checkpoint = { image: initialImage };
        await postgresQuery('INSERT INTO app_runtime_checkpoints(name, image) VALUES ($1, $2)', [name, checkpoint.image]);
      }
      // Restore even after a previous failed request: uncommitted working state is disposable.
      restoreLocalDb(gunzipSync(checkpoint.image, { maxOutputLength: 256 * 1024 * 1024 }));
      const before = localDb.serialize();
      const result = await operation();
      // Registered last, after all stock projection callbacks from the request.
      beforePostgresCommit(async () => {
        const image = localDb.serialize();
        if (image.length > 256 * 1024 * 1024) throw new Error('Embedded runtime capacity exceeded');
        if (!image.equals(before)) {
          await postgresQuery(
            'UPDATE app_runtime_checkpoints SET image = $2, revision = revision + 1, updated_at = now() WHERE name = $1',
            [name, gzipSync(image)],
          );
        }
      });
      return result;
    });
  } finally {
    release();
  }
}
