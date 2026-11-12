// Caché de reglas y de su consumo. Se recarga cada 5 s desde la base (función consumo_reglas());
// entre recargas, lo que pasa por el proxy se suma en memoria para que el corte sea inmediato.
// Si la base no responde, las reglas que ya estaban cargadas siguen valiendo; si nunca cargaron, todo pasa.
import { rest } from './db.mjs';
import { METRICAS_PLAN, coincide, evaluar, valorDeFila, valorPlan } from './reglas-logica.mjs';

let reglas = [];                 // reglas activas
let base = new Map();            // regla_id -> consumo según la base en la última recarga
// consumo = base + sinVolcar + volcados:
//  sinVolcar: filas registradas que aún no llegan a la base
//  volcados:  filas que llegaron a la base después de la última consulta (la base todavía no las incluye)
let sinVolcar = new Map();
let volcados = new Map();
const aportes = new WeakMap();   // fila -> [[regla_id, valor]] calculado al registrarla
let planes = new Map();          // id del plan (suscripciones_estado) -> { ventanas }
let cuentasPorOrg = new Map();   // org de Anthropic -> cuenta (correo)
export const cuentaDeOrg = (org) => cuentasPorOrg.get(org) || (org ? `org-${String(org).slice(0, 8)}` : null);
let listo = false;
let ultimoError = null;

const sumar = (mapa, id, v) => {
  const n = (mapa.get(id) || 0) + v;
  if (n > 1e-9) mapa.set(id, n); else mapa.delete(id);
};

export async function recargarReglas() {
  const volcadosAlEmpezar = new Map(volcados);
  try {
    const [rs, cs, ps, oc] = await Promise.all([
      rest('reglas?select=*&activa=eq.true&order=creada'),
      rest('rpc/consumo_reglas', { metodo: 'POST', cuerpo: {} }),
      rest('suscripciones_estado?select=id,ventanas'),
      rest('suscripcion_cuentas?select=org_id,cuenta'),
    ]);
    reglas = rs;
    for (const p of ps) planes.set(p.id, { ventanas: p.ventanas });
    cuentasPorOrg = new Map(oc.map((o) => [o.org_id, o.cuenta]));
    base = new Map(cs.map((c) => [c.regla_id, Number(c.consumo)]));
    // Lo volcado antes de la consulta ya está en base. Lo volcado durante la consulta puede quedar
    // contado dos veces hasta la próxima recarga (5 s): se prefiere eso a dejar pasar de más.
    for (const [id, v] of volcadosAlEmpezar) sumar(volcados, id, -v);
    listo = true;
    ultimoError = null;
  } catch (e) {
    ultimoError = e.message;
    console.error(`Recarga de reglas falló: ${e.message}`);
  }
}

const consumoDe = (r) => (METRICAS_PLAN.includes(r.metrica) ? valorPlan(r, planes.get(r.filtro_plan))
  : (base.get(r.id) || 0) + (sinVolcar.get(r.id) || 0) + (volcados.get(r.id) || 0));

// El proxy avisa apenas llega un dato nuevo del plan (cabeceras de Anthropic), para que el corte sea inmediato.
export function actualizarPlan(id, ventanas) { planes.set(id, { ventanas }); }
export const valorDeReglaPlan = (r) => valorPlan(r, planes.get(r.filtro_plan));
// Reinicio de la ventana del plan de una regla (para agrupar avisos por ciclo).
export const resetDePlan = (r) => (planes.get(r.filtro_plan)?.ventanas || []).find((v) => v.clave === r.plan_ventana)?.reset || null;

// ctx: { empresa_id, cliente_id, proveedor, modo, modelo }
export const decidir = (ctx, fecha = new Date()) => evaluar(reglas, consumoDe, ctx, fecha);

// Lo llama registro.mjs con cada fila de consumos.
export function sumarFila(fila) {
  const lista = [];
  for (const r of reglas) {
    if (METRICAS_PLAN.includes(r.metrica) || !coincide(r, fila)) continue;
    const v = valorDeFila(r, fila);
    if (v) { sumar(sinVolcar, r.id, v); lista.push([r.id, v]); }
  }
  if (lista.length) aportes.set(fila, lista);
}

// Lo llama registro.mjs cuando un lote quedó guardado en la base.
export function confirmarVolcado(lote) {
  for (const fila of lote) {
    for (const [id, v] of aportes.get(fila) || []) { sumar(sinVolcar, id, -v); sumar(volcados, id, v); }
  }
}

export const estadoReglas = () => ({ listo, ultimoError, reglas: reglas.length });

// Para los avisos push: cada regla activa con su consumo actual.
export const reglasConConsumo = () => reglas.map((r) => ({ ...r, consumo: consumoDe(r) }));

export function iniciarRecargaReglas(cadaMs = 5000) {
  return setInterval(recargarReglas, cadaMs).unref();
}
