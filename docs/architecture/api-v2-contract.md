# API v2 and Event Contract

Status: normative public contract for V3-Clean.
Base path: /api/v2.
Transport: HTTPS/HTTP, SSE, JSON replay, MCP HTTP, MCP stdio, and MCP
Gateway forwarding.

The route registry, MCP registry, and Web client are generated or validated
from the same command/query definitions. The router contains only API v2
business routes plus /livez and /readyz probes. Historical route names are
characterization inputs and are not mounted by the clean runtime.

## 1. Envelope

### 1.1 Success

~~~json
{
  "request_id": "req_01...",
  "data": {"id": "project_01...", "revision": 4},
  "meta": {
    "api_version": "2",
    "resource_type": "project",
    "resource_revision": 4,
    "etag": "rev-4-sha256:...",
    "redactions": []
  }
}
~~~

Collection responses use data.items, data.next_cursor, and data.total. Binary
responses carry a CAS reference and a short-lived download receipt; they do not
embed an unbounded payload in the envelope.

### 1.2 Error

~~~json
{
  "request_id": "req_01...",
  "error": {
    "code": "revision_conflict",
    "message": "expected revision does not match",
    "details": {
      "resource_type": "project",
      "resource_id": "project_01...",
      "expected_revision": 3,
      "actual_revision": 4
    },
    "retryable": true,
    "redactions": []
  }
}
~~~

Error codes are stable machine identifiers. Messages are display text and may
be localized. The minimum registry is:

| HTTP | Code family | Meaning |
| --- | --- | --- |
| 400 | invalid_request, unknown_field, schema_invalid | envelope or command validation failed |
| 401 | authentication_required, session_expired | actor proof is missing or expired |
| 403 | permission_denied, scope_denied, project_denied | policy evaluation rejected the request |
| 404 | resource_not_found, operation_not_found | scoped object is absent |
| 409 | revision_conflict, idempotency_conflict, state_conflict | caller state or command replay conflicts |
| 410 | route_retired, receipt_expired | historical or expired address/receipt |
| 413 | quota_exceeded, payload_too_large | declared resource limit exceeded |
| 415 | media_type_unsupported | parser/attachment format is unregistered |
| 422 | semantic_invalid, evidence_incomplete, conflict_blocked | domain validation failed |
| 429 | rate_limited, lease_busy | retry after the supplied delay |
| 500 | internal_error | unexpected server fault with a redacted trace |
| 502 | adapter_failed | external provider/runner returned a bounded failure |
| 503 | not_ready, dependency_unavailable | readiness or required adapter is unavailable |
| 504 | operation_timeout | bounded wait elapsed; operation receipt remains queryable |

The response never includes a secret, token, cookie, full prompt, host absolute
path, or unredacted parser text.

## 2. Request metadata

Every request has:

| Header/field | Rule |
| --- | --- |
| X-Request-ID | optional caller id; server returns a validated request id |
| Idempotency-Key | required for POST/PATCH/PUT/DELETE mutations; 8-128 safe characters |
| X-Expected-Revision | required for updates and lifecycle commands; integer |
| If-Match | alternative revision form, e.g. rev-4-sha256:... |
| X-Actor-ID | service-to-service actor binding, accepted only with a valid credential |
| X-Project-ID | optional route-independent scope; must agree with body/path |
| Accept | application/json or text/event-stream |
| Last-Event-ID | SSE reconnect cursor |

The body may repeat idempotency_key or expected_revision for MCP and offline
clients. Header and body values must agree. A mutation without its required
key/revision returns a structured validation error before domain code runs.

## 3. Operation receipts

Long work returns HTTP 202:

~~~json
{
  "request_id": "req_01...",
  "data": {
    "operation": {
      "id": "op_01...",
      "kind": "workflow.execution",
      "status": "queued",
      "resource_type": "execution",
      "resource_id": "exe_01...",
      "accepted_revision": 4,
      "poll_uri": "/api/v2/operations/op_01...",
      "events_uri": "/api/v2/operations/op_01.../events",
      "replay_uri": "/api/v2/operations/op_01.../events?format=json"
    }
  },
  "meta": {"retry_after_ms": 500}
}
~~~

Operation states are accepted, queued, running, paused, succeeded, failed,
cancelled, and expired. The receipt is immutable; a retry creates a linked
operation. GET operation and event routes use the same permission context as
the originating command.

## 4. Route families

The following table is the complete V3-Clean family map. Individual command
ids, schemas, and MCP bindings live in the registry; the path patterns are
stable public addresses.

