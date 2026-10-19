#!/usr/bin/env bash
# Бэкап базы и загруженных картинок в ./backups, хранит последние 14 копий.
# Раз в сутки в 04:00 (crontab -e):  0 4 * * * /root/kolo/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups; D="$(date +%F)"
docker compose exec -T db pg_dump -U kolo kolo | gzip > "backups/db-$D.sql.gz"
docker compose exec -T app tar czf - -C /app/data uploads > "backups/uploads-$D.tgz" || true
ls -1t backups/db-* 2>/dev/null | tail -n +15 | xargs -r rm --
ls -1t backups/uploads-* 2>/dev/null | tail -n +15 | xargs -r rm --
echo "Бэкап готов: backups/*-$D*"
