// Panel: reglas de uso (crear, editar, activar, borrar) y uso de la suscripción.
// Las escrituras van por /admin con la sesión del panel; las lecturas de consumo, por Supabase (RLS).
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const METRICA = { tokens: 'tokens', tokens_out: 'tokens de salida', costo_usd: 'US$', llamadas: 'llamadas', pct_plan: '% del plan', ritmo_plan: 'puntos sobre el ritmo' };
const ES_PLAN = (m) => m === 'pct_plan' || m === 'ritmo_plan';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, dec = 0) => Number(n || 0).toLocaleString('es-CL', { maximumFractionDigits: dec });
const compacto = (n) => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const hora = (ts) => new Date(ts).toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

let ctx = null;          // { sb, empresas, alCambiar }
let reglas = [];
let clientes = [];
let editando = null;
let planes = [];         // suscripciones_estado: [{ id, proveedor, cuenta }]

async function admin(metodo, ruta, cuerpo) {
  const { data: { session } } = await ctx.sb.auth.getSession();
  const r = await fetch(ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.access_token || ''}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return d;
}

// ---------- reglas ----------
function ventana(r) {
  if (r.ventana_tipo === 'plan') return `plan ${r.plan_ventana === '5h' ? '5 horas' : 'semanal'}`;
  if (r.ventana_tipo === 'calendario') return { dia: 'hoy', semana: 'esta semana', mes: 'este mes' }[r.ventana_periodo];
  const m = r.ventana_minutos;
  if (m % 1440 === 0) return `últimos ${m / 1440} día(s)`;
  if (m % 60 === 0) return `últimas ${m / 60} h`;
  return `últimos ${m} min`;
}

function filtros(r) {
  const cliente = clientes.find((c) => c.id === r.filtro_cliente_id);
  const partes = [
    ctx.empresas.length > 1 && r.empresa_id,
    r.filtro_plan && `plan ${r.filtro_plan.replace(/^[a-z]+:/, '')}`, cliente && `cliente ${cliente.nombre}`, r.filtro_modo, r.filtro_proveedor, r.filtro_modelo && `modelo «${r.filtro_modelo}»`,
    r.horario_dias?.length && `${r.horario_dias.map((d) => DIAS[d]).join(' ')} ${r.horario_desde.slice(0, 5)}–${r.horario_hasta.slice(0, 5)}`,
  ].filter(Boolean);
  return partes.map((p) => `<span class="chip">${esc(p)}</span>`).join(' ') || '<span class="chip">todo</span>';
}

function barra(consumo, limite, plan) {
  if (!Number(limite) && !plan) return '<span class="chip">franja</span>';
  if (!Number(limite)) limite = 1e-9;
  const pct = Math.min(1, consumo / limite);
  const color = pct >= 1 ? 'var(--mal)' : pct >= 0.75 ? 'var(--warn)' : 'var(--ok)';
  return `<div class="barra" title="${Math.round(pct * 100)} %"><i style="width:${pct * 100}%;background:${color}"></i></div>`;
}

