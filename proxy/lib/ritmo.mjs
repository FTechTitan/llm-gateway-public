// Ritmo de créditos con datos reales: saldo por empresa y proveedor + gasto real de los últimos 7 días.
import { rest } from './db.mjs';
import { ritmo, gastoPorDia } from './ritmo-logica.mjs';

const diaChile = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date(Date.now() + offset * 864e5));

// filtro: sufijo de consulta PostgREST para limitar empresas (vacío = todas)
export async function saldosConRitmo(filtro = '') {
  const hoy = diaChile();
  const [saldos, costos] = await Promise.all([
    rest(`v_saldo_proveedor?select=*${filtro}&order=empresa_id,proveedor`),
    rest(`costos_proveedor?select=empresa_id,proveedor,dia,costo_usd&dia=gte.${diaChile(-8)}${filtro}`),
  ]);
  const porDia = gastoPorDia(costos, hoy);
  return saldos.map((s) => ({ ...s, ritmo: ritmo(s, porDia[`${s.empresa_id}:${s.proveedor}`] || 0, hoy) }));
}
