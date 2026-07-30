import {
  V21_SOURCE_VOLUME,
  V21_TARGET_VOLUME,
  acceptVolumeMigrationV21,
  validateV21ReleaseTarget,
  verifyClonedVolumeV21
} from './release-volume-v21.mjs';
import { releaseError } from './release-volume-validation.mjs';

export async function executeV21ReleaseCommand(command, args) {
  if (command === 'clone-verify-v21')
    return {
      matched: true,
      result: await verifyClonedVolumeV21({
        sourceRoot: required(args[0], 'source_root_required'),
        targetRoot: required(args[1], 'target_root_required'),
        manifestPath: required(args[2], 'clone_manifest_path_required'),
        archiveSha256: required(args[3], 'archive_sha_required'),
        sourceVolume: args[4] || V21_SOURCE_VOLUME,
        targetVolume: args[5] || V21_TARGET_VOLUME
      })
    };
  if (command === 'accept-v21')
    return {
      matched: true,
      result: await acceptVolumeMigrationV21({
        targetRoot: required(args[0], 'target_root_required'),
        sourceRoot: required(args[1], 'source_root_required'),
        cloneManifestPath: required(args[2], 'clone_manifest_path_required'),
        archiveSha256: required(args[3], 'archive_sha_required'),
        migrationVolume: optional(args[4]),
        sourceVolume: args[5] || V21_SOURCE_VOLUME,
        targetVolume: args[6] || V21_TARGET_VOLUME
      })
    };
  if (command === 'check-v21')
    return {
      matched: true,
      result: await validateV21ReleaseTarget(required(args[0], 'target_root_required'), args[1] || V21_TARGET_VOLUME, {
        deferProjection: args[2] === 'defer-projection'
      })
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
