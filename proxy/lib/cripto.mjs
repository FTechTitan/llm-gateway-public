// Cifrado de llaves de proveedor (AES-256-GCM) y hash/generación de llaves propias.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';

const clave = Buffer.from(config.claveCifrado, 'base64');
if (clave.length !== 32) throw new Error('GATEWAY_ENC_KEY debe ser de 32 bytes en base64');

export function cifrar(texto) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave, iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
}

export function descifrar(paquete) {
  const [v, iv, tag, datos] = paquete.split(':');
  if (v !== 'v1') throw new Error('Formato de cifrado desconocido');
  const d = createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// tfk_ = llave de cliente; tfa_ = llave de administración.
export function nuevaLlave(tipo = 'tfk') {
  const llave = `${tipo}_${randomBytes(24).toString('base64url')}`;
  return { llave, hash: sha256(llave), prefijo: llave.slice(0, 10) };
}

export function igualSeguro(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
