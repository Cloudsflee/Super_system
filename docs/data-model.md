# Data Model

AIWS 3.0 creates a new database and rejects legacy `user_version` values. It does not contain a V2 migration path.

## SQLite policy

- `PRAGMA user_version=1`
- `foreign_keys=ON`
- `journal_mode=WAL`
- `synchronous=FULL`
- `busy_timeout=5000`
- STRICT tables and FTS5 context search
- database access isolated in a Worker Thread

## Core tables

| Table | Ownership and invariant |
| --- | --- |
| `projects` | mutable head with integer `revision` |
| `brief_revisions` | immutable Project Brief content and hash |
| `repository_bindings` | one managed repository per project |
| `workflow_revisions` | immutable two-level DAG and graph hash |
| `executions` | pins all input revisions and hashes |
| `task_attempts` | one row per attempt and normalized task status |
| `events` | append-only SSE source with integer cursor |
| `context_sources` | searchable project-scoped context |
| `context_packs` | immutable source selection and pack hash |
| `reviews` | immutable input and model suggestion state |
| `review_decisions` | one append-only human decision per review |
| `asset_versions` | immutable CAS identity and metadata |
| `evidence_links` | connects assets to executions, tasks, reviews, deliveries |
| `deliveries` | Draft PR or merge state with revision lock |
| `audit_events` | append-only command history |
| `idempotency_keys` | command request hash and replay response |
| `credential_refs` | references only; secret material is not stored here |

## Execution pinning

Creation copies the Workflow revision, Brief revision/hash, repository SHA, Context Pack ID/hash, and every input Asset Version/CAS hash into execution-owned fields. Later edits create new revisions and cannot stale or rewrite an existing execution.

## Immutability

SQLite triggers reject UPDATE and DELETE on Brief revisions, Workflow revisions, Context Packs, Reviews, Asset Versions, and Events. A model suggestion is restricted to `available`, `unavailable`, or `invalid`; it has no human decision column.
