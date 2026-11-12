# Modo suscripción, reglas de uso y vista Suscripciones

## Qué agrega

1. **Ruta `/suscripcion/anthropic/*`**. Claude Code con login de suscripción (Max) apunta aquí. El token OAuth
   (`Authorization`) pasa **sin tocarse** a `api.anthropic.com`; el gateway no guarda cabeceras ni contenido.
   Quién llama se identifica con una llave normal del gateway (`tfk_…`) en la cabecera `x-gw-key`.
   No hay gasto real: lo que costaría por API se guarda en `consumos.costo_equivalente_usd` y **no** consume el
   presupuesto mensual en US$ del cliente.
2. **Reglas de uso** (tabla `reglas`), para los dos modos. Cada regla combina:

   | Parte | Opciones |
   |---|---|
   | Métrica | `tokens` (entrada + salida + caché escrita), `tokens_out`, `costo_usd` (real + equivalente), `llamadas` |
   | Límite | cualquier número; **0 = se dispara siempre dentro del horario** (bloquear franjas) |
   | Ventana | móvil (últimos N minutos; 300 = 5 h) o calendario (día, semana desde el lunes, mes), hora de Chile |
   | Filtros | cliente, modo (`api`/`suscripcion`), proveedor, modelo que contenga un texto. Vacío = todo |
   | Horario | días + desde/hasta en hora de Chile; puede cruzar medianoche |
   | Acción | `avisar` (queda en el log) o `cortar` (403; Claude Code y los SDK no reintentan ese código) |

   El proxy recarga reglas y consumo cada 5 s (función SQL `consumo_reglas()`) y entre recargas suma en memoria lo
   que pasa, así el corte es inmediato. Si la base no responde, siguen valiendo las reglas ya cargadas.
3. **Panel**: sección «Reglas de uso» (crear, editar, activar, borrar, barra de consumo) y «Suscripción» (últimas
   48 h). `/admin` acepta ahora también la sesión del panel, con el rol de su perfil.

## API nueva

| Método y ruta | Uso |
|---|---|
| `GET /admin/reglas?empresa=` | reglas con `consumo` y `en_horario` |
| `POST /admin/reglas` | crear (`empresa_id` + campos de la tabla) |
| `PATCH /admin/reglas/:id` | cambio parcial (se combina con la regla actual y se valida) |
| `DELETE /admin/reglas/:id` | borrar |

### Reglas sobre el plan, umbral de aviso y cuenta por organización 

| Campo | Uso |
|---|---|
| `metrica: pct_plan` | % usado de la ventana del plan (dato de Anthropic o de los colectores) |
| `metrica: ritmo_plan` | % usado − % de la ventana transcurrido. Límite 10 en `7d` = cortar al ir 10 puntos sobre el ritmo |
| `ventana_tipo: plan` + `plan_ventana: 5h \| 7d` + `filtro_plan` | qué plan mira: id de `suscripciones_estado`, p. ej. `claude:alice@example.com` |
| `limite_aviso` | umbral de aviso (< `limite`): notifica sin cortar; en `limite` corta o avisa según `accion` |

- **La cuenta de Claude sale de cada llamada**, no del equipo: el proxy lee `anthropic-organization-id` de la respuesta,
  la asocia al hash del token OAuth y la traduce con `suscripcion_cuentas` (org → correo). Una regla del plan solo
  frena a quien está usando esa cuenta; con un token recién cambiado, la primera llamada siempre pasa.
- Activar o desactivar: panel → Suscripciones → «Reglas de los planes», o `PATCH /admin/reglas/:id {"activa":false}`.

## API de la vista Suscripciones

| Método y ruta | Quién | Uso |
|---|---|---|
| `POST /admin/suscripciones` | admin de la empresa (`tfa_`) | estado de una suscripción que no pasa por el proxy (Codex, Antigravity). Cuerpo: `{id:"codex:correo", empresa_id, proveedor:"chatgpt"\|"antigravity"\|"claude", cuenta, plan, equipo, ventanas:[{clave:"5h"\|"7d", nombre, usado:0..1, ventana_min, reset:epoch_s}], extra, ts}`. Ignora datos más viejos que el guardado |
| `POST /admin/autoria` | admin de la empresa | registro de autoría (quién escribió cada mensaje). Cuerpo: `{empresa_id, equipo, filas:[{sesion:uuid, ts, autor, certeza, cwd}]}` (máx. 5000). Repetidas se ignoran. Devuelve `{recibidas, guardadas}` |

Claude Max lo llena el propio proxy (cabeceras `anthropic-ratelimit-unified-*` → `suscripciones_estado` y
`suscripcion_limites`). Para otras herramientas, un colector propio puede publicar su estado en `POST /admin/suscripciones`.

### Quién usó cada llamada (sesión y autor)

- El proxy guarda en `consumos.sesion` la sesión de Claude Code de cada llamada de suscripción: cabecera
  `x-claude-code-session-id`, o `metadata.user_id` (JSON con `session_id`, o el formato viejo `…_session_<uuid>`).
  Código: `proxy/lib/sesion.mjs`.
- En un equipo con usuario compartido, un colector externo puede subir el registro de autoría a `autoria_mensajes`
  (`POST /admin/autoria`). **`v_consumo_autor`** le asigna a cada llamada el autor del último mensaje anterior de su
  sesión: respeta los traspasos entre personas. Sin mensajes humanos = «automático (agente)».
