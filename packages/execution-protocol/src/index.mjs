import { createHash } from 'node:crypto';
import { z } from 'zod';

export const OUTCOME_CONTRACT_SCHEMA = 'aiws.outcome_contract.v1';
export const QUALITY_RUBRIC_SCHEMA = 'aiws.quality_rubric.v1';
export const FAILURE_ENVELOPE_SCHEMA = 'aiws.failure_envelope.v1';
export const EXECUTION_CHECKPOINT_SCHEMA = 'aiws.execution_checkpoint.v1';
export const DEPLOYMENT_EVIDENCE_SCHEMA = 'aiws.deployment_evidence.v2';
export const CONTEXT_SELECTION_SCHEMA_V2 = 'aiws.context_selection.v2';
export const CONTEXT_PACK_SCHEMA_V5 = 'aiws.context_pack.v5';

export const EXECUTION_STAGES = Object.freeze([
  'preflight',
  'execute',
  'collect',
  'verify',
  'attest',
  'promote',
  'finalize'
]);
export const COMPLETION_STATUSES = Object.freeze([
  'pending',
  'completed',
  'completed_with_gaps',
  'waived',
  'failed',
  'legacy_unassessed'
]);
export const OUTCOME_EVALUATION_STATUSES = Object.freeze(['pending', 'satisfied', 'unsatisfied', 'waived', 'error']);

const identifier = z.string().trim().min(1).max(200);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.iso.datetime({ offset: true });
const jsonPointer = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/);
const jsonValue = z.json();
const evidenceRefs = z.array(identifier).max(500).default([]);

export const OutcomeRequirementDefinitionSchema = z
  .object({
    id: identifier,
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().min(1).max(4000).optional(),
    mandatory: z.boolean().default(true),
    scope: z.enum(['workflow', 'task', 'delivery', 'context', 'security', 'content', 'metric', 'manual']),
    task_id: identifier.nullable().optional(),
    order: z.number().int().min(0).max(100000),
    evaluator: z.enum([
      'task_acceptance',
      'effect_claim',
      'delivery_receipt',
      'trusted_metric',
      'context_freshness',
      'manual_review',
      'json_schema',
      'evidence_refs',
      'claim_coverage',
      'human_score'
    ]),
    expected: jsonValue,
    waivable: z.boolean().default(true),
    evaluator_config: z.record(z.string(), jsonValue).default({})
  })
  .strict();

export const OutcomeContractSchema = z
  .object({
    schema_version: z.literal(OUTCOME_CONTRACT_SCHEMA),
    version: z.number().int().positive(),
    source: z.enum(['declared', 'legacy_derived']).default('declared'),
    requirements: z.array(OutcomeRequirementDefinitionSchema).min(1).max(500)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set();
    for (let index = 0; index < value.requirements.length; index += 1) {
      const requirement = value.requirements[index];
      if (ids.has(requirement.id))
        context.addIssue({ code: 'custom', path: ['requirements', index, 'id'], message: 'duplicate_requirement_id' });
      ids.add(requirement.id);
      if (['context', 'security'].includes(requirement.scope) && requirement.waivable)
        context.addIssue({ code: 'custom', path: ['requirements', index, 'waivable'], message: 'scope_not_waivable' });
    }
  });

export const QualityRubricCriterionSchema = z
  .object({
    id: identifier,
    title: z.string().trim().min(1).max(500),
    evaluator: z.enum(['json_schema', 'evidence_refs', 'claim_coverage', 'trusted_metric', 'human_score']),
    mandatory: z.boolean().default(true),
    applicable: z.boolean(),
    expected: jsonValue,
    authority_mapping: z.record(z.string(), identifier).default({})
  })
  .strict();

export const QualityRubricSchema = z
  .object({
    schema_version: z.literal(QUALITY_RUBRIC_SCHEMA),
    version: z.number().int().positive(),
    criteria: z.array(QualityRubricCriterionSchema).min(1).max(500)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set();
    for (let index = 0; index < value.criteria.length; index += 1) {
      if (ids.has(value.criteria[index].id))
        context.addIssue({ code: 'custom', path: ['criteria', index, 'id'], message: 'duplicate_criterion_id' });
      ids.add(value.criteria[index].id);
    }
  });

export const FailureEnvelopeSchema = z
  .object({
    schema_version: z.literal(FAILURE_ENVELOPE_SCHEMA),
    code: identifier,
    stage: z.enum(EXECUTION_STAGES),
    category: z.enum([
      'precondition',
      'capability',
      'network',
      'runner',
      'verifier',
      'integrity',
      'policy',
      'context',
      'internal'
    ]),
    retryable: z.boolean(),
    message: z.string().trim().max(2000).nullable().default(null),
    field_path: jsonPointer.nullable().default(null),
    details: z.record(z.string(), jsonValue).default({}),
    cause_codes: z.array(identifier).max(50).default([]),
    occurred_at: isoDate
  })
  .strict();

