// Genera .env con secretos nuevos. Se corre UNA vez en el servidor; no imprime valores.
// Uso: node tools/generar-env.mjs <PUBLIC_URL> [BIND_IP]
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) { console.error('.env ya existe: no se sobrescribe.'); process.exit(1); }
const [urlPublica, bindIp] = process.argv.slice(2);
if (!urlPublica) { console.error('Falta PUBLIC_URL'); process.exit(1); }

const b64url = (b) => Buffer.from(b).toString('base64url');
const secretoJwt = randomBytes(40).toString('hex');
function jwt(rol) {
  const cab = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const datos = b64url(JSON.stringify({ role: rol, iss: 'llm-gateway', iat: Math.floor(Date.now() / 1000), exp: 4102444800 }));
  const firma = createHmac('sha256', secretoJwt).update(`${cab}.${datos}`).digest('base64url');
  return `${cab}.${datos}.${firma}`;
}

const lineas = [
  `PUBLIC_URL=${urlPublica}`,
  `BIND_IP=${bindIp || '127.0.0.1'}`,
  `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
  `JWT_SECRET=${secretoJwt}`,
  `ANON_KEY=${jwt('anon')}`,
  `SERVICE_ROLE_KEY=${jwt('service_role')}`,
  `GATEWAY_ENC_KEY=${randomBytes(32).toString('base64')}`,
  `GATEWAY_MASTER_KEY=tfm_${randomBytes(32).toString('base64url')}`,
  'SMTP_HOST=', 'SMTP_PORT=465', 'SMTP_USER=', 'SMTP_PASS=', 'SMTP_FROM=',
  'REPORTE_PARA=', 'REPORTE_HORA=8',
];
writeFileSync('.env', lineas.join('\n') + '\n', { mode: 0o600 });
console.log('.env creado con permisos 600');
