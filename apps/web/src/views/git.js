import { state } from '../state.js';
import { card, code, empty, esc, status } from '../ui.js';

export function gitView() {
  const changes = state.review?.code_changes || [];
  const latest = changes.at(-1);
  if (!state.project) return empty('请先选择 Project。');
  return `
    <div class="card stack">
      <h3>Git Review</h3>
      <label>Repo Path</label><input id="repo-path" value="${esc(state.project.project.repo_path || '')}" placeholder="本地 git repo 路径" />
      <div class="row"><button id="bind-repo" class="secondary">绑定 Repo</button><button id="git-branch" class="secondary">创建分支</button><button id="git-diff" class="secondary">捕获 Diff</button><button id="git-commit" class="primary">Commit</button><button id="github-pr" class="ghost">PR / 草稿</button></div>
    </div>
    ${latest ? `<div class="grid cols-2" style="margin-top:16px">${card('CodeChange', `<div class="row between"><b>${esc(latest.id)}</b>${status(latest.status)}</div><p>branch: ${esc(latest.work_branch)}</p><p>commit: ${esc(latest.head_commit)}</p><p>PR: ${esc(latest.pr_url || '草稿')}</p>`)}${card('Changed Files', code(latest.changed_files || []))}</div>` : empty('暂无 Git 变更记录')}`;
}
