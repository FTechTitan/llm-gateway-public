// Reenvío al proveedor real. Dos modos:
//  - api:         /openai/* y /anthropic/*. Cambia la llave del cliente por la de su empresa.
//  - suscripcion: /suscripcion/anthropic/*. El login OAuth de Claude Code (suscripción Max) pasa sin
//                 tocarse; el cliente se identifica con una llave del gateway en la cabecera x-gw-key
//                 (ANTHROPIC_CUSTOM_HEADERS="x-gw-key: tfk_..."). No hay gasto real: se guarda el costo equivalente.
// En ambos se aplican las reglas de uso y se cuentan los tokens del streaming por el camino.
import { sesionClaudeCode } from './sesion.mjs';
import { config } from './config.mjs';
import { sha256 } from './cripto.mjs';
import { buscarLlave, credencial, gastoMes, mapaModelosBedrock, vencida } from './estado.mjs';
import { enviarABedrock, resolverModelo } from './bedrock.mjs';
import { acumular, costo, lectorSSE, usoVacio } from './uso.mjs';
import { registrar } from './registro.mjs';
import { rest } from './db.mjs';
import { actualizarPlan, cuentaDeOrg, decidir } from './reglas.mjs';
import { leerCuerpo, responderError } from './http.mjs';
import { acumuladorSalida, armarLote, enviarTraza, normalizarMetadata, salidaDe } from './langfuse.mjs';
import { esRechazoDeFiltro, modeloDeRespaldo, pedidoDeRespaldo } from './respaldo.mjs';

export const CABECERA_GW = 'x-gw-key';
const SIN_REENVIAR_COMUN = ['host', 'content-length', 'connection', 'accept-encoding', 'x-forwarded-for',
  'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry',
  'cf-visitor', 'cdn-loop', 'true-client-ip'];
const SIN_REENVIAR = {
  api: new Set([...SIN_REENVIAR_COMUN, 'authorization', 'x-api-key', CABECERA_GW]),
  suscripcion: new Set([...SIN_REENVIAR_COMUN, CABECERA_GW]),   // authorization (OAuth) pasa tal cual
};
const SIN_DEVOLVER = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
const MAX_JSON_PARA_USO = 8 * 1024 * 1024;

function llaveDelCliente(req, modo) {
  if (modo === 'suscripcion') return String(req.headers[CABECERA_GW] || '').trim();
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-api-key'] || '').trim();
}

