# AIWS 3.0

AIWS is a local, single-user workspace for AI-assisted software delivery. Version 3.0 keeps one product journey: register a project, seal a Project Brief and workflow revision, build a Context Pack, execute a two-level DAG, review immutable evidence, and create a GitHub Draft PR delivery.

The target architecture is **V3-Clean**. Its normative public contract is `/api/v2`
and its database starts from a clean baseline. The current branch still contains
the pre-clean V6/R6 implementation as a historical fixture; the implementation
plan and capability matrix are the authority for what has actually been restored.

## Runtime

The production topology has two long-running services and one temporary workload:

- `app`: HTTP API, web UI, SQLite worker, command registry, Git and CAS services.
- `runner-broker`: the only service with Docker CLI and `/var/run/docker.sock`.
- `codex-runner`: a short-lived container created from a pinned image digest.

The deterministic gates use the mock adapter. Run `pnpm test:runner-real` for the explicit Docker/Codex smoke path; without a pinned Runner digest and an ignored `AIWS_CODEX_SECRET_FILE`, it records `candidate` instead of a formal pass. The smoke verifies the CLI identity and ephemeral authentication cleanup before calling the model.

The eventual clean deployment is published only at `http://127.0.0.1:4317`. The
Broker is reachable only on the internal Compose network. V3-Clean uses a
`v3-clean` database/CAS volume; historical V2.3 and pre-clean V3 volumes are
read-only importer inputs and are forbidden as runtime write volumes.

## Start

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
$env:AIWS_RUNNER_DIGEST = "sha256:<built-runner-digest>"
$env:AIWS_RUNNER_IMAGE = $env:AIWS_RUNNER_DIGEST
$env:AIWS_GITHUB_REPOSITORY = "OWNER/REPO"
$env:AIWS_GITHUB_FIXTURE_SHA = "<40-character-fixture-commit>"
docker compose up -d --no-build
```

Before Compose startup, provide the ignored instance files `docker/secrets/broker_hmac`, `docker/secrets/codex_api_key`, and `docker/secrets/github_token`; the checked-in `.example` files define their formats. The GitHub token must be a fine-grained PAT for `AIWS_GITHUB_REPOSITORY` with Metadata read, Contents read/write, and Pull requests read/write. The Codex bundle supports only an OpenAI API key, fixed profile, and registered model. Credential material is read by the App into memory and never enters the browser.

Seed the GitHub fixture only into a pre-created empty repository, then retain the emitted SHA as the configured fixture identity:

```powershell
$env:AIWS_GITHUB_SECRET_FILE = (Resolve-Path docker/secrets/github_token)
$env:AIWS_GITHUB_REPOSITORY = "OWNER/REPO"
corepack pnpm github:seed-fixture
$env:AIWS_GITHUB_FIXTURE_SHA = "<fixture_sha from the command>"
```

The seed command accepts an empty repository or the exact existing fixture refs. It never overwrites different history.

Open `http://127.0.0.1:4317`. Local source development runs the API and Broker plus Vite at `http://127.0.0.1:5173`:

```powershell
corepack pnpm dev
```

Create the sanitized DesignSignal fixture through the public API:

```powershell
corepack pnpm seed:demo
```

## API

The V3-Clean target exposes business routes only under `/api/v2`. Mutating requests
require `Idempotency-Key`; lifecycle updates require `expected_revision` (or the
equivalent revision header). The clean contract uses one redacted success/error
envelope:

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

REST, MCP, and UI actions must invoke the same Command/Query Registry. See the
[API v2 contract](docs/architecture/api-v2-contract.md). The old `/api/v1`
description is retained only in [`docs/archive/legacy-code-docs/`](docs/archive/legacy-code-docs/).

## Data Boundary

The clean runtime opens only the `v3-clean` schema family. It uses ordered
forward-only migrations, checksums, foreign keys, WAL, strict tables, canonical
CAS hashes and immutable receipts. A historical V1-V6 database is not opened by
startup; it is an input to the offline importer described in
[`architecture/import-contract.md`](docs/architecture/import-contract.md).
V2.3 and current V3 sources are stopped, hashed and imported into a temporary
clean volume before one-time cutover. Credentials import as metadata with
`rebind_required`; secret material is never copied.

## Gates

| Command | Scope |
| --- | --- |
| `pnpm check` | syntax, TypeScript, runtime ownership, script count |
| `pnpm test` | DAG, SQLite, immutability, paths, Broker contracts |
| `pnpm test:integration` | API, Broker, MCP, restart, execution journey |
| `pnpm test:e2e` | unique browser journey and six-viewport layout/error checks |
| `pnpm test:security` | Compose and socket isolation, Broker rejection, credential scans across SQLite/SSE/CAS/errors |
| `pnpm test:release` | version, port, receipt integrity, image identity, archive, directory governance |
| `pnpm verify` | all gates in release order |

Recovery planning and impact are executable before the release gates:

```powershell
corepack pnpm recovery:plan
corepack pnpm recovery:catalog
corepack pnpm recovery:coverage
corepack pnpm recovery:impact --audit
```

The commands validate `feature-catalog.json` and write metadata receipts below `.ai-workspace/recovery` without touching the formal `4317` service.

Formal release runs only from a clean commit:

```powershell
corepack pnpm release:build
corepack pnpm release:rehearse
corepack pnpm release:promote
```

These commands create immutable gate, image/SBOM, temporary-volume acceptance, recovery, rollback, promotion, and targeted cleanup receipts under `.ai-workspace/release/v3-transition`. Rehearsal without both external configurations remains `candidate`; formal promotion requires fresh available Codex and GitHub probes plus evidence of a real Runner journey and a merged GitHub Draft PR with synchronized local baseline.

## Documentation

- [Code document index](docs/document-index.md)
- [V3-Clean architecture](docs/architecture/v3-clean-break.md)
- [Clean schema](docs/architecture/clean-schema.md)
- [API v2 and events](docs/architecture/api-v2-contract.md)
- [Capability matrix](docs/architecture/v23-capability-matrix.md)
- [Development plan](docs/architecture/v3-clean-development-plan.md)
- [Import contract](docs/architecture/import-contract.md)
- [Threat model](docs/threat-model.md)
- [Runbook](docs/runbook.md)
- [Testing and evaluation](docs/testing.md)
- [Requirements traceability](docs/requirements-traceability.md)
- [V2 retrospective](docs/v2-retrospective.md)
