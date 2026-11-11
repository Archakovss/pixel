#!/usr/bin/env node
// yadro-agent.mjs — движок терминала ЯДРО × Пятница · OrenCode
// v2.2 — фильтрация bash-output (RTK-style), авторетрай оборванных tool-call,
//        логирование stop=max_tokens, улучшенный парсинг

import { stdin, stdout } from 'process'
import * as rl from 'readline'
import { spawn, spawnSync, execSync, execFileSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { resolve, dirname, join, basename } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const LOG = join(ROOT, 'data', 'yadro-agent.log')
const HEALTH_FILE = join(ROOT, 'data', 'yadro-health.json')
const VERSION_FILE = join(__dirname, 'yadro-agent.version')

// ── конфиг из env ─────────────────────────────────────────────
// 11.11: FCC снят, дефолт 8082 больше не существует. Свой шлюз Ядра — 3212.
// Токен берём из файла 600, чтобы запуск без env не падал в 401.
const GATEWAY = process.env.YADRO_GATEWAY || 'http://127.0.0.1:3212'
// justcode живёт не в FCC (там его нет в каталоге), а в своём мостике tools/justcode-gateway.mjs.
const JUSTCODE_GATEWAY = process.env.JUSTCODE_GATEWAY || 'http://127.0.0.1:8083'
function gatewayFor(model) {
  return /^justcode\//i.test(String(model || '')) ? JUSTCODE_GATEWAY : GATEWAY
}
function defaultGatewayToken() {
  if (process.env.YADRO_TOKEN) return process.env.YADRO_TOKEN
  try { return readFileSync('/root/.orencode-gateway.token', 'utf-8').trim() } catch { return 'freecc' }
}
const AUTHZ = 'Bearer ' + defaultGatewayToken()
// MODEL изменяемая: /model раньше писал только в process.env, а константа оставалась
// прежней — интерфейс показывал justcode, запросы уходили в deepseek (баг 08.11).
const MODEL_FILE = join(ROOT, 'data', 'yadro-model.txt')
let MODEL = process.env.YADRO_MODEL
  || (existsSync(MODEL_FILE) ? readFileSync(MODEL_FILE, 'utf-8').trim() : '')
  || 'deepseek/deepseek-v4-pro'

// ── сессия: история переживает падение процесса (11.11) ──────
// Раньше hist жил только в памяти: watchdog, падение node или рестарт
// съедали весь разговор, и задачу приходилось объяснять заново.
const SESSION_ID = process.env.YADRO_SESSION_ID || 'main'
const SESSION_FILE = join(ROOT, 'data', `yadro-session-${SESSION_ID}.json`)
const SESSION_TTL_H = parseInt(process.env.YADRO_SESSION_TTL_H || '72', 10)
const SESSION_MAX_MSGS = parseInt(process.env.YADRO_SESSION_MAX_MSGS || '400', 10)
const SESSION_ENABLED = process.env.YADRO_SESSION !== '0'

// ── чекпоинт правок: тень дерева перед первым write/edit ─────
const CHECKPOINT_FILE = join(ROOT, 'data', 'yadro-checkpoint.json')
const CHECKPOINT_ENABLED = process.env.YADRO_CHECKPOINT !== '0'

// ── учёт токенов по прогону ──────────────────────────────────
const USAGE_FILE = join(ROOT, 'data', 'yadro-usage.jsonl')
const runUsage = { in: 0, out: 0, calls: 0 }

// ── нативный tool calling (опция, по умолчанию выключено) ────
// XML-протокол рвётся на stop=max_tokens: блок обрывается посередине и парсер
// не находит хвост. Нативный режим выключает целый класс этих ошибок, потому
// что форму ответа гарантирует API. Включается одной переменной, откат такой же.
// 11.11: нативный режим проверен 3×10/10 — включён по умолчанию.
// Откат в одну переменную: YADRO_NATIVE_TOOLS=0 (вернётся XML-протокол).
const NATIVE_TOOLS = process.env.YADRO_NATIVE_TOOLS !== '0'
const TOOL_DEFS = [
  { name: 'bash', description: 'Выполнить shell-команду в рабочем каталоге', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read', description: 'Прочитать файл', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write', description: 'Записать файл целиком', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit', description: 'Точечная замена oldText → newText в файле', input_schema: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] } },
  { name: 'ls', description: 'Список файлов в каталоге', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'grep', description: 'Поиск по файлам', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'glob', description: 'Поиск файлов по маске', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'web_get', description: 'Загрузить http(s)-страницу как текст', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  // Имена web_fetch/web_search нельзя: FCC отвергает их как серверные инструменты
  // Anthropic и возвращает 400 на весь запрос (найдено 11.11). Локальные — свои имена.
  { name: 'web_query', description: 'Веб-поиск', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'mcp', description: 'Вызов MCP-коннектора платформы', input_schema: { type: 'object', properties: { server: { type: 'string' }, action: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' } }, required: ['server', 'action'] } },
  { name: 'connectors', description: 'Список MCP-коннекторов', input_schema: { type: 'object', properties: {} } },
  { name: 'verify', description: 'Собрать факты о состоянии (git, синтаксис, живой процесс)', input_schema: { type: 'object', properties: {} } },
  { name: 'todo', description: 'План работы: set/done/show', input_schema: { type: 'object', properties: { action: { type: 'string' }, items: { type: 'array', items: { type: 'string' } }, index: { type: 'number' } }, required: ['action'] } },
  { name: 'delegate', description: 'Отдать тяжёлую подзадачу агенту с чистым контекстом', input_schema: { type: 'object', properties: { task: { type: 'string' }, chart: { type: 'string' }, cwd: { type: 'string' }, max_steps: { type: 'number' } }, required: ['task'] } },
]
const FALLBACK_MODEL = process.env.YADRO_FALLBACK_MODEL || 'deepseek/deepseek-flash'
const CB_THRESHOLD = parseInt(process.env.YADRO_CB_THRESHOLD || '3', 10)
const CB_COOLDOWN_MS = parseInt(process.env.YADRO_CB_COOLDOWN_MS || '60000', 10)
const MAX_TOKENS = parseInt(process.env.YADRO_MAX_TOKENS || '8000', 10)
// 8.11: 16 шагов мало — на циклах «запрос → инструмент» потолок съедался на середине
// задачи; 40 хватает на полноценный прогон, бесконечность по-прежнему сторожит watchdog.
const MAX_STEPS = parseInt(process.env.YADRO_MAX_STEPS || '40', 10)
const BASH_TIMEOUT = parseInt(process.env.YADRO_BASH_TIMEOUT || '60000', 10)
const REQ_TIMEOUT = parseInt(process.env.YADRO_REQ_TIMEOUT || '180000', 10)
const CTX_BUDGET = parseInt(process.env.YADRO_CTX_BUDGET || '60000', 10)
const TOOL_OUTPUT_CLIP = parseInt(process.env.YADRO_TOOL_OUTPUT_CLIP || '8000', 10)
const TOOL_MAX_TOKENS = parseInt(process.env.YADRO_TOOL_MAX_TOKENS || '16000', 10)

// ── цвета ─────────────────────────────────────────────────────
const R = '\x1b[0m', D = '\x1b[2m', L = '\x1b[38;2;168;209;0m'
const RD = '\x1b[38;2;255;100;100m', YEL = '\x1b[38;2;255;200;0m'
const S = (x) => (x == null ? '' : String(x))

// ── circuit breaker ───────────────────────────────────────────
// 3 подряд неудач шлюза → breaker OPEN (cooldown) → fallback-модель
let cbState = 'CLOSED'   // CLOSED | OPEN | HALF_OPEN
let cbFailures = 0
let cbOpenedAt = 0
function cbOnFailure() {
  cbFailures++
  health.last_error = `circuit failures=${cbFailures}`
  if (cbState === 'CLOSED' && cbFailures >= CB_THRESHOLD) {
    cbState = 'OPEN'
    cbOpenedAt = Date.now()
    logLine(`${new Date().toISOString()} CIRCUIT OPEN after ${cbFailures} failures`)
  }
}
function cbOnSuccess() {
  if (cbState === 'HALF_OPEN') { cbState = 'CLOSED'; logLine(`${new Date().toISOString()} CIRCUIT CLOSED (recovered)`); }
  cbFailures = 0
}
function cbEffectiveModel() {
  if (cbState === 'OPEN') {
    if (Date.now() - cbOpenedAt >= CB_COOLDOWN_MS) { cbState = 'HALF_OPEN'; logLine(`${new Date().toISOString()} CIRCUIT HALF_OPEN, probing ${MODEL}`); return MODEL }
    return FALLBACK_MODEL
  }
  return MODEL
}

// ── рабочая папка (a0-6): наследуется от tmux (-c cwd), меняется /cwd ──
let CWD = process.env.YADRO_CWD || process.cwd() || '/root/orencode'
try { if (CWD === '/' || !existsSync(CWD)) CWD = '/root/orencode' } catch { CWD = '/root/orencode' }

// ── системный промпт ──────────────────────────────────────────
// Правила проекта читаем из AGENTS.md — как Claude Code читает CLAUDE.md.
// Раньше всё было вшито в SYS: чтобы поменять правило, приходилось править код.
let _agentsCache = { cwd: null, text: '' }
function agentsDocs() {
  if (_agentsCache.cwd === CWD) return _agentsCache.text
  const seen = new Set()
  const parts = []
  // PIXEL.md идёт последним: его правила перекрывают общие (роль, аудит, проактивность).
  for (const p of [join(CWD, 'AGENTS.md'), '/root/orencode/AGENTS.md', join(ROOT, 'AGENTS.md'),
                   join(CWD, 'PIXEL.md'), '/root/orencode/PIXEL.md']) {
    if (seen.has(p) || !existsSync(p)) continue
    seen.add(p)
    try {
      const t = readFileSync(p, 'utf-8').trim()
      if (t) parts.push('--- ' + p + ' ---\n' + clip(t, 4000))
    } catch (_) { /* нет файла — не критично */ }
  }
  const text = parts.length ? '\n\nПРАВИЛА ПРОЕКТА (AGENTS.md + PIXEL.md, PIXEL.md приоритетнее):\n' + parts.join('\n\n') : ''
  _agentsCache = { cwd: CWD, text }
  return text
}

// Антипаттерны: короткий список классов провалов, которые уже случались (приём Boris Cherny).
// Читается при старте и живёт в промпте всегда — иначе агент повторяет одни и те же ошибки,
// а learning-log продолжает расти как дневник, который никто не перечитывает.
function antiPatterns() {
  try {
    const t = readFileSync(join(__dirname, '..', 'ANTIPATTERNS.md'), 'utf-8')
      .split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.replace(/^- /, '• ')).join('\n')
    return t ? '\nНЕ ПОВТОРЯЙ (классы прошлых провалов):\n' + t + '\n' : ''
  } catch { return '' }
}

const SYS = `Ты — ЯДРО (Agent for Developing & Reasoning Operations), рабочий терминал внутри проекта OrenCode (панель fridaybot.ru/core).

Твоя роль: выполнять приказы Сергея (@Archakov) в ${CWD} — читать код, править файлы, запускать тесты, коммитить в git.

Инструменты:
- bash — команды shell
- read — чтение файла
- write — перезапись файла
- edit — точечная правка
- ls — листинг директории
- grep — поиск по файлам
- connectors — список доступных MCP-коннекторов платформы
- mcp — вызов коннектора: server + action(tools|call) + tool + args(JSON). Сначала connectors → потом mcp action=tools → потом mcp action=call
- verify — собрать факты о состоянии: git, синтаксис изменённых файлов, совпадение загруженного кода Ядра с HEAD, не устарел ли живой процесс. Вызывай ПЕРЕД словом «готово».
- delegate — отдать тяжёлую подзадачу отдельному агенту с чистым контекстом: task(строка), chart(имя команды из teams/, необязательно: audit|research|acceptance), cwd(путь, необязательно), max_steps(число). Возвращает только результат. Используй для исследования, аудита, сбора данных из многих файлов.
- todo — план/список задач: action=set items=<строки> (составить план), action=done index=N (отметить пункт), action=show
- glob — поиск файлов по маске (pattern, напр. src/**/*.vue)
  - web_get (в XML-режиме web_fetch) — загрузка http(s)-страницы (url), HTML → текст
  - web_query (в XML-режиме web_search) — веб-поиск (query), топ результатов

Формат вызова инструмента — отвечай ТОЧНО так (без markdown и без кодовых блоков):
<function_calls>
<invoke name="read">
<parameter name="path">package.json</parameter>
</invoke>
</function_calls>

После вызова ты получишь «Результат tool ...» и продолжишь. Можно вызвать несколько инструментов подряд. Все инструменты выше доступны ВСЕГДА — никогда не пиши, что инструмент недоступен, просто вызови его в этом формате.

Стиль работы:
- Краткие подтверждения действий
- Без предисловий и разъяснений
- Сначала действие, потом доклад
- Для нетривиальных задач (3+ шага) сначала составь план: todo action=set items=... — затем выполняй по пунктам, отмечая todo action=done index=N. Простое — сразу действие без плана.
- Ошибки фиксируй в data/yadro-agent.log

Правила безопасности:
- Деструктив (rm -rf, DROP TABLE, git reset --hard) — ВСЕГДА спрашивай подтверждения
- Перед правкой важных файлов (package.json, server.js, .env) — показывай diff
- Не трогай .git/config без явного приказа

${antiPatterns()}
Ты работаешь в CWD: ${CWD}
Версия движка: ${existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf-8').trim() : 'unknown'}
Модель: ${MODEL}

Отвечай только по делу. Если нужен ответ пользователя — задай вопрос с "?" в конце строки (он будет подсвечен).`

// ── health-метрики (живой JSON для монитора) ────────────────
const START_TS = Date.now()
const health = {
  pid: process.pid,
  started_at: new Date(START_TS).toISOString(),
  model: MODEL,
  requests_total: 0,
  requests_failed: 0,
  requests_truncated: 0,
  tool_calls_total: 0,
  tool_errors_total: 0,
  // По каждому инструменту: сколько раз звали и сколько раз он ответил ошибкой.
  // Нужно, чтобы видеть, где агент путается (grep вместо read, edit вместо write),
  // а не только «всего ошибок N» — это была метрика без адреса.
  tool_stats: {},
  // Эскалация человеку: сколько раз агент останавливался и ждал ответа.
  // Раньше «задай вопрос с ? в конце» было только просьбой в промпте — состояние
  // нигде не фиксировалось, и по метрикам нельзя было понять, часто ли он застревает.
  questions_asked: 0,
  waiting_for_human: false,
  last_error: null,
  last_activity_at: new Date().toISOString(),
  // учёт токенов (11.11): раньше цифры расхода жили в панели отдельно от движка
  tokens_in: 0,
  tokens_out: 0,
  // флаг «занят» — читает бэк Ядра (term.js status.busy) для индикатора в тулбаре
  in_flight: false,
}
function saveHealth() {
  try {
    health.last_activity_at = new Date(lastActivity).toISOString()
    health.uptime_sec = Math.round((Date.now() - START_TS) / 1000)
    writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2), 'utf-8')
  } catch {}
}

// ── логирование ───────────────────────────────────────────────
const logDir = dirname(LOG)
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })

function logLine(s) {
  try {
    const line = S(s).replace(/\n/g, ' ').slice(0, 500) + '\n'
    writeFileSync(LOG, line, { flag: 'a', encoding: 'utf-8' })
  } catch {}
}

// ── spinner ───────────────────────────────────────────────────
// Маскот «Пиксель» вместо точек Брайля: мордочка моргает и поворачивается,
// пока агент думает (Сергей, 08.11). Кадры одной ширины — чтобы не рвать строку.
const frames = [
  '(◕‿◕)  ',
  '(◕‿◕)ﾉ ',
  '(◔‿◔)  ',
  '(°‿°)  ',
  '(◕‿◕)♪ ',
  '(≧‿≦)  ',
]
let spinId = null, spinFrame = 0, spinLabel = '', spinStart = 0
function startSpin(label) {
  stopSpin()
  if (process.env.YADRO_TASK) return   // тихий режим: без спиннера, stdout собирает родитель
  spinLabel = label
  spinFrame = 0
  spinStart = Date.now()
  spinId = setInterval(() => {
    // Секунды рядом с именем инструмента: видно, что работа идёт и сколько уже идёт.
    const sec = ((Date.now() - spinStart) / 1000).toFixed(1)
    stdout.write('\r' + L + frames[spinFrame] + R + D + ' ' + spinLabel + ' · ' + sec + 'с' + R)
    spinFrame = (spinFrame + 1) % frames.length
  }, 160)
}
function stopSpin() {
  if (spinId) {
    clearInterval(spinId)
    spinId = null
    stdout.write('\r' + ' '.repeat(80) + '\r')
  }
}

// ── вспомогательные ───────────────────────────────────────────
function clip(s, max) {
  s = S(s)
  if (s.length <= max) return s
  // Голова + хвост: конец вывода несёт ошибку и итог, обрезать его — терять смысл.
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return s.slice(0, head) + '\n…(середина опущена, ' + (s.length - max) + ' симв.)…\n' + s.slice(-tail)
}

function toolRe() {
  return /<\/?(?:antml:)?(function_calls|invoke|parameter)(\s+name="[^"]*")?>/gi
}

function clean(text) {
  return S(text)
    .replace(toolRe(), '')
    .split('\n')
    .filter((l) => !/DSLM|<\|[\s\S]*?\|>|<\/?\s*\|?\s*(calls|invoke|parameter)|\b(invoke|parameter)\s+name=/i.test(l))
    .join('\n')
    .replace(/([A-Za-zА-Яа-яЁё])\1{6,}/g, '$1$1')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── фильтрация bash-вывода (RTK-style) ───────────────────────
function filterBashOutput(text) {
  const lines = S(text).split('\n')
  const filtered = []
  const seen = new Map()
  
  for (const line of lines) {
    const trim = line.trim()
    
    // Режем полные дубли (npm/yarn спам)
    if (seen.has(trim) && seen.get(trim) > 1) {
      if (/^(npm|yarn|pnpm|added|removed|updated|audited|packages?|dependencies|found|run|audit|up to date)/i.test(trim)) continue
    }
    seen.set(trim, (seen.get(trim) || 0) + 1)
    
    // Режем мусорные логи
    if (/^(Debugger attached|Waiting for the debugger|For help, see:|Deprecated|ExperimentalWarning)/.test(trim)) continue
    if (/^\[.*?\]\s*(GET|POST|PUT|DELETE|PATCH)\s+\//.test(trim)) continue // HTTP-логи
    if (/^(\s*at\s+|^\s*\^)/.test(line) && filtered.length > 50) continue // стек-трейсы (первые 50 оставляем)
    if (/^(\s*\||│)/.test(line) && /progress|download/i.test(line)) continue // прогресс-бары
    
    filtered.push(line)
  }
  
  // Если вывод стал пустым после фильтрации — вернём оригинал (чтобы не потерять важное)
  if (filtered.length === 0 && lines.length > 0) return text
  
  return filtered.join('\n')
}

// ── история и бюджет контекста ────────────────────────────────
const hist = []
const sizeOf = (msgs) => msgs.reduce((s, m) => s + S(m.content).length, 0)

// Скоринг чанков (harness P2, 09.11.2026). Раньше чистили по возрасту: резали середину,
// пока не влезем в бюджет — вместе с тем, что ещё нужно, и оставляли воду. Теперь каждый
// блок оценивается по пересечению слов с задачей и по свежести; последние 4 хода неприкосновенны,
// иначе агент теряет нить. Решение арифметическое, модель не вызывается.
function scoreOf(m, queryWords, idx, total) {
  const text = S(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).toLowerCase()
  const words = new Set(text.match(/[a-zа-яё0-9]{3,}/g) || [])
  let overlap = 0
  for (const w of queryWords) if (words.has(w)) overlap++
  const rel = queryWords.size ? overlap / queryWords.size : 0
  const rec = (idx + 1) / Math.max(1, total)
  const bonus = m.role === 'user' || m.role === 'system' ? 0.15 : 0
  return Math.min(1, 0.55 * rel + 0.35 * rec + bonus)
}

function trimHistory(msgs) {
  const query = S(msgs[0] && msgs[0].content ? msgs[0].content : '')
  const qw = new Set((query.toLowerCase().match(/[a-zа-яё0-9]{3,}/g) || []))
  const total = msgs.length
  const tailFrom = Math.max(0, total - 4)
  const kept = new Set()
  let used = 0
  const items = msgs.map((m, i) => ({ m, i, score: scoreOf(m, qw, i, total), must: i >= tailFrom }))
  for (const it of items) if (it.must) { kept.add(it.i); used += sizeOf([it.m]) }
  for (const it of items.slice().sort((a, b) => b.score - a.score)) {
    if (kept.has(it.i)) continue
    const cost = sizeOf([it.m])
    if (used + cost > CTX_BUDGET) continue
    kept.add(it.i); used += cost
  }
  let out = msgs.filter((_, i) => kept.has(i))
  // если даже отобранное не влезло (гигантские сообщения) — режем содержимое длинных
  if (sizeOf(out) > CTX_BUDGET) {
    out = out.map((m, i) => (i > 0 && i < out.length - 1 && S(m.content).length > 4000 ? { ...m, content: clip(m.content, 4000) } : m))
  }
  return out.length ? out : msgs.slice(-4)
}

function trimHistoryLegacy(msgs) {
  let out = msgs.slice()
  while (out.length > 3 && sizeOf(out) > CTX_BUDGET) {
    if (out.length >= 4 && out[2].role === 'assistant' && out[3].role === 'user') out.splice(2, 2)
    else if (out.length >= 4 && out[2].role === 'user' && out[3].role === 'assistant') out.splice(2, 2)
    else if (out.length > 3) out.splice(2, 1)
  }
  if (sizeOf(out) > CTX_BUDGET) {
    out = out.map((m, i) => (i > 0 && i < out.length - 1 && S(m.content).length > 4000 ? { ...m, content: clip(m.content, 4000) } : m))
  }
  return out
}

function commit(msgs, reply) {
  hist.length = 0
  for (const m of msgs) hist.push(m)
  if (reply != null) hist.push({ role: 'assistant', content: reply })
  saveSession()
}

// ── персист истории сессии ────────────────────────────────────
// Атомарная запись через tmp+rename: обрыв посреди записи не рвёт файл.
function saveSession() {
  if (!SESSION_ENABLED || process.env.YADRO_TASK) return
  try {
    const msgs = hist.length > SESSION_MAX_MSGS ? hist.slice(-SESSION_MAX_MSGS) : hist
    const payload = {
      version: 1, session: SESSION_ID, saved_at: new Date().toISOString(),
      cwd: CWD, model: MODEL, messages: msgs,
    }
    mkdirSync(dirname(SESSION_FILE), { recursive: true })
    const tmp = SESSION_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8')
    renameSync(tmp, SESSION_FILE)
  } catch (e) { logLine(new Date().toISOString() + ' session-save-err ' + S(e.message || e)) }
}

function loadSession() {
  if (!SESSION_ENABLED || process.env.YADRO_TASK) return 0
  try {
    if (!existsSync(SESSION_FILE)) return 0
    const p = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    if (!Array.isArray(p.messages) || !p.messages.length) return 0
    const ageH = (Date.now() - new Date(p.saved_at).getTime()) / 3600000
    // Старше TTL — не тащим: устаревший контекст хуже пустого.
    if (!(ageH >= 0) || ageH > SESSION_TTL_H) {
      logLine(`${new Date().toISOString()} session-expired ageH=${ageH.toFixed(1)}`)
      return 0
    }
    for (const m of p.messages.slice(-SESSION_MAX_MSGS)) hist.push(m)
    return hist.length
  } catch (e) {
    logLine(new Date().toISOString() + ' session-load-err ' + S(e.message || e))
    return 0
  }
}

// ── учёт токенов (11.11) ──────────────────────────────────────
function resetRunUsage() { runUsage.in = 0; runUsage.out = 0; runUsage.calls = 0 }
function addUsage(inT, outT) {
  const i = Number(inT) || 0, o = Number(outT) || 0
  if (!i && !o) return
  runUsage.in += i; runUsage.out += o; runUsage.calls++
  health.tokens_in = (health.tokens_in || 0) + i
  health.tokens_out = (health.tokens_out || 0) + o
  try {
    writeFileSync(USAGE_FILE, JSON.stringify({
      at: new Date().toISOString(), model: MODEL, in: i, out: o,
      run_in: runUsage.in, run_out: runUsage.out, cwd: CWD,
    }) + '\n', { flag: 'a', encoding: 'utf-8' })
  } catch {}
}

// ── чекпоинт правок и откат ──────────────────────────────────
// `git stash create` делает снимок рабочего дерева, НЕ трогая его и не создавая
// запись в stash-листе. Откат — checkout снимка + удаление появившихся после него
// неотслеживаемых файлов. Не git-каталог → чекпоинта нет, честно сообщаем.
function gitOut(cmd) {
  try { return String(execSync(cmd, { cwd: CWD, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }) || '') }
  catch { return '' }
}

function checkpoint(reason) {
  if (!CHECKPOINT_ENABLED) return null
  if (gitOut('git rev-parse --is-inside-work-tree').trim() !== 'true') return null
  try {
    const sha = gitOut('git stash create').trim()
    const untracked = gitOut('git ls-files --others --exclude-standard').split('\n').filter(Boolean)
    const rec = { at: new Date().toISOString(), cwd: CWD, reason, sha, untracked }
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(rec, null, 2), 'utf-8')
    logLine(`${new Date().toISOString()} checkpoint ${sha ? sha.slice(0, 8) : 'clean'} untracked=${untracked.length}`)
    return rec
  } catch (e) {
    logLine(new Date().toISOString() + ' checkpoint-err ' + S(e.message || e))
    return null
  }
}

let checkpointDone = false// Снимок ставится один раз за виток — перед первой правкой. Мельче не имеет
// смысла: откатывать надо виток целиком, а не каждый файл по отдельности.
function beforeMutation(reason) {
  if (checkpointDone) return null
  checkpointDone = true
  // Субагент и trap-eval работают в чужом каталоге и без человека рядом:
  // снимок там некому откатывать, а висячие stash-коммиты копятся в чужом репо.
  if (process.env.YADRO_TASK) return null
  const rec = checkpoint(reason)
  if (rec && !process.env.YADRO_TASK) {
    process.stdout.write(D + `⟲ чекпоинт: ${rec.sha ? rec.sha.slice(0, 8) : 'дерево чисто'} — /undo вернёт` + R + '\n')
  }
  return rec
}

function rollbackCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return 'чекпоинта нет — откатывать нечего'
  try {
    const rec = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
    if (rec.cwd && rec.cwd !== CWD) return `чекпоинт сделан в другом каталоге: ${rec.cwd}`
    const out = []
    if (rec.sha) {
      gitOut(`git checkout ${rec.sha} -- .`)
      out.push('рабочие файлы восстановлены из снимка ' + rec.sha.slice(0, 8))
    } else out.push('на момент чекпоинта изменений не было — файлы восстановлены самим git-состоянием')
    const before = new Set(rec.untracked || [])
    const now = gitOut('git ls-files --others --exclude-standard').split('\n').filter(Boolean)
    const fresh = now.filter((f) => !before.has(f))
    for (const f of fresh) { try { unlinkSync(resolve(CWD, f)) } catch {} }
    if (fresh.length) out.push('удалены созданные после снимка: ' + fresh.join(', '))
    out.push('снимок от ' + rec.at)
    logLine(`${new Date().toISOString()} rollback sha=${(rec.sha || '').slice(0, 8)} removed=${fresh.length}`)
    return out.join('\n')
  } catch (e) { return 'откат не удался: ' + S(e.message || e) }
}

// ── компакция контекста (a0-5): суммаризация вместо обрезки ────
const COMPACT_TRIGGER = parseInt(process.env.YADRO_COMPACT_TRIGGER || String(Math.round(CTX_BUDGET * 0.9)), 10)
async function summarizeMessages(msgs) {
  const convo = msgs.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Агент'}: ${clip(S(m.content), 2000)}`).join('\n')
  try {
    const ctrl = new AbortController()
    const tm = setTimeout(() => { try { ctrl.abort() } catch {} }, 50000)
    const r = await fetch(gatewayFor(MODEL) + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTHZ, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: FALLBACK_MODEL, max_tokens: 1500, stream: false, thinking: { type: 'disabled' },
        system: 'Сожми историю рабочей сессии разработки в плотную маркированную сводку на русском. Сохрани: принятые решения, изменённые файлы и команды, открытые задачи, важные факты и ошибки. Только факты, без вступлений и воды.',
        messages: [{ role: 'user', content: 'Сожми предыдущий контекст:\n\n' + convo }],
      }),
      signal: ctrl.signal,
    })
    clearTimeout(tm)
    if (!r.ok) return null
    const d = await r.json().catch(() => null)
    if (!d) return null
    const txt = ((d.content || []).map((c) => (c && c.type === 'text' ? c.text : '')).join('')).trim()
    return txt || null
  } catch { return null }
}

