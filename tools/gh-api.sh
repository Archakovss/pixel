#!/bin/bash
# gh-api.sh — тонкая обёртка над GitHub API для Пикселя.
# Токен читается из хранилища секретов Ядра и НЕ печатается.
# Использование: gh-api.sh GET /repos/Archakovss/pixel/git/trees/main?recursive=1
#                gh-api.sh POST /user/repos '{"name":"x","private":true}'
set -eu
METHOD="${1:-GET}"
PATHQ="${2:-}"
BODY="${3:-}"
TOKEN=$(node /root/orencode/tools/api-key-helper.mjs GITHUB_ACTIONS_PAT 2>/dev/null)
if [ -z "$TOKEN" ]; then echo "нет токена GITHUB_ACTIONS_PAT" >&2; exit 1; fi
if [ "$METHOD" = "GET" ]; then
    curl -s -H "authorization: Bearer $TOKEN" -H 'accept: application/vnd.github+json' "https://api.github.com$PATHQ"
else
    curl -s -X "$METHOD" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$BODY" "https://api.github.com$PATHQ"
fi
