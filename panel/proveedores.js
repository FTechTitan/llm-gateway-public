// Panel: saldo de créditos y consumo por llave según OpenAI y Anthropic (sincronizado cada 6 h con las admin keys).
import { rango, proveedorFiltro } from '/panel/filtros.js?v=11';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (v) => 'US$ ' + Number(v || 0).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compacto = (n) => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
const fechaHora = (ts) => (ts ? new Date(ts).toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
let ctx = null;   // { sb, empresas, superadmin }

async function admin(metodo, ruta, cuerpo) {
  const { data: { session } } = await ctx.sb.auth.getSession();
  const r = await fetch(ruta, { method: metodo, headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.access_token || ''}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return d;
}

// Próxima recarga por llegar y próximo vencimiento de crédito sin usar.
function proximo(x) {
  const p = [];
  if (Number(x.por_llegar)) p.push(`+${usd(x.por_llegar)} llega el ${esc(x.proxima_recarga)}`);
  if (x.proximo_vencimiento) p.push(`${usd(x.monto_por_vencer)} vence el ${esc(x.proximo_vencimiento)}`);
  const r = x.ritmo;
  if (r && r.estado !== 'sin_datos') {
    const c = { se_pierde: 'var(--warn)', se_acaba: 'var(--mal)', en_ritmo: 'var(--ok, #16a34a)' }[r.estado];
    p.push(`<span style="color:${c}" title="${esc(r.mensaje)}">${{ se_pierde: '⚠ se pierde', se_acaba: '⚠ no alcanza', en_ritmo: '✓ en ritmo' }[r.estado]}`
      + `${r.ideal_dia !== null ? ` · gastar ${usd(r.ideal_dia)}/día (hoy ${usd(r.gasto_dia)})` : ''}</span>`);
  }
  return p.join('<br>') || '—';
}

export async function cargarProveedores() {
  if (!ctx) return;
  const empresa = $('filtroEmpresa').value;
  const { desde, hasta } = rango();
  const prov = proveedorFiltro();
  try {
    const [s, llaves] = await Promise.all([
      admin('GET', '/admin/saldos'),
      admin('GET', `/admin/consumo-proveedor?desde=${desde}&hasta=${hasta}${empresa ? `&empresa=${encodeURIComponent(empresa)}` : ''}`),
    ]);
    const saldos = s.saldos.filter((x) => !empresa || x.empresa_id === empresa);
    $('tSaldos').innerHTML = saldos.map((x) => {
      const color = Number(x.saldo) < 10 ? 'var(--mal)' : Number(x.saldo) < 50 ? 'var(--warn)' : 'inherit';
      return `<tr><td>${esc(x.empresa_id)}</td><td>${esc(x.proveedor)}</td><td class="n" style="color:${color};font-weight:600">${usd(x.saldo)}</td>
        <td class="n sub">${usd(x.saldo_inicial)} al ${esc(x.saldo_desde)}</td><td class="n sub">+${usd(x.recargas)}</td><td class="n sub">−${usd(x.gastado)}</td>
        <td class="n sub">${Number(x.perdido) ? '−' + usd(x.perdido) : '—'}</td><td class="sub">${proximo(x)}</td>
        <td class="sub">${fechaHora(x.actualizado)}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="sub">Sin saldo anotado. Usa «Anotar saldo o recarga» con lo que muestra la consola del proveedor.</td></tr>';

    $('tPorLlave').innerHTML = llaves.filter((k) => !prov || k.proveedor === prov).map((k) => {
      const tok = k.tokens_in + k.tokens_out + k.cache_read + k.cache_write;
      const top = Object.entries(k.modelos).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => esc(m)).join(', ');
      const est = k.sin_precio.length ? `${usd(k.usd_estimado)}<br><span class="sub" title="Modelos sin precio: ${esc(k.sin_precio.join(', '))}">+ sin precio</span>` : usd(k.usd_estimado);
      return `<tr><td>${esc(k.empresa_id)} · ${esc(k.proveedor)}</td><td><strong>${esc(k.llave_nombre || k.llave_id)}</strong><br><span class="sub">${esc(k.proyecto || '')}</span></td>
        <td class="n">${k.llamadas ? compacto(k.llamadas) : '—'}</td><td class="n">${compacto(tok)}</td><td class="n">${est}</td><td class="sub">${top}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="sub">Sin datos todavía (se sincroniza cada 6 horas).</td></tr>';
  } catch (e) {
    $('tPorLlave').innerHTML = `<tr><td colspan="6" class="err">No se pudo cargar: ${esc(e.message)}</td></tr>`;
  }
}

function abrirSaldo() {
  const f = $('fSaldo');
  f.reset();
  f.empresa_id.innerHTML = ctx.empresas.map((e) => `<option value="${esc(e.id)}">${esc(e.nombre)}</option>`).join('');
  if ($('filtroEmpresa').value) f.empresa_id.value = $('filtroEmpresa').value;
  f.fecha.value = hoy();
  $('errSaldo').textContent = '';
  $('dlgSaldo').showModal();
}

async function guardarSaldo(ev) {
  ev.preventDefault();
  const f = $('fSaldo');
  try {
    await admin('POST', '/admin/saldos', { empresa_id: f.empresa_id.value, proveedor: f.proveedor.value, tipo: f.tipo.value,
      monto_usd: Number(f.monto_usd.value), fecha: f.fecha.value, vence: f.vence.value || null, nota: f.nota.value });
    $('dlgSaldo').close();
    await cargarProveedores();
  } catch (e) { $('errSaldo').textContent = e.message; }
}

async function sincronizar() {
  const b = $('btnSincronizar');
  b.disabled = true; b.textContent = 'Sincronizando…';
  try { await admin('POST', '/admin/costos/sincronizar'); await cargarProveedores(); b.textContent = 'Sincronizado'; }
  catch (e) { b.textContent = 'Falló'; b.title = e.message; }
  finally { setTimeout(() => { b.disabled = false; b.textContent = 'Sincronizar ahora'; }, 3000); }
}

export function iniciarProveedores(opciones) {
  ctx = opciones;
  $('btnAnotarSaldo').classList.toggle('oculto', !ctx.superadmin);
  $('btnSincronizar').classList.toggle('oculto', !ctx.superadmin);
  $('btnAnotarSaldo').onclick = abrirSaldo;
  $('btnSincronizar').onclick = sincronizar;
  $('fSaldo').onsubmit = guardarSaldo;
  $('dlgSaldo').querySelectorAll('[data-cerrar]').forEach((b) => { b.onclick = () => $('dlgSaldo').close(); });
}
