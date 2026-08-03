import { codexMcpConfigArgs } from './codex-mcp-runtime.mjs';
import { toRunnerPath } from './container-runtime-config.mjs';

export function codexConfigArgs(mcpAccess, disabled) {
  return disabled ? [] : codexMcpConfigArgs(mcpAccess);
}

export function appendCodexQualityArgs(args, { profile, cwd, outputSchema, images, ephemeral, disableRules }) {
  if (ephemeral) args.push('--ephemeral');
  if (disableRules) args.push('-c', 'project_doc_max_bytes=0');
  if (outputSchema) args.push('--output-schema', runnerFile(outputSchema, profile, cwd));
  for (const image of images || []) args.push('--image', runnerFile(image, profile, cwd));
  return args;
}

export function reviewerMounts(profile, reviewer) {
  return reviewer ? [] : profile.mounts || [];
}

function runnerFile(value, profile, cwd) {
  return profile.kind === 'docker' ? toRunnerPath(value, cwd) : value;
}
