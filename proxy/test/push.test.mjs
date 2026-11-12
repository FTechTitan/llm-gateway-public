// Prueba del cifrado Web Push (RFC 8291): el test hace de navegador y descifra lo que cifra el gateway.
process.env.SERVICE_ROLE_KEY ??= 'x'; process.env.ANON_KEY ??= 'x'; process.env.PUBLIC_URL ??= 'http://x';
process.env.GATEWAY_ENC_KEY ??= Buffer.alloc(32, 7).toString('base64'); process.env.GATEWAY_MASTER_KEY ??= 'm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
const { cifrarMensaje } = await import('../lib/push.mjs');

const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

function descifrarComoNavegador(cuerpo, uaEcdh, secreto) {
  const sal = cuerpo.subarray(0, 16);
  const largoId = cuerpo[20];
  const asPublica = cuerpo.subarray(21, 21 + largoId);
  const cifrado = cuerpo.subarray(21 + largoId);
  const compartido = uaEcdh.computeSecret(asPublica);
  const ikm = hmac(hmac(secreto, compartido), Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublica, Buffer.from([1])]));
  const prk = hmac(sal, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cifrado.subarray(cifrado.length - 16));
  const plano = Buffer.concat([d.update(cifrado.subarray(0, cifrado.length - 16)), d.final()]);
  assert.equal(plano[plano.length - 1], 2, 'falta el delimitador del último registro');
  return plano.subarray(0, -1).toString('utf8');
}

test('el navegador descifra el mensaje que cifra el gateway', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const secreto = randomBytes(16);
  const mensaje = JSON.stringify({ titulo: 'Shop: 80 % de la cuota', cuerpo: 'Lleva US$ 24 de US$ 30 este mes. ñandú áéí' });
  const cuerpo = cifrarMensaje(mensaje, ua.getPublicKey().toString('base64url'), secreto.toString('base64url'));
  assert.equal(cuerpo.readUInt32BE(16), 4096);
  assert.equal(descifrarComoNavegador(cuerpo, ua, secreto), mensaje);
});
