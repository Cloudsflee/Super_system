import {
  parseOutcomeContract,
  parseQualityRubric,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';
import { HttpError } from './http.mjs';

export function requireWorkflowExecutionProtocols(workflow) {
  requireProtocolFields(workflow);
  let contract, rubric;
  try {
    contract = parseOutcomeContract(workflow.outcome_contract);
    rubric = parseQualityRubric(workflow.quality_rubric);
  } catch (error) {
    throw invalidProtocol(error);
  }
  const outcomeContractHash = protocolHash(contract),
    qualityRubricHash = protocolHash(rubric);
  assertProtocolHashes(workflow, outcomeContractHash, qualityRubricHash);
  return {
    contract,
    rubric,
    outcome_contract_hash: outcomeContractHash,
    quality_rubric_hash: qualityRubricHash
  };
}

function requireProtocolFields(workflow) {
  if (!workflow.outcome_contract)
    throw new HttpError(409, { error: 'workflow_outcome_contract_required', field_path: '/outcome_contract' });
  if (!workflow.quality_rubric)
    throw new HttpError(409, { error: 'workflow_quality_rubric_required', field_path: '/quality_rubric' });
}

function assertProtocolHashes(workflow, outcomeContractHash, qualityRubricHash) {
  if (workflow.outcome_contract_hash && workflow.outcome_contract_hash !== outcomeContractHash)
    throw new HttpError(409, { error: 'workflow_outcome_contract_hash_mismatch' });
  if (workflow.quality_rubric_hash && workflow.quality_rubric_hash !== qualityRubricHash)
    throw new HttpError(409, { error: 'workflow_quality_rubric_hash_mismatch' });
}

function invalidProtocol(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(409, {
    error: 'workflow_execution_protocol_invalid',
    protocol: error?.payload?.protocol || null,
    field_path: error?.payload?.field_path || '',
    issues: error?.payload?.issues || []
  });
}
