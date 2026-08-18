# V3-Clean Offline Import Contract

Status: normative contract for the one-time cutover importer.
Execution mode: offline CLI on isolated source snapshots and a temporary
target volume.
Runtime boundary: the importer is not linked into HTTP, MCP, or worker
startup.

## 1. Purpose and guarantees

The importer combines a read-only V2.3 state source and a read-only current V3
source into a new v3-clean database and CAS root. It produces a complete
mapping, conflict report, verification record, and rollback receipt before a
cutover is attempted.

The importer guarantees:

- source bytes are hashed before any mapping or copy;
- the target is never mounted as a production volume before verify passes;
- a source semantic conflict blocks the entire batch;
- technical id collisions are resolved deterministically and recorded;
- CAS content is rehashed from canonical bytes;
- credential metadata is imported with status rebind_required;
- checkpoints can resume only when source and mapping hashes are unchanged;
- a failed batch leaves its target volume and report intact for diagnosis.

## 2. Inputs

### 2.1 Source manifest

Each source has an immutable manifest:

~~~json
{
  "source_namespace": "v23",
  "product_version": "2.3.0",
  "schema_family": "historical-v23",
  "schema_version": 23,
  "schema_fingerprint": "sha256:...",
  "state_path": "snapshots/v23/state-v23.sqlite",
  "cas_root": "snapshots/v23/cas",
  "cas_manifest": "snapshots/v23/cas.manifest.json",
  "context_index_manifest": "snapshots/v23/context-index.json",
  "workspace_manifest": "snapshots/v23/workspaces.json",
  "attachment_manifest": "snapshots/v23/attachments.json",
  "evidence_manifest": "snapshots/v23/evidence.json",
  "release_receipt": "snapshots/v23/source-receipt.json",
  "snapshot_sha256": "sha256:...",
  "created_at": "2026-01-01T00:00:00.000Z"
}
~~~

The V3 source uses the same shape with source_namespace v3, schema_version 6,
its workspace and Evidence manifests, and its clean snapshot receipt. Paths
are relative to the importer workspace. A manifest
with an absolute path, missing hash, changed byte range, or mismatched receipt
is rejected before inspect.

### 2.2 Merge manifest

An optional merge manifest supplies human decisions for known semantic
conflicts. It cannot authorize secret import or bypass ACL, checksum, CAS, or
foreign-key checks.

~~~json
{
  "batch_id": "imp_...",
  "accepted_conflicts": [
    {
      "conflict_id": "conf_...",
      "decision": "merge",
      "reason": "same project intentionally consolidated",
      "actor_id": "actor_...",
      "expected_source_hash": "sha256:..."
    }
  ]
}
~~~

The decision hash is recorded in every affected mapping and receipt.

## 3. Commands and phase outputs

The executable is conceptually:

~~~text
aiws-import inspect --manifest INPUT.json --report REPORT.json
aiws-import dry-run --sources SOURCES.json --merge MERGE.json --out PLAN.json
aiws-import run --plan PLAN.json --target TEMP_VOLUME --checkpoint CHECKPOINT.json
aiws-import resume --checkpoint CHECKPOINT.json --target TEMP_VOLUME
aiws-import verify --checkpoint CHECKPOINT.json --report VERIFY.json
aiws-import cutover --verify VERIFY.json --deployment RECEIPT.json
aiws-import rollback --cutover RECEIPT.json --restore OLD_RECEIPT.json
~~~

Every command is deterministic for the same source hashes, mapping rules,
tool build, and merge manifest.

### 3.1 inspect

Inspect is read-only. It performs:

1. source manifest and receipt signature/hash validation;
2. SQLite header, schema fingerprint, WAL/integrity, and foreign-key checks;
3. row counts and primary/foreign-key uniqueness checks;
4. CAS manifest enumeration and content hash sampling/full verification;
5. context-index, workspace, attachment, Evidence, and release-manifest
   consistency;
6. secret/path sentinel scan of metadata and logs.

Output is an inspect receipt with source hashes, counts, warnings, and a stable
inspection hash. No target file is created.

