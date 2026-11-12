import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sesionClaudeCode } from '../lib/sesion.mjs';

const S = '0d1c8866-1a2b-4c3d-8e9f-001122334455';

test('cabecera x-claude-code-session-id', () => {
  assert.equal(sesionClaudeCode({ 'x-claude-code-session-id': S.toUpperCase() }, null), S);
});
test('metadata.user_id en JSON (versiones nuevas)', () => {
  assert.equal(sesionClaudeCode({}, { metadata: { user_id: JSON.stringify({ device_id: 'x', session_id: S }) } }), S);
});
test('metadata.user_id con _session_ (versiones anteriores)', () => {
  assert.equal(sesionClaudeCode({}, { metadata: { user_id: `user_abc_account_${S}_session_${S}` } }), S);
});
test('sin sesión o con basura', () => {
  assert.equal(sesionClaudeCode({}, null), null);
  assert.equal(sesionClaudeCode({ 'x-claude-code-session-id': 'nope' }, { metadata: { user_id: '{malo' } }), null);
  assert.equal(sesionClaudeCode({}, { metadata: { user_id: 'cliente-n8n' } }), null);
});
