#!/usr/bin/env bash
# Полная установка на чистый сервер Ubuntu/Debian. Запускать от root из папки проекта:
#   bash deploy/setup-server.sh kolo.ru
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo "Запустите от root (или через sudo)."; exit 1; }

if ! command -v docker >/dev/null; then
  echo "==> Ставлю Docker"
  curl -fsSL https://get.docker.com | sh
fi

if command -v ufw >/dev/null; then
  echo "==> Открываю порты 22, 80, 443"
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

bash deploy/init-env.sh "${1:-}"

echo "==> Собираю и запускаю"
docker compose up -d --build
DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2)"
echo
echo "Готово. Через минуту (пока Caddy получает сертификат) откройте https://$DOMAIN"
echo "Логи:  docker compose logs -f"
