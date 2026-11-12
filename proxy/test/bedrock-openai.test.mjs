// Pruebas de modelos de OpenAI por Bedrock (/openai/v1/chat/completions con ruta_openai = bedrock), con Bedrock falso.
// Correr: node --test proxy/test/bedrock-openai.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

process.env.SERVICE_ROLE_KEY ??= 'x'; process.env.ANON_KEY ??= 'x'; process.env.PUBLIC_URL ??= 'http://x';
process.env.GATEWAY_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64'); process.env.GATEWAY_MASTER_KEY ??= 'maestra-de-prueba';

const { resolverModelo, cuerpoBedrockOpenAI } = await import('../lib/bedrock.mjs');
let cifrar;

// ---------- event-stream de prueba (CRC en cero: el decodificador no los usa) ----------
function mensajeES(cabeceras, payload) {
  const cab = Buffer.concat(Object.entries(cabeceras).map(([k, v]) => {
    const n = Buffer.from(k); const val = Buffer.from(v);
    const largo = Buffer.alloc(2); largo.writeUInt16BE(val.length);
    return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), largo, val]);
  }));
  const cuerpo = Buffer.from(payload);
  const total = 12 + cab.length + cuerpo.length + 4;
  const pre = Buffer.alloc(12); pre.writeUInt32BE(total, 0); pre.writeUInt32BE(cab.length, 4);
  return Buffer.concat([pre, cab, cuerpo, Buffer.alloc(4)]);
}
const chunk = (ev) => mensajeES({ ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' },
  JSON.stringify({ bytes: Buffer.from(JSON.stringify(ev)).toString('base64') }));

test('resolverModelo: ids de OpenAI en Bedrock pasan sin perfil; la tabla manda', () => {
  const mapa = new Map([['*|gpt-oss-120b', 'openai.gpt-oss-120b-1:0'], ['*|gpt-6-luna', 'us.openai.gpt-6-luna']]);
  assert.equal(resolverModelo('gpt-oss-120b', 'initech', 'us.', mapa), 'openai.gpt-oss-120b-1:0');
  assert.equal(resolverModelo('gpt-6-luna', 'initech', 'us.', mapa), 'us.openai.gpt-6-luna');
  assert.equal(resolverModelo('openai.gpt-oss-20b-1:0', 'initech', 'us.', mapa), 'openai.gpt-oss-20b-1:0');
  assert.equal(resolverModelo('global.openai.gpt-5.4', 'initech', 'us.', mapa), 'global.openai.gpt-5.4');
  assert.equal(resolverModelo('gpt-4o', 'initech', 'us.', mapa), null);
});

test('cuerpo OpenAI: quita model y stream; en streaming pide el uso', () => {
  assert.deepEqual(cuerpoBedrockOpenAI({ model: 'x', messages: [], max_completion_tokens: 5 }), { messages: [], max_completion_tokens: 5 });
  assert.deepEqual(cuerpoBedrockOpenAI({ model: 'x', stream: true, messages: [] }), { messages: [], stream_options: { include_usage: true } });
  assert.equal(cuerpoBedrockOpenAI({ messages: [] }, 'openai.gpt-oss-120b-1:0').include_reasoning, false);
  assert.equal(cuerpoBedrockOpenAI({ messages: [], include_reasoning: true }, 'openai.gpt-oss-20b-1:0').include_reasoning, true);
  assert.equal('include_reasoning' in cuerpoBedrockOpenAI({ messages: [] }, 'us.openai.gpt-6-luna'), false);
});

// ---------- flujo completo ----------
const LLAVE_BR = 'tfk_bedrock_openai_prueba';
const LLAVE_DI = 'tfk_directo_openai_prueba';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const leer = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); });
const escuchar = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const completo = { id: 'chatcmpl-1', object: 'chat.completion', model: 'openai.gpt-oss-120b-1:0',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hola' } }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
const pedidosBedrock = [];
const bedrock = http.createServer(async (req, res) => {
  const cuerpo = JSON.parse(await leer(req));
  pedidosBedrock.push({ url: req.url, headers: req.headers, cuerpo });
  if (cuerpo.messages?.[0]?.content === 'denegar') {
    res.writeHead(403, { 'content-type': 'application/json', 'x-amzn-errortype': 'AccessDeniedException:http://internal.amazon.com/' });
    return res.end('{"message":"openai.gpt-6-luna is not available for this account."}');
  }
  if (req.url.endsWith('/invoke')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(completo));
  }
  res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
  res.write(chunk({ object: 'chat.completion.chunk', model: 'openai.gpt-oss-120b-1:0', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
  res.write(chunk({ object: 'chat.completion.chunk', model: 'openai.gpt-oss-120b-1:0', choices: [{ index: 0, delta: { content: 'hola' }, finish_reason: 'stop' }] }));
  res.end(chunk({ object: 'chat.completion.chunk', model: 'openai.gpt-oss-120b-1:0', choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 25, total_tokens: 36 }, 'amazon-bedrock-invocationMetrics': { inputTokenCount: 11 } }));
});
const pedidosOpenAI = [];
const openai = http.createServer(async (req, res) => {
  await leer(req); pedidosOpenAI.push({ url: req.url, auth: req.headers.authorization });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...completo, model: 'gpt-6-luna' }));
});
const consumos = [];
const C_BR = '33333333-3333-4333-8333-333333333333';
const C_DI = '44444444-4444-4444-8444-444444444444';
const credBedrock = () => cifrar(JSON.stringify({ region: 'us-east-1', perfil: 'us.', accessKeyId: 'AKIAPRUEBA1234567890', secretAccessKey: 'secreto-de-prueba-secreto-de-prueba-1234' }));
const rest = http.createServer(async (req, res) => {
  const cuerpo = await leer(req);
  const ruta = req.url.split('?')[0];
  const json = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (ruta === '/llaves' && req.method === 'GET') {
    return json([{ id: 'k1', hash: sha(LLAVE_BR), cliente_id: C_BR, empresa_id: 'initech', activa: true },
      { id: 'k2', hash: sha(LLAVE_DI), cliente_id: C_DI, empresa_id: 'initech', activa: true }]);
  }
  if (ruta === '/clientes') {
    return json([{ id: C_BR, nombre: 'agente por bedrock', activo: true, presupuesto_usd_mensual: 0, ruta_anthropic: null, ruta_openai: 'bedrock' },
      { id: C_DI, nombre: 'agente directo', activo: true, presupuesto_usd_mensual: 0, ruta_anthropic: 'bedrock', ruta_openai: null }]);
  }
  if (ruta === '/empresas') return json([{ id: 'initech', ruta_anthropic: 'directo', ruta_openai: 'directo' }]);
  if (ruta === '/credenciales_proveedor') {
    return json([{ empresa_id: 'initech', proveedor: 'bedrock', tipo: 'api', valor_cifrado: credBedrock() },
      { empresa_id: 'initech', proveedor: 'openai', tipo: 'api', valor_cifrado: cifrar('sk-proj-real') }]);
  }
  if (ruta === '/bedrock_modelos') {
    return json([{ empresa_id: null, modelo: 'gpt-oss-120b', bedrock_id: 'openai.gpt-oss-120b-1:0' },
      { empresa_id: null, modelo: 'gpt-6-luna', bedrock_id: 'us.openai.gpt-6-luna' }]);
  }
  if (ruta === '/precios') return json([{ proveedor: 'openai', modelo: 'gpt-oss-120b', usd_in_1m: 0.15, usd_out_1m: 0.6 }]);
  if (ruta === '/consumos' && req.method === 'POST') { consumos.push(...JSON.parse(cuerpo)); res.writeHead(201); return res.end(); }
  if (req.method === 'PATCH') { res.writeHead(204); return res.end(); }
  return json([]);
});

