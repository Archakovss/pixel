#!/bin/bash
# restore.sh — подъём Ядра по карточке Армагеддона (P2).
#
# Принципы:
#   * идемпотентность: повторный запуск не ломает сделанное;
#   * по умолчанию СУХОЙ прогон — показывает, что сделает, и ничего не меняет;
#   * разрушительное (заливка в непустую БД) — только с --yes;
#   * после каждого шага проверка, без неё дальше не идём;
#   * состояние и лог — в ~/.pixel/data.
#
# Режим учения на живом узле:
#   DB_NAME=platform_drill CORE_PORT=3222 SKIP_WEB=1 CORE_DIR=/srv/drill/orencode
#
# Использование:
#   restore.sh                                  сухой прогон всех шагов
#   restore.sh --apply --yes                    выполнить
#   restore.sh --step preflight                 один шаг
#   restore.sh --from s3://bucket/dr/<date> --passphrase-file ~/.pixel/dr.pass
#   restore.sh --from /path/to/dr.tar.gz.gpg --passphrase-file ...
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
RESTORE_ROOT=""
SRC=""

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
log()  { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG" 2>/dev/null || true; }
ok()   { printf '✔ %s\n' "$*"; }
bad()  { printf '✖ %s\n' "$*"; }
info() { printf '• %s\n' "$*"; }
run()  { if [ "$APPLY" = "1" ]; then log "RUN: $*"; "$@"; else info "[сухой прогон] $*"; fi; }

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


# psql-хелперы: sudo есть не везде (на чистом Debian его нет), а мы и так root.
pg_sql() { # SQL → вывод
    if command -v sudo >/dev/null 2>&1; then sudo -u postgres psql -tAc "$1"
    else su -s /bin/sh postgres -c "psql -tAc \"$1\""; fi
}
pg_sql_db() { # SQL, БД
    if command -v sudo >/dev/null 2>&1; then sudo -u postgres psql -d "$2" -tAc "$1"
    else su -s /bin/sh postgres -c "psql -d '$2' -tAc \"$1\""; fi
}
pg_run() { # SQL без вывода
    if command -v sudo >/dev/null 2>&1; then sudo -u postgres psql -c "$1"
    else su -s /bin/sh postgres -c "psql -c \"$1\""; fi
}
pg_createdb() {
    if command -v sudo >/dev/null 2>&1; then sudo -u postgres createdb -O core "$1"
    else su -s /bin/sh postgres -c "createdb -O core '$1'"; fi
}


pg_restore_file() { # файл дампа → в базу, от суперпользователя postgres через сокет
    if command -v sudo >/dev/null 2>&1; then
        sudo -u postgres pg_restore -d "$DB_NAME" --no-owner "$1"
    else
        su -s /bin/sh postgres -c "pg_restore -d '$DB_NAME' --no-owner '$1'"
    fi
}
pg_apply_sql() {
    if command -v sudo >/dev/null 2>&1; then
        sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$1"
    else
        su -s /bin/sh postgres -c "psql -d '$DB_NAME' -v ON_ERROR_STOP=1 -f '$1'"
    fi
}

healthy_core() {
    curl -sf --max-time 3 "${CORE_HEALTH_URL:-http://127.0.0.1:${CORE_PORT}/health}" 2>/dev/null | grep -q '"ok":true'
}

# ── 1. Осмотр машины ─────────────────────────────────────────
step_preflight() {
    local miss=0
    printf '\n== preflight: что есть на машине\n'
    for spec in "node:nodejs npm" "python3:python3" "curl:curl" "git:git" "psql:postgresql" "nginx:nginx" "pm2:npm i -g pm2" "tar:tar" "openssl:openssl" "gpg:gnupg"; do
        name="${spec%%:*}"; pkg="${spec#*:}"
        if command -v "$name" >/dev/null 2>&1; then ok "$name — $(command -v "$name")"; else bad "$name — установи: $pkg"; miss=1; fi
    done
    local free_gb
    free_gb=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')
    if [ "${free_gb:-0}" -ge 10 ]; then ok "диск — ${free_gb} ГБ свободно"; else bad "диск — ${free_gb} ГБ, нужно ≥ 10"; miss=1; fi
    if healthy_core; then
        bad "Ядро уже отвечает на /health — поверх живого не восстанавливаем"
        info "если это осознанно: CORE_HEALTH_URL=http://127.0.0.1:1/health restore.sh --apply --yes"
        miss=1
    fi
    [ "$miss" = "0" ] && save_state preflight ok || save_state preflight fail
    return "$miss"
}

# ── 2. Снимок: получить, расшифровать, распаковать ───────────
step_snapshot() {
    printf '\n== snapshot: снимок\n'
    if [ -z "$FROM" ]; then
        bad "не указан источник: --from s3://... или --from /path/file.tar.gz.gpg"
        save_state snapshot fail; return 1
    fi
    local work="$DATA_DIR/restore"
    mkdir -p "$work"
    case "$FROM" in
        s3://*)
            command -v aws >/dev/null 2>&1 || { bad "нет aws cli"; save_state snapshot fail; return 1; }
            info "скачиваю $FROM"
            run aws s3 cp "$FROM" "$work/" --recursive --only-show-errors
            ;;
        *)
            if [ -f "$FROM" ]; then
                # Явно указанный файл важнее маски: рядом могут лежать другие архивы.
                SRC="$FROM"; work="$(dirname "$FROM")"
                info "беру указанный файл $FROM"
            else
                work="$FROM"; SRC=""; info "беру каталог $FROM"
            fi
            ;;
    esac
    if [ "$APPLY" != "1" ]; then info "[сухой прогон] расшифровка и распаковка пропущены"; save_state snapshot dry; return 0; fi

    local unpack="$DATA_DIR/restore/unpacked"
    rm -rf "$unpack"; mkdir -p "$unpack"
    local enc=""
    local plain_src=""
    if [ -n "${SRC:-}" ]; then
        # Зашифрованное — только .gpg. Обычный архив не должен требовать пароль.
        case "$SRC" in
            *.gpg) enc="$SRC" ;;
            *) plain_src="$SRC" ;;
        esac
    else
        enc=$(ls -1 "$work"/*.tar.gz.gpg 2>/dev/null | head -1 || true)
    fi
    if [ -n "$enc" ]; then
        [ -n "$PASS_FILE" ] && [ -r "$PASS_FILE" ] || { bad "нужен --passphrase-file"; save_state snapshot fail; return 1; }
        info "расшифровываю $(basename "$enc")"
        gpg --batch --quiet --yes --passphrase-file "$PASS_FILE" --decrypt "$enc" > "$work/snapshot.tar.gz" \
            || { bad "расшифровка не удалась (пароль?)"; save_state snapshot fail; return 1; }
    else
        if [ -n "$plain_src" ]; then
            cp "$plain_src" "$work/snapshot.tar.gz" \
                || { bad "не скопировать $plain_src"; save_state snapshot fail; return 1; }
        else
            local plain
            plain=$(ls -1 "$work"/*.tar.gz 2>/dev/null | head -1 || true)
            [ -n "$plain" ] || { bad "нет архива .tar.gz/.gpg"; save_state snapshot fail; return 1; }
            cp "$plain" "$work/snapshot.tar.gz" || { bad "не скопировать $plain"; save_state snapshot fail; return 1; }
        fi
    fi
    tar xzf "$work/snapshot.tar.gz" -C "$unpack" || { bad "архив не распаковывается"; save_state snapshot fail; return 1; }
    RESTORE_ROOT="$unpack"

    if [ -f "$unpack/meta/manifest.txt" ]; then
        info "манифест: $(head -2 "$unpack/meta/manifest.txt" | tr '\n' ' ' | cut -c1-160)"
    elif [ -f "$unpack/manifest.json" ]; then
        info "манифест: $(python3 -c "import json;d=json.load(open('$unpack/manifest.json'));print(d.get('date'),'частей',d.get('parts'))" 2>/dev/null || echo json)"
    else
        bad "в архиве нет манифеста"; save_state snapshot fail; return 1
    fi
    ok "распаковано: $unpack ($(ls "$unpack/db" 2>/dev/null | wc -l) дампов)"
    save_state snapshot ok
}

# ── 3. База ─────────────────────────────────────────────────
step_db() {
    printf '\n== db: база %s\n' "$DB_NAME"
    local root="${RESTORE_ROOT:-$DATA_DIR/restore/unpacked}"
    local dump
    # Ядро — это platform. Раньше брался первый по алфавиту (club_saas) — неверно.
    dump="$root/db/platform.dump"
    [ -f "$dump" ] || dump=$(ls -1S "$root"/db/*.dump "$root"/db/*.sql 2>/dev/null | head -1 || true)
    [ -n "$dump" ] || { bad "нет дампа в $root/db"; save_state db fail; return 1; }
    info "дамп: $(basename "$dump") ($(du -h "$dump" | cut -f1))"
    run systemctl enable --now postgresql
    if [ "$APPLY" != "1" ]; then info "[сухой прогон] роль core, база ${DB_NAME}, заливка, сверка"; save_state db dry; return 0; fi

    pg_sql "SELECT 1 FROM pg_roles WHERE rolname='core'" | grep -q 1 \
        || pg_run "CREATE ROLE core LOGIN"
    pg_sql "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
        || pg_createdb "${DB_NAME}"

    local tables
    tables=$(pg_sql_db "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform'" "${DB_NAME}" 2>/dev/null || echo 0)
    if [ "${tables:-0}" -gt 0 ] && [ "$YES" != "1" ]; then
        bad "в базе ${DB_NAME} уже ${tables} таблиц — заливка поверх требует --yes"
        save_state db refuse; return 1
    fi

    # Заливаем от postgres через локальный сокет: TCP-пароль на свежей машине не настроен.
    case "$dump" in
        *.sql) pg_apply_sql "$dump" >/tmp/pg-restore.log 2>&1 ;;
        *) pg_restore_file "$dump" >/tmp/pg-restore.log 2>&1 ;;
    esac
    local rrc=$?
    if [ "$rrc" != "0" ]; then
        bad "pg_restore/psql вернул $rrc, хвост лога:"
        tail -5 /tmp/pg-restore.log | sed 's/^/    /'
    fi
    local after
    after=$(pg_sql_db "SELECT count(*) FROM information_schema.tables WHERE table_schema='platform'" "${DB_NAME}" 2>/dev/null || echo 0)
    if [ "${after:-0}" -gt 0 ]; then ok "таблиц в ${DB_NAME}: $after"; save_state db ok; else bad "таблиц нет — дамп не залился"; save_state db fail; return 1; fi
}

# ── 4. Код и процессы ───────────────────────────────────────
step_apps() {
    printf '\n== apps: код и процессы\n'
    local root="${RESTORE_ROOT:-$DATA_DIR/restore/unpacked}"
    local repo="${CORE_REPO:-}"
    if [ -z "$repo" ] && [ -f "$root/git/orencode.bundle" ]; then
        repo="$root/git/orencode.bundle"
    fi
    [ -n "$repo" ] || { bad "нет CORE_REPO и нет git/orencode.bundle в снимке"; save_state apps fail; return 1; }
    info "источник кода: $repo → $CORE_DIR"
    if [ -d "$CORE_DIR/.git" ]; then
        info "каталог уже есть — fetch"
        run git -C "$CORE_DIR" fetch --all --prune
    else
        run git clone "$repo" "$CORE_DIR"
    fi
    run bash -c "cd '$CORE_DIR' && npm ci --omit=dev"
    if [ "$APPLY" != "1" ]; then info "[сухой прогон] pm2 start + pm2 save (без автозапуска)"; save_state apps dry; return 0; fi

    ( cd "$CORE_DIR" && PORT="$CORE_PORT" pm2 start ecosystem.config.js --update-env >/dev/null 2>&1 \
        || PORT="$CORE_PORT" pm2 start server.js --name orencode-drill --update-env >/dev/null 2>&1 )
    pm2 save >/dev/null 2>&1
    sleep 6
    local st
    st=$(curl -sf --max-time 5 "http://127.0.0.1:${CORE_PORT}/health" || true)
    if printf '%s' "$st" | grep -q '"ok":true'; then
        printf '%s' "$st" | python3 -c "import json,sys;d=json.load(sys.stdin);print('  загружен',str(d.get('loaded_commit'))[:7],'| head',str(d.get('head'))[:7],'| stale',d.get('stale'))" || true
        ok "Ядро отвечает на ${CORE_PORT}"; save_state apps ok
    else
        bad "нет ответа на 127.0.0.1:${CORE_PORT}/health — смотри pm2 logs"; save_state apps fail; return 1
    fi
}

# ── 5. Сайт ─────────────────────────────────────────────────
step_web() {
    if [ "$SKIP_WEB" = "1" ]; then info "web пропущен (SKIP_WEB=1) — nginx не трогаем"; save_state web skipped; return 0; fi
    printf '\n== web: nginx\n'
    local root="${RESTORE_ROOT:-$DATA_DIR/restore/unpacked}"
    [ -d "$root/configs/nginx" ] || { bad "в снимке нет configs/nginx"; save_state web fail; return 1; }
    run bash -c "cp -a '$root/configs/nginx/.' /etc/nginx/sites-available/"
    run nginx -t
    run systemctl reload nginx
    save_state web ok
}

# ── 6. Приёмка ──────────────────────────────────────────────
step_accept() {
    printf '\n== accept: приёмка\n'
    local fail=0
    local base="${CORE_PUBLIC_URL:-http://127.0.0.1:${CORE_PORT}}"
    if curl -sf --max-time 8 "$base/health" | grep -q '"ok":true'; then ok "$base/health — ok"; else bad "$base/health — нет ответа"; fail=1; fi
    if [ "$SKIP_WEB" != "1" ]; then
        if curl -sfI --max-time 8 "$base/" | head -1 | grep -q "200\|302"; then ok "панель открывается"; else bad "панель не открывается"; fail=1; fi
    else
        info "веб-часть пропущена (учение)"
    fi
    [ "$fail" = "0" ] && save_state accept ok || save_state accept fail
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
        *) bad "неизвестный шаг: $1"; return 2 ;;
    esac
}

printf 'Пиксель · восстановление Ядра — режим: %s\n' "$([ "$APPLY" = "1" ] && echo ВЫПОЛНЕНИЕ || echo СУХОЙ ПРОГОН)"
[ "$APPLY" != "1" ] && printf 'Ничего не меняется. Выполнить: --apply (опасное спросит --yes).\n'

if [ -n "$STEP" ]; then run_step "$STEP"; exit $?; fi

rc=0
for s in preflight snapshot db apps web accept; do
    if ! run_step "$s"; then bad "останов на шаге: $s"; info "регламент: $HERE/ARMAGEDDON-LLM.md"; rc=1; break; fi
done

[ "$rc" = "0" ] && printf '\n✔ Все шаги пройдены. Состояние: %s\n' "$STATE" || printf '\n✖ Не завершено. Состояние: %s\n' "$STATE"
exit "$rc"
