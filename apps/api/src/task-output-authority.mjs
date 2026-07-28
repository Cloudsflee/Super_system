export function executionOutputUsage(outputKey, consumption, contextConsumption, effects) {
  return {
    inputs: consumption.byOutput.get(outputKey) || [],
    inputDispositions: consumption.byOutputDispositions.get(outputKey) || [],
    context: contextConsumption.byOutput.get(outputKey) || [],
    contextDispositions: contextConsumption.byOutputDispositions.get(outputKey) || [],
    contextSelectionId: contextConsumption.selectionId,
    contextSelectionIds: contextConsumption.selectionIdsByOutput.get(outputKey) || [],
    inputEffects: effects?.inputEffectsByOutput.get(outputKey),
    contextEffects: effects?.contextEffectsByOutput.get(outputKey)
  };
}

export function executionOutputProvenance(taskExecution, outputKey, usage, effects) {
  const contributionAware = effects?.schema_version === 'aiws.task_effects.v2',
    provenance = {
      source: 'task_execution',
      workflow_execution_id: taskExecution.workflow_execution_id,
      task_execution_id: taskExecution.id,
      executor: taskExecution.executor,
      output_key: outputKey,
      input_snapshot_hash: taskExecution.input_snapshot_hash,
      consumed_inputs: contributionAware ? [] : usage.inputs,
      input_dispositions: contributionAware ? [] : usage.inputDispositions,
      context_selection_id: usage.contextSelectionId,
      context_selection_ids: usage.contextSelectionIds,
      consumed_context_document_versions: contributionAware ? [] : usage.context,
      context_dispositions: contributionAware ? [] : usage.contextDispositions,
      ...(contributionAware
        ? {
            declared_consumed_inputs: usage.inputs,
            structurally_verified_inputs: usage.inputs,
            structurally_verified_input_dispositions: usage.inputDispositions,
            declared_context_document_versions: usage.context,
            structurally_verified_context_document_versions: usage.context,
            structurally_verified_context_dispositions: usage.contextDispositions,
            authority_status: 'structurally_verified'
          }
        : {})
    };
  if (effects)
    Object.assign(provenance, {
      effects_schema_version: effects.schema_version,
      input_effects: usage.inputEffects || [],
      context_effects: usage.contextEffects || []
    });
  return provenance;
}
