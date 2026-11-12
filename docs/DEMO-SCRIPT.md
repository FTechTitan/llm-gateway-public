# Demo script (screenshots / GIF still pending)

Captures need a browser; they were left as a script so they can be recorded in 3 minutes against a fresh stack.

1. `docker compose up -d` and open `http://localhost:8740/panel/` (log in with the user created via `POST /admin/usuarios`).
2. **Consumption view** — send ~20 calls with two different `tfk_` keys (`curl` loop, one OpenAI model and one Anthropic model). Screenshot: daily chart + per-client table. → `docs/img/panel-consumo.png`
3. **Keys view** — create a client with a US$ 5 budget and an expiry date; show the key being displayed once. → `docs/img/panel-llaves.png`
4. **Rules view** — create the rule `"tokens" > 2000 / rolling 5 h → cortar`, then repeat a call until the `403 usage_rule` appears. GIF: terminal on the left, panel bar filling on the right. → `docs/img/regla-corta.gif`
5. **Bedrock route** (needs AWS creds) — `PATCH /admin/clientes/:id {"ruta_anthropic":"bedrock"}` and show the `x-gw-ruta: bedrock` response header. → optional.

When recorded, add them to the README under "What it does" with `![panel](docs/img/panel-consumo.png)`.
