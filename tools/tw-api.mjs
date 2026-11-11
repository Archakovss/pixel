// tw-api.mjs — пробы Timeweb API токеном из файла (/root/.timeweb.token).
// Токен не печатается: только статусы и короткие ответы.
import fs from 'node:fs';

const TOKEN = fs.readFileSync('/root/.timeweb.token', 'utf8').trim();
const BASE = 'https://api.timeweb.cloud/api/v1';

async function probe(method, path, body) {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    console.log(`${method.padEnd(5)} ${path.padEnd(42)} → ${res.status}  ${text.slice(0, 220).replace(/\s+/g, ' ')}`);
    return { status: res.status, text };
  } catch (e) {
    console.log(`${method.padEnd(5)} ${path.padEnd(42)} → ошибка: ${e.message}`);
    return { status: 0, text: '' };
  }
}

await probe('GET', '/accounts');
const domains = await probe('GET', '/domains');
await probe('GET', '/domains/friday.com.ru');
await probe('GET', '/domains/friday.com.ru/dns-records');

// если домен виден — показываем список, чтобы не гадать про www
try {
  const j = JSON.parse(domains.text);
  const list = j.domains || [];
  if (list.length) {
    console.log('\nдомены в аккаунте:', list.map((d) => d.fqdn || d.name).join(', '));
  } else {
    console.log('\nв аккаунте нет доменов (или токен другого аккаунта)');
  }
} catch { /* не JSON — уже видно по статусу */ }
