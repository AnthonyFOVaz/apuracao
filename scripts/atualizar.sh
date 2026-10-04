#!/bin/bash
# Puxa o main do GitHub e reinicia o serviço quando o back muda. Rodado a cada minuto pelo apuracao-atualizar.timer.
set -euo pipefail
cd /home/ubuntu/projects/apuracao
git fetch -q origin main
antes=$(git rev-parse HEAD); depois=$(git rev-parse origin/main)
[ "$antes" = "$depois" ] && exit 0
git reset -q --hard origin/main
if ! /usr/bin/node --check server.js; then git reset -q --hard "$antes"; echo "server.js inválido em $depois; mantido $antes"; exit 1; fi
if git diff --name-only "$antes" "$depois" | grep -qE '^(server\.js|package\.json)$'; then sudo systemctl restart apuracao; fi
echo "atualizado para $depois"
