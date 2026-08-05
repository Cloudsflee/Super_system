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
- `GET/POST /projects/{projectId}/executions`
- `GET /executions/{executionId}`
- `POST /executions/{executionId}/start`
- `POST /executions/{executionId}/cancel`
- `GET /executions/{executionId}/events`
- `GET/POST /reviews`
- `POST /reviews/{reviewId}/decisions`
- `GET /assets/{assetId}` and `/assets/{assetId}/content`
- `GET/POST /deliveries`
- `POST /deliveries/{deliveryId}/merge`
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

## Health

`/livez` reports only process liveness. `/readyz` checks SQLite integrity/user version, Broker reachability, and exact Runner digest. Codex and GitHub cached probes are returned separately from `/api/v1/system/capabilities`.

`/api/v1/system/performance` reports App RSS, event-loop lag p95, and process uptime for release acceptance.
