# V3-Clean Break Architecture

Status: normative clean-break contract, implemented through P4.
Owner: platform architecture.
Effective runtime name: `V3-Clean`.

This document is the top-level contract for the clean break. It governs the
schema, service, importer, API, event, deployment, and release documents in
this directory. Decisions through D-033 implement the P1-P4 runtime surface;
later phases must update the decision log and capability matrix before changing
one of these contracts.

## 1. Objective

V3-Clean is the only runtime and restores the complete V2.3 business surface
as one coherent system. V2.3 commit `e18dc0b` is a read-only behavior source;
the current V3 tree is a second read-only input for the offline importer. The
new public API is `/api/v2`, and the new database starts at a clean baseline.

The target has these properties:

1. One implementation and one owner for every table, command, event, and
   permission decision.
2. One transaction for a state transition, revision/CAS check, attempt record,
   operation link, event append, and aggregate-head update.
3. One authorization predicate reused by HTTP, MCP, importer, replay, and
   evidence queries.
4. One operation/event/CAS model for Assist and all other long-running work.
5. An offline, checkpointed import followed by an atomic deployment cutover.
6. Evidence and release receipts that make the result and rollback auditable.

## 2. Non-goals

The following are outside the V3-Clean runtime contract:

- serving `/api/v1` or any other compatibility route;
- loading a V1-V6 migration chain during normal startup;
- keeping a legacy session branch, a legacy facade, or a native-version flag;
- dual writes, shared write volumes, or long-term dual operation;
- importing secret material, tokens, cookies, or old Vault ciphertext;
- silently choosing one source when V2.3 and V3 describe different business
  meanings;
- treating a parser result as an automatic human quality decision.

Historical code, migrations, databases, CAS roots, screenshots, and receipts
remain valuable fixtures. They are never runtime dependencies.

## 3. Runtime shape

```text
HTTP/API v2, SSE, JSON replay, MCP HTTP/stdio/Gateway
                       |
             Command and Query Registry
                       |
                 Domain Services
                       |
       Canonical Repositories and transaction unit
                       |
       Adapters: runner, parser, GitHub, bridge, CAS
                       |
       Clean SQLite + CAS + immutable receipts
```

### 3.1 Request boundary

The boundary authenticates the actor, normalizes the project scope, validates
the redacted envelope, checks idempotency and expected revision, and creates a
request id. It does not mutate domain tables. A command handler receives a
typed command and an authorization context; a query handler receives a typed
query and a read scope.

### 3.2 Command/query registry

The registry is the single description used to build HTTP routes and MCP
bindings. Each entry declares:

- command or query id and version;
- input and output schema;
- project scope and required permission;
- idempotency and expected-revision policy;
- operation behavior and event stream;
- redaction policy and external adapter;
- UI and evidence links.

Unknown commands, unknown fields, and unregistered routes fail at the
boundary. A route is never implemented a second time in a MCP-only handler.

### 3.3 Domain service and repository

Domain services own invariants and state machines. Repositories own SQL,
foreign keys, CAS references, and transaction composition. Adapters translate
external protocols into domain receipts. A service may call another service
only through an explicit command or repository interface; direct cross-domain
table writes are an architecture-gate failure.

### 3.4 Runner and parser adapter contracts

Every runner invocation receives an immutable, signed Job Spec:

~~~json
{
  "job_id": "job_01...",
  "execution_id": "exe_01...",
  "runner_profile": "docker-default",
  "image_digest": "sha256:...",
  "workspace_ref": "ws_01...",
  "code_home_ref": "codehome_01...",
  "credential_ref": "cred_01...",
  "timeout_ms": 900000,
  "capabilities": ["git.read", "cas.write"],
  "spec_sha256": "sha256:...",
  "signature": "sig_..."
}
~~~

The broker verifies the signature, digest, workspace scope, capability
allowlist, and temporary credential binding before starting a process. The
receipt contains exit status and stdout/stderr hashes, never raw secrets.

