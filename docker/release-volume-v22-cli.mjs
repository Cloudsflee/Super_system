import {
  V22_SOURCE_VOLUME,
  V22_TARGET_VOLUME,
  acceptVolumeMigrationV22,
  validateV22ReleaseTarget,
  verifyClonedVolumeV22
} from './release-volume-v22.mjs';
import { releaseError } from './release-volume-validation.mjs';

export async function executeV22ReleaseCommand(command, args) {
  if (command === 'clone-verify-v22')
    return {
      matched: true,
      result: await verifyClonedVolumeV22({
        sourceRoot: required(args[0], 'source_root_required'),
        targetRoot: required(args[1], 'target_root_required'),
        manifestPath: required(args[2], 'clone_manifest_path_required'),
        archiveSha256: required(args[3], 'archive_sha_required'),
        sourceVolume: args[4] || V22_SOURCE_VOLUME,
        targetVolume: args[5] || V22_TARGET_VOLUME
      })
    };
  if (command === 'accept-v22')
    return {
      matched: true,
      result: await acceptVolumeMigrationV22({
        targetRoot: required(args[0], 'target_root_required'),
        sourceRoot: required(args[1], 'source_root_required'),
        cloneManifestPath: required(args[2], 'clone_manifest_path_required'),
        archiveSha256: required(args[3], 'archive_sha_required'),
        migrationVolume: optional(args[4]),
        sourceVolume: args[5] || V22_SOURCE_VOLUME,
        targetVolume: args[6] || V22_TARGET_VOLUME
      })
    };
  if (command === 'check-v22')
    return {
      matched: true,
      result: await validateV22ReleaseTarget(required(args[0], 'target_root_required'), args[1] || V22_TARGET_VOLUME)
    };
  return { matched: false, result: null };
}

function required(value, code) {
  if (!value || value === '-') throw releaseError(code);
  return value;
}

function optional(value) {
  return !value || value === '-' ? null : value;
}
