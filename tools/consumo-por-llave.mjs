// Consumo de los últimos N días por llave de API y modelo, leído con las admin keys cargadas en el gateway.
// Corre dentro del contenedor del proxy: node tools/consumo-por-llave.mjs [dias]  -> JSON por stdout (sin secretos).
import { recargar, credencial, precioDe } from '../proxy/lib/estado.mjs';
import { rest } from '../proxy/lib/db.mjs';

const DIAS = Number(process.argv[2] || 30);
const desdeSeg = Math.floor(Date.now() / 1000) - DIAS * 86400;
const desdeIso = new Date(desdeSeg * 1000).toISOString().slice(0, 10) + 'T00:00:00Z';

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
  } while (sig && ++vueltas < 50);
  return salida;
}
const estimar = (prov, modelo, ent, sal, cl, ce) => {
  const p = precioDe(prov, modelo); if (!p) return null;
  const pin = Number(p.usd_in_1m);
  return (ent * pin + sal * Number(p.usd_out_1m) + cl * Number(p.usd_cache_read_1m ?? pin) + ce * Number(p.usd_cache_write_1m ?? pin)) / 1e6;
};

async function openai(llave) {
  const h = { Authorization: `Bearer ${llave}` };
  const B = 'https://api.openai.com/v1/organization';
  const nombres = {};
  const proyectos = await paginar(`${B}/projects?limit=100&include_archived=true`, h, 'last_id', 'after');
  for (const p of proyectos) {
    const ks = await paginar(`${B}/projects/${p.id}/api_keys?limit=100`, h, 'last_id', 'after').catch(() => []);
    for (const k of ks) nombres[k.id] = { nombre: k.name, proyecto: p.name, huella: k.redacted_value, ultimo_uso: k.last_used_at };
  }
  const usos = await paginar(`${B}/usage/completions?start_time=${desdeSeg}&bucket_width=1d&limit=31&group_by=api_key_id&group_by=model`, h);
  const porLlave = {};
  for (const b of usos) for (const r of b.results || []) {
    const id = r.api_key_id || 'sin-llave';
    const m = r.model || '?';
    const x = (porLlave[id] ??= { ...(nombres[id] || { nombre: '(llave borrada o de otra org)' }), modelos: {} });
    const y = (x.modelos[m] ??= { llamadas: 0, entrada: 0, salida: 0, cache: 0 });
    y.llamadas += r.num_model_requests || 0; y.entrada += r.input_tokens || 0; y.salida += r.output_tokens || 0; y.cache += r.input_cached_tokens || 0;
  }
  for (const x of Object.values(porLlave)) {
    x.usd_estimado = 0;
    for (const [m, y] of Object.entries(x.modelos)) {
      const e = estimar('openai', m, y.entrada - y.cache, y.salida, y.cache, 0);
      y.usd_estimado = e; x.usd_estimado += e || 0;
    }
  }
  const costos = await paginar(`${B}/costs?start_time=${desdeSeg}&bucket_width=1d&limit=31&group_by=project_id`, h);
  const nomProy = Object.fromEntries(proyectos.map((p) => [p.id, p.name]));
  const porProyecto = {}; let total = 0;
  for (const b of costos) for (const r of b.results || []) {
    const v = Number(r.amount?.value || 0); total += v;
    const n = nomProy[r.project_id] || r.project_id || 'sin proyecto';
    porProyecto[n] = (porProyecto[n] || 0) + v;
  }
  return { costo_real_usd: total, costo_real_por_proyecto: porProyecto, llaves_existentes: Object.keys(nombres).length, por_llave: porLlave };
}

async function anthropic(llave) {
  const h = { 'x-api-key': llave, 'anthropic-version': '2023-06-01' };
  const B = 'https://api.anthropic.com/v1/organizations';
  const nombres = {};
  const ks = await paginar(`${B}/api_keys?limit=100`, h, 'last_id', 'after_id').catch(() => []);
  for (const k of ks) nombres[k.id] = { nombre: k.name, huella: k.partial_key_hint, estado: k.status, workspace: k.workspace_id };
  const usos = await paginar(`${B}/usage_report/messages?starting_at=${desdeIso}&bucket_width=1d&limit=31&group_by[]=api_key_id&group_by[]=model`, h);
  const porLlave = {};
  for (const b of usos) for (const r of b.results || []) {
    const id = r.api_key_id || 'consola/claude-code';
    const m = r.model || '?';
    const x = (porLlave[id] ??= { ...(nombres[id] || { nombre: r.api_key_id ? '(llave borrada)' : '(sin llave: consola o Claude Code)' }), modelos: {} });
    const y = (x.modelos[m] ??= { entrada: 0, salida: 0, cache_leida: 0, cache_escrita: 0 });
    const cc = r.cache_creation || {};
    y.entrada += r.uncached_input_tokens || 0; y.salida += r.output_tokens || 0; y.cache_leida += r.cache_read_input_tokens || 0;
    y.cache_escrita += (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0);
  }
  for (const x of Object.values(porLlave)) {
    x.usd_estimado = 0;
    for (const [m, y] of Object.entries(x.modelos)) {
      const e = estimar('anthropic', m, y.entrada, y.salida, y.cache_leida, y.cache_escrita);
      y.usd_estimado = e; x.usd_estimado += e || 0;
    }
  }
  const costos = await paginar(`${B}/cost_report?starting_at=${desdeIso}&bucket_width=1d&limit=31&group_by[]=description`, h);
  const porConcepto = {}; let total = 0;
  for (const b of costos) for (const r of b.results || []) {
    const v = Number(r.amount || 0) / 100; total += v;   // Anthropic: centavos
    const n = r.description || r.model || 'otros';
    porConcepto[n] = (porConcepto[n] || 0) + v;
  }
  return { costo_real_usd: total, costo_real_por_concepto: porConcepto, llaves_existentes: ks.length, por_llave: porLlave };
}

await recargar();
const empresas = (await rest('empresas?select=id')).map((e) => e.id);
const salida = { dias: DIAS, desde: desdeIso.slice(0, 10), empresas: {} };
for (const e of empresas) for (const [prov, fn] of [['openai', openai], ['anthropic', anthropic]]) {
  const k = credencial(e, prov, 'admin');
  if (!k) continue;
  try { (salida.empresas[e] ??= {})[prov] = await fn(k); }
  catch (err) { (salida.empresas[e] ??= {})[prov] = { error: err.message }; }
}
process.stdout.write(JSON.stringify(salida));
