// Ritmo de créditos: ¿al gasto actual se pierde crédito al vencer, o se acaba antes de la próxima recarga?
// Lógica pura (sin base), para el panel, los avisos push y el correo diario.

const DIA = 864e5;
const dias = (desde, hasta) => Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / DIA);

// Días mínimos de saldo sin recarga anotada antes de avisar.
export const DIAS_MINIMOS = 14;

// Umbral para no avisar por centavos: se pierde algo si sobra más de US$5 o del 10 % del crédito.
export const umbralPerdida = (monto) => Math.max(5, 0.1 * monto);

/**
 * @param s      fila de v_saldo_proveedor (saldo, proximo_vencimiento, monto_por_vencer, por_llegar, proxima_recarga)
 * @param porDia gasto real promedio por día (últimos 7 días) de esa empresa y proveedor
 * @param hoy    AAAA-MM-DD (hora de Chile)
 */
export function ritmo(s, porDia, hoy) {
  const saldo = Number(s.saldo || 0);
  const gasto = Math.max(0, Number(porDia || 0));
  const r = { gasto_dia: gasto, estado: 'sin_datos', dias_para_vencer: null, ideal_dia: null, sobrante: null, se_acaba: null, mensaje: '' };

  if (s.proximo_vencimiento && Number(s.monto_por_vencer) > 0) {
    const monto = Number(s.monto_por_vencer);
    const quedan = Math.max(1, dias(hoy, s.proximo_vencimiento) + 1);   // el día del vencimiento todavía se puede usar
    r.dias_para_vencer = quedan;
    r.ideal_dia = monto / quedan;
    r.sobrante = Math.max(0, monto - gasto * quedan);
    if (r.sobrante > umbralPerdida(monto)) {
      r.estado = 'se_pierde';
      r.mensaje = `A este ritmo (US$ ${gasto.toFixed(2)}/día) vencen ~US$ ${r.sobrante.toFixed(2)} sin usar el ${s.proximo_vencimiento}. `
        + `Para usarlo todo hay que gastar US$ ${r.ideal_dia.toFixed(2)}/día durante ${quedan} ${quedan === 1 ? 'día' : 'días'}.`;
      return r;
    }
  }

  // ¿Alcanza hasta la próxima recarga? (si no hay recarga anotada, hasta el vencimiento)
  const hasta = s.proxima_recarga || s.proximo_vencimiento;
  if (gasto > 0 && hasta) {
    const diasAlcanza = saldo / gasto;
    const diasHasta = dias(hoy, hasta);
    if (diasAlcanza < diasHasta) {
      const fin = new Date(Date.parse(`${hoy}T12:00:00Z`) + Math.floor(diasAlcanza) * DIA).toISOString().slice(0, 10);
      r.estado = 'se_acaba';
      r.se_acaba = fin;
      r.mensaje = `A este ritmo (US$ ${gasto.toFixed(2)}/día) el saldo se acaba cerca del ${fin}, antes del ${hasta}.`;
      return r;
    }
  }
  // Sin recarga anotada: avisa si al ritmo actual el saldo dura menos de DIAS_MINIMOS.
  if (gasto > 0 && !hasta && saldo / gasto < DIAS_MINIMOS) {
    const quedan = Math.max(0, Math.floor(saldo / gasto));
    r.estado = 'se_acaba';
    r.se_acaba = new Date(Date.parse(`${hoy}T12:00:00Z`) + quedan * DIA).toISOString().slice(0, 10);
    r.mensaje = saldo <= 0
      ? `Saldo agotado (US$ ${saldo.toFixed(2)}) y se gastan US$ ${gasto.toFixed(2)}/día. Hay que recargar.`
      : `A este ritmo (US$ ${gasto.toFixed(2)}/día) el saldo de US$ ${saldo.toFixed(2)} se acaba cerca del ${r.se_acaba}. No hay recarga anotada.`;
    return r;
  }
  if (r.ideal_dia !== null || hasta) {
    r.estado = 'en_ritmo';
    r.mensaje = r.ideal_dia !== null
      ? `En ritmo: US$ ${gasto.toFixed(2)}/día; para usar todo el crédito, US$ ${r.ideal_dia.toFixed(2)}/día.`
      : Number(s.por_llegar) > 0 ? `Llegan US$ ${Number(s.por_llegar).toFixed(2)} el ${s.proxima_recarga}.` : 'En ritmo.';
  }
  return r;
}

// Promedio diario de costo real por empresa:proveedor en los últimos n días completos (sin hoy).
export function gastoPorDia(costos, hoy, n = 7) {
  const desde = new Date(Date.parse(`${hoy}T12:00:00Z`) - n * DIA).toISOString().slice(0, 10);
  const suma = {};
  for (const c of costos) {
    if (c.dia < desde || c.dia >= hoy) continue;
    const k = `${c.empresa_id}:${c.proveedor}`;
    suma[k] = (suma[k] || 0) + Number(c.costo_usd || 0);
  }
  return Object.fromEntries(Object.entries(suma).map(([k, v]) => [k, v / n]));
}
