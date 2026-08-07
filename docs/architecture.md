# Architecture

## Product boundary

AIWS 3.0 is a local single-user development workspace. The supported flow is Project -> Brief -> Workflow -> Context Pack -> Execution -> Review -> Asset/Evidence -> Delivery. Interactive Terminal sessions are a runtime component of the Assist workspace and are gated by the V3 approval and audit contracts.

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
- `TerminalService` owns approval-gated native PTY sessions, bounded redacted output, cursor replay, reconnect recovery, and the project terminal write lock. Linux uses forkpty through node-pty; Windows uses ConPTY. It never invokes Docker directly.
- `terminal-bundle` validates source trees (no symlinks, submodules, or case collisions) and creates/verifies SHA-addressed Git bundles for the Windows native runtime.

Each service returns fixed, redacted metadata to the Domain. Secrets remain in process memory and are never part of API, audit, event, or Broker job records.

## Networks

`internal` connects App and Broker and is not externally routable. `edge` connects only the App so Docker Desktop can publish `127.0.0.1:4317`. The Broker has `expose` metadata but no host port.

## Commands and events

Mutations are commands with idempotency records. Domain changes and audit events are committed in SQLite. Execution and Terminal events are append-only and streamed as SSE with cursor resumption. Terminal output is also available over a local WebSocket with replay from a cursor. The Broker does not persist request bodies or credentials.

## Recovery

On process restart, the App reopens SQLite and finds `running` executions and terminal sessions. Unknown runner jobs become retryable failures; native PTYs that no longer exist become `orphaned` terminal sessions. Execution and terminal history is never rewritten.
