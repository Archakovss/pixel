#!/bin/bash
# yadro-guard.sh — единственный сторож терминала Ядра (11.11.2026).
#
# Раньше сторожей было два (крон каждые 60с и systemd-таймер каждые 2 мин),
# оба запускали этот скрипт. Дубли давали гонку: при падении оба видели мёртвую
# сессию и оба пытались её поднять. Теперь планировщик один — systemd-таймер.
#
# Что улучшено против прежней версии:
#   1. flock — два запуска не наложатся, даже если таймер и ручной вызов совпали.
#   2. Проверяется не только tmux, но и живость node: pid из health-файла сверяется
#      с pid панели, процесс проверяется через kill -0. Живая оболочка с мёртвым
#      движком раньше считалась нормой.
#   3. Детектор зависания: in_flight=true и активность старше HUNG_SEC → рестарт.
#   4. Бэкофф: 10 → 30 → 60 → 300 секунд между попытками. Раньше crash-loop
#      крутился каждые 60 секунд бесконечно.
#   5. Лог только по смене состояния. Было 47 827 строк, из них 47 753 — «жива».
#   6. Алерт в friday.db agent_outbox после 3 неудачных подъёмов подряд.
#
# Коды выхода: 0 — всё в порядке (в т.ч. после успешного подъёма), 1 — не поднялся.
set -u

SESSION_NAME="${YADRO_SESSION:-orencode-yadro}"
CORE_WORKSPACE="${CORE_WORKSPACE:-/root/.openclaw/workspace}"
AGENT="$CORE_WORKSPACE/tools/yadro-agent.mjs"
HEALTH="$CORE_WORKSPACE/data/yadro-health.json"
STATE="$CORE_WORKSPACE/data/yadro-guard-state.json"
LOG="$CORE_WORKSPACE/data/yadro-guard.log"
LEARNING_LOG="$CORE_WORKSPACE/reviews/learning-log.md"
LOCK="${YADRO_GUARD_LOCK:-/tmp/yadro-guard.lock}"
HUNG_SEC="${YADRO_HUNG_SEC:-180}"
GATEWAY_URL="${YADRO_GATEWAY:-http://127.0.0.1:3212}"
GATEWAY_TOKEN_FILE=/root/.orencode-gateway.token

exec 9>"$LOCK" || exit 1
flock -n 9 || { echo "уже выполняется — пропуск"; exit 0; }

state_get() { # $1 — ключ, $2 — значение по умолчанию
    python3 - "$STATE" "$1" "$2" <<'PY' 2>/dev/null || echo "$2"
import json,sys
try:
    print(json.load(open(sys.argv[1])).get(sys.argv[2], sys.argv[3]))
except Exception:
    print(sys.argv[3])
PY
}

