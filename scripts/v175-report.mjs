import fs from 'node:fs';
import path from 'node:path';
import { ROOT, redactText, writeFileEnsured } from './v175-lib.mjs';

const STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY']);

export class V175Report {
  constructor({ directory, runId, mode, catalog, baseline, impact, selectedIds }) {
    this.directory = directory;
    this.runId = runId;
    this.mode = mode;
    this.catalog = catalog;
    this.baseline = baseline;
    this.impact = impact;
    this.finalBaseline = null;
    this.defects = [];
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.results = new Map(catalog.tests.map((item) => [item.id, initialResult(item, selectedIds.has(item.id), mode)]));
    this.write();
  }

  setResult(id, patch) {
    const current = this.results.get(id);
    if (!current) throw new Error(`unknown report case: ${id}`);
    const next = { ...current, ...patch };
    if (!STATUSES.has(next.status)) throw new Error(`invalid V1.75 status: ${next.status}`);
    this.results.set(id, next);
    if (['FAIL', 'FLAKY'].includes(next.status) && !current.defect_recorded) {
      this.addDefect(next);
      next.defect_recorded = true;
    }
    this.write();
  }

  addDefect(result) {
    if (this.defects.length >= 100) return;
    this.defects.push({
      severity: result.priority,
      chain: result.domain,
      steps: `运行 ${formatCommand(result.command)}`,
      expected: `${result.id} 满足计划不变量并通过`,
      actual: result.summary || result.status,
      request_id: result.request_id || 'n/a',
      redaction: '日志已按 secret/header/query/body 规则脱敏并限制为 200 行、64 KiB',
      scope: `${result.layer}/${result.domain}`,
      fix_status: '未修复（按 V1.75 计划）'
    });
  }

  finalize(finalBaseline) {
    this.finalBaseline = finalBaseline;
    this.completedAt = new Date().toISOString();
    if (
      (finalBaseline.source_polluted || finalBaseline.active_workspace_polluted || !finalBaseline.resources_clean) &&
      this.defects.length < 100
    ) {
      this.defects.push({
        severity: 'P0',
        chain: 'governance',
        steps: '比较冻结前后的源码、活动 .ai-workspace 与 aiws.test_run 资源',
        expected: '除报告目录外无变化且无测试资源残留',
        actual: JSON.stringify({
          source_changes: finalBaseline.source_changes,
          active_workspace_changes: finalBaseline.active_workspace_changes,
          labeled_resources: finalBaseline.labeled_resources
        }),
        request_id: `v175_${this.runId}_pollution`,
        redaction: '仅记录路径和 SHA-256，不记录文件内容',
        scope: '测试污染/资源清理',
        fix_status: '未修复（按 V1.75 计划）'
      });
    }
    this.write();
  }

  verdict() {
    const selected = [...this.results.values()].filter((item) => item.selected);
    return classifyRunVerdict({ completed: Boolean(this.completedAt), finalBaseline: this.finalBaseline, selected });
  }

  write() {
    const results = [...this.results.values()];
    writeFileEnsured(
      path.join(this.directory, 'results.json'),
      JSON.stringify(
        {
          version: '1.75',
          run_id: this.runId,
          mode: this.mode,
          verdict: this.verdict(),
          started_at: this.startedAt,
          completed_at: this.completedAt,
          results,
          defects: this.defects,
          final_baseline: this.finalBaseline
        },
        null,
        2
      )
    );
    writeFileEnsured(path.join(this.directory, '测试结果v1.75.md'), render(this, results));
  }
}

export function classifyRunVerdict({ completed, finalBaseline, selected = [] }) {
  if (!completed || !finalBaseline) return 'INCOMPLETE';
  if (selected.some((item) => ['FAIL', 'FLAKY'].includes(item.status))) return 'FAIL';
  if (finalBaseline.source_polluted || finalBaseline.active_workspace_polluted || !finalBaseline.resources_clean)
    return 'FAIL';
  if (selected.some((item) => ['BLOCKED', 'SKIPPED'].includes(item.status))) return 'INCOMPLETE';
  return selected.every((item) => item.status === 'PASS') ? 'PASS' : 'INCOMPLETE';
}

function initialResult(item, selected, mode) {
  return {
    id: item.id,
    layer: item.layer,
    domain: item.domain,
    priority: item.priority,
    phase: 'selection',
    status: 'SKIPPED',
    duration_ms: 0,
    request_id: null,
    cleanup: 'not-required',
    command: item.command,
    selected,
    summary: selected ? '等待执行' : item.suites.includes(mode) ? '当前变更未影响此测试域' : `不属于 ${mode} suite`,
    log: null,
    first_attempt_status: null,
    rerun_status: null
  };
}