### 3.2 dry-run

Dry-run builds a mapping graph without writing business rows. It reports:

- source and target entity counts;
- retained ids, generated ids, and mapping reasons;
- references that require translation;
- semantic conflicts and technical collisions;
- credential rebind list;
- unsupported or unmapped fields;
- projected CAS bytes and temporary-volume size;
- ACL closure and project-scope violations;
- a deterministic plan hash.

The plan is a release artifact. run accepts only a plan whose input hashes and
tool policy match its own calculation.

### 3.3 run

run creates a new temporary clean database and CAS root. It copies domains in
dependency order:

~~~text
identity -> teams/ACL -> credentials metadata -> projects/briefs
-> repositories/workspaces -> workflows/generation -> context
-> Assist/files/approval/terminal/bridge -> execution/runner
-> assets/evidence/quality/outcome -> delivery/operations
~~~

Each domain commits in bounded transactions. A checkpoint is written after the
transaction and fsynced before the next domain starts.

### 3.4 resume

resume verifies the source manifest, plan hash, mapping hash, target schema
family, and checkpoint signature. It skips verified keys and replays only the
unfinished domain. A changed source byte, mapping decision, tool policy, or
target family starts a new batch instead of mutating the old target.

### 3.5 verify

Verify runs on a closed database snapshot and a sealed CAS manifest:

- row counts by source namespace and clean table;
- foreign-key and relation closure;
- aggregate head/revision/hash agreement;
- event sequence monotonicity and operation-link closure;
- idempotency records and checkpoint consistency;
- CAS hash, byte length, media type, and lineage checks;
- ACL and Exchange scope tests for every project;
- credential state checks (metadata only, rebind_required);
- V2.3 golden workflows and V3 business golden workflows;
- secret/path/token sentinel scans.

Verify writes a signed report containing exact commands, inputs, outputs, and
exit statuses. A failed assertion marks the target volume blocked.

### 3.6 cutover

cutover requires a verify receipt with status passed, matching source and
target hashes, a deployment health probe, and an operator approval. It stops
old writes, atomically switches the data-volume reference, performs livez and
readyz checks, and writes a cutover receipt. The old volumes remain mounted
only as read-only rollback artifacts.

## 4. ID mapping

### 4.1 Stable retention

An id is retained when all of the following hold:

- it matches the clean id grammar;
- it is unique in the destination table;
- its source namespace is the selected canonical owner;
- its semantic identity fingerprint agrees with any other source reference.

The importer records reason retained and the source namespace in import_id_map.

### 4.2 Deterministic technical collision

For a pure primary-key collision with equal semantic identity, generate:

~~~text
clean_id = base32url(
  sha256("v3-clean/id/" + source_namespace + "/" + table + "/" + old_id)
)[0:26]
~~~

The mapping row includes old id, new id, source namespace, table, collision
kind, algorithm version, and mapping hash. If that derived id is already used
by a different semantic object, the importer takes the next fixed digest
window from the same hash and records the window number. Re-running the batch
yields the same new id.

### 4.3 Semantic conflict

A semantic conflict is any disagreement in owner, project scope, workflow
meaning, revision lineage, content hash, permission, or external reference
that cannot be proven to be a technical collision. Examples include:

- two projects with the same business key but different owners or briefs;
- one workflow revision pointing to incompatible node contracts;
- an asset id with different canonical bytes;
- an Exchange grant with incompatible source/target scope;
- an event sequence that implies different prior state.

Semantic conflicts are batch-blocking. The current run always ends in failed
before a conflicting row is committed. A merge manifest may be supplied to a
later dry-run only when both source hashes and the resulting clean object are
explicit; it is a human resolution input, not a source-preference default or
an in-place override of the failed batch.

### 4.4 Reference translation

Every foreign key, path reference, operation id, event id, asset id, context
node id, revision id, workspace id, and external callback id is resolved
through import_id_map. An unresolved reference creates a blocking conflict
with source file, row key, field, expected target, and reason.

## 5. Field mapping policy

