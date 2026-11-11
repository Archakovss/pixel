#!/bin/bash
# install.sh — установка Пикселя одной строкой:
#
#   curl -fsSL https://raw.githubusercontent.com/Archakovss/pixel/main/install.sh | bash
#
# Работает и из клонированного каталога (./install.sh).
# Показывает шаги и результат каждого, как обычный установщик.
set -u

REPO="Archakovss/pixel"
BRANCH="${PIXEL_BRANCH:-main}"
PIXEL_HOME="${PIXEL_HOME:-$HOME/.pixel}"
APP_DIR="$PIXEL_HOME/app"
BIN_TARGET="${PIXEL_BIN:-/usr/local/bin}"

C_OK=$'\033[0;32m'; C_BAD=$'\033[0;31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_R=$'\033[0m'

ok()   { printf '   %s✓%s %s\n' "$C_OK" "$C_R" "$*"; }
bad()  { printf '   %s✗%s %s\n' "$C_BAD" "$C_R" "$*"; }
note() { printf '   %s•%s %s\n' "$C_DIM" "$C_R" "$*"; }

printf '\n%s┌────────────────────────────────────┐%s\n' "$C_B" "$C_R"
printf '%s│  Пиксель · установка               │%s\n' "$C_B" "$C_R"
printf '%s└────────────────────────────────────┘%s\n' "$C_B" "$C_R"

# ── 1/4 · проверки ──────────────────────────────────────────
printf '\n%s[1/4]%s Проверяю машину\n' "$C_B" "$C_R"
fail=0
if command -v node >/dev/null 2>&1; then
    v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "${v:-0}" -ge 20 ]; then ok "node $(node -v)"; else bad "node $(node -v) — нужен 20+"; fail=1; fi
else
    bad "node не найден — поставь nodejs (apt install nodejs npm)"; fail=1
fi
for t in curl git python3; do
    if command -v "$t" >/dev/null 2>&1; then ok "$t"; else bad "$t не найден"; fail=1; fi
done
if [ "$fail" = "1" ]; then
    printf '\n%sУстановка остановлена.%s Поставь недостающее и запусти снова.\n\n' "$C_BAD" "$C_R"
    exit 1
fi

# ── 2/4 · файлы ─────────────────────────────────────────────
printf '\n%s[2/4]%s Кладу файлы\n' "$C_B" "$C_R"
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/bin/pixel" ]; then
    SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    note "из локального каталога: $SRC_DIR"
else
    note "скачиваю пакет: $REPO@$BRANCH"
    tmp="$(mktemp -d)"
    if ! curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar xz -C "$tmp" 2>/dev/null; then
        bad "не удалось скачать пакет — проверь сеть"
        exit 1
    fi
    SRC_DIR="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -1)"
fi
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/bin" "$APP_DIR/recovery"
cp -a "$SRC_DIR/bin" "$SRC_DIR/recovery" "$SRC_DIR/config.example.json" "$APP_DIR/" 2>/dev/null
chmod +x "$APP_DIR/bin/pixel" "$APP_DIR/bin/pixel.mjs" "$APP_DIR/recovery/restore.sh" 2>/dev/null
[ -n "${tmp:-}" ] && rm -rf "$tmp"
if [ -x "$APP_DIR/bin/pixel" ]; then ok "движок: $APP_DIR/bin/pixel"; else bad "файлы не разложились"; exit 1; fi

# ── 3/4 · конфиг ────────────────────────────────────────────
printf '\n%s[3/4]%s Готовлю конфиг\n' "$C_B" "$C_R"
mkdir -p "$PIXEL_HOME/data"; chmod 700 "$PIXEL_HOME" 2>/dev/null
if [ -f "$PIXEL_HOME/config.json" ]; then
    note "уже есть, не трогаю: $PIXEL_HOME/config.json"
else
    sed "s|\"~/.pixel|\"$PIXEL_HOME|g" "$APP_DIR/config.example.json" > "$PIXEL_HOME/config.json"
    chmod 600 "$PIXEL_HOME/config.json"
    ok "создан $PIXEL_HOME/config.json"
fi
if [ -f "$PIXEL_HOME/provider.key" ]; then
    ok "ключ провайдера на месте"
else
    note "ключа нет: положи в $PIXEL_HOME/provider.key (chmod 600)"
    note "без него Пиксель живёт только пока жив шлюз Ядра"
fi

# ── 4/4 · команда ───────────────────────────────────────────
printf '\n%s[4/4]%s Ставлю команду pixel\n' "$C_B" "$C_R"
if ln -sf "$APP_DIR/bin/pixel" "$BIN_TARGET/pixel" 2>/dev/null; then
    ok "$BIN_TARGET/pixel"
else
    mkdir -p "$HOME/.local/bin"
    ln -sf "$APP_DIR/bin/pixel" "$HOME/.local/bin/pixel" && ok "$HOME/.local/bin/pixel (добавь в PATH)"
fi

printf '\n%s✓ Готово.%s Дальше:\n' "$C_OK" "$C_R"
printf '   pixel doctor     %s— чего не хватает на машине%s\n' "$C_DIM" "$C_R"
printf '   pixel            %s— терминал%s\n' "$C_DIM" "$C_R"
printf '   pixel recover    %s— подъём Ядра по карточке%s\n' "$C_DIM" "$C_R"
printf '   %sИнструкция: recovery/ARMAGEDDON-HUMAN.md%s\n\n' "$C_DIM" "$C_R"
