import { state } from '../state.js';
import { card, empty, esc, status } from '../ui.js';

export function assetsView() {
  const assets = state.workspace?.assets || state.review?.assets || [];
  const digests = state.workspace?.digests || state.review?.digests || [];
  return `
    <div class="grid cols-2">
      ${card('Asset Review', assets.length ? assets.map((asset) => `<div class="card soft"><div class="row between"><b>${esc(asset.title)}</b>${status(asset.status)}</div><p>${esc(asset.summary)}</p><div class="row"><button class="confirm-asset secondary" data-id="${asset.id}">确认资产</button><button class="reject-asset ghost" data-id="${asset.id}">拒绝</button></div></div>`).join('') : '<p class="muted">暂无资产候选</p>')}
      ${card('Workspace Digest', `<button id="generate-digest" class="primary full">生成并确认 Digest</button><div class="divider"></div>${digests.length ? digests.map((digest) => `<div><b>v${digest.version}</b><p>${esc(digest.summary)}</p></div>`).join('<div class="divider"></div>') : '<p class="muted">暂无 Digest</p>'}`)}
    </div>`;
}
