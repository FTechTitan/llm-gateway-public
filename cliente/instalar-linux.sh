#!/usr/bin/env bash
# Instala el respaldo local del llm-gateway como servicio de usuario (systemd --user) y configura Claude Code.
# Requiere en el mismo directorio: respaldo-local.mjs y configurar-claude.py. Uso: bash instalar-linux.sh
set -euo pipefail
ORIGEN="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/llm-gw-respaldo"
NODE="$(command -v node || ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1 || true)"
[ -x "$NODE" ] || { echo "no encontré node"; exit 1; }

mkdir -p "$DEST" "$HOME/.config/systemd/user"
if [ "$ORIGEN" != "$DEST" ]; then cp "$ORIGEN/respaldo-local.mjs" "$ORIGEN/configurar-claude.py" "$DEST/"; fi

cat > "$HOME/.config/systemd/user/llm-gw-respaldo.service" <<EOF
[Unit]
Description=Respaldo local del llm-gateway para Claude Code
After=network-online.target

[Service]
ExecStart=$NODE $DEST/respaldo-local.mjs
Restart=always
RestartSec=3
MemoryMax=128M
Nice=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now llm-gw-respaldo.service
systemctl --user restart llm-gw-respaldo.service
for i in $(seq 1 20); do curl -fs http://127.0.0.1:8741/_estado >/dev/null 2>&1 && break; sleep 0.5; done
echo "estado: $(curl -fs http://127.0.0.1:8741/_estado)"
python3 "$DEST/configurar-claude.py" --node "$NODE" --script "$DEST/respaldo-local.mjs"