function pintarReglas() {
  $('tReglas').innerHTML = reglas.map((r) => {
    const dec = r.metrica === 'costo_usd' || ES_PLAN(r.metrica) ? 1 : 0;
    const disparada = r.activa && r.en_horario && r.consumo >= Number(r.limite);
    return `<tr class="${r.activa ? '' : 'inactiva'}">
      <td><strong>${esc(r.nombre)}</strong><br>${filtros(r)}</td>
      <td>${esc(ventana(r))}</td>
      <td class="n">${num(r.consumo, dec)} / ${num(r.limite, dec)}<div class="sub">${esc(METRICA[r.metrica])}${r.limite_aviso != null ? ` · aviso en ${num(r.limite_aviso, dec)}` : ''}</div></td>
      <td>${barra(Math.max(0, r.consumo), Number(r.limite), ES_PLAN(r.metrica))}</td>
      <td><span class="chip ${r.accion}">${r.accion}</span> ${disparada ? '<span class="chip disparada">disparada</span>' : ''}
          ${r.horario_dias?.length && !r.en_horario ? '<span class="chip">fuera de horario</span>' : ''}</td>
      <td class="n" style="white-space:nowrap">
        <button class="chico" data-alternar="${r.id}">${r.activa ? 'Desactivar' : 'Activar'}</button>
        <button class="chico" data-editar="${r.id}">Editar</button>
        <button class="chico" data-borrar="${r.id}">Borrar</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="sub">Sin reglas: todo pasa y solo se mide.</td></tr>';
}

export async function cargarReglas(empresa) {
  $('errReglas').textContent = '';
  try {
    const [rs, { data: cs }, { data: ps }] = await Promise.all([
      admin('GET', `/admin/reglas${empresa ? `?empresa=${encodeURIComponent(empresa)}` : ''}`),
      ctx.sb.from('clientes').select('id,nombre,empresa_id').order('nombre'),
      ctx.sb.from('suscripciones_estado').select('id,empresa_id,proveedor,cuenta').order('proveedor'),
    ]);
    reglas = rs;
    planes = ps || [];
    clientes = cs || [];
    pintarReglas();
  } catch (e) {
    $('errReglas').textContent = `No se pudieron cargar las reglas: ${e.message}`;
  }
}

// ---------- suscripción ----------
export async function cargarSuscripcion(empresa) {
  let q = ctx.sb.from('v_suscripcion_reciente').select('*').order('ts', { ascending: false }).limit(500);
  if (empresa) q = q.eq('empresa_id', empresa);
  const { data, error } = await q;
  if (error) { $('tSuscripcion').innerHTML = `<tr><td colspan="9" class="err">${esc(error.message)}</td></tr>`; return; }
  const filas = data || [];
  const peso = (f) => f.tokens_in + f.tokens_out + f.tokens_cache_write;
  const desde5h = Date.now() - 5 * 3600e3;
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
  const esHoy = (f) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date(f.ts)) === hoy;
  const ok = filas.filter((f) => !f.bloqueado);
  const suma = (arr, fn) => arr.reduce((s, f) => s + fn(f), 0);
  const kpis = [
    ['Tokens hoy', compacto(suma(ok.filter(esHoy), peso))],
    ['Tokens últimas 5 h', compacto(suma(ok.filter((f) => new Date(f.ts) >= desde5h), peso))],
    ['Llamadas hoy', num(ok.filter(esHoy).length)],
    ['Bloqueos hoy', num(filas.filter((f) => f.bloqueado && esHoy(f)).length)],
    ['Equivalente API hoy', `US$ ${num(suma(ok.filter(esHoy), (f) => Number(f.costo_equivalente_usd)), 2)}`],
  ];
  $('kSuscripcion').innerHTML = kpis.map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  $('tSuscripcion').innerHTML = filas.slice(0, 40).map((f) => `<tr class="${f.bloqueado ? 'bloqueado' : ''}">
    <td>${hora(f.ts)}</td><td>${esc(f.cliente)}</td><td>${esc(f.modelo || '¿?')}</td>
    <td class="n">${num(f.tokens_in)}</td><td class="n">${num(f.tokens_out)}</td><td class="n">${num(f.tokens_cache_write)}</td>
    <td class="n">${num(f.tokens_cache_read)}</td><td class="n">US$ ${num(f.costo_equivalente_usd, 3)}</td>
    <td>${f.bloqueado ? `bloqueado: ${esc(f.motivo)}` : 'ok'}</td></tr>`).join('')
    || '<tr><td colspan="9" class="sub">Todavía no pasa nada por /suscripcion/anthropic.</td></tr>';
}

// ---------- formulario ----------
function visibles() {
  const f = $('fRegla');
  const plan = ES_PLAN(f.metrica.value);
  f.querySelectorAll('.si-plan').forEach((e) => e.classList.toggle('oculto', !plan));
  f.querySelectorAll('.si-consumo').forEach((e) => e.classList.toggle('oculto', plan));
  $('rAyudaPlan').textContent = f.metrica.value === 'ritmo_plan'
    ? 'Ej. 10 en semanal: con 3 de 7 días pasados (43 %), se dispara al llegar a 53 % usado. 0 = cortar apenas vayas más rápido que el tiempo.'
    : 'Ej. 90: se dispara al llegar al 90 % usado de la ventana. Cortar solo frena lo que pasa por el gateway (Claude Code); en Codex y Antigravity sirve para avisar.';
  const movil = f.ventana_tipo.value === 'movil';
  f.querySelector('.si-movil').classList.toggle('oculto', !movil);
  f.querySelector('.si-calendario').classList.toggle('oculto', movil);
  f.querySelector('.si-horario').classList.toggle('oculto', !f.usar_horario.checked);
}

function opcionesClientes(empresa, elegido) {
  $('rCliente').innerHTML = '<option value="">Todos los clientes</option>' + clientes.filter((c) => c.empresa_id === empresa)
    .map((c) => `<option value="${esc(c.id)}" ${c.id === elegido ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
}

function abrir(regla) {
  const f = $('fRegla');
  f.reset();
  editando = regla?.id || null;
  $('tituloRegla').textContent = regla ? 'Editar regla' : 'Nueva regla';
  $('errRegla').textContent = '';
  const empresaFiltro = $('filtroEmpresa').value;
  $('rEmpresa').innerHTML = ctx.empresas.map((e) => `<option value="${esc(e.id)}">${esc(e.nombre)}</option>`).join('');
  $('rEmpresa').value = regla?.empresa_id || empresaFiltro || ctx.empresas[0]?.id || '';
  $('rEmpresa').disabled = Boolean(regla);
  opcionesClientes($('rEmpresa').value, regla?.filtro_cliente_id);
  const PROV = { claude: 'Claude', chatgpt: 'Codex', antigravity: 'Antigravity' };
  $('rPlan').innerHTML = planes.map((p) => `<option value="${esc(p.id)}">${esc(PROV[p.proveedor] || p.proveedor)} · ${esc(p.cuenta)}</option>`).join('');
  if (regla) {
    if (regla.filtro_plan) f.filtro_plan.value = regla.filtro_plan;
    if (regla.plan_ventana) f.plan_ventana.value = regla.plan_ventana;
    for (const k of ['nombre', 'metrica', 'limite', 'limite_aviso', 'ventana_tipo', 'filtro_modo', 'filtro_proveedor', 'filtro_modelo']) f[k].value = regla[k] ?? '';
    if (regla.ventana_minutos) f.ventana_minutos.value = regla.ventana_minutos;
    if (regla.ventana_periodo) f.ventana_periodo.value = regla.ventana_periodo;
    f.usar_horario.checked = Boolean(regla.horario_dias?.length);
    if (regla.horario_dias?.length) {
      f.querySelectorAll('[name=dia]').forEach((c) => { c.checked = regla.horario_dias.includes(Number(c.value)); });
      f.horario_desde.value = regla.horario_desde.slice(0, 5);
      f.horario_hasta.value = regla.horario_hasta.slice(0, 5);
    }
    f.querySelector(`[name=accion][value=${regla.accion}]`).checked = true;
    f.activa.checked = regla.activa;
  }
  visibles();
  $('dlgRegla').showModal();
}

function leer() {
  const f = $('fRegla');
  const r = {
    empresa_id: $('rEmpresa').value, nombre: f.nombre.value, metrica: f.metrica.value, limite: Number(f.limite.value),
    limite_aviso: f.limite_aviso.value === '' ? null : Number(f.limite_aviso.value),
    accion: f.querySelector('[name=accion]:checked').value, activa: f.activa.checked,
    ventana_tipo: ES_PLAN(f.metrica.value) ? 'plan' : f.ventana_tipo.value,
    filtro_plan: ES_PLAN(f.metrica.value) ? f.filtro_plan.value : null,
    plan_ventana: ES_PLAN(f.metrica.value) ? f.plan_ventana.value : null,
    ventana_minutos: f.ventana_tipo.value === 'movil' ? Number(f.ventana_minutos.value) : null,
    ventana_periodo: f.ventana_tipo.value === 'calendario' ? f.ventana_periodo.value : null,
    filtro_cliente_id: f.filtro_cliente_id.value || null, filtro_modo: f.filtro_modo.value || null,
    filtro_proveedor: f.filtro_proveedor.value || null, filtro_modelo: f.filtro_modelo.value || null,
    horario_dias: null, horario_desde: null, horario_hasta: null,
  };
  if (f.usar_horario.checked) {
    r.horario_dias = [...f.querySelectorAll('[name=dia]:checked')].map((c) => Number(c.value));
    r.horario_desde = f.horario_desde.value;
    r.horario_hasta = f.horario_hasta.value;
  }
  return r;
}

export function iniciarReglas(opciones) {
  const primeraVez = !ctx;
  ctx = opciones;
  if (!primeraVez) return;
  const f = $('fRegla');
  $('rDias').innerHTML = DIAS.map((d, i) => `<label><input type="checkbox" name="dia" value="${i}" checked>${d}</label>`).join('');
  f.ventana_tipo.addEventListener('change', visibles);
  f.metrica.addEventListener('change', visibles);
  f.usar_horario.addEventListener('change', visibles);
  $('rEmpresa').addEventListener('change', () => opcionesClientes($('rEmpresa').value));
  $('nuevaRegla').onclick = () => abrir(null);
  $('cancelarRegla').onclick = () => $('dlgRegla').close();
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = leer();
      if (editando) { delete r.empresa_id; await admin('PATCH', `/admin/reglas/${editando}`, r); }
      else await admin('POST', '/admin/reglas', r);
      $('dlgRegla').close();
      ctx.alCambiar();
    } catch (e) { $('errRegla').textContent = e.message; }
  });
  $('tReglas').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const regla = reglas.find((r) => r.id === (b.dataset.editar || b.dataset.alternar || b.dataset.borrar));
    try {
      if (b.dataset.editar) return abrir(regla);
      if (b.dataset.alternar) await admin('PATCH', `/admin/reglas/${regla.id}`, { activa: !regla.activa });
      if (b.dataset.borrar) {
        if (!confirm(`¿Borrar la regla «${regla.nombre}»?`)) return;
        await admin('DELETE', `/admin/reglas/${regla.id}`);
      }
      ctx.alCambiar();
    } catch (e) { $('errReglas').textContent = e.message; }
  });
}
