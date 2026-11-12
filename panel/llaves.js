// Panel: llaves. Llaves reales de OpenAI/Anthropic (normales y de administración), llaves de clientes (tfk_)
// y de administración del gateway (tfa_). Toda llave lleva fecha de expiración obligatoria y descripción opcional.
// Todo va por /admin con la sesión del panel; la API decide qué puede hacer cada usuario.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fecha = (iso) => (iso ? new Date(iso).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' }) : '—');
const aFechaInput = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(iso ? new Date(iso) : new Date());
const enDias = (n) => aFechaInput(new Date(Date.now() + n * 864e5).toISOString());

let ctx = null;          // { sb, empresas, superadmin }
let datos = { credenciales: [], llaves: [], admins: [], clientes: [] };
let editando = null;     // { tipo: 'credencial'|'llave'|'admin', id }

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

function vence(iso) {
  const dias = Math.floor((Date.parse(iso) - Date.now()) / 864e5);
  if (dias < 0) return `<span class="chip" style="background:var(--mal);color:#fff">venció ${fecha(iso)}</span>`;
  if (dias <= 7) return `<span class="chip" style="background:var(--warn);color:#fff">vence ${fecha(iso)} (${dias} d)</span>`;
  if (dias <= 30) return `<span class="chip" style="background:#fde68a;color:#78350f">vence ${fecha(iso)}</span>`;
  return `<span class="sub">${fecha(iso)}</span>`;
}

const estado = (activa) => (activa ? '' : ' <span class="chip">inactiva</span>');
const boton = (accion, tipo, id, texto) => `<button data-accion="${accion}" data-tipo="${tipo}" data-id="${id}">${texto}</button>`;

