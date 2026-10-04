#!/bin/bash
# Garante que o Caddy atende o domínio principal (DuckDNS), além do sslip.io. Chamado a cada minuto pelo atualizar.sh.
# O Caddy do servidor roda num container (edge-caddy), com a API de administração desligada. O script:
#  1. sai na hora se o domínio já responde (checagem local, sem sudo);
#  2. se a API do Caddy estiver ligada (no container ou no host), põe o domínio no route do sslip.io por ela;
#  3. senão, edita a config dentro do container: o domínio entra na linha do site do sslip.io (mesmo bloco) ou, se o
#     nome não aparece literalmente, num bloco novo com o mesmo upstream :3100; valida com `caddy validate`, aplica com
#     `caddy reload` ou, sem API, reiniciando o container, e confere que o sslip.io voltou. Falhou: desfaz.
# Com o domínio já na config, não reinicia de novo (só espera o certificado). Falhas: data/caddy-falhou e /api/versao.
set -euo pipefail
DOMINIO=apuracaox1doscria.duckdns.org
SITE=apuracao-204-216-184-199.sslip.io
MARCA=data/caddy-falhou # depois de uma falha, só tenta de novo quando este script mudar

responde() { curl -fsk -m 5 --noproxy '*' --resolve "$1:443:127.0.0.1" -o /dev/null "https://$1/health" 2>/dev/null; }
responde "$DOMINIO" && { rm -f "$MARCA"; exit 0; }
[ -f "$MARCA" ] && [ "$MARCA" -nt "$0" ] && exit 0

falhou() { echo "caddy: $1"; mkdir -p data; echo "$(date -Is) $1" > "$MARCA"; exit 1; }
curto() { tail -n 3 | tr '\n' ' ' | cut -c1-300; }

CID=$(sudo -n docker ps --format '{{.ID}} {{.Image}}' 2>/dev/null | awk '$2 ~ /^caddy(:|$)/ {print $1; exit}' || true)
dx() { sudo -n docker exec -i "$CID" "$@"; }

