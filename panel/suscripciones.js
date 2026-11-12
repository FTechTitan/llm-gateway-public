// Vista «Suscripciones» (Claude Code con login Max): uso del plan según Anthropic y tokens por equipo.
// No mezcla dólares ni nada de la API: son cosas distintas.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('es-CL');
const compacto = (n) => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const TZ = 'America/Santiago';
const fecha = (d, o) => new Date(d).toLocaleString('es-CL', { timeZone: TZ, ...o });
const LARGA = { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
const CORTA = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
const diaChile = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
const COLORES = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2'];
const NOMBRE_VENTANA = { '5h': 'Ventana de 5 horas', '7d': 'Plan semanal', '7d_opus': 'Semanal · Opus', '7d_sonnet': 'Semanal · Sonnet' };
const ESTADO = { allowed: ['ok', 'Dentro del límite'], allowed_warning: ['avisar', 'Aviso: cerca del límite'], rejected: ['cortar', 'Límite alcanzado'] };
const P = 'anthropic-ratelimit-unified-';
let ctx = null;
let grafico = null;
let graficoHist = null;

function faltaPara(ms) {
  if (ms <= 0) return 'ya';
  const h = Math.floor(ms / 3600e3);
  const d = Math.floor(h / 24);
  return d ? `en ${d} d ${h % 24} h` : `en ${h} h ${Math.floor((ms % 3600e3) / 60e3)} min`;
}

const PROVEEDOR = { claude: ['Claude', '#d97706'], chatgpt: ['ChatGPT · Codex', '#16a34a'], antigravity: ['Antigravity', '#2563eb'] };
const NOMBRE_CLAVE = { '5h': 'Ventana de 5 horas', '7d': 'Semanal', '7d_opus': 'Semanal · Opus', '7d_sonnet': 'Semanal · Sonnet' };
const dur = (ms) => {
  if (ms <= 0) return '0 min';
  const h = Math.floor(ms / 3600e3); const d = Math.floor(h / 24);
  return d ? `${d} d ${h % 24} h` : h ? `${h} h ${Math.floor((ms % 3600e3) / 60e3)} min` : `${Math.max(1, Math.floor(ms / 60e3))} min`;
};
const hace = (ts) => { const m = (Date.now() - Date.parse(ts)) / 60e3; return m < 2 ? 'recién' : m < 60 ? `hace ${Math.round(m)} min` : m < 2880 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} días`; };

function filaVentana(v) {
  const ahora = Date.now();
  const reset = v.reset ? v.reset * 1000 : null;
  const largo = (v.ventana_min || 0) * 60e3;
  const nombre = v.nombre || NOMBRE_CLAVE[v.clave] || v.clave;
  if (reset && reset <= ahora) {
    return `<div style="margin-top:10px"><div class="fila-titulo"><b>${esc(nombre)}</b><span class="chip ok">se reinició</span></div>
      <div class="sub">Ya pasó el reinicio (${esc(fecha(reset, CORTA))}): está al 100 % hasta que llegue un dato nuevo.</div></div>`;
  }
  const usado = Math.max(0, Math.min(1, Number(v.usado) || 0));
  const pctUsado = Math.round(usado * 100); const pctQueda = 100 - pctUsado;
  const falta = reset ? reset - ahora : null;
  const transcurrido = largo && falta != null ? Math.min(1, Math.max(0, 1 - falta / largo)) : null;
  const pctTiempo = transcurrido != null ? Math.round((1 - transcurrido) * 100) : null;
  const color = pctUsado >= 90 ? 'var(--mal)' : pctUsado >= 75 ? 'var(--warn)' : 'var(--ok)';
  let ritmo = '';
  if (transcurrido != null && transcurrido > 0.02 && usado > 0.01) {
    const msHasta100 = ((1 - usado) / usado) * (transcurrido * largo);
    if (msHasta100 < falta) ritmo = `<span style="color:var(--mal)">A este ritmo se agota el ${esc(fecha(ahora + msHasta100, LARGA))}, ${dur(falta - msHasta100)} antes del reinicio.</span>`;
    else ritmo = `<span style="color:var(--ok)">A este ritmo alcanza: llegarías al reinicio con ~${Math.round((1 - usado / transcurrido) * 100)} % sin usar.</span>`;
  } else if (usado <= 0.01) ritmo = '<span style="color:var(--ok)">Casi sin uso.</span>';
  return `<div style="margin-top:10px">
    <div class="fila-titulo"><b>${esc(nombre)}</b><span class="sub">queda <b style="color:var(--txt)">${pctQueda} %</b> del cupo${pctTiempo != null ? ` · ${pctTiempo} % del tiempo` : ''}</span></div>
    <div class="barra" style="height:10px;position:relative"><i style="width:${pctUsado}%;background:${color}"></i>
      ${transcurrido != null ? `<span title="tiempo transcurrido" style="position:absolute;top:-3px;bottom:-3px;left:${Math.round(transcurrido * 100)}%;width:2px;background:var(--txt)"></span>` : ''}</div>
    <div class="sub">${pctUsado} % usado${falta != null ? ` · se reinicia en <b>${dur(falta)}</b> (${esc(fecha(reset, LARGA))})` : ''}</div>
    ${ritmo ? `<div class="sub">${ritmo}</div>` : ''}</div>`;
}

function tarjetaCuenta(c) {
  const [prov, color] = PROVEEDOR[c.proveedor] || [c.proveedor, 'var(--acento)'];
  const vs = [...(c.ventanas || [])].sort((a, b) => (a.ventana_min || 0) - (b.ventana_min || 0));
  const extra = c.extra || {};
  const avisos = [];
  if (extra.estado === 'allowed_warning') avisos.push('<span class="chip avisar">cerca del límite</span>');
  if (extra.estado === 'rejected' || extra.alcanzado) avisos.push('<span class="chip cortar">límite alcanzado</span>');
  return `<div class="card" style="border-top:3px solid ${color}">
    <div class="fila-titulo"><h2>${esc(prov)}${c.plan ? ` <span class="chip">${esc(c.plan)}</span>` : ''}</h2>${avisos.join(' ')}</div>
    <div class="sub">${esc(c.cuenta)}</div>
    ${vs.length ? vs.map(filaVentana).join('') : '<div class="sub" style="margin-top:10px">Sin ventanas informadas.</div>'}
    <div class="sub" style="margin-top:10px">Dato ${esc(hace(c.ts))}${c.equipo ? ` desde ${esc(c.equipo)}` : ''}.</div>
  </div>`;
}

// Una sola tarjeta: una barra por plan. Barra gruesa = cupo que queda; barra fina adentro = tiempo que queda.
function ventanaPrincipal(c) {
  const vs = (c.ventanas || []).filter((v) => v.ventana_min);
  return vs.find((v) => v.clave === '7d') || vs.sort((a, b) => b.ventana_min - a.ventana_min)[0] || null;
}
function unirCuentasIguales(lista) {
  // Dos equipos con la misma cuenta de Claude informan el mismo reinicio semanal: se muestran una sola vez (el dato más nuevo).
  const vistos = new Map();
  for (const c of [...lista].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))) {
    const v = ventanaPrincipal(c);
    const clave = c.proveedor === 'claude' && v?.reset ? `claude|${Math.round(v.reset / 300)}` : c.id;
    if (!vistos.has(clave)) vistos.set(clave, { ...c, equipos: [c.equipo] });
    else vistos.get(clave).equipos.push(c.equipo);
  }
  return [...vistos.values()];
}
function filaPlan(c) {
  const [prov, colorProv] = PROVEEDOR[c.proveedor] || [c.proveedor, 'var(--acento)'];
  const nombre = c.proveedor === 'antigravity' ? `${prov} · ${String(c.cuenta).split('@')[1]?.split('.')[0] || c.cuenta}`
    : c.proveedor === 'claude' ? `${prov}${c.plan ? ` ${c.plan}` : ''} · ${String(c.cuenta).split('@')[0]}` : `${prov}${c.plan ? ` ${c.plan}` : ''}`;
  const v = ventanaPrincipal(c);
  const ahora = Date.now();
  if (!v) return '';
  const reset = v.reset ? v.reset * 1000 : null;
  const largo = v.ventana_min * 60e3;
  const reiniciado = reset && reset <= ahora;
  const cupo = reiniciado ? 1 : Math.max(0, Math.min(1, 1 - (Number(v.usado) || 0)));
  const tiempo = reset && !reiniciado ? Math.max(0, Math.min(1, (reset - ahora) / largo)) : 1;
  const color = cupo < 0.1 ? 'var(--mal)' : cupo + 0.05 < tiempo ? 'var(--warn)' : 'var(--ok)';
  const dias = reset && !reiniciado ? dur(reset - ahora) : '—';
  const cinco = (c.ventanas || []).find((x) => x.clave === '5h' && x.reset * 1000 > ahora);
  const nota = [
    cupo + 0.05 < tiempo ? 'vas más rápido que el tiempo' : '',
    cinco ? `5 h: queda ${Math.round((1 - cinco.usado) * 100)} %` : '',
    reiniciado ? 'ya se reinició' : '',
    Date.now() - Date.parse(c.ts) > 6 * 3600e3 ? `dato ${hace(c.ts)}` : '',
  ].filter(Boolean).join(' · ');
  return `<div style="display:grid;grid-template-columns:170px 1fr 150px;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--borde)">
    <div><b style="border-left:3px solid ${colorProv};padding-left:8px">${esc(nombre)}</b><div class="sub" style="padding-left:11px">${esc(c.cuenta)}</div></div>
    <div title="Barra gruesa: cupo que queda (${Math.round(cupo * 100)} %). Barra fina: tiempo que queda (${Math.round(tiempo * 100)} %).">
      <div style="position:relative;height:26px;background:var(--borde);border-radius:7px;overflow:hidden">
        <div style="position:absolute;inset:0 auto 0 0;width:${(cupo * 100).toFixed(1)}%;background:${color};opacity:.85"></div>
        <div style="position:absolute;left:0;top:10px;height:6px;width:${(tiempo * 100).toFixed(1)}%;background:var(--txt);opacity:.75;border-radius:3px"></div>
      </div>
      ${nota ? `<div class="sub" style="margin-top:3px">${esc(nota)}</div>` : ''}
    </div>
    <div style="text-align:right"><div style="font-size:20px;font-weight:700">${Math.round(cupo * 100)} %</div><div class="sub">quedan ${esc(dias)}</div></div>
  </div>`;
}

export function iniciarSuscripciones(c) {
  ctx = c;
  $('sReglas').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-alternar]');
    if (!b) return;
    b.disabled = true;
    try {
      await adminSus('PATCH', `/admin/reglas/${b.dataset.alternar}`, { activa: b.dataset.activa !== 'true' });
      await pintarReglasPlan();
    } catch (e) { alert(`No se pudo cambiar la regla: ${e.message}`); b.disabled = false; }
  });
}

async function adminSus(metodo, ruta, cuerpo) {
  const { data: { session } } = await ctx.sb.auth.getSession();
  const r = await fetch(ruta, { method: metodo, headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.access_token || ''}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return d;
}

// Reglas sobre los planes, con botón para activarlas o desactivarlas desde esta vista.
async function pintarReglasPlan() {
  let rs = [];
  try { rs = (await adminSus('GET', '/admin/reglas')).filter((r) => r.ventana_tipo === 'plan'); }
  catch (e) { $('sReglas').innerHTML = `<tr><td colspan="7" class="err">${esc(e.message)}</td></tr>`; return; }
  const n1 = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('es-CL', { maximumFractionDigits: 1 }));
  $('sReglas').innerHTML = rs.map((r) => {
    const c = Number(r.consumo);
    const estado = !r.activa ? '<span class="chip">desactivada</span>'
      : c >= Number(r.limite) ? `<span class="chip ${r.accion === 'cortar' ? 'cortar' : 'avisar'}">${r.accion === 'cortar' ? 'cortando' : 'superada'}</span>`
      : r.limite_aviso != null && c >= Number(r.limite_aviso) ? '<span class="chip avisar">en aviso</span>' : '<span class="chip ok">ok</span>';
    return `<tr class="${r.activa ? '' : 'inactiva'}"><td>${esc(r.nombre)}<div class="sub">${r.metrica === 'ritmo_plan' ? 'puntos sobre el ritmo' : '% del plan'} · ${r.plan_ventana === '5h' ? '5 horas' : 'semanal'} · ${esc(r.accion)}</div></td>
      <td>${esc(String(r.filtro_plan || '').replace(/^[a-z]+:/, ''))}</td><td class="n"><b>${n1(c)}</b></td><td class="n">${n1(r.limite_aviso)}</td><td class="n">${n1(r.limite)}</td>
      <td>${estado}</td><td class="n"><button class="chico ${r.activa ? '' : 'pri'}" data-alternar="${r.id}" data-activa="${r.activa}">${r.activa ? 'Desactivar' : 'Activar'}</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="sub">Sin reglas sobre los planes.</td></tr>';
}

