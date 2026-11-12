// Adaptador de Amazon Bedrock (contrato: docs/bedrock.md). Dos formatos:
//  - anthropic: Messages API. Devuelve lo mismo que api.anthropic.com (JSON, o SSE convertido desde el event-stream de AWS).
//  - openai:    Chat Completions, para modelos openai.* de Bedrock, que aceptan el cuerpo de OpenAI tal cual en
//               InvokeModel y devuelven chat.completion / chat.completion.chunk. Se reenvía como SSE de OpenAI.
// Así proxy.mjs trata la respuesta igual que la del proveedor directo.
import { createHash, createHmac } from 'node:crypto';

const ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const SERVICIO = 'bedrock';

// ---------- credencial ----------
// JSON cifrado en credenciales_proveedor: { region, perfil?, apiKey } o { region, perfil?, accessKeyId, secretAccessKey, sessionToken? }
export function leerCredencialBedrock(texto) {
  let c;
  try { c = JSON.parse(texto); } catch { throw new Error('la credencial de Bedrock debe ser un JSON'); }
  if (!c || typeof c !== 'object') throw new Error('la credencial de Bedrock debe ser un objeto JSON');
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(c.region || '')) throw new Error('region inválida (ej. us-east-1)');
  const perfil = c.perfil ?? '';
  if (!/^((us|eu|apac|jp|au|ca|us-gov|global)\.)?$/.test(perfil)) throw new Error('perfil debe ser "", "us.", "eu.", "apac.", "global." …');
  if (c.apiKey) {
    if (typeof c.apiKey !== 'string' || c.apiKey.length < 20) throw new Error('apiKey inválida');
    return { region: c.region, perfil, apiKey: c.apiKey };
  }
  if (!/^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(c.accessKeyId || '') || typeof c.secretAccessKey !== 'string' || c.secretAccessKey.length < 30) {
    throw new Error('falta apiKey, o accessKeyId + secretAccessKey válidos');
  }
  return { region: c.region, perfil, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken || null };
}

export const huellaBedrock = (c) => (c.apiKey || c.accessKeyId).slice(-4);

// ---------- modelos ----------
// mapa: Map(`${empresa}|${modelo}` | `*|${modelo}`, bedrock_id)
export function resolverModelo(modelo, empresa, perfil, mapa) {
  const m = String(modelo || '').trim();
  if (!m) return null;
  if (m.startsWith('arn:') || /^[a-z-]+\.(anthropic|openai)\./.test(m)) return m;   // ARN o perfil con región (us.anthropic.…, us.openai.…)
  if (m.startsWith('openai.')) return m;   // id de Bedrock de OpenAI tal cual (los gpt-oss no tienen perfil con región)
  const base = mapa.get(`${empresa}|${m}`) || mapa.get(`*|${m}`)
    || (m.startsWith('anthropic.') ? m : null)
    || (/^claude-[a-z0-9-]+-\d{8}$/.test(m) ? `anthropic.${m}-v1:0` : null);
  if (!base) return null;
  if (base.startsWith('arn:') || !base.startsWith('anthropic.')) return base;   // ya trae prefijo geográfico
  return perfil + base;
}

// ---------- cuerpo ----------
// OpenAI: el modelo va en la URL y el streaming lo decide el endpoint; se pide el uso al final del stream.
// Los gpt-oss de Bedrock meten su razonamiento en el texto (<reasoning>…</reasoning>) salvo include_reasoning=false;
// una app escrita para OpenAI no lo espera, así que se apaga por defecto (si la app lo manda, se respeta).
export function cuerpoBedrockOpenAI(pedido, modeloId = '') {
  const { model, stream, ...resto } = pedido;
  const base = /gpt-oss/.test(modeloId) && !('include_reasoning' in resto) ? { ...resto, include_reasoning: false } : resto;
  if (stream !== true) return base;
  return { ...base, stream_options: { ...(base.stream_options || {}), include_usage: true } };
}

