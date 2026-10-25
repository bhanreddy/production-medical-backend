// Real database verification. Requires a disposable localhost database ending in _qa.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const target = new URL(process.env.TEST_DATABASE_URL || 'http://missing.invalid');
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_qa')) {
  throw new Error('TEST_DATABASE_URL must name a disposable local *_qa database');
}
Object.assign(process.env, {
  DATABASE_URL: target.href,
  LOCAL_DB_PATH: ':memory:',
  DURABLE_RUNTIME: 'postgres',
  DURABLE_RUNTIME_KEY: 'durability-verification',
});
require('dotenv').config({ quiet: true });
const { withDurableRuntime } = require('../dist/lib/durableRuntime');
const db = require('../dist/local-db');
const { postgresQuery, beforePostgresCommit, withPostgresTransaction } = require('../dist/lib/postgresDb');
const sql = require('../dist/db').default;
const { PrescriptionStorageService: files } = require('../dist/services/prescription/prescriptionStorageService');
const key = 'prescriptions/qa/2026/00000000-0000-0000-0000-000000000001.pdf';
const getCounter = () => Number(db.localDb.prepare("SELECT value FROM sync_meta WHERE key='durability-counter'").get()?.value || 0);
const setCounter = value => db.localDb.prepare("INSERT OR REPLACE INTO sync_meta(key,value) VALUES ('durability-counter',?)").run(String(value));

async function worker() {
  const result = await withDurableRuntime(async () => {
    if (process.argv[3] === 'increment') {
      const before = getCounter();
      await new Promise(resolve => setTimeout(resolve, 25));
      setCounter(before + 1);
    }
    return getCounter();
  });
  process.stdout.write(String(result));
}
function replica(operation) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--worker', operation], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(Number(out)) : reject(new Error(err || `Worker exited ${code}`)));
  });
}
async function verify() {
  let ordinaryProjectionRan = false;
  delete process.env.DURABLE_RUNTIME;
  await assert.rejects(withPostgresTransaction(async () => {
    beforePostgresCommit(() => { ordinaryProjectionRan = true; });
    throw new Error('ordinary transaction rollback');
  }));
  assert.equal(ordinaryProjectionRan, false);
  process.env.DURABLE_RUNTIME = 'postgres';
  console.log('PASS: ordinary hosting retains after-commit projection semantics');
  await sql.unsafe(fs.readFileSync(path.join(__dirname, '../migrations/020_durable_runtime.sql'), 'utf8'));
  await postgresQuery('DELETE FROM app_runtime_checkpoints WHERE name = $1', [process.env.DURABLE_RUNTIME_KEY]);
  await postgresQuery('DELETE FROM app_prescription_documents WHERE storage_key = $1', [key]);
  // A first-request rollback must not become the seed for the next request.
  await assert.rejects(withDurableRuntime(async () => { setCounter(99); throw new Error('reject first'); }));
  assert.equal(await withDurableRuntime(async () => getCounter()), 0);
  console.log('PASS: a rejected first request never seeds durable data');

  await withDurableRuntime(async () => {
    setCounter(1);
    await files.save(key, Buffer.from('%PDF-1.7 durable prescription'));
  });
  assert.equal(await replica('read'), 1);
  assert.equal((await files.read(key)).toString(), '%PDF-1.7 durable prescription');
  console.log('PASS: committed workflow and file data survive a fresh process');

  await Promise.all(Array.from({ length: 8 }, () => replica('increment')));
  assert.equal(await replica('read'), 9);
  console.log('PASS: eight concurrent replicas preserve every increment');

  await postgresQuery('CREATE TABLE IF NOT EXISTS durability_qa(id integer PRIMARY KEY)');
  await assert.rejects(withDurableRuntime(async () => {
    setCounter(200);
    await postgresQuery('INSERT INTO durability_qa(id) VALUES(200)');
    await files.remove(key);
    throw new Error('simulated failure');
  }));
  assert.equal(await replica('read'), 9);
  assert.equal((await postgresQuery('SELECT * FROM durability_qa WHERE id = 200')).length, 0);
  assert.ok(await files.read(key));
  console.log('PASS: SQL, workflow changes and file deletion roll back together');

  const express = require('express');
  const request = require('supertest');
  const { durableRuntime } = require('../dist/middleware/durableRuntime');
  const app = express();
  app.use(require('compression')());
  app.use(durableRuntime);
  app.post('/write', async (_req, res, next) => {
    try { setCounter(getCounter() + 1); res.status(201).json({ saved: true }); }
    catch (error) { next(error); }
  });
  app.post('/reject', (_req, res) => { setCounter(999); res.status(409).json({ rejected: true }); });
  await postgresQuery('CREATE TABLE IF NOT EXISTS durability_deferred_qa(id integer REFERENCES durability_qa(id) DEFERRABLE INITIALLY DEFERRED)');
  app.post('/commit-failure', async (_req, res, next) => {
    try {
      setCounter(900);
      await postgresQuery('INSERT INTO durability_deferred_qa(id) VALUES (9876)');
      res.json({ saved: true });
    } catch (error) { next(error); }
  });
  assert.equal((await request(app).post('/write')).status, 201);
  assert.equal(await replica('read'), 10);
  assert.equal((await request(app).post('/reject')).status, 409);
  assert.equal(await replica('read'), 10);
  const failed = await request(app).post('/commit-failure');
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, 'DURABLE_STORAGE_UNAVAILABLE');
  assert.equal(await replica('read'), 10);
  console.log('PASS: HTTP success waits for commit, rejected requests and failed commits preserve state');

  await withDurableRuntime(async () => { beforePostgresCommit(() => { setCounter(11); }); });
  assert.equal(await replica('read'), 11);
  console.log('PASS: inventory projection callbacks join the committed checkpoint');

  await postgresQuery('DELETE FROM app_prescription_documents WHERE storage_key = $1', [key]);
  await postgresQuery('DELETE FROM app_runtime_checkpoints WHERE name = $1', [process.env.DURABLE_RUNTIME_KEY]);
}
(process.argv[2] === '--worker' ? worker() : verify())
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { db.localDb.close(); await sql.end(); });