# --- 2) API de administração ligada
api=""
if [ -n "$CID" ] && dx wget -qO- http://127.0.0.1:2019/config/ >/dev/null 2>&1; then
  ler() { dx wget -qO- http://127.0.0.1:2019/config/; }
  pos() { dx wget -qO- --header 'Content-Type: application/json' --post-data "\"$DOMINIO\"" "http://127.0.0.1:2019$1"; }
  api=1
elif curl -fsS -m 3 -o /dev/null http://127.0.0.1:2019/config/ 2>/dev/null; then
  ler() { curl -fsS -m 10 http://127.0.0.1:2019/config/; }
  pos() { curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d "\"$DOMINIO\"" "http://127.0.0.1:2019$1"; }
  api=1
fi
if [ -n "$api" ]; then
  cfg=$(ler)
  case "$cfg" in *"\"$DOMINIO\""*) exit 0 ;; esac # já está; o certificado ainda está saindo
  achou=$(printf '%s' "$cfg" | /usr/bin/node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s || "null") || {}, servers = ((c.apps || {}).http || {}).servers || {}, hosts = [];
      let achou = "";
      for (const [n, srv] of Object.entries(servers)) (srv.routes || []).forEach((r, i) => (r.match || []).forEach((m, j) => {
        hosts.push(...(m.host || []));
        if (!achou && (m.host || []).includes(process.argv[1])) achou = `/config/apps/http/servers/${encodeURIComponent(n)}/routes/${i}/match/${j}/host`;
      }));
      console.log(achou || "hosts=" + hosts.join(","));
    });' "$SITE" 2>&1 || true)
  case "$achou" in /config/*) ;; *) falhou "nenhum route com o host $SITE na config do Caddy: $(echo "$achou" | cut -c1-300)" ;; esac
  saida=$(pos "$achou" 2>&1) || falhou "POST $achou na API do Caddy falhou: $(echo "$saida" | curto)"
  rm -f "$MARCA"; echo "caddy: $DOMINIO adicionado pela API em $achou"; exit 0
fi

# --- 3) sem API: editar a config dentro do container
[ -n "$CID" ] || falhou "não achei o Caddy: nem container com imagem caddy, nem API em 127.0.0.1:2019"
CP=$(sudo -n docker inspect -f '{{range .Args}}{{.}} {{end}}' "$CID" | grep -oE -- '--config[ =][^ ]+' | head -1 | sed -E 's/--config[ =]//' || true)
CP=${CP:-/etc/caddy/Caddyfile}
DIR=$(dirname "$CP")
usados() { dx grep -rlF "$1" "$DIR" 2>/dev/null | grep -vE '(\.bak|\.orig|\.old|~$|antes)' || true; } # ignora cópias de segurança
[ -n "$(usados "$DOMINIO")" ] && exit 0 # já está na config; o certificado ainda está saindo
responde "$SITE" || falhou "a checagem local do $SITE (https em 127.0.0.1) não funciona; não vou reiniciar o Caddy às cegas"
F=$(usados "$SITE" | head -1)
er=${SITE//./\\.}
if [ -n "$F" ] && dx cat "$F" | grep -qE "^[^#]*$er[^{]*\{[[:space:]]*$"; then
  novo=$(dx cat "$F" | sed -E "0,/^([^#]*$er([^{]*[^[:space:]{])?)[[:space:]]*\{[[:space:]]*\$/s##\1, $DOMINIO {#")
  como="na linha do site em $F"
else
  F=$CP
  up=$(dx grep -rhoE '[^[:space:]]+:3100' "$DIR" 2>/dev/null | head -1 || true)
  [ -n "$up" ] || up=127.0.0.1:3100
  novo=$(dx cat "$F"; printf '\n# Apuração Luta: domínio principal (scripts/caddy.sh)\n%s {\n\tencode gzip\n\treverse_proxy %s\n}\n' "$DOMINIO" "$up")
  como="num bloco novo em $F (upstream $up)"
fi
grep -qF "$DOMINIO" <<< "$novo" || falhou "não consegui pôr $DOMINIO $como; nada mudou"
# o arquivo vem de um bind mount (só leitura no container): grava a origem dele no host, no lugar (mesmo inode)
hospedeiro() {
  local melhor="" origem="" src dst
  while read -r src dst; do
    [ -n "$dst" ] || continue
    if [ "$1" = "$dst" ] || [ "${1#"$dst"/}" != "$1" ]; then
      if [ ${#dst} -gt ${#melhor} ]; then melhor=$dst; origem=$src; fi
    fi
  done < <(sudo -n docker inspect -f '{{range .Mounts}}{{.Source}} {{.Destination}}{{"\n"}}{{end}}' "$CID" 2>/dev/null || true)
  if [ -n "$melhor" ]; then echo "$origem${1#"$melhor"}"; fi
}
HF=$(hospedeiro "$F")
if [ -n "$HF" ]; then
  sudo -n test -f "$HF" || falhou "$F vem de $HF no host, mas esse arquivo não existe"
  grava() { if [ -w "$HF" ]; then cat > "$HF"; else sudo -n tee "$HF" >/dev/null; fi; }
  como="$como (no host: $HF)"
else
  grava() { dx tee "$F" >/dev/null; }
fi
copia=$(mktemp); trap 'rm -f "$copia"' EXIT
dx cat "$F" > "$copia"
printf '%s\n' "$novo" | grava || falhou "não deu para gravar ${HF:-$F}"
desfaz() { grava < "$copia"; }
if ! saida=$(dx caddy validate --config "$CP" --adapter caddyfile 2>&1); then
  desfaz; falhou "caddy validate recusou a config com $DOMINIO $como (desfeito): $(echo "$saida" | curto)"
fi
if ! dx caddy reload --config "$CP" --adapter caddyfile >/dev/null 2>&1; then
  # API desligada: aplica reiniciando o container (a config já foi validada) e confere que o site atual voltou
  sudo -n docker restart -t 10 "$CID" >/dev/null || { desfaz; falhou "docker restart falhou (desfeito)"; }
  ok=""; for _ in $(seq 1 20); do sleep 2; if responde "$SITE"; then ok=1; break; fi; done
  if [ -z "$ok" ]; then
    desfaz; sudo -n docker restart -t 10 "$CID" >/dev/null || true
    falhou "o Caddy não voltou a responder pelo $SITE depois do restart; config desfeita e container reiniciado de novo"
  fi
fi
rm -f "$MARCA"
echo "caddy: $DOMINIO configurado $como (container $CID)"
