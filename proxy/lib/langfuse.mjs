// Trazas a Langfuse por cliente (opcional). Formato:
// trace-create + generation-create, con prompt enlazado, sesión y enlace a la ejecución de n8n de origen.
// Se envía después de responder; si Langfuse falla, la llamada no se entera.

// Extrae el texto de salida de una respuesta completa (JSON) de OpenAI o Anthropic.
export function salidaDe(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.output !== undefined) return obj.output;                                // OpenAI Responses
  if (obj.choices) return obj.choices.map((c) => c.message ?? c.text);            // Chat / completions
  if (obj.content) return obj.content;                                            // Anthropic Messages
  if (obj.text !== undefined) return obj.text;                                    // audio/transcriptions
  return null;
}

// Junta la salida de un streaming, evento por evento.
export function acumuladorSalida() {
  let texto = '';
  let final = null;
  return {
    evento(ev) {
      if (ev.type === 'response.completed' && ev.response) final = ev.response.output;           // Responses
      else if (ev.choices?.[0]?.delta?.content) texto += ev.choices[0].delta.content;            // Chat
      else if (ev.type === 'content_block_delta' && ev.delta?.text) texto += ev.delta.text;      // Anthropic
    },
    salida: () => final ?? (texto || null),
  };
}

// metadata de OpenAI: máx. 16 claves, valores texto de hasta 512 caracteres. n8n manda números: se convierten.
export function normalizarMetadata(pedido) {
  if (!pedido?.metadata || typeof pedido.metadata !== 'object') return pedido;
  const m = Object.fromEntries(Object.entries(pedido.metadata).slice(0, 16)
    .map(([k, v]) => [k.slice(0, 64), (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 512)]));
  return { ...pedido, metadata: m };
}

const recortar = (v, max = 200000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}… [recortado]` : v;
};

export function armarLote({ cliente, proveedor, endpoint, pedido, salida, uso, status, inicio, cabeceras, errorTexto }) {
  const md = pedido?.metadata || {};
  const h = (n) => cabeceras[`x-langfuse-${n}`];
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const traza = `trace-${id}`;
  const promptName = h('prompt-name') || md.prompt_name;
  const promptVersion = Number(h('prompt-version') || md.prompt_version) || undefined;
  const ahora = new Date().toISOString();
  const origen = md.base_url && md.workflow_id ? `${md.base_url}/workflow/${md.workflow_id}/executions/${md.excecution_id || md.execution_id || ''}` : undefined;
  const entrada = recortar(pedido?.input ?? pedido?.messages ?? pedido?.prompt ?? null);
  const metadata = { cliente, endpoint, proveedor, status, origen_host: origen, workflow: md.workflow, gateway: 'llm.example.com' };
  return {
    batch: [
      { type: 'trace-create', id: `evt-${id}-t`, timestamp: ahora, body: {
        id: traza, name: h('trace-name') || (promptName ? `${promptName}_${promptVersion ?? ''}` : `${cliente} ${endpoint}`),
        userId: h('user-id') || md.user_id || cabeceras['x-forwarded-for'] || undefined,
        sessionId: h('session-id') || md.session_id || pedido?.prompt_cache_key || undefined,
        input: entrada, output: recortar(salida), metadata, tags: ['llm-gateway', cliente] } },
      { type: 'generation-create', id: `evt-${id}-g`, timestamp: ahora, body: {
        id: `gen-${id}`, traceId: traza, name: md.workflow || endpoint,
        startTime: new Date(inicio).toISOString(), endTime: ahora,
        model: uso.modelo || pedido?.model, promptName, promptVersion,
        modelParameters: { temperature: pedido?.temperature, stream: Boolean(pedido?.stream) },
        input: entrada, output: recortar(salida),
        usageDetails: { input: uso.entrada, output: uso.salida, input_cached_tokens: uso.cacheLectura, cache_creation_input_tokens: uso.cacheEscritura },
        level: status >= 400 ? 'ERROR' : 'DEFAULT', statusMessage: status >= 400 ? (errorTexto || `HTTP ${status}`) : undefined,
        metadata } },
    ],
  };
}

export function enviarTraza(lf, lote) {
  const auth = Buffer.from(`${lf.public_key}:${lf.secret_key}`).toString('base64');
  fetch(`${lf.host.replace(/\/$/, '')}/api/public/ingestion`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(lote), signal: AbortSignal.timeout(15000),
  }).then(async (r) => { if (r.status >= 300 && r.status !== 207) console.error(`Langfuse ${r.status}: ${(await r.text()).slice(0, 150)}`); })
    .catch((e) => console.error(`Langfuse no respondió: ${e.message}`));
}
