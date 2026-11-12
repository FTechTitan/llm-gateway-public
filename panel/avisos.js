// Panel: instalación como app (PWA) y notificaciones push.
const $ = (id) => document.getElementById(id);
let ctx = null;   // { sb }

const b64uABytes = (s) => {
  const relleno = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + relleno).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function admin(metodo, ruta, cuerpo) {
  const { data: { session } } = await ctx.sb.auth.getSession();
  const r = await fetch(ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.access_token || ''}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return d;
}

const soportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function suscripcionActual() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function pintarBoton() {
  const b = $('btnAvisos');
  if (!soportado() || !window.GW.vapid) {
    // En iPhone las notificaciones solo funcionan con la app instalada en la pantalla de inicio.
    b.title = /iPhone|iPad/.test(navigator.userAgent) ? 'Instala la app (Compartir → Agregar a inicio) para recibir avisos.' : 'Este navegador no admite notificaciones.';
    b.disabled = true;
    b.textContent = '🔕';
    return;
  }
  const sus = await suscripcionActual();
  const activas = Boolean(sus) && Notification.permission === 'granted';
  b.textContent = activas ? '🔔' : '🔕';
  b.title = activas ? 'Avisos activados en este dispositivo (clic para desactivar)' : 'Activar avisos en este dispositivo';
  b.dataset.activas = activas ? '1' : '';
}

async function alternar() {
  const b = $('btnAvisos');
  b.disabled = true;
  try {
    if (b.dataset.activas) {
      const sus = await suscripcionActual();
      if (sus) { await admin('POST', '/admin/push/desuscribir', { endpoint: sus.endpoint }).catch(() => {}); await sus.unsubscribe(); }
    } else {
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') throw new Error('No diste permiso para notificaciones. Puedes activarlo en la configuración del navegador.');
      const reg = await navigator.serviceWorker.ready;
      const sus = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uABytes(window.GW.vapid) });
      await admin('POST', '/admin/push/suscribir', sus.toJSON());
      await admin('POST', '/admin/push/probar');
    }
  } catch (e) {
    alert(e.message);   // único aviso modal del panel: el usuario lo pidió con un clic
  } finally {
    b.disabled = false;
    await pintarBoton();
  }
}

// Botón «Instalar» cuando el navegador ofrece instalar la app.
let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  pedidoInstalar = ev;
  $('btnInstalar').classList.remove('oculto');
});
window.addEventListener('appinstalled', () => $('btnInstalar').classList.add('oculto'));

export async function registrarApp() {
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/panel/sw.js', { scope: '/panel/' }).catch((e) => console.error('Service worker:', e));
  }
  $('btnInstalar').onclick = async () => {
    if (!pedidoInstalar) return;
    pedidoInstalar.prompt();
    await pedidoInstalar.userChoice;
    pedidoInstalar = null;
    $('btnInstalar').classList.add('oculto');
  };
}

export async function iniciarAvisos(opciones) {
  ctx = opciones;
  $('btnAvisos').onclick = alternar;
  await pintarBoton();
}
