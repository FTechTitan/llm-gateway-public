// Acceso a la base por PostgREST con el rol service_role. Sin dependencias.
import { config } from './config.mjs';

const cabeceras = {
  Authorization: `Bearer ${config.serviceJwt}`,
  apikey: config.serviceJwt,
  'Content-Type': 'application/json',
};

export async function rest(ruta, { metodo = 'GET', cuerpo, prefer } = {}) {
  const r = await fetch(`${config.restUrl}/${ruta}`, {
    method: metodo,
    headers: { ...cabeceras, ...(prefer ? { Prefer: prefer } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(15000),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`PostgREST ${metodo} ${ruta} -> ${r.status}: ${texto.slice(0, 300)}`);
  return texto ? JSON.parse(texto) : null;
}

export const enc = encodeURIComponent;

// Llamadas al admin de GoTrue (crear usuarios del panel).
export async function authAdmin(ruta, cuerpo) {
  const r = await fetch(`${config.authUrl}/admin/${ruta}`, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GoTrue ${ruta} -> ${r.status}: ${d.msg || d.message || JSON.stringify(d).slice(0, 200)}`);
  return d;
}