// Держит контекст в бюджете: при превышении — сжимает середину в сводку,
// сохраняя первую постановку задачи и последние 4 сообщения. Фолбэк — жёсткая обрезка.
async function manageContext(msgs, force = false) {
  if (!force && sizeOf(msgs) <= COMPACT_TRIGGER) return msgs
  const head = msgs.slice(0, 1)
  const tail = msgs.slice(-4)
  const middle = msgs.slice(1, msgs.length - 4)
  if (middle.length >= 2) {
    startSpin('компакция контекста')
    const summary = await summarizeMessages(middle)
    stopSpin()
    if (summary) {
      const rebuilt = [...head, { role: 'user', content: '[Сводка раннего контекста]\n' + summary }, ...tail]
      process.stdout.write(D + `↳ контекст сжат: ${middle.length} сообщений → сводка (${summary.length} симв.)` + R + '\n')
      logLine(`${new Date().toISOString()} compact ${middle.length} msgs -> ${summary.length} chars`)
      return sizeOf(rebuilt) > CTX_BUDGET ? trimHistory(rebuilt) : rebuilt
    }
  }
  return trimHistory(msgs)
}

// ── шлюз ──────────────────────────────────────────────────────
let ABORT = null
let INTERRUPTED = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function chat(messages, attempt = 0, label = '', maxTokens = MAX_TOKENS) {
  const t0 = Date.now()
  beginWork()
  startSpin(label)
  ABORT = new AbortController()
  const timer = setTimeout(() => { try { ABORT.abort('timeout') } catch {} }, REQ_TIMEOUT)
  const effModel = cbEffectiveModel()
  if (effModel !== MODEL) process.stdout.write(YEL + `⚠ circuit breaker: перешёл на ${effModel}` + R + '\n')
  try {
    const r = await fetch(gatewayFor(effModel) + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTHZ, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify((() => { const b = { model: effModel, max_tokens: maxTokens, system: SYS + agentsDocs(), stream: true, messages }; if ((process.env.YADRO_THINKING || 'disabled') === 'disabled') b.thinking = { type: 'disabled' }; if (NATIVE_TOOLS) { b.tools = TOOL_DEFS; b.tool_choice = { type: 'auto' } } return b })()),
      signal: ABORT.signal,
    })
    if (!r.ok || !r.body) {
      stopSpin()
      health.requests_failed++
      cbOnFailure()
      const d = await r.json().catch(() => ({}))
      logLine(`${new Date().toISOString()} err http=${r.status} :: ${S(typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail || d.error || '')).slice(0, 400)}`)
      // 429 (временный rate-limit) ретраим как 5xx, но с бóльшей паузой: квота окном
      // обычно восстанавливается за секунды. Постоянное исчерпание — сообщение ниже (8.11).
      if ((r.status === 401 || r.status === 429 || r.status >= 500) && attempt < 2) {
        await sleep((r.status === 429 ? 4000 : 1500) * (attempt + 1))
        return chat(messages, attempt + 1, label, maxTokens)
      }
      const em = (r.status === 402 || r.status === 429)
        ? ('лимит/квота модели исчерпаны (HTTP ' + r.status + '): смените модель — /model justcode/claude-sonnet-5.5 — или подождите')
        : ('ошибка шлюза: ' + (d.detail || r.status))
      process.stdout.write('\n' + RD + em + R + '\n')
      return { text: '', stop: null, error: em }
    }
    const rd = r.body.getReader(), dec = new TextDecoder()
    let buf = '', full = '', stop = null, streamErr = null
    let usageIn = 0, usageOut = 0
    const nativeCalls = []
    while (true) {
      const { done, value } = await rd.read()
      if (done) break
      // heartbeat: любой пришедший байт = поток живой. Раньше touch() звался только
      // ПОСЛЕ завершения стрима → запрос дольше HEALTH_TIMEOUT (30с, напр. thinking
      // или медленный шлюз) ложно триггерил WATCHDOG и kill-loop. Корень вылетов терминала.
      touch()
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop()
      for (const p of parts) {
        for (const line of p.split('\n')) {
          if (!line.startsWith('data:')) continue
          let ev
          try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            const chunk = ev.delta.text || ''
            full += chunk
          } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta') {
            // thinking-режим (фолбэк-модели типа deepseek-v4-flash гоняют рассуждение):
            // игнорируем дельты мышления — ждём text_delta. Раньше движок не знал этот тип
            // и молча висел, пока thinking упирался в max_tokens → WATCHDOG. Корень crash-loop.
          } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
            // Нативный режим: вызов приходит структурой, а не текстом.
            nativeCalls[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: '' }
          } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'input_json_delta') {
            const slot = nativeCalls[ev.index]
            if (slot) slot.json += ev.delta.partial_json || ''
          } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
            // Входные токены приходят один раз в начале сообщения.
            usageIn = Number(ev.message.usage.input_tokens) || usageIn
          } else if (ev.type === 'message_delta' && ev.usage) {
            usageOut = Number(ev.usage.output_tokens) || usageOut
          } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
            stop = ev.delta.stop_reason
          } else if (ev.type === 'error') {
            streamErr = S((ev.error && ev.error.message) || ev.error || 'ошибка потока')
          }
        }
      }
    }
    stopSpin()
    const elapsed = Date.now() - t0
    touch()
    health.requests_total++
    addUsage(usageIn, usageOut)
    cbOnSuccess()
    if (stop === 'max_tokens') health.requests_truncated++
    
    if (stop === 'max_tokens') {
      logLine(`${new Date().toISOString()} WARN stop=max_tokens ms=${elapsed} model=${MODEL} maxTokens=${maxTokens}`)
      process.stdout.write(YEL + `⚠ ответ модели обрезан лимитом вывода ${maxTokens} токенов` + R + '\n')
    } else {
      logLine(`${new Date().toISOString()} ok ms=${elapsed} model=${MODEL} stream stop=${stop || '-'}${streamErr ? ' streamErr=' + streamErr.slice(0, 120) : ''}`)
    }
    
    full = normalizeDSML(full)
    const toolCalls = NATIVE_TOOLS
      ? nativeCalls.filter(Boolean).map((c) => {
        let input = {}
        try { input = c.json ? JSON.parse(c.json) : {} } catch (e) { logLine(`${new Date().toISOString()} native-json-err ${c.name} :: ${S(c.json).slice(0, 120)}`) }
        return { id: c.id, name: c.name, input }
      })
      : []
    return { text: full, stop, error: streamErr, truncated: stop === 'max_tokens', toolCalls }
  } catch (e) {
    stopSpin()
    const wasAbort = ABORT && ABORT.signal.aborted
    touch()
    health.requests_failed++
    cbOnFailure()
    health.last_error = S(e.message || e).slice(0, 200)
    logLine(`${new Date().toISOString()} err ms=${Date.now() - t0} ${wasAbort ? 'abort:' : ''}${S(e.message || e)}`)
    if (INTERRUPTED) return { text: '', stop: null, error: null, interrupted: true }
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1))
      return chat(messages, attempt + 1, label, maxTokens)
    }
    const em = wasAbort
      ? `шлюз не ответил за ${Math.round(REQ_TIMEOUT / 1000)} с (повторов: ${attempt}) — проверь FCC на 8082 или повтори`
      : 'сеть: ' + S(e.message || e)
    process.stdout.write('\n' + RD + em + R + '\n')
    return { text: '', stop: null, error: em }
  } finally {
    clearTimeout(timer)
    ABORT = null
    endWork()
  }
}

