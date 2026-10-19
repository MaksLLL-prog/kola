#!/usr/bin/env bash
# Создаёт .env: спрашивает домен, остальное (пароль базы, секрет токенов) генерирует сам.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then echo ".env уже существует — не трогаю."; exit 0; fi

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then read -rp "Ваш домен без http и www (например kolo.ru): " DOMAIN; fi
DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z')"
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#www.}"; DOMAIN="${DOMAIN%%/*}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z0-9-]+$ ]] || { echo "Не похоже на домен: '$DOMAIN'"; exit 1; }

cp .env.example .env
sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 48)|" .env
chmod 600 .env
echo "Готово: .env создан для $DOMAIN (пароли сгенерированы)."
