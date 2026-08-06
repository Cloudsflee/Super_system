# Threat Model

## Protected assets

- managed repository content and generated diffs
- Codex and GitHub credential material
- immutable execution, review, delivery, and audit evidence
- Docker daemon control capability
- V2.3 cold evidence and V3 production data

## Trust boundaries

The browser is untrusted input. The App is trusted for commands and relational data. The App-to-Broker network is authenticated but treated as replayable transport. The Broker is the only Docker control boundary. Runner output is untrusted evidence until a human Review accepts it.

## Controls

| Threat | Control |
| --- | --- |
| command replay | `Idempotency-Key` plus request hash |
| stale write | integer revision and `expected_revision` |
| Broker impersonation | HMAC method/path/timestamp/nonce/body signature |
| replayed Broker request | 30-second expiry and nonce cache |
| arbitrary container | registered image digest and closed Job Spec |
| host path escape | normalized relative path under V3 data root |
| privileged runner | fixed cap drop, no-new-privileges, read-only root, no ports |
| Docker takeover from App | no CLI package and no socket mount |
| secret disclosure | ephemeral memory reference; no events, logs, or results |
| model approval spoofing | suggestion state separate from immutable human decision |
| legacy data contamination | V2 volume name rejection in App and Broker config |
| archive deletion | cold clone, compressed archive, manifest hash, restore drill |

## Residual risks

The Docker daemon remains a high-privilege dependency for the Broker. A compromised Broker can control local containers, so it is not host-published and accepts only signed requests. GitHub and Codex probes are capability states, not readiness exceptions. External integration success must be evidenced before a formal release receipt is marked passed.

The only model egress is the fixed `aiws-runner-model` network. Public provider egress is an accepted residual risk: the Broker does not add a general-purpose proxy or a mutable domain allowlist. Credentials are delivered over the signed App-to-Broker request and exist only in the probe/Runner process lifetime.
