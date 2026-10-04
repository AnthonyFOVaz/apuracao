#!/bin/bash
# Garante que o Caddy atende o domínio principal (DuckDNS), além do sslip.io. Chamado a cada minuto pelo atualizar.sh.
# Idempotente: se o domínio já está no Caddyfile, sai sem fazer nada. Só acrescenta um bloco ao fim do Caddyfile
# (o bloco existente não é alterado); config que não passa no `caddy validate` não é aplicada.
# Se algo falhar, o motivo fica em data/caddy-falhou (aparece em /api/versao).
set -euo pipefail
DOMINIO=apuracaox1doscria.duckdns.org
CF=/etc/caddy/Caddyfile
MARCA=data/caddy-falhou # depois de uma falha, só tenta de novo quando este script ou o Caddyfile mudarem

[ -r "$CF" ] && grep -qF "$DOMINIO" "$CF" && exit 0
[ -f "$MARCA" ] && [ "$MARCA" -nt "$0" ] && { [ ! -e "$CF" ] || [ "$MARCA" -nt "$CF" ]; } && exit 0

falhou() { echo "caddy: $1"; mkdir -p data; echo "$(date -Is) $1" > "$MARCA"; exit 1; }
curto() { tail -n 3 | tr '\n' ' ' | cut -c1-400; }

[ -e "$CF" ] || falhou "$CF não existe (usuário $(id -un))"
[ -r "$CF" ] || falhou "sem leitura em $CF (usuário $(id -un), $(stat -c '%U:%G %a' "$CF"))"
grep -qF 'sslip.io' "$CF" || falhou "$CF não tem o site da apuração; nada mudou"

# mesmo destino do site atual (reverse_proxy do bloco do sslip.io); padrão 127.0.0.1:3100
destino=$(awk '!/^[[:space:]]*#/ && /sslip\.io/ && /\{[[:space:]]*$/ {f=1} f && $1 == "reverse_proxy" {print $2; exit}' "$CF")
[[ "$destino" =~ ^[A-Za-z0-9._-]+:[0-9]+$ ]] || destino=127.0.0.1:3100

novo="$(dirname "$CF")/Caddyfile.apuracao-novo"
if ! saida=$({ cat "$CF"; printf '\n# Apuração Luta: domínio principal (scripts/caddy.sh)\n%s {\n\tencode gzip\n\treverse_proxy %s\n}\n' "$DOMINIO" "$destino"; } \
  | sudo -n tee "$novo" 2>&1 >/dev/null); then
  falhou "não deu para escrever $novo com sudo: $(echo "$saida" | curto)"
fi
sudo -n chown --reference="$CF" "$novo" && sudo -n chmod --reference="$CF" "$novo"
if ! saida=$(sudo -n timeout 60 caddy validate --config "$novo" --adapter caddyfile 2>&1); then
  sudo -n rm -f "$novo"
  falhou "caddy validate recusou a configuração com $DOMINIO (nada mudou): $(echo "$saida" | curto)"
fi
copia="$CF.antes-duckdns"
sudo -n cp -p "$CF" "$copia"
sudo -n mv "$novo" "$CF"
if ! saida=$(sudo -n timeout 60 systemctl reload caddy 2>&1); then
  sudo -n cp -p "$copia" "$CF"
  falhou "reload do Caddy falhou; Caddyfile anterior restaurado: $(echo "$saida" | curto)"
fi
rm -f "$MARCA"
echo "caddy: $DOMINIO configurado (Caddyfile anterior em $copia)"