export async function proxear(req, res, proveedor, rutaResto, modo = 'api') {
  const inicio = Date.now();
  const llave = llaveDelCliente(req, modo);
  const info = llave ? buscarLlave(sha256(llave)) : null;
  if (!info) {
    return responderError(res, 401, 'invalid_api_key', modo === 'suscripcion'
      ? `Falta una llave del gateway válida en la cabecera ${CABECERA_GW} (configúrala con ANTHROPIC_CUSTOM_HEADERS).`
      : 'Llave inválida o inexistente.');
  }
  if (!info.activa) return responderError(res, 403, 'key_disabled', 'La llave o el cliente están desactivados.');
  if (vencida(info)) {
    return responderError(res, 401, 'key_expired',
      `La llave venció el ${new Date(info.expira).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })}. Pide una nueva al administrador.`);
  }
  // En suscripción authorization y x-api-key pasan a Anthropic: nunca deben llevar una llave del gateway.
  if (modo === 'suscripcion' && /tf[ka]_/.test(`${req.headers.authorization || ''} ${req.headers['x-api-key'] || ''}`)) {
    return responderError(res, 400, 'gateway_key_misplaced',
      `La llave del gateway va solo en ${CABECERA_GW}; Authorization y x-api-key deben ser las de tu suscripción.`);
  }

  let real = null;
  let via = 'directo';
  if (modo === 'api') {
    if (info.presupuesto > 0 && gastoMes(info.cliente_id) >= info.presupuesto) {
      return responderError(res, 429, 'budget_exceeded',
        `Se agotó el presupuesto mensual de ${info.presupuesto} USD del cliente ${info.cliente}.`);
    }
    if ((proveedor === 'anthropic' && info.ruta_anthropic === 'bedrock')
        || (proveedor === 'openai' && info.ruta_openai === 'bedrock')) {
      via = 'bedrock';
      real = credencial(info.empresa_id, 'bedrock', 'api');
      if (!real) return responderError(res, 503, 'provider_not_configured', `El cliente ${info.cliente} va por Bedrock, pero la empresa ${info.empresa_id} no tiene credencial de Bedrock cargada.`);
    } else {
      real = credencial(info.empresa_id, proveedor, 'api');
      if (!real) return responderError(res, 503, 'provider_not_configured', `La empresa ${info.empresa_id} no tiene llave de ${proveedor} cargada.`);
    }
  }

  let cuerpo;
  try { cuerpo = await leerCuerpo(req, config.maxCuerpoBytes); }
  catch (e) { return responderError(res, 413, 'body_too_large', e.message); }

  let pedido = null;
  if (cuerpo.length && (req.headers['content-type'] || '').includes('application/json')) {
    try { pedido = JSON.parse(cuerpo.toString('utf8')); } catch { pedido = null; }
  }
  // Audio (transcriptions/translations) llega como multipart: se lee solo el campo model, para cobrarlo.
  if (!pedido && cuerpo.length && (req.headers['content-type'] || '').includes('multipart/form-data')) {
    const m = /name="model"\r?\n\r?\n([^\r\n]{1,100})/.exec(cuerpo.toString('latin1'));
    if (m) pedido = { model: m[1].trim() };
  }
  // n8n manda metadata con números (prompt_version): OpenAI solo acepta texto.
  if (proveedor === 'openai' && pedido?.metadata) {
    pedido = normalizarMetadata(pedido);
    cuerpo = Buffer.from(JSON.stringify(pedido));
  }
  // Para que OpenAI informe tokens en streaming de chat hay que pedirlo explícitamente.
  if (proveedor === 'openai' && config.inyectarUsoStream && pedido?.stream === true
      && rutaResto.endsWith('/chat/completions') && !pedido.stream_options?.include_usage) {
    pedido = { ...pedido, stream_options: { ...(pedido.stream_options || {}), include_usage: true } };
    cuerpo = Buffer.from(JSON.stringify(pedido));
  }

  // Por Bedrock solo existen POST /v1/messages (Anthropic) y POST /v1/chat/completions (OpenAI). Contrato: docs/bedrock.md.
  let modeloBedrock = null;
  const unicoEndpoint = proveedor === 'openai' ? '/v1/chat/completions' : '/v1/messages';
  if (via === 'bedrock') {
    if (req.method !== 'POST' || rutaResto !== unicoEndpoint) {
      return responderError(res, 400, 'not_supported_on_bedrock', `${req.method} ${rutaResto} no está disponible por Bedrock; solo POST ${unicoEndpoint}.`);
    }
    if (!pedido) return responderError(res, 400, 'invalid_request_error', `El cuerpo debe ser JSON de ${proveedor === 'openai' ? 'Chat Completions' : 'la Messages API'}.`);
    modeloBedrock = resolverModelo(pedido.model, info.empresa_id, real.perfil, mapaModelosBedrock());
    if (!modeloBedrock) {
      const conocidos = [...mapaModelosBedrock().keys()].map((k) => k.split('|')[1]);
      return responderError(res, 400, 'model_not_mapped', `El modelo «${pedido.model}» no tiene traducción a Bedrock. Configurados: ${[...new Set(conocidos)].join(', ') || 'ninguno'}.`);
    }
  }

  // Reglas de uso. 403: Claude Code y los SDK no reintentan ese código.
  // plan: la cuenta de suscripción de esta llamada, para que una regla del plan solo frene a los equipos de esa cuenta.
  // La cuenta real sale del token OAuth de esta llamada (aprendida de la organización que informó Anthropic).
  // Token aún desconocido (recién cambiado de cuenta): ninguna regla del plan se le aplica hasta la primera respuesta.
  const sesion = modo === 'suscripcion' ? sesionClaudeCode(req.headers, pedido) : null;
  const tokenHash = modo === 'suscripcion' ? sha256(String(req.headers.authorization || req.headers['x-api-key'] || '')) : null;
  const orgToken = tokenHash ? orgPorToken.get(tokenHash) : null;
  const plan = modo === 'suscripcion' && proveedor === 'anthropic' && orgToken ? `claude:${cuentaDeOrg(orgToken)}` : null;
  const d = decidir({ empresa_id: info.empresa_id, cliente_id: info.cliente_id, proveedor, modo, modelo: pedido?.model || '', plan });
  for (const a of d.avisos) console.warn(`Aviso de regla (${info.cliente}): ${a}`);
  if (!d.permitido) {
    if (anotarBloqueo(info.cliente_id, d.motivo)) {
      anotar({ info, sesion, proveedor, modo, endpoint: rutaResto, pedido, uso: usoVacio(), status: 403, inicio, bloqueo: d.motivo });
    }
    return responderError(res, 403, 'usage_rule', `Bloqueado por la regla ${d.motivo}. Revísala en el panel del gateway.`);
  }

  const cabeceras = {};
  for (const [k, v] of Object.entries(req.headers)) if (!SIN_REENVIAR[modo].has(k)) cabeceras[k] = v;
  cabeceras['accept-encoding'] = 'identity';
  if (modo === 'api') {
    if (proveedor === 'openai') cabeceras.authorization = `Bearer ${real}`;
    else cabeceras['x-api-key'] = real;
  }

  const url = config.proveedores[proveedor] + rutaResto + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  const abortar = new AbortController();
  req.on('close', () => { if (!res.writableEnded) abortar.abort(); });

  let respuesta;
  try {
    respuesta = via === 'bedrock'
      ? await enviarABedrock({ cred: real, modeloId: modeloBedrock, pedido, cabeceras: req.headers, signal: abortar.signal, base: config.bedrockBase || null, formato: proveedor })
      : await fetch(url, {
        method: req.method, headers: cabeceras,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : cuerpo,
        signal: abortar.signal, duplex: 'half',
      });
  } catch (e) {
    if (abortar.signal.aborted) return res.end();
    anotar({ info, sesion, proveedor, modo, via, endpoint: rutaResto, pedido, uso: usoVacio(), status: 502, inicio });
    return responderError(res, 502, 'upstream_error', `No se pudo contactar a ${via === 'bedrock' ? 'Bedrock' : proveedor}: ${e.message}`);
  }

  // OpenAI rechazó el pedido con su filtro de seguridad: un reintento con el modelo de respaldo (ver respaldo.mjs).
  let notaRespaldo = null;
  const respaldo = respuesta.status === 400 ? modeloDeRespaldo({ info, proveedor, via, pedido }) : null;
  if (respaldo) {
    const texto = await respuesta.text();
    const original = new Response(texto, { status: respuesta.status, headers: respuesta.headers });
    respuesta = original;
    if (esRechazoDeFiltro(400, texto)) {
      anotar({ info, sesion, proveedor, modo, via, endpoint: rutaResto, pedido, uso: usoVacio(), status: 400, inicio, nota: `filtro de OpenAI → respaldo ${respaldo}` });
      const pedido2 = pedidoDeRespaldo(pedido, respaldo);
      try {
        const r2 = await fetch(url, { method: req.method, headers: cabeceras, body: Buffer.from(JSON.stringify(pedido2)), signal: abortar.signal });
        if (r2.ok) {
          console.warn(`Respaldo por filtro (${info.cliente}): ${pedido.model} → ${respaldo}`);
          notaRespaldo = `filtro:${pedido.model}->${respaldo}`;
          pedido = pedido2;
          respuesta = r2;
        } else {
          console.warn(`Respaldo por filtro (${info.cliente}) también falló: ${respaldo} → HTTP ${r2.status}; se devuelve el error original`);
        }
      } catch (e) {
        if (abortar.signal.aborted) return res.end();
        console.warn(`Respaldo por filtro (${info.cliente}) no se pudo intentar: ${e.message}`);
      }
    }
  }

  const salida = { 'x-gw-ruta': via, ...(notaRespaldo ? { 'x-gw-respaldo': notaRespaldo } : {}) };
  respuesta.headers.forEach((v, k) => { if (!SIN_DEVOLVER.has(k)) salida[k] = v; });
  if (modo === 'suscripcion') guardarLimites(info, respuesta.headers, tokenHash);
  res.writeHead(respuesta.status, salida);

  const tipo = respuesta.headers.get('content-type') || '';
  let uso = { ...usoVacio(), modelo: pedido?.model || null };
  const esSSE = tipo.includes('text/event-stream');
  const lf = info.langfuse && modo === 'api' ? info.langfuse : null;
  const acum = lf && esSSE ? acumuladorSalida() : null;
  let objeto = null;
  const leer = esSSE ? lectorSSE((ev) => { uso = acumular(proveedor, uso, ev); acum?.evento(ev); }) : null;
  const decodificador = new TextDecoder();
  const trozosJson = [];
  let bytesJson = 0;

  try {
    if (respuesta.body) {
      for await (const trozo of respuesta.body) {
        res.write(trozo);
        if (esSSE) leer(decodificador.decode(trozo, { stream: true }));
        else if (tipo.includes('json') && bytesJson < MAX_JSON_PARA_USO) { trozosJson.push(trozo); bytesJson += trozo.length; }
      }
    }
    if (!esSSE && trozosJson.length) {
      try { objeto = JSON.parse(Buffer.concat(trozosJson).toString('utf8')); uso = acumular(proveedor, uso, objeto); } catch { /* no era JSON */ }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error(`Corte del stream ${proveedor}${rutaResto}: ${e.message}`);
  } finally {
    res.end();
    anotar({ info, sesion, proveedor, modo, via, endpoint: rutaResto, pedido, uso, status: respuesta.status, inicio, stream: esSSE, nota: notaRespaldo });
    if (lf) {
      enviarTraza(lf, armarLote({ cliente: info.cliente, proveedor, endpoint: rutaResto, pedido, uso, status: respuesta.status, inicio,
        cabeceras: req.headers, salida: acum ? acum.salida() : salidaDe(objeto), errorTexto: objeto?.error?.message }));
    }
  }
}

const sinPrecioAvisado = new Set();

// Un cliente que reintenta contra una regla no debe llenar consumos: un registro por minuto por cliente y motivo.
const ultimosBloqueos = new Map();
function anotarBloqueo(clienteId, motivo) {
  const clave = `${clienteId}|${motivo}`;
  const ahora = Date.now();
  if (ahora - (ultimosBloqueos.get(clave) || 0) < 60000) return false;
  if (ultimosBloqueos.size > 5000) ultimosBloqueos.clear();
  ultimosBloqueos.set(clave, ahora);
  return true;
}

function anotar({ info, sesion = null, proveedor, modo, via = 'directo', endpoint, pedido, uso, status, inicio, stream = false, bloqueo = null, nota = null }) {
  const c = costo(via === 'bedrock' ? 'bedrock' : proveedor, uso, proveedor);
  const clave = `${proveedor}/${uso.modelo}`;
  if (!c.conocido && !sinPrecioAvisado.has(clave)) {
    sinPrecioAvisado.add(clave);
    console.warn(`Modelo sin precio: ${clave} (se registra con costo 0; agrégalo a la tabla precios)`);
  }
  const usd = Number(c.usd.toFixed(6));
  registrar({
    empresa_id: info.empresa_id, cliente_id: info.cliente_id, llave_id: info.llave_id,
    proveedor, modo, via, modelo: uso.modelo || pedido?.model || null, endpoint, stream: stream || pedido?.stream === true,
    tokens_in: uso.entrada, tokens_out: uso.salida,
    tokens_cache_read: uso.cacheLectura, tokens_cache_write: uso.cacheEscritura,
    costo_usd: modo === 'api' ? usd : 0,
    costo_equivalente_usd: modo === 'suscripcion' ? usd : 0,
    precio_conocido: c.conocido,
    status, latencia_ms: Date.now() - inicio,
    bloqueado: Boolean(bloqueo), motivo: bloqueo || nota, sesion,
  });
}

// Suscripción: Anthropic informa el uso del plan (ventana de 5 h, semanal…) en cabeceras anthropic-ratelimit-*.
// Se guarda la última foto por cliente, como mucho una vez cada 20 s por cliente para no cargar la base.
const ultimaFoto = new Map();
const orgPorToken = new Map();   // sha256(token OAuth) -> organización de Anthropic
function guardarLimites(info, cabeceras, tokenHash) {
  const org = cabeceras.get('anthropic-organization-id');
  if (org && tokenHash) { if (orgPorToken.size > 2000) orgPorToken.clear(); orgPorToken.set(tokenHash, org); }
  const foto = {};
  cabeceras.forEach((v, k) => { if (k.startsWith('anthropic-ratelimit')) foto[k] = v; });
  if (!Object.keys(foto).length) return;
  const ahora = Date.now();
  const claveFoto = org || info.cliente_id;
  if (ahora - (ultimaFoto.get(claveFoto) || 0) < 20000) return;
  ultimaFoto.set(claveFoto, ahora);
  rest('suscripcion_limites?on_conflict=cliente_id', {
    metodo: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    cuerpo: { cliente_id: info.cliente_id, empresa_id: info.empresa_id, ts: new Date(ahora).toISOString(), cabeceras: foto },
  }).catch((e) => console.error(`No se pudo guardar el límite de suscripción: ${e.message}`));
  // Vista común de suscripciones: una fila por cuenta de Claude (la cuenta sale de metadata.cuenta_suscripcion del cliente).
  const ventanas = [];
  for (const [k, v] of Object.entries(foto)) {
    const m = k.match(/^anthropic-ratelimit-unified-(.+)-utilization$/);
    if (!m) continue;
    const w = m[1];
    ventanas.push({ clave: w, usado: Number(v), reset: Number(foto[`anthropic-ratelimit-unified-${w}-reset`]) || null,
      ventana_min: w.startsWith('5h') ? 300 : w.startsWith('7d') ? 10080 : null, estado: foto[`anthropic-ratelimit-unified-${w}-status`] || null });
  }
  const cuenta = org ? cuentaDeOrg(org) : (info.cuenta_suscripcion || info.cliente);
  actualizarPlan(`claude:${cuenta}`, ventanas);
  rest('suscripciones_estado?on_conflict=id', {
    metodo: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    cuerpo: { id: `claude:${cuenta}`, empresa_id: info.empresa_id, proveedor: 'claude', cuenta, equipo: info.cliente, plan: 'Max',
      ventanas, extra: { org_id: org || null, estado: foto['anthropic-ratelimit-unified-status'] || null, limita: foto['anthropic-ratelimit-unified-representative-claim'] || null,
        uso_extra: foto['anthropic-ratelimit-unified-overage-status'] || null }, ts: new Date(ahora).toISOString() },
  }).catch((e) => console.error(`No se pudo guardar el estado de la suscripción: ${e.message}`));
}
