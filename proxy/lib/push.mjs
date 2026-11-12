// Web Push sin dependencias: cifrado aes128gcm (RFC 8291) y autenticación VAPID (RFC 8292) con node:crypto.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { rest, enc } from './db.mjs';

const b64u = (b) => Buffer.from(b).toString('base64url');
const deB64u = (s) => Buffer.from(s, 'base64url');
const hmac = (clave, datos) => createHmac('sha256', clave).update(datos).digest();

const VAPID = (() => {
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  if (!pub || !priv) return null;
  const crudo = deB64u(pub);                       // 65 bytes: 0x04 || x || y
  const clave = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(crudo.subarray(1, 33)), y: b64u(crudo.subarray(33, 65)) }, format: 'jwk',
  });
  return { pub, clave, sujeto: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' };
})();

export const pushDisponible = () => Boolean(VAPID);
export const clavePublica = () => VAPID?.pub || null;

function jwtVapid(endpoint) {
  const aud = new URL(endpoint).origin;
  const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const cuerpo = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID.sujeto }));
  const firma = sign('sha256', Buffer.from(`${cab}.${cuerpo}`), { key: VAPID.clave, dsaEncoding: 'ieee-p1363' });
  return `${cab}.${cuerpo}.${b64u(firma)}`;
}

// Cifra el mensaje para una suscripción (p256dh y auth en base64url, como los entrega el navegador).
export function cifrarMensaje(texto, p256dh, auth) {
  const uaPublica = deB64u(p256dh);
  const secreto = deB64u(auth);
  const ecdh = createECDH('prime256v1');
  const asPublica = ecdh.generateKeys();
  const compartido = ecdh.computeSecret(uaPublica);
  const prkClave = hmac(secreto, compartido);
  const ikm = hmac(prkClave, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica, Buffer.from([1])]));
  const sal = randomBytes(16);
  const prk = hmac(sal, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([c.update(Buffer.concat([Buffer.from(texto, 'utf8'), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([sal, rs, Buffer.from([asPublica.length]), asPublica, cifrado]);
}

async function enviarA(sus, mensaje) {
  const r = await fetch(sus.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: mensaje.urgente ? 'high' : 'normal',
      Authorization: `vapid t=${jwtVapid(sus.endpoint)}, k=${VAPID.pub}`,
    },
    body: cifrarMensaje(JSON.stringify(mensaje), sus.p256dh, sus.auth),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404 || r.status === 410) {        // el navegador dio de baja la suscripción
    await rest(`push_suscripciones?id=eq.${sus.id}`, { metodo: 'DELETE', prefer: 'return=minimal' }).catch(() => {});
    return 'baja';
  }
  if (!r.ok) throw new Error(`push ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return 'ok';
}

// Envía a todos los usuarios que pueden ver esa empresa (superadmins siempre). empresa null = solo superadmins.
// Si se pasa userId, solo a ese usuario.
export async function notificar({ empresa = null, titulo, cuerpo, url = '/panel/', urgente = false, etiqueta, userId } = {}) {
  if (!VAPID) return { enviados: 0, motivo: 'push sin configurar (faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)' };
  const [subs, perfiles] = await Promise.all([
    rest(`push_suscripciones?select=id,user_id,endpoint,p256dh,auth${userId ? `&user_id=eq.${enc(userId)}` : ''}`),
    rest('perfiles?select=user_id,empresa_id,empresas_extra'),
  ]);
  // user_id -> null (superadmin) o lista de empresas que ve
  const empresaDe = new Map(perfiles.map((p) => [p.user_id, p.empresa_id === null ? null : [p.empresa_id, ...(p.empresas_extra || [])]]));
  const destino = subs.filter((s) => empresaDe.has(s.user_id) && (empresaDe.get(s.user_id) === null || (empresa && empresaDe.get(s.user_id).includes(empresa))));
  const mensaje = { titulo, cuerpo, url, urgente, etiqueta: etiqueta || titulo };
  let enviados = 0;
  for (const s of destino) {
    try { if (await enviarA(s, mensaje) === 'ok') enviados++; }
    catch (e) { console.error(`Notificación a ${s.id} falló: ${e.message}`); }
  }
  return { enviados, suscripciones: destino.length };
}
