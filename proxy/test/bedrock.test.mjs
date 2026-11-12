// Pruebas del adaptador de Bedrock: firma, event-stream, modelos, credencial y flujo completo con Bedrock falso.
// Correr: node --test proxy/test/bedrock.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

process.env.SERVICE_ROLE_KEY ??= 'x'; process.env.ANON_KEY ??= 'x'; process.env.PUBLIC_URL ??= 'http://x';
process.env.GATEWAY_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64'); process.env.GATEWAY_MASTER_KEY ??= 'maestra-de-prueba';

const { firmarSigV4, decodificarEventStream, resolverModelo, leerCredencialBedrock, cuerpoBedrock, errorDeBedrock } = await import('../lib/bedrock.mjs');
let cifrar;   // se importa después de fijar el entorno: config.mjs lo congela al cargarse

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

test('SigV4: vector oficial get-vanilla de AWS', () => {
  const h = firmarSigV4({
    metodo: 'GET', host: 'example.amazonaws.com', ruta: '/', cuerpo: '', region: 'us-east-1', servicio: 'service',
    cred: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    fecha: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('event-stream: decodifica mensajes partidos en trozos arbitrarios', async () => {
  const todo = Buffer.concat([chunk({ type: 'message_start' }), chunk({ type: 'message_stop' })]);
  async function* trozos() { for (let i = 0; i < todo.length; i += 7) yield todo.subarray(i, i + 7); }
  const tipos = [];
  for await (const m of decodificarEventStream(trozos())) {
    tipos.push(JSON.parse(Buffer.from(JSON.parse(m.payload).bytes, 'base64')).type);
  }
  assert.deepEqual(tipos, ['message_start', 'message_stop']);
});

test('resolverModelo: tabla, nombre con fecha, ids de Bedrock y desconocidos', () => {
  const mapa = new Map([['*|claude-haiku-4-5', 'anthropic.claude-haiku-4-5-20251001-v1:0'], ['initech|claude-haiku-4-5', 'eu.anthropic.x-v1:0']]);
  assert.equal(resolverModelo('claude-haiku-4-5', 'globex', 'us.', mapa), 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(resolverModelo('claude-haiku-4-5', 'initech', 'us.', mapa), 'eu.anthropic.x-v1:0');
  assert.equal(resolverModelo('claude-sonnet-4-5-20250929', 'globex', '', mapa), 'anthropic.claude-sonnet-4-5-20250929-v1:0');
  assert.equal(resolverModelo('us.anthropic.claude-y-v1:0', 'globex', 'global.', mapa), 'us.anthropic.claude-y-v1:0');
  assert.equal(resolverModelo('anthropic.claude-y-v1:0', 'globex', 'global.', mapa), 'global.anthropic.claude-y-v1:0');
  assert.equal(resolverModelo('gpt-4o', 'globex', '', mapa), null);
});

test('credencial: valida region, perfil y llaves', () => {
  assert.deepEqual(leerCredencialBedrock('{"region":"us-east-1","perfil":"us.","apiKey":"ABSKxxxxxxxxxxxxxxxxxxxxxx"}').perfil, 'us.');
  assert.throws(() => leerCredencialBedrock('no json'), /JSON/);
  assert.throws(() => leerCredencialBedrock('{"region":"chile","apiKey":"ABSKxxxxxxxxxxxxxxxxxxxxxx"}'), /region/);
  assert.throws(() => leerCredencialBedrock('{"region":"us-east-1","accessKeyId":"AKIA123"}'), /accessKeyId/);
});

test('cuerpo: quita model y stream, agrega anthropic_version y betas', () => {
  const c = cuerpoBedrock({ model: 'x', stream: true, max_tokens: 5, messages: [] }, { 'anthropic-beta': 'a, b' });
  assert.deepEqual(c, { max_tokens: 5, messages: [], anthropic_version: 'bedrock-2023-05-31', anthropic_beta: ['a', 'b'] });
});

test('errores de AWS se traducen al formato de Anthropic', () => {
  assert.deepEqual([errorDeBedrock(400, 'ThrottlingException:http://x', 'm').status, errorDeBedrock(400, 'ThrottlingException', 'm').cuerpo.error.type], [429, 'rate_limit_error']);
  assert.equal(errorDeBedrock(403, 'AccessDeniedException', 'm').cuerpo.error.type, 'permission_error');
});

// ---------- flujo completo ----------
const LLAVE_BR = 'tfk_bedrock_prueba';
const LLAVE_DI = 'tfk_directo_prueba';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const leer = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); });
const escuchar = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const pedidosBedrock = [];
const bedrock = http.createServer(async (req, res) => {
  const cuerpo = JSON.parse(await leer(req));
  pedidosBedrock.push({ url: req.url, headers: req.headers, cuerpo });
  if (cuerpo.messages?.[0]?.content === 'limitar') {
    res.writeHead(429, { 'content-type': 'application/json', 'x-amzn-errortype': 'ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/' });
    return res.end('{"message":"Too many requests"}');
  }
  if (req.url.endsWith('/invoke')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'hola' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }));
  }
  res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
  res.write(chunk({ type: 'message_start', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 11, output_tokens: 1 } } }));
  res.write(chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hola' } }));
  res.write(chunk({ type: 'message_delta', usage: { output_tokens: 25 } }));
  res.end(chunk({ type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 11 } }));
});
const pedidosAnthropic = [];
const anthropic = http.createServer(async (req, res) => {
  await leer(req); pedidosAnthropic.push(req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
});
const consumos = [];
const C_BR = '11111111-1111-4111-8111-111111111111';
const C_DI = '22222222-2222-4222-8222-222222222222';
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
    return json([{ id: C_BR, nombre: 'crm por bedrock', activo: true, presupuesto_usd_mensual: 0, ruta_anthropic: 'bedrock' },
      { id: C_DI, nombre: 'crm directo', activo: true, presupuesto_usd_mensual: 0, ruta_anthropic: null }]);
  }
  if (ruta === '/empresas') return json([{ id: 'initech', ruta_anthropic: 'directo' }]);
  if (ruta === '/credenciales_proveedor') {
    return json([{ empresa_id: 'initech', proveedor: 'bedrock', tipo: 'api', valor_cifrado: credBedrock() },
      { empresa_id: 'initech', proveedor: 'anthropic', tipo: 'api', valor_cifrado: cifrar('sk-ant-api03-real') }]);
  }
  if (ruta === '/bedrock_modelos') return json([{ empresa_id: null, modelo: 'claude-haiku-4-5', bedrock_id: 'anthropic.claude-haiku-4-5-20251001-v1:0' }]);
  if (ruta === '/precios') return json([{ proveedor: 'anthropic', modelo: 'claude-haiku-4-5', usd_in_1m: 1, usd_out_1m: 5 }]);
  if (ruta === '/consumos' && req.method === 'POST') { consumos.push(...JSON.parse(cuerpo)); res.writeHead(201); return res.end(); }
  if (req.method === 'PATCH') { res.writeHead(204); return res.end(); }
  return json([]);
});

