// Avisos automáticos por notificación push. Revisa cada 2 minutos y no repite un aviso
// (cada aviso tiene una clave única guardada en avisos_enviados).
import { rest, enc } from './db.mjs';
import { notificar, pushDisponible } from './push.mjs';
import { reglasConConsumo, resetDePlan } from './reglas.mjs';
import { enHorario } from './reglas-logica.mjs';
import { saldosConRitmo } from './ritmo.mjs';

const usd = (v) => `US$ ${Number(v || 0).toFixed(2)}`;
const mesChile = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit' }).format(new Date());
const diaChile = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
const fecha = (iso) => new Date(iso).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' });

// true si la clave es nueva (y queda registrada); false si ese aviso ya se mandó.
async function primeraVez(clave) {
  const filas = await rest('avisos_enviados?on_conflict=clave', {
    metodo: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', cuerpo: { clave },
  });
  return Array.isArray(filas) && filas.length > 0;
}

async function avisar(clave, aviso) {
  if (!(await primeraVez(clave))) return;
  const r = await notificar(aviso);
  console.log(`Aviso «${aviso.titulo}» → ${r.enviados} dispositivo(s)`);
}

async function presupuestos() {
  const mes = mesChile();
  const clientes = await rest('v_consumo_mes_cliente?select=cliente_id,empresa_id,nombre,presupuesto_usd_mensual,gastado_mes&presupuesto_usd_mensual=gt.0');
  for (const c of clientes) {
    const pct = Number(c.gastado_mes) / Number(c.presupuesto_usd_mensual);
    if (pct >= 1) {
      await avisar(`presupuesto100:${c.cliente_id}:${mes}`, {
        empresa: c.empresa_id, urgente: true, titulo: `${c.nombre}: cuota agotada`,
        cuerpo: `Gastó ${usd(c.gastado_mes)} de ${usd(c.presupuesto_usd_mensual)}. Sus llamadas están cortadas hasta el día 1 o hasta subir el presupuesto.`,
      });
    } else if (pct >= 0.8) {
      await avisar(`presupuesto80:${c.cliente_id}:${mes}`, {
        empresa: c.empresa_id, titulo: `${c.nombre}: ${Math.round(pct * 100)} % de la cuota`,
        cuerpo: `Lleva ${usd(c.gastado_mes)} de ${usd(c.presupuesto_usd_mensual)} este mes.`,
      });
    }
  }
}

// Ventana de la regla, para avisar una sola vez por ventana.
function tramo(r) {
  if (r.ventana_tipo === 'plan') return `plan-${resetDePlan(r) || diaChile()}`;
  if (r.ventana_tipo === 'calendario') return r.ventana_periodo === 'mes' ? mesChile() : diaChile();
  return String(Math.floor(Date.now() / (r.ventana_minutos * 60000)));
}

async function reglas() {
  const ahora = new Date();
  for (const r of reglasConConsumo()) {
    if (!enHorario(r, ahora)) continue;
    const umbralAviso = r.limite_aviso === null || r.limite_aviso === undefined ? null : Number(r.limite_aviso);
    if (umbralAviso !== null && r.consumo >= umbralAviso && r.consumo < Number(r.limite)) {
      await avisar(`regla-aviso:${r.id}:${tramo(r)}`, {
        empresa: r.empresa_id, urgente: false, titulo: `Regla «${r.nombre}»: umbral de aviso`,
        cuerpo: `Consumo ${Number(r.consumo).toLocaleString('es-CL', { maximumFractionDigits: 1 })}; aviso en ${umbralAviso.toLocaleString('es-CL')}, ${r.accion === 'cortar' ? 'corta' : 'límite'} en ${Number(r.limite).toLocaleString('es-CL')} (${r.metrica}).`,
      });
      continue;
    }
    if (!(Number(r.limite) > 0 || r.ventana_tipo === 'plan') || r.consumo < Number(r.limite)) continue;
    const corta = r.accion === 'cortar';
    await avisar(`regla:${r.id}:${tramo(r)}`, {
      empresa: r.empresa_id, urgente: corta,
      titulo: `Regla «${r.nombre}» ${corta ? 'cortando llamadas' : 'superada'}`,
      cuerpo: `Consumo ${Number(r.consumo).toLocaleString('es-CL', { maximumFractionDigits: 2 })} de un límite de ${Number(r.limite).toLocaleString('es-CL')} (${r.metrica}).`,
    });
  }
}

