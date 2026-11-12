#!/usr/bin/env node
// Respaldo local del llm-gateway para Claude Code (modo suscripción). Corre en cada equipo.
//
// Claude Code apunta a http://127.0.0.1:8741 (ANTHROPIC_BASE_URL) y manda x-gw-key (ANTHROPIC_CUSTOM_HEADERS).
// - Gateway arriba: reenvía al gateway tal cual.
// - Gateway caído (no conecta, o nginx responde 502/503/504 sin JSON): reenvía directo a api.anthropic.com
//   SIN x-gw-key, avisa (log, notificación del sistema, aviso en Claude Code) y deja el estado en modo directo.
// - Cada 15 s revisa /health del gateway; cuando vuelve, regresa solo y avisa.
// Este proceso no guarda llaves: la del gateway y el OAuth vienen en cada pedido de Claude Code.
//
// Uso: node respaldo-local.mjs           servicio
//      node respaldo-local.mjs --aviso   hook UserPromptSubmit: muestra en Claude Code si está en modo directo
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PUERTO = Number(process.env.GW_RESPALDO_PUERTO || 8741);
const GATEWAY = (process.env.GW_RESPALDO_GATEWAY || 'http://127.0.0.1:8740/suscripcion/anthropic').replace(/\/$/, '');
const SALUD = process.env.GW_RESPALDO_SALUD || new URL('/health', GATEWAY).href;
const DIRECTO = (process.env.GW_RESPALDO_DIRECTO || 'https://api.anthropic.com').replace(/\/$/, '');
const DIR = process.env.GW_RESPALDO_DIR || path.join(os.homedir(), '.llm-gw-respaldo');
const CADA_MS = Number(process.env.GW_RESPALDO_CADA_MS || 15000);
const AVISO_CMD = process.env.GW_RESPALDO_AVISO_CMD || '';   // opcional: comando que recibe el mensaje como argumento
const ESTADO = path.join(DIR, 'estado.json');
const LOG = path.join(DIR, 'respaldo.log');
const FALLOS_PARA_CAER = 2;
const NO_REENVIAR = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive']);
const NO_DEVOLVER = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const hora = (ts) => new Date(ts).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });

// ---------- modo hook ----------
if (process.argv.includes('--aviso')) {
  try {
    const e = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
    let msg = null;
    if (Date.now() - e.actualizado > 2 * 60000) msg = `⚠️ El respaldo local del gateway no está corriendo desde las ${hora(e.actualizado)}: si Claude Code no conecta, revisa el servicio llm-gw-respaldo.`;
    else if (e.modo === 'directo') msg = `⚠️ llm-gateway caído desde las ${hora(e.desde)}: Claude Code va directo a Anthropic, sin registro ni reglas. Vuelve solo al gateway cuando se recupere.`;
    if (msg) console.log(JSON.stringify({ systemMessage: msg }));
  } catch { /* sin estado todavía: nada que avisar */ }
  process.exit(0);
}

// ---------- servicio ----------
fs.mkdirSync(DIR, { recursive: true });
let modo = 'gateway';
let desde = Date.now();
let fallos = 0;

function log(m) {
  const linea = `${new Date().toISOString()} ${m}\n`;
  fs.appendFile(LOG, linea, () => {});
  process.stdout.write(linea);
}
const guardar = () => fs.writeFile(ESTADO, JSON.stringify({ modo, desde, actualizado: Date.now(), gateway: GATEWAY, pid: process.pid }), () => {});

function lanzar(cmd, args, env = {}) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    p.on('error', () => {});
    p.unref();
  } catch { /* sin notificador: queda el log */ }
}

