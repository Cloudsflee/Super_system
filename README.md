# AIWS 3.0

AIWS is a local, single-user workspace for AI-assisted software delivery. Version 3.0 keeps one product journey: register a project, seal a Project Brief and workflow revision, build a Context Pack, execute a two-level DAG, review immutable evidence, and create a GitHub Draft PR delivery.

## Runtime

The production topology has two long-running services and one temporary workload:

- `app`: HTTP API, web UI, SQLite worker, command registry, Git and CAS services.
- `runner-broker`: the only service with Docker CLI and `/var/run/docker.sock`.
- `codex-runner`: a short-lived container created from a pinned image digest.

The App is published only at `http://127.0.0.1:4317`. The Broker is reachable only on the internal Compose network. V3 always uses `aiws-data-v3`; V2.3 volumes are forbidden by configuration.

## Start

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
$env:AIWS_RUNNER_DIGEST = "sha256:<built-runner-digest>"
$env:AIWS_RUNNER_IMAGE = $env:AIWS_RUNNER_DIGEST
docker compose up -d --no-build
```

Open `http://127.0.0.1:4317`. Local source development runs the API and Broker plus Vite at `http://127.0.0.1:5173`:

```powershell
corepack pnpm dev
```

Create the sanitized DesignSignal fixture through the public API:

```powershell
corepack pnpm seed:demo
```

## API

All public routes are under `/api/v1`. Mutating requests require `Idempotency-Key`; revisioned updates require `expected_revision`. Errors use one envelope:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "project revision has changed",
    "retryable": false,
    "request_id": "...",
    "details": {}
  }
}
```

REST, MCP, and UI actions invoke the same Command Registry. See [API](docs/api.md).

## Data Boundary

SQLite starts at `PRAGMA user_version=1`, with foreign keys, WAL, `synchronous=FULL`, strict relational tables, and FTS5. Immutable records are protected by database triggers. An execution pins Workflow revision, Brief hash, repository SHA, Context Pack hash, and input asset hashes.

V2.3 data is not migrated. The source volume is stopped, hashed, cloned as cold evidence, archived, and recovery-tested. Its immutable revocation and archive receipts are stored under `.ai-workspace/release/v3-transition`.

## Gates

| Command | Scope |
| --- | --- |
| `pnpm check` | syntax, TypeScript, runtime ownership, script count |
| `pnpm test` | DAG, SQLite, immutability, paths, Broker contracts |
| `pnpm test:integration` | API, Broker, MCP, restart, execution journey |
| `pnpm test:e2e` | unique browser journey and six-viewport layout/error checks |
| `pnpm test:security` | resolved Compose, App image socket/CLI isolation, signed Broker rejection |
| `pnpm test:release` | version, port, receipt integrity, image identity, archive, directory governance |
| `pnpm verify` | all gates in release order |

Formal release runs only from a clean commit:

```powershell
corepack pnpm release:build
corepack pnpm release:rehearse
corepack pnpm release:promote
```

These commands create immutable gate, image/SBOM, temporary-volume acceptance, recovery, rollback, promotion, and targeted cleanup receipts under `.ai-workspace/release/v3-transition`.

## Documentation

- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Threat model](docs/threat-model.md)
- [Runbook](docs/runbook.md)
- [Testing and evaluation](docs/testing.md)
- [Requirements traceability](docs/requirements-traceability.md)
- [V2 retrospective](docs/v2-retrospective.md)
