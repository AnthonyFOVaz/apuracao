#!/bin/bash
# Garante que o Caddy atende o domínio principal (DuckDNS), além do sslip.io. Chamado a cada minuto pelo atualizar.sh.
# O Caddy do servidor roda num container (edge-caddy). O script usa a API de administração dele (localhost:2019, de
# dentro do container) para pôr o domínio novo no mesmo route do site do sslip.io: mesma configuração, sem mexer em
# arquivo. Se o Caddy reiniciar e perder a mudança, ela volta no minuto seguinte. Sem container, usa a API no host.
# Falhou: o motivo fica em data/caddy-falhou e aparece em /api/versao.
set -euo pipefail
DOMINIO=apuracaox1doscria.duckdns.org
SITE=apuracao-204-216-184-199.sslip.io
MARCA=data/caddy-falhou # depois de uma falha, só tenta de novo quando este script mudar

# já atende com certificado? (pergunta ao próprio servidor, sem sudo)
if curl -fsk -m 5 --resolve "$DOMINIO:443:127.0.0.1" -o /dev/null "https://$DOMINIO/health" 2>/dev/null; then rm -f "$MARCA"; exit 0; fi
[ -f "$MARCA" ] && [ "$MARCA" -nt "$0" ] && exit 0

falhou() { echo "caddy: $1"; mkdir -p data; echo "$(date -Is) $1" > "$MARCA"; exit 1; }
curto() { tail -n 3 | tr '\n' ' ' | cut -c1-300; }

CID=$(sudo -n docker ps --format '{{.ID}} {{.Image}}' 2>/dev/null | awk '$2 ~ /^caddy(:|$)/ {print $1; exit}' || true)
if [ -n "$CID" ]; then
  ler() { sudo -n docker exec "$CID" wget -qO- http://127.0.0.1:2019/config/; }
  pos() { sudo -n docker exec "$CID" wget -qO- --header 'Content-Type: application/json' --post-data "\"$DOMINIO\"" "http://127.0.0.1:2019$1"; }
elif curl -fsS -m 3 -o /dev/null http://127.0.0.1:2019/config/ 2>/dev/null; then
  ler() { curl -fsS -m 10 http://127.0.0.1:2019/config/; }
  pos() { curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d "\"$DOMINIO\"" "http://127.0.0.1:2019$1"; }
else
  falhou "não achei o Caddy: nem container com imagem caddy, nem API em 127.0.0.1:2019. docker=[$(sudo -n docker ps --format '{{.Names}} {{.Image}}' 2>&1 | head -4 | tr '\n' ';')]"
fi

cfg=$(ler 2>&1) || falhou "não consegui ler a config pela API do Caddy${CID:+ (container $CID)}: $(echo "$cfg" | curto)"
case "$cfg" in *"\"$DOMINIO\""*) exit 0 ;; esac # já está na config; o certificado ainda está saindo

# caminho do array de hosts do route que atende o sslip.io (e a lista de hosts, para o diagnóstico)
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
ler 2>/dev/null | grep -qF "\"$DOMINIO\"" || falhou "o domínio não apareceu na config depois do POST em $achou"
rm -f "$MARCA"
echo "caddy: $DOMINIO adicionado em $achou${CID:+ (container $CID)}"
