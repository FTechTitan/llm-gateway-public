// API de administración: /admin/*
// Autenticación: Bearer GATEWAY_MASTER_KEY (superadmin) o una llave tfa_ (superadmin o admin de una empresa).
import { saldosConRitmo } from './ritmo.mjs';
import { config } from './config.mjs';
import { authAdmin, enc, rest } from './db.mjs';
import { huellaBedrock, leerCredencialBedrock } from './bedrock.mjs';
import { cifrar, igualSeguro, nuevaLlave, sha256 } from './cripto.mjs';
import { buscarLlaveAdmin, recargar } from './estado.mjs';
import { leerJson, responderError, responderJson } from './http.mjs';
import { enviarReporte } from './reporte.mjs';
import { sincronizarTodo } from './costos.mjs';
import { recargarReglas, valorDeReglaPlan } from './reglas.mjs';
import { enHorario, validarRegla } from './reglas-logica.mjs';
import { descripcionValida, expiraValida } from './vencimientos.mjs';
import { notificar, pushDisponible } from './push.mjs';

const PROVEEDORES = ['openai', 'anthropic'];
const RUTAS = ['directo', 'bedrock'];
const rutaValida = (v, permitirNull, campo = 'ruta_anthropic') => {
  if (v === null && permitirNull) return null;
  if (!RUTAS.includes(v)) throw error(400, `${campo} debe ser ${RUTAS.join(' o ')}${permitirNull ? ' o null (hereda de la empresa)' : ''}.`);
  return v;
};
// Rutas que trae un cuerpo de PATCH (ruta_anthropic y/o ruta_openai).
function rutasDe(b, permitirNull) {
  const r = {};
  for (const campo of ['ruta_anthropic', 'ruta_openai']) if (campo in b) r[campo] = rutaValida(b[campo], permitirNull, campo);
  return r;
}
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

async function quien(req) {
  const auth = req.headers.authorization || '';
  const t = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!t) return null;
  if (igualSeguro(t, config.llaveMaestra)) return { superadmin: true, empresa: null };
  const a = buscarLlaveAdmin(sha256(t));
  if (a) return { superadmin: a.empresa_id === null, empresa: a.empresa_id, empresas: a.empresa_id ? [a.empresa_id] : [] };
  return usuarioPanel(t);
}