export const ExecutionCheckpointSchema = z
  .object({
    schema_version: z.literal(EXECUTION_CHECKPOINT_SCHEMA),
    id: identifier,
    workflow_execution_id: identifier,
    task_execution_id: identifier.nullable(),
    stage: z.enum(EXECUTION_STAGES),
    sequence: z.number().int().positive(),
    attempt: z.number().int().positive(),
    status: z.enum(['completed', 'failed']),
    input_hash: sha256,
    output_hash: sha256.nullable(),
    identity: z
      .object({
        input_snapshot_hash: sha256.nullable(),
        repository_sha: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .nullable(),
        runner_image_digest: z.string().min(1).max(300).nullable(),
        policy_hash: sha256,
        verifier_version: identifier,
        cas_hash: sha256.nullable()
      })
      .strict(),
    cas_refs: z
      .array(
        z
          .object({
            sha256,
            size_bytes: z.number().int().nonnegative(),
            media_type: z.string().trim().min(1).max(200)
          })
          .strict()
      )
      .max(500)
      .default([]),
    duration_ms: z.number().int().nonnegative(),
    queue_ms: z.number().int().nonnegative().default(0),
    failure: FailureEnvelopeSchema.nullable(),
    replay_of_checkpoint_id: identifier.nullable(),
    started_at: isoDate,
    completed_at: isoDate,
    immutable: z.literal(true)
  })
  .strict();

const HttpCheckSchema = z
  .object({
    method: z.enum(['GET', 'HEAD']),
    url: z.string().url(),
    status: z.number().int().min(100).max(599),
    passed: z.boolean(),
    content_type: z.string().trim().max(300).nullable().default(null),
    body_sha256: sha256.nullable().default(null)
  })
  .strict();
const ComposeServiceSchema = z
  .object({
    name: identifier,
    image: z.string().trim().min(1).max(500),
    digest: z.string().trim().min(1).max(500).nullable().default(null),
    published_ports: z.array(z.string().trim().min(1).max(100)).max(100).default([])
  })
  .strict();
const StaticAssetSchema = z
  .object({
    path: z.string().trim().min(1).max(2000),
    media_type: z.string().trim().min(1).max(300),
    sha256,
    size_bytes: z.number().int().nonnegative()
  })
  .strict();

export const DeploymentEvidenceV2Schema = z
  .object({
    schema_version: z.literal(DEPLOYMENT_EVIDENCE_SCHEMA),
    target: z
      .object({
        kind: z.enum(['http', 'compose']),
        origin: z.string().url(),
        repository_sha: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .nullable()
          .default(null)
      })
      .strict(),
    http_checks: z.array(HttpCheckSchema).min(1).max(500),
    compose_services: z.array(ComposeServiceSchema).max(200).default([]),
    static_assets: z.array(StaticAssetSchema).max(2000).default([]),
    security_headers: z.record(z.string(), z.string()).default({}),
    evidence_refs: evidenceRefs,
    collected_at: isoDate,
    collector_version: identifier
  })
  .strict();

export class ProtocolValidationError extends Error {
  constructor(protocol, issues) {
    const normalized = issues.map((issue) => {
      const path =
        issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.length
          ? [...issue.path, issue.keys[0]]
          : issue.path;
      return {
        path: pathToJsonPointer(path),
        code: String(issue.code || 'invalid'),
        message: String(issue.message || 'invalid_value')
      };
    });
    super(`${protocol}_invalid`);
    this.name = 'ProtocolValidationError';
    this.code = 'execution_protocol_invalid';
    this.status = 400;
    this.payload = { error: this.code, protocol, field_path: normalized[0]?.path || '', issues: normalized };
  }
}

export function parseProtocol(schema, value, protocol = 'execution_protocol') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProtocolValidationError(protocol, parsed.error.issues);
  return parsed.data;
}

export function parseOutcomeContract(value) {
  return parseProtocol(OutcomeContractSchema, value, OUTCOME_CONTRACT_SCHEMA);
}

export function parseQualityRubric(value) {
  return parseProtocol(QualityRubricSchema, value, QUALITY_RUBRIC_SCHEMA);
}

export function parseFailureEnvelope(value) {
  return parseProtocol(FailureEnvelopeSchema, value, FAILURE_ENVELOPE_SCHEMA);
}

export function parseExecutionCheckpoint(value) {
  return parseProtocol(ExecutionCheckpointSchema, value, EXECUTION_CHECKPOINT_SCHEMA);
}

export function parseDeploymentEvidenceV2(value) {
  return parseProtocol(DeploymentEvidenceV2Schema, value, DEPLOYMENT_EVIDENCE_SCHEMA);
}