let histFilas = [];
function pintarHistProyecto() {
  const dias = Number($('sHistDias')?.value || 30);
  const desde = diaChile(Date.now() - (dias - 1) * 864e5);
  const g = new Map();
  for (const f of histFilas.filter((x) => x.dia >= desde)) {
    const k = `${f.equipo}|${f.proyecto}|${f.usuario}`;
    const x = g.get(k) || { equipo: f.equipo, proyecto: f.proyecto, usuario: f.usuario, sesiones: 0, llamadas: 0, sub: 0, in: 0, out: 0, cw: 0, cr: 0, ultimo: null, modelos: new Map() };
    x.sesiones += Number(f.sesiones); x.llamadas += Number(f.llamadas); x.sub += Number(f.subagente);
    x.in += Number(f.tokens_in); x.out += Number(f.tokens_out); x.cw += Number(f.tokens_cache_write); x.cr += Number(f.tokens_cache_read);
    const t = Number(f.tokens_in) + Number(f.tokens_out) + Number(f.tokens_cache_write) + Number(f.tokens_cache_read);
    x.modelos.set(f.modelo, (x.modelos.get(f.modelo) || 0) + t);
    if (!x.ultimo || f.ultimo > x.ultimo) x.ultimo = f.ultimo;
    g.set(k, x);
  }
  const tot = (x) => x.in + x.out + x.cw + x.cr;
  const filas = [...g.values()].sort((a, b) => tot(b) - tot(a)).slice(0, 200);
  $('sHistProyecto').innerHTML = filas.map((x) => {
    const t = tot(x) || 1;
    const mods = [...x.modelos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, v]) => `${esc(m)} ${Math.round((v / t) * 100)} %`).join(' · ');
    return `<tr><td>${esc(x.equipo)}</td><td>${esc(x.proyecto)}<div class="sub">${mods}</div></td><td>${esc(x.usuario)}</td>
      <td class="n">${num(x.sesiones)}</td><td class="n">${num(x.llamadas)}</td><td class="n">${num(x.sub)}</td>
      <td class="n">${compacto(x.in)}</td><td class="n">${compacto(x.out)}</td><td class="n">${compacto(x.cw)}</td><td class="n">${compacto(x.cr)}</td>
      <td class="n"><b>${compacto(tot(x))}</b></td><td class="sub">${x.ultimo ? esc(fecha(x.ultimo, CORTA)) : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="12" class="sub">Sin histórico en ese período.</td></tr>';
}

export async function cargarSuscripciones(empresa) {
  pintarReglasPlan();
  const fe = (q) => (empresa ? q.eq('empresa_id', empresa) : q);
  const [{ data: cuentas, error: e1 }, { data: dias, error: e2 }, { data: recientes }] = await Promise.all([
    fe(ctx.sb.from('suscripciones_estado').select('*')).order('proveedor').order('cuenta'),
    fe(ctx.sb.from('v_suscripcion_tokens_dia').select('*')).order('dia'),
    fe(ctx.sb.from('v_suscripcion_reciente').select('ts,cliente,modelo,tokens_in,tokens_out,tokens_cache_write,tokens_cache_read,bloqueado,motivo'))
      .order('ts', { ascending: false }).limit(30),
  ]);
  fe(ctx.sb.from('v_suscripcion_historico_proyecto').select('*')).limit(50000).then(({ data, error }) => {
    if (error) { $('sHistProyecto').innerHTML = `<tr><td colspan="12" class="err">${esc(error.message)}</td></tr>`; return; }
    histFilas = data || [];
    pintarHistProyecto();
  });
  if ($('sHistDias') && !$('sHistDias').dataset.listo) { $('sHistDias').dataset.listo = '1'; $('sHistDias').addEventListener('change', pintarHistProyecto); }
  if (e1 || e2) { $('sPlan').innerHTML = `<div class="err">${esc((e1 || e2).message)}</div>`; return; }

  // Todas las suscripciones de un vistazo: una tarjeta por cuenta.
  const lista = cuentas || [];
  const planes = lista.map((c) => ({ ...c, equipos: [c.equipo] })).sort((a, b) => Object.keys(PROVEEDOR).indexOf(a.proveedor) - Object.keys(PROVEEDOR).indexOf(b.proveedor));
  $('sPlan').innerHTML = planes.length
    ? `<div class="card" style="grid-column:1/-1"><div class="fila-titulo"><h2>Planes</h2><span class="sub">barra gruesa = cupo que queda · barra fina = tiempo que queda</span></div>${planes.map(filaPlan).join('')}</div>`
    : '<div class="card sub">Todavía no llega el uso de ninguna suscripción.</div>';
  $('sPlanInfo').innerHTML = 'Claude llega solo con cada llamada de Claude Code por el gateway; Codex y Antigravity, con un colector propio. '
    + 'El ritmo compara cuánto cupo usaste con cuánto tiempo pasó de la ventana.';
  const claude7 = lista.filter((c) => c.proveedor === 'claude').flatMap((c) => c.ventanas || []).filter((v) => v.clave === '7d' && v.reset).sort((a, b) => b.reset - a.reset)[0];
  let inicioSemana = claude7 ? claude7.reset * 1000 - 7 * 864e5 : Date.now() - 7 * 864e5;

  // Tokens por equipo desde que empezó la semana del plan.
  const desdeDia = diaChile(inicioSemana);
  const semana = (dias || []).filter((d) => d.dia >= desdeDia);
  const hoy = diaChile(Date.now());
  const total = (f) => Number(f.tokens_in) + Number(f.tokens_out) + Number(f.tokens_cache_read) + Number(f.tokens_cache_write);
  const suma = (arr, fn) => arr.reduce((s, f) => s + fn(f), 0);
  $('sKpis').innerHTML = [
    ['Tokens hoy', compacto(suma(semana.filter((d) => d.dia === hoy), total))],
    ['Tokens en la semana del plan', compacto(suma(semana, total))],
    ['Llamadas en la semana', num(suma(semana, (d) => Number(d.llamadas)))],
    ['Bloqueos en la semana', num(suma(semana, (d) => Number(d.bloqueos)))],
  ].map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  $('sSemanaDesde').textContent = `desde el ${fecha(inicioSemana, LARGA)}`;

  const porEquipo = new Map();
  for (const d of semana) {
    const x = porEquipo.get(d.cliente) || { llamadas: 0, in: 0, out: 0, cr: 0, cw: 0, hoy: 0, ultimo: null, modelos: new Map() };
    x.llamadas += Number(d.llamadas); x.in += Number(d.tokens_in); x.out += Number(d.tokens_out);
    x.cr += Number(d.tokens_cache_read); x.cw += Number(d.tokens_cache_write);
    if (d.dia === hoy) x.hoy += total(d);
    if (!x.ultimo || d.ultimo > x.ultimo) x.ultimo = d.ultimo;
    x.modelos.set(d.modelo, (x.modelos.get(d.modelo) || 0) + total(d));
    porEquipo.set(d.cliente, x);
  }
  const tot = (x) => x.in + x.out + x.cr + x.cw;
  const totSemana = suma(semana, total) || 1;
  $('sEquipos').innerHTML = [...porEquipo.entries()].sort((a, b) => tot(b[1]) - tot(a[1])).map(([n, x]) => {
    const t = tot(x);
    const pct = Math.round((t / totSemana) * 100);
    const mods = [...x.modelos.entries()].sort((a, b) => b[1] - a[1]).map(([m, v]) => `${esc(m)} ${Math.round((v / (t || 1)) * 100)} %`).join(' · ');
    return `<tr><td>${esc(n)}<div class="sub">${mods}</div></td><td class="n">${num(x.llamadas)}</td><td class="n">${compacto(x.hoy)}</td>
      <td class="n">${compacto(x.in)}</td><td class="n">${compacto(x.out)}</td><td class="n">${compacto(x.cw)}</td><td class="n">${compacto(x.cr)}</td>
      <td class="n"><b>${compacto(t)}</b></td><td>${pct} %<div class="barra"><i style="width:${pct}%;background:var(--acento)"></i></div></td>
      <td class="sub">${x.ultimo ? esc(fecha(x.ultimo, CORTA)) : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="10" class="sub">Sin uso en esta semana del plan.</td></tr>';

  // Tokens por día y equipo (últimos 14 días).
  const desde14 = diaChile(Date.now() - 13 * 864e5);
  const ult = (dias || []).filter((d) => d.dia >= desde14);
  const fechas = [...new Set(ult.map((d) => d.dia))].sort();
  const equipos = [...new Set(ult.map((d) => d.cliente))];
  grafico?.destroy();
  grafico = null;
  if (window.Chart && fechas.length) {
    grafico = new window.Chart($('sGrafico'), {
      type: 'bar',
      data: { labels: fechas.map((f) => f.slice(5)), datasets: equipos.map((e, i) => ({ label: e, backgroundColor: COLORES[i % COLORES.length],
        data: fechas.map((f) => suma(ult.filter((d) => d.dia === f && d.cliente === e), total)) })) },
      options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => compacto(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${num(c.raw)} tokens` } } } },
    });
  }

  // Histórico por semana (lunes) y equipo.
  const lunes = (dia) => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const semanas = [...new Set((dias || []).map((d) => lunes(d.dia)))].sort();
  const equiposH = [...new Set((dias || []).map((d) => d.cliente))];
  graficoHist?.destroy();
  graficoHist = null;
  if (window.Chart && semanas.length) {
    graficoHist = new window.Chart($('sHistorico'), {
      type: 'bar',
      data: { labels: semanas.map((s) => s.slice(5)), datasets: equiposH.map((e, i) => ({ label: e, backgroundColor: COLORES[i % COLORES.length],
        data: semanas.map((s) => suma((dias || []).filter((d) => d.cliente === e && lunes(d.dia) === s), total)) })) },
      options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => compacto(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${num(c.raw)} tokens` } } } },
    });
  }

  $('sRecientes').innerHTML = (recientes || []).map((f) => `<tr class="${f.bloqueado ? 'bloqueado' : ''}">
    <td>${esc(fecha(f.ts, CORTA))}</td><td>${esc(f.cliente)}</td><td>${esc(f.modelo || '¿?')}</td>
    <td class="n">${num(f.tokens_in)}</td><td class="n">${num(f.tokens_out)}</td><td class="n">${num(f.tokens_cache_write)}</td>
    <td class="n">${num(f.tokens_cache_read)}</td><td>${f.bloqueado ? `bloqueado: ${esc(f.motivo)}` : 'ok'}</td></tr>`).join('')
    || '<tr><td colspan="8" class="sub">Sin llamadas en las últimas 48 h.</td></tr>';
}