const pB = await escuchar(bedrock); const pO = await escuchar(openai); const pR = await escuchar(rest);
const libre = http.createServer(); const PUERTO = await escuchar(libre); await new Promise((r) => libre.close(r));
Object.assign(process.env, {
  PORT: String(PUERTO), REST_URL: `http://127.0.0.1:${pR}`, AUTH_URL: 'http://127.0.0.1:9',
  OPENAI_BASE: `http://127.0.0.1:${pO}`, BEDROCK_BASE: `http://127.0.0.1:${pB}`,
});
({ cifrar } = await import('../lib/cripto.mjs'));
await import('../server.mjs');
const { volcar } = await import('../lib/registro.mjs');
after(() => setTimeout(() => process.exit(0), 50));

const BASE = `http://127.0.0.1:${PUERTO}/openai/v1`;
const llamar = (llave, cuerpo, ruta = `${BASE}/chat/completions`) => fetch(ruta, {
  method: 'POST', body: JSON.stringify(cuerpo),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${llave}` },
});

test('openai por bedrock con streaming: SSE de OpenAI con [DONE], sin métricas de AWS, consumo con precio de OpenAI', async () => {
  const r = await llamar(LLAVE_BR, { model: 'gpt-oss-120b', stream: true, messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-gw-ruta'), 'bedrock');
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const sse = await r.text();
  assert.match(sse, /^data: \{"object":"chat.completion.chunk"/);
  assert.match(sse, /data: \[DONE\]\n\n$/);
  assert.doesNotMatch(sse, /invocationMetrics/);
  const p = pedidosBedrock.at(-1);
  assert.equal(p.url, '/model/openai.gpt-oss-120b-1%3A0/invoke-with-response-stream');
  assert.match(p.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAPRUEBA1234567890\//);
  assert.equal(p.cuerpo.model, undefined);
  assert.equal(p.cuerpo.stream, undefined);
  assert.equal(p.cuerpo.stream_options.include_usage, true);
  assert.equal(p.cuerpo.include_reasoning, false);
  await volcar();
  const c = consumos.at(-1);
  assert.deepEqual([c.via, c.proveedor, c.tokens_in, c.tokens_out, c.precio_conocido], ['bedrock', 'openai', 11, 25, true]);
  assert.ok(c.costo_usd > 0);
});

test('openai por bedrock sin streaming: chat.completion tal cual y perfil us. de la tabla', async () => {
  const r = await llamar(LLAVE_BR, { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, 'hola');
  assert.equal(pedidosBedrock.at(-1).url, '/model/us.openai.gpt-6-luna/invoke');
});

test('openai por bedrock: error de AWS en formato OpenAI; responses y modelo sin traducción -> 400', async () => {
  const den = await llamar(LLAVE_BR, { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'denegar' }] });
  assert.equal(den.status, 403);
  const e = await den.json();
  assert.equal(e.error.type, 'permission_error');
  assert.match(e.error.message, /not available for this account/);
  const resp = await llamar(LLAVE_BR, { model: 'gpt-oss-120b', input: 'hola' }, `${BASE}/responses`);
  assert.equal(resp.status, 400);
  assert.equal((await resp.json()).error.type, 'not_supported_on_bedrock');
  const sinMapa = await llamar(LLAVE_BR, { model: 'gpt-4o', messages: [] });
  assert.equal(sinMapa.status, 400);
  assert.equal((await sinMapa.json()).error.type, 'model_not_mapped');
});

test('ruta_anthropic no afecta a OpenAI: el cliente hereda ruta_openai directo y va a OpenAI con la llave real', async () => {
  const antes = pedidosBedrock.length;
  const r = await llamar(LLAVE_DI, { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-gw-ruta'), 'directo');
  assert.equal(pedidosOpenAI.at(-1).auth, 'Bearer sk-proj-real');
  assert.equal(pedidosBedrock.length, antes);
});
