# Runbook

## Local production

1. Set a 32-byte or longer secret in `docker/secrets/broker_hmac`.
2. Build the Runner and record its digest.
3. Set `AIWS_RUNNER_DIGEST` and `AIWS_RUNNER_IMAGE` in the local environment or ignored `.env`.
4. Run `corepack pnpm verify`.
5. Set `AIWS_APP_IMAGE` and `AIWS_BROKER_IMAGE` to verified image IDs or digest-pinned references.
6. Run `docker compose up -d --no-build`.
7. Confirm `GET http://127.0.0.1:4317/livez` and `/readyz` both return 200.

The Broker intentionally has no host port. Inspect it with `docker compose logs runner-broker` and signed internal probes.

## Formal release

From a clean commit, run `corepack pnpm release:build`, `corepack pnpm release:rehearse`, then `corepack pnpm release:promote`. The first command records the full gate output, verifies the reverse source patch, builds `<version>-<shortsha>` candidates, and generates image SBOMs. The second uses dynamically allocated ports and two temporary V3 volumes for real-Runner acceptance and restore. The third backs up production, validates the generated rollback, promotes tags by verified image ID, switches 4317, and removes only the exact V2.2 resources after V3 is healthy.

Never run `release:promote` unless the latest image, Docker acceptance, and recovery receipts all identify the current commit and report their required pass/candidate states.

## Backup

Stop App writes before a byte-level backup. Hash every file, copy `aiws-data-v3` to a specifically named snapshot volume, create a compressed archive, and restore it to a temporary volume. Run SQLite `integrity_check` against a tmpfs copy and compare the full manifest before marking the receipt passed.

## Recovery

Do not mount a V2 volume into V3. For V3 recovery, restore an accepted V3 archive to a new V3 volume, verify manifest and SQLite, then start the same App/Broker/Runner digests on a dynamically allocated port. Switch 4317 only after `/readyz` and the core journey pass.

## Rollback

Rollback is digest and snapshot based. Stop the current App, preserve the failed V3 volume, restore the previous accepted V3 snapshot, and recreate App/Broker with the previous digests. The rollback script must name only `aiws-v3` resources and must not use global prune.

## Cleanup

Cleanup filters exact AIWS names and `aiws.owner` labels. Never run global image, volume, container, or build-cache prune. Retain the current and previous V3 digest, two snapshots, and 14 days of logs. CAS deletion requires dry-run, quarantine, and delayed removal.