| Source class | Clean treatment |
| --- | --- |
| canonical business identity | retain or deterministic remap; record mapping |
| mutable state | normalize into the clean aggregate state and revision |
| immutable snapshot/report | copy to aggregate_revisions or Evidence with hash |
| legacy compatibility field | map to a clean field or record a blocking unsupported-field conflict |
| source-only runtime flag | convert to a receipt/evidence attribute, never a runtime switch |
| absolute host path | resolve to a relative workspace reference; keep adapter receipt only |
| prompt, token, cookie, secret, Vault ciphertext | omit and record credential/rebind metadata |
| old operation/event | map to generic operations/events with a preserved source reference |
| old state enum | map through an explicit table; unknown value blocks the batch |

The mapping table and schema-diff appendix list every source field. "Ignored"
is a valid result only for a documented, non-business, non-secret field.

## 6. Credential and external-reference handling

Imported credential_refs contain provider, external account id, profile name,
scope, source fingerprint, and status rebind_required. The importer never
copies:

- Codex API keys or device tokens;
- GitHub access/refresh tokens, webhook secrets, or cookies;
- MCP client bearer secrets or Gateway signing keys;
- runner environment secrets or old Vault ciphertext.

The first adapter use requires an explicit rebind or rotation operation. Probe
results are new Evidence, not a continuation of an old active status.

## 7. Checkpoint format

~~~json
{
  "schema": "aiws.v3-clean.import-checkpoint.v1",
  "batch_id": "imp_...",
  "source_hashes": {"v23": "sha256:...", "v3": "sha256:..."},
  "plan_hash": "sha256:...",
  "mapping_hash": "sha256:...",
  "target_family": "v3-clean",
  "target_baseline": 1,
  "domain": "context",
  "last_key": "ctx_...",
  "rows_committed": 240,
  "cas_objects_committed": 91,
  "status": "checkpointed",
  "updated_at": "2026-01-01T00:00:00.000Z"
}
~~~

Checkpoint writes are append-only receipts. The active pointer is a deployment
metadata file whose hash is included in the next checkpoint.

## 8. Failure and rollback rules

| Failure | Target behavior | Resume behavior |
| --- | --- | --- |
| manifest/hash mismatch | block before target creation | new inspect after source repair |
| SQLite/CAS integrity error | mark batch failed and seal target | repair source, new batch |
| semantic conflict | roll back current transaction; preserve report | merge manifest then resume from clean checkpoint |
| technical collision | write deterministic mapping | continue after mapping commit |
| adapter timeout | operation failed/retryable; no partial business event | resume/retry with same input hash |
| secret/path sentinel | redact output, block affected row | corrected source or explicit field mapping |
| verify mismatch | target remains blocked and unmountable | fix importer, resume or start new batch |
| cutover health failure | restore old deployment receipt | rerun cutover after repair |

Rollback is deployment-level: restore the old image, old database/CAS volume,
and old deployment receipt. The clean target remains sealed for inspection.

## 9. Receipt requirements

Each phase receipt includes:

- batch id, phase, tool build, policy version, and actor;
- exact command, working directory, environment names (values redacted);
- source/plan/mapping/target hashes;
- row, relation, CAS, and conflict counts;
- literal verification outputs and exit statuses;
- next checkpoint or failure reason;
- signature/hash and parent receipt id.

The four cutover artifacts are mandatory:

1. modified clean database and CAS root;
2. import plan/diff and ID mapping;
3. verification record with baseline/target commands and outputs;
4. runnable deployment rollback receipt.

## 10. Acceptance checklist

- Both source manifests pass inspect and byte-level hash comparison.
- Dry-run has zero unresolved semantic conflicts and an explicit result for
  every source field/reference.
- Re-running dry-run produces the same plan and mapping hashes.
- Run/resume completes after an injected interruption at every domain boundary.
- Verify passes row, relation, event, ACL, CAS, credential, and golden checks.
- Cutover and an actual rollback both pass health and behavior probes.
- No source runtime directory is opened by the clean application after cutover.
