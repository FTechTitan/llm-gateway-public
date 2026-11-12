// Cliente SMTP mínimo (TLS directo, puerto 465, AUTH LOGIN). Sin dependencias.
import tls from 'node:tls';
import { config } from './config.mjs';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

export async function enviarCorreo({ para, asunto, html }) {
  const { host, puerto, usuario, clave, de } = config.smtp;
  if (!host || !usuario || !clave || !de) throw new Error('SMTP no configurado (SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM).');
  const destinos = Array.isArray(para) ? para : [para];
  const socket = tls.connect({ host, port: puerto, servername: host });
  socket.setTimeout(30000);
  let buffer = '';
  const esperar = () => new Promise((resolver, rechazar) => {
    const alDato = (d) => {
      buffer += d.toString('utf8');
      const lineas = buffer.split('\r\n').filter(Boolean);
      const ultima = lineas[lineas.length - 1] || '';
      if (/^\d{3} /.test(ultima)) {
        socket.off('data', alDato);
        buffer = '';
        const codigo = Number(ultima.slice(0, 3));
        codigo >= 400 ? rechazar(new Error(`SMTP ${ultima}`)) : resolver(codigo);
      }
    };
    socket.on('data', alDato);
    socket.once('error', rechazar);
    socket.once('timeout', () => rechazar(new Error('SMTP: tiempo de espera agotado')));
  });
  const cmd = async (linea) => { socket.write(`${linea}\r\n`); return esperar(); };

  try {
    await esperar();
    await cmd('EHLO llm-gateway');
    await cmd('AUTH LOGIN');
    await cmd(b64(usuario));
    await cmd(b64(clave));
    await cmd(`MAIL FROM:<${de.match(/<(.+)>/)?.[1] || de}>`);
    for (const d of destinos) await cmd(`RCPT TO:<${d}>`);
    await cmd('DATA');
    const mensaje = [
      `From: ${de}`, `To: ${destinos.join(', ')}`,
      `Subject: =?utf-8?B?${b64(asunto)}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      b64(html).replace(/.{1,76}/g, '$&\r\n'),
    ].join('\r\n');
    await cmd(`${mensaje}\r\n.`);
    await cmd('QUIT').catch(() => {});
  } finally {
    socket.end();
  }
}
