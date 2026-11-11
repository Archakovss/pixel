#!/usr/bin/env python3
"""patch-env.py — перевести .env из снимка на учебную/новую базу и порт.

Зачем отдельный файл: правка env из bash через sed ломается на спецсимволах
в пароле, а пароль генерируется случайный. Здесь одна задача и одна проверка.

Использование: patch-env.py <path/.env> <db> <port> <pg_password>
"""
import re
import sys


def main() -> int:
    if len(sys.argv) != 5:
        print('usage: patch-env.py <.env> <db> <port> <password>', file=sys.stderr)
        return 2
    path, db, port, password = sys.argv[1:5]
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except OSError as e:
        print(f'не прочитан {path}: {e}', file=sys.stderr)
        return 1

    values = {
        'PG_DATABASE': db,
        'PG_HOST': '127.0.0.1',
        'PG_PORT': '5432',
        'PG_USER': 'core',
        'PG_PASSWORD': password,
        'PORT': port,
    }

    for key, value in values.items():
        pattern = re.compile(rf'^{re.escape(key)}=.*$', re.M)
        if pattern.search(text):
            text = pattern.sub(f'{key}={value}', text)
        else:
            text = text.rstrip('\n') + f'\n{key}={value}\n'

    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f'env обновлён: база {db}, порт {port}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