// Sesión del panel (JWT de GoTrue): mismo rol que su perfil. Se cachea 60 s.
// Los rechazos también se cachean (60 s) y hay un tope de validaciones simultáneas,
// para que tokens basura no carguen GoTrue ni la base.
const sesionesPanel = new Map();
const MAX_VALIDANDO = 5;
let validando = 0;
async function usuarioPanel(token) {
  if (token.split('.').length !== 3) return null;
  const h = sha256(token);
  const c = sesionesPanel.get(h);
  if (c && c.vence > Date.now()) return c.q;
  if (validando >= MAX_VALIDANDO) return null;
  if (sesionesPanel.size > 500) sesionesPanel.clear();
  validando++;
  try {
    const r = await fetch(`${config.authUrl}/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: config.anonKey }, signal: AbortSignal.timeout(5000),
    });
    let q = null;
    if (r.ok) {
      const u = await r.json();
      const [p] = await rest(`perfiles?user_id=eq.${enc(u.id)}&select=empresa_id,empresas_extra`);
      if (p) {
        const empresas = [...new Set([p.empresa_id, ...(p.empresas_extra || [])].filter(Boolean))];
        q = { superadmin: p.empresa_id === null, empresa: p.empresa_id, empresas, usuario: u.email, userId: u.id };
      }
    }
    sesionesPanel.set(h, { q, vence: Date.now() + 60000 });
    return q;
  } catch (e) {
    console.error(`No se pudo validar la sesión del panel: ${e.message}`);
    return null;
  } finally {
    validando--;
  }
}

async function reglaDe(q, id) {
  const [r] = await rest(`reglas?id=eq.${enc(id)}&select=*`);
  if (!r) throw error(404, 'Regla no encontrada.');
  empresaPermitida(q, r.empresa_id);
  return r;
}

async function validarClienteDeRegla(q, empresa, clienteId) {
  if (!clienteId) return;
  const c = await clienteDe(q, clienteId);
  if (c.empresa_id !== empresa) throw error(400, 'El cliente del filtro no pertenece a la empresa de la regla.');
}

const error = (status, mensaje) => Object.assign(new Error(mensaje), { status });
const soloSuper = (q) => { if (!q.superadmin) throw error(403, 'Solo el superadmin puede hacer esto.'); };
function empresaPermitida(q, empresa) {
  if (!empresa) throw error(400, 'Falta empresa_id.');
  if (!q.superadmin && !(q.empresas || [q.empresa]).includes(empresa)) throw error(403, `No tienes acceso a la empresa ${empresa}.`);
  return empresa;
}
// Filtro PostgREST por empresa: la pedida, o todas las del usuario (multiempresa), o sin restricción si es superadmin.
function filtroEmp(q, empresa, campo = 'empresa_id') {
  if (empresa) return `&${campo}=eq.${enc(empresa)}`;
  if (q.superadmin) return '';
  return `&${campo}=in.(${(q.empresas || [q.empresa]).map(enc).join(',')})`;
}
const presupuestoValido = (v) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0) throw error(400, 'presupuesto_usd_mensual debe ser un número mayor o igual a 0.');
  return n;
};

async function crearLlaveCliente(cliente, b) {
  const expira = expiraValida(b.expira);
  const descripcion = descripcionValida(b.descripcion);
  const k = nuevaLlave('tfk');
  const [fila] = await rest('llaves', {
    metodo: 'POST', prefer: 'return=representation',
    cuerpo: { cliente_id: cliente.id, empresa_id: cliente.empresa_id, prefijo: k.prefijo, hash: k.hash, nombre: b.nombre_llave || b.nombre || null, expira, descripcion },
  });
  return { id: fila.id, prefijo: k.prefijo, llave: k.llave, expira, descripcion };
}

// Cambios permitidos sobre una llave ya creada: vencimiento y descripción.
function cambiosDeLlave(b) {
  const cambios = {};
  if ('expira' in b) cambios.expira = expiraValida(b.expira);
  if ('descripcion' in b) cambios.descripcion = descripcionValida(b.descripcion);
  if (!Object.keys(cambios).length) throw error(400, 'Indica expira y/o descripcion.');
  return cambios;
}

// Langfuse por cliente: { activo, host, public_key, secret_key }. Sin secret_key se conserva la anterior.
async function langfuseValido(clienteId, l) {
  if (l === null || l?.activo === false) {
    const [c] = await rest(`clientes?id=eq.${clienteId}&select=langfuse`);
    return c?.langfuse ? { ...c.langfuse, activo: false } : null;
  }
  if (!/^https:\/\/[\w.-]+(:\d+)?\/?$/.test(l?.host || '')) throw error(400, 'langfuse.host debe ser una URL https (ej. https://langfuse.example.com).');
  if (!/^pk-lf-[\w-]{8,}$/.test(l.public_key || '')) throw error(400, 'langfuse.public_key debe empezar con pk-lf-.');
  let secret = l.secret_key ? String(l.secret_key).trim() : null;
  if (secret && !/^sk-lf-[\w-]{8,}$/.test(secret)) throw error(400, 'langfuse.secret_key debe empezar con sk-lf-.');
  if (!secret) {
    const [c] = await rest(`clientes?id=eq.${clienteId}&select=langfuse`);
    if (!c?.langfuse?.secret_cifrado) throw error(400, 'Falta langfuse.secret_key.');
    return { activo: true, host: l.host.replace(/\/$/, ''), public_key: l.public_key, secret_cifrado: c.langfuse.secret_cifrado };
  }
  // Se prueba la llave antes de guardarla.
  const r = await fetch(`${l.host.replace(/\/$/, '')}/api/public/projects`, {
    headers: { Authorization: `Basic ${Buffer.from(`${l.public_key}:${secret}`).toString('base64')}` }, signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!r?.ok) throw error(400, `Langfuse rechazó esas llaves (${r ? r.status : 'sin respuesta'}).`);
  return { activo: true, host: l.host.replace(/\/$/, ''), public_key: l.public_key, secret_cifrado: cifrar(secret) };
}

const COLS_CREDENCIAL = 'id,empresa_id,proveedor,tipo,huella,activa,creada,expira,descripcion';
const COLS_LLAVE = 'id,empresa_id,cliente_id,prefijo,nombre,descripcion,activa,creada,ultimo_uso,expira,clientes(nombre)';
const PREFIJOS = {
  openai: { api: /^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/, admin: /^sk-admin-[A-Za-z0-9_-]{20,}$/ },
  // api03 = llave de workspace; usr = personal; svc/svac = de cuenta de servicio (tipos de llave de 2026)
  anthropic: { api: /^sk-ant-(api\d{2}|usr\d*|svc\d*|svac\d*)-[A-Za-z0-9_-]{20,}$/, admin: /^sk-ant-admin\d{2}-[A-Za-z0-9_-]{20,}$/ },
};

async function clienteDe(q, id) {
  const [c] = await rest(`clientes?id=eq.${enc(id)}&select=*`);
  if (!c) throw error(404, 'Cliente no encontrado.');
  empresaPermitida(q, c.empresa_id);
  return c;
}

const rutas = [
  ['GET', /^\/admin\/yo$/, async (q) => q],

  ['GET', /^\/admin\/empresas$/, async (q) =>
    rest(`empresas?select=*${filtroEmp(q, null, 'id')}&order=id`)],

  ['POST', /^\/admin\/empresas$/, async (q, b) => {
    soloSuper(q);
    if (!SLUG.test(b.id || '')) throw error(400, 'id debe ser un slug en minúsculas (ej. "nueva-empresa").');
    const [e] = await rest('empresas', { metodo: 'POST', prefer: 'return=representation', cuerpo: { id: b.id, nombre: b.nombre || b.id } });
    return e;
  }],

  // Ruta por defecto de la empresa para Claude (ruta_anthropic) y para OpenAI (ruta_openai): directo o bedrock.
  ['PATCH', /^\/admin\/empresas\/([a-z0-9][a-z0-9-]{1,40})$/, async (q, b, m) => {
    soloSuper(q);
    const cambios = rutasDe(b, false);
    if (!Object.keys(cambios).length) throw error(400, 'Indica ruta_anthropic y/o ruta_openai.');
    const [e] = await rest(`empresas?id=eq.${enc(m[1])}`, { metodo: 'PATCH', prefer: 'return=representation', cuerpo: cambios });
    if (!e) throw error(404, 'Empresa no encontrada.');
    await recargar();
    return e;
  }],

  // Traducción de nombres de modelo de Anthropic a ids de Bedrock (empresa_id null = global).
  ['GET', /^\/admin\/bedrock\/modelos$/, async () => rest('bedrock_modelos?select=*&order=empresa_id.nullsfirst,modelo')],

  ['PUT', /^\/admin\/bedrock\/modelos$/, async (q, b) => {
    soloSuper(q);
    if (b.empresa_id) empresaPermitida(q, b.empresa_id);
    const modelo = String(b.modelo || '').trim();
    const bedrockId = String(b.bedrock_id || '').trim();
    if (!/^[a-z0-9][a-z0-9.:_-]{2,100}$/i.test(modelo)) throw error(400, 'modelo inválido.');
    if (!/^(arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:[a-z-]+\/[\w.:-]+|([a-z-]+\.)?(anthropic|openai)\.[\w.:-]+)$/.test(bedrockId)) {
      throw error(400, 'bedrock_id debe ser anthropic.…, openai.…, <región>.anthropic.…, <región>.openai.… o un ARN de Bedrock.');
    }
    const filtro = `empresa_id=${b.empresa_id ? `eq.${enc(b.empresa_id)}` : 'is.null'}&modelo=eq.${enc(modelo)}`;
    const existe = await rest(`bedrock_modelos?${filtro}&select=id`);
    const [r] = existe.length
      ? await rest(`bedrock_modelos?${filtro}`, { metodo: 'PATCH', prefer: 'return=representation', cuerpo: { bedrock_id: bedrockId } })
      : await rest('bedrock_modelos', { metodo: 'POST', prefer: 'return=representation', cuerpo: { empresa_id: b.empresa_id || null, modelo, bedrock_id: bedrockId } });
    await recargar();
    return r;
  }],

  ['DELETE', /^\/admin\/bedrock\/modelos\/(\d+)$/, async (q, _b, m) => {
    soloSuper(q);
    await rest(`bedrock_modelos?id=eq.${m[1]}`, { metodo: 'DELETE', prefer: 'return=minimal' });
    await recargar();
    return { ok: true, borrado: Number(m[1]) };
  }],

  // Cargar o reemplazar la llave real de un proveedor (tipo api o admin).
  ['PUT', /^\/admin\/credenciales$/, async (q, b) => {
    soloSuper(q);
    empresaPermitida(q, b.empresa_id);
    if (![...PROVEEDORES, 'bedrock'].includes(b.proveedor)) throw error(400, 'proveedor debe ser openai, anthropic o bedrock.');
    if (!['api', 'admin'].includes(b.tipo)) throw error(400, 'tipo debe ser api o admin.');
    const valor = typeof b.valor === 'string' ? b.valor.trim() : '';
    let huella = valor.slice(-4);
    if (b.proveedor === 'bedrock') {
      if (b.tipo !== 'api') throw error(400, 'Bedrock solo tiene credencial de tipo api.');
      try { huella = huellaBedrock(leerCredencialBedrock(valor)); }
      catch (e) { throw error(400, `Credencial de Bedrock inválida: ${e.message}. Ver docs/bedrock.md.`); }
    } else if (!PREFIJOS[b.proveedor][b.tipo].test(valor)) {
      throw error(400, `Eso no parece una llave ${b.tipo === 'admin' ? 'de administración' : 'normal'} de ${b.proveedor}. Revisa que pegaste la correcta.`);
    }
    const expira = expiraValida(b.expira);
    const descripcion = descripcionValida(b.descripcion);
    await rest('credenciales_proveedor?on_conflict=empresa_id,proveedor,tipo', {
      metodo: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      cuerpo: { empresa_id: b.empresa_id, proveedor: b.proveedor, tipo: b.tipo, valor_cifrado: cifrar(valor), huella, activa: true, expira, descripcion },
    });
    await recargar();
    return { ok: true, empresa_id: b.empresa_id, proveedor: b.proveedor, tipo: b.tipo, huella, expira, descripcion };
  }],

  ['GET', /^\/admin\/credenciales$/, async (q) => {
    soloSuper(q);
    return rest(`credenciales_proveedor?select=${COLS_CREDENCIAL}&order=empresa_id,proveedor,tipo`);
  }],

  ['PATCH', /^\/admin\/credenciales\/([0-9a-f-]{36})$/, async (q, b, m) => {
    soloSuper(q);
    const [c] = await rest(`credenciales_proveedor?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=representation', cuerpo: cambiosDeLlave(b) });
    if (!c) throw error(404, 'Credencial no encontrada.');
    await recargar();
    return { id: c.id, expira: c.expira, descripcion: c.descripcion };
  }],

  // Desactivar una llave real: el gateway deja de usarla (las llamadas de esa empresa responden 503).
  ['DELETE', /^\/admin\/credenciales\/([0-9a-f-]{36})$/, async (q, _b, m) => {
    soloSuper(q);
    await rest(`credenciales_proveedor?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=minimal', cuerpo: { activa: false } });
    await recargar();
    return { ok: true, desactivada: m[1] };
  }],

  ['GET', /^\/admin\/llaves$/, async (q, _b, _m, url) => {
    const empresa = url.searchParams.get('empresa') || null;
    if (empresa) empresaPermitida(q, empresa);
    const cliente = url.searchParams.get('cliente');
    return rest(`llaves?select=${COLS_LLAVE}${filtroEmp(q, empresa)}${cliente ? `&cliente_id=eq.${enc(cliente)}` : ''}&order=expira`);
  }],

  ['PATCH', /^\/admin\/llaves\/([0-9a-f-]{36})$/, async (q, b, m) => {
    const [k] = await rest(`llaves?id=eq.${m[1]}&select=id,empresa_id`);
    if (!k) throw error(404, 'Llave no encontrada.');
    empresaPermitida(q, k.empresa_id);
    const [r] = await rest(`llaves?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=representation', cuerpo: cambiosDeLlave(b) });
    await recargar();
    return { id: r.id, expira: r.expira, descripcion: r.descripcion };
  }],

  ['GET', /^\/admin\/llaves-admin$/, async (q) => {
    soloSuper(q);
    return rest('llaves_admin?select=id,empresa_id,prefijo,nombre,descripcion,activa,creada,expira&order=expira');
  }],

  ['PATCH', /^\/admin\/llaves-admin\/([0-9a-f-]{36})$/, async (q, b, m) => {
    soloSuper(q);
    const [r] = await rest(`llaves_admin?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=representation', cuerpo: cambiosDeLlave(b) });
    if (!r) throw error(404, 'Llave de administración no encontrada.');
    await recargar();
    return { id: r.id, expira: r.expira, descripcion: r.descripcion };
  }],

  ['DELETE', /^\/admin\/llaves-admin\/([0-9a-f-]{36})$/, async (q, _b, m) => {
    soloSuper(q);
    await rest(`llaves_admin?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=minimal', cuerpo: { activa: false } });
    await recargar();
    return { ok: true, revocada: m[1] };
  }],

  ['GET', /^\/admin\/clientes$/, async (q, _b, _m, url) => {
    const empresa = url.searchParams.get('empresa') || null;
    if (empresa) empresaPermitida(q, empresa);
    const [filas, lfs] = await Promise.all([
      rest(`v_consumo_mes_cliente?select=*${filtroEmp(q, empresa)}&order=empresa_id,nombre`),
      rest(`clientes?select=id,langfuse${filtroEmp(q, empresa)}`),
    ]);
    const lf = new Map(lfs.map((c) => [c.id, c.langfuse?.activo ? { host: c.langfuse.host, public_key: c.langfuse.public_key } : null]));
    return filas.map((f) => ({ ...f, langfuse: lf.get(f.cliente_id) || null }));
  }],

  // Crear un cliente con su primera llave. La llave completa solo se muestra aquí.
  ['POST', /^\/admin\/clientes$/, async (q, b) => {
    const empresa = empresaPermitida(q, b.empresa_id);
    if (!b.nombre || String(b.nombre).length > 120) throw error(400, 'Falta nombre (máx. 120 caracteres).');
    expiraValida(b.expira);           // se valida antes de crear el cliente, para no dejarlo sin llave
    descripcionValida(b.descripcion);
    const [c] = await rest('clientes', {
      metodo: 'POST', prefer: 'return=representation',
      cuerpo: { empresa_id: empresa, nombre: String(b.nombre).trim(), presupuesto_usd_mensual: presupuestoValido(b.presupuesto_usd_mensual), metadata: b.metadata || {} },
    });
    const llave = await crearLlaveCliente(c, { ...b, nombre_llave: 'principal' });
    await recargar();
    return { cliente: c, llave };
  }],

  ['PATCH', /^\/admin\/clientes\/([0-9a-f-]{36})$/, async (q, b, m) => {
    await clienteDe(q, m[1]);
    const cambios = {};
    if ('presupuesto_usd_mensual' in b) cambios.presupuesto_usd_mensual = presupuestoValido(b.presupuesto_usd_mensual);
    if ('activo' in b) cambios.activo = Boolean(b.activo);
    if ('nombre' in b) cambios.nombre = String(b.nombre).trim();
    if ('langfuse' in b) cambios.langfuse = await langfuseValido(m[1], b.langfuse);
    Object.assign(cambios, rutasDe(b, true));
    if (!Object.keys(cambios).length) throw error(400, 'Nada que cambiar.');
    const [c] = await rest(`clientes?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=representation', cuerpo: cambios });
    await recargar();
    return c;
  }],

  ['POST', /^\/admin\/clientes\/([0-9a-f-]{36})\/llaves$/, async (q, b, m) => {
    const c = await clienteDe(q, m[1]);
    const llave = await crearLlaveCliente(c, b);
    await recargar();
    return llave;
  }],

  ['DELETE', /^\/admin\/llaves\/([0-9a-f-]{36})$/, async (q, _b, m) => {
    const [k] = await rest(`llaves?id=eq.${m[1]}&select=id,empresa_id`);
    if (!k) throw error(404, 'Llave no encontrada.');
    empresaPermitida(q, k.empresa_id);
    await rest(`llaves?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=minimal', cuerpo: { activa: false } });
    await recargar();
    return { ok: true, revocada: m[1] };
  }],

  ['GET', /^\/admin\/consumo$/, async (q, _b, _m, url) => {
    const empresa = url.searchParams.get('empresa') || null;
    if (empresa) empresaPermitida(q, empresa);
    const desde = url.searchParams.get('desde') || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const filtro = [`dia=gte.${enc(desde)}`];
    if (url.searchParams.get('hasta')) filtro.push(`dia=lte.${enc(url.searchParams.get('hasta'))}`);
    { const f = filtroEmp(q, empresa); if (f) filtro.push(f.slice(1)); }
    return rest(`v_consumo_diario?select=*&${filtro.join('&')}&order=dia.desc`);
  }],

  // Llave de administración por API (superadmin, o admin de una empresa si viene empresa_id).
  ['POST', /^\/admin\/llaves-admin$/, async (q, b) => {
    soloSuper(q);
    if (b.empresa_id) empresaPermitida(q, b.empresa_id);
    const expira = expiraValida(b.expira);
    const descripcion = descripcionValida(b.descripcion);
    const k = nuevaLlave('tfa');
    await rest('llaves_admin', { metodo: 'POST', prefer: 'return=minimal', cuerpo: { empresa_id: b.empresa_id || null, prefijo: k.prefijo, hash: k.hash, nombre: b.nombre || null, expira, descripcion } });
    await recargar();
    return { empresa_id: b.empresa_id || null, prefijo: k.prefijo, llave: k.llave, expira, descripcion };
  }],

  // Estado de una suscripción (Codex, Antigravity…) que manda el colector de un equipo. Admin de la empresa.
  ['POST', /^\/admin\/suscripciones$/, async (q, b) => {
    empresaPermitida(q, b.empresa_id);
    if (!/^[a-z]+:[\w.@+ ()·-]{1,120}$/u.test(b.id || '')) throw error(400, 'id inválido (ej. codex:correo@dominio).');
    if (!['claude', 'chatgpt', 'antigravity'].includes(b.proveedor)) throw error(400, 'proveedor: claude | chatgpt | antigravity.');
    if (!Array.isArray(b.ventanas) || b.ventanas.length > 12) throw error(400, 'ventanas debe ser una lista (máx. 12).');
    const ventanas = b.ventanas.map((v) => ({ clave: String(v.clave || '').slice(0, 40), nombre: v.nombre ? String(v.nombre).slice(0, 60) : null,
      usado: Math.max(0, Math.min(1, Number(v.usado) || 0)), ventana_min: Number(v.ventana_min) || null, reset: Number(v.reset) || null }));
    const ts = b.ts && !Number.isNaN(Date.parse(b.ts)) ? new Date(b.ts).toISOString() : new Date().toISOString();
    const [actual] = await rest(`suscripciones_estado?id=eq.${enc(b.id)}&select=ts`);
    if (actual && Date.parse(actual.ts) > Date.parse(ts)) return { ok: true, ignorado: 'ya hay un dato más nuevo' };
    await rest('suscripciones_estado?on_conflict=id', { metodo: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      cuerpo: { id: b.id, empresa_id: b.empresa_id, proveedor: b.proveedor, cuenta: String(b.cuenta || b.id).slice(0, 120),
        plan: b.plan ? String(b.plan).slice(0, 40) : null, equipo: b.equipo ? String(b.equipo).slice(0, 80) : null,
        ventanas, extra: typeof b.extra === 'object' && b.extra ? b.extra : {}, ts } });
    return { ok: true };
  }],

  // Registro de autoría (quién escribió cada mensaje), lo sube un colector externo. Admin de la empresa.
  ['POST', /^\/admin\/autoria$/, async (q, b) => {
    empresaPermitida(q, b.empresa_id);
    if (!Array.isArray(b.filas) || b.filas.length > 5000) throw error(400, 'filas debe ser una lista (máx. 5000).');
    const UUID = /^[0-9a-f-]{36}$/i;
    const filas = b.filas.filter((f) => UUID.test(f.sesion || '') && !Number.isNaN(Date.parse(f.ts)) && f.autor)
      .map((f) => ({ sesion: f.sesion.toLowerCase(), ts: new Date(f.ts).toISOString(), empresa_id: b.empresa_id,
        equipo: String(b.equipo || 'default').slice(0, 80), autor: String(f.autor).slice(0, 120),
        certeza: f.certeza ? String(f.certeza).slice(0, 30) : null, cwd: f.cwd ? String(f.cwd).slice(0, 300) : null }));
    if (filas.length) {
      await rest('autoria_mensajes?on_conflict=sesion,ts,autor', { metodo: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', cuerpo: filas });
    }
    return { ok: true, recibidas: b.filas.length, guardadas: filas.length };
  }],

  // Usuario del panel. empresa_id vacío = superadmin.
  ['POST', /^\/admin\/usuarios$/, async (q, b) => {
    soloSuper(q);
    if (b.empresa_id) empresaPermitida(q, b.empresa_id);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) throw error(400, 'email inválido.');
    if (!b.password || b.password.length < 10) throw error(400, 'password debe tener al menos 10 caracteres.');
    // empresas_extra: otras empresas que también ve (usuario multiempresa). Requiere empresa_id principal.
    const extra = [...new Set((Array.isArray(b.empresas_extra) ? b.empresas_extra : []).filter((e) => e && e !== b.empresa_id))];
    if (extra.length && !b.empresa_id) throw error(400, 'empresas_extra requiere empresa_id (un superadmin ya ve todas).');
    const existentes = new Set((await rest('empresas?select=id')).map((e) => e.id));
    for (const e of [b.empresa_id, ...extra].filter(Boolean)) if (!existentes.has(e)) throw error(400, `No existe la empresa ${e}.`);
    const u = await authAdmin('users', { email: b.email, password: b.password, email_confirm: true });
    await rest('perfiles', { metodo: 'POST', prefer: 'return=minimal', cuerpo: { user_id: u.id, empresa_id: b.empresa_id || null, empresas_extra: extra, nombre: b.nombre || null } });
    return { id: u.id, email: b.email, empresa_id: b.empresa_id || null, empresas_extra: extra };
  }],

  // Reglas de uso (ver reglas-logica.mjs). GET trae el consumo actual de cada una.
  ['GET', /^\/admin\/reglas$/, async (q, _b, _m, url) => {
    const empresa = url.searchParams.get('empresa') || null;
    if (empresa) empresaPermitida(q, empresa);
    const [rs, cs] = await Promise.all([
      rest(`reglas?select=*${filtroEmp(q, empresa)}&order=empresa_id,creada`),
      rest('rpc/consumo_reglas', { metodo: 'POST', cuerpo: {} }),
    ]);
    const consumo = new Map(cs.map((c) => [c.regla_id, Number(c.consumo)]));
    const ahora = new Date();
    return rs.map((r) => ({ ...r, consumo: r.ventana_tipo === 'plan' ? valorDeReglaPlan(r) : consumo.get(r.id) || 0, en_horario: enHorario(r, ahora) }));
  }],

  ['POST', /^\/admin\/reglas$/, async (q, b) => {
    const empresa = empresaPermitida(q, b.empresa_id);
    const regla = validarRegla(b);
    await validarClienteDeRegla(q, empresa, regla.filtro_cliente_id);
    const [r] = await rest('reglas', { metodo: 'POST', prefer: 'return=representation', cuerpo: { ...regla, empresa_id: empresa } });
    await recargarReglas();
    return r;
  }],

  // Acepta cambios parciales: se combinan con la regla actual y se valida el resultado.
  ['PATCH', /^\/admin\/reglas\/([0-9a-f-]{36})$/, async (q, b, m) => {
    const actual = await reglaDe(q, m[1]);
    const regla = validarRegla({ ...actual, ...b });
    await validarClienteDeRegla(q, actual.empresa_id, regla.filtro_cliente_id);
    const [r] = await rest(`reglas?id=eq.${m[1]}`, { metodo: 'PATCH', prefer: 'return=representation', cuerpo: { ...regla, actualizada: new Date().toISOString() } });
    await recargarReglas();
    return r;
  }],

  ['DELETE', /^\/admin\/reglas\/([0-9a-f-]{36})$/, async (q, _b, m) => {
    await reglaDe(q, m[1]);
    await rest(`reglas?id=eq.${m[1]}`, { metodo: 'DELETE', prefer: 'return=minimal' });
    await recargarReglas();
    return { ok: true, borrada: m[1] };
  }],

  // Notificaciones push del panel (PWA). Requieren la sesión del panel: se guardan por usuario.
  ['POST', /^\/admin\/push\/suscribir$/, async (q, b, _m, _u, req) => {
    if (!q.userId) throw error(400, 'Suscribirse requiere iniciar sesión en el panel.');
    if (!pushDisponible()) throw error(503, 'Las notificaciones no están configuradas en el gateway.');
    const { endpoint, keys } = b;
    if (!/^https:\/\//.test(endpoint || '') || !keys?.p256dh || !keys?.auth) throw error(400, 'Suscripción inválida.');
    await rest('push_suscripciones?on_conflict=endpoint', {
      metodo: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      cuerpo: { user_id: q.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, agente: String(req.headers['user-agent'] || '').slice(0, 200) },
    });
    return { ok: true };
  }],

  ['POST', /^\/admin\/push\/desuscribir$/, async (q, b) => {
    if (!q.userId) throw error(400, 'Requiere la sesión del panel.');
    await rest(`push_suscripciones?endpoint=eq.${enc(b.endpoint || '')}&user_id=eq.${enc(q.userId)}`, { metodo: 'DELETE', prefer: 'return=minimal' });
    return { ok: true };
  }],

  ['POST', /^\/admin\/push\/probar$/, async (q) => {
    const r = await notificar({
      userId: q.userId, empresa: q.empresa, titulo: 'Notificaciones activadas',
      cuerpo: 'Así te avisará el gateway cuando un cliente llegue al 80 % de su cuota, se dispare una regla o venza una llave.',
    });
    if (!r.enviados) throw error(404, 'No hay dispositivos suscritos para recibirla.');
    return r;
  }],

  // Saldo de créditos por empresa y proveedor (calculado: último saldo anotado + recargas - costo real).
  ['GET', /^\/admin\/saldos$/, async (q) => {
    const filtro = filtroEmp(q, null);
    const [saldos, movs] = await Promise.all([
      saldosConRitmo(filtro),
      rest(`movimientos_saldo?select=*${filtro}&order=fecha.desc,creado.desc&limit=50`),
    ]);
    return { saldos, movimientos: movs };
  }],

  ['POST', /^\/admin\/saldos$/, async (q, b) => {
    soloSuper(q);
    empresaPermitida(q, b.empresa_id);
    if (!PROVEEDORES.includes(b.proveedor)) throw error(400, 'proveedor debe ser openai o anthropic.');
    if (!['saldo', 'recarga'].includes(b.tipo)) throw error(400, 'tipo debe ser saldo o recarga.');
    const monto = Number(b.monto_usd);
    if (!Number.isFinite(monto) || monto < 0) throw error(400, 'monto_usd debe ser un número mayor o igual a 0.');
    const fecha = String(b.fecha || '').trim() || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw error(400, 'fecha debe ser AAAA-MM-DD.');
    // Vencimiento propio de la recarga (opcional): lo que no se use hasta ese día se pierde. No se deriva de la fecha.
    const vence = String(b.vence || '').trim() || null;
    if (vence && b.tipo !== 'recarga') throw error(400, 'Solo una recarga puede tener vencimiento.');
    if (vence && !/^\d{4}-\d{2}-\d{2}$/.test(vence)) throw error(400, 'vence debe ser AAAA-MM-DD.');
    if (vence && vence < fecha) throw error(400, 'vence no puede ser anterior a la fecha de la recarga.');
    const [m] = await rest('movimientos_saldo', { metodo: 'POST', prefer: 'return=representation',
      cuerpo: { empresa_id: b.empresa_id, proveedor: b.proveedor, tipo: b.tipo, monto_usd: monto, fecha, vence, nota: descripcionValida(b.nota) } });
    return m;
  }],

  ['DELETE', /^\/admin\/saldos\/([0-9a-f-]{36})$/, async (q, _b, m) => {
    soloSuper(q);
    await rest(`movimientos_saldo?id=eq.${m[1]}`, { metodo: 'DELETE', prefer: 'return=minimal' });
    return { ok: true, borrado: m[1] };
  }],

  // Consumo por llave del proveedor, sumado en el período.
  ['GET', /^\/admin\/consumo-proveedor$/, async (q, _b, _m, url) => {
    const empresa = url.searchParams.get('empresa') || null;
    if (empresa) empresaPermitida(q, empresa);
    const desde = url.searchParams.get('desde') || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const hasta = url.searchParams.get('hasta');
    const filas = await rest(`consumo_proveedor?select=*&dia=gte.${enc(desde)}${hasta ? `&dia=lte.${enc(hasta)}` : ''}${filtroEmp(q, empresa)}`);
    const m = new Map();
    for (const f of filas) {
      const k = `${f.empresa_id}|${f.proveedor}|${f.llave_id}`;
      const x = m.get(k) || { empresa_id: f.empresa_id, proveedor: f.proveedor, llave_id: f.llave_id, llave_nombre: f.llave_nombre,
        proyecto: f.proyecto, llamadas: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, usd_estimado: 0, sin_precio: [], modelos: {} };
      for (const c of ['llamadas', 'tokens_in', 'tokens_out', 'cache_read', 'cache_write']) x[c] += Number(f[c]);
      if (f.usd_estimado === null) { if (!x.sin_precio.includes(f.modelo)) x.sin_precio.push(f.modelo); } else x.usd_estimado += Number(f.usd_estimado);
      x.modelos[f.modelo] = (x.modelos[f.modelo] || 0) + Number(f.tokens_in) + Number(f.tokens_out) + Number(f.cache_read) + Number(f.cache_write);
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => (b.tokens_in + b.tokens_out) - (a.tokens_in + a.tokens_out));
  }],

  ['POST', /^\/admin\/reporte\/enviar$/, async (q) => { soloSuper(q); return enviarReporte(); }],
  ['POST', /^\/admin\/costos\/sincronizar$/, async (q) => { soloSuper(q); return sincronizarTodo(); }],
];

export async function admin(req, res, url) {
  const q = await quien(req);
  if (!q) return responderError(res, 401, 'unauthorized', 'Falta una llave de administración válida.');
  const ruta = rutas.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!ruta) return responderError(res, 404, 'not_found', 'Ruta de administración inexistente.');
  try {
    const cuerpo = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await leerJson(req) : {};
    const datos = await ruta[2](q, cuerpo, url.pathname.match(ruta[1]), url, req);
    responderJson(res, 200, datos);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`Error en ${req.method} ${url.pathname}: ${e.message}`);
    const mensaje = status >= 500 && /duplicate key/.test(e.message) ? 'Ya existe un registro con ese nombre.' : e.message;
    responderError(res, /duplicate key/.test(e.message) ? 409 : status, 'admin_error', status >= 500 && !/duplicate/.test(e.message) ? 'Error interno; revisa los logs del proxy.' : mensaje);
  }
}
