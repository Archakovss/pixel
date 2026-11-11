#!/bin/bash
# install.sh — поставить Пикселя на машину (сервер Ядра, чужой сервер, ноутбук).
#
# Что делает: проверяет node, создаёт ~/.pixel, кладёт конфиг из примера,
# ставит симлинк в PATH. Ничего не перезаписывает молча.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PIXEL_HOME="${PIXEL_HOME:-$HOME/.pixel}"
BIN_TARGET="${PIXEL_BIN:-/usr/local/bin}"

say() { printf '%s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
    say "✖ node не найден. Нужен Node.js 20+ (для Debian: apt install nodejs npm)"
    exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
    say "✖ node $(node -v) — нужен 20 или новее"
    exit 1
fi
say "✔ node $(node -v)"

if ! command -v python3 >/dev/null 2>&1; then
    say "✖ python3 не найден — он нужен обёртке pixel для чтения конфига"
    exit 1
fi

mkdir -p "$PIXEL_HOME/data"
chmod 700 "$PIXEL_HOME"

if [ -f "$PIXEL_HOME/config.json" ]; then
    say "• конфиг уже есть: $PIXEL_HOME/config.json (не трогаю)"
else
    sed "s|\"~/.pixel|\"$PIXEL_HOME|g" "$HERE/config.example.json" > "$PIXEL_HOME/config.json"
    chmod 600 "$PIXEL_HOME/config.json"
    say "✔ конфиг создан: $PIXEL_HOME/config.json"
fi

if [ ! -f "$PIXEL_HOME/provider.key" ]; then
    say "• нет ключа провайдера: положи его в $PIXEL_HOME/provider.key (chmod 600)"
    say "  без ключа Пиксель работает только пока жив шлюз Ядра"
fi

mkdir -p "$BIN_TARGET" 2>/dev/null || true
ln -sf "$HERE/bin/pixel" "$BIN_TARGET/pixel" 2>/dev/null && say "✔ команда: $BIN_TARGET/pixel" || say "• симлинк не создан — запускай $HERE/bin/pixel"

say ""
say "Дальше:"
say "  pixel doctor          — чего не хватает на этой машине"
say "  pixel                 — терминал"
say "  recovery/ARMAGEDDON-HUMAN.md — инструкция по подъёму Ядра"
