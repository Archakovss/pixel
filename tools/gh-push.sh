#!/bin/bash
# gh-push.sh — пуш репозитория Пикселя на GitHub.
# Токен читается из хранилища секретов, в вывод и в аргументы не попадает.
set -eu
cd "$(dirname "$0")/.."
TOKEN=$(node /root/orencode/tools/api-key-helper.mjs GITHUB_ACTIONS_PAT 2>/dev/null)
[ -n "$TOKEN" ] || { echo "нет токена GITHUB_ACTIONS_PAT" >&2; exit 1; }
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push "https://x-access-token:${TOKEN}@github.com/Archakovss/pixel.git" "$BRANCH:$BRANCH" 2>&1 | tail -3