function render(report, results) {
  const counts = Object.fromEntries(
    [...STATUSES].map((status) => [status, results.filter((item) => item.status === status).length])
  );
  const lines = [
    '# AIWS 测试结果 V1.75',
    '',
    `- Run ID：\`${report.runId}\``,
    `- 模式：\`${report.mode}\``,
    `- Run verdict：**${report.verdict()}**`,
    `- 开始：${report.startedAt}`,
    `- 完成：${report.completedAt || '执行中'}`,
    `- 状态：${[...STATUSES].map((status) => `${status}=${counts[status]}`).join(' / ')}`,
    '',
    '## 冻结基线',
    '',
    `- Commit：\`${report.baseline.git.commit}\``,
    `- Branch：\`${report.baseline.git.branch || '(detached)'}\``,
    `- Dirty diff SHA-256：\`${report.baseline.git.dirty_diff_sha256}\``,
    `- 源码快照 SHA-256：\`${report.baseline.git.source_snapshot_sha256}\``,
    `- Node / pnpm：\`${report.baseline.environment.node}\` / \`${report.baseline.environment.pnpm}\``,
    `- Docker / Codex：\`${oneLine(report.baseline.environment.docker)}\` / \`${oneLine(report.baseline.environment.codex)}\``,
    `- Active state SHA-256：\`${report.baseline.active_workspace.state_sha256 || 'missing'}\``,
    '',
    '## 影响复查',
    '',
    `- Base：\`${report.impact.base}\``,
    `- 变更文件：${report.impact.files.length}`,
    `- 受影响域：${report.impact.domains.join(', ') || 'none'}`,
    `- 未分类业务文件：${report.impact.unclassified.length}`,
    '',
    '## 用例结果',
    '',
    '| ID | 层级 | 域 | 优先级 | 状态 | 耗时 | Request ID | 清理 |',
    '|---|---|---|---|---|---:|---|---|'
  ];
  for (const item of results)
    lines.push(
      `| ${item.id} | ${item.layer} | ${item.domain} | ${item.priority} | **${item.status}** | ${item.duration_ms} ms | ${item.request_id || '-'} | ${cell(item.cleanup)} |`
    );
  lines.push('', '## 结果明细', '');
  for (const item of results.filter((value) => value.selected || !value.summary.startsWith('不属于'))) {
    lines.push(
      `### ${item.id} · ${item.status}`,
      '',
      `- 阶段：${item.phase}`,
      `- 摘要：${redactText(item.summary)}`,
      `- 首次/隔离重跑：${item.first_attempt_status || '-'} / ${item.rerun_status || '-'}`,
      `- 日志：${item.log ? `\`${item.log}\`` : '-'}`,
      `- 清理：${cell(item.cleanup)}`,
      ''
    );
  }
  lines.push('## 阈值观测', '');
  lines.push(...observations(report.directory));
  lines.push('', '## 缺陷', '');
  if (!report.defects.length) lines.push('- 无已登记缺陷。');
  for (const [index, defect] of report.defects.slice(0, 100).entries()) {
    lines.push(
      `### DEF-${String(index + 1).padStart(3, '0')} · ${defect.severity}`,
      '',
      `- 业务链：${defect.chain}`,
      `- 复现步骤：${redactText(defect.steps)}`,
      `- 期望：${defect.expected}`,
      `- 实际：${redactText(defect.actual)}`,
      `- 请求 ID：${defect.request_id}`,
      `- 脱敏证据：${defect.redaction}`,
      `- 影响范围：${defect.scope}`,
      `- 修复状态：${defect.fix_status}`,
      ''
    );
  }
  lines.push('## 资源清理与污染检查', '');
  if (!report.finalBaseline) lines.push('- 执行中，尚未进行结束对比。');
  else
    lines.push(
      `- 源码污染：${report.finalBaseline.source_polluted ? '是' : '否'}`,
      `- 活动目录污染：${report.finalBaseline.active_workspace_polluted ? '是' : '否'}`,
      `- 活动目录外部漂移：${report.finalBaseline.active_workspace_external_drift ? '是' : '否'}`,
      `- 漂移归因：${report.finalBaseline.active_workspace_drift_reason}`,
      `- 冻结前 writer：${report.finalBaseline.preexisting_writers?.map((item) => `${item.pid}:${item.name}`).join(', ') || '无'}`,
      `- 测试隔离证明：${JSON.stringify(report.finalBaseline.isolation)}`,
      `- 标签资源清理：${report.finalBaseline.resources_clean ? '完成' : '存在残留'}`,
      `- 源码变化数：${report.finalBaseline.source_changes.length}`,
      `- 活动目录变化数：${report.finalBaseline.active_workspace_changes.length}`
    );
  lines.push('');
  return lines.join('\n');
}

function observations(directory) {
  const files = [
    ['coverage-summary.json', '覆盖率'],
    ['mutation-summary.json', 'Mutation'],
    ['soak-summary.json', 'Soak']
  ];
  return files.map(([name, label]) => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return `- ${label}：本模式未执行。`;
    try {
      return `- ${label}：\`${redactText(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))))}\``;
    } catch {
      return `- ${label}：结果文件无法解析。`;
    }
  });
}

function formatCommand(command) {
  return command.map((item) => (/\s/.test(item) ? JSON.stringify(item) : item)).join(' ');
}
function oneLine(value) {
  return String(value || 'unavailable')
    .split(/\r?\n/)[0]
    .replaceAll('`', "'");
}
function cell(value) {
  return redactText(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll('|', '\\|');
}
