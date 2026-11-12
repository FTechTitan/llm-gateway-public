// Gasto REAL de 30 días por llave: toma el informe de costos del proveedor (lo que se factura)
// y reparte cada línea (modelo + tipo de token) entre las llaves según los tokens que usó cada una.
// Uso : docker compose exec -T proxy node --input-type=module - < tools/costo-real-por-llave.mjs
import { recargar, credencial } from '/app/proxy/lib/estado.mjs';
import { rest } from '/app/proxy/lib/db.mjs';
const desdeSeg = Math.floor(Date.now() / 1000) - 30 * 86400;
const desdeIso = new Date(desdeSeg * 1000).toISOString().slice(0, 10) + 'T00:00:00Z';
async function get(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) }); const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`); return JSON.parse(t);
}
async function pag(base, headers, campo = 'next_page', param = 'page') {
  const out = []; let sig = null; let n = 0;
  do { const d = await get(sig ? `${base}&${param}=${encodeURIComponent(sig)}` : base, headers); out.push(...(d.data || [])); sig = d.has_more ? d[campo] : null; } while (sig && ++n < 60);
  return out;
}
const casa = (a, b) => a && b && (a.startsWith(b) || b.startsWith(a));
// reparte usd entre entradas {id, peso}; si no hay peso, va a sinAsignar
function repartir(acc, entradas, usd, etiqueta, sinAsignar) {
  const tot = entradas.reduce((s, e) => s + e.peso, 0);
  if (!tot) { sinAsignar[etiqueta] = (sinAsignar[etiqueta] || 0) + usd; return; }
  for (const e of entradas) acc[e.id] = (acc[e.id] || 0) + usd * e.peso / tot;
}

async function openai(llave) {
  const h = { Authorization: `Bearer ${llave}` }; const B = 'https://api.openai.com/v1/organization';
  const u = []; // {id, proj, model, inp, cache, out, req}
  for (const b of await pag(`${B}/usage/completions?start_time=${desdeSeg}&bucket_width=1d&limit=31&group_by=api_key_id&group_by=model&group_by=project_id`, h))
    for (const r of b.results || []) u.push({ id: r.api_key_id || 'sin-llave', proj: r.project_id, model: r.model, inp: (r.input_tokens || 0) - (r.input_cached_tokens || 0), cache: r.input_cached_tokens || 0, out: r.output_tokens || 0, req: r.num_model_requests || 0 });
  for (const ep of ['audio_transcriptions', 'audio_speeches', 'embeddings', 'images'])
    for (const b of await pag(`${B}/usage/${ep}?start_time=${desdeSeg}&bucket_width=1d&limit=31&group_by=api_key_id&group_by=model&group_by=project_id`, h).catch(() => []))
      for (const r of b.results || []) u.push({ id: r.api_key_id || 'sin-llave', proj: r.project_id, model: r.model, inp: r.input_tokens || 0, cache: 0, out: 0, req: r.num_model_requests || r.num_images || 0, seg: r.seconds || 0, extra: ep });
  const acc = {}; const sin = {}; let total = 0;
  for (const b of await pag(`${B}/costs?start_time=${desdeSeg}&bucket_width=1d&limit=31&group_by=project_id&group_by=line_item`, h))
    for (const r of b.results || []) {
      const usd = Number(r.amount?.value || 0); if (!usd) continue; total += usd;
      const li = (r.line_item || '').toLowerCase(); const [mod, tipo = ''] = li.split(/,\s*/);
      const delProy = u.filter((x) => x.proj === r.project_id);
      let ent = delProy.filter((x) => casa(x.model?.toLowerCase(), mod));
      const campo = tipo.includes('cached') ? 'cache' : tipo.includes('output') ? 'out' : tipo.includes('input') ? 'inp' : null;
      let pesos = ent.map((x) => ({ id: x.id, peso: campo ? x[campo] : (x.seg || x.req || x.inp) }));
      if (!pesos.some((p) => p.peso)) pesos = delProy.map((x) => ({ id: x.id, peso: x.req }));
      repartir(acc, pesos, usd, `${r.project_id} ${li}`, sin);
    }
  return { total, acc, sin };
}

async function anthropic(llave) {
  const h = { 'x-api-key': llave, 'anthropic-version': '2023-06-01' }; const B = 'https://api.anthropic.com/v1/organizations';
  const u = [];
  for (const b of await pag(`${B}/usage_report/messages?starting_at=${desdeIso}&bucket_width=1d&limit=31&group_by[]=api_key_id&group_by[]=model&group_by[]=workspace_id`, h))
    for (const r of b.results || []) { const cc = r.cache_creation || {};
      u.push({ id: r.api_key_id || 'consola/claude-code', ws: r.workspace_id || null, model: r.model, inp: r.uncached_input_tokens || 0, out: r.output_tokens || 0, cr: r.cache_read_input_tokens || 0, cw: (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0), web: r.server_tool_use?.web_search_requests || 0 }); }
  const acc = {}; const sin = {}; let total = 0;
  for (const b of await pag(`${B}/cost_report?starting_at=${desdeIso}&bucket_width=1d&limit=31&group_by[]=workspace_id&group_by[]=description`, h))
    for (const r of b.results || []) {
      const usd = Number(r.amount || 0) / 100; if (!usd) continue; total += usd;
      const tt = (r.token_type || '').toLowerCase(); const mod = (r.model || '').toLowerCase();
      const campo = tt.includes('cache_read') ? 'cr' : tt.includes('cache_creation') ? 'cw' : tt.includes('output') ? 'out' : tt.includes('input') ? 'inp' : (r.cost_type === 'web_search' ? 'web' : null);
      const ent = u.filter((x) => (x.ws || null) === (r.workspace_id || null) && (!mod || casa(x.model?.toLowerCase(), mod)));
      repartir(acc, ent.map((x) => ({ id: x.id, peso: campo ? x[campo] : x.inp + x.out })), usd, `${r.workspace_id} ${r.description || mod + ' ' + tt}`, sin);
    }
  return { total, acc, sin };
}

await recargar();
const out = {};
for (const { id } of await rest('empresas?select=id'))
  for (const [prov, fn] of [['openai', openai], ['anthropic', anthropic]]) {
    const k = credencial(id, prov, 'admin'); if (!k) continue;
    try { out[`${id}/${prov}`] = await fn(k); } catch (e) { out[`${id}/${prov}`] = { error: e.message }; }
  }
process.stdout.write(JSON.stringify(out));
