// Consumo diario por llave y modelo según cada proveedor, leído con las admin keys de cada empresa.
// Se guarda en consumo_proveedor (upsert por empresa, proveedor, día, llave y modelo).
import { rest } from './db.mjs';
import { credencial, precioDe } from './estado.mjs';
import { desdeDe } from './costos.mjs';


async function get(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
async function paginar(base, headers, campoSig = 'next_page', param = 'page') {
  const salida = []; let sig = null; let vueltas = 0;
  do {
    const d = await get(sig ? `${base}&${param}=${encodeURIComponent(sig)}` : base, headers);
    salida.push(...(d.data || []));
    sig = d.has_more ? d[campoSig] : null;
  } while (sig && ++vueltas < 400);
  return salida;
}
function estimar(prov, modelo, ent, sal, cl, ce) {
  const p = precioDe(prov, modelo);
  if (!p) return null;
  const pin = Number(p.usd_in_1m);
  return Number(((ent * pin + sal * Number(p.usd_out_1m) + cl * Number(p.usd_cache_read_1m ?? pin)
    + ce * Number(p.usd_cache_write_1m ?? pin)) / 1e6).toFixed(6));
}

async function filasOpenAI(empresa, llave, desdeFecha) {
  const h = { Authorization: `Bearer ${llave}` };
  const B = 'https://api.openai.com/v1/organization';
  const desde = Math.floor(desdeDe(desdeFecha).getTime() / 1000);
  const nombres = {};
  const proyectos = await paginar(`${B}/projects?limit=100&include_archived=true`, h, 'last_id', 'after');
  for (const p of proyectos) {
    const ks = await paginar(`${B}/projects/${p.id}/api_keys?limit=100`, h, 'last_id', 'after').catch(() => []);
    for (const k of ks) nombres[k.id] = { nombre: k.name, proyecto: p.name };
  }
  const nomProy = Object.fromEntries(proyectos.map((p) => [p.id, p.name]));
  const usos = await paginar(`${B}/usage/completions?start_time=${desde}&bucket_width=1d&limit=31&group_by=api_key_id&group_by=model&group_by=project_id`, h);
  return usos.flatMap((b) => (b.results || []).map((r) => {
    const cache = r.input_cached_tokens || 0;
    const ent = (r.input_tokens || 0) - cache;
    const n = nombres[r.api_key_id] || {};
    return {
      empresa_id: empresa, proveedor: 'openai', dia: new Date(b.start_time * 1000).toISOString().slice(0, 10),
      llave_id: r.api_key_id || 'sin-llave', llave_nombre: n.nombre || null, proyecto: n.proyecto || nomProy[r.project_id] || null,
      modelo: r.model || '?', llamadas: r.num_model_requests || 0, tokens_in: ent, tokens_out: r.output_tokens || 0,
      cache_read: cache, cache_write: 0, usd_estimado: estimar('openai', r.model, ent, r.output_tokens || 0, cache, 0),
    };
  }));
}

async function filasAnthropic(empresa, llave, desdeFecha) {
  const h = { 'x-api-key': llave, 'anthropic-version': '2023-06-01' };
  const B = 'https://api.anthropic.com/v1/organizations';
  const desde = desdeDe(desdeFecha).toISOString().slice(0, 10) + 'T00:00:00Z';
  const nombres = {};
  const [ks, ws] = await Promise.all([
    paginar(`${B}/api_keys?limit=100`, h, 'last_id', 'after_id').catch(() => []),
    paginar(`${B}/workspaces?limit=100`, h, 'last_id', 'after_id').catch(() => []),
  ]);
  const nomWs = Object.fromEntries(ws.map((w) => [w.id, w.name]));
  for (const k of ks) nombres[k.id] = { nombre: k.name, proyecto: nomWs[k.workspace_id] || (k.workspace_id ? k.workspace_id : 'Default') };
  const usos = await paginar(`${B}/usage_report/messages?starting_at=${desde}&bucket_width=1d&limit=31&group_by[]=api_key_id&group_by[]=model`, h);
  return usos.flatMap((b) => (b.results || []).map((r) => {
    const cc = r.cache_creation || {};
    const ce = (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0);
    const n = nombres[r.api_key_id] || {};
    return {
      empresa_id: empresa, proveedor: 'anthropic', dia: String(b.starting_at).slice(0, 10),
      llave_id: r.api_key_id || 'sin-llave', llave_nombre: n.nombre || (r.api_key_id ? null : 'consola / Claude Code'),
      proyecto: n.proyecto || null, modelo: r.model || '?', llamadas: 0,
      tokens_in: r.uncached_input_tokens || 0, tokens_out: r.output_tokens || 0, cache_read: r.cache_read_input_tokens || 0, cache_write: ce,
      usd_estimado: estimar('anthropic', r.model, r.uncached_input_tokens || 0, r.output_tokens || 0, r.cache_read_input_tokens || 0, ce),
    };
  }));
}

// Junta filas repetidas (misma clave) antes del upsert.
function agrupar(filas) {
  const m = new Map();
  for (const f of filas) {
    const k = [f.empresa_id, f.proveedor, f.dia, f.llave_id, f.modelo].join('|');
    const x = m.get(k);
    if (!x) { m.set(k, { ...f }); continue; }
    for (const c of ['llamadas', 'tokens_in', 'tokens_out', 'cache_read', 'cache_write']) x[c] += f[c];
    x.usd_estimado = x.usd_estimado === null || f.usd_estimado === null ? null : x.usd_estimado + f.usd_estimado;
  }
  return [...m.values()];
}

export async function sincronizarUsoPorLlave(desde = null) {
  const empresas = await rest('empresas?select=id');
  const resultado = [];
  for (const { id } of empresas) {
    for (const [proveedor, leer] of [['openai', filasOpenAI], ['anthropic', filasAnthropic]]) {
      const llave = credencial(id, proveedor, 'admin');
      if (!llave) continue;
      try {
        const filas = agrupar(await leer(id, llave, desde)).map((f) => ({ ...f, leido: new Date().toISOString() }));
        for (let i = 0; i < filas.length; i += 500) {
          await rest('consumo_proveedor?on_conflict=empresa_id,proveedor,dia,llave_id,modelo', {
            metodo: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', cuerpo: filas.slice(i, i + 500),
          });
        }
        resultado.push({ empresa: id, proveedor, estado: 'ok', filas: filas.length });
      } catch (e) {
        console.error(`Uso por llave ${id}/${proveedor}: ${e.message}`);
        resultado.push({ empresa: id, proveedor, estado: 'error', detalle: e.message.slice(0, 200) });
      }
    }
  }
  return resultado;
}
