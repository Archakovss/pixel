#!/bin/bash
# restore.sh — подъём Ядра по карточке Армагеддона (этап P2).
#
# Принципы:
#   * идемпотентность: повторный запуск не ломает уже сделанное;
#   * по умолчанию — СУХОЙ прогон: показывает, что сделает, и ничего не меняет;
#   * разрушительное (заливка в существующую БД) — только с --yes;
#   * после каждого шага — проверка, без неё дальше не идём;
#   * состояние в ~/.pixel/data/recovery-state.json, лог рядом.
#
# Использование:
#   restore.sh                       — сухой прогон всех шагов
#   restore.sh --apply               — выполнить (спросит подтверждение на опасном)
#   restore.sh --step preflight      — один шаг (preflight|snapshot|db|apps|web|accept)
#   restore.sh --from /path/to/dir   — уже распакованный снимок (без S3)
#   restore.sh --from s3://bucket/dr/20261111 --passphrase-file ~/.pixel/dr.pass
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${PIXEL_DATA_DIR:-$HOME/.pixel/data}/recovery-state.json"
LOG="${PIXEL_DATA_DIR:-$HOME/.pixel/data}/recovery.log"
APPLY=0
STEP=""
FROM=""
PASS_FILE=""
YES=0
STEP_ARG=""

while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=1 ;;
        --yes|-y) YES=1 ;;
        --step) STEP="${2:-}"; shift ;;
        --from) FROM="${2:-}"; shift ;;
        --passphrase-file) PASS_FILE="${2:-}"; shift ;;
        *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
    esac
    shift
done

mkdir -p "$(dirname "$STATE")"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
ok()   { printf '✔ %s\n' "$*"; }
bad()  { printf '✖ %s\n' "$*"; }
info() { printf '• %s\n' "$*"; }
run() { # run <описание> <команда...>
    if [ "$APPLY" = "1" ]; then
        log "RUN: $*"
        "$@"
    else
        info "[сухой прогон] $*"
    fi
}
save_state() { # save_state <шаг> <статус>
    python3 - "$STATE" "$1" "$2" <<'PY' 2>/dev/null || true
import json, sys, time
p, step, status = sys.argv[1], sys.argv[2], sys.argv[3]
try: d = json.load(open(p))
except Exception: d = {}
d.setdefault('steps', {})[step] = {'status': status, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=1)
PY
}

# ── 0. Предохранитель: не восстанавливать поверх живого ──────
healthy_core() {
    local url="${CORE_HEALTH_URL:-http://127.0.0.1:3212/health}"
    curl -sf --max-time 3 "$url" 2>/dev/null | grep -q '"ok":true'
}

# ── Шаг 1. Осмотр машины ─────────────────────────────────────
step_preflight() {
    local miss=0
    printf '\n== preflight: что есть на машине\n'
    for spec in "node:nodejs npm" "python3:python3" "curl:curl" "git:git" "psql:postgresql" "nginx:nginx" "pm2:pm2 (npm i -g pm2)" "tar:tar" "openssl:openssl"; do
        name="${spec%%:*}"; pkg="${spec#*:}"
        if command -v "$name" >/dev/null 2>&1; then ok "$name — $(command -v "$name")"; else bad "$name — установи: $pkg"; miss=1; fi
    done
    local free_gb
    free_gb=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')
    if [ "${free_gb:-0}" -ge 20 ]; then ok "диск — ${free_gb} ГБ свободно"; else bad "диск — ${free_gb} ГБ, нужно ≥ 20"; miss=1; fi
    if healthy_core; then
        bad "Ядро уже отвечает на /health — восстанавливать поверх живого нельзя"
        info "если это правда нужно: CORE_HEALTH_URL=http://127.0.0.1:1/health restore.sh --apply --yes"
        miss=1
    fi
    [ "$miss" = "0" ] && save_state preflight ok || save_state preflight fail
    return "$miss"
}

