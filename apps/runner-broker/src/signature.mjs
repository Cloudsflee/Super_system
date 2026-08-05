import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256 } from '../../api/src/crypto.mjs';
import { AppError } from '../../api/src/errors.mjs';

export function makeSignature(secret, method, requestPath, body, timestamp, nonce) {
  const canonical = [method.toUpperCase(), requestPath, String(timestamp), nonce, sha256(body)].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function createReplayGuard({ ttlMs = 30_000, clock = () => Date.now() } = {}) {
  const seen = new Map();
  return {
    verify(headers, method, requestPath, body, secret) {
      const timestamp = Number(headers['x-aiws-timestamp']);
      const nonce = String(headers['x-aiws-nonce'] || '');
      const received = String(headers['x-aiws-signature'] || '');
      if (!Number.isFinite(timestamp) || Math.abs(clock() - timestamp) > ttlMs || !nonce || !/^[a-f0-9]{64}$/.test(received)) {
        throw new AppError('invalid_signature', 'request signature is invalid or expired', { status: 401 });
      }
      for (const [key, expires] of seen) if (expires <= clock()) seen.delete(key);
      if (seen.has(nonce)) throw new AppError('replay_detected', 'replay detected: request nonce has already been used', { status: 401 });
      const expected = makeSignature(secret, method, requestPath, body, timestamp, nonce);
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(received))) throw new AppError('invalid_signature', 'request signature is invalid', { status: 401 });
      seen.set(nonce, clock() + ttlMs);
      return true;
    },
    size() { return seen.size; }
  };
}
