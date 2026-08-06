# Architecture

## Product boundary

AIWS 3.0 is a local single-user development workspace. The supported flow is Project -> Brief -> Workflow -> Context Pack -> Execution -> Review -> Asset/Evidence -> Delivery. Team administration, Exchange, hosted GitHub, terminals, host bridges, global context graphs, projectors, and standalone MCP gateways are not runtime components.

## Components

### App

The App owns the public web and `/api/v1` surface. A single Command Registry is called by REST handlers and `/api/v1/mcp`. Domain handlers use relational repositories through a dedicated SQLite Worker Thread. The App can execute Git with fixed argument lists but contains no Docker CLI and has no Docker socket.

### Runner Broker

The Broker owns container lifecycle operations. Every request is HMAC-signed over method, path, timestamp, nonce, and body hash. Signatures expire after 30 seconds and nonces are single-use. The Broker accepts a closed Job Spec and maps it to fixed Docker arguments.

### Codex Runner

The Runner is temporary and digest-pinned. Its enforced profile drops all capabilities, enables `no-new-privileges`, uses a read-only root filesystem, publishes no port, and limits CPU, memory, PIDs, and tmpfs. The registered project subdirectory is the only writable workspace mount.

### Domain services

The App keeps transaction orchestration in `Domain` and delegates filesystem and provider boundaries to focused services:

- `InputStaging` validates declared assets and creates the execution-scoped input tree.
- `EvidenceService` captures bounded Git evidence, prepares CAS blobs, and commits evidence links with the terminal execution state.
- `IntegrationProbeService` owns cached Codex and GitHub capability probes; probes are explicit and do not run during capability reads.
- `GitHubIntegration` owns fixture validation, project and delivery branches, draft PR submission, merge review, and baseline synchronization.

Each service returns fixed, redacted metadata to the Domain. Secrets remain in process memory and are never part of API, audit, event, or Broker job records.

## Networks

`internal` connects App and Broker and is not externally routable. `edge` connects only the App so Docker Desktop can publish `127.0.0.1:4317`. The Broker has `expose` metadata but no host port.

## Commands and events

Mutations are commands with idempotency records. Domain changes and audit events are committed in SQLite. Execution events are append-only and streamed as SSE with cursor resumption. The Broker does not persist request bodies or credentials.

## Recovery

On process restart, the App reopens SQLite and finds `running` executions. Broker job status determines whether work continues. An unknown job is recorded as a retryable failure; execution history is never rewritten.
