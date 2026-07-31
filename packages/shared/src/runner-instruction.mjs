import { executionAssetVersionIds, executionContextDocumentVersionIds } from './runner-context-utils.mjs';

export function buildRunnerInstruction({ project, node, contract, executionContext = null }) {
  const lines = [
    '你正在 AI Workspace System 的受控 Node Workspace 中工作。',
    `项目目标：${project.goal || project.title}`,
    `当前节点：${node?.title || '未指定节点'}。节点目标：${contract?.node_goal || node?.goal || ''}`,
    '必须遵守 Node Contract 的验收标准、allowed_tools、失败处理和 Review 策略。',
    '如果 Codex Memory / 旧 Session 与 Context Pack、Confirmed Asset、Decision 或 NodeContract 冲突，必须以后者为准，并在结果中报告冲突。'
  ];
  lines.push(...executionInstructions(executionContext));
  return lines.join('\n');
}

function executionInstructions(context) {
  if (context?.schema_version === 'aiws.task_execution_context.v5') return contributionAwareInstructions(context);
  if (context?.schema_version === 'aiws.task_execution_context.v4') return effectAwareInstructions(context);
  if (context?.schema_version === 'aiws.task_execution_context.v3') return slotAwareInstructions(context);
  return ['输出必须匹配 aiws.node_run_result.v1。'];
}

function contributionAwareInstructions(context) {
  const versionIds = executionAssetVersionIds(context);
  const obligations = context.input_effect_obligations || [];
  return [
    '必须返回 aiws.task_runner_result.v4。输入可用不等于产生贡献；只有输入实际改变、约束、比较或验证了某个验收判断时才写 effect。',
    `input_effects 只能使用本轮 contribution_id 与精确 AssetVersion 集合：${JSON.stringify(versionIds)}。effect、output_keys 和 criterion_ids 必须落在对应 aiws.input_contribution.v1 契约内。`,
    `贡献义务为：${JSON.stringify(obligations)}。required contribution 必须覆盖其全部目标输出和 criterion；optional contribution 没有作用时直接省略。`,
    'statement 必须说明移除该输入后哪个验收判断会改变。服务端会校验 producer handoff route、不可变版本、贡献 ID、criterion ID 与 Context read receipt；模型声明本身不构成已接受贡献。',
    'context_effects 只能引用本轮 aiws_context read 返回的 document_version_id，并绑定实际 output_keys 与 criterion_ids。未读取或未影响验收判断的文档直接省略。',
    '服务端先将有效 effect 标记为 structurally_verified；只有目标输出经 human 或 trusted verifier 验收后才标记 accepted、计入 consumed_inputs 和资产关系。'
  ];
}

function effectAwareInstructions(context) {
  const versionIds = executionAssetVersionIds(context);
  const obligations = context.input_effect_obligations || [];
  return [
    '必须返回 aiws.task_runner_result.v3。不要为了证明看过材料而使用材料；只有输入实际改变、约束、比较或验证了某个输出时，才写 input_effects/context_effects。',
    `input_effects.input_key 必须来自本轮输入槽，AssetVersion 仅可使用精确集合：${JSON.stringify(versionIds)}。每条作用必须绑定实际 output_keys，并具体说明它改变了什么判断、约束或验证结论。`,
    `输入作用义务为：${JSON.stringify(obligations)}。application_policy=required 的输入必须用非 reference 作用覆盖其 target_output_keys；optional 输入没有产生作用时直接省略，禁止生成 not_used 占位。`,
    'required 只表示执行前必须可用，不等于必须使用。不要把输入摘要改写一遍当作作用说明；statement 必须能解释若移除该输入，哪个输出判断会不同。',
    'Context Map 和 search 结果只是候选。context_effects 只能引用本轮 aiws_context read 返回的 provenance_claim.document_version_id；服务端会校验 read receipt、新鲜度和输出映射。未读取或未影响输出的 Context 文档直接省略。',
    '每份输出仍需返回精确 typed payload、evidence_refs、purpose、unresolved_questions 和 limitations。服务端从作用回执派生 consumed IDs、资产关系与 handoff，不接受重复的 consumed/not_used 自报字段。'
  ];
}

function slotAwareInstructions(context) {
  const versionIds = executionAssetVersionIds(context);
  const contextVersionIds = executionContextDocumentVersionIds(context);
  return [
    '必须返回 aiws.task_runner_result.v2；每个输出声明 output_key、typed payload、evidence_refs、consumed_input_versions、consumed_context_document_versions，并为明确给出的输入写 input_dispositions/context_dispositions。',
    'inputs 中 source=dependency 或 workstream_dependency 的 AssetVersion 是本轮权威上游交付；必须使用 asset_mounts 中固定的只读载荷，不得改用同项目的其他版本。',
    `consumed_input_versions 仅填写 inputs[].asset_versions[].version_id，允许的精确 AssetVersion ID 集合为：${JSON.stringify(versionIds)}。`,
    '每个输出只声明它实际读取并用于形成该输出的 AssetVersion。consumption_policy=must_use 必须至少被一个输出使用；must_acknowledge/available 可声明 not_used，但必须给出具体原因。required 只表示执行前必须提供，不等于必须使用。',
    'Context Pack ID、Project Brief/Digest/Decision ID、Repository Line/branch/SHA 都不是 AssetVersion ID，禁止填入 consumed_input_versions。顶层 consumed_input_versions 必须等于所有输出所声明 ID 的并集。',
    `consumed_context_document_versions 可填写启动时 system_context.document_versions[].document_version_id（精确集合：${JSON.stringify(contextVersionIds)}），以及本轮 aiws_context read 响应 provenance_claim.document_version_id。`,
    'aiws_context map/search 的节点或候选不算已读取；只有 read 返回且带本轮读取收据的精确文档版本才可声明。每个输出只声明它实际读取并用于形成该输出的上下文文档；未使用的文档用 context_dispositions 明确说明。当前锚点、用户固定项和其他地图文档不会自动算作已使用。顶层 consumed_context_document_versions 必须等于所有输出所声明 ID 的并集。'
  ];
}