const pB = await escuchar(bedrock); const pA = await escuchar(anthropic); const pR = await escuchar(rest);
const libre = http.createServer(); const PUERTO = await escuchar(libre); await new Promise((r) => libre.close(r));
Object.assign(process.env, {
  PORT: String(PUERTO), REST_URL: `http://127.0.0.1:${pR}`, AUTH_URL: 'http://127.0.0.1:9',
  ANTHROPIC_BASE: `http://127.0.0.1:${pA}`, BEDROCK_BASE: `http://127.0.0.1:${pB}`,
});
({ cifrar } = await import('../lib/cripto.mjs'));
await import('../server.mjs');
const { volcar } = await import('../lib/registro.mjs');
after(() => setTimeout(() => process.exit(0), 50));

const URL_GW = `http://127.0.0.1:${PUERTO}/anthropic/v1/messages`;
const llamar = (llave, cuerpo, ruta = URL_GW) => fetch(ruta, {
  method: 'POST', body: JSON.stringify(cuerpo),
  headers: { 'content-type': 'application/json', 'x-api-key': llave, 'anthropic-version': '2023-06-01' },
});

test('ruta bedrock con streaming: firma SigV4, perfil us., SSE de Anthropic y consumo registrado', async () => {
  const r = await llamar(LLAVE_BR, { model: 'claude-haiku-4-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-gw-ruta'), 'bedrock');
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const sse = await r.text();
  assert.match(sse, /event: message_start\ndata: \{"type":"message_start"/);
  assert.match(sse, /event: message_stop/);
  assert.doesNotMatch(sse, /invocationMetrics/);
  const p = pedidosBedrock.at(-1);
  assert.equal(p.url, '/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream');
  assert.match(p.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAPRUEBA1234567890\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
  assert.equal(p.headers['x-api-key'], undefined);
  assert.equal(p.cuerpo.model, undefined);
  assert.equal(p.cuerpo.anthropic_version, 'bedrock-2023-05-31');
  await volcar();
  const c = consumos.at(-1);
  assert.deepEqual([c.via, c.proveedor, c.tokens_in, c.tokens_out, c.precio_conocido], ['bedrock', 'anthropic', 11, 25, true]);
  assert.ok(c.costo_usd > 0);
});

test('ruta bedrock sin streaming: JSON tal cual', async () => {
  const r = await llamar(LLAVE_BR, { model: 'claude-haiku-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).content[0].text, 'hola');
  assert.match(pedidosBedrock.at(-1).url, /\/invoke$/);
});

test('ruta bedrock: throttling -> 429 rate_limit_error; modelo sin traducción y count_tokens -> 400', async () => {
  const lim = await llamar(LLAVE_BR, { model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'limitar' }] });
  assert.equal(lim.status, 429);
  assert.equal((await lim.json()).error.type, 'rate_limit_error');
  const sinMapa = await llamar(LLAVE_BR, { model: 'claude-inventado', max_tokens: 5, messages: [] });
  assert.equal(sinMapa.status, 400);
  assert.equal((await sinMapa.json()).error.type, 'model_not_mapped');
  const ct = await llamar(LLAVE_BR, { model: 'claude-haiku-4-5', messages: [] }, `${URL_GW}/count_tokens`);
  assert.equal(ct.status, 400);
  assert.equal((await ct.json()).error.type, 'not_supported_on_bedrock');
});

test('cliente que hereda ruta directo sigue yendo a Anthropic sin cambios', async () => {
  const antes = pedidosBedrock.length;
  const r = await llamar(LLAVE_DI, { model: 'claude-haiku-4-5', max_tokens: 5, messages: [] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-gw-ruta'), 'directo');
  assert.equal(pedidosAnthropic.length, 1);
  assert.equal(pedidosBedrock.length, antes);
});