function pintar() {
  const empresa = $('filtroEmpresa').value;
  const deEmpresa = (x) => !empresa || x.empresa_id === empresa;

  $('bloqueProveedor').classList.toggle('oculto', !ctx.superadmin);
  $('bloqueAdminGw').classList.toggle('oculto', !ctx.superadmin);

  $('tCredenciales').innerHTML = datos.credenciales.filter(deEmpresa).map((c) => `<tr>
      <td>${esc(c.empresa_id)}</td><td>${esc(c.proveedor)}</td>
      <td>${c.tipo === 'admin' ? '<span class="chip">admin</span>' : 'normal'}</td>
      <td><code>…${esc(c.huella)}</code>${estado(c.activa)}</td><td>${esc(c.descripcion || '')}</td><td>${vence(c.expira)}</td>
      <td class="n">${boton('editar', 'credencial', c.id, 'Editar')} ${c.activa ? boton('quitar', 'credencial', c.id, 'Desactivar') : ''}</td></tr>`).join('')
    || '<tr><td colspan="7" class="sub">No hay llaves de OpenAI ni Anthropic cargadas.</td></tr>';

  $('tLlavesClientes').innerHTML = datos.llaves.filter(deEmpresa).map((k) => `<tr>
      <td>${esc(k.empresa_id)} · ${esc(k.clientes?.nombre || '')}</td><td><code>${esc(k.prefijo)}…</code>${estado(k.activa)}</td>
      <td>${esc(k.descripcion || k.nombre || '')}</td><td>${vence(k.expira)}</td>
      <td class="sub">${k.ultimo_uso ? fecha(k.ultimo_uso) : 'nunca'}</td>
      <td class="n">${boton('editar', 'llave', k.id, 'Editar')} ${k.activa ? boton('quitar', 'llave', k.id, 'Revocar') : ''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="sub">Sin llaves de clientes.</td></tr>';

  $('tLlavesAdmin').innerHTML = datos.admins.filter((a) => !empresa || a.empresa_id === empresa || !a.empresa_id).map((a) => `<tr>
      <td>${esc(a.empresa_id || 'superadmin')}</td><td><code>${esc(a.prefijo)}…</code>${estado(a.activa)}</td>
      <td>${esc(a.descripcion || a.nombre || '')}</td><td>${vence(a.expira)}</td>
      <td class="n">${boton('editar', 'admin', a.id, 'Editar')} ${a.activa ? boton('quitar', 'admin', a.id, 'Revocar') : ''}</td></tr>`).join('')
    || '<tr><td colspan="5" class="sub">Sin llaves de administración.</td></tr>';
}

export async function cargarLlaves() {
  if (!ctx) return;
  try {
    const [llaves, clientes, credenciales, admins] = await Promise.all([
      admin('GET', '/admin/llaves'),
      admin('GET', '/admin/clientes'),
      ctx.superadmin ? admin('GET', '/admin/credenciales') : [],
      ctx.superadmin ? admin('GET', '/admin/llaves-admin') : [],
    ]);
    datos = { llaves, clientes, credenciales, admins };
    pintar();
  } catch (e) {
    $('tLlavesClientes').innerHTML = `<tr><td colspan="6" class="err">No se pudieron cargar las llaves: ${esc(e.message)}</td></tr>`;
  }
}

function opcionesEmpresa(sel, conSuper = false) {
  sel.innerHTML = (conSuper ? '<option value="">superadmin (todas)</option>' : '')
    + ctx.empresas.map((e) => `<option value="${esc(e.id)}">${esc(e.nombre)}</option>`).join('');
  if ($('filtroEmpresa').value) sel.value = $('filtroEmpresa').value;
}

// ---------- mostrar una llave nueva una sola vez ----------
function mostrarLlaveNueva(llave, detalle) {
  $('nuevaLlaveValor').value = llave;
  $('nuevaLlaveDetalle').textContent = detalle;
  $('dlgLlaveNueva').showModal();
}

// ---------- diálogos ----------
function abrirProveedor() {
  const f = $('fProveedor');
  f.reset();
  opcionesEmpresa(f.empresa_id);
  f.expira.value = enDias(365);
  f.expira.min = enDias(1);
  $('errProveedor').textContent = '';
  $('dlgProveedor').showModal();
}

async function guardarProveedor(ev) {
  ev.preventDefault();
  const f = $('fProveedor');
  try {
    const r = await admin('PUT', '/admin/credenciales', {
      empresa_id: f.empresa_id.value, proveedor: f.proveedor.value, tipo: f.tipo.value,
      valor: f.valor.value, expira: f.expira.value, descripcion: f.descripcion.value,
    });
    f.valor.value = '';
    $('dlgProveedor').close();
    await cargarLlaves();
    alertaBreve(`Cargada la llave ${r.tipo === 'admin' ? 'de administración' : 'normal'} de ${r.proveedor} para ${r.empresa_id} (…${r.huella}).`);
  } catch (e) { $('errProveedor').textContent = e.message; }
}

function abrirCliente() {
  const f = $('fLlaveCliente');
  f.reset();
  opcionesEmpresa(f.empresa_id);
  llenarClientes();
  f.expira.value = enDias(365);
  f.expira.min = enDias(1);
  $('errLlaveCliente').textContent = '';
  $('dlgLlaveCliente').showModal();
}

function llenarClientes() {
  const f = $('fLlaveCliente');
  const lista = datos.clientes.filter((c) => c.empresa_id === f.empresa_id.value);
  f.cliente_id.innerHTML = lista.map((c) => `<option value="${esc(c.cliente_id)}">${esc(c.nombre)}</option>`).join('')
    + '<option value="__nuevo">+ cliente nuevo…</option>';
  alternarClienteNuevo();
}

function alternarClienteNuevo() {
  const nuevo = $('fLlaveCliente').cliente_id.value === '__nuevo';
  $('camposClienteNuevo').classList.toggle('oculto', !nuevo);
  $('fLlaveCliente').nombre_cliente.required = nuevo;
}

async function guardarLlaveCliente(ev) {
  ev.preventDefault();
  const f = $('fLlaveCliente');
  const base = { expira: f.expira.value, descripcion: f.descripcion.value };
  try {
    let r;
    if (f.cliente_id.value === '__nuevo') {
      const d = await admin('POST', '/admin/clientes', {
        ...base, empresa_id: f.empresa_id.value, nombre: f.nombre_cliente.value,
        presupuesto_usd_mensual: Number(f.presupuesto.value || 0),
      });
      r = { ...d.llave, cliente: d.cliente.nombre };
    } else {
      r = await admin('POST', `/admin/clientes/${f.cliente_id.value}/llaves`, base);
      r.cliente = f.cliente_id.selectedOptions[0]?.textContent;
    }
    $('dlgLlaveCliente').close();
    await cargarLlaves();
    mostrarLlaveNueva(r.llave, `Cliente ${r.cliente} · vence el ${fecha(r.expira)}`);
  } catch (e) { $('errLlaveCliente').textContent = e.message; }
}

function abrirAdminGw() {
  const f = $('fAdminGw');
  f.reset();
  opcionesEmpresa(f.empresa_id, true);
  f.expira.value = enDias(180);
  f.expira.min = enDias(1);
  $('errAdminGw').textContent = '';
  $('dlgAdminGw').showModal();
}

async function guardarAdminGw(ev) {
  ev.preventDefault();
  const f = $('fAdminGw');
  try {
    const r = await admin('POST', '/admin/llaves-admin', {
      empresa_id: f.empresa_id.value || null, nombre: f.descripcion.value || null,
      expira: f.expira.value, descripcion: f.descripcion.value,
    });
    $('dlgAdminGw').close();
    await cargarLlaves();
    mostrarLlaveNueva(r.llave, `Administración de ${r.empresa_id || 'todas las empresas'} · vence el ${fecha(r.expira)}`);
  } catch (e) { $('errAdminGw').textContent = e.message; }
}

const RUTAS = { credencial: '/admin/credenciales/', llave: '/admin/llaves/', admin: '/admin/llaves-admin/' };
const LISTAS = { credencial: 'credenciales', llave: 'llaves', admin: 'admins' };

function abrirEditar(tipo, id) {
  const x = datos[LISTAS[tipo]].find((y) => y.id === id);
  if (!x) return;
  editando = { tipo, id };
  const f = $('fEditarLlave');
  f.expira.value = aFechaInput(x.expira);
  f.expira.min = enDias(1);
  f.descripcion.value = x.descripcion || '';
  $('errEditarLlave').textContent = '';
  $('dlgEditarLlave').showModal();
}

async function guardarEditar(ev) {
  ev.preventDefault();
  const f = $('fEditarLlave');
  try {
    await admin('PATCH', RUTAS[editando.tipo] + editando.id, { expira: f.expira.value, descripcion: f.descripcion.value });
    $('dlgEditarLlave').close();
    await cargarLlaves();
  } catch (e) { $('errEditarLlave').textContent = e.message; }
}

async function quitar(tipo, id) {
  const que = { credencial: 'desactivar esta llave del proveedor (las llamadas de esa empresa dejarán de funcionar)',
    llave: 'revocar esta llave (la app que la use dejará de funcionar)', admin: 'revocar esta llave de administración' }[tipo];
  const fila = document.querySelector(`[data-accion="quitar"][data-id="${id}"]`);
  if (fila && fila.dataset.confirmar !== '1') {
    fila.dataset.confirmar = '1';
    fila.textContent = '¿Seguro?';
    fila.title = `Haz clic otra vez para ${que}.`;
    setTimeout(() => { if (fila.isConnected) { fila.dataset.confirmar = ''; pintar(); } }, 4000);
    return;
  }
  try {
    await admin('DELETE', RUTAS[tipo] + id);
    await cargarLlaves();
  } catch (e) { alertaBreve(`No se pudo: ${e.message}`); }
}

function alertaBreve(texto) {
  const a = $('avisoLlaves');
  a.textContent = texto;
  a.classList.remove('oculto');
  setTimeout(() => a.classList.add('oculto'), 6000);
}

export function iniciarLlaves(opciones) {
  ctx = opciones;
  $('btnAgregarProveedor').onclick = abrirProveedor;
  $('btnNuevaLlaveCliente').onclick = abrirCliente;
  $('btnNuevaLlaveAdmin').onclick = abrirAdminGw;
  $('fProveedor').onsubmit = guardarProveedor;
  $('fLlaveCliente').onsubmit = guardarLlaveCliente;
  $('fAdminGw').onsubmit = guardarAdminGw;
  $('fEditarLlave').onsubmit = guardarEditar;
  $('fLlaveCliente').empresa_id.onchange = llenarClientes;
  $('fLlaveCliente').cliente_id.onchange = alternarClienteNuevo;
  $('btnCopiarLlave').onclick = async () => {
    await navigator.clipboard.writeText($('nuevaLlaveValor').value);
    $('btnCopiarLlave').textContent = 'Copiada';
  };
  $('dlgLlaveNueva').addEventListener('close', () => { $('nuevaLlaveValor').value = ''; $('btnCopiarLlave').textContent = 'Copiar'; });
  for (const id of ['dlgProveedor', 'dlgLlaveCliente', 'dlgAdminGw', 'dlgEditarLlave', 'dlgLlaveNueva']) {
    $(id).querySelectorAll('[data-cerrar]').forEach((b) => { b.onclick = () => $(id).close(); });
  }
  $('seccionLlaves').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-accion]');
    if (!b) return;
    if (b.dataset.accion === 'editar') abrirEditar(b.dataset.tipo, b.dataset.id);
    if (b.dataset.accion === 'quitar') quitar(b.dataset.tipo, b.dataset.id);
  });
}
