#!/usr/bin/env python3
"""Configura ~/.claude/settings.json para usar el respaldo local del llm-gateway.

  python configurar-claude.py --node <ruta node> --script <ruta respaldo-local.mjs> [--puerto 8741]
  python configurar-claude.py --desinstalar      quita el gateway y el hook: Claude Code vuelve a ir directo

Deja ANTHROPIC_BASE_URL apuntando al respaldo local y agrega un hook UserPromptSubmit que avisa en
Claude Code cuando el gateway está caído. ANTHROPIC_CUSTOM_HEADERS (la llave x-gw-key) no se toca.
Siempre respalda el archivo antes (settings.json.bak-respaldo-<fecha>).
"""
import argparse
import json
import os
import shutil
import time

MARCA = 'respaldo-local.mjs'
RUTA = os.path.expanduser('~/.claude/settings.json')


def cargar():
    with open(RUTA, encoding='utf-8-sig') as f:
        return json.load(f)


def guardar(datos):
    respaldo = f"{RUTA}.bak-respaldo-{time.strftime('%Y%m%d%H%M%S')}"
    shutil.copy2(RUTA, respaldo)
    tmp = RUTA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(datos, f, ensure_ascii=False, indent=2)
    os.replace(tmp, RUTA)
    if os.name != 'nt':
        os.chmod(RUTA, 0o600)
        os.chmod(respaldo, 0o600)
    return os.path.basename(respaldo)


def sin_hook(hooks):
    """Copia de hooks sin las entradas del respaldo local."""
    nuevos = {}
    for evento, grupos in (hooks or {}).items():
        filtrados = []
        for g in grupos:
            hs = [h for h in g.get('hooks', []) if MARCA not in h.get('command', '')]
            if hs:
                filtrados.append({**g, 'hooks': hs})
        if filtrados:
            nuevos[evento] = filtrados
    return nuevos


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--node')
    p.add_argument('--script')
    p.add_argument('--puerto', type=int, default=8741)
    p.add_argument('--desinstalar', action='store_true')
    a = p.parse_args()

    d = cargar()
    env = dict(d.get('env') or {})
    hooks = sin_hook(d.get('hooks'))

    if a.desinstalar:
        env.pop('ANTHROPIC_BASE_URL', None)
        env.pop('ANTHROPIC_CUSTOM_HEADERS', None)
        r = guardar({**d, 'env': env, 'hooks': hooks})
        print(f'desinstalado: Claude Code va directo a Anthropic | respaldo: {r}')
        return

    if not a.node or not a.script:
        p.error('faltan --node y --script')
    if 'ANTHROPIC_CUSTOM_HEADERS' not in env:
        p.error('falta ANTHROPIC_CUSTOM_HEADERS (x-gw-key) en settings.json: primero configura la llave del gateway')
    env['ANTHROPIC_BASE_URL'] = f'http://127.0.0.1:{a.puerto}'
    comando = f'"{a.node}" "{a.script}" --aviso'
    hooks.setdefault('UserPromptSubmit', []).append({'hooks': [{'type': 'command', 'command': comando, 'timeout': 5}]})
    r = guardar({**d, 'env': env, 'hooks': hooks})
    print(f'configurado: ANTHROPIC_BASE_URL={env["ANTHROPIC_BASE_URL"]} + hook de aviso | respaldo: {r}')


if __name__ == '__main__':
    main()
