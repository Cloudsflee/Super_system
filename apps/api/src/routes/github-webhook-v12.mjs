import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { appCredentials, resolveGithubAppConfig } from '../github-service.mjs';
import { now } from '../../../../packages/shared/index.mjs';

export const githubWebhookV12Routes = [makeRoute('POST', '/github/webhook', webhook)];

async function webhook({ req, res, body }) {
  const delivery = String(req.headers['x-github-delivery'] || '');
  const event = String(req.headers['x-github-event'] || '');
  const signature = String(req.headers['x-hub-signature-256'] || '');
  if (!delivery || !event) throw new HttpError(400, { error: 'github_webhook_headers_required' });
  const state = await readState();
  const config = resolveGithubAppConfig(state);
  const credentials = config ? await appCredentials(config) : null;
  const secret = credentials?.webhookSecret || '';
  if (!verifySignature(req.rawBody || '', signature, secret)) throw new HttpError(401, { error: 'invalid_webhook_signature' });
  if (state.webhook_deliveries.some((item) => item.delivery_id === delivery)) return send(res, 202, { accepted: true, duplicate: true });
  const result = await mutate((data) => {
    if (data.webhook_deliveries.some((item) => item.delivery_id === delivery)) return { accepted: true, duplicate: true, event };
    const actor = owner(data);
    data.webhook_deliveries.push({ delivery_id: delivery, event, received_at: now() });
    applyEvent(data, event, body);
    addTrace(data, 'github.webhook.received', { summary: `GitHub webhook: ${event}`, data: { delivery_id: delivery, action: body.action } }, actor.id);
    return { accepted: true, duplicate: false, event };
  });
  return send(res, 202, result);
}

function applyEvent(state, event, payload) {
  const installationId = String(payload.installation?.id || '');
  const installation = state.github_installations.find((item) => String(item.installation_id) === installationId);
  if (event === 'installation' && payload.action === 'deleted' && installation) {
    installation.status = 'removed';
    removeBindings(state, installation.installation_id);
  }
  if (event === 'installation_repositories' && installation) {
    const removed = new Set((payload.repositories_removed || []).map((item) => String(item.id)));
    installation.repositories = (installation.repositories || []).filter((item) => !removed.has(String(item.id)));
    if (removed.size) removeBindings(state, installation.installation_id, removed);
    for (const repo of payload.repositories_added || []) if (!installation.repositories.some((item) => String(item.id) === String(repo.id))) installation.repositories.push({ id: String(repo.id), name: repo.name, full_name: repo.full_name, private: repo.private, selected: false, permissions: { pull: true, push: false, admin: false } });
    installation.updated_at = now();
  }
}

function removeBindings(state, installationId, repositoryIds = null) {
  state.repository_bindings = state.repository_bindings.filter((item) => String(item.installation_id) !== String(installationId) || (repositoryIds && !repositoryIds.has(String(item.repository_id))));
}

function verifySignature(raw, provided, secret) {
  if (!secret || !provided.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const left = Buffer.from(expected), right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
