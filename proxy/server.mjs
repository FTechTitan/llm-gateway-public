// llm-gateway: proxy de OpenAI y Anthropic con registro de consumo, cuotas y panel.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.mjs';
import { estadoCache, iniciarRecarga, recargar } from './lib/estado.mjs';
import { iniciarVolcado, tamanoCola, volcar } from './lib/registro.mjs';
import { proxear } from './lib/proxy.mjs';
import { estadoReglas, iniciarRecargaReglas, recargarReglas } from './lib/reglas.mjs';
import { admin } from './lib/admin.mjs';
import { programarReporte } from './lib/reporte.mjs';
import { iniciarAvisos } from './lib/avisos.mjs';
import { iniciarSincronizacion } from './lib/costos.mjs';
import { clavePublica } from './lib/push.mjs';
import { responderError, responderJson } from './lib/http.mjs';

const DIR_PANEL = fileURLToPath(new URL('../panel/', import.meta.url));
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' };

async function panel(req, res, ruta) {
  if (ruta === '/panel/config.js') {
    const js = `window.GW=${JSON.stringify({ url: config.urlPublica, anon: config.anonKey, vapid: clavePublica() })};`;
    res.writeHead(200, { 'content-type': TIPOS['.js'], 'cache-control': 'no-store' });
    return res.end(js);
  }
  const relativo = normalize(ruta.replace(/^\/panel\/?/, '') || 'index.html');
  if (relativo.startsWith('..')) return responderError(res, 400, 'bad_path', 'Ruta inválida.');
  try {
    const archivo = await readFile(join(DIR_PANEL, relativo));
    res.writeHead(200, { 'content-type': TIPOS[extname(relativo)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(archivo);
  } catch {
    responderError(res, 404, 'not_found', 'No existe.');
  }
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ruta = url.pathname;
  try {
    if (ruta === '/health') {
      const c = estadoCache();
      return responderJson(res, c.listo ? 200 : 503, { ok: c.listo, ...c, cola: tamanoCola(), reglas: estadoReglas() });
    }
    // Apagado por defecto (revisa los términos de uso de tu proveedor antes de habilitarlo).
    if (ruta.startsWith('/suscripcion/anthropic/')) {
      if (process.env.SUSCRIPCION_HABILITADA !== 'true') return responderError(res, 404, 'not_enabled', 'El modo suscripción no está habilitado en este gateway.');
      return await proxear(req, res, 'anthropic', ruta.slice('/suscripcion/anthropic'.length), 'suscripcion');
    }
    if (ruta.startsWith('/openai/')) return await proxear(req, res, 'openai', ruta.slice('/openai'.length));
    if (ruta.startsWith('/anthropic/')) return await proxear(req, res, 'anthropic', ruta.slice('/anthropic'.length));
    if (ruta.startsWith('/admin/')) return await admin(req, res, url);
    if (ruta === '/panel') { res.writeHead(301, { location: '/panel/' }); return res.end(); }
    if (ruta.startsWith('/panel/')) return await panel(req, res, ruta);
    return responderError(res, 404, 'not_found', 'Usa /openai/v1/..., /anthropic/v1/... o /suscripcion/anthropic/v1/...');
  } catch (e) {
    console.error(`Error no controlado en ${req.method} ${ruta}: ${e.stack || e.message}`);
    responderError(res, 500, 'internal_error', 'Error interno del gateway.');
  }
});
servidor.requestTimeout = 0;          // las respuestas largas en streaming no se cortan
servidor.headersTimeout = 60000;
servidor.keepAliveTimeout = 65000;

await recargar();
iniciarRecarga();
await recargarReglas();
iniciarRecargaReglas();
iniciarVolcado();
programarReporte();
iniciarAvisos();
iniciarSincronizacion();
servidor.listen(config.puerto, () => console.log(`llm-gateway escuchando en :${config.puerto}`));

async function apagar(senal) {
  console.log(`${senal}: volcando consumos pendientes y cerrando`);
  servidor.close();
  await volcar().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
