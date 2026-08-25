import { PlatformError } from './platform-error.mjs';

export function buildDockerParserArgs(job, { image = null, inputFile, jobFile, outputRoot } = {}) {
  const reference = image || job.worker_image_digest;
  if (!/^([a-z0-9]+(?:[._/-][a-z0-9]+)*)?@?sha256:[a-f0-9]{64}$/i.test(String(reference || ''))) {
    throw new PlatformError('parser_digest_invalid', 'parser image must be digest pinned', {}, 422);
  }
  for (const value of [inputFile, jobFile, outputRoot]) {
    if (!value) throw new PlatformError('parser_mount_invalid', 'parser mount path is required', {}, 500);
  }
  return [
    'run', '--rm', '--init', '--name', `aiws-parser-${job.parser_job_id}`,
    '--label', 'aiws.owner=v3-clean', '--label', `aiws.parser-job=${job.parser_job_id}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only', '--network', 'none',
    '--cpus', '1', '--memory', '536870912', '--pids-limit', '64', '--tmpfs', '/tmp:size=134217728,mode=1777',
    '--mount', `type=bind,src=${inputFile},dst=/input/input.bin,readonly`,
    '--mount', `type=bind,src=${jobFile},dst=/input/job.json,readonly`,
    '--mount', `type=bind,src=${outputRoot},dst=/output`,
    reference, '--job', '/input/job.json', '--input', '/input/input.bin', '--output', '/output'
  ];
}
