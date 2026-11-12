# Contrato de API: Claude y modelos de OpenAI por Bedrock a través del llm-gateway 

> **v2:** también los modelos de OpenAI de Bedrock, en formato **OpenAI Chat Completions**. Ver §9.

> **Estado:** implementado (migración `007_bedrock.sql`, `proxy/lib/bedrock.mjs`). El
> administrador carga la credencial de AWS y pone en `bedrock` la ruta de cada cliente. Mientras un cliente tenga la
> ruta `directo` (por defecto), el mismo código va a Anthropic directo, sin cambios.

## Idea en una línea

La app **no habla con AWS**. Habla con el gateway en formato **Anthropic Messages API** y con su llave `tfk_`.
El gateway decide, por cliente, si el pedido sale a **Anthropic directo** o a **Amazon Bedrock**. Cambiar de uno a
otro es una configuración del gateway, no un cambio de código en la app.

```
app (SDK de Anthropic, llave tfk_) ──► llm-gateway ──► Anthropic directo   (ruta = directo)
                                         │  registro, reglas, presupuesto, Langfuse
                                         └──────────► Amazon Bedrock      (ruta = bedrock)
```

## 1. Endpoint y autenticación

| | |
|---|---|
| URL base (SDK) | `https://llm.example.com/anthropic` · en local: `http://localhost:8740/anthropic` |
| Endpoint | `POST /v1/messages` |
| Llave | `x-api-key: tfk_…` (o `Authorization: Bearer tfk_…`). Una llave por app o bot, nunca la llave de AWS |
| Cabeceras | `anthropic-version: 2023-06-01`, `content-type: application/json`. `anthropic-beta` opcional (ver §4) |

La app **no debe tener credenciales de AWS**. Si hoy las tiene (p. ej. `AGENTS_PROVIDER=bedrock` con `AKIA…`), se
quitan al migrar: la credencial de AWS vive solo dentro del gateway, cifrada.

## 2. Pedido

Cuerpo de la **Messages API de Anthropic**, igual que contra `api.anthropic.com`:

```json
{
  "model": "claude-haiku-4-5",
  "max_tokens": 1024,
  "system": "…",
  "messages": [{ "role": "user", "content": "Hola" }],
  "stream": true,
  "temperature": 0.2,
  "tools": [ … ],
  "metadata": { "user_id": "…" }
}
```

**`model`** acepta tres formas:

1. **Nombre de Anthropic** con fecha (`claude-haiku-4-5-20251001`) o alias (`claude-haiku-4-5`). El gateway lo
   traduce al id de Bedrock con su tabla de modelos. **Es la forma recomendada:** el mismo valor sirve con ruta
   `directo` o `bedrock`.