// ── парсинг tool-блоков ───────────────────────────────────────
// ── нормализация DSML-токенов (flash недетерминированно оборачивает tool-call
// в <｜｜DSML｜｜ ...> вместо <function_calls>; имя и параметры сохраняются) ──
function normalizeDSML(t) {
  return S(t).replace(/<(\/?)[|｜]{1,2}\s*DSML\s*[|｜]{1,2}\s*(calls|invoke|parameter)/gi,
    (_, slash, tag) => '<' + slash + (tag.toLowerCase() === 'calls' ? 'function_calls' : tag.toLowerCase()))
}

function extractToolBlocks(text) {
  const blocks = []
  let depth = 0, start = -1, buf = ''
  const lines = S(text).split('\n')
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/<(?:antml:)?function_calls>/i.test(line)) {
      if (depth === 0) { start = i; buf = '' }
      depth++
    }
    if (depth > 0) buf += line + '\n'
    if (/<\/(?:antml:)?function_calls>/i.test(line)) {
      depth--
      if (depth === 0 && start >= 0) {
        blocks.push({ raw: buf.trim(), lineStart: start, lineEnd: i })
        buf = ''
        start = -1
      }
    }
  }
  
  if (depth > 0 && start >= 0) {
    blocks.push({ raw: buf.trim(), lineStart: start, lineEnd: lines.length - 1, incomplete: true })
  }
  

  // fallback (a0-4): модель прислала <invoke> без обёртки <function_calls>
  if (!blocks.length) {
    const full = S(text)
    const re = /<(?:antml:)?invoke\s+name="[^"]+"[^>]*>[\s\S]*?<\/(?:antml:)?invoke>/gi
    let m
    while ((m = re.exec(full)) !== null) {
      blocks.push({ raw: '<function_calls>' + m[0] + '</function_calls>', lineStart: -1, lineEnd: -1 })
    }
    if (!blocks.length && /<(?:antml:)?invoke\s+name="[^"]+"[^>]*>/i.test(full) && !/<\/(?:antml:)?invoke>/i.test(full)) {
      blocks.push({ raw: full.slice(full.search(/<invoke/i)), lineStart: -1, lineEnd: -1, incomplete: true })
    }
  }

  return blocks
}

