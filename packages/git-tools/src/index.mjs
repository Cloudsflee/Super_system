export { generateBranchName, generatePrBody } from '../../shared/index.mjs';

export function parseRemoteUrl(remoteUrl = '') {
  const https = remoteUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?/);
  return https?.groups || null;
}
