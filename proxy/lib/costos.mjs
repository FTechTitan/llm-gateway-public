// Costo real según cada proveedor, leído con las admin keys de cada empresa.
// OpenAI: GET /v1/organization/costs · Anthropic: GET /v1/organizations/cost_report
import { config } from './config.mjs';
import { rest } from './db.mjs';
import { credencial } from './estado.mjs';

const DIAS = 31;
// Desde cuándo leer: por defecto los últimos 31 días; para cargar historial se pasa una fecha (AAAA-MM-DD).
export const desdeDe = (desde) => (desde ? new Date(`${desde}T00:00:00Z`) : new Date(Date.now() - DIAS * 864e5));

// Recorre todas las páginas (has_more + next_page) de un informe de costos o uso.
async function paginas(url, headers, nombre) {
  const datos = []; let sig = null; let vueltas = 0;
  do {
    const r = await fetch(sig ? `${url}&page=${encodeURIComponent(sig)}` : url, { headers, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${nombre} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    datos.push(...(d.data || []));
    sig = d.has_more ? d.next_page : null;
  } while (sig && ++vueltas < 40);
  return datos;
}

async function costosOpenAI(llave, desde) {
  const inicio = Math.floor(desdeDe(desde).getTime() / 1000);
  const data = await paginas(`${config.proveedores.openai}/v1/organization/costs?start_time=${inicio}&bucket_width=1d&limit=31`,
    { Authorization: `Bearer ${llave}` }, 'OpenAI costs');
  return data.map((b) => ({
    dia: new Date(b.start_time * 1000).toISOString().slice(0, 10),
    costo: (b.results || []).reduce((s, x) => s + Number(x.amount?.value || 0), 0),
  }));
}

async function costosAnthropic(llave, desde) {
  const inicio = desdeDe(desde).toISOString().slice(0, 10) + 'T00:00:00Z';
  const data = await paginas(`${config.proveedores.anthropic}/v1/organizations/cost_report?starting_at=${inicio}&bucket_width=1d&limit=31`,
    { 'x-api-key': llave, 'anthropic-version': '2023-06-01' }, 'Anthropic cost_report');
  // Anthropic informa el monto en la unidad mínima (centavos de USD).
  return data.map((b) => ({
    dia: String(b.starting_at).slice(0, 10),
    costo: (b.results || []).reduce((s, x) => s + Number(x.amount || 0), 0) / 100,
  }));
}

export async function sincronizarCostos(desde = null) {
  const empresas = await rest('empresas?select=id');
  const resultado = [];
  for (const { id } of empresas) {
    for (const [proveedor, leer] of [['openai', costosOpenAI], ['anthropic', costosAnthropic]]) {
      const llave = credencial(id, proveedor, 'admin');
      if (!llave) { resultado.push({ empresa: id, proveedor, estado: 'sin admin key' }); continue; }
      try {
        const filas = (await leer(llave, desde)).map((f) => ({ empresa_id: id, proveedor, dia: f.dia, costo_usd: Number(f.costo.toFixed(6)), leido: new Date().toISOString() }));
        for (let i = 0; i < filas.length; i += 200) {
          await rest('costos_proveedor?on_conflict=empresa_id,proveedor,dia', { metodo: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', cuerpo: filas.slice(i, i + 200) });
        }
        resultado.push({ empresa: id, proveedor, estado: 'ok', dias: filas.length });
      } catch (e) {
        console.error(`Costos ${id}/${proveedor}: ${e.message}`);
        resultado.push({ empresa: id, proveedor, estado: 'error', detalle: e.message.slice(0, 200) });
      }
    }
  }
  return resultado;
}

// Sincronización periódica: costo real y consumo por llave, cada 6 horas (y 1 minuto después de arrancar).
export async function sincronizarTodo(desde = null) {
  const { sincronizarUsoPorLlave } = await import('./uso-proveedor.mjs');
  const costos = await sincronizarCostos(desde);
  const porLlave = await sincronizarUsoPorLlave(desde);
  return { costos, por_llave: porLlave };
}

export function iniciarSincronizacion(cadaMs = 6 * 3600 * 1000) {
  const correr = () => sincronizarTodo()
    .then((r) => console.log(`Sincronización con proveedores: ${r.por_llave.filter((x) => x.estado === 'ok').length} ok`))
    .catch((e) => console.error(`Sincronización con proveedores falló: ${e.message}`));
  setTimeout(correr, 60000).unref();
  return setInterval(correr, cadaMs).unref();
}
