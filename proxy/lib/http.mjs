// Utilidades HTTP comunes.
export function responderJson(res, status, datos) {
  if (res.headersSent) return res.end();
  const cuerpo = JSON.stringify(datos);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(cuerpo) });
  res.end(cuerpo);
}

// Formato de error compatible con los SDK de OpenAI y Anthropic.
export function responderError(res, status, tipo, mensaje) {
  responderJson(res, status, { type: 'error', error: { type: tipo, code: tipo, message: mensaje } });
}

export function leerCuerpo(req, max) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    let total = 0;
    req.on('data', (t) => {
      total += t.length;
      if (total > max) { rechazar(new Error(`El cuerpo supera ${Math.round(max / 1048576)} MB`)); req.destroy(); return; }
      trozos.push(t);
    });
    req.on('end', () => resolver(Buffer.concat(trozos)));
    req.on('error', rechazar);
  });
}

export async function leerJson(req, max = 1024 * 1024) {
  const b = await leerCuerpo(req, max);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}
