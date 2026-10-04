#!/bin/bash
# Garante que o Caddy atende o domínio principal (DuckDNS), além do sslip.io. Chamado a cada minuto pelo atualizar.sh.
# Acha o Caddyfile que tem o site do sslip.io e põe o domínio novo no mesmo bloco (mesma configuração do site atual).
# Valida antes com `caddy validate` e recarrega o Caddy: no container Docker que monta esse Caddyfile, ou no Caddy do
# sistema. Se a validação ou o reload falharem, o Caddyfile volta ao que era.
# Já configurado: sai sem fazer nada. Falhou: o motivo (com um diagnóstico) fica em data/caddy-falhou e aparece em /api/versao.
set -euo pipefail
DOMINIO=apuracaox1doscria.duckdns.org
SITE=apuracao-204-216-184-199.sslip.io
MARCA=data/caddy-falhou # depois de uma falha, só tenta de novo quando este script mudar

falhou() { echo "caddy: $1"; mkdir -p data; echo "$(date -Is) $1" > "$MARCA"; exit 1; }
curto() { tail -n 3 | tr '\n' ' ' | cut -c1-400; }
diagnostico() {
  local p d
  p=$(ps -C caddy -o user=,args= 2>/dev/null | head -2 | tr '\n' ';' | cut -c1-200 || true)
  d=$(sudo -n docker ps --format '{{.Names}} {{.Image}}' 2>&1 | head -4 | tr '\n' ';' | cut -c1-300 || true)
  echo "processo=[$p] docker=[$d]"
}

# o Caddyfile com o site da apuração
CF=""
for f in /etc/caddy/Caddyfile /home/ubuntu/projects/edge/Caddyfile $(find /home/ubuntu/projects /etc/caddy -maxdepth 3 -name Caddyfile 2>/dev/null || true); do
  if [ -r "$f" ] && grep -qF "$SITE" "$f"; then CF=$f; break; fi
done
if [ -n "$CF" ] && grep -qF "$DOMINIO" "$CF"; then rm -f "$MARCA"; exit 0; fi
[ -f "$MARCA" ] && [ "$MARCA" -nt "$0" ] && exit 0
[ -n "$CF" ] || falhou "nenhum Caddyfile com o site $SITE. $(diagnostico)"

# quem usa esse Caddyfile: um container Docker que o monta (direto ou a pasta dele) ou o Caddy do sistema
CID="" CCF=""
for c in $(sudo -n docker ps -q 2>/dev/null || true); do
  while read -r src dst; do
    [ "$src" = "$CF" ] && CCF=$dst
    [ "$src" = "$(dirname "$CF")" ] && CCF="$dst/$(basename "$CF")"
  done < <(sudo -n docker inspect -f '{{range .Mounts}}{{.Source}} {{.Destination}}{{"\n"}}{{end}}' "$c" 2>/dev/null || true)
  if [ -n "$CCF" ]; then CID=$c; break; fi
done
if [ -n "$CID" ]; then
  validar() { sudo -n docker exec -i "$CID" sh -c 'cat > /tmp/Caddyfile.apuracao && caddy validate --config /tmp/Caddyfile.apuracao --adapter caddyfile; s=$?; rm -f /tmp/Caddyfile.apuracao; exit $s' < "$1"; }
  recarregar() { sudo -n docker exec "$CID" caddy reload --config "$CCF" --adapter caddyfile; }
elif command -v caddy >/dev/null && systemctl cat caddy >/dev/null 2>&1; then
  validar() { sudo -n caddy validate --config "$1" --adapter caddyfile; }
  recarregar() { sudo -n systemctl reload caddy; }
else
  falhou "não achei o Caddy que usa $CF (nem container Docker que o monte, nem serviço caddy). $(diagnostico)"
fi

novo=$(mktemp)
trap 'rm -f "$novo"' EXIT
er=${SITE//./\\.}
if grep -qE "^[[:space:]]*(https?://)?$er(:443)?[[:space:]]*\{[[:space:]]*$" "$CF"; then
  # o domínio entra na mesma linha do site atual: mesmo bloco, mesma configuração
  sed -E "s#^([[:space:]]*)((https?://)?$er(:443)?)[[:space:]]*\{[[:space:]]*\$#\1\2, $DOMINIO {#" "$CF" > "$novo"
else
  destino=$(awk '!/^[[:space:]]*#/ && /sslip\.io/ && /\{[[:space:]]*$/ {f=1} f && $1 == "reverse_proxy" {print $2; exit}' "$CF")
  [[ "$destino" =~ ^[A-Za-z0-9._-]+:[0-9]+$ ]] || destino=127.0.0.1:3100
  { cat "$CF"; printf '\n# Apuração Luta: domínio principal (scripts/caddy.sh)\n%s {\n\tencode gzip\n\treverse_proxy %s\n}\n' "$DOMINIO" "$destino"; } > "$novo"
fi
saida=$(validar "$novo" 2>&1) || falhou "caddy validate recusou a configuração com $DOMINIO (nada mudou): $(echo "$saida" | curto)"

# grava no lugar (mesmo inode), para o container que monta só o arquivo enxergar a mudança
escrever() { if [ -w "$1" ]; then cat > "$1"; else sudo -n tee "$1" >/dev/null; fi; }
copia="$CF.antes-duckdns"
cp -p "$CF" "$copia" 2>/dev/null || sudo -n cp -p "$CF" "$copia"
escrever "$CF" < "$novo"
if ! saida=$(recarregar 2>&1); then
  escrever "$CF" < "$copia"
  falhou "reload do Caddy falhou; Caddyfile anterior restaurado: $(echo "$saida" | curto)"
fi
rm -f "$MARCA"
echo "caddy: $DOMINIO configurado em $CF${CID:+ (container $CID)}; anterior em $copia"