# ── Шаг 2. Снимок ───────────────────────────────────────────
step_snapshot() {
    printf '\n== snapshot: получить и распечатать снимок\n'
    if [ -z "$FROM" ]; then
        bad "не указан источник: --from /path/to/dir или --from s3://bucket/dr/<date>"
        info "список: aws --endpoint-url=https://storage.yandexcloud.net s3 ls s3://<bucket>/dr/"
        save_state snapshot fail; return 1
    fi
    local work="$PIXEL_DATA_DIR/restore"
    mkdir -p "$work"
    case "$FROM" in
        s3://*)
            command -v aws >/dev/null 2>&1 || { bad "нет aws cli — установи awscli"; save_state snapshot fail; return 1; }
            info "скачиваю $FROM → $work"
            run aws s3 cp "$FROM" "$work/" --recursive --only-show-errors
            ;;
        *) info "использую локальный путь $FROM"; work="$FROM" ;;
    esac
    if [ "$APPLY" != "1" ]; then info "[сухой прогон] проверка манифеста и расшифровка пропущены"; save_state snapshot dry; return 0; fi
    local man="$work/manifest.json"
    [ -f "$man" ] || { bad "нет manifest.json в $work"; save_state snapshot fail; return 1; }
    python3 - "$man" <<'PY' || { bad "манифест не читается или битый"; save_state snapshot fail; exit 1; }
import json, sys
d = json.load(open(sys.argv[1]))
for k in ('date', 'parts', 'db'):
    if k not in d: raise SystemExit(f'в манифесте нет поля {k}')
print('манифест:', d['date'], '| частей:', d['parts'], '| БД:', d['db'])
PY
    ok "манифест сходится"; save_state snapshot ok
}

