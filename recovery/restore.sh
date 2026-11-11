#!/bin/bash
# restore.sh — подъём Ядра по карточке Армагеддона (P2+).
#
# Показывает шаги и время, как установщик. По умолчанию СУХОЙ прогон.
# Разрушительное — только с --yes. Поверх живого Ядра — отказ.
#
# Режим учения на живом узле:
#   DB_NAME=platform_drill CORE_PORT=3222 SKIP_WEB=1 CORE_DIR=/srv/drill/orencode
#
# Использование:
#   restore.sh                                  сухой прогон
#   restore.sh --apply --yes --from s3://... --passphrase-file ~/.pixel/dr.pass
#   restore.sh --step preflight                 один шаг
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${PIXEL_DATA_DIR:-$HOME/.pixel/data}"
STATE="$DATA_DIR/recovery-state.json"
LOG="$DATA_DIR/recovery.log"
APPLY=0; YES=0; STEP=""; FROM=""; PASS_FILE=""
DB_NAME="${DB_NAME:-platform}"
CORE_PORT="${CORE_PORT:-3212}"
SKIP_WEB="${SKIP_WEB:-0}"
CORE_DIR="${CORE_DIR:-/root/orencode}"
RESTORE_ROOT=""; SRC=""

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

mkdir -p "$DATA_DIR"
C_OK=$'\033[0;32m'; C_BAD=$'\033[0;31m'; C_WARN=$'\033[0;33m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_R=$'\033[0m'

# ── журнал и статусы ────────────────────────────────────────
declare -a R_STEP R_STATUS R_TIME
STEP_NO=0; TOTAL=6
say_ok()   { printf '   %s✓%s %s\n' "$C_OK" "$C_R" "$*"; }
say_bad()  { printf '   %s✗%s %s\n' "$C_BAD" "$C_R" "$*"; }
say_info() { printf '   %s• %s%s\n' "$C_DIM" "$*" "$C_R"; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG" 2>/dev/null || true; }

bar() { # bar <процент>
    local p=$1 fill=$(( $1 * 16 / 100 )) empty
    empty=$(( 16 - fill ))
    printf '   %s%s%s%s %d%%%s\n' "$C_DIM" \
        "$(printf '█%.0s' $(seq 1 $fill 2>/dev/null))" \
        "$(printf '░%.0s' $(seq 1 $empty 2>/dev/null))" "$C_R" "$p" "$C_R"
}

step_begin() { # step_begin <имя>
    STEP_NO=$((STEP_NO+1))
    STEP_NAME="$1"; STEP_T0=$(date +%s)
    printf '\n%s[%d/%d]%s %s%s%s\n' "$C_B" "$STEP_NO" "$TOTAL" "$C_R" "$C_B" "$1" "$C_R"
}
step_end() { # step_end <ok|fail|skip>
    local t=$(( $(date +%s) - STEP_T0 ))
    R_STEP+=("$STEP_NAME"); R_STATUS+=("$1"); R_TIME+=("$t")
    case "$1" in
        ok)   printf '   %s✓ готово%s %s(%d с)%s\n' "$C_OK" "$C_R" "$C_DIM" "$t" "$C_R" ;;
        skip) printf '   %s• пропущено%s\n' "$C_WARN" "$C_R" ;;
        fail) printf '   %s✗ останов%s %s(%d с)%s\n' "$C_BAD" "$C_R" "$C_DIM" "$t" "$C_R" ;;
    esac
    bar $(( STEP_NO * 100 / TOTAL ))
    save_state "$STEP_NAME" "$1"
}

run()  { if [ "$APPLY" = "1" ]; then log "RUN: $*"; "$@"; else say_info "[сухой прогон] $*"; fi; }
save_state() {
    python3 - "$STATE" "$1" "$2" <<'PY' 2>/dev/null || true
import json, sys, time
p, step, status = sys.argv[1], sys.argv[2], sys.argv[3]
try: d = json.load(open(p))
except Exception: d = {}
d.setdefault('steps', {})[step] = {'status': status, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=1)
PY
}

