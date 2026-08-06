# Public API

Base URL: `http://127.0.0.1:4317/api/v1`

## Resources

- `GET/POST /projects`
- `GET/PATCH /projects/{projectId}`
- `GET/POST /projects/{projectId}/briefs`
- `GET/POST /projects/{projectId}/workflows`
- `GET/POST /projects/{projectId}/context/sources`
- `GET/POST /projects/{projectId}/context/packs`
- `GET/POST /projects/{projectId}/assets`
- `GET /projects/{projectId}/diff`
- `POST /integrations/codex/probe` (requires `Idempotency-Key`; returns only provider, model, status, timestamp, and fixed error code; `{ "force": true }` bypasses the 15-minute cache)
- `POST /integrations/github/probe` (explicit, cached GitHub repository/PAT probe; `{ "force": true }` bypasses the 15-minute cache)
- `GET/POST /projects/{projectId}/executions`
- `GET /executions/{executionId}`
- `GET /executions/{executionId}/diff` (captured execution evidence; never a live project diff)
- `POST /executions/{executionId}/evidence/resolve` with `action: retry_capture|discard_worktree` and `expected_revision`
- `POST /executions/{executionId}/start`
- `POST /executions/{executionId}/cancel`
- `GET /executions/{executionId}/events`
- `GET/POST /reviews`
- `POST /reviews/{reviewId}/decisions`
- `GET /assets/{assetId}` and `/assets/{assetId}/content`
- `GET/POST /deliveries`
- `POST /deliveries/{deliveryId}/merge`
- `POST /deliveries/{deliveryId}/retry` (idempotent remote submission or post-merge synchronization retry)
- `GET /audit`
- `GET /system`, `/system/capabilities`, and `/system/performance`
- `POST /mcp`

## Command requirements

Every POST, PATCH, and action requires `Idempotency-Key`. Reusing a key with the same command returns the recorded response. Reusing it with a different body returns `409 idempotency_conflict`.

Mutable resources require `expected_revision`. A stale value returns `409 revision_conflict`.

## SSE

The execution event endpoint accepts `Last-Event-ID`. Each event data object has exactly these stable fields:

```json
{
  "cursor": 42,
  "type": "task.completed",
  "execution_id": "exe_...",
  "task_id": "verify",
  "data": { "attempt": 1 },
  "created_at": "2026-08-06T00:00:00.000Z"
}
```

Runner events are normalized before persistence. They contain only a runner event type, phase, exit code, file count, a short redacted summary, and its SHA-256; raw JSONL and stderr are not stored.

## Fixture execution

The public project create payload may opt into the deterministic repository fixture:

```json
{
  "name": "DesignSignal",
  "repository": { "source": { "kind": "fixture", "id": "designsignal-v1" } }
}
```

The API computes the repository SHA. A submitted `head_sha` is ignored. Starts validate that the baseline is still clean, create an isolated execution directory under `projects/{projectId}/worktrees/{executionId}`, and stage declared assets under `inputs/{projectId}/{executionId}`. A second failed Attempt enters `awaiting_human` and retains that Worktree for an immutable human-retry Attempt. Completion or cancellation captures the diff, checks, rollback script, and declared outputs into CAS before cleanup.

The Codex probe returns `error_code: null` only for a Docker-backed Runner with the fixed CLI version and an in-memory Secret Bundle. Its unavailable codes are `runner_unavailable`, `deterministic_adapter`, and `credential_missing`.

## Health

`/livez` reports only process liveness. `/readyz` checks SQLite integrity/user version, Broker reachability, and exact Runner digest. Codex and GitHub cached probes are returned separately from `/api/v1/system/capabilities`; a restart reports `unknown/not_probed` until an explicit probe.

`/api/v1/system/performance` reports App RSS, event-loop lag p95, and process uptime for release acceptance.