async function vencimientos() {
  const limite = new Date(Date.now() + 7 * 864e5).toISOString();
  const [ks, as, cs] = await Promise.all([
    rest(`llaves?select=id,prefijo,expira,empresa_id,clientes(nombre)&activa=eq.true&expira=lte.${enc(limite)}`),
    rest(`llaves_admin?select=id,prefijo,expira,empresa_id&activa=eq.true&expira=lte.${enc(limite)}`),
    rest(`credenciales_proveedor?select=id,proveedor,tipo,huella,expira,empresa_id&activa=eq.true&expira=lte.${enc(limite)}`),
  ]);
  const items = [
    ...ks.map((k) => ({ id: k.id, empresa: k.empresa_id, que: `Llave de ${k.clientes?.nombre || 'cliente'} (${k.prefijo}…)`, expira: k.expira })),
    ...as.map((a) => ({ id: a.id, empresa: a.empresa_id, que: `Llave de administración ${a.prefijo}…`, expira: a.expira })),
    ...cs.map((c) => ({ id: c.id, empresa: c.empresa_id, que: `Llave ${c.tipo === 'admin' ? 'admin' : 'normal'} de ${c.proveedor} de ${c.empresa_id} (…${c.huella})`, expira: c.expira })),
  ];
  for (const it of items) {
    const vencio = Date.parse(it.expira) <= Date.now();
    await avisar(`${vencio ? 'vencida' : 'vence7'}:${it.id}`, {
      empresa: it.empresa, urgente: vencio,
      titulo: vencio ? 'Llave vencida' : 'Llave por vencer',
      cuerpo: `${it.que} ${vencio ? 'venció' : 'vence'} el ${fecha(it.expira)}.`,
    });
  }
}

// Créditos que van a vencer sin usar (aviso a 14, 7, 3 y 1 días) o que se acaban antes de la próxima recarga (1 por semana).
async function creditos() {
  const semana = Math.floor(Date.now() / (7 * 864e5));
  for (const s of await saldosConRitmo()) {
    const r = s.ritmo;
    if (r.estado === 'se_pierde') {
      const hito = [1, 3, 7, 14].find((d) => r.dias_para_vencer <= d);
      if (!hito) continue;
      await avisar(`credito-vence:${s.empresa_id}:${s.proveedor}:${s.proximo_vencimiento}:${hito}`, {
        empresa: s.empresa_id, urgente: hito <= 3,
        titulo: `${s.empresa_id} · ${s.proveedor}: crédito por vencer sin usar`, cuerpo: r.mensaje,
      });
    } else if (r.estado === 'se_acaba') {
      await avisar(`credito-acaba:${s.empresa_id}:${s.proveedor}:${semana}`, {
        empresa: s.empresa_id, urgente: true,
        titulo: `${s.empresa_id} · ${s.proveedor}: el crédito no alcanza`, cuerpo: r.mensaje,
      });
    }
  }
}

let corriendo = false;
export async function revisarAvisos() {
  if (corriendo || !pushDisponible()) return;
  corriendo = true;
  try {
    for (const paso of [presupuestos, reglas, vencimientos, creditos]) {
      await paso().catch((e) => console.error(`Avisos (${paso.name}): ${e.message}`));
    }
  } finally {
    corriendo = false;
  }
}

export function iniciarAvisos(cadaMs = 120000) {
  setTimeout(revisarAvisos, 20000).unref();
  return setInterval(revisarAvisos, cadaMs).unref();
}