Parser workers use one isolated request/response protocol for every registered
format:

~~~json
{
  "parser_run_id": "parse_01...",
  "format": "docx",
  "input_blob_sha256": "sha256:...",
  "limits": {"bytes": 10485760, "pages": 100, "cpu_ms": 120000},
  "sandbox_profile": "parser-default",
  "output_contract": "evidence.asset.v2"
}
~~~

The response is a bounded redacted envelope containing status, output CAS
hashes, extracted asset metadata, warnings, error code, retryability, and a
checkpoint token. A worker timeout, quota breach, malformed input, or
unsupported format is represented explicitly and can be retried with the same
input hash. Audio/video, PPTX, and generic archives use this protocol as
first-class registered formats.

## 4. Fixed module ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| Identity | users, sessions, actors, teams, memberships, ACL decisions | project content |
| Setup/Credential | credential metadata, profiles, rebind state, provider probes | secret values or business events |
| Project | projects, briefs, intake, project lifecycle | workflow execution |
| Repository | connections, targets, lines, workspaces, locks | GitHub app credentials |
| Workflow/Generation | workflow revisions, nodes, contracts, proposals, critic receipts | runner process state |
| Context/Projection | sources, nodes, versions, edges, selections, packs, projection jobs | human quality verdicts |
| MCP/Exchange/Gateway | clients, scopes, requests, grants, forwarding receipts | durable business payloads in the gateway |
| Assist | sessions, turns, messages, generic operation links, user input, proposals | a second operation table |
| Files/Attachments/Approval/Terminal/Bridge | file changes, attachments, approval waits, PTY sessions, pairing and bundles | project ACL policy definition |
| Runner/Execution | signed jobs, executions, attempts, seven stages, checkpoints | parser-specific business policy |
| Evidence/Quality/Outcome | CAS assets, traces, digests, parser reports, human scores, outcomes and waivers | source workspace mutation |
| Delivery/Deployment/Operations | PR intents, delivery state, deployment evidence, backup/restore/reset, receipts | ad-hoc migration of old databases |
| Importer | inspect, map, copy, verify, checkpoint, cutover manifests | online API requests or runtime writes |

The owner list is normative. A table, command, or event may appear in a
capability row owned by another module only as a read-only reference.

## 5. Clean-break invariants

### 5.1 Storage

- The runtime opens only the `v3-clean` schema family. `user_version` starts at
  `1` for the clean baseline and advances through forward-only migrations in
  that family.
- Startup verifies the family marker, migration checksums, foreign keys,
  snapshot hash, and CAS manifest. A historical schema produces an importer
  request receipt and the process remains unavailable for business traffic.
- A mutable aggregate has one canonical state row. Immutable revisions and the
  generic aggregate head are updated in the same transaction. Per-domain shadow
  head tables are not part of the model.
- Every mutable row has an opaque stable id, `revision`, `created_at`,
  `updated_at`, and (where applicable) `deleted_at`. Revision values increase
  monotonically and are checked with compare-and-swap.
- Immutable payloads use canonical JSON and SHA-256. Host absolute paths,
  secrets, and unredacted prompts are excluded from canonical payloads.

### 5.2 Operations and events

- `operations` is the only durable operation ledger. Assist does not write an
  `assist_operations` table; Assist links use `operation_links`.
- `events` is the only append-only domain event stream. Each event carries an
  aggregate id, aggregate revision, sequence, operation id, actor id, project
  scope, redacted data, and payload hash.
- An event cursor is durable and scoped. SSE and JSON replay read the same
  cursor and event rows.
- Every retry, cancel, ack, pause, resume, and replay records an operation
  receipt and expected revision result.

### 5.3 Authorization

The authorization context contains `actor_id`, `team_id`, `project_id`,
membership role, grants, client scopes, and a policy revision. A project ACL
decision is made before a repository, context, Assist, MCP, evidence, or
importer read. Exchange grants can narrow a scope, never widen it. Gateway
forwarding repeats the check at the destination service.

