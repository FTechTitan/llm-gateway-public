// Pruebas del respaldo por filtro de seguridad de OpenAI. Correr: node --test proxy/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { esRechazoDeFiltro, modeloDeRespaldo, pedidoDeRespaldo } from '../lib/respaldo.mjs';

const FLAG = '{"error":{"message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy.","type":"invalid_request_error","code":"invalid_prompt"}}';
const base = { proveedor: 'openai', via: 'directo', pedido: { model: 'gpt-5.5', input: 'hola' } };

test('reconoce el rechazo del filtro y no otros 400', () => {
  assert.equal(esRechazoDeFiltro(400, FLAG), true);
  assert.equal(esRechazoDeFiltro(400, '{"error":{"message":"Unsupported parameter: temperature"}}'), false);
  assert.equal(esRechazoDeFiltro(429, FLAG), false);
});

test('el cliente manda; si no dice nada, vale el general; «no» lo apaga', () => {
  assert.equal(modeloDeRespaldo({ ...base, info: { respaldo_filtro: 'gpt-4.1' }, general: 'gpt-5.4' }), 'gpt-4.1');
  assert.equal(modeloDeRespaldo({ ...base, info: {}, general: 'gpt-5.4' }), 'gpt-5.4');
  assert.equal(modeloDeRespaldo({ ...base, info: { respaldo_filtro: 'no' }, general: 'gpt-5.4' }), null);
  assert.equal(modeloDeRespaldo({ ...base, info: {}, general: '' }), null);
});

test('no aplica a Bedrock, Anthropic ni al mismo modelo', () => {
  assert.equal(modeloDeRespaldo({ ...base, via: 'bedrock', info: {}, general: 'gpt-5.4' }), null);
  assert.equal(modeloDeRespaldo({ ...base, proveedor: 'anthropic', info: {}, general: 'gpt-5.4' }), null);
  assert.equal(modeloDeRespaldo({ ...base, info: { respaldo_filtro: 'GPT-5.5' } }), null);
});

test('a un modelo sin razonamiento se le quitan esos parámetros', () => {
  const p = { model: 'gpt-5.5', reasoning: { effort: 'low' }, reasoning_effort: 'low', input: 'x' };
  assert.deepEqual(pedidoDeRespaldo(p, 'gpt-4.1'), { model: 'gpt-4.1', input: 'x' });
  assert.equal(pedidoDeRespaldo(p, 'gpt-5.4').reasoning.effort, 'low');
  assert.equal(p.model, 'gpt-5.5');   // no muta el original
});