function parseToolBlock(xml) {
  // [^>]* после имени: flash в DSML-режиме шлёт <parameter name="command" string="true">,
  // строгий «">» сразу после имени не матчился → флуд «нет параметра command» (8.11).
  const invokeRe = /<(?:antml:)?invoke\s+name="([^"]+)"[^>]*>/i
  const m = invokeRe.exec(xml)
  if (!m) return null
  const name = m[1]
  const params = {}
  const paramRe = /<(?:antml:)?parameter\s+name="([^"]+)"[^>]*>([^]*?)<\/(?:antml:)?parameter>/gi
  let pm
  while ((pm = paramRe.exec(xml)) !== null) {
    params[pm[1]] = pm[2].trim()
  }
  return { name, params }
}

// ── карточки tool-call (a0-6) ─────────────────────────────────
function toolIcon(n) {
  // web_get/web_query — имена нативного режима, показываем те же значки.
  return ({ bash: '$', read: '▤', write: '✎', edit: '✎', ls: '▸', grep: '⌕', glob: '⌕', web_fetch: '⤓', web_get: '⤓', web_search: '⌕', web_query: '⌕', mcp: '⚙', connectors: '⚙', todo: '☑' })[n] || '•'
}
function toolParamHint(n, p) {
  if (!p) return ''
  if (n === 'bash') return clip(S(p.command || p.cmd), 60)
  if (n === 'read' || n === 'write' || n === 'edit' || n === 'ls') return S(p.path || '')
  if (n === 'grep' || n === 'glob') return S(p.pattern || p.glob || p.query || '')
  if (n === 'web_fetch' || n === 'web_get') return S(p.url || '')
  if (n === 'web_search' || n === 'web_query') return S(p.query || p.q || '')
  if (n === 'mcp') return `${S(p.server)} ${S(p.action || 'tools')}${p.tool ? ' ' + p.tool : ''}`.trim()
  if (n === 'todo') return S(p.action || 'show')
  return ''
}
// Повторы одного и того же вызова сворачиваем в одну строку со счётчиком:
// иначе стена одинаковых `bash · npx jest` занимает весь экран (08.11).
let printedKey = ''
let printedCount = 0

function printToolCard(nm, params, res, ok, ms) {
  const dur = Number.isFinite(ms) ? ` · ${ms < 1000 ? Math.round(ms) + ' мс' : (ms / 1000).toFixed(1) + ' с'}` : ''
  // Правка невидима — человек не понимает, что изменилось. Показываем пару строк диффа.
  if (nm === 'edit' && params && (params.old || params.oldText)) {
    const o = S(params.old || params.oldText).split('\n')
    const n = S(params.new || params.newText || '').split('\n')
    process.stdout.write(`${ok ? L : RD}✎ edit${R}${D} · ${S(params.path || '')}${dur}${R}\n`)
    for (const line of o.slice(0, 3)) process.stdout.write(`${RD}  − ${line.slice(0, 120)}${R}\n`)
    for (const line of n.slice(0, 3)) process.stdout.write(`${L}  + ${line.slice(0, 120)}${R}\n`)
    if (o.length + n.length > 6) process.stdout.write(`${D}  … ещё ${o.length + n.length - 6} строк${R}\n`)
    return
  }

  const hint = toolParamHint(nm, params)
  const key = nm + '|' + JSON.stringify(params || {})
  const same = key === printedKey
  printedKey = key
  printedCount = same ? printedCount + 1 : 1

  if (same && printedCount > 1) {
    process.stdout.write(`${D}  ↺ то же самое ×${printedCount}${R}\n`)
    return
  }
  const head = `${ok ? L : RD}${toolIcon(nm)} ${nm}${R}${hint ? D + ' · ' + hint + R : ''}${D}${dur}${R}`
  const first = S(res).split('\n')[0].slice(0, 140)
  process.stdout.write(`${head}\n${D}  ↳ ${first}${R}\n`)
}

// ── выполнение инструментов ───────────────────────────────────
// ── двойной апрув на нагрузочные тесты (PIXEL.md §7) ──────────
// Текстового правила мало: команда с ab/wrk/hey без кодового слова не выполняется.
let stressAt = 0
// Инструмент должен стоять в начале команды (или после ; && |), а не быть аргументом:
// иначе `grep ab file` ложно блокировался.
const STRESS_RE = /(^|[;&|]\s*)(ab|wrk|hey|vegeta|siege|slowloris|hping3?|jmeter|k6|autocannon)\s/i

// Экранирование одного аргумента для шелла (имена файлов, пути).
function shq(x) { return "'" + String(x).replace(/'/g, "'\\''") + "'"; }

async function runBash(cmd) {
  if (STRESS_RE.test(cmd) && Date.now() - stressAt > 15 * 60 * 1000) {
    return 'ОТКАЗ: нагрузочный тест требует двойного подтверждения.\n'
      + 'Порядок: 1) согласуй план (цель, лимиты, окно, стоп-условия); '
      + '2) Сергей пишет в чат «☣️ ПОДЖИГАЙ» — и только тогда повтори команду.\n'
      + 'Только свои проекты: Ядро, fridaybot, switchnote, beep, VPN.'
  }
  beginWork()
  return new Promise((res) => {
    const child = spawn('/bin/bash', ['-c', cmd], { cwd: CWD, timeout: BASH_TIMEOUT })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d.toString('utf-8') })
    child.stderr.on('data', (d) => { err += d.toString('utf-8') })
    child.on('close', (code) => {
      const raw = (out + err).trim()
      const full = filterBashOutput(raw)
      endWork()
      res(code === 0 ? (full || '(без вывода)') : `ошибка bash exit=${code}\n${full}`)
    })
    child.on('error', (e) => { endWork(); res(`ошибка запуска bash: ${e.message}`) })
  })
}

// ── MCP-коннекторы: stdio JSON-RPC клиент (a0-2) ──────────────
let _mcpServersCache = null
function mcpServers() {
  if (_mcpServersCache) return _mcpServersCache
  try {
    const RESOLVER = `node -e 'require("/root/orencode/services/mcp").mcpServersDb().then(r=>process.stdout.write(JSON.stringify(r.servers||[]))).catch(()=>process.stdout.write("[]"))'`
    const out = execSync(RESOLVER, { timeout: 15000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 })
    _mcpServersCache = JSON.parse(out || '[]')
  } catch (e) { _mcpServersCache = [] }
  return Array.isArray(_mcpServersCache) ? _mcpServersCache : []
}

// Один короткоживущий stdio-сеанс: initialize → notifications/initialized → method
function mcpStdioCall(def, method, params, timeoutMs = 25000) {
  return new Promise((res) => {
    let child
    try {
      child = spawn(def.command, def.args || [], {
        env: { ...process.env, ...(def.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) { return res({ error: 'spawn: ' + S(e.message) }) }
    let buf = '', stderr = '', done = false
    const timer = setTimeout(() => finish({ error: `таймаут MCP ${timeoutMs}ms` }), timeoutMs)
    function finish(r) {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      res(r)
    }
    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n') } catch {} }
    child.stdout.on('data', (d) => {
      buf += d.toString('utf-8')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method, params: params || {} })
        } else if (msg.id === 2) {
          if (msg.error) finish({ error: S(msg.error.message || JSON.stringify(msg.error)) })
          else finish({ result: msg.result })
        }
      }
    })
    child.stderr.on('data', (d) => { stderr += d.toString('utf-8') })
    child.on('error', (e) => finish({ error: 'proc: ' + S(e.message) }))
    child.on('close', () => finish({ error: 'сервер закрылся' + (stderr ? ': ' + stderr.slice(0, 200) : '') }))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'yadro-agent', version: '1' } } })
  })
}

// ── план / список задач (a0-3) ────────────────────────────────
// План переживает перезапуск: 08.11 агент трижды терял todo при рестарте сессии
// и начинал работу заново. Пишем на диск после каждого изменения, читаем при старте.
const PLAN_FILE = join(ROOT, 'data', 'yadro-plan.json')

function savePlan() {
  try {
    mkdirSync(dirname(PLAN_FILE), { recursive: true })
    writeFileSync(PLAN_FILE, JSON.stringify({ todos, updated_at: new Date().toISOString() }, null, 1))
  } catch (_) { /* план не критичен для работы */ }
}

function loadPlan() {
  try {
    if (!existsSync(PLAN_FILE)) return []
    const j = JSON.parse(readFileSync(PLAN_FILE, 'utf-8'))
    const list = Array.isArray(j) ? j : (j && j.todos) || []
    return list.filter((t) => t && typeof t.text === 'string').map((t) => ({ text: t.text, done: !!t.done }))
  } catch (_) { return [] }
}

let todos = loadPlan()
function renderTodosPlain() {
  if (!todos.length) return '(план пуст)'
  return todos.map((t, i) => `${t.done ? '[x]' : '[ ]'} ${i + 1}. ${t.text}`).join('\n')
}
function printTodos() {
  if (!todos.length) return
  const done = todos.filter((t) => t.done).length
  process.stdout.write('\n' + L + `━━ план (${done}/${todos.length}) ━━` + R + '\n')
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i]
    const box = t.done ? (L + '☑' + R) : (D + '☐' + R)
    const txt = t.done ? (D + t.text + R) : t.text
    process.stdout.write(`${box} ${D}${i + 1}.${R} ${txt}\n`)
  }
  process.stdout.write('\n')
}

// Защита от зацикливания на одном вызове: агент повторял `npx jest` десятки раз,
// получая ту же ошибку и не меняя подход (08.11). Считаем повторы подряд по name+args:
// третий одинаковый — не выполняем, а говорим модели прямо, что результат не изменится.
let repeatKey = ''
let repeatCount = 0

