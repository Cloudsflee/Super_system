import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalRedactor } from '../../apps/api/src/terminal-service.mjs';

test('terminal redaction masks known secrets split across output chunks', () => {
  const secret = 'terminal-secret-sentinel-123456';
  const redactor = new TerminalRedactor([secret]);
  const output = [
    redactor.push('before terminal-secret-'),
    redactor.push('sentinel-123456 after\n'),
    redactor.push('Authorization: Bearer token-value-123456\n'),
    redactor.flush()
  ].join('');
  assert.equal(output.includes(secret), false);
  assert.match(output, /before \[redacted\] after/);
  assert.match(output, /Bearer \[redacted\]/);
});

test('terminal redaction flushes harmless command prompts without changing them', () => {
  const redactor = new TerminalRedactor(['another-sensitive-value']);
  assert.equal(redactor.push('workspace> '), 'workspace> ');
  assert.equal(redactor.flush(), '');
});

test('terminal redaction removes control sequences inserted inside a secret', () => {
  const secret = 'terminal-secret-sentinel-123456';
  const redactor = new TerminalRedactor([secret]);
  const output = redactor.push(`echo terminal-secret-se\u001b[?25lntinel-123456\r\n`) + redactor.flush();
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('\u001b'), false);
  assert.match(output, /echo \[redacted\]/);
});
