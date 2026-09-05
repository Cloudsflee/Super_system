# Post-P10 development reliability maintenance evidence

Owner: Platform Governance and Operations

Phase: Post-P10 maintenance under D-040 (no new governance phase)

Baseline: `5f2be38845d36236637c7f22a1b4df5611a6175b`

This directory records the independent verification and rollback artifacts for
the no-Shell Gate executor, R5 immutable source proof, dual-channel
verification, and read-only development receipt. It does not supersede or
modify any P1-P10 Evidence and has no Catalog promotion authority.

Required final roles:

- `modified-artifact.tgz`
- `change.patch`
- `verification.json`
- `rollback.ps1`

The verification receipt records literal commands, outputs, exit statuses,
performance measurements, artifact hashes, and isolated dry-run/actual rollback
results. Local failed/advisory Gate receipts remain under the ignored
`.ai-workspace/gate-receipts/` directory.

Maintenance tools:

- `capture.mjs <label> <command> [args...]` stores exclusive redacted command
  records and live diagnostic logs in the ignored maintenance directory.
- `round2-probe.mjs [round2-run-id]` starts an isolated project or resumes the
  same project after a harness error. It never supplies a fabricated generated
  candidate, edits product code, or mutates Draft PR #2.
- `package.mjs` produces and reopens all artifact roles, reproduces the baseline
  R5 failure, executes the modified R5 replay, and restores an isolated clone
  and v9 state copy using `rollback.ps1`.
- `package.mjs --verify` checks the artifact inventory bidirectionally and
  verifies every hash and the actual rollback receipt.

Round 2 currently stops at `round2_generation_workstreams_mismatch`: the
default server generator returns `inspect` instead of the six fixed
workstreams. The default Host runner also emits a fixed status without running
the product's unit tests. These are business blockers, not missing external
Live credentials. Execution, Outcome, and Draft Delivery are not claimed.