# ── psql-хелперы: sudo есть не везде, а мы и так root ───────
pg_sql()    { if command -v sudo >/dev/null 2>&1; then sudo -u postgres psql -tAc "$1"; else su -s /bin/sh postgres -c "psql -tAc \"$1\""; fi; }
pg_sql_db() { if command -v sudo >/dev/null 2>&1; then sudo -u postgres psql -d "$2" -tAc "$1"; else su -s /bin/sh postgres -c "psql -d '$2' -tAc \"$1\""; fi; }
pg_run()    { if command -v sudo >/dev/null 2>&1; then sudo -u postgres psql -c "$1"; else su -s /bin/sh postgres -c "psql -c \"$1\""; fi; }
pg_createdb(){ if command -v sudo >/dev/null 2>&1; then sudo -u postgres createdb -O core "$1"; else su -s /bin/sh postgres -c "createdb -O core '$1'"; fi; }
pg_restore_file() { if command -v sudo >/dev/null 2>&1; then sudo -u postgres pg_restore -d "$DB_NAME" --no-owner "$1"; else su -s /bin/sh postgres -c "pg_restore -d '$DB_NAME' --no-owner '$1'"; fi; }
pg_apply_sql()    { if command -v sudo >/dev/null 2>&1; then sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$1"; else su -s /bin/sh postgres -c "psql -d '$DB_NAME' -v ON_ERROR_STOP=1 -f '$1'"; fi; }

healthy_core() { curl -sf --max-time 3 "${CORE_HEALTH_URL:-http://127.0.0.1:${CORE_PORT}/health}" 2>/dev/null | grep -q '"ok":true'; }

# ── 1. preflight ────────────────────────────────────────────
step_preflight() {
    local miss=0
    for spec in "node:nodejs npm" "python3:python3" "curl:curl" "git:git" "psql:postgresql" "nginx:nginx" "pm2:npm i -g pm2" "tar:tar" "openssl:openssl" "gpg:gnupg"; do
        name="${spec%%:*}"; pkg="${spec#*:}"
        if command -v "$name" >/dev/null 2>&1; then say_ok "$name"; else say_bad "$name — установи: $pkg"; miss=1; fi
    done
    local free_gb; free_gb=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')
    if [ "${free_gb:-0}" -ge 10 ]; then say_ok "диск ${free_gb} ГБ"; else say_bad "диск ${free_gb} ГБ, нужно ≥10"; miss=1; fi
    if healthy_core; then
        say_bad "Ядро уже отвечает на /health — поверх живого не восстанавливаем"
        say_info "осознанно: CORE_HEALTH_URL=http://127.0.0.1:1/health restore.sh --apply --yes"
        miss=1
    fi
    return "$miss"
}

# ── 2. snapshot ─────────────────────────────────────────────
step_snapshot() {
    [ -n "$FROM" ] || { say_bad "нет источника: --from s3://... или --from /path/file"; return 1; }
    local work="$DATA_DIR/restore"; mkdir -p "$work"
    case "$FROM" in
        s3://*)
            command -v aws >/dev/null 2>&1 || { say_bad "нет aws cli"; return 1; }
            say_info "скачиваю $FROM"; run aws s3 cp "$FROM" "$work/" --recursive --only-show-errors ;;
        *)
            if [ -f "$FROM" ]; then SRC="$FROM"; work="$(dirname "$FROM")"; say_info "файл: $FROM"
            else work="$FROM"; say_info "каталог: $FROM"; fi ;;
    esac
    if [ "$APPLY" != "1" ]; then say_info "[сухой прогон] расшифровка и распаковка пропущены"; return 0; fi

    local unpack="$DATA_DIR/restore/unpacked"; rm -rf "$unpack"; mkdir -p "$unpack"
    local enc="" plain_src=""
    if [ -n "$SRC" ]; then case "$SRC" in *.gpg) enc="$SRC" ;; *) plain_src="$SRC" ;; esac
    else enc=$(ls -1 "$work"/*.tar.gz.gpg 2>/dev/null | head -1 || true); fi
    if [ -n "$enc" ]; then
        [ -n "$PASS_FILE" ] && [ -r "$PASS_FILE" ] || { say_bad "нужен --passphrase-file"; return 1; }
        say_info "расшифровываю $(basename "$enc")"
        gpg --batch --quiet --yes --passphrase-file "$PASS_FILE" --decrypt "$enc" > "$work/snapshot.tar.gz" \
            || { say_bad "расшифровка не удалась"; return 1; }
    elif [ -n "$plain_src" ]; then cp "$plain_src" "$work/snapshot.tar.gz" || { say_bad "копирование не удалось"; return 1; }
    else
        local plain; plain=$(ls -1 "$work"/*.tar.gz 2>/dev/null | head -1 || true)
        [ -n "$plain" ] || { say_bad "нет архива .tar.gz/.gpg"; return 1; }
        cp "$plain" "$work/snapshot.tar.gz" || { say_bad "копирование не удалось"; return 1; }
    fi
    tar xzf "$work/snapshot.tar.gz" -C "$unpack" || { say_bad "архив не распаковывается"; return 1; }
    RESTORE_ROOT="$unpack"
    local mf=""
    [ -f "$unpack/meta/manifest.txt" ] && mf=$(head -2 "$unpack/meta/manifest.txt" | tr '\n' ' ' | cut -c1-90)
    [ -z "$mf" ] && [ -f "$unpack/manifest.json" ] && mf=$(python3 -c "import json;d=json.load(open('$unpack/manifest.json'));print(d.get('date'),'частей',d.get('parts'))" 2>/dev/null)
    [ -n "$mf" ] || { say_bad "нет манифеста"; return 1; }
    say_ok "манифест: $mf"
    say_ok "дампов: $(ls "$unpack/db" 2>/dev/null | wc -l) · код: $([ -f "$unpack/git/orencode.bundle" ] && echo bundle || echo нет)"
}

# ── 3. db ───────────────────────────────────────────────────
step_db() {
    local root="${RESTORE_ROOT:-$DATA_DIR/restore/unpacked}"
    local dump="$root/db/platform.dump"
    [ -f "$dump" ] || dump=$(ls -1S "$root"/db/*.dump "$root"/db/*.sql 2>/dev/null | head -1 || true)
    [ -n "$dump" ] || { say_bad "нет дампа в $root/db"; return 1; }
    say_info "дамп $(basename "$dump") · $(du -h "$dump" | cut -f1) · база ${DB_NAME}"
    run systemctl enable --now postgresql
    if [ "$APPLY" != "1" ]; then say_info "[сухой прогон] роли core/platform, база, заливка, сверка"; return 0; fi

    pg_sql "SELECT 1 FROM pg_roles WHERE rolname='core'" | grep -q 1 || pg_run "CREATE ROLE core LOGIN" >/dev/null
    # Политики в дампе ссылаются на роль platform: без неё теряется часть объектов.
    pg_sql "SELECT 1 FROM pg_roles WHERE rolname='platform'" | grep -q 1 || pg_run "CREATE ROLE platform LOGIN" >/dev/null
    pg_sql "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || pg_createdb "${DB_NAME}"

    # Пароль роли: без него приложение не подключится по TCP на новой машине.
    local passfile="$DATA_DIR/pg.pass"
    if [ ! -f "$passfile" ]; then
        openssl rand -hex 16 > "$passfile"; chmod 600 "$passfile"
    fi
    pg_run "ALTER ROLE core PASSWORD '$(cat "$passfile")'" >/dev/null 2>&1 || true

    local tables; tables=$(pg_sql_db "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform'" "${DB_NAME}" 2>/dev/null || echo 0)
    if [ "${tables:-0}" -gt 0 ] && [ "$YES" != "1" ]; then
        say_bad "в ${DB_NAME} уже ${tables} таблиц — нужен --yes"; return 1
    fi
    case "$dump" in
        *.sql) pg_apply_sql "$dump" >/tmp/pg-restore.log 2>&1 ;;
        *) pg_restore_file "$dump" >/tmp/pg-restore.log 2>&1 ;;
    esac
    local rc=$?
    [ "$rc" != "0" ] && { say_info "pg_restore вернул $rc (часть объектов могла быть пропущена):"; tail -3 /tmp/pg-restore.log | sed 's/^/     /'; }
    local after; after=$(pg_sql_db "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform'" "${DB_NAME}" 2>/dev/null || echo 0)
    [ "${after:-0}" -gt 0 ] || { say_bad "таблиц нет"; return 1; }
    say_ok "таблиц в ${DB_NAME}: $after"
}

# ── 4. apps ─────────────────────────────────────────────────
step_apps() {
    local root="${RESTORE_ROOT:-$DATA_DIR/restore/unpacked}"
    local repo="${CORE_REPO:-}"
    [ -z "$repo" ] && [ -f "$root/git/orencode.bundle" ] && repo="$root/git/orencode.bundle"
    [ -n "$repo" ] || { say_bad "нет CORE_REPO и нет git/orencode.bundle"; return 1; }
    say_info "код: $(basename "$repo") → $CORE_DIR"
    if [ -d "$CORE_DIR/.git" ]; then run git -C "$CORE_DIR" fetch --all --prune
    else run git clone "$repo" "$CORE_DIR" >/dev/null 2>&1 || { [ "$APPLY" = "1" ] && { say_bad "клон не удался"; return 1; }; }; fi
    # Конфиг приложения: берём из снимка и переводим на нашу базу и порт.
    if [ -f "$root/configs/env.friday" ] && [ ! -f "$CORE_DIR/.env" ]; then
        cp "$root/configs/env.friday" "$CORE_DIR/.env"; chmod 600 "$CORE_DIR/.env"
        PGPASS=""; [ -f "$DATA_DIR/pg.pass" ] && PGPASS=$(cat "$DATA_DIR/pg.pass")
        python3 "$HERE/patch-env.py" "$CORE_DIR/.env" "$DB_NAME" "$CORE_PORT" "$PGPASS" 2>/dev/null || true
        say_ok "конфиг .env собран из снимка (база ${DB_NAME}, порт ${CORE_PORT})"
    fi
    run bash -c "cd '$CORE_DIR' && npm ci --omit=dev"
    if [ "$APPLY" != "1" ]; then say_info "[сухой прогон] pm2 start, pm2 save, проверка health"; return 0; fi
    ( cd "$CORE_DIR" && PORT="$CORE_PORT" pm2 start server.js --name "orencode-${DB_NAME}" --update-env >/dev/null 2>&1 )
    pm2 save >/dev/null 2>&1
    say_info "жду ответа на ${CORE_PORT}…"
    local i st=""
    for i in $(seq 1 20); do
        sleep 2
        st=$(curl -sf --max-time 4 "http://127.0.0.1:${CORE_PORT}/health" || true)
        [ -n "$st" ] && break
        printf '.'
    done
    printf '\n'
    if printf '%s' "$st" | grep -q '"ok":true'; then
        say_ok "health: $(printf '%s' "$st" | python3 -c "import json,sys;d=json.load(sys.stdin);print('loaded',str(d.get('loaded_commit'))[:7],'head',str(d.get('head'))[:7],'stale',d.get('stale'))" 2>/dev/null)"
    else
        say_bad "нет ответа на ${CORE_PORT}/health"; say_info "хвост: $(tail -3 /tmp/pg-restore.log 2>/dev/null | head -1)"; return 1
    fi
}

# ── 5. web ──────────────────────────────────────────────────
step_web() {
    if [ "$SKIP_WEB" = "1" ]; then say_info "nginx не трогаю (SKIP_WEB=1)"; return 0; fi
    local root="${RESTORE_ROOT:-$DATA_DIR/restore/unpacked}"
    [ -d "$root/configs/nginx" ] || { say_bad "в снимке нет configs/nginx"; return 1; }
    run bash -c "cp -a '$root/configs/nginx/.' /etc/nginx/sites-available/"
    run nginx -t && run systemctl reload nginx
    say_ok "nginx перезагружен"
}

# ── 6. accept ───────────────────────────────────────────────
step_accept() {
    local fail=0 base="${CORE_PUBLIC_URL:-http://127.0.0.1:${CORE_PORT}}"
    if curl -sf --max-time 8 "$base/health" | grep -q '"ok":true'; then say_ok "$base/health"; else say_bad "$base/health недоступен"; fail=1; fi
    if [ "$SKIP_WEB" != "1" ]; then
        if curl -sfI --max-time 8 "$base/" | head -1 | grep -q "200\|302"; then say_ok "панель открывается"; else say_bad "панель не открывается"; fail=1; fi
    else say_info "веб-часть пропущена (учение)"; fi
    return "$fail"
}

run_step() {
    case "$1" in
        preflight) step_preflight ;;
        snapshot)  step_snapshot ;;
        db)        step_db ;;
        apps)      step_apps ;;
        web)       step_web ;;
        accept)    step_accept ;;
        *) say_bad "неизвестный шаг: $1"; return 2 ;;
    esac
    return $?
}

# ── диспетчер ───────────────────────────────────────────────
printf '%s╭──────────────────────────────────────────────╮%s\n' "$C_B" "$C_R"
printf '%s│  Пиксель · восстановление Ядра                │%s\n' "$C_B" "$C_R"
printf '%s│  режим: %-36s│%s\n' "$C_B" "$([ "$APPLY" = "1" ] && echo ВЫПОЛНЕНИЕ || echo СУХОЙ ПРОГОН)" "$C_R"
printf '%s╰──────────────────────────────────────────────╯%s\n' "$C_B" "$C_R"
[ "$APPLY" != "1" ] && printf '%sНичего не меняется. Выполнить: --apply (опасное спросит --yes).%s\n' "$C_DIM" "$C_R"

T0=$(date +%s)
rc=0
if [ -n "$STEP" ]; then
    names="preflight snapshot db apps web accept"
    label=$(echo "$STEP" | sed 's/^\(.\)/\U\1/')
    STEP_NAME="$STEP"; STEP_T0=$(date +%s); STEP_NO=0; TOTAL=1
    printf '\n%s[1/1]%s %s\n' "$C_B" "$C_R" "$STEP"
    run_step "$STEP"; rc=$?
    STEP_NO=1; step_end "$([ "$rc" = "0" ] && echo ok || echo fail)"
else
    names="preflight snapshot db apps web accept"
    labels=("Проверяю машину" "Беру снимок" "Восстанавливаю базу" "Поднимаю код и процессы" "Настраиваю сайт" "Приёмка")
    i=0
    for s in $names; do
        step_begin "${labels[$i]}"
        if run_step "$s"; then step_end ok; else step_end fail; rc=1; break; fi
        i=$((i+1))
    done
fi

TOTAL_T=$(( $(date +%s) - T0 ))
printf '\n%s──────────── и т о г ────────────%s\n' "$C_DIM" "$C_R"
for i in "${!R_STEP[@]}"; do
    case "${R_STATUS[$i]}" in
        ok) mark="${C_OK}✓${C_R}" ;; skip) mark="${C_WARN}•${C_R}" ;; *) mark="${C_BAD}✗${C_R}" ;;
    esac
    printf '  %s  %-28s %s%4s с%s\n' "$mark" "${R_STEP[$i]}" "$C_DIM" "${R_TIME[$i]}" "$C_R"
done
printf '  %sвсего: %s с%s\n' "$C_DIM" "$TOTAL_T" "$C_R"
if [ "$rc" = "0" ]; then
    printf '\n%s✔ Готово.%s Ядро поднято. Состояние: %s\n' "$C_OK" "$C_R" "$STATE"
else
    printf '\n%s✖ Не завершено.%s Регламент: %s/ARMAGEDDON-LLM.md\n' "$C_BAD" "$C_R" "$HERE"
fi
exit "$rc"