function notificar(msg) {
  log(msg);
  if (process.platform === 'win32') {
    const ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; "
      + "$n.Icon=[System.Drawing.SystemIcons]::Warning; $n.Visible=$true; $n.ShowBalloonTip(15000,'llm-gateway',$env:GW_MSG,'Warning'); Start-Sleep 16; $n.Dispose()";
    lanzar('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { GW_MSG: msg });
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.DBUS_SESSION_BUS_ADDRESS) {
    lanzar('notify-send', ['llm-gateway', msg]);
  }
  if (AVISO_CMD) lanzar(AVISO_CMD, [msg]);
}

function cambiar(nuevo, motivo = '') {
  if (nuevo === modo) return;
  modo = nuevo;
  desde = Date.now();
  guardar();
  notificar(nuevo === 'directo'
    ? `Gateway caído (${motivo}): Claude Code sigue directo a Anthropic, sin registro ni reglas.`
    : 'Gateway de vuelta: Claude Code vuelve a pasar por el gateway.');
}

function marcarCaido(motivo) {
  fallos = FALLOS_PARA_CAER;
  cambiar('directo', motivo);
}

async function revisar() {
  try {
    const r = await fetch(SALUD, { signal: AbortSignal.timeout(4000) });
    await r.body?.cancel();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fallos = 0;
    cambiar('gateway');
  } catch (e) {
    fallos++;
    if (fallos >= FALLOS_PARA_CAER) cambiar('directo', e.cause?.code || e.message);
  }
  guardar();
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

function pedir(base, req, cuerpo, conLlave, signal) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (NO_REENVIAR.has(k) || (!conLlave && k === 'x-gw-key')) continue;
    h[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  h['accept-encoding'] = 'identity';
  return fetch(base + req.url, {
    method: req.method, headers: h, signal, duplex: 'half',
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : cuerpo,
  });
}

// nginx devuelve HTML cuando el proxy del gateway está caído; los errores propios del gateway son JSON.
const gatewayNoResponde = (r) => [502, 503, 504].includes(r.status) && !(r.headers.get('content-type') || '').includes('json');

function responderError(res, status, msg) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } }));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/_estado') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ modo, desde, gateway: GATEWAY }));
  }
  const abortar = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abortar.abort(); });
  let cuerpo;
  try { cuerpo = await leerCuerpo(req); } catch { return responderError(res, 400, 'Respaldo local: no se pudo leer el pedido.'); }

  let r = null;
  if (modo === 'gateway') {
    try {
      r = await pedir(GATEWAY, req, cuerpo, true, abortar.signal);
      if (gatewayNoResponde(r)) { await r.body?.cancel(); marcarCaido(`HTTP ${r.status}`); r = null; }
    } catch (e) {
      if (abortar.signal.aborted) return;
      marcarCaido(e.cause?.code || e.message);
      r = null;
    }
  }
  if (!r) {
    try { r = await pedir(DIRECTO, req, cuerpo, false, abortar.signal); }
    catch (e) {
      if (abortar.signal.aborted) return;
      return responderError(res, 502, `Respaldo local: no se pudo contactar ni al gateway ni a Anthropic (${e.cause?.code || e.message}).`);
    }
  }

  const salida = {};
  r.headers.forEach((v, k) => { if (!NO_DEVOLVER.has(k)) salida[k] = v; });
  res.writeHead(r.status, salida);
  try {
    if (r.body) for await (const trozo of r.body) res.write(trozo);
  } catch (e) {
    if (e.name !== 'AbortError') log(`corte del stream: ${e.message}`);
  } finally {
    res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60000;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`puerto ${PUERTO} ocupado: ya hay un respaldo corriendo`); process.exit(0); }
  log(`error del servidor: ${e.message}`);
  process.exit(1);
});
process.on('uncaughtException', (e) => log(`error no controlado: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log(`promesa rechazada: ${e?.stack || e}`));

server.listen(PUERTO, '127.0.0.1', () => {
  log(`respaldo local en http://127.0.0.1:${PUERTO} -> ${GATEWAY} (directo: ${DIRECTO})`);
  guardar();
  revisar();
  setInterval(revisar, CADA_MS).unref();
});
