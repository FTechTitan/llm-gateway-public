// Caché en memoria: llaves, credenciales, precios y gasto del mes.
// Se recarga cada 30 s, así el proxy no consulta la base en cada llamada.
import { rest } from './db.mjs';
import { descifrar } from './cripto.mjs';
import { leerCredencialBedrock } from './bedrock.mjs';

let llaves = new Map();        // hash -> { llave_id, cliente_id, empresa_id, cliente, presupuesto, activa }
let llavesAdmin = new Map();   // hash -> { id, empresa_id }
let credenciales = new Map();  // `${empresa}:${proveedor}:${tipo}` -> valor descifrado
let modelosBedrock = new Map(); // `${empresa|*}|${modelo}` -> bedrock_id
let precios = [];              // ordenados por largo de prefijo, descendente
let gastoBase = new Map();     // cliente_id -> gasto del mes según la base
const gastoPendiente = new Map(); // cliente_id -> gasto aún no volcado a la base
let listo = false;
let ultimoError = null;

// Configuración de Langfuse del cliente, con la llave secreta descifrada (solo en memoria).
function langfuseDe(c) {
  const l = c.langfuse;
  if (!l?.activo || !l.host || !l.public_key || !l.secret_cifrado) return null;
  try { return { host: l.host, public_key: l.public_key, secret_key: descifrar(l.secret_cifrado) }; }
  catch (e) { console.error(`Langfuse de ${c.nombre}: no se pudo descifrar (${e.message})`); return null; }
}

export async function recargar() {
  try {
    const [ks, cs, ads, cr, ps, gs, es, bm] = await Promise.all([
      rest('llaves?select=id,hash,cliente_id,empresa_id,activa,expira'),
      rest('clientes?select=id,nombre,activo,presupuesto_usd_mensual,langfuse,ruta_anthropic,ruta_openai,metadata'),
      rest('llaves_admin?select=id,hash,empresa_id,expira&activa=eq.true'),
      rest('credenciales_proveedor?select=empresa_id,proveedor,tipo,valor_cifrado,expira&activa=eq.true'),
      rest('precios?select=*'),
      rest('v_consumo_mes_cliente?select=cliente_id,gastado_mes'),
      rest('empresas?select=id,ruta_anthropic,ruta_openai'),
      rest('bedrock_modelos?select=empresa_id,modelo,bedrock_id'),
    ]);
    const rutaEmpresa = new Map(es.map((e) => [e.id, e.ruta_anthropic || 'directo']));
    const rutaOpenaiEmpresa = new Map(es.map((e) => [e.id, e.ruta_openai || 'directo']));
    modelosBedrock = new Map(bm.map((m) => [`${m.empresa_id || '*'}|${m.modelo}`, m.bedrock_id]));
    const clientes = new Map(cs.map((c) => [c.id, c]));
    llaves = new Map(ks.map((k) => {
      const c = clientes.get(k.cliente_id) || {};
      return [k.hash, {
        llave_id: k.id, cliente_id: k.cliente_id, empresa_id: k.empresa_id, cliente: c.nombre,
        presupuesto: Number(c.presupuesto_usd_mensual || 0), activa: k.activa && c.activo !== false,
        expira: k.expira ? Date.parse(k.expira) : null,
        langfuse: langfuseDe(c),
        ruta_anthropic: c.ruta_anthropic || rutaEmpresa.get(k.empresa_id) || 'directo',
        cuenta_suscripcion: c.metadata?.cuenta_suscripcion || c.nombre || null,
        ruta_openai: c.ruta_openai || rutaOpenaiEmpresa.get(k.empresa_id) || 'directo',
        respaldo_filtro: c.metadata?.respaldo_filtro ?? null,
      }];
    }));
    llavesAdmin = new Map(ads.map((a) => [a.hash, { id: a.id, empresa_id: a.empresa_id, expira: a.expira ? Date.parse(a.expira) : null }]));
    const nuevas = new Map();
    for (const c of cr) {
      if (c.expira && Date.parse(c.expira) <= Date.now()) {
        console.warn(`La llave de ${c.proveedor} (${c.tipo}) de ${c.empresa_id} está vencida según su fecha anotada; se sigue usando hasta que se reemplace.`);
      }
      try {
        const valor = descifrar(c.valor_cifrado);
        nuevas.set(`${c.empresa_id}:${c.proveedor}:${c.tipo}`, c.proveedor === 'bedrock' ? leerCredencialBedrock(valor) : valor);
      }
      catch (e) { console.error(`No se pudo descifrar la credencial ${c.empresa_id}/${c.proveedor}/${c.tipo}: ${e.message}`); }
    }
    credenciales = nuevas;
    precios = ps.map((p) => ({ ...p, n: p.modelo.length })).sort((a, b) => b.n - a.n);
    gastoBase = new Map(gs.map((g) => [g.cliente_id, Number(g.gastado_mes)]));
    listo = true;
    ultimoError = null;
  } catch (e) {
    ultimoError = e.message;
    console.error(`Recarga de caché falló: ${e.message}`);
  }
}

export const vencida = (info) => Boolean(info?.expira && info.expira <= Date.now());
export const buscarLlave = (hash) => llaves.get(hash);
// Una llave de administración vencida simplemente deja de existir para la API.
export const buscarLlaveAdmin = (hash) => {
  const a = llavesAdmin.get(hash);
  return a && !vencida(a) ? a : undefined;
};
export const credencial = (empresa, proveedor, tipo = 'api') => credenciales.get(`${empresa}:${proveedor}:${tipo}`);
export const estadoCache = () => ({ listo, ultimoError, llaves: llaves.size, credenciales: credenciales.size });
export const mapaModelosBedrock = () => modelosBedrock;

export function gastoMes(clienteId) {
  return (gastoBase.get(clienteId) || 0) + (gastoPendiente.get(clienteId) || 0);
}
export function sumarPendiente(clienteId, usd) {
  gastoPendiente.set(clienteId, (gastoPendiente.get(clienteId) || 0) + usd);
}
export function descontarPendiente(clienteId, usd) {
  const v = (gastoPendiente.get(clienteId) || 0) - usd;
  if (v <= 1e-9) gastoPendiente.delete(clienteId); else gastoPendiente.set(clienteId, v);
  // Lo volcado ya está en la base; se refleja en gastoBase en la próxima recarga.
  gastoBase.set(clienteId, (gastoBase.get(clienteId) || 0) + usd);
}

// origen: proveedor del formato del pedido (anthropic u openai). Solo se usa cuando proveedor = 'bedrock'.
export function precioDe(proveedor, modelo, origen = 'anthropic') {
  if (!modelo) return null;
  const m = modelo.toLowerCase();
  const p = precios.find((x) => x.proveedor === proveedor && m.startsWith(x.modelo.toLowerCase())) || null;
  if (p || proveedor !== 'bedrock') return p;
  // Bedrock sin precio propio cargado: usa el del proveedor de origen para el mismo modelo
  // (sin el prefijo de Bedrock: us.openai.gpt-6-luna -> gpt-6-luna).
  const sinPrefijo = m.replace(/^([a-z-]+\.)?(anthropic|openai)\./, '');
  return precioDe(origen === 'bedrock' ? 'anthropic' : origen, sinPrefijo);
}

export function iniciarRecarga(cadaMs = 30000) {
  return setInterval(recargar, cadaMs).unref();
}