function printBanner() {
  const v = existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf-8').trim() : 'unknown'
  // Спрайт Space Invaders в half-block: 11×8 пикселей → 11×4 символа, всё в рамке.
  const sprite = [
    '00100000100', '00010001000', '00111111100', '01101110110',
    '11111111111', '10111111101', '10100000101', '00011011000',
  ]
  const hb = { '00': ' ', '10': '▀', '01': '▄', '11': '█' }
  const mono = []
  for (let i = 0; i < sprite.length; i += 2) {
    mono.push(Array.from({ length: sprite[0].length }, (_, j) => hb[sprite[i][j] + sprite[i + 1][j]]).join(''))
  }
  const info = ['Пиксель v' + v, MODEL, CWD]
  const SW = 12, IW = 28
  const pad = (x, n) => S(x).padEnd(n, ' ')
  const VIOLET = '\x1b[95m'
  // Рамку строим по фактической длине строки — иначе правый угол съезжает.
  const body = mono.map((m, i) => ' ' + VIOLET + pad(m, SW) + R + D + pad(info[i] || '', IW) + R + ' ')
  const inner = body[0].replace(/\x1b\[[0-9;]*m/g, '').length
  const head = ('─ Пиксель v' + v + ' ').padEnd(inner, '─')
  process.stdout.write('\n' + L + '╭' + head + '╮' + R + '\n')
  for (const line of body) process.stdout.write(L + '│' + line + '│' + R + '\n')
  process.stdout.write(L + '╰' + '─'.repeat(inner) + '╯' + R + '\n\n')
}

// Ошибки, которые имеет смысл повторить: они про окружение, а не про логику вызова.
const ENV_ERROR_RE = /ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout|таймаут|no such file|не найден файл|connection refused/i
function isEnvError(text) {
  const t = String(text || '')
  return t.startsWith('ошибка') && ENV_ERROR_RE.test(t) && !/нет параметра|некорректн|неверн/i.test(t)
}

// ── детектор правки проверок (09.11.2026) ────────────────────
// Класс провала: агенту не хватает контекста, и он правит СВОИ ЖЕ тесты/спеки, чтобы «зелёное»
// сошлось. Запрещать нельзя (иногда тест правда устарел), но молчать нельзя: это стоп-сигнал.
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|__specs__)\//i
const TEST_FILE_RE = /\.(test|spec)\.[a-z0-9]+$/i

function testTamper() {
  try {
    const out = execFileSync('git', ['-C', CWD, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 8000 })
    const files = out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
    return files.filter((f) => TEST_PATH_RE.test(f) || TEST_FILE_RE.test(f))
  } catch { return [] }
}

function warnIfTestsTouched(answer) {
  const files = testTamper()
  if (!files.length) return false
  const mentioned = /тест|spec|проверк/i.test(String(answer || ''))
  health.tests_touched = (health.tests_touched || 0) + 1
  if (mentioned) return false
  process.stdout.write(`${YEL}\n⚠ за прогон изменены проверки, но в ответе об этом ни слова:\n  ${files.slice(0, 6).join('\n  ')}\n  Скажи прямо, что и зачем поменял в тестах.${R}\n`)
  logLine(`${new Date().toISOString()} tests-touched-silently :: ${files.slice(0, 6).join(', ')}`)
  return true
}

// ── гейт деструктива ─────────────────────────────────────────
// Список намеренно узкий и явный: лучше спросить лишний раз, чем один раз не спросить.
const DANGER = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\//, 'удаление каталога'],
  [/\brm\s+-rf\b/, 'rm -rf'],
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, 'удаление в базе'],
  [/\bTRUNCATE\s+TABLE\b/i, 'очистка таблицы'],
  [/\bgit\s+reset\s+--hard\b/, 'сброс рабочей копии'],
  [/\bgit\s+clean\s+-[a-z]*[fd]/, 'удаление неотслеживаемых файлов'],
  [/\bgit\s+push\s+(-f\b|--force)/, 'force-push'],
  [/\bmkfs(\.|\s)/, 'форматирование'],
  [/\bdd\s+[^|]*of=\/dev\//, 'запись на устройство'],
  [/\bshutdown\b|\breboot\b|\bhalt\b/, 'выключение/перезагрузка'],
  [/\bsystemctl\s+(stop|disable|mask)\s+(nginx|postgres|ssh|pm2)/, 'остановка системного сервиса'],
  [/\bkill\s+-9\s+1\b|\bpkill\s+-9\b/, 'жёсткое убийство процессов'],
  [/\bchmod\s+777\s+\//, 'права на корень'],
  [/\bpm2\s+delete\s+all\b/, 'удаление всех процессов pm2'],
]

function dangerOf(cmd) {
  const c = String(cmd || '')
  for (const [re, why] of DANGER) if (re.test(c)) return 'похоже на: ' + why
  return ''
}

// Вопрос человеку. Ключевая тонкость: readline уже обслуживает REPL, и вложенный
// input.question() внутри обработчика 'line' конфликтует с ним — вопрос не рисуется,
// ответ не доходит (поймано живьём 09.11: агент молча повторял rm -rf по кругу).
// Поэтому не задаём вопрос сами, а отдаём ожидание в общий обработчик строки.
let pendingConfirm = null
function askHuman(question, timeoutMs = 300000) {
  if (!stdin.isTTY) return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(t)
      pendingConfirm = null
      resolve(v)
    }
    const t = setTimeout(() => finish(false), timeoutMs)
    pendingConfirm = { finish }
    process.stdout.write('\n' + YEL + question + R)
  })
}