2. **Id o perfil de inferencia de Bedrock** (`anthropic.claude-haiku-4-5-20251001-v1:0`,
   `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `global.anthropic…`). Pasa tal cual. Solo funciona con ruta `bedrock`.
3. Si el nombre no está en la tabla ni se puede traducir: error `400 model_not_mapped` con la lista de modelos
   configurados. El administrador lo agrega en la tabla; no hay que tocar la app.

## 3. Respuesta

Idéntica a la de Anthropic, en los dos modos:

- **Sin streaming:** JSON `{"id","type":"message","role","content":[…],"stop_reason","usage":{…}}`.
- **Con `stream: true`:** SSE (`text/event-stream`) con los eventos de Anthropic: `message_start`,
  `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, y `error`.
  El gateway convierte el formato binario de AWS a este SSE: los SDK de Anthropic funcionan sin cambios.
- Cabecera de respuesta **`x-gw-ruta: directo | bedrock`**, para saber por dónde salió (solo diagnóstico).
- `usage` trae `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.

## 4. Qué funciona por Bedrock y qué no

| Función | Por Bedrock |
|---|---|
| Texto, imágenes, `system`, `stop_sequences`, `temperature`, `top_p`, `top_k` | sí |
| Tool use (`tools`, `tool_choice`) | sí |
| Streaming | sí |
| Prompt caching (`cache_control`) | sí, en los modelos que Bedrock lo soporte |
| Extended thinking | sí, en los modelos que lo soporten |
| `anthropic-beta` | se pasa a Bedrock como `anthropic_beta` en el cuerpo; si Bedrock no tiene esa beta, devuelve su error |
| `POST /v1/messages/count_tokens` | **no**: `400 not_supported_on_bedrock` |
| Files API, Message Batches, `GET /v1/models`, herramientas de servidor de Anthropic (web search, code execution) | **no** por Bedrock |

Si la app necesita algo de la segunda parte de la tabla, ese cliente se deja con ruta `directo`.

## 5. Errores

Formato de Anthropic: `{"type":"error","error":{"type":"…","message":"…"}}`. Los SDK los tratan igual que siempre.

| HTTP | `error.type` | Causa |
|---|---|---|
| 401 | `invalid_api_key` · `key_expired` | La `tfk_` no existe, está mal copiada o venció |
| 403 | `key_disabled` | Llave revocada o cliente desactivado |
| 403 | `usage_rule` | Una regla de uso del gateway lo cortó (no reintentar) |
| 429 | `budget_exceeded` | Se acabó el presupuesto mensual del cliente (no reintentar) |
| 429 | `rate_limit_error` | Bedrock limitó por cuota (`ThrottlingException`): **sí reintentar con espera**, los SDK lo hacen solos |
| 400 | `invalid_request_error` · `model_not_mapped` · `not_supported_on_bedrock` | Pedido inválido para Bedrock o modelo sin traducción |
| 403 | `permission_error` | La credencial de AWS del gateway no tiene acceso a ese modelo (falta habilitarlo en la consola de Bedrock) |
| 503 | `provider_not_configured` | El cliente está en ruta `bedrock` pero la empresa no tiene credencial de Bedrock cargada |
| 502 / 529 | `api_error` · `overloaded_error` | Falla de Bedrock o de red: reintentar con espera |

Errores a mitad de un stream llegan como evento SSE `error`.

## 6. Límites y registro

- Cada llamada queda registrada (tokens y costo en US$) con la tabla de precios de Bedrock, y cuenta para el
  **presupuesto mensual** y las **reglas de uso** del cliente, igual que por Anthropic directo.
- Las trazas a Langfuse, si el cliente las tiene activas, funcionan igual.
- **Llamadas largas:** Cloudflare corta a los 100 s las respuestas **sin streaming** (`524`). Usar `stream: true` o una
  URL que no pase por ese proxy.

## 7. Ejemplos

```python
import os, anthropic
cliente = anthropic.Anthropic(base_url="https://llm.example.com/anthropic", api_key=os.environ["LLM_GW_KEY"])
r = cliente.messages.create(model="claude-haiku-4-5", max_tokens=512, messages=[{"role": "user", "content": "Hola"}])
```

```python
# LangChain / LangGraph: reemplaza ChatBedrock / ChatBedrockConverse
from langchain_anthropic import ChatAnthropic
llm = ChatAnthropic(model="claude-haiku-4-5", base_url="https://llm.example.com/anthropic",
                    api_key=os.environ["LLM_GW_KEY"], max_tokens=1024)
```

```ts
import Anthropic from '@anthropic-ai/sdk';
const cliente = new Anthropic({ baseURL: 'https://llm.example.com/anthropic', apiKey: process.env.LLM_GW_KEY });
```

**Pasos para migrar una app que hoy usa Bedrock directo** (p. ej. un servicio de agentes de la empresa `initech`):

1. Pedir al administrador un cliente en el gateway (empresa `initech`) con su llave `tfk_` y su presupuesto, y que
   le ponga ruta `bedrock`.
2. Cambiar el cliente de Bedrock (`boto3` / `ChatBedrock` / `ChatBedrockConverse`) por el SDK de Anthropic o
   `ChatAnthropic` con la URL y la llave de arriba. Si usaba la API Converse, pasar mensajes y herramientas al
   formato Messages de Anthropic.
3. `model` con nombre de Anthropic (recomendado) o con el id de Bedrock que ya usaba.
4. Quitar las variables de AWS de la app y rotar esa llave de AWS si ya no la usa nadie más.
5. Probar una llamada con y sin streaming, y con herramientas si las usa, y revisar `x-gw-ruta: bedrock`.

## 8. Lado del administrador (para referencia)

| Qué | Cómo |
|---|---|
| Ruta de un cliente | `PATCH /admin/clientes/:id {"ruta_anthropic": "bedrock" \| "directo" \| null}` (`null` = hereda de la empresa) |
| Ruta por defecto de una empresa | `PATCH /admin/empresas/:id {"ruta_anthropic": "bedrock" \| "directo"}` (por defecto `directo`) |
| Credencial de AWS | `PUT /admin/credenciales {"empresa_id", "proveedor": "bedrock", "tipo": "api", "valor": "<JSON>"}` con `{"region": "us-east-1", "perfil": "us.", "accessKeyId": "…", "secretAccessKey": "…"}` o `{"region": "…", "perfil": "…", "apiKey": "<API key de Bedrock>"}` |
| Traducción de modelos | `GET/PUT /admin/bedrock/modelos` (nombre de Anthropic → id o perfil de Bedrock, global o por empresa) |
| Precios | tabla `precios` con `proveedor = 'bedrock'` (si falta, usa el precio de Anthropic) |

Permisos mínimos del usuario IAM del gateway: `bedrock:InvokeModel` y `bedrock:InvokeModelWithResponseStream`
sobre los modelos y perfiles de inferencia que se usen. Freno de emergencia recomendado: un AWS Budget con acción
que aplique una política IAM de denegación si el gasto de la cuenta pasa un monto.

## 9. Modelos de OpenAI por Bedrock (v2)

Mismo esquema, con el formato de OpenAI: la app usa el SDK de OpenAI contra `https://llm.example.com/openai/v1`
con su `tfk_`, y el gateway decide por cliente si sale a **OpenAI directo** o a **Bedrock** (`ruta_openai`,
independiente de `ruta_anthropic`).

| | |
|---|---|
| Endpoint | `POST /openai/v1/chat/completions` (con y sin `stream`). Bedrock acepta el cuerpo de Chat Completions tal cual en `InvokeModel` para los modelos `openai.*` y devuelve `chat.completion` / `chat.completion.chunk` |
| Streaming | SSE de OpenAI (`data: {chunk}` … `data: [DONE]`). El gateway pide `stream_options.include_usage` para contar tokens |
| Herramientas | `tools` / `tool_choice` pasan tal cual (probado con `gpt-oss-120b`) |
| No disponible | `/v1/responses`, embeddings, imágenes, audio, archivos: `400 not_supported_on_bedrock`. Si la app los usa, ese cliente queda con `ruta_openai = directo` |
| `model` | Nombre de la tabla `bedrock_modelos` (`gpt-oss-120b`, `gpt-6-luna`, `gpt-5.4`…) o el id de Bedrock tal cual (`openai.gpt-oss-120b-1:0`, `us.openai.gpt-6-luna`). Los `gpt-oss` no tienen perfil con región: van sin prefijo |
| Errores | Formato de OpenAI: `{"error":{"message","type","code"}}`, con los mismos códigos HTTP de §5 |
| Precio | Tabla `precios` con `proveedor = 'bedrock'`; si falta, usa el de OpenAI del mismo modelo (sin el prefijo de Bedrock) |

Administración: `PATCH /admin/clientes/:id {"ruta_openai": "bedrock" | "directo" | null}` y
`PATCH /admin/empresas/:id {"ruta_openai": "bedrock" | "directo"}`. La credencial de Bedrock es la misma de §8; el
usuario IAM necesita además `bedrock:InvokeModel*` sobre `foundation-model/openai.*` y los perfiles `us.openai.*`.

**Acceso en AWS:** cada modelo nuevo de un proveedor (GPT-5.x/6.x, Claude 5.5) exige aceptar su oferta en
Marketplace, y además AWS puede tenerlo restringido para la cuenta («is not available for this account») aunque la
oferta esté aceptada y la cuota sea mayor que 0; eso se levanta con un caso de soporte. Los `gpt-oss` no tienen esa
restricción.
