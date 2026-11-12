// Cola de consumos: se vuelca a la base por lotes para no demorar cada llamada.
import { rest } from './db.mjs';
import { descontarPendiente, sumarPendiente } from './estado.mjs';
import { confirmarVolcado, sumarFila } from './reglas.mjs';

const cola = [];
const MAX_COLA = 20000;
let volcando = false;

export function registrar(fila) {
  if (cola.length >= MAX_COLA) {
    console.error('Cola de consumos llena: se descarta el registro más antiguo');
    cola.shift();
  }
  cola.push(fila);
  sumarPendiente(fila.cliente_id, fila.costo_usd);
  sumarFila(fila);
  if (cola.length >= 200) volcar();
}

export async function volcar() {
  if (volcando || cola.length === 0) return;
  volcando = true;
  const lote = cola.splice(0, 500);
  try {
    await rest('consumos', { metodo: 'POST', cuerpo: lote, prefer: 'return=minimal' });
    for (const f of lote) descontarPendiente(f.cliente_id, f.costo_usd);
    confirmarVolcado(lote);
    const usadas = [...new Set(lote.map((f) => f.llave_id).filter(Boolean))];
    if (usadas.length) {
      await rest(`llaves?id=in.(${usadas.join(',')})`, { metodo: 'PATCH', cuerpo: { ultimo_uso: new Date().toISOString() }, prefer: 'return=minimal' })
        .catch((e) => console.error(`No se actualizó ultimo_uso: ${e.message}`));
    }
  } catch (e) {
    console.error(`Volcado de ${lote.length} consumos falló, se reintenta: ${e.message}`);
    cola.unshift(...lote);
  } finally {
    volcando = false;
  }
}

export const tamanoCola = () => cola.length;

export function iniciarVolcado(cadaMs = 2000) {
  return setInterval(volcar, cadaMs).unref();
}
