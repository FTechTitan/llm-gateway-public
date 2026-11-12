// Lógica pura de las reglas de uso (sin base ni red): validación, horario, filtros y decisión.
// El consumo de cada regla lo calcula la función SQL consumo_reglas(); aquí solo se compara.

export const METRICAS = ['tokens', 'tokens_out', 'costo_usd', 'llamadas', 'pct_plan', 'ritmo_plan'];
// Métricas sobre el plan de una suscripción (% usado o puntos por sobre el ritmo del tiempo).
export const METRICAS_PLAN = ['pct_plan', 'ritmo_plan'];
const VENTANAS_PLAN = ['5h', '7d'];
const PERIODOS = ['dia', 'semana', 'mes'];
const PROVEEDORES = ['openai', 'anthropic'];
const MODOS = ['api', 'suscripcion'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HORA = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const ZONA = 'America/Santiago';
const DIAS_EN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const fallar = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
const vacio = (v) => v === undefined || v === null || v === '';

function textoOpcional(v, campo, max = 80) {
  if (vacio(v)) return null;
  if (typeof v !== 'string' || v.trim().length > max) fallar(`${campo} debe ser texto de hasta ${max} caracteres.`);
  return v.trim();
}

function enLista(v, lista, campo) {
  if (vacio(v)) return null;
  if (!lista.includes(v)) fallar(`${campo} debe ser ${lista.join(', ')}.`);
  return v;
}

// Recibe la regla en el formato de la API y devuelve las columnas de la tabla reglas (sin empresa_id).
export function validarRegla(b) {
  if (!b || typeof b !== 'object') fallar('Regla vacía.');
  const nombre = textoOpcional(b.nombre, 'nombre', 120);
  if (!nombre) fallar('Falta nombre.');
  if (!METRICAS.includes(b.metrica)) fallar(`metrica debe ser ${METRICAS.join(', ')}.`);
  const limite = Number(b.limite);
  if (vacio(b.limite) || !Number.isFinite(limite) || limite < 0) fallar('limite debe ser un número mayor o igual a 0.');
  if (!['avisar', 'cortar'].includes(b.accion)) fallar('accion debe ser avisar o cortar.');
  const limite_aviso = vacio(b.limite_aviso) ? null : Number(b.limite_aviso);
  if (limite_aviso !== null && (!Number.isFinite(limite_aviso) || limite_aviso < 0 || limite_aviso > limite)) fallar('limite_aviso debe estar entre 0 y el límite.');

  let ventana_minutos = null, ventana_periodo = null, filtro_plan = null, plan_ventana = null;
  const esPlan = METRICAS_PLAN.includes(b.metrica);
  if (esPlan) {
    if (limite > 100) fallar('Para métricas del plan el límite va de 0 a 100 (porcentaje o puntos).');
    if (typeof b.filtro_plan !== 'string' || !/^[a-z]+:.{1,120}$/u.test(b.filtro_plan)) fallar('Falta filtro_plan (id del plan, ej. claude:correo@dominio).');
    filtro_plan = b.filtro_plan;
    plan_ventana = enLista(b.plan_ventana, VENTANAS_PLAN, 'plan_ventana');
    if (!plan_ventana) fallar('Falta plan_ventana (5h o 7d).');
  } else if (b.ventana_tipo === 'movil') {
    ventana_minutos = Number(b.ventana_minutos);
    if (!Number.isInteger(ventana_minutos) || ventana_minutos < 1 || ventana_minutos > 525600) fallar('ventana_minutos debe ser un entero entre 1 y 525600.');
  } else if (b.ventana_tipo === 'calendario') {
    ventana_periodo = enLista(b.ventana_periodo, PERIODOS, 'ventana_periodo');
    if (!ventana_periodo) fallar('Falta ventana_periodo.');
  } else fallar('ventana_tipo debe ser movil o calendario.');

  if (!vacio(b.filtro_cliente_id) && !UUID.test(b.filtro_cliente_id)) fallar('filtro_cliente_id debe ser un id de cliente.');
  // En SQL el filtro va en un ILIKE: %, _ y \ cambiarían el resultado respecto del proxy.
  if (typeof b.filtro_modelo === 'string' && /[%_\\]/.test(b.filtro_modelo)) fallar('filtro_modelo no puede contener %, _ ni \\.');

  let horario_dias = null, horario_desde = null, horario_hasta = null;
  if (Array.isArray(b.horario_dias) && b.horario_dias.length) {
    horario_dias = [...new Set(b.horario_dias.map(Number))].sort((x, y) => x - y);
    if (horario_dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) fallar('horario_dias: números de 0 (domingo) a 6 (sábado).');
    if (!HORA.test(b.horario_desde || '') || !HORA.test(b.horario_hasta || '')) fallar('horario_desde y horario_hasta en formato HH:MM.');
    horario_desde = b.horario_desde.slice(0, 5);
    horario_hasta = b.horario_hasta.slice(0, 5);
  }

  return {
    nombre, activa: b.activa !== false, metrica: b.metrica, limite, accion: b.accion, limite_aviso,
    ventana_tipo: esPlan ? 'plan' : b.ventana_tipo, ventana_minutos, ventana_periodo, filtro_plan, plan_ventana,
    filtro_cliente_id: vacio(b.filtro_cliente_id) ? null : b.filtro_cliente_id,
    filtro_proveedor: enLista(b.filtro_proveedor, PROVEEDORES, 'filtro_proveedor'),
    filtro_modo: enLista(b.filtro_modo, MODOS, 'filtro_modo'),
    filtro_modelo: textoOpcional(b.filtro_modelo, 'filtro_modelo'),
    horario_dias, horario_desde, horario_hasta,
  };
}

// Día de la semana (0 = domingo) y minuto del día en hora de Chile.
export function momentoChile(fecha) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(fecha).map((p) => [p.type, p.value]));
  return { dia: DIAS_EN[partes.weekday], minuto: (Number(partes.hour) % 24) * 60 + Number(partes.minute) };
}