- `clientes.metadata.equipo` (nombre del equipo) y `metadata.equipo_autoria` (si tiene registro de autoría).

### Histórico anterior al gateway

`consumo_historico_suscripcion`: una fila por equipo, hora, modelo, sesión y usuario, importada de transcripts propios (importación opcional, fuera de este repo). Solo conviene cargar horas
anteriores a la primera llamada del gateway de cada equipo. Vistas: `v_suscripcion_tokens_dia` (por día) y
`v_suscripcion_historico_proyecto` (por día, equipo, proyecto, usuario y modelo; junta histórico y vivo).
Migraciones 013–019.

## Despliegue

1. Respaldo de la base y aplicar la migración **antes** de cambiar el proxy (el proxy nuevo inserta columnas nuevas):
   ```bash
   cd ~/llm-gateway
   docker compose exec -T db pg_dump -U postgres postgres > respaldo-pre-002.sql </dev/null
   docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < db/migrations/002_suscripcion_y_reglas.sql
   docker compose kill -s SIGUSR1 rest     # PostgREST relee el esquema (tabla reglas y función consumo_reglas)
   ```
2. Copiar `proxy/` y `panel/` de esta rama y reiniciar solo el proxy: `docker compose restart proxy`.
3. Ver `GET /health`: debe traer `reglas.listo: true`.

**Volver atrás:** el proxy de `master` sigue funcionando con la migración aplicada (las columnas nuevas tienen
valores por defecto). Basta volver a copiar `proxy/` y `panel/` de `master` y reiniciar el proxy.

## Configurar Claude Code (cada equipo)

1. Crear un cliente por persona o equipo (o una llave por equipo dentro del mismo cliente):
   `POST /admin/clientes {"empresa_id":"acme","nombre":"Alice · suscripción"}` → devuelve la llave `tfk_…`
   (se muestra una sola vez).
2. En `~/.claude/settings.json` del equipo:
   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://localhost:8740/suscripcion/anthropic",
       "ANTHROPIC_CUSTOM_HEADERS": "x-gw-key: tfk_…"
     }
   }
   ```
   Para probar sin tocar las otras sesiones, poner las dos variables solo en una terminal.

   **Usar una dirección de red privada (VPN o localhost), no un dominio público detrás de un CDN/túnel que termine
   el TLS:** el token OAuth de la suscripción pasaría en claro por ese intermediario.
3. Si el gateway no responde, Claude Code no conecta: quitar las dos variables vuelve al modo directo.

## Pendiente (ideas)

- Precios de los modelos Claude 5 en la tabla `precios` (hoy el equivalente queda en 0 y la métrica `costo_usd` no sirve
  para ellos; `tokens` y `llamadas` sí).
- Codex con login de ChatGPT (`/suscripcion/openai`): confirmar a qué backend habla y si respeta `chatgpt_base_url`.
- Pausa manual de un clic en el panel (hoy: desactivar el cliente, o una regla con límite 0).

## Medido (prototipo previo)

Un `claude -p "hola"` en frío escribe ~140–160 mil tokens de caché (el contexto global de Claude Code); dentro de los
5 minutos siguientes ese contexto se lee de caché. Por eso la métrica `tokens` cuenta la caché escrita y no la leída.

## Respaldo local en cada equipo (`cliente/`)

Para que una caída del gateway o de la VPN no deje a Claude Code sin conexión, cada equipo corre
`cliente/respaldo-local.mjs` en `127.0.0.1:8741` y Claude Code apunta ahí (`ANTHROPIC_BASE_URL=http://127.0.0.1:8741`,
la llave sigue en `ANTHROPIC_CUSTOM_HEADERS`).

- **Gateway arriba:** reenvía al gateway tal cual.
- **Gateway caído** (no conecta, o nginx responde 502/503/504 sin JSON): el mismo pedido sale directo a
  `api.anthropic.com` **sin** `x-gw-key`. Avisa en el log (`~/.llm-gw-respaldo/respaldo.log`), con una notificación del
  sistema (globo en Windows, `notify-send` en Linux con escritorio) y dentro de Claude Code con un hook
  `UserPromptSubmit` (`respaldo-local.mjs --aviso`). Mientras dure, **no hay registro ni reglas**.
- **Vuelta:** revisa `/health` cada 15 s; cuando responde, regresa solo al gateway y avisa.
- No guarda llaves. ~60 MB de RAM.

| Equipo | Instalar | Servicio |
|---|---|---|
| Linux | `bash cliente/instalar-linux.sh` | `systemctl --user status llm-gw-respaldo` (Restart=always) |
| Windows | `powershell -ExecutionPolicy Bypass -File cliente/instalar-windows.ps1` | arranque en la carpeta Inicio + tarea `llm-gw-respaldo` cada 5 min |

Estado: `curl http://127.0.0.1:8741/_estado`. Aviso opcional extra: `GW_RESPALDO_AVISO_CMD=<comando>` recibe el mensaje.
Volver a ir directo sin gateway: `python configurar-claude.py --desinstalar`. Pruebas: `node --test cliente/test/respaldo.test.mjs`.
