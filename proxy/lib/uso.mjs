// Extrae tokens de las respuestas de OpenAI y Anthropic (JSON completo o eventos SSE)
// y calcula el costo con la tabla de precios.
import { precioDe } from './estado.mjs';

// segundos: audio cobrado por minuto (whisper-1), sale de usage.type = 'duration'.
export const usoVacio = () => ({ modelo: null, entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0, segundos: 0, visto: false });

const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// Aplica un objeto (respuesta completa o un evento) sobre el acumulado. Devuelve un objeto nuevo.
export function acumular(proveedor, uso, obj) {
  if (!obj || typeof obj !== 'object') return uso;
  return proveedor === 'anthropic' ? deAnthropic(uso, obj) : deOpenAI(uso, obj);
}

function deOpenAI(uso, obj) {
  // Responses API en streaming: response.completed trae la respuesta completa
  const base = obj.type && obj.response ? obj.response : obj;
  const u = base.usage;
  const modelo = base.model || uso.modelo;
  if (!u) return { ...uso, modelo };
  if (u.type === 'duration') return { ...uso, modelo, visto: true, segundos: n(u.seconds) };   // audio: whisper-1
  if ('input_tokens' in u || 'output_tokens' in u) {           // Responses API y audio por tokens (gpt-4o-transcribe)
    const cache = n(u.input_tokens_details?.cached_tokens);
    return { ...uso, modelo, visto: true, entrada: n(u.input_tokens) - cache, cacheLectura: cache, salida: n(u.output_tokens) };
  }
  const cache = n(u.prompt_tokens_details?.cached_tokens);      // Chat / Embeddings
  return { ...uso, modelo, visto: true, entrada: n(u.prompt_tokens) - cache, cacheLectura: cache, salida: n(u.completion_tokens) };
}

function deAnthropic(uso, obj) {
  if (obj.type === 'message_start' && obj.message) return deAnthropic({ ...uso, modelo: obj.message.model || uso.modelo }, obj.message);
  const u = obj.usage;
  const modelo = obj.model || uso.modelo;
  if (!u) return { ...uso, modelo };
  // En message_delta los valores son acumulados: se toma el mayor visto.
  return {
    ...uso, modelo, visto: true,
    entrada: Math.max(uso.entrada, n(u.input_tokens)),
    salida: Math.max(uso.salida, n(u.output_tokens)),
    cacheLectura: Math.max(uso.cacheLectura, n(u.cache_read_input_tokens)),
    cacheEscritura: Math.max(uso.cacheEscritura, n(u.cache_creation_input_tokens)),
  };
}

// origen: proveedor del formato del pedido; Bedrock sin precio propio usa el de ese proveedor.
export function costo(proveedor, uso, origen = proveedor) {
  const p = precioDe(proveedor, uso.modelo, origen);
  if (!p) return { usd: 0, conocido: !uso.visto };
  const pin = Number(p.usd_in_1m);
  const porMinuto = Number(p.usd_minuto ?? 0);
  const usd = (uso.entrada * pin
    + uso.salida * Number(p.usd_out_1m)
    + uso.cacheLectura * Number(p.usd_cache_read_1m ?? pin)
    + uso.cacheEscritura * Number(p.usd_cache_write_1m ?? pin)) / 1e6
    + (uso.segundos || 0) * porMinuto / 60;
  // Modelo por minuto sin duración en la respuesta (response_format=text/srt/vtt): no se puede cobrar.
  if (porMinuto > 0 && !uso.segundos && !uso.entrada) return { usd: 0, conocido: false };
  return { usd, conocido: true };
}

// Lector de SSE incremental: recibe trozos de texto y entrega cada `data:` como objeto.
export function lectorSSE(alEvento) {
  let resto = '';
  return (trozo) => {
    resto += trozo;
    let i;
    while ((i = resto.indexOf('\n')) >= 0) {
      const linea = resto.slice(0, i).trim();
      resto = resto.slice(i + 1);
      if (!linea.startsWith('data:')) continue;
      const dato = linea.slice(5).trim();
      if (!dato || dato === '[DONE]') continue;
      try { alEvento(JSON.parse(dato)); } catch { /* evento no JSON: se ignora */ }
    }
  };
}
