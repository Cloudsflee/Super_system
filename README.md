# AIWS 3.0

AIWS is a local, single-user workspace for AI-assisted software delivery. Version 3.0 keeps one product journey: register a project, seal a Project Brief and workflow revision, build a Context Pack, execute a two-level DAG, review immutable evidence, and create a GitHub Draft PR delivery.

The target architecture is **V3-Clean**. Its normative public contract is `/api/v2`
and its database starts from a clean baseline. The current branch still contains
the pre-clean V6/R6 implementation as a historical fixture; the implementation
plan and capability matrix are the authority for what has actually been restored.

## Runtime

The target production topology has two long-running services and one temporary workload:

- `app`: HTTP API, web UI, SQLite worker, command registry, Git and CAS services.
- `runner-broker`: the only service with Docker CLI and `/var/run/docker.sock`.
- `codex-runner`: a short-lived container created from a pinned image digest.

Broker, Runner, external provider, and browser journeys remain characterization
fixtures during P1. Their implementation and release claims begin in P2-P9 as
listed in the development plan.

The eventual clean deployment is published only at `http://127.0.0.1:4317`. The
Broker is reachable only on the internal Compose network. V3-Clean uses a
`v3-clean` database/CAS volume; historical V2.3 and pre-clean V3 volumes are
read-only importer inputs and are forbidden as runtime write volumes.

The P1 clean platform is the default API entrypoint and can be started without
the historical adapters:

```powershell
corepack pnpm start
```

`corepack pnpm start:clean` is an explicit alias for the same clean entrypoint.

It creates `001-clean-baseline` (`PRAGMA user_version = 1`), exposes `/livez`,
`/readyz`, and the operation/replay routes under `/api/v2`, and keeps a local
CAS and receipt volume beside the database.

## P1 Start

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
corepack pnpm start
```

From another shell, probe the clean process:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/livez
Invoke-RestMethod http://127.0.0.1:4317/readyz
```

During P1, local source development starts the clean API only; Broker and Web
remain later-phase fixtures:

```powershell
corepack pnpm dev
```

The pre-clean demonstration seeder is retained only for explicit historical
fixture runs; clean project creation enters in P3:

```powershell
corepack pnpm fixture:seed-demo
```

## Deferred Fixtures

The checked-in Web, Broker, MCP stdio, Compose, deployment, importer-adjacent,
and release tooling are inputs to P2-P9. Commands that can execute the old
runtime are registered under `fixture:legacy:*`; their output characterizes
historical behavior and is not a clean release receipt. P1 has no active
build/rehearse/promote command.

## API

The V3-Clean target exposes business routes only under `/api/v2`. Mutating requests
require `Idempotency-Key`; lifecycle updates require `expected_revision` (or the
equivalent revision header). The clean contract uses one redacted success/error
envelope:

```json
{
  "request_id": "...",
  "error": {
    "code": "revision_conflict",
    "message": "project revision has changed",
    "retryable": false,
    "details": {}
  }
}
```

REST, MCP, and UI actions must invoke the same Command/Query Registry. See the
[API v2 contract](docs/architecture/api-v2-contract.md). Historical routes are
retired at the clean boundary and remain characterization inputs only.

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
| `pnpm test:p1` | V3-Clean baseline, operation/event/CAS/API v2 probes |
| `pnpm audit:p1` | all-path P1/future-fixture classification, active docs, final Evidence and rollback freshness |
| `pnpm scan:clean` | clean dependency boundary, ownership, registry parity and global P1 audit |
| `pnpm test:integration` | P1 integration plus historical API/Broker/MCP characterization |
| `pnpm test:e2e` | historical Web journey characterization; no P1 Web claim |
| `pnpm test:security` | P1 security plus deferred Compose/Broker/provider characterization |
| `pnpm test:release` | historical release receipt and deferred deployment characterization |
| `pnpm verify` | P1 gates plus explicitly classified historical regression gates |

Recovery planning and impact are executable before the release gates:

```powershell
corepack pnpm recovery:plan
corepack pnpm recovery:catalog
corepack pnpm recovery:coverage
corepack pnpm recovery:impact --audit
```

The commands validate `feature-catalog.json` and write metadata receipts below `.ai-workspace/recovery` without touching the formal `4317` service.

Clean deployment build, rehearsal, promotion, temporary-volume import, and
actual deployment rollback enter in P8-P9. Existing pre-clean scripts and
receipts remain read-only fixtures until those phase gates replace them.

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
