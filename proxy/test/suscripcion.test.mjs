// Prueba de integración del modo suscripción y las reglas, con PostgREST y Anthropic falsos (sin Docker).
// Correr: node --test proxy/test/suscripcion.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

const LLAVE = 'tfk_prueba_suscripcion';
const OAUTH = 'Bearer sk-ant-oat01-token-de-la-suscripcion';
const CLIENTE = '11111111-1111-4111-8111-111111111111';
const sha = (t) => createHash('sha256').update(t).digest('hex');

const escuchar = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const leer = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); });

// ---- Anthropic falso: guarda las cabeceras que recibe y responde SSE con usage ----
const recibidas = [];
const anthropic = http.createServer(async (req, res) => {
  await leer(req);
  recibidas.push(req.headers);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":2,"output_tokens":1,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}}\n\n');
  res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

// ---- PostgREST falso ----
const consumos = [];
let reglas = [];
const rest = http.createServer(async (req, res) => {
  const cuerpo = await leer(req);
  const ruta = req.url.split('?')[0];
  const json = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (ruta === '/llaves' && req.method === 'GET') return json([{ id: 'k1', hash: sha(LLAVE), cliente_id: CLIENTE, empresa_id: 'acme', activa: true }]);
  if (ruta === '/clientes') return json([{ id: CLIENTE, nombre: 'Alice · suscripción', activo: true, presupuesto_usd_mensual: 0 }]);
  if (ruta === '/reglas') return json(reglas);
  if (ruta === '/rpc/consumo_reglas') {
    // Igual que la función SQL: suma lo guardado y no bloqueado (ventana y filtros se ignoran en la prueba).
    return json(reglas.map((r) => ({ regla_id: r.id, consumo: consumos.filter((c) => !c.bloqueado).reduce((s, c) => s + c.tokens_in + c.tokens_out + c.tokens_cache_write, 0) })));
  }
  if (ruta === '/consumos' && req.method === 'POST') { consumos.push(...JSON.parse(cuerpo)); res.writeHead(201); return res.end(); }
  if (ruta === '/llaves' && req.method === 'PATCH') { res.writeHead(204); return res.end(); }
  return json([]);   // llaves_admin, credenciales_proveedor, precios, v_consumo_mes_cliente
});

const puertoAnthropic = await escuchar(anthropic);
const puertoRest = await escuchar(rest);
const libre = http.createServer();
const PUERTO = await escuchar(libre);
await new Promise((r) => libre.close(r));

Object.assign(process.env, {
  SUSCRIPCION_HABILITADA: 'true',   // la ruta está apagada por defecto en producción
  PORT: String(PUERTO), REST_URL: `http://127.0.0.1:${puertoRest}`, AUTH_URL: 'http://127.0.0.1:9',
  SERVICE_ROLE_KEY: 'x', ANON_KEY: 'x', PUBLIC_URL: 'http://x', GATEWAY_MASTER_KEY: 'maestra-de-prueba',
  GATEWAY_ENC_KEY: Buffer.alloc(32, 7).toString('base64'), ANTHROPIC_BASE: `http://127.0.0.1:${puertoAnthropic}`,
});
await import('../server.mjs');
const { volcar } = await import('../lib/registro.mjs');
const { recargarReglas } = await import('../lib/reglas.mjs');
after(() => setTimeout(() => process.exit(0), 50));

const URL_MSG = `http://127.0.0.1:${PUERTO}/suscripcion/anthropic/v1/messages`;
const mensaje = (cabeceras = {}) => fetch(URL_MSG, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: OAUTH, 'x-gw-key': LLAVE, ...cabeceras },
  body: JSON.stringify({ model: 'claude-haiku-5-5', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hola' }] }),
});

test('pasa el OAuth sin tocarlo, no reenvía la llave del gateway y registra el consumo como suscripción', async () => {
  const r = await mensaje();
  assert.equal(r.status, 200);
  assert.match(await r.text(), /message_stop/);
  const h = recibidas.at(-1);
  assert.equal(h.authorization, OAUTH);
  assert.equal(h['x-gw-key'], undefined);
  assert.equal(h['x-api-key'], undefined);
  await volcar();
  const c = consumos.at(-1);
  assert.deepEqual([c.modo, c.tokens_out, c.tokens_cache_write, c.costo_usd, c.bloqueado], ['suscripcion', 40, 1000, 0, false]);
});

test('sin x-gw-key responde 401 y no llega a Anthropic', async () => {
  const antes = recibidas.length;
  const r = await fetch(URL_MSG, { method: 'POST', headers: { authorization: OAUTH, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.equal(recibidas.length, antes);
});

test('una llave del gateway en Authorization se rechaza con 400 y no sale', async () => {
  const antes = recibidas.length;
  const r = await mensaje({ authorization: `Bearer ${LLAVE}` });
  assert.equal(r.status, 400);
  assert.equal(recibidas.length, antes);
});

test('una regla de corte bloquea con 403 al llegar al límite, aun antes de recargar', async () => {
  reglas = [{ id: 'r1', empresa_id: 'acme', nombre: 'tope de prueba', activa: true, metrica: 'tokens', limite: 2000,
    accion: 'cortar', ventana_tipo: 'movil', ventana_minutos: 60, filtro_modo: 'suscripcion' }];
  await recargarReglas();                       // base = 1043 (el primer mensaje)
  assert.equal((await mensaje()).status, 200);  // 1043 < 2000 → pasa; suma 1043 en memoria (2086)
  const r = await mensaje();                    // sin volcar ni recargar: debe cortar igual
  assert.equal(r.status, 403);
  const e = await r.json();
  assert.equal(e.error.type, 'usage_rule');
  assert.match(e.error.message, /tope de prueba/);
  await volcar();
  await recargarReglas();                       // tras volcar y recargar no se cuenta dos veces
  assert.equal((await mensaje()).status, 403);
  assert.equal(consumos.filter((c) => c.bloqueado).length, 1);   // bloqueos repetidos: un registro por minuto
});