| Family | API v2 paths | Representative commands/events | Owner |
| --- | --- | --- | --- |
| probes/operations | /livez, /readyz, /api/v2/operations/{id}, /api/v2/operations/{id}/events, /api/v2/operations/{id}/cancel | operations.get, operations.cancel; operation.* | Operations |
| identity/team | /api/v2/account, /api/v2/sessions, /api/v2/teams, /api/v2/teams/{id}/memberships | actor.update, session.revoke, team.member.grant; actor.*, team.* | Identity |
| setup/credentials | /api/v2/setup, /api/v2/credentials, /api/v2/profiles, /api/v2/integrations/{provider}/* | setup.complete, credential.rotate, profile.probe; setup.*, credential.* | Setup |
| projects/briefs | /api/v2/projects, /api/v2/projects/{id}, /api/v2/projects/{id}/intake, /api/v2/projects/{id}/briefs | project.create, intake.retry, brief.confirm; project.*, brief.* | Project |
| ACL/exchange | /api/v2/projects/{id}/members, /api/v2/projects/{id}/permissions, /api/v2/projects/{id}/exchange-requests, /api/v2/exchange-grants/{id} | membership.grant, exchange.approve, exchange.revoke; acl.*, exchange.* | Identity/Exchange |
| repositories | /api/v2/projects/{id}/repository-connections, /repository-lines, /repository-workspaces, /api/v2/repository-workspaces/{id}/* | repository.bind, workspace.refresh, line.reconcile; repository.*, workspace.* | Repository |
| workflow | /api/v2/projects/{id}/workflows, /workflow-drafts, /workflow-generations, /api/v2/workflows/{id}/* | workflow.revise, generation.start, proposal.apply; workflow.*, generation.* | Workflow |
| context | /api/v2/projects/{id}/context/map, /search, /read, /policy, /selections, /packs | context.select, context.pack.create; context.* | Context |
| projection | /api/v2/projects/{id}/context/jobs, /context/jobs/{id}/events, /context/rebuild | projection.rebuild, projection.cancel; projection.* | Projection |
| MCP/client | /api/v2/mcp, /api/v2/mcp/tools, /api/v2/mcp/clients, /api/v2/mcp/clients/{id} | mcp.tool.call, mcp.client.revoke; mcp.* | MCP |
| gateway | /api/v2/gateway/forward, /api/v2/gateway/receipts/{id} | gateway.forward; gateway.* | Gateway |
| Assist | /api/v2/assist/sessions, /turns, /events, /follow-ups, /goal, /references | assist.turn.create, assist.turn.retry, assist.turn.cancel; assist.* | Assist |
| files/attachments | /api/v2/projects/{id}/files, /change-batches, /attachments, /api/v2/attachments/{id}/* | file.batch.apply, file.batch.undo, attachment.create; file.*, attachment.* | Files |
| approval/input | /api/v2/approvals, /api/v2/user-inputs, /api/v2/proposals | approval.decide, user-input.answer, proposal.apply; approval.*, input.* | Assist |
| terminal/bridge | /api/v2/terminals, /terminals/{id}/events, /terminals/{id}/ws, /api/v2/bridge/pairing | terminal.open, terminal.stop, bridge.pair; terminal.*, bridge.* | Terminal/Bridge |
| execution/runner | /api/v2/projects/{id}/executions, /api/v2/executions/{id}/start, /pause, /resume, /cancel, /stages/{stage}/replay | execution.start, stage.replay; execution.*, runner.* | Execution/Runner |
| evidence/assets | /api/v2/projects/{id}/assets, /api/v2/assets/{id}/versions, /api/v2/assets/{id}/content, /api/v2/executions/{id}/evidence | asset.capture, asset.attest; asset.*, evidence.* | Evidence |
| quality/outcome | /api/v2/executions/{id}/quality-reviews, /api/v2/quality-reviews/{id}, /outcome, /waivers | quality.start, quality.decision, outcome.evaluate, waiver.revoke; quality.*, outcome.* | Quality/Outcome |
| delivery | /api/v2/deliveries, /api/v2/pull-request-intents, /api/v2/deliveries/{id}/* | delivery.submit, pr.ready, pr.merge, delivery.reconcile; delivery.* | Delivery |
| deployment/ops | /api/v2/system/deployment, /api/v2/backups, /restore, /reset, /imports | deploy.verify, backup.restore, import.cutover; deployment.*, operations.* | Operations |

All project-scoped patterns resolve a project before authorization. Collection
queries return only resources visible to the actor, Exchange grant, and MCP
allowlist.

## 5. Command contract

A command is identified by a stable id such as
workflow.execution.start or assist.turn.create. Its registry entry contains:

~~~json
{
  "command_id": "assist.turn.create",
  "version": 2,
  "method": "POST",
  "pattern": "/api/v2/assist/sessions/{session_id}/turns",
  "project_scoped": true,
  "required_scopes": ["assist:write"],
  "idempotency": "required",
  "expected_revision": "session",
  "long_running": true,
  "input_schema": "assist.turn.create.v2",
  "output_schema": "operation.receipt.v2",
  "events": ["assist.turn.queued", "assist.turn.running", "assist.turn.completed"],
  "mcp": {"mapping": "tool", "name": "assist_turn_create"}
}
~~~

Queries may omit Idempotency-Key and expected revision. Mutations always return
the resource revision or an operation receipt, and every state change emits an
event with the same operation id.

## 6. Event protocol

### 6.1 Event envelope

~~~json
{
  "id": "evt_01...",
  "type": "assist.turn.completed",
  "sequence": 18,
  "aggregate": {"type": "assist_turn", "id": "turn_01...", "revision": 5},
  "operation_id": "op_01...",
  "actor_id": "actor_01...",
  "project_id": "project_01...",
  "occurred_at": "2026-01-01T00:00:00.000Z",
  "data": {"status": "completed", "output_asset_id": "asset_01..."},
  "data_sha256": "sha256:...",
  "redactions": []
}
~~~

Sequence is monotonic per stream. Event ids are opaque; replay ordering uses
sequence and the cursor, not wall-clock time. Event payloads are bounded and
redacted.

### 6.2 SSE

GET /api/v2/{resource}/{id}/events with Accept text/event-stream returns:

~~~text
id: 18
event: assist.turn.completed
data: {"id":"evt_01...","sequence":18,...}

~~~

The server honors Last-Event-ID and query cursor. On reconnect it first emits
all durable events after the cursor, then follows the live stream. A terminal
operation emits a terminal snapshot and closes the stream. Heartbeats carry
no business data.

### 6.3 JSON replay

The same endpoint with format=json returns:

~~~json
{
  "events": [{"id": "evt_01...", "sequence": 18, "type": "assist.turn.completed"}],
  "next_cursor": "19",
  "terminal": true,
  "resource": {"id": "turn_01...", "revision": 5}
}
~~~

SSE and JSON replay use the same event rows, authorization, redaction, cursor
semantics, and retention policy.

## 7. MCP mapping

MCP HTTP and stdio expose the command registry, not private service methods.
Each callable entry maps to one tool or resource:

| Registry mapping | MCP shape | API equivalence |
| --- | --- | --- |
| tool | tool name, input schema, result envelope | POST/PUT/PATCH command |
| resource | resource URI template, read schema | GET query |
| async_adapter | tool returns operation receipt; events resource | 202 command plus events |
| external_callback | inbound webhook receipt | provider callback route |
| frontend_only | registry metadata only | UI action, no MCP invocation |

MCP requests carry client id, scopes, subject actor, project allowlist, and
optional Exchange grant. The registry repeats route authorization and filters
project collections. A Gateway forwards only registered tool/resource calls,
never stores business state, and never receives a Docker socket.

## 8. Pagination, filtering, and downloads

Collection queries use opaque cursor tokens bound to actor, project scope,
query hash, ordering, and expiry. A cursor from another scope returns
cursor_scope_mismatch. Ordering is stable by revision/time/id. Downloads use a
single-use receipt bound to actor, project, asset hash, media type, and expiry.

## 9. Retry and cancellation

Retry, cancel, pause, resume, ack, and decision commands require expected
revision and Idempotency-Key. A stale command returns revision_conflict with
the current receipt. A retryable adapter error returns 202 only when a new
operation was accepted; otherwise it returns the bounded adapter error.

## 10. Authentication and permissions

The boundary authenticates a session, service credential, MCP client, or
Gateway signature into an actor. Scope names are action-oriented:

~~~text
account:read/write
team:read/manage
project:read/write/run/approve
repository:read/write/admin
context:read/write
assist:read/write
execution:read/run/control
evidence:read/write/attest
delivery:read/write/merge
operations:read/control
~~~

Project ACL, team membership, Exchange grant, client allowlist, and operation
ownership are all required where applicable. A permission denial has the same
shape through HTTP, MCP, replay, and Evidence query.

## 11. Compatibility and versioning

The public contract starts at /api/v2 and has no legacy route registration.
An address from an archived API family returns route_retired with a migration
receipt reference; it does not dispatch into a historical handler. Schema
versions in payloads are explicit, and a breaking contract change requires a
new command or API major plus a decision-log entry.

## 12. Contract validation

The API gate must verify:

1. every route has a unique command id and one owner;
2. every mutation declares idempotency and expected-revision behavior;
3. every project route has a permission predicate;
4. every 202 command has an operation and event mapping;
5. SSE and JSON replay produce equivalent event sets;
6. HTTP, MCP HTTP, stdio, Gateway, and Web client schemas agree;
7. redaction tests find no secret/path/token sentinel;
8. route inventory and capability matrix references are bidirectional.