const aMinutos = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function enHorario(regla, fecha) {
  if (!regla.horario_dias?.length) return true;
  const { dia, minuto } = momentoChile(fecha);
  const desde = aMinutos(regla.horario_desde), hasta = aMinutos(regla.horario_hasta);
  if (desde <= hasta) return regla.horario_dias.includes(dia) && minuto >= desde && minuto < hasta;
  // Cruza medianoche (23:00–07:00): la madrugada pertenece al día en que empezó la franja.
  if (minuto >= desde) return regla.horario_dias.includes(dia);
  if (minuto < hasta) return regla.horario_dias.includes((dia + 6) % 7);
  return false;
}

// ctx o fila: { empresa_id, cliente_id, proveedor, modo, modelo }
export function coincide(regla, ctx) {
  if (regla.empresa_id !== ctx.empresa_id) return false;
  if (regla.filtro_cliente_id && regla.filtro_cliente_id !== ctx.cliente_id) return false;
  if (regla.filtro_plan && regla.filtro_plan !== ctx.plan) return false;   // regla del plan: solo llamadas de esa cuenta
  if (regla.filtro_proveedor && regla.filtro_proveedor !== ctx.proveedor) return false;
  if (regla.filtro_modo && regla.filtro_modo !== ctx.modo) return false;
  if (regla.filtro_modelo && !(ctx.modelo || '').toLowerCase().includes(regla.filtro_modelo.toLowerCase())) return false;
  return true;
}

// Cuánto suma una fila de consumos a la métrica de una regla (igual que consumo_reglas() en SQL).
export function valorDeFila(regla, f) {
  if (f.bloqueado) return 0;
  const tin = f.tokens_in || 0, tout = f.tokens_out || 0, cw = f.tokens_cache_write || 0, cr = f.tokens_cache_read || 0;
  switch (regla.metrica) {
    case 'llamadas': return tin + tout + cw + cr > 0 ? 1 : 0;
    case 'tokens_out': return tout;
    case 'costo_usd': return (f.costo_usd || 0) + (f.costo_equivalente_usd || 0);
    default: return tin + tout + cw;
  }
}

const formato = (n) => Number(n).toLocaleString('es-CL', { maximumFractionDigits: 2 });

// Valor de una regla del plan a partir del estado de la suscripción ({ ventanas: [{clave, usado, reset, ventana_min}] }).
// Si la ventana ya se reinició (o no hay dato) vale 0: el plan arranca de nuevo.
export function valorPlan(regla, plan, ahoraMs = Date.now()) {
  const v = (plan?.ventanas || []).find((x) => x.clave === regla.plan_ventana);
  if (!v || !v.reset || v.reset * 1000 <= ahoraMs) return 0;
  const usado = Math.max(0, Math.min(1, Number(v.usado) || 0)) * 100;
  if (regla.metrica === 'pct_plan') return usado;
  const largo = (Number(v.ventana_min) || (regla.plan_ventana === '5h' ? 300 : 10080)) * 60e3;
  const transcurrido = Math.max(0, Math.min(1, 1 - (v.reset * 1000 - ahoraMs) / largo)) * 100;
  return usado - transcurrido;
}
const UNIDAD = { pct_plan: '% del plan', ritmo_plan: 'puntos sobre el ritmo' };

// consumoDe(regla) -> número. Devuelve { permitido, motivo, avisos }.
export function evaluar(reglas, consumoDe, ctx, fecha) {
  const avisos = [];
  for (const r of reglas) {
    if (!r.activa || !coincide(r, ctx) || !enHorario(r, fecha)) continue;
    const limite = Number(r.limite);
    const c = consumoDe(r);
    if (c < limite) {
      const aviso = r.limite_aviso === null || r.limite_aviso === undefined ? null : Number(r.limite_aviso);
      if (aviso !== null && c >= aviso) avisos.push(`«${r.nombre}»: ${formato(c)}, sobre el umbral de aviso ${formato(aviso)} (${UNIDAD[r.metrica] || r.metrica})`);
      continue;
    }
    const msg = limite === 0 && !METRICAS_PLAN.includes(r.metrica) ? `«${r.nombre}» (franja bloqueada)`
      : `«${r.nombre}»: ${formato(c)} de ${formato(limite)} (${UNIDAD[r.metrica] || r.metrica})`;
    if (r.accion === 'cortar') return { permitido: false, motivo: msg, avisos };
    avisos.push(msg);
  }
  return { permitido: true, avisos };
}