async function runTool(block) {
  health.tool_calls_total++
  if (block.incomplete) {
    logLine(`${new Date().toISOString()} tool-err incomplete tool-call block (stop=max_tokens), requesting retry`)
    return 'ошибка: tool-call оборван (stop=max_tokens). Повтори вызов инструмента полностью.'
  }
  
  const call = block.native ? { name: block.native.name, params: block.native.input || {} } : parseToolBlock(block.raw)
  if (!call) return 'ошибка: не удалось разобрать tool-call'
  
  const { name: rawName, params } = call
  // Нативный режим не может отдавать имена web_fetch/web_search (их перехватывает FCC),
  // поэтому в схеме они называются web_get/web_query, а здесь сводятся к обычным.
  const name = rawName === 'web_get' ? 'web_fetch' : rawName === 'web_query' ? 'web_search' : rawName

  usedTools.add(name)   // какие инструменты реально работали в этой задаче (для сторожа доказательств)
  if (name === 'read' && params.path) { try { usedPaths.add(resolve(CWD, params.path)) } catch {} }
  // Повторное чтение того же файла возвращало то же содержимое без пометки —
  // и модель считала, что прочитала ВТОРОЙ файл (флак 4-conflict). Теперь
  // на повтор отдаём явную пометку и список соседей, которые ещё не открыты.
  if (name === 'read' && params.path) {
    try {
      const abs = resolve(CWD, params.path)
      if (readCache.has(abs)) {
        let siblings = []
        try {
          siblings = readdirSync(dirname(abs)).filter((f) => !usedPaths.has(resolve(dirname(abs), f))).slice(0, 8)
        } catch {}
        logLine(`${new Date().toISOString()} read-dup ${abs}`)
        return readCache.get(abs)
          + '\n[ПОВТОР: этот файл уже прочитан в этом витке, содержимое выше — его же. '
          + (siblings.length ? 'Ещё не открыты в каталоге: ' + siblings.join(', ') + '. Прочитай их, если они нужны.' : 'Других неоткрытых файлов в каталоге нет.')
          + ']'
      }
    } catch {}
  }
  const callKey = name + '|' + JSON.stringify(params || {})
  if (callKey === repeatKey) repeatCount++; else { repeatKey = callKey; repeatCount = 1 }
  if (repeatCount >= 3) {
    logLine(`${new Date().toISOString()} repeat-guard ${name} x${repeatCount}`)
    return `СТОП: этот же вызов уже выполнен ${repeatCount - 1} раз(а) подряд и дал тот же результат. `
      + 'Повтор ничего не изменит. Смени подход: проверь путь/cwd, прочитай ошибку целиком, '
      + 'либо честно скажи, что задача не решается этим способом, и предложи другой.'
  }

  try {
    if (name === 'bash') {
      const cmd = params.command || params.cmd
      if (!cmd) return 'ошибка bash: нет параметра command'
      // Детерминированный гейт (harness P0, 09.11.2026). Раньше подтверждение просилось
      // «напиши ВЫПОЛНИТЬ в ответе» — но это же слово пишет сама модель, то есть гейта не было.
      // Теперь спрашиваем человека в терминале. Нет TTY — отказ (fail-closed), без исключений.
      const danger = dangerOf(cmd)
      if (danger) {
        const ok = await askHuman(`⚠ ${danger}\n\n${cmd.slice(0, 400)}\n\nВыполнить? [y/N] `)
        if (!ok) {
          logLine(`${new Date().toISOString()} danger-denied :: ${cmd.slice(0, 160)}`)
          return 'отказ: команда не выполнена — подтверждение не получено'
        }
        logLine(`${new Date().toISOString()} danger-approved :: ${cmd.slice(0, 160)}`)
      }
      const r = await runBash(cmd)
      return clip(r, TOOL_OUTPUT_CLIP)
    }
    
    if (name === 'read') {
      const path = params.path
      if (!path) return 'ошибка read: нет параметра path'
      const abs = resolve(CWD, path)
      if (!existsSync(abs)) return `ошибка read: файл не найден — ${path}`
      const content = readFileSync(abs, 'utf-8')
      const body = clip(content, TOOL_OUTPUT_CLIP)
      try { readCache.set(abs, body) } catch {}
      return body
    }
    
    if (name === 'write') {
      const path = params.path
      const content = params.content || ''
      if (!path) return 'ошибка write: нет параметра path'
      const cp = beforeMutation('write ' + path)
      const abs = resolve(CWD, path)
      const dir = dirname(abs)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(abs, content, 'utf-8')
      return `записано ${content.length} байт → ${path}`
    }
    
    if (name === 'edit') {
      const path = params.path
      const oldText = params.oldText || params.old
      const newText = params.newText || params.new
      if (!path || !oldText) return 'ошибка edit: нужны path и oldText'
      const cp = beforeMutation('edit ' + path)
      const abs = resolve(CWD, path)
      if (!existsSync(abs)) return `ошибка edit: файл не найден — ${path}`
      let content = readFileSync(abs, 'utf-8')
      if (!content.includes(oldText)) return `ошибка edit: oldText не найден в ${path}`
      content = content.replace(oldText, newText || '')
      writeFileSync(abs, content, 'utf-8')
      return `изменено в ${path}`
    }
    
    if (name === 'ls') {
      const path = params.path || '.'
      const abs = resolve(CWD, path)
      if (!existsSync(abs)) return `ошибка ls: путь не найден — ${path}`
      const stat = statSync(abs)
      if (stat.isFile()) return `${basename(abs)} (файл)`
      const items = readdirSync(abs).slice(0, 200)
      return items.join('\n') + (items.length === 200 ? '\n…(обрезано до 200)' : '')
    }
    
    if (name === 'grep') {
      const pattern = params.pattern || params.query
      const path = params.path || '.'
      if (!pattern) return 'ошибка grep: нет параметра pattern'
      const abs = resolve(CWD, path)
      const cmd = `grep -rn "${pattern.replace(/"/g, '\\"')}" "${abs}" 2>/dev/null | head -50`
      const r = await runBash(cmd)
      return clip(r, TOOL_OUTPUT_CLIP)
    }
    
    if (name === 'glob') {
      const pattern = S(params.pattern || params.glob).trim()
      if (!pattern) return 'ошибка glob: нет параметра pattern'
      if (/[`$;|&<>()]/.test(pattern)) return 'ошибка glob: недопустимые символы в pattern'
      const cmd = `shopt -s globstar nullglob dotglob 2>/dev/null; n=0; for f in ${pattern}; do [ -e "$f" ] && { echo "$f"; n=$((n+1)); }; [ $n -ge 300 ] && break; done`
      const r = await runBash(cmd)
      const t = S(r).trim()
      return (t && !t.startsWith('ошибка')) ? clip(t, TOOL_OUTPUT_CLIP) : '(нет совпадений)'
    }

    if (name === 'web_fetch') {
      const url = S(params.url).trim()
      if (!/^https?:\/\//i.test(url)) return 'ошибка web_fetch: нужен http(s) url'
      beginWork()
      try {
        const ctrl = new AbortController()
        const tm = setTimeout(() => { try { ctrl.abort() } catch {} }, 20000)
        const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'yadro-agent/1 (+orencode)' } })
        clearTimeout(tm)
        const ct = resp.headers.get('content-type') || ''
        let body = await resp.text()
        if (/html|xml/i.test(ct)) {
          body = body
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
        }
        return `HTTP ${resp.status} · ${ct}\n` + clip(body, TOOL_OUTPUT_CLIP)
      } catch (e) {
        return 'ошибка web_fetch: ' + (S(e.message).includes('abort') ? 'таймаут 20с' : S(e.message))
      } finally { endWork() }
    }

    if (name === 'web_search') {
      const q = S(params.query || params.q).trim()
      if (!q) return 'ошибка web_search: нет параметра query'
      beginWork()
      try {
        const ctrl = new AbortController()
        const tm = setTimeout(() => { try { ctrl.abort() } catch {} }, 20000)
        const resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; yadro-agent/1)' } })
        clearTimeout(tm)
        const html = await resp.text()
        const out = []
        const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
        let m
        while ((m = re.exec(html)) !== null && out.length < 8) {
          let url = m[1]
          const um = /[?&]uddg=([^&]+)/.exec(url)
          if (um) { try { url = decodeURIComponent(um[1]) } catch {} }
          const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          if (title) out.push(`• ${title}\n  ${url}`)
        }
        return out.length ? out.join('\n') : '(поиск не дал результатов или формат выдачи изменился)'
      } catch (e) {
        return 'ошибка web_search: ' + (S(e.message).includes('abort') ? 'таймаут 20с' : S(e.message))
      } finally { endWork() }
    }

    if (name === 'todo') {
      const action = params.action || 'show'
      if (action === 'set') {
        const raw = S(params.items || params.plan || '').trim()
        let items = []
        if (raw.startsWith('[')) { try { items = JSON.parse(raw).map(S) } catch { items = [] } }
        if (!items.length) items = raw.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)
        if (!items.length) return 'ошибка todo: пустой список (нужен параметр items)'
        todos = items.map((text) => ({ text, done: false }))
        savePlan()
        printTodos()
        return 'План сохранён:\n' + renderTodosPlain()
      }
      if (action === 'done') {
        const idx = parseInt(params.index || params.n || '', 10)
        if (!isNaN(idx) && todos[idx - 1]) todos[idx - 1].done = true
        else if (params.text) {
          const f = todos.find((t) => t.text.includes(params.text))
          if (f) f.done = true
          else return `ошибка todo: пункт не найден — ${params.text}`
        } else return 'ошибка todo: нужен параметр index или text'
        savePlan()
        printTodos()
        return 'Отмечено. Текущий план:\n' + renderTodosPlain()
      }
      if (action === 'show') return renderTodosPlain()
      if (action === 'clear') { todos = []; savePlan(); return 'план очищен' }
      return `ошибка todo: неизвестный action — ${action} (set|done|show|clear)`
    }

    // ── verify: факты вместо слова «готово» ──
    if (name === 'verify') return clip(await runVerify(), 4000)

    // ── delegate: тяжёлую подзадачу — отдельному агенту с чистым контекстом ──
    // Родитель получает только результат, история исследования остаётся у ребёнка.
    if (name === 'delegate') {
      if (process.env.YADRO_NO_DELEGATE) return 'отказ: вложенное делегирование запрещено (YADRO_NO_DELEGATE=1)'
      const task = S(params.task || '').trim()
      if (!task) return 'ошибка delegate: нужен параметр task'
      // Команда из данных (этап 7): состав и границы берём из teams/<id>.json,
      // а не выдумываем в промпте. Код один на все команды — новая команда
      // добавляется файлом, без правки этого места.
      let teamBrief = ''
      let teamId = ''
      if (params.chart) {
        const dir = process.env.YADRO_TEAMS_DIR || '/root/orencode/teams'
        const id = String(params.chart).replace(/[^a-z0-9-]/g, '')
        const file = join(dir, id + '.json')
        let chart
        try { chart = JSON.parse(readFileSync(file, 'utf8')); }
        catch (e) { return 'ошибка delegate: команда «' + id + '» не прочитана (' + e.message + ')' }
        const roles = Array.isArray(chart.roles) ? chart.roles : []
        const orch = roles.find((r) => r.kind === 'orchestrator')
        if (!orch) return 'ошибка delegate: в команде «' + id + '» нет координатора'
        teamId = id
        const lines = roles.map((r) => {
          const scope = Array.isArray(r.in_scope) && r.in_scope.length ? ' в работе: ' + r.in_scope.join(', ') + ';' : ''
          const out = Array.isArray(r.out_of_scope) && r.out_of_scope.length ? ' НЕ делает: ' + r.out_of_scope.join(', ') + '.' : ''
          return '- ' + r.name + (r.id === orch.id ? ' (координатор)' : '') + ': ' + S(r.brief || r.summary || '') + scope + out
        })
        teamBrief = 'Ты работаешь как команда «' + (chart.title || id) + '» (схема ' + id + ').\n'
          + 'Твоя роль — ' + orch.name + ': ' + S(orch.brief || orch.summary || '') + '\n'
          + 'Роли и границы:\n' + lines.join('\n') + '\n'
          + 'Правила: не разворачивай всех сразу — сначала пойми цель; границы ролей соблюдай буквально; '
          + 'секреты только из хранилища, в текст задачи их не переноси.\n'
          + 'Отчёт: по каждой роли — что сделано, чем подтверждено.\n\n'
      }
      const workDir = params.cwd ? resolve(CWD, String(params.cwd)) : CWD
      const steps = String(parseInt(params.max_steps || '30', 10) || 30)
      const AGENT = join(__dirname, 'yadro-agent.mjs')
      const started = Date.now()
      beginWork()
      return await new Promise((res) => {
        let out = ''
        const child = spawn('node', [AGENT], {
          cwd: workDir,
          env: {
            ...process.env,
            YADRO_TASK: teamBrief + 'ЦЕЛЬ: ' + task,
            YADRO_NO_DELEGATE: '1',          // глубина ровно один уровень
            YADRO_MAX_STEPS: steps,
            YADRO_CTX_BUDGET: process.env.YADRO_CTX_BUDGET || '120000',
          },
        })
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM') } catch (_) {}
          logLine(new Date().toISOString() + ' subagent-timeout ms=' + (Date.now() - started))
          res('субагент остановлен по таймауту 10 мин. Что успел:\n' + clip(out.trim(), 4000))
        }, 10 * 60 * 1000)
        child.stdout.on('data', (d) => { out += d.toString('utf-8') })
        child.stderr.on('data', (d) => { out += d.toString('utf-8') })
        child.on('error', (e) => { clearTimeout(timer); endWork(); res('ошибка запуска субагента: ' + e.message) })
        child.on('close', (code) => {
          clearTimeout(timer)
          endWork()
          const ms = Date.now() - started
          logLine(new Date().toISOString() + ' subagent ok=' + (code === 0) + ' ms=' + ms)
          // Трасса в Ядро: без неё делегирование — слепая зона по расходу и времени.
          if (teamId) {
            sendTrace({ chart: teamId, task: task.slice(0, 500), cwd: workDir, ok: code === 0, ms, steps }, 'team')
          } else {
            sendTrace({ task: task.slice(0, 500), cwd: workDir, ok: code === 0, ms, steps })
          }
          const head = code === 0 ? '' : ('субагент завершился с кодом ' + code + '\n')
          res(head + clip(out.trim() || '(без вывода)', 6000))
        })
      })
    }

    if (name === 'connectors') {
      const servers = mcpServers()
      if (!servers.length) return 'нет зарегистрированных MCP-коннекторов'
      return 'Доступные MCP-коннекторы:\n' + servers.map((s) => `• ${s.name} [${s.transport}]`).join('\n') + '\n\nДалее: mcp server=<имя> action=tools — список инструментов.'
    }

    if (name === 'mcp') {
      const server = params.server
      const action = params.action || 'tools'
      if (!server) return 'ошибка mcp: нужен параметр server (см. инструмент connectors)'
      const def = mcpServers().find((s) => s.name === server)
      if (!def) return `ошибка mcp: коннектор не найден — ${server} (см. connectors)`
      if (def.transport !== 'stdio') return `ошибка mcp: поддерживается только stdio-транспорт (у ${server}: ${def.transport})`
      beginWork()
      try {
        if (action === 'tools') {
          const r = await mcpStdioCall(def, 'tools/list', {})
          if (r.error) return `ошибка mcp(${server}): ${r.error}`
          const tools = (r.result && r.result.tools) || []
          if (!tools.length) return `(коннектор ${server} не вернул инструментов)`
          return `Инструменты ${server}:\n` + tools.map((t) => `• ${t.name} — ${clip(S(t.description), 140)}`).join('\n')
        }
        if (action === 'call') {
          const toolName = params.tool
          if (!toolName) return 'ошибка mcp: для action=call нужен параметр tool'
          let argObj = {}
          if (params.args) {
            try { argObj = JSON.parse(params.args) } catch { return 'ошибка mcp: параметр args должен быть JSON-объектом' }
          }
          const r = await mcpStdioCall(def, 'tools/call', { name: toolName, arguments: argObj })
          if (r.error) return `ошибка mcp(${server}.${toolName}): ${r.error}`
          const content = (r.result && r.result.content) || []
          const text = content.map((c) => (c && c.type === 'text' ? c.text : `[${c && c.type || 'data'}]`)).join('\n')
          return clip(text || JSON.stringify(r.result || {}), TOOL_OUTPUT_CLIP)
        }
        return `ошибка mcp: неизвестный action — ${action} (tools|call)`
      } finally { endWork() }
    }

    return `ошибка: неизвестный инструмент — ${name}`
  } catch (e) {
    return `ошибка ${name}: ${e.message}`
  }
}

// Инструменты, реально вызванные в текущей задаче. Нужны сторожу доказательств.
const usedTools = new Set()
// Какие файлы реально читались: сторож «сказал, что прочитал, а не читал».
// Флак 4-conflict (11.11): прочитал один файл из двух и объявил про оба.
const usedPaths = new Set()
const readCache = new Map()
let readClaimChecked = false

// ── ход агента ────────────────────────────────────────────────
async function handle(text) {
  usedTools.clear()
  usedPaths.clear()
  readCache.clear()
  readClaimChecked = false
  checkpointDone = false
  resetRunUsage()
  health.waiting_for_human = false
  let msgs = await manageContext(hist.concat([{ role: 'user', content: text }]))
  const cap = MAX_STEPS > 0 ? MAX_STEPS : Infinity
  let step = 0
  let stopped = ''
  
  for (; step < cap; step++) {
    if (INTERRUPTED) { stopped = 'прервано (Ctrl+C)'; break }
    
    const isToolStep = msgs[msgs.length - 1].role === 'user' && /tool-call оборван|Повтори вызов/i.test(msgs[msgs.length - 1].content)
    const maxTokens = isToolStep ? TOOL_MAX_TOKENS : MAX_TOKENS
    
    // Заполнение контекста видно ДО сжатия: иначе агент внезапно теряет нить.
    const ctxUsed = sizeOf(msgs)
    const ctxPct = Math.min(100, Math.round((ctxUsed / CTX_BUDGET) * 100))
    // Триггер делегирования: контекст пухнет — тяжёлое стоит отдать субагенту,
    // а не давить историю компрессией. Подсказываем один раз, не навязываем.
    if (ctxPct >= 70 && !process.env.YADRO_TASK && !globalThis.__delegateHinted) {
      globalThis.__delegateHinted = true
      process.stdout.write(`${D}· контекст ${ctxPct}% — тяжёлые подзадачи лучше через delegate (свежий контекст у ребёнка)${R}\n`)
    }
    if (ctxPct >= 80) {
      process.stdout.write(`${YEL}⚠ контекст ${ctxPct}% (${Math.round(ctxUsed / 1000)}k из ${Math.round(CTX_BUDGET / 1000)}k) — скоро сжатие${R}\n`)
    }
    const r = await chat(msgs, 0, 'шаг ' + (step + 1) + ' · ctx ' + ctxPct + '%', maxTokens)
    if (r.interrupted) { stopped = 'прервано (Ctrl+C)'; break }
    if (r.error) { stopped = 'ошибка шлюза: ' + r.error; break }
    
    const blocks = (NATIVE_TOOLS && r.toolCalls && r.toolCalls.length)
      ? r.toolCalls.map((t) => ({ raw: '', native: t, incomplete: false }))
      : extractToolBlocks(r.text)
    if (!blocks.length) {
      // Resume: обрыв на max_tokens без tool-call — продолжить ответ в том же витке
      if (r.truncated) {
        logLine(`${new Date().toISOString()} resume max_tokens (no tool-call), continue`)
        msgs.push({ role: 'assistant', content: r.text }, { role: 'user', content: '[Продолжи с того места, где остановился. Не повторяй уже написанное.]' })
        msgs = await manageContext(msgs)
        continue
      }
      const out = clean(r.text)
      warnIfTestsTouched(out)

      // Сторож чтения: в ответе названы файлы каталога, которые НЕ были прочитаны.
      // Значит модель достроила содержимое по одному образцу (так падала ловушка 4).
      if (!readClaimChecked) {
        try {
          const claimed = new Set()
          for (const m of (out.match(/[A-Za-z0-9_./-]+\.(?:txt|md|csv|json|jsonl|js|mjs|ts|vue|html|css|ya?ml|log|sh|py)\b/g) || [])) {
            const abs = resolve(CWD, m)
            if (existsSync(abs) && !usedPaths.has(abs)) claimed.add(m)
          }
          if (claimed.size) {
            readClaimChecked = true
            process.stdout.write(YEL + '⚠ в ответе файлы, которые не открывались: ' + [...claimed].join(', ') + ' — читаю' + R + '\n')
            logLine(`${new Date().toISOString()} read-claim-guard :: ${[...claimed].join(',')}`)
            msgs.push({ role: 'assistant', content: r.text },
                      { role: 'user', content: `[Прочитай эти файлы инструментом read и сверь содержимое: ${[...claimed].join(', ')}. Вывод, построенный на непрочитанных файлах, недействителен.]` })
            msgs = await manageContext(msgs)
            continue
          }
        } catch (e) { logLine(new Date().toISOString() + ' read-claim-guard err ' + String((e && e.message) || e)) }
      }
      // Явная эскалация: ответ закончился вопросом и инструментов больше нет —
      // значит агент ждёт человека, а не «просто печатает». Фиксируем состояние.
      if (/\?\s*$/.test(out.trim())) {
        health.questions_asked++
        health.waiting_for_human = true
        logLine(`${new Date().toISOString()} waiting-for-human (вопрос без tool-call)`)
      }
      // Сторож доказательств: утверждение «готово/исправлено/прошло» без единого
      // фактического шага (verify/bash/grep/read) — не доказательство. Собираем факты сами.
      const claims = /(готово|закоммит|исправил|починил|исправлено|тесты.*(прошл|зелён)|всё работает|проверено)/i.test(out)
      const hasEvidence = usedTools.has('verify') || usedTools.has('bash') || usedTools.has('grep') || usedTools.has('read')
      if (claims && !hasEvidence) {
        process.stdout.write(`${YEL}⚠ сказано «готово», но ни одной проверки не выполнено — собираю факты${R}\n`)
        try {
          const facts = await runVerify()
          process.stdout.write(facts + '\n')
          msgs.push({ role: 'assistant', content: r.text },
                    { role: 'user', content: '[Проверка выполнена. Если факты расходятся со сказанным — исправь вывод и назови расхождение.]' })
          msgs = await manageContext(msgs)
          continue
        } catch (e) { logLine(new Date().toISOString() + ' verify-guard err ' + String((e && e.message) || e)) }
      }
      // Вопрос — непустая строка, оканчивающаяся на «?». Лаймовые полосы убраны (8.11):
      // остаётся только текстовый маркер «нужен твой ответ».
      const needs = out.split('\n').some((l) => { const t = l.trim(); return t.length > 2 && /[?？]$/.test(t) })
      if (out) process.stdout.write('\n' + (needs ? (L + '── нужен твой ответ ──' + R + '\n') : '') + out + '\n\n')
      msgs.push({ role: 'assistant', content: r.text })
      commit(msgs)
      return
    }
    
    const results = []
    const nativeResults = []
    let hasIncomplete = false

    // Считать-только инструменты независимы друг от друга: три read подряд раньше
    // ждали по очереди, хотя модель уже выдала их одним витком (11.11).
    const PARALLEL_SAFE = new Set(['read', 'ls', 'grep', 'glob', 'web_fetch', 'web_search', 'connectors'])

    const execOne = async (b) => {
      const t0 = Date.now()
      let res = await runTool(b)
      // Ретрай только на класс «окружение»: файл не найден, таймаут, соединение.
      // Повторять ошибку логики (неверный аргумент) бессмысленно — модель должна переосмыслить.
      const nm = parseToolBlock(b.raw)?.name || '?'
      if (isEnvError(res) && !b.incomplete) {
        logLine(`${new Date().toISOString()} tool-retry name=${nm} :: ${res.slice(0, 120)}`)
        await new Promise((r2) => setTimeout(r2, 400))
        res = await runTool(b)
      }
      return { res, ms: Date.now() - t0 }
    }

    const reportCard = (b, res, ms) => {
      const call = b.native ? { name: b.native.name, params: b.native.input || {} } : parseToolBlock(b.raw)
      const nm = call ? call.name : '?'
      if (b.incomplete) hasIncomplete = true
      const bad = res.startsWith('ошибка')
      const st = (health.tool_stats[nm] = health.tool_stats[nm] || { calls: 0, errors: 0 })
      st.calls++
      printToolCard(nm, call ? call.params : null, res, !bad, ms)
      if (bad) { st.errors++; health.tool_errors_total++; logLine(`${new Date().toISOString()} tool-err name=${nm} :: ${res.slice(0, 200)}`) }
      results.push(`Результат tool ${nm}:\n${res}`)
      if (b.native) nativeResults.push({ type: 'tool_result', tool_use_id: b.native.id, content: res })
    }

    let bi = 0
    while (bi < blocks.length) {
      // Группа — подряд идущие безопасные блоки. Оборванный блок или мутирующий
      // инструмент прерывает группу: порядок правок менять нельзя.
      const group = []
      while (bi < blocks.length) {
        const b = blocks[bi]
        const call = parseToolBlock(b.raw)
        const nm = call ? call.name : '?'
        if (!call || b.incomplete || !PARALLEL_SAFE.has(nm)) break
        group.push(b)
        bi++
        if (group.length >= 6) break   // потолок: не бомбить диск десятками чтений
      }
      if (!group.length) { group.push(blocks[bi]); bi++ }

      const par = group.length > 1
      if (par) {
        startSpin(`параллельно ×${group.length}`)
        const outs = await Promise.all(group.map((b) => execOne(b)))
        stopSpin()
        group.forEach((b, k) => reportCard(b, outs[k].res, outs[k].ms))
      } else {
        const b = group[0]
        const call = parseToolBlock(b.raw)
        const nm = call ? call.name : '?'
        const hint = call ? toolParamHint(nm, call.params) : ''
        startSpin(`${nm}${hint ? ' · ' + hint : ''}`)
        const { res, ms } = await execOne(b)
        stopSpin()
        reportCard(b, res, ms)
      }
    }
    
    if (NATIVE_TOOLS && r.toolCalls && r.toolCalls.length && nativeResults.length === r.toolCalls.length) {
      // Нативный режим требует структуру: tool_use у ассистента, tool_result у пользователя.
      // Пустой массив tool_result шлюз отвергает 400 — поэтому только при полном наборе.
      const assistantContent = [{ type: 'text', text: r.text || ' ' }]
        .concat(r.toolCalls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })))
      msgs.push({ role: 'assistant', content: assistantContent }, { role: 'user', content: nativeResults })
    } else {
      msgs.push({ role: 'assistant', content: r.text }, { role: 'user', content: results.join('\n\n') })
    }
    msgs = await manageContext(msgs)
    
    if (hasIncomplete) {
      logLine(`${new Date().toISOString()} auto-retry incomplete tool-call`)
      continue
    }
  }
  
  commit(msgs)
  if (stopped) process.stdout.write(RD + stopped + R + ' — контекст сохранён, скажи «продолжай»\n')
  else process.stdout.write(YEL + 'остановился на шаге ' + MAX_STEPS + ' (потолок YADRO_MAX_STEPS) — скажи «продолжай»' + R + '\n')
}

// ── slash-команды ─────────────────────────────────────────────
async function handleSlash(cmd) {
  const [c, ...args] = cmd.split(/\s+/)
  
  // Кодовое слово для нагрузочного теста даёт право на 15 минут (§7 PIXEL.md).
  if (/ПОДЖИГАЙ|поджигай/i.test(c)) {
    stressAt = Date.now()
    process.stdout.write(YEL + '☣️ подтверждение принято: нагрузочные тесты разрешены на 15 минут.\n' + R)
    return
  }
  if (c === '/exit') { process.stdout.write(D + 'выход\n' + R); process.exit(0) }
  if (c === '/clear') {
    hist.length = 0; todos = []; savePlan()
    try { if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE) } catch {}
    process.stdout.write(D + 'история и план очищены\n' + R); return
  }
  if (c === '/undo') {
    process.stdout.write(D + rollbackCheckpoint() + '\n' + R); return
  }
  if (c === '/version') {
    const v = existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf-8').trim() : 'unknown'
    const cbLine = `Circuit breaker: ${cbState} (failures=${cbFailures}/${CB_THRESHOLD})${cbState !== 'CLOSED' ? ' → fallback ' + FALLBACK_MODEL : ''}`
    process.stdout.write(`ЯДРО × Пятница · OrenCode\nДвижок: yadro-agent v${v}\nМодель: ${MODEL}\n${cbLine}\nШагов: ${MAX_STEPS} · Таймаут bash: ${BASH_TIMEOUT}ms · Таймаут запроса: ${REQ_TIMEOUT}ms\nБюджет контекста: ${CTX_BUDGET} симв. · Обрезка вывода: ${TOOL_OUTPUT_CLIP} симв.\nMax tokens (стандарт): ${MAX_TOKENS} · Max tokens (write/bash): ${TOOL_MAX_TOKENS}\n`)
    return
  }
  if (c === '/model') {
    if (args[0]) {
      MODEL = args[0]
      process.env.YADRO_MODEL = args[0]
      try { mkdirSync(dirname(MODEL_FILE), { recursive: true }); writeFileSync(MODEL_FILE, args[0] + '\n') } catch (_) { /* не критично */ }
      process.stdout.write(D + `модель переключена на ${args[0]}\n` + R)
    } else {
      process.stdout.write(`текущая модель: ${MODEL}\n`)
    }
    return
  }
  
  if (c === '/help') {
    process.stdout.write(['Слэш-команды:',
      '/help — справка',
      '/tools — инструменты агента',
      '/connectors — MCP-коннекторы платформы',
      '/plan — текущий план (todo)',
      '/cwd [путь] — показать/сменить рабочую папку',
      '/compact — сжать контекст сейчас',
      '/model [имя] — показать/сменить модель',
      '/clear — очистить историю и план',
      '/version · /exit'].join('\n') + '\n')
    return
  }
  if (c === '/tools') {
    process.stdout.write('Инструменты: bash, read, write, edit, ls, grep, glob, web_fetch, web_search, connectors, mcp, todo\n')
    return
  }
  if (c === '/connectors') {
    const s = mcpServers()
    process.stdout.write((s.length ? 'MCP-коннекторы:\n' + s.map((x) => `• ${x.name} [${x.transport}]`).join('\n') : 'нет зарегистрированных коннекторов') + '\n')
    return
  }
  if (c === '/plan') { process.stdout.write(renderTodosPlain() + '\n'); return }
  if (c === '/cwd') {
    if (args[0]) {
      const target = resolve(CWD, args[0])
      if (!existsSync(target)) { process.stdout.write(RD + `нет такой папки: ${target}` + R + '\n'); return }
      CWD = target
      process.stdout.write(D + `рабочая папка: ${CWD}\n` + R)
    } else process.stdout.write(`рабочая папка: ${CWD}\n`)
    return
  }
  if (c === '/compact') {
    const n = hist.length
    const compacted = await manageContext(hist.slice(), true)
    hist.length = 0
    for (const m of compacted) hist.push(m)
    process.stdout.write(D + `контекст: ${n} → ${hist.length} сообщений\n` + R)
    return
  }

  process.stdout.write(RD + 'неизвестная команда: ' + cmd + R + '\n')
}

// ── сторож доказательств (Foreman-приём) ──────────────────────
// Правило verification-first у нас было только текстом в AGENTS.md, а код его не
// принуждал: агент говорил «готово», и это принималось на слово. Здесь — факты:
// git, синтаксис изменённых файлов, совпадение загруженного кода Ядра с HEAD и
// главная ловушка дня — живой процесс старше правки файла.
async function runVerify() {
  const out = []
  try {
    const st = String(await runBash('git status --porcelain 2>/dev/null | head -15')).trim()
    out.push('git: ' + (st ? st.split('\n').length + ' изменённых файлов\n' + st : 'рабочее дерево чисто'))
    const lg = String(await runBash('git log --oneline -1 2>/dev/null')).trim()
    if (lg) out.push('последний коммит: ' + lg)
  } catch (e) { out.push('git: ошибка — ' + e.message) }

  // Синтаксис изменённых .js/.mjs — дешёвая проверка, ловит опечатку до запуска.
  try {
    const chg = String(await runBash("git status --porcelain 2>/dev/null | awk '{print $NF}' | grep -E '\\.(js|mjs)$' | head -8")).trim()
    if (chg) {
      const bad = []
      for (const f of chg.split('\n')) {
        const r = String(await runBash('node --check ' + shq(f) + ' 2>&1 || echo "SYNTAX_FAIL"')).trim()
        if (r.includes('SYNTAX_FAIL')) bad.push(f)
      }
      out.push('синтаксис изменённых: ' + (bad.length ? 'ОШИБКА в ' + bad.join(', ') : 'ok (' + chg.split('\n').length + ' файлов)'))
    }
  } catch (_) { /* необязательная проверка */ }

  // Ядро: загруженный коммит должен совпадать с HEAD, иначе «работает» — неправда.
  try {
    const r = await fetch((process.env.YADRO_TRACE_URL || 'http://127.0.0.1:3212').replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(4000) })
    const h = await r.json()
    const loaded = String(h.loaded_commit || '').slice(0, 7)
    const head = String(h.head || '').slice(0, 7)
    out.push('Ядро: loaded ' + (loaded || '?') + ' / head ' + (head || '?') + (h.stale ? ' — STALE, нужен перезапуск' : ' — совпадает'))
  } catch (_) { out.push('Ядро: /health недоступен') }

  // Ловушка дня: процесс терминала старше правки своего же файла → тест врёт.
  try {
    const self = fileURLToPath(import.meta.url)
    const mt = statSync(self).mtimeMs
    const ps = String(await runBash("ps -eo lstart=,cmd= 2>/dev/null | grep '[y]adro-agent.mjs' | head -5")).trim()
    if (ps) {
      const stale = ps.split('\n').filter((line) => {
        const d = new Date(line.slice(0, 24))
        return !isNaN(d.getTime()) && d.getTime() < mt
      })
      out.push('процессы терминала: ' + (stale.length
        ? 'ВНИМАНИЕ — ' + stale.length + ' запущены до правки кода (перезапусти, иначе тест врёт)'
        : 'актуальны'))
    }
  } catch (_) { /* нет ps — не критично */ }

  return out.join('\n')
}

// Трасса субагента → Ядро (/v1/trace). Best-effort: Ядро может быть не поднято,
// это не должно ломать саму задачу.
async function sendTrace(detail, step) {
  try {
    const base = String(process.env.YADRO_TRACE_URL || 'http://127.0.0.1:3212')
    const r = await fetch(base.replace(/\/$/, '') + '/v1/trace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trace_id: (step === 'team' ? 'team-' : 'subagent-') + Date.now(), step: step || 'subagent', detail }),
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) logLine(new Date().toISOString() + ' subagent-trace HTTP ' + r.status)
  } catch (e) {
    logLine(new Date().toISOString() + ' subagent-trace failed ' + String((e && e.message) || e))
  }
}

// ── REPL ──────────────────────────────────────────────────────

// ── служебные команды Пикселя (doctor / status / recover) ────
// Нужны именно тогда, когда Ядра нет: поэтому без модели и без шлюза.
const PIXEL_CMD = (() => {
  const i = process.argv.indexOf('--pixel')
  return i >= 0 ? String(process.argv[i + 1] || '') : ''
})()

function sh(cmd) {
  try { return String(execSync(cmd, { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim() }
  catch { return '' }
}

function pixDoctor() {
  const say = (ok, name, note) => console.log(`${ok ? '\u2714' : '\u2716'} ${name}${note ? ' — ' + note : ''}`)
  const nodeV = process.versions.node
  say(parseInt(nodeV, 10) >= 20, 'node', nodeV)
  say(!!sh('command -v curl'), 'curl', 'нужен для проверки шлюза')
  say(!!sh('command -v git'), 'git', '')
  const gw = (process.env.YADRO_GATEWAY || '').replace(/\/$/, '')
  const probe = gw ? sh(`curl -sf --max-time 3 ${gw}/health`) : ''
  say(!!probe, 'шлюз', gw ? `${gw}${probe ? '' : ' — не отвечает'}` : 'не задан')
  const key = process.env.PIXEL_PROVIDER_KEY_FILE || `${process.env.HOME}/.pixel/provider.key`
  say(existsSync(key), 'ключ провайдера', key)
  say(!!sh('command -v psql'), 'postgres', 'для восстановления БД')
  say(!!sh('command -v pm2'), 'pm2', 'процессы Ядра')
  say(!!sh('command -v nginx'), 'nginx', 'сайты')
  say(!!sh('command -v tmux'), 'tmux', 'не обязателен локально')
  const disk = sh("df -h / | awk 'NR==2{print $4}'")
  say(!!disk, 'свободно на /', disk)
  const dataDir = process.env.PIXEL_DATA_DIR || `${process.env.HOME}/.pixel/data`
  say(existsSync(dataDir), 'каталог данных', dataDir)
}

function pixStatus() {
  const gw = (process.env.YADRO_GATEWAY || '').replace(/\/$/, '')
  const h = gw ? sh(`curl -sf --max-time 3 ${gw}/health`) : ''
  console.log('шлюз:', gw || 'не задан', h ? '— ' + h.slice(0, 120) : '— нет ответа')
  const hp = process.env.PIXEL_HEALTH_FILE || '/root/.openclaw/workspace/data/yadro-health.json'
  if (existsSync(hp)) {
    try {
      const j = JSON.parse(readFileSync(hp, 'utf-8'))
      console.log('движок: pid', j.pid, '| модель', j.model, '| in_flight', j.in_flight, '| uptime', j.uptime_sec, 'с')
    } catch { console.log('движок: health-файл не читается') }
  } else console.log('движок: health-файла нет — терминал не запущен')
  const sess = sh('tmux ls 2>/dev/null | grep -c pixel\\|yadro')
  console.log('tmux-сессия:', sess && sess !== '0' ? 'есть' : 'нет (локально это норма)')
}

function pixRecover(args) {
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, '..', 'recovery', 'restore.sh')
  console.log('Пиксель · восстановление')
  console.log('карточка: recovery/ARMAGEDDON.md')
  if (!existsSync(script)) {
    console.log('restore.sh не найден — восстановление делается по карточке вручную')
    return 1
  }
  const r = spawnSync('/bin/bash', [script, ...args], { stdio: 'inherit' })
  return r.status || 0
}

if (PIXEL_CMD) {
  try {
    if (PIXEL_CMD === 'doctor') { pixDoctor(); process.exit(0) }
    if (PIXEL_CMD === 'status') { pixStatus(); process.exit(0) }
    if (PIXEL_CMD === 'recover') { process.exit(pixRecover(process.argv.slice(process.argv.indexOf('--pixel') + 2))) }
    console.error('pixel: неизвестная команда ' + PIXEL_CMD)
    process.exit(2)
  } catch (e) {
    console.error('pixel: ' + (e && e.message ? e.message : e))
    process.exit(1)
  }
}

const input = rl.createInterface({ input: stdin, output: stdout, terminal: true, prompt: '' })

// Восстановление разговора после падения/рестарта (11.11).
if (!process.env.YADRO_TASK) {
  const restored = loadSession()
  if (restored) process.stdout.write(D + `↺ сессия восстановлена: ${restored} сообщений (` + basename(SESSION_FILE) + ')' + R + '\n')
  const cp = existsSync(CHECKPOINT_FILE) ? (() => { try { const r = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8')); return r } catch { return null } })() : null
  if (cp && cp.sha) process.stdout.write(D + `⟲ есть чекпоинт от ${cp.at}: /undo вернёт файлы` + R + '\n')
}

// ── watchdog: зависание ТОЛЬКО активной работы → форс-выход ──
// Баг v2.3.0: watchdog считал «простой в ожидании ввода» зависанием и убивал
// здоровый терминал каждые 30с → crash-loop (supervisor бесконечно поднимал).
// Правильно: мониторить только когда запрос в полёте (inFlight). Идл — не убивать.
// 8.11: 30с → 60с. Heartbeat на каждый байт уже есть, но медленный старт шлюза
// (первый токен за 30+с) убивал живой терминал; мёртвый поток и за 60с отловится.
const HEALTH_TIMEOUT = parseInt(process.env.YADRO_HEALTH_TIMEOUT || '60000', 10)
let lastActivity = Date.now()
let inFlight = false
function touch() { lastActivity = Date.now() }
function beginWork() { inFlight = true; touch(); health.in_flight = true; saveHealth() }
function endWork() { inFlight = false; touch(); health.in_flight = false; saveHealth() }
const watchdog = setInterval(() => {
  saveHealth()
  if (inFlight && Date.now() - lastActivity > HEALTH_TIMEOUT) {
    logLine(`${new Date().toISOString()} WATCHDOG terminal hung >${HEALTH_TIMEOUT}ms (in-flight), forcing exit(1)`)
    process.stdout.write(RD + `\n⚠ терминал завис >${Math.round(HEALTH_TIMEOUT / 1000)}с — перезапуск…` + R + '\n')
    process.exit(1)
  }
}, Math.min(10000, HEALTH_TIMEOUT / 2))

// Компактный баннер (2 строки вместо 6): на телефоне служебный текст съедал экран.
// Субагент (YADRO_TASK) работает тихо: его stdout читает родитель, баннер там лишний.
if (!process.env.YADRO_TASK) printBanner()
// Подсказка команд при старте убрана (8.11): список живёт в /help, баннер чистый.

logLine(`${new Date().toISOString()} start model=${MODEL} max_steps=${MAX_STEPS} native=${NATIVE_TOOLS ? 1 : 0}`)

input.on('line', async (line) => {
  const t = line.trim()
  touch()
  // Сначала — ответ на «Выполнить? [y/N]»: пока он не получен, реплики в REPL не идут.
  if (pendingConfirm) {
    pendingConfirm.finish(/^(y|yes|д|да)$/i.test(t))
    return
  }
  if (!t) return
  
  try {
    if (t.startsWith('/')) {
      await handleSlash(t)
    } else if (t.startsWith('!')) {
      const cmd = t.slice(1).trim()
      if (!cmd) return
      process.stdout.write(D + '$ ' + cmd + '\n' + R)
      const r = await runBash(cmd)
      process.stdout.write(r + '\n\n')
    } else {
      await handle(t)
    }
  } catch (e) {
    stopSpin()
    process.stdout.write(RD + 'ошибка: ' + e.message + '\n' + R)
    logLine(`${new Date().toISOString()} repl-err ${e.message}`)
  }
})

input.on('SIGINT', () => {
  if (ABORT) {
    INTERRUPTED = true
    try { ABORT.abort('user-interrupt') } catch {}
    stopSpin()
    process.stdout.write('\n' + YEL + '⏸ прерывание (Ctrl+C) — дождись завершения текущего запроса' + R + '\n')
  } else {
    process.stdout.write('\n' + D + 'для выхода: /exit' + R + '\n')
  }
})

// ── неинтерактивный режим (для делегирования из родительского агента) ──
// Родитель запускает нас с YADRO_TASK и читает stdout. Один прогон — и выход.
if (process.env.YADRO_TASK) {
  const task = String(process.env.YADRO_TASK)
  ;(async () => {
    try {
      await handle(task)
    } catch (e) {
      process.stdout.write('\nошибка субагента: ' + String((e && e.message) || e) + '\n')
      logLine(new Date().toISOString() + ' subagent-err ' + String((e && e.message) || e))
    }
    process.exit(0)
  })()
}
