// Sesión de Claude Code de una llamada, para saber después quién la escribió (registro de autoría de un equipo compartido).
// Claude Code la manda de varias formas según la versión:
//   cabecera x-claude-code-session-id: <uuid>
//   metadata.user_id = '{"device_id":…,"session_id":"<uuid>"}'   (versiones nuevas, JSON en texto)
//   metadata.user_id = 'user_<hash>_account_<uuid>_session_<uuid>' (versiones anteriores)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sesionClaudeCode(cabeceras, pedido) {
  const h = String(cabeceras?.['x-claude-code-session-id'] || '').trim();
  if (UUID.test(h)) return h.toLowerCase();
  const uid = pedido?.metadata?.user_id;
  if (typeof uid !== 'string' || uid.length > 2000) return null;
  if (uid.startsWith('{')) {
    try {
      const s = JSON.parse(uid)?.session_id;
      return typeof s === 'string' && UUID.test(s) ? s.toLowerCase() : null;
    } catch { return null; }
  }
  const m = /_session_([0-9a-f-]{36})$/i.exec(uid);
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}
