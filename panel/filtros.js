// Panel: filtros compartidos (período con calendario, proveedor y cliente).
// Los demás módulos leen el rango con rango() en vez de un número fijo de días.
const $ = (id) => document.getElementById(id);
const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(d);
const hoyChile = () => fmt(new Date());
const masDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Cada preset devuelve [desde, hasta] (AAAA-MM-DD, hora de Chile).
const PRESETS = {
  hoy: () => [hoyChile(), hoyChile()],
  ayer: () => [masDias(hoyChile(), -1), masDias(hoyChile(), -1)],
  d7: () => [masDias(hoyChile(), -6), hoyChile()],
  d30: () => [masDias(hoyChile(), -29), hoyChile()],
  d90: () => [masDias(hoyChile(), -89), hoyChile()],
  mes: () => [hoyChile().slice(0, 8) + '01', hoyChile()],
  mesAnterior: () => {
    const primeroEste = hoyChile().slice(0, 8) + '01';
    const ultimoAnterior = masDias(primeroEste, -1);
    return [ultimoAnterior.slice(0, 8) + '01', ultimoAnterior];
  },
  anio: () => [hoyChile().slice(0, 4) + '-01-01', hoyChile()],
};

export function rango() {
  const desde = $('filtroDesde').value || PRESETS.d30()[0];
  const hasta = $('filtroHasta').value || hoyChile();
  return desde <= hasta ? { desde, hasta } : { desde: hasta, hasta: desde };
}

export const proveedorFiltro = () => $('filtroProveedor').value;
export const clienteFiltro = () => $('filtroCliente').value;

// Días del rango, de desde a hasta inclusive.
export function diasDelRango({ desde, hasta }) {
  const dias = [];
  for (let d = desde; d <= hasta && dias.length < 1100; d = masDias(d, 1)) dias.push(d);
  return dias;
}

export function iniciarFiltros(alCambiar) {
  const aplicarPreset = () => {
    const p = PRESETS[$('filtroPeriodo').value];
    if (p) { const [d, h] = p(); $('filtroDesde').value = d; $('filtroHasta').value = h; }
  };
  $('filtroPeriodo').onchange = () => { aplicarPreset(); alCambiar(); };
  for (const id of ['filtroDesde', 'filtroHasta']) {
    $(id).max = hoyChile();
    $(id).onchange = () => { $('filtroPeriodo').value = 'personalizado'; alCambiar(); };
  }
  for (const id of ['filtroProveedor', 'filtroCliente']) $(id).onchange = alCambiar;
  aplicarPreset();
}

// Lista de clientes del filtro, según la empresa elegida.
export function pintarClientesFiltro(clientes, empresa) {
  const sel = $('filtroCliente');
  const actual = sel.value;
  const lista = clientes.filter((c) => !empresa || c.empresa_id === empresa).sort((a, b) => a.nombre.localeCompare(b.nombre));
  sel.innerHTML = '<option value="">Todos los clientes</option>'
    + lista.map((c) => `<option value="${c.cliente_id}">${String(c.nombre).replace(/[&<>"]/g, '')}</option>`).join('');
  sel.value = lista.some((c) => c.cliente_id === actual) ? actual : '';
}
