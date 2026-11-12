// Prueba del respaldo local: gateway arriba, gateway caído (va directo sin x-gw-key) y vuelta automática.
// Correr: node --test cliente/test/respaldo.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../respaldo-local.mjs', import.meta.url));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const escuchar = (srv, puerto = 0) => new Promise((r) => srv.listen(puerto, '127.0.0.1', () => r(srv.address().port)));

function falso(nombre, vistos) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      vistos.push({ nombre, url: req.url, headers: req.headers });
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: {"desde":"${nombre}"}\n\n`);
    });
  });
}

const vistos = [];
let gateway = falso('gateway', vistos);
const anthropic = falso('anthropic', vistos);
const puertoGw = await escuchar(gateway);
const puertoAn = await escuchar(anthropic);
const libre = http.createServer();
const PUERTO = await escuchar(libre);
await new Promise((r) => libre.close(r));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-respaldo-'));

const env = {
  ...process.env, GW_RESPALDO_PUERTO: String(PUERTO), GW_RESPALDO_DIR: DIR, GW_RESPALDO_CADA_MS: '150',
  GW_RESPALDO_GATEWAY: `http://127.0.0.1:${puertoGw}/suscripcion/anthropic`, GW_RESPALDO_DIRECTO: `http://127.0.0.1:${puertoAn}`,
  DISPLAY: '', WAYLAND_DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '',
};
const hijo = spawn(process.execPath, [SCRIPT], { env, stdio: 'ignore' });
after(() => { hijo.kill(); anthropic.close(); gateway.close(); });

const URL_MSG = `http://127.0.0.1:${PUERTO}/v1/messages?beta=true`;
const mensaje = () => fetch(URL_MSG, {
  method: 'POST', body: '{"model":"claude-haiku-5-5"}',
  headers: { 'content-type': 'application/json', authorization: 'Bearer oauth-de-prueba', 'x-gw-key': 'tfk_prueba' },
}).then((r) => r.text());
const estado = () => fetch(`http://127.0.0.1:${PUERTO}/_estado`).then((r) => r.json());
async function esperar(cond, ms = 3000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { try { if (await cond()) return; } catch { /* aún no */ } await dormir(50); }
  throw new Error('tiempo agotado');
}
const aviso = () => execFileSync(process.execPath, [SCRIPT, '--aviso'], { env }).toString().trim();
const ultimoMensaje = () => vistos.filter((v) => v.url.startsWith('/') && !v.url.startsWith('/health')).at(-1);

await esperar(async () => (await estado()).modo === 'gateway');

test('gateway arriba: va al gateway con x-gw-key y la ruta completa', async () => {
  assert.match(await mensaje(), /gateway/);
  const v = ultimoMensaje();
  assert.equal(v.url, '/suscripcion/anthropic/v1/messages?beta=true');
  assert.equal(v.headers['x-gw-key'], 'tfk_prueba');
  assert.equal(v.headers.authorization, 'Bearer oauth-de-prueba');
  assert.equal(aviso(), '');
});

test('gateway caído: el mismo pedido sale directo a Anthropic sin x-gw-key y avisa', async () => {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
  assert.match(await mensaje(), /anthropic/);
  const v = ultimoMensaje();
  assert.equal(v.nombre, 'anthropic');
  assert.equal(v.url, '/v1/messages?beta=true');
  assert.equal(v.headers['x-gw-key'], undefined);
  assert.equal(v.headers.authorization, 'Bearer oauth-de-prueba');
  assert.equal((await estado()).modo, 'directo');
  await dormir(200);
  assert.match(JSON.parse(aviso()).systemMessage, /caído/);
  assert.match(fs.readFileSync(path.join(DIR, 'respaldo.log'), 'utf8'), /Gateway caído/);
});

test('gateway de vuelta: regresa solo al gateway', async () => {
  gateway = falso('gateway', vistos);
  await escuchar(gateway, puertoGw);
  await esperar(async () => (await estado()).modo === 'gateway');
  assert.match(await mensaje(), /gateway/);
  await dormir(200);
  assert.equal(aviso(), '');
  assert.match(fs.readFileSync(path.join(DIR, 'respaldo.log'), 'utf8'), /Gateway de vuelta/);
});
