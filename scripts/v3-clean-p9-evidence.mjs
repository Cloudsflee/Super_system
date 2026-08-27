import fs from 'node:fs';
import path from 'node:path';

export const P9_EVIDENCE_OWNER = 'Release';
export const P9_EVIDENCE_PHASE = 'P9';
export const P9_EVIDENCE_ROOT = path.resolve('docs/evidence/v3-clean-p9-web-release-20260826');

if (process.argv.includes('--verify')) {
  const verificationFile = path.join(P9_EVIDENCE_ROOT, 'verification.json');
  if (!fs.existsSync(verificationFile)) throw new Error('p9_final_verification_missing');
  const receipt = JSON.parse(fs.readFileSync(verificationFile, 'utf8'));
  if (receipt.schema_version !== 'aiws.v3-clean.p9-verification.v1'
    || receipt.status !== 'verified'
    || receipt.provisional !== false) {
    throw new Error('p9_final_verification_invalid');
  }
  process.stdout.write(`${JSON.stringify({ status: receipt.status, provisional: receipt.provisional, run_id: receipt.run_id })}\n`);
} else {
  throw new Error('p9_release_evidence_not_generated');
}
