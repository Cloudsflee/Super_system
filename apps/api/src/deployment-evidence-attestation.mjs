import { HttpError } from './http.mjs';
import { DEPLOYMENT_RUNTIME_VERIFIER } from './deployment-evidence-verifier.mjs';

export { DEPLOYMENT_RUNTIME_VERIFIER };

export function assertDeploymentSystemEvidence(state, asset, version, evidence, execution) {
  const context = deploymentEvidenceContext(state, version, evidence);
  assertReceipt(context, version, execution);
  assertSource(state, context, execution);
  assertPayload(context, version);
  if (asset.confirmation_policy !== 'system_evidence')
    throw new HttpError(409, { error: 'system_evidence_policy_mismatch' });
}

function deploymentEvidenceContext(state, version, evidence) {
  const receipt = evidence.deployment_verification,
    manifestEntries = version.manifest?.entries || [],
    receiptEntries = Array.isArray(receipt?.entries) ? receipt.entries : [],
    viewports = Array.isArray(receipt?.required_viewports) ? receipt.required_viewports : [];
  return {
    receipt,
    run: state.node_runs.find((item) => item.id === receipt?.node_run_id),
    manifestEntries,
    entries: new Map(manifestEntries.map((item) => [item.path, item])),
    receiptEntries,
    receiptPaths: new Set(receiptEntries.map((item) => item?.path)),
    viewports,
    compose: receipt?.compose_authorization
  };
}

function assertReceipt(context, version, execution) {
  const { receipt, viewports, compose } = context;
  if (
    receipt?.schema_version !== 'aiws.deployment_runtime_receipt.v1' ||
    receipt.verifier !== DEPLOYMENT_RUNTIME_VERIFIER ||
    receipt.task_execution_id !== execution.id ||
    receipt.repository_sha !== version.repository_sha ||
    !/^[a-f0-9]{64}$/.test(String(receipt.report_sha256 || '')) ||
    !validTarget(receipt.target) ||
    !Number.isFinite(Date.parse(receipt.verified_at)) ||
    !viewports.length ||
    new Set(viewports).size !== viewports.length ||
    viewports.some((width) => !Number.isInteger(width) || width < 320 || width > 7680) ||
    compose?.schema_version !== 'aiws.compose_target_authorization.v1' ||
    !/^[a-f0-9]{64}$/.test(String(compose.compose_config_sha256 || '')) ||
    Number(new URL(receipt.target).port) !== compose.published_port ||
    !compose.service ||
    !Number.isInteger(compose.target_port) ||
    compose.host_ip !== '127.0.0.1'
  )
    throw new HttpError(409, { error: 'deployment_runtime_evidence_incomplete' });
}

function assertSource(state, context, execution) {
  const { receipt, run } = context;
  if (
    !run ||
    run.task_execution_id !== execution.id ||
    run.runner !== 'codex_docker' ||
    run.status !== 'succeeded' ||
    run.raw_output_file_ref_id !== receipt.raw_output_file_ref_id ||
    !state.file_refs.some((item) => item.id === receipt.raw_output_file_ref_id)
  )
    throw new HttpError(409, { error: 'deployment_runtime_source_invalid' });
}

function assertPayload(context, version) {
  const { receipt, manifestEntries, entries, receiptEntries, receiptPaths, viewports } = context;
  if (
    version.manifest?.schema_version !== 'aiws.asset_manifest.v1' ||
    version.manifest.payload_kind !== 'file_set' ||
    version.manifest.media_type !== 'application/vnd.aiws.deployment-evidence+json' ||
    version.manifest.metadata?.schema_version !== receipt.schema_version ||
    version.manifest.metadata?.verifier !== receipt.verifier ||
    receiptEntries.length !== manifestEntries.length ||
    receiptEntries.length !== viewports.length + 1 ||
    receiptPaths.size !== receiptEntries.length ||
    receiptEntries.some((item) => !matchingEntry(entries, item)) ||
    !matchingReport(entries, receipt) ||
    viewports.some((width) => !matchingScreenshot(entries, width))
  )
    throw new HttpError(409, { error: 'deployment_runtime_payload_invalid' });
}

function matchingEntry(entries, item) {
  if (!item || typeof item !== 'object') return false;
  const entry = entries.get(item.path);
  return Boolean(
    entry &&
    entry.sha256 === item.sha256 &&
    entry.size_bytes === item.size_bytes &&
    entry.role === item.role &&
    entry.media_type === item.media_type
  );
}

function matchingReport(entries, receipt) {
  const report = entries.get('deployment-verification.json');
  return Boolean(
    report &&
    report.sha256 === receipt.report_sha256 &&
    report.role === 'report' &&
    report.media_type === 'application/json'
  );
}

function matchingScreenshot(entries, width) {
  const screenshot = entries.get(`screenshots/${width}.png`);
  return Boolean(screenshot && screenshot.role === 'screenshot' && screenshot.media_type === 'image/png');
}

function validTarget(value) {
  return /^https?:\/\/host\.docker\.internal:\d+$/.test(String(value || ''));
}
