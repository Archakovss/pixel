#!/bin/bash
# tw-api.sh — пробы Timeweb API токеном из хранилища секретов.
# Токен не печатается и в аргументы не попадает.
set -u
TOKEN=*** /root/orencode/tools/api-key-helper.mjs TIMEWEB_TOKEN 2>/dev/null)
[ -n "$TOKEN" ] || { echo "нет TIMEWEB_TOKEN в секретах"; exit 1; }

probe() { # probe <метод> <путь> [тело]
    local m="$1" p="$2" body="${3:-}" out code
    if [ -n "$body" ]; then
        out=$(curl -s -m 15 -X "$m" "https://api.timeweb.cloud/api/v1$p" \
            -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body" -w '\n%{http_code}' 2>/dev/null)
    else
        out=$(curl -s -m 15 -X "$m" "https://api.timeweb.cloud/api/v1$p" \
            -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}' 2>/dev/null)
    fi
    code=$(printf '%s' "$out" | tail -1)
    printf '%-6s %-42s → %s  %s\n' "$m" "$p" "$code" "$(printf '%s' "$out" | head -c 160 | tr '\n' ' ')"
}

probe GET /accounts
probe GET /domains
probe GET "/domains/friday.com.ru"
probe GET "/domains/friday.com.ru/dns-records"
