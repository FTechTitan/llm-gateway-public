// Informe diario por correo: consumo de ayer, acumulado del mes, presupuesto restante
// y comparación con el costo real que informa cada proveedor.
import { config } from './config.mjs';
import { rest } from './db.mjs';
import { enviarCorreo } from './smtp.mjs';
import { sincronizarCostos } from './costos.mjs';
import { saldosConRitmo } from './ritmo.mjs';

const ZONA = 'America/Santiago';
const diaChile = (offsetDias = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date(Date.now() + offsetDias * 864e5));
const usd = (v) => `US$ ${Number(v || 0).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Llaves vencidas o que vencen en los próximos 7 días (de clientes, de administración y reales).
async function seccionVencimientos() {
  const limite = new Date(Date.now() + 7 * 864e5).toISOString();
  const [ks, as, cs] = await Promise.all([
    rest(`llaves?select=prefijo,descripcion,expira,empresa_id,clientes(nombre)&activa=eq.true&expira=lte.${limite}&order=expira`),
    rest(`llaves_admin?select=prefijo,descripcion,expira,empresa_id&activa=eq.true&expira=lte.${limite}&order=expira`),
    rest(`credenciales_proveedor?select=proveedor,tipo,huella,descripcion,expira,empresa_id&activa=eq.true&expira=lte.${limite}&order=expira`),
  ]);
  const filas = [
    ...cs.map((c) => ({ que: `${c.proveedor} ${c.tipo} …${c.huella}`, quien: c.empresa_id, desc: c.descripcion, expira: c.expira })),
    ...as.map((a) => ({ que: `admin ${a.prefijo}…`, quien: a.empresa_id || 'superadmin', desc: a.descripcion, expira: a.expira })),
    ...ks.map((k) => ({ que: `${k.prefijo}…`, quien: `${k.empresa_id} · ${k.clientes?.nombre || ''}`, desc: k.descripcion, expira: k.expira })),
  ];
  if (!filas.length) return '';
  const fecha = (iso) => new Date(iso).toLocaleDateString('es-CL', { timeZone: ZONA });
  return `<div style="border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;padding:10px 12px;margin:0 0 16px">
    <b>Llaves vencidas o por vencer (7 días)</b>
    <ul style="margin:6px 0 0;padding-left:18px">${filas.map((f) => {
      const vencio = Date.parse(f.expira) <= Date.now();
      return `<li style="color:${vencio ? '#b91c1c' : '#92400e'}">${esc(f.que)} · ${esc(f.quien)}${f.desc ? ` · ${esc(f.desc)}` : ''} — ${vencio ? 'venció' : 'vence'} el ${fecha(f.expira)}</li>`;
    }).join('')}</ul></div>`;
}

// Créditos con vencimiento o por llegar: ritmo de gasto y lo que se perdería.
async function seccionCreditos() {
  const filas = (await saldosConRitmo()).filter((s) => s.proximo_vencimiento || Number(s.por_llegar) > 0);
  if (!filas.length) return '';
  const color = { se_pierde: '#b45309', se_acaba: '#b91c1c', en_ritmo: '#166534', sin_datos: '#6b7280' };
  return `<div style="border:1px solid #93c5fd;background:#eff6ff;border-radius:8px;padding:10px 12px;margin:0 0 16px">
    <b>Créditos: ritmo de uso</b>
    <ul style="margin:6px 0 0;padding-left:18px">${filas.map((s) => `<li style="color:${color[s.ritmo.estado]}">
      <b>${esc(s.empresa_id)} · ${esc(s.proveedor)}</b>: saldo ${usd(s.saldo)}${Number(s.por_llegar) > 0 ? `, llegan ${usd(s.por_llegar)} el ${esc(s.proxima_recarga)}` : ''}.
      ${esc(s.ritmo.mensaje || 'Sin gasto registrado todavía.')}</li>`).join('')}</ul></div>`;
}

export async function armarReporte() {
  const ayer = diaChile(-1);
  const [diario, mes, empresas, reales] = await Promise.all([
    rest(`v_consumo_diario?dia=eq.${ayer}&select=*`),
    rest('v_consumo_mes_cliente?select=*&order=empresa_id,gastado_mes.desc'),
    rest('empresas?select=id,nombre&order=id'),
    rest(`costos_proveedor?dia=eq.${ayer}&select=*`),
  ]);
  const ayerPorCliente = new Map();
  for (const f of diario) ayerPorCliente.set(f.cliente_id, (ayerPorCliente.get(f.cliente_id) || 0) + Number(f.costo_usd));

  let html = `<div style="font-family:system-ui,Arial,sans-serif;color:#1f2937">
    <h2 style="margin:0 0 4px">Consumo de IA del ${ayer}</h2>
    <p style="margin:0 0 16px;color:#6b7280">Gateway llm.example.com · montos en dólares</p>`;
  html += await seccionCreditos().catch(() => '');
  html += await seccionVencimientos();
  for (const e of empresas) {
    const clientes = mes.filter((c) => c.empresa_id === e.id);
    const totalAyer = diario.filter((f) => f.empresa_id === e.id).reduce((s, f) => s + Number(f.costo_usd), 0);
    const totalMes = clientes.reduce((s, c) => s + Number(c.gastado_mes), 0);
    const real = reales.filter((r) => r.empresa_id === e.id);
    const realTxt = real.length
      ? real.map((r) => `${r.proveedor}: ${usd(r.costo_usd)}`).join(' · ')
      : 'sin dato (falta admin key o aún no se informa)';
    html += `<h3 style="margin:20px 0 6px">${esc(e.nombre)}</h3>
      <p style="margin:0 0 8px">Ayer: <b>${usd(totalAyer)}</b> · Mes: <b>${usd(totalMes)}</b><br>
      <span style="color:#6b7280">Costo real informado por el proveedor ayer: ${esc(realTxt)}</span></p>`;
    if (!clientes.length) { html += '<p style="color:#6b7280">Sin clientes.</p>'; continue; }
    html += `<table style="border-collapse:collapse;width:100%;font-size:14px">
      <tr style="background:#f3f4f6"><th align="left" style="padding:6px">Cliente</th><th align="right" style="padding:6px">Ayer</th>
      <th align="right" style="padding:6px">Mes</th><th align="right" style="padding:6px">Presupuesto</th><th align="right" style="padding:6px">Restante</th></tr>`;
    for (const c of clientes) {
      const pres = Number(c.presupuesto_usd_mensual);
      const pct = pres > 0 ? Number(c.gastado_mes) / pres : 0;
      const color = pct >= 1 ? '#b91c1c' : pct >= 0.8 ? '#b45309' : '#111827';
      html += `<tr style="border-top:1px solid #e5e7eb"><td style="padding:6px">${esc(c.nombre)}${c.activo ? '' : ' (inactivo)'}</td>
        <td align="right" style="padding:6px">${usd(ayerPorCliente.get(c.cliente_id))}</td>
        <td align="right" style="padding:6px">${usd(c.gastado_mes)}</td>
        <td align="right" style="padding:6px">${pres > 0 ? usd(pres) : 'sin tope'}</td>
        <td align="right" style="padding:6px;color:${color}">${pres > 0 ? `${usd(c.restante)} (${Math.round(pct * 100)} %)` : '—'}</td></tr>`;
    }
    html += '</table>';
  }
  html += `<p style="margin-top:20px"><a href="${config.urlPublica}/panel/">Abrir el panel</a></p></div>`;
  return { asunto: `Consumo de IA del ${ayer}`, html };
}

export async function enviarReporte() {
  if (!config.reportePara.length) throw Object.assign(new Error('Falta REPORTE_PARA.'), { status: 400 });
  await sincronizarCostos().catch((e) => console.error(`Sincronizar costos antes del reporte: ${e.message}`));
  const { asunto, html } = await armarReporte();
  await enviarCorreo({ para: config.reportePara, asunto, html });
  return { ok: true, para: config.reportePara, asunto };
}

// Revisa cada 5 minutos si ya es la hora del reporte en Chile y no se mandó hoy.
let ultimoEnvio = null;
export function programarReporte() {
  return setInterval(async () => {
    const hoy = diaChile(0);
    const hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hour12: false }).format(new Date()));
    if (hora !== config.reporteHora || ultimoEnvio === hoy || !config.reportePara.length) return;
    ultimoEnvio = hoy;
    try { await enviarReporte(); console.log(`Reporte diario enviado ${hoy}`); }
    catch (e) { console.error(`Reporte diario falló: ${e.message}`); ultimoEnvio = null; }
  }, 5 * 60 * 1000).unref();
}