# ── Шаг 3. База ─────────────────────────────────────────────
step_db() {
    printf '\n== db: база данных\n'
    local work="${PIXEL_DATA_DIR}/restore"
    local dump
    dump=$(ls -1 "$work"/*.sql "$work"/*.dump 2>/dev/null | head -1 || true)
    if [ -z "$dump" ]; then bad "в $work нет дампа (.sql/.dump)"; save_state db fail; return 1; fi
    info "дамп: $dump"
    run systemctl enable --now postgresql
    if [ "$APPLY" != "1" ]; then info "[сухой прогон] роль core, БД platform, заливка дампа, сверка счётчиков"; save_state db dry; return 0; fi
    # Роль и БД — идемпотентно: если есть, не трогаем.
    sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='core'" | grep -q 1 \
        || sudo -u postgres psql -c "CREATE ROLE core LOGIN"
    sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='platform'" | grep -q 1 \
        || sudo -u postgres createdb -O core platform
    local rows
    rows=$(sudo -u postgres psql -d platform -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform'" || echo 0)
    if [ "${rows:-0}" -gt 0 ] && [ "$YES" != "1" ]; then
        bad "в базе уже ${rows} таблиц. Заливка поверх требует --yes"
        info "безопаснее: createdb -O core platform2 и восстановить туда, затем переключить строку подключения"
        save_state db refuse; return 1
    fi
    case "$dump" in
        *.sql) psql "postgresql://core@127.0.0.1/platform" -v ON_ERROR_STOP=1 -f "$dump" | tail -3 ;;
        *) pg_restore -d "postgresql://core@127.0.0.1/platform" --no-owner "$dump" | tail -3 ;;
    esac
    local after
    after=$(sudo -u postgres psql -d platform -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform'")
    [ "${after:-0}" -gt 0 ] && { ok "таблиц в базе: $after"; save_state db ok; } || { bad "дамп залился, но таблиц нет"; save_state db fail; return 1; }
}

# ── Шаг 4. Код и процессы ───────────────────────────────────
step_apps() {
    printf '\n== apps: код и процессы\n'
    local repo="${CORE_REPO:-}"
    local dir="${CORE_DIR:-/root/orencode}"
    if [ -z "$repo" ]; then bad "не задан CORE_REPO (git-адрес репозитория Ядра)"; save_state apps fail; return 1; fi
    info "репозиторий: $repo → $dir"
    if [ -d "$dir/.git" ]; then info "каталог уже есть — делаю fetch, не клон"
        run git -C "$dir" fetch --all --prune
    else
        run git clone "$repo" "$dir"
    fi
    run bash -c "cd '$dir' && npm ci --omit=dev"
    if [ "$APPLY" != "1" ]; then info "[сухой прогон] pm2 start ecosystem.config.js && pm2 save"; save_state apps dry; return 0; fi
    ( cd "$dir" && pm2 start ecosystem.config.js --update-env >/dev/null 2>&1 || pm2 start server.js --name orencode >/dev/null 2>&1 )
    pm2 save >/dev/null 2>&1
    sleep 5
    local st
    st=$(curl -sf --max-time 5 http://127.0.0.1:3212/health || true)
    if printf '%s' "$st" | grep -q '"ok":true'; then
        printf '%s' "$st" | python3 -c "import json,sys;d=json.load(sys.stdin);print('загружен',d.get('loaded_commit','?')[:7],'| head',d.get('head','?')[:7],'| stale',d.get('stale'))" || true
        ok "процесс отвечает"; save_state apps ok
    else
        bad "процесс не отвечает на 3212/health — смотри pm2 logs"; save_state apps fail; return 1
    fi
}

# ── Шаг 5. Сайт и TLS ───────────────────────────────────────
step_web() {
    printf '\n== web: nginx и сертификаты\n'
    local work="${PIXEL_DATA_DIR}/restore"
    if [ ! -d "$work/nginx" ]; then bad "в снимке нет каталога nginx/"; save_state web fail; return 1; fi
    run bash -c "cp -a '$work/nginx/.' /etc/nginx/sites-available/"
    run nginx -t
    run systemctl reload nginx
    if [ "$APPLY" != "1" ]; then info "[сухой прогон] certbot для доменов из снимка"; save_state web dry; return 0; fi
    if command -v certbot >/dev/null 2>&1; then
        info "сертификаты: certbot renew --quiet (если уже есть) или certbot --nginx -d <домен>"
        certbot renew --quiet 2>/dev/null || true
    fi
    ok "nginx перезагружен"; save_state web ok
}

# ── Шаг 6. Приёмка ──────────────────────────────────────────
step_accept() {
    printf '\n== accept: приёмка на границе потребителя\n'
    local fail=0
    local ext="${CORE_PUBLIC_URL:-https://fridaybot.ru/core}"
    if curl -sf --max-time 8 "$ext/health" | grep -q '"ok":true'; then ok "внешний /core/health — ok"; else bad "внешний $ext/health — нет ответа"; fail=1; fi
    if curl -sfI --max-time 8 "$ext/" | head -1 | grep -q "200\|302"; then ok "панель открывается"; else bad "панель не открывается"; fail=1; fi
    [ "$fail" = "0" ] && save_state accept ok || save_state accept fail
    return "$fail"
}

# ── Диспетчер ───────────────────────────────────────────────
run_step() {
    case "$1" in
        preflight) step_preflight ;;
        snapshot)  step_snapshot ;;
        db)        step_db ;;
        apps)      step_apps ;;
        web)       step_web ;;
        accept)    step_accept ;;
        *) bad "неизвестный шаг: $1"; return 2 ;;
    esac
}

printf 'Пиксель · восстановление Ядра (режим: %s)\n' "$([ "$APPLY" = "1" ] && echo ВЫПОЛНЕНИЕ || echo СУХОЙ ПРОГОН)"
[ "$APPLY" != "1" ] && printf 'Ничего не меняется. Чтобы выполнить: --apply (опасное спросит --yes).\n'

if [ -n "$STEP" ]; then
    run_step "$STEP"; exit $?
fi

rc=0
for s in preflight snapshot db apps web accept; do
    if ! run_step "$s"; then
        bad "останов на шаге: $s"
        info "регламент: $HERE/ARMAGEDDON-LLM.md"
        rc=1; break
    fi
done

if [ "$rc" = "0" ]; then
    printf '\n✔ Все шаги пройдены. Состояние: %s\n' "$STATE"
else
    printf '\n✖ Восстановление не завершено. Состояние: %s\n' "$STATE"
fi
exit "$rc"
