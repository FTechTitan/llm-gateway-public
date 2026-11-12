// Inventario de TODAS las llaves de OpenAI y Anthropic de cada empresa (con las admin keys del gateway).
// Sin secretos: solo nombre, id, huella, fechas, dueño y uso de 30 días.
// Uso : docker compose exec -T proxy node --input-type=module - < tools/inventario-llaves.mjs
import { recargar, credencial, precioDe } from '/app/proxy/lib/estado.mjs';
import { rest } from '/app/proxy/lib/db.mjs';

const desdeSeg = Math.floor(Date.now() / 1000) - 30 * 86400;
const desdeIso = new Date(desdeSeg * 1000).toISOString().slice(0, 10) + 'T00:00:00Z';
const fecha = (s) => (s ? new Date(typeof s === 'number' ? s * 1000 : s).toISOString().slice(0, 10) : '');
async function get(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
async function paginar(base, headers, campoSig, param) {
  const out = []; let sig = null; let n = 0;
  do {
    const d = await get(sig ? `${base}&${param}=${encodeURIComponent(sig)}` : base, headers);
    out.push(...(d.data || [])); sig = d.has_more ? d[campoSig] : null;
  } while (sig && ++n < 50);
  return out;
}
const costo = (prov, m, ent, sal, cl, ce) => {
  const p = precioDe(prov, m); if (!p) return 0; const pin = Number(p.usd_in_1m);
  return (ent * pin + sal * Number(p.usd_out_1m) + cl * Number(p.usd_cache_read_1m ?? pin) + ce * Number(p.usd_cache_write_1m ?? pin)) / 1e6;
};

async function openai(empresa, llave) {
  const h = { Authorization: `Bearer ${llave}` }; const B = 'https://api.openai.com/v1/organization';
  const uso = {};
  for (const b of await paginar(`${B}/usage/completions?start_time=${desdeSeg}&bucket_width=1d&limit=31&group_by=api_key_id&group_by=model`, h, 'next_page', 'page'))
    for (const r of b.results || []) {
      const u = (uso[r.api_key_id] ??= { llamadas: 0, usd: 0, modelos: new Set() });
      u.llamadas += r.num_model_requests || 0; u.modelos.add(r.model);
      u.usd += costo('openai', r.model, (r.input_tokens || 0) - (r.input_cached_tokens || 0), r.output_tokens || 0, r.input_cached_tokens || 0, 0);
    }
  const filas = [];
  for (const p of await paginar(`${B}/projects?limit=100&include_archived=true`, h, 'last_id', 'after')) {
    for (const k of await paginar(`${B}/projects/${p.id}/api_keys?limit=100`, h, 'last_id', 'after').catch(() => [])) {
      const o = k.owner || {}; const u = uso[k.id] || { llamadas: 0, usd: 0, modelos: new Set() };
      filas.push({ proveedor: 'OpenAI', empresa, contenedor: p.name + (p.status === 'archived' ? ' (archivado)' : ''), nombre: k.name, id: k.id,
        huella: k.redacted_value, creada: fecha(k.created_at), ultimo_uso: fecha(k.last_used_at), estado: 'activa',
        duenio: o.type === 'service_account' ? `cuenta de servicio ${o.service_account?.name || ''}` : (o.user?.email || o.user?.name || o.type || ''),
        llamadas30: u.llamadas, usd30: Math.round(u.usd * 100) / 100, modelos: [...u.modelos].join(', ') });
    }
  }
  return filas;
}
async function anthropic(empresa, llave) {
  const h = { 'x-api-key': llave, 'anthropic-version': '2023-06-01' }; const B = 'https://api.anthropic.com/v1/organizations';
  const ws = Object.fromEntries((await paginar(`${B}/workspaces?limit=100&include_archived=true`, h, 'last_id', 'after_id').catch(() => [])).map((w) => [w.id, w.name]));
  const uso = {};
  for (const b of await paginar(`${B}/usage_report/messages?starting_at=${desdeIso}&bucket_width=1d&limit=31&group_by[]=api_key_id&group_by[]=model`, h, 'next_page', 'page'))
    for (const r of b.results || []) {
      const u = (uso[r.api_key_id] ??= { usd: 0, tokens: 0, modelos: new Set() }); const cc = r.cache_creation || {};
      const ce = (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0);
      u.modelos.add(r.model); u.tokens += (r.uncached_input_tokens || 0) + (r.output_tokens || 0);
      u.usd += costo('anthropic', r.model, r.uncached_input_tokens || 0, r.output_tokens || 0, r.cache_read_input_tokens || 0, ce);
    }
  return (await paginar(`${B}/api_keys?limit=100`, h, 'last_id', 'after_id')).map((k) => {
    const u = uso[k.id] || { usd: 0, tokens: 0, modelos: new Set() };
    return { proveedor: 'Anthropic', empresa, contenedor: k.workspace_id ? (ws[k.workspace_id] || k.workspace_id) : 'Default', nombre: k.name, id: k.id,
      huella: k.partial_key_hint, creada: fecha(k.created_at), ultimo_uso: '', estado: k.status,
      duenio: k.created_by?.type || '', llamadas30: u.tokens ? `${u.tokens} tokens` : 0, usd30: Math.round(u.usd * 100) / 100, modelos: [...u.modelos].join(', ') };
  });
}

await recargar();
const filas = []; const errores = [];
for (const { id } of await rest('empresas?select=id'))
  for (const [prov, fn] of [['openai', openai], ['anthropic', anthropic]]) {
    const k = credencial(id, prov, 'admin'); if (!k) continue;
    try { filas.push(...(await fn(id, k))); } catch (e) { errores.push(`${id}/${prov}: ${e.message}`); }
  }
process.stdout.write(JSON.stringify({ filas, errores }));
