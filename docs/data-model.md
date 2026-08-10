# Data Model

## Recovery contract groups

The V3 schema keeps the original hot-path tables and reserves strict, foreign-keyed storage for restored workflows:

- identity/configuration: `users`, `sessions`, `connected_accounts`, `setup_states`, `codex_profiles`, `github_app_configs`, `github_installations`, `mcp_clients`, `config_revisions`
- Assist/files: `assist_sessions`, `assist_turns`, `assist_messages`, `assist_events`, `assist_operations`, `assist_change_batches`, `assist_checkpoints`, `attachments`, `runtime_approvals`, `runtime_user_inputs`, `ui_action_intents`, `file_changes`
- workflow/outcome: `project_intakes`, `workflow_drafts`, `workflow_generations`, `workflow_generation_events`, `node_contracts`, `outcome_requirements`, `outcome_evaluations`, `outcome_waivers`, `execution_stage_checkpoints`
- repository/delivery: `repository_connections`, `repository_targets`, `repository_lines`, `pull_request_intents`, `delivery_policies`, `delivery_events`, `exchange_requests`, `exchange_grants`
- context/evidence/quality: `context_nodes`, `context_document_versions`, `context_edges`, `context_selections`, `context_policies`, `context_projection_jobs`, `context_summaries`, `asset_blobs`, `asset_attestations`, `asset_relations`, `traces`, `digests`, `code_changes`, `test_results`, `quality_review_runs`, `quality_review_reports`, `quality_review_events`

Table presence is a persistence contract, not a completion claim. `feature-catalog.json` remains authoritative for behavior status, while `apps/api/src/modules/registry.mjs` assigns every table exactly one current module owner.

Credential plaintext is excluded from SQLite. `credential_refs` stores provider, label, opaque Vault reference and timestamps; workspace Vault files are authenticated ciphertext.

AIWS 3.0 applies ordered, forward-only migrations. Empty databases execute the full list. A current v1 database without a ledger is accepted only when its normalized `sqlite_schema` fingerprint matches migration 1, then receives a baseline row. V2 data is never opened by this path and is handled only by the later offline importer.

Before baseline registration or a pending migration, SQLite creates a consistent snapshot below `data/migration-snapshots`. Its manifest records source, from/to versions and snapshot SHA-256. Restore verifies the hash, `integrity_check`, and original `user_version` before returning the database.

## SQLite policy

- `PRAGMA user_version=1`
- `schema_migrations(version,name,checksum,applied_at,duration_ms)`
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
| `schema_migrations` | immutable applied source identity for ordered forward upgrades |

## Execution pinning

Creation copies the Workflow revision, Brief revision/hash, repository SHA, Context Pack ID/hash, and every input Asset Version/CAS hash into execution-owned fields. Later edits create new revisions and cannot stale or rewrite an existing execution.

## Immutability

SQLite triggers reject UPDATE and DELETE on Brief revisions, Workflow revisions, Context Packs, Reviews, Asset Versions, and Events. A model suggestion is restricted to `available`, `unavailable`, or `invalid`; it has no human decision column.
