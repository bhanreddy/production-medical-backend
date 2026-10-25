# Medical POS on Catalyst

The backend is linked to the `medipos` project (78544000000061006), India data center, organization 60091775419.

Run `npm run build:catalyst` to compile the source, install locked production dependencies, and prepare the Linux x86-64 SQLite binary for Node 24. The generated `.catalyst-build/` contains an ignored, mode-0600 AppSail configuration populated from `.env` (or `CATALYST_ENV_FILE`). Credentials are sent as AppSail environment variables; the CLI excludes this configuration from the code archive. Never commit the build directory.

Run `npm run deploy:catalyst` to upload to Catalyst Development. Promote the project in the Catalyst console to reach Production. Initial production deployment requires a configured Catalyst payment method. The application binds `X_ZOHO_CATALYST_LISTEN_PORT` and rejects requests until migrations finish.

## Durable state

Core cloud tables continue to use the existing Supabase PostgreSQL database. With `DURABLE_RUNTIME=postgres`, embedded workflows use a disposable in-memory SQLite working copy. Each API request acquires a PostgreSQL transaction lock, restores the last checkpoint, runs the existing workflow, and commits its changed checkpoint before releasing the HTTP response. Cloud SQL operations using the transaction wrapper and inventory projection updates join that commit. Rejected requests and failed commits discard the working copy. Private prescription originals are stored as PostgreSQL `bytea`, with existing organization authorization enforced by the document route. Migration 020 enables RLS and removes browser-role access to both storage tables.

This is a durability compatibility bridge, **not a native relational migration of the embedded engine**. Requests are serialized across replicas. Checkpoints have a 256 MiB uncompressed capacity limit, and transfer/restore cost grows with embedded data. Use load testing and migrate embedded workflows to native PostgreSQL tables before expanding to a large deployment. Supabase REST calls and external providers cannot participate in the PostgreSQL transaction. SSE connections are excluded from checkpoint locking and remain instance-local; AppSail request duration limits also apply.

Existing SQLite files or prescription directories from other machines/hosting providers are not imported by this deployment. Archive and explicitly migrate any such business records before redirecting existing users. Existing differences between cloud billing and embedded stock workflows described in `docs/RELEASE_VALIDATION.md` in the parent workspace still need workflow-specific validation.

Keep PostgreSQL backups/PITR enabled; they must include `app_runtime_checkpoints` and `app_prescription_documents`. `DURABLE_RUNTIME_KEY` names an independent embedded state; changing it starts another state rather than migrating the old one. Production uses `medical-pos`.

## Verification

Run the ordinary Jest suite with an isolated `LOCAL_DB_PATH` and a test database URL, never live mutation credentials. Run `TEST_DATABASE_URL=postgresql://...@127.0.0.1:PORT/medical_catalyst_qa npm run test:durability` against a disposable database. This checks restart persistence, concurrent replica increments, atomic rollback of SQL/checkpoints/files, and delayed HTTP success including an actual deferred-constraint commit failure.

After deployment, check `/api/health` for `status: ok` and `db.status: connected`, and confirm protected endpoints reject unauthenticated requests. A dedicated authenticated test account is needed to validate actual business workflows without touching customer records.