state_write() { # $1 — статус, $2 — число неудач, $3 — время следующей попытки (unix)
    python3 - "$STATE" "$1" "$2" "$3" <<'PY' 2>/dev/null || true
import json,sys,time
path,status,fails,next_at=sys.argv[1],sys.argv[2],int(sys.argv[3]),float(sys.argv[4])
try:
    st=json.load(open(path))
except Exception:
    st={}
if st.get('status')!=status:
    st['last_change']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
st.update({'status':status,'consecutive_failures':fails,'next_attempt_at':next_at,
           'checked_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})
if status=='restarted':
    st['restarts_total']=int(st.get('restarts_total',0))+1
json.dump(st,open(path,'w'),ensure_ascii=False,indent=1)
PY
}

note() { # запись только о смене состояния — не чаще, чем меняется мир
    local st="$1"; shift
    printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$st" "$*" >> "$LOG" 2>/dev/null || true
}

alert() { # fail-loud: только когда человеку правда нужен
    local msg="$1"
    local esc=${msg//\'/\'\'}
    sqlite3 "$CORE_WORKSPACE/friday.db" \
      "INSERT INTO agent_outbox (from_agent, subject, message, status) VALUES ('Пятница','yadro-guard ALERT','$esc','new');" \
      >/dev/null 2>&1 || true
    note 'ALERT' "$msg"
}

now=$(date +%s)
next_at=$(state_get next_attempt_at 0)
if [ "${next_at%.*}" -gt "$now" ] 2>/dev/null; then
    echo "бэкофф: следующая попытка через $(( ${next_at%.*} - now )) с"
    exit 0
fi

# --- 1. Сессия жива? ---
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    reason="tmux-сессия отсутствует"
else
    pane_pid=$(tmux list-panes -t "$SESSION_NAME" -F '#{pane_pid}' 2>/dev/null | head -1)
    health_pid=$(python3 -c "import json;print(json.load(open('$HEALTH')).get('pid',''))" 2>/dev/null || echo '')
    reason=''
    if [ -z "$pane_pid" ] || ! kill -0 "$pane_pid" 2>/dev/null; then
        reason="панель без живого процесса (pane_pid=$pane_pid)"
    elif [ -n "$health_pid" ] && [ "$pane_pid" != "$health_pid" ] && ! kill -0 "$health_pid" 2>/dev/null; then
        reason="движок мёртв (health pid=$health_pid), оболочка ещё жива"
    else
        hung=$(python3 - "$HEALTH" "$HUNG_SEC" <<'PY' 2>/dev/null || echo 0
import json,sys,time
try:
    h=json.load(open(sys.argv[1]))
except Exception:
    print(0); raise SystemExit
if not h.get('in_flight'):
    print(0); raise SystemExit
try:
    t=time.mktime(time.strptime(h['last_activity_at'].split('.')[0].replace('Z',''),'%Y-%m-%dT%H:%M:%S'))
except Exception:
    print(0); raise SystemExit
print(1 if (time.time()-t) > int(sys.argv[2]) else 0)
PY
)
        [ "$hung" = "1" ] && reason="зависание: in_flight без активности дольше ${HUNG_SEC}с"
    fi
fi

if [ -z "${reason:-}" ]; then
    if [ "$(state_get status '')" != "ok" ]; then
        state_write ok 0 0
        note 'OK' "терминал в норме (сессия $SESSION_NAME, движок жив)"
    fi
    exit 0
fi

# --- 2. Не здоров: поднимаем с бэкоффом ---
fails=$(state_get consecutive_failures 0)
fails=$((fails + 1))
case "$fails" in
    1) delay=10 ;;
    2) delay=30 ;;
    3) delay=60 ;;
    *) delay=300 ;;
esac

note 'RESTART' "причина: $reason · попытка $fails · следующая через ${delay}с"

if [ ! -f "$AGENT" ]; then
    state_write broken "$fails" $(( now + delay ))
    alert "движок отсутствует: $AGENT"
    exit 1
fi

# Старую сессию снимаем: полумёртвая оболочка мешает новой.
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

GW_ENV="YADRO_GATEWAY=$GATEWAY_URL"
if [ -r "$GATEWAY_TOKEN_FILE" ]; then
    GW_ENV="$GW_ENV YADRO_TOKEN=$(cat "$GATEWAY_TOKEN_FILE")"
else
    note 'WARN' "нет $GATEWAY_TOKEN_FILE — шлюз может ответить 401"
fi

tmux new-session -d -s "$SESSION_NAME" -c "$CORE_WORKSPACE" "$GW_ENV node '$AGENT'"
sleep 3

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    state_write restarted 0 0
    note 'UP' "сессия $SESSION_NAME поднята (причина была: $reason)"
    printf '\n- %s yadro-guard: поднял терминал — %s\n' "$(date -u +%FT%TZ)" "$reason" >> "$LEARNING_LOG" 2>/dev/null || true
    exit 0
fi

state_write broken "$fails" $(( now + delay ))
if [ "$fails" -ge 3 ]; then
    alert "терминал не поднимается: $fails попыток подряд, причина: $reason"
fi
exit 1
