import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CredentialVault } from '../../apps/api/src/credential-vault.mjs';
import { SecretRegistry } from '../../apps/api/src/secret-registry.mjs';

test('versioned Vault ciphertext is immutable and addressed by metadata reference', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r2-vault-'));
  try {
    const vault = new CredentialVault(home);
    const secretRef = `vault:${vault.putVersion('cred_fixture', 1, 'fixture-secret-value-1234')}`;
    assert.equal(vault.getBySecretRef(secretRef), 'fixture-secret-value-1234');
    assert.throws(() => vault.putVersion('cred_fixture', 1, 'replacement-secret-value'), /EEXIST/);
    assert.deepEqual(vault.entries(), ['cred_fixture.v1.vault']);
    assert.equal(fs.readFileSync(path.join(home, 'vault', 'cred_fixture.v1.vault'), 'utf8').includes('fixture-secret'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('secret registry redacts known values split across chunks and structured values', () => {
  const registry = new SecretRegistry([['fixture', 'registry-secret-sentinel-1234']]);
  const stream = registry.stream();
  const output = stream.push('before registry-secret-') + stream.push('sentinel-1234 after') + stream.flush();
  assert.equal(output, 'before [redacted] after');
  assert.deepEqual(registry.redactObject({ message: 'Bearer token-value-1234', nested: ['registry-secret-sentinel-1234'] }), {
    message: 'Bearer [redacted]', nested: ['[redacted]']
  });
});