export function cuerpoBedrock(pedido, cabeceras) {
  const { model, stream, ...resto } = pedido;
  const betas = String(cabeceras['anthropic-beta'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { ...resto, anthropic_version: ANTHROPIC_VERSION, ...(betas.length ? { anthropic_beta: betas } : {}) };
}

// ---------- SigV4 ----------
const hex = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// ruta: ya codificada una vez (como viaja). Para servicios distintos de S3 la ruta canónica se codifica de nuevo.
export function firmarSigV4({ metodo, host, ruta, query = '', cuerpo, region, servicio = SERVICIO, cred, fecha = new Date() }) {
  const amzDate = fecha.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dia = amzDate.slice(0, 8);
  const cab = { host, 'x-amz-date': amzDate };
  if (cred.sessionToken) cab['x-amz-security-token'] = cred.sessionToken;
  const nombres = Object.keys(cab).sort();
  const rutaCanonica = ruta.split('/').map(rfc3986).join('/');
  const canonica = [metodo, rutaCanonica, query, nombres.map((n) => `${n}:${cab[n]}\n`).join(''), nombres.join(';'), hex(cuerpo)].join('\n');
  const alcance = `${dia}/${region}/${servicio}/aws4_request`;
  const firmar = ['AWS4-HMAC-SHA256', amzDate, alcance, hex(canonica)].join('\n');
  const clave = hmac(hmac(hmac(hmac(`AWS4${cred.secretAccessKey}`, dia), region), servicio), 'aws4_request');
  const firma = createHmac('sha256', clave).update(firmar).digest('hex');
  return {
    ...cab,
    authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${alcance}, SignedHeaders=${nombres.join(';')}, Signature=${firma}`,
  };
}

// ---------- event-stream de AWS -> eventos ----------
function leerCabecerasEventStream(buf) {
  const cab = {};
  let i = 0;
  while (i < buf.length) {
    const largo = buf[i]; i += 1;
    const nombre = buf.toString('utf8', i, i + largo); i += largo;
    const tipo = buf[i]; i += 1;
    let valor = null;
    switch (tipo) {
      case 0: valor = true; break;
      case 1: valor = false; break;
      case 2: valor = buf.readInt8(i); i += 1; break;
      case 3: valor = buf.readInt16BE(i); i += 2; break;
      case 4: valor = buf.readInt32BE(i); i += 4; break;
      case 5: case 8: i += 8; break;
      case 6: case 7: { const n = buf.readUInt16BE(i); i += 2; valor = tipo === 7 ? buf.toString('utf8', i, i + n) : buf.subarray(i, i + n); i += n; break; }
      case 9: i += 16; break;
      default: throw new Error(`tipo de cabecera event-stream desconocido: ${tipo}`);
    }
    cab[nombre] = valor;
  }
  return cab;
}

// Async generator: trozos binarios -> { cabeceras, payload(Buffer) }
export async function* decodificarEventStream(trozos) {
  let pend = Buffer.alloc(0);
  for await (const t of trozos) {
    pend = pend.length ? Buffer.concat([pend, Buffer.from(t)]) : Buffer.from(t);
    while (pend.length >= 12) {
      const total = pend.readUInt32BE(0);
      if (total < 16 || total > 16 * 1024 * 1024) throw new Error(`mensaje event-stream inválido (${total} bytes)`);
      if (pend.length < total) break;
      const largoCab = pend.readUInt32BE(4);
      const cabeceras = leerCabecerasEventStream(pend.subarray(12, 12 + largoCab));
      const payload = pend.subarray(12 + largoCab, total - 4);
      pend = pend.subarray(total);
      yield { cabeceras, payload };
    }
  }
}

// ---------- errores ----------
const TIPO_ERROR = {
  ThrottlingException: [429, 'rate_limit_error'],
  ServiceQuotaExceededException: [429, 'rate_limit_error'],
  ValidationException: [400, 'invalid_request_error'],
  AccessDeniedException: [403, 'permission_error'],
  UnrecognizedClientException: [403, 'permission_error'],
  ResourceNotFoundException: [404, 'not_found_error'],
  ModelNotReadyException: [529, 'overloaded_error'],
  ServiceUnavailableException: [529, 'overloaded_error'],
  ModelTimeoutException: [504, 'api_error'],
  ModelStreamErrorException: [502, 'api_error'],
  ModelErrorException: [502, 'api_error'],
  InternalServerException: [500, 'api_error'],
};
export function errorDeBedrock(status, tipoAws, mensaje) {
  const nombre = String(tipoAws || '').split(':')[0].split('#').pop();
  const [s, tipo] = TIPO_ERROR[nombre] || [status >= 500 ? 502 : status || 502, status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error'];
  return { status: s, cuerpo: { type: 'error', error: { type: tipo, message: `Bedrock: ${mensaje || nombre || 'error'}` } } };
}

const respuestaJson = (status, cuerpo, extra = {}) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...extra } });

export const errorAnthropic = (status, tipo, mensaje) => respuestaJson(status, { type: 'error', error: { type: tipo, message: mensaje } });

// Mismo error con la forma de OpenAI ({ error: { message, type, code } }).
const aFormatoOpenAI = (cuerpo) => ({ error: { message: cuerpo.error.message, type: cuerpo.error.type, code: cuerpo.error.type } });

// event-stream de Bedrock (modelos openai.*) -> SSE de OpenAI: `data: {chunk}` y `data: [DONE]` al final.
async function* aSSEOpenAI(eventos) {
  const enc = new TextEncoder();
  try {
    for await (const { cabeceras, payload } of eventos) {
      if (cabeceras[':message-type'] === 'exception' || cabeceras[':message-type'] === 'error') {
        const msg = (() => { try { return JSON.parse(payload.toString('utf8')).message; } catch { return payload.toString('utf8'); } })();
        const e = errorDeBedrock(500, cabeceras[':exception-type'] || cabeceras[':error-code'], msg);
        yield enc.encode(`data: ${JSON.stringify(aFormatoOpenAI(e.cuerpo))}\n\n`);
        return;
      }
      if (cabeceras[':event-type'] !== 'chunk') continue;
      const { bytes } = JSON.parse(payload.toString('utf8'));
      const ev = JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'));
      delete ev['amazon-bedrock-invocationMetrics'];
      yield enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
    }
    yield enc.encode('data: [DONE]\n\n');
  } catch (e) {
    if (e.name === 'AbortError') return;
    yield enc.encode(`data: ${JSON.stringify({ error: { message: `Bedrock: ${e.message}`, type: 'api_error', code: 'api_error' } })}\n\n`);
  }
}

// event-stream de Bedrock -> SSE idéntico al de Anthropic
async function* aSSE(eventos) {
  const enc = new TextEncoder();
  try {
    for await (const { cabeceras, payload } of eventos) {
      if (cabeceras[':message-type'] === 'exception' || cabeceras[':message-type'] === 'error') {
        const msg = (() => { try { return JSON.parse(payload.toString('utf8')).message; } catch { return payload.toString('utf8'); } })();
        const e = errorDeBedrock(500, cabeceras[':exception-type'] || cabeceras[':error-code'], msg);
        yield enc.encode(`event: error\ndata: ${JSON.stringify(e.cuerpo)}\n\n`);
        return;
      }
      if (cabeceras[':event-type'] !== 'chunk') continue;
      const { bytes } = JSON.parse(payload.toString('utf8'));
      const ev = JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'));
      delete ev['amazon-bedrock-invocationMetrics'];
      yield enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    yield enc.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Bedrock: ${e.message}` } })}\n\n`);
  }
}

// ---------- llamada ----------
// base: para pruebas; por defecto https://bedrock-runtime.<region>.amazonaws.com
// formato: 'anthropic' (Messages API) u 'openai' (Chat Completions de modelos openai.*).
export async function enviarABedrock({ cred, modeloId, pedido, cabeceras, signal, base = null, formato = 'anthropic' }) {
  const openai = formato === 'openai';
  const stream = pedido.stream === true;
  const ruta = `/model/${encodeURIComponent(modeloId)}/${stream ? 'invoke-with-response-stream' : 'invoke'}`;
  const origen = (base || `https://bedrock-runtime.${cred.region}.amazonaws.com`).replace(/\/$/, '');
  const host = new URL(origen).host;
  const cuerpo = JSON.stringify(openai ? cuerpoBedrockOpenAI(pedido, modeloId) : cuerpoBedrock(pedido, cabeceras));
  const auth = cred.apiKey
    ? { authorization: `Bearer ${cred.apiKey}` }
    : firmarSigV4({ metodo: 'POST', host, ruta, cuerpo, region: cred.region, cred });
  const r = await fetch(origen + ruta, {
    method: 'POST', signal,
    headers: {
      ...auth, 'content-type': 'application/json',
      accept: stream ? 'application/vnd.amazon.eventstream' : 'application/json',
    },
    body: cuerpo,
  });
  if (!r.ok) {
    const texto = await r.text();
    let msg = texto;
    try { msg = JSON.parse(texto).message || JSON.parse(texto).Message || texto; } catch { /* texto plano */ }
    const e = errorDeBedrock(r.status, r.headers.get('x-amzn-errortype'), String(msg).slice(0, 500));
    return respuestaJson(e.status, openai ? aFormatoOpenAI(e.cuerpo) : e.cuerpo);
  }
  if (!stream) return new Response(r.body, { status: 200, headers: { 'content-type': 'application/json' } });
  const eventos = decodificarEventStream(r.body);
  return new Response(ReadableStream.from(openai ? aSSEOpenAI(eventos) : aSSE(eventos)), {
    status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
