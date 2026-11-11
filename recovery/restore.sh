#!/bin/bash
# restore.sh — подъём Ядра по карточке Армагеддона (этап P2, скелет).
#
# Сейчас: проверяет готовность машины и показывает порядок шагов.
# Дальше: реальные действия по шагам регламента (recovery/ARMAGEDDON-LLM.md).
#
# Принцип: идемпотентность. Повторный запуск не должен ломать сделанное.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
step() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "✖ нет $1 — установи: $2"; return 1; }; }

step "0. Осмотр машины"
missing=0
for pair in "node:nodejs npm" "python3:python3" "curl:curl" "git:git" "psql:postgresql" "nginx:nginx"; do
    name="${pair%%:*}"; pkg="${pair#*:}"
    need "$name" "apt install $pkg" || missing=1
done
[ "$missing" = "1" ] && { echo; echo "Есть красные пункты — дальше нельзя. Установи и повтори."; exit 1; }

step "1. Ключ провайдера"
KEY="${PIXEL_PROVIDER_KEY:-$HOME/.pixel/provider.key}"
if [ ! -r "$KEY" ]; then
    echo "✖ нет ключа: $KEY"
    echo "  положи ключ в файл (chmod 600) — без него Пиксель не думает"
    exit 1
fi
echo "✔ ключ на месте"

step "2. Снимок"
echo "Нужен самый свежий ЦЕЛЫЙ снимок и пароль расшифровки."
echo "Список: aws --endpoint-url=https://storage.yandexcloud.net s3 ls s3://<bucket>/dr/"
echo "Манифест не сходится → брать предыдущий, а не «попробовать так»."

step "3. Порядок (не переставлять)"
cat <<'TXT'
  4. База: роль → БД → restore дампа → сверка счётчиков
  5. Код: git clone → npm ci → pm2 start → pm2 save → pm2 startup
  6. Сайт: nginx-конфиги → nginx -t → reload → certbot
  7. Приёмка: /health ok, панель, один клиентский сайт, бот
TXT

step "Готово к ручному продолжению"
echo "Полный регламент: $HERE/ARMAGEDDON-LLM.md (для агента), ARMAGEDDON-HUMAN.md (для человека)."
