// Validación de la fecha de expiración (obligatoria) y la descripción (opcional) de las llaves.
const MAX_ANIOS = 5;
const MAX_DESCRIPCION = 300;

const invalido = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

// Acepta 'AAAA-MM-DD' (vence al final de ese día, hora de Chile) o una fecha ISO completa.
// Devuelve la fecha en ISO. Debe ser futura y a no más de 5 años.
export function expiraValida(valor, ahora = Date.now()) {
  if (valor === undefined || valor === null || valor === '') {
    throw invalido('Falta expira: toda llave necesita fecha de expiración (AAAA-MM-DD).');
  }
  const texto = String(valor).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(texto) ? `${texto}T23:59:59-03:00` : texto;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw invalido(`expira no es una fecha válida: «${texto}». Usa AAAA-MM-DD.`);
  if (t <= ahora) throw invalido('expira debe ser una fecha futura.');
  if (t > ahora + MAX_ANIOS * 366 * 864e5) throw invalido(`expira no puede pasar de ${MAX_ANIOS} años.`);
  return new Date(t).toISOString();
}

export function descripcionValida(valor) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  if (texto.length > MAX_DESCRIPCION) throw invalido(`descripcion admite hasta ${MAX_DESCRIPCION} caracteres.`);
  return texto || null;
}

// Días que faltan para vencer (negativo si ya venció).
export const diasParaVencer = (expira, ahora = Date.now()) => Math.floor((Date.parse(expira) - ahora) / 864e5);
