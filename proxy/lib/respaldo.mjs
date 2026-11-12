// Respaldo cuando OpenAI rechaza un pedido por su filtro de seguridad (400 «your prompt was flagged…»).
// Se reintenta una sola vez con otro modelo, elegido por cliente (clientes.metadata.respaldo_filtro) o, si el
// cliente no dice nada, por el valor general GW_RESPALDO_FILTRO. «no» en el cliente lo apaga para ese cliente.
// Solo para este error: un 400 de parámetros, presupuesto o reglas nunca se reintenta.

const FILTRO = /invalid_prompt|flagged as potentially violating|violating our usage polic/i;

export function esRechazoDeFiltro(status, texto) {
  return status === 400 && FILTRO.test(String(texto || ''));
}

// Modelo de respaldo para esta llamada, o null si no aplica.
export function modeloDeRespaldo({ info, proveedor, via, pedido, general = process.env.GW_RESPALDO_FILTRO }) {
  if (proveedor !== 'openai' || via !== 'directo' || !pedido || typeof pedido.model !== 'string') return null;
  const delCliente = info?.respaldo_filtro;
  const elegido = String(delCliente ?? general ?? '').trim();
  if (!elegido || elegido.toLowerCase() === 'no') return null;
  if (elegido.toLowerCase() === pedido.model.toLowerCase()) return null;   // mismo modelo: reintentar no sirve
  return elegido;
}

// Pedido con el modelo de respaldo. Si el respaldo no es de la serie gpt-5 / o-series, se quitan los parámetros de
// razonamiento que esos modelos rechazan (Chat: reasoning_effort; Responses: reasoning).
export function pedidoDeRespaldo(pedido, modelo) {
  const razona = /^(gpt-5|gpt-6|o\d)/i.test(modelo);
  const nuevo = { ...pedido, model: modelo };
  if (!razona) { delete nuevo.reasoning_effort; delete nuevo.reasoning; }
  return nuevo;
}