### 5.4 Credentials

Only provider, profile, scope, status, revision, and external reference are
domain data. Secret values are resolved at adapter execution time from the
current Vault or provider binding. An imported credential is always
`rebind_required` until a fresh proof succeeds.

## 6. State-machine conventions

All state machines use lower-case stable values and explicit terminal states.
The common transition envelope is:

```json
{
  "from": "queued",
  "to": "running",
  "expected_revision": 3,
  "actor_id": "actor_...",
  "operation_id": "op_...",
  "reason": "dispatcher_claim",
  "at": "2026-01-01T00:00:00.000Z"
}
```

The state transition, revision increment, event, and operation link commit or
roll back together. The detailed aggregate states are in
[`clean-schema.md`](clean-schema.md).

## 7. Capability restoration order

The implementation sequence follows dependency edges:

1. Clean baseline, API v2, Identity/Team/Actor, Credential, and permissions.
2. Project, Brief, Repository, Workflow, Generation, and Critic.
3. Context, Projection, Context Pack, MCP, Exchange, and Gateway.
4. Assist, Files, Attachments, Approval/User Input, Terminal, and Windows
   Bridge.
5. Runner, seven-stage Execution, checkpoint, pause/resume, and replay.
6. Asset/CAS, Evidence, Trace, Digest, Quality parser, human score, Outcome,
   and waiver.
7. GitHub Delivery, Draft PR, merge recovery, Deployment, Backup/Restore, and
   Reset.
8. Complete Web workflow, mobile/offline behavior, SSE reconnect, Gateway
   administration, and operations views.

The current Catalog's `scaffolded` entries stay below `implemented` until a
behavior test, applicable UI test, integration probe, and Evidence record
exist. Status is derived; it is not a planning assertion.

## 8. Deployment and cutover

1. Stop writes to both source systems and create byte-level snapshots, CAS
   manifests, and source receipts.
2. Build a clean database and temporary CAS root on an isolated volume.
3. Run importer `inspect`, `dry-run`, `run`, `checkpoint/resume`, and `verify`.
4. Verify row counts, relation closure, CAS hashes, event ordering, ACL
   boundaries, credential rebind status, and golden workflows.
5. Switch the deployment to the verified volume and record a cutover receipt.
6. Retain the old volumes and rollback receipt. Rollback restores the old
   deployment as a deployment artifact; it does not re-enable old API routes.

An importer failure leaves the target volume unmountable for production. The
failed volume, input hashes, mapping, and report remain available for resume.

## 9. Architecture gates

Every implementation change runs the preflight in the root `AGENTS.md` and
the following gates:

- no legacy compatibility symbols, old runtime imports, or dual operation
  models in runtime code;
- one owner per table/command/event and one canonical head mechanism;
- API registry, MCP mapping, UI route, and capability matrix agree;
- migration checksum, foreign-key check, snapshot, and rollback receipts pass;
- secrets and absolute paths are absent from API, event, audit, CAS, and
  evidence envelopes;
- all V2.3 L0-L7 catalog cases are linked to a V3-Clean test and Evidence
  receipt before release promotion.

## 10. Source anchors

The matrix records the exact historical anchors used for characterization:

- V2.3 behavior commit: `e18dc0b`;
- V2.3 test catalog: `tests/v23/catalog.json` at `e18dc0b`;
- V2.3 route registry: `apps/api/src/api-routes.mjs` and
  `apps/api/src/routes/*.mjs` at `e18dc0b`;
- V2.3 state collections and schema 23: `apps/api/src/config.mjs`,
  `apps/api/src/state-migration-v23.mjs`, and
  `apps/api/src/state-migration-v23-quality.mjs`;
- V2.3 UI route and features: `apps/web/src/app/router.tsx` and
  `apps/web/src/features/**`;
- current V3 feature status: root `feature-catalog.json` and its Evidence
  paths.

These anchors explain behavior and coverage. They do not authorize importing
their runtime modules.