export function protocolHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export function pathToJsonPointer(path) {
  if (!Array.isArray(path) || !path.length) return '';
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

export function failureEnvelope(
  error,
  { stage, category = 'internal', retryable = false, details = {}, clock = () => new Date() } = {}
) {
  const payload = error?.payload && typeof error.payload === 'object' ? error.payload : {};
  return parseFailureEnvelope({
    schema_version: FAILURE_ENVELOPE_SCHEMA,
    code: cleanCode(payload.error || error?.code || 'execution_stage_failed'),
    stage,
    category,
    retryable: Boolean(error?.retryable ?? payload.retryable ?? retryable),
    message: typeof error?.message === 'string' ? error.message.slice(0, 2000) : null,
    field_path: typeof payload.field_path === 'string' ? payload.field_path : null,
    details: sanitizeJson(details),
    cause_codes: [],
    occurred_at: clock().toISOString()
  });
}

export function normalizeDeploymentEvidenceV2(
  value,
  { collectedAt = new Date().toISOString(), collectorVersion = 'legacy-adapter.v1' } = {}
) {
  if (value?.schema_version === DEPLOYMENT_EVIDENCE_SCHEMA) return parseDeploymentEvidenceV2(value);
  const source = legacyDeploymentEvidenceSource(value);
  const checks = normalizeLegacyHttpChecks(source);
  const origin = source.target?.origin || source.origin || source.base_url || checks[0]?.url;
  const rawServices = source.compose_services || source.compose?.services || source.services || [];
  const services = normalizeComposeServices(rawServices);
  const normalized = {
    schema_version: DEPLOYMENT_EVIDENCE_SCHEMA,
    target: {
      kind: services.length ? 'compose' : 'http',
      origin,
      repository_sha: source.target?.repository_sha || source.repository_sha || null
    },
    http_checks: checks,
    compose_services: services,
    static_assets: normalizeLegacyStaticAssets(source),
    security_headers: source.security_headers || source.headers || {},
    evidence_refs: source.evidence_refs || [],
    collected_at: source.collected_at || collectedAt,
    collector_version: source.collector_version || collectorVersion
  };
  return parseDeploymentEvidenceV2(normalized);
}

function legacyDeploymentEvidenceSource(value) {
  return value?.deployment_evidence || value?.evidence || value || {};
}

function normalizeLegacyHttpChecks(source) {
  const raw = source.http_checks || source.checks || source.api?.checks || source.api?.GET || source.api?.get || [];
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((check) => normalizeHttpCheck(check, source));
}

function normalizeLegacyStaticAssets(source) {
  const raw = source.static_assets || source.assets || source.browser?.static_assets || [];
  return (Array.isArray(raw) ? raw : []).filter(Boolean).map((asset) => ({
    path: String(asset.path || asset.url || ''),
    media_type: String(asset.media_type || asset.content_type || mediaTypeFromPath(asset.path || asset.url)),
    sha256: String(asset.sha256 || asset.content_sha256 || ''),
    size_bytes: Number(asset.size_bytes ?? asset.bytes ?? 0)
  }));
}

function normalizeHttpCheck(check, source) {
  const method = String(check.method || check.verb || (check.GET || check.get ? 'GET' : 'GET')).toUpperCase();
  const nested = check.GET || check.get || check;
  const status = Number(nested.status ?? nested.status_code ?? nested.response?.status ?? 0);
  return {
    method: method === 'HEAD' ? 'HEAD' : 'GET',
    url: String(nested.url || nested.href || source.origin || source.base_url || ''),
    status,
    passed: nested.passed === undefined ? status >= 200 && status < 400 : Boolean(nested.passed),
    content_type: nested.content_type || nested.headers?.['content-type'] || null,
    body_sha256: nested.body_sha256 || nested.sha256 || null
  };
}

function normalizeComposeServices(value) {
  if (Array.isArray(value)) return value.map(normalizeComposeService);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([name, service]) => normalizeComposeService({ name, ...(service || {}) }));
}

function normalizeComposeService(service) {
  return {
    name: String(service.name || service.service || ''),
    image: String(service.image || service.container_image || ''),
    digest: service.digest || service.image_digest || null,
    published_ports: (service.published_ports || service.ports || []).map(String)
  };
}

function mediaTypeFromPath(value) {
  const pathname = String(value || '')
    .split(/[?#]/, 1)[0]
    .toLowerCase();
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return 'text/javascript';
  if (pathname.endsWith('.json')) return 'application/json';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function sanitizeJson(value) {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      /token|secret|password|cookie|authorization/i.test(key) ? '[REDACTED]' : item
    )
  );
}

function cleanCode(value) {
  const candidate = String(value || '')
    .trim()
    .slice(0, 200);
  return /^[a-z0-9_.-]+$/i.test(candidate) ? candidate : 'execution_stage_failed';
}
