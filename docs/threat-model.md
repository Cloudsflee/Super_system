# Threat Model

状态：V3-Clean 支撑文档。规范细节以 `v3-clean-break.md`、`api-v2-contract.md`
和 `clean-schema.md` 为准。

## Protected assets

- project, team and ACL metadata;
- managed repository content, workspace bundles and generated diffs;
- credential metadata and the external proof used for rebind (not secret values);
- immutable operations, events, execution, review, delivery and audit Evidence;
- clean SQLite, CAS objects, parser outputs and import manifests;
- Docker/Host/Windows execution capability and Gateway scope decisions;
- read-only V2.3/V3 source snapshots used by the offline importer.

## Trust boundaries

The browser and all uploaded/parser input are untrusted. The API authenticates an
actor and evaluates the project ACL before dispatching a typed command. The
App-to-Broker and Gateway transports are authenticated but replayable. The Broker
is the only Docker control boundary; the Gateway is a forwarding boundary with no
Docker socket and no business tables. Runner and parser output is untrusted
Evidence until policy and, where required, a human review accept it. The importer
is offline and writes only an isolated temporary volume.

## Controls

| Threat | V3-Clean control |
| --- | --- |
| command replay | `Idempotency-Key`, request hash and one operation receipt |
| stale write or state jump | expected revision/CAS plus atomic state/event/head transaction |
| actor/project scope escape | one authorization predicate reused by HTTP, MCP, importer, replay and Evidence |
| Broker/Gateway impersonation | signed method/path/timestamp/nonce/body or forwarding receipt |
| replayed adapter request | expiry, nonce cache, operation revision and bounded retry |
| arbitrary container or parser | fixed digest/profile, closed Job Spec, quotas, sandbox and output contract |
| host path escape | relative workspace reference, canonical CAS bytes and adapter path policy |
| privileged runner | dropped capabilities, no-new-privileges, read-only root, no public port |
| Docker takeover from App/Gateway | Docker CLI/socket exists only at the Broker boundary |
| secret disclosure | metadata-only credentials, temporary rebind proof, redaction before event/audit/CAS commit |
| approval spoofing | model suggestion, operation state and immutable human decision are separate records |
| import contamination | schema-family check, read-only source manifests, semantic-conflict batch failure and sealed target on verify failure |
| CAS tamper | canonical bytes, SHA-256 manifest, lineage/attestation and closed-snapshot verification |
| rollback ambiguity | deployment-level receipt naming old image, old volume, target health and actual rollback output |

## Residual risks

The Docker daemon remains a high-privilege dependency for the Broker. A compromised
Broker can control local containers, so it is not host-published and accepts only
signed requests. External Codex, GitHub, Gateway, Bridge and parser availability
are capability states; they cannot be silently treated as readiness. Public provider
egress remains an accepted local-deployment risk and must be reflected in the
Runner profile and release receipt.

Imported credentials require a new proof and start as `rebind_required`. Historical
source data may contain malformed paths, stale permissions or incompatible meaning;
the importer blocks those batches rather than silently selecting a source. A formal
release requires fresh external probes, temporary-volume verification and an actual
deployment rollback.
