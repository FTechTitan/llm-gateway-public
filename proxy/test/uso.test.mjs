// Pruebas del conteo de tokens y costo. Correr: node --test proxy/test/
process.env.SERVICE_ROLE_KEY ??= 'x'; process.env.ANON_KEY ??= 'x'; process.env.PUBLIC_URL ??= 'http://x';
process.env.GATEWAY_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64'); process.env.GATEWAY_MASTER_KEY ??= 'm';
import test from 'node:test';
import assert from 'node:assert/strict';
const { acumular, usoVacio, lectorSSE } = await import('../lib/uso.mjs');
const { cifrar, descifrar, nuevaLlave, sha256 } = await import('../lib/cripto.mjs');

test('OpenAI chat sin streaming descuenta el caché de la entrada', () => {
  const u = acumular('openai', usoVacio(), { model: 'gpt-4.1-mini', usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } } });
  assert.deepEqual([u.modelo, u.entrada, u.cacheLectura, u.salida], ['gpt-4.1-mini', 600, 400, 50]);
});

test('OpenAI Responses en streaming toma response.completed', () => {
  let u = usoVacio();
  const leer = lectorSSE((ev) => { u = acumular('openai', u, ev); });
  leer('event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-5"}}\n\n');
  leer('data: {"type":"response.completed","response":{"model":"gpt-5","usage":{"input_tokens":120,"output_tokens":30,"input_tokens_details":{"cached_tokens":20}}}}\n');
  leer('data: [DONE]\n');
  assert.deepEqual([u.modelo, u.entrada, u.cacheLectura, u.salida], ['gpt-5', 100, 20, 30]);
});

test('OpenAI chat en streaming con trozos partidos a la mitad', () => {
  let u = usoVacio();
  const leer = lectorSSE((ev) => { u = acumular('openai', u, ev); });
  leer('data: {"choices":[{"delta":{"content":"ho"}}],"model":"gpt-4o"}\n\ndata: {"choices":[],"model":"gpt-4o","usa');
  leer('ge":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
  assert.deepEqual([u.entrada, u.salida], [10, 5]);
});

test('Anthropic en streaming suma message_start y message_delta', () => {
  let u = usoVacio();
  const leer = lectorSSE((ev) => { u = acumular('anthropic', u, ev); });
  leer('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":200,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50,"output_tokens":1}}}\n\n');
  leer('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":321}}\n\n');
  assert.deepEqual([u.modelo, u.entrada, u.cacheLectura, u.cacheEscritura, u.salida], ['claude-sonnet-4-5', 200, 1000, 50, 321]);
});

test('Anthropic sin streaming', () => {
  const u = acumular('anthropic', usoVacio(), { model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 20 } });
  assert.deepEqual([u.entrada, u.salida], [10, 20]);
});

test('cifrado de ida y vuelta y llaves con hash', () => {
  assert.equal(descifrar(cifrar('sk-secreto-123')), 'sk-secreto-123');
  const k = nuevaLlave('tfk');
  assert.ok(k.llave.startsWith('tfk_') && k.hash === sha256(k.llave) && k.prefijo.length === 10);
});

test('Audio whisper-1: usage por duración', () => {
  const u = acumular('openai', { ...usoVacio(), modelo: 'whisper-1' }, { text: 'hola', usage: { type: 'duration', seconds: 42 } });
  assert.deepEqual([u.modelo, u.segundos, u.visto], ['whisper-1', 42, true]);
});

test('Audio gpt-4o-transcribe: usage por tokens', () => {
  const u = acumular('openai', { ...usoVacio(), modelo: 'gpt-4o-transcribe' },
    { text: 'hola', usage: { type: 'tokens', input_tokens: 300, input_token_details: { audio_tokens: 290, text_tokens: 10 }, output_tokens: 20, total_tokens: 320 } });
  assert.deepEqual([u.entrada, u.salida, u.segundos], [300, 20, 0]);
});
