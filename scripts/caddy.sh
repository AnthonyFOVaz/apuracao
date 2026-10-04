#!/bin/bash
# Garante que o Caddy atende o domínio principal (DuckDNS), além do sslip.io. Chamado a cada minuto pelo atualizar.sh.
# 1) Caddy com a API de administração (localhost:2019): acrescenta o domínio ao mesmo route do site do sslip.io.
#    Se o Caddy reiniciar e perder a mudança, ela volta no minuto seguinte.
# 2) Sem a API: acrescenta um bloco ao Caddyfile que tem o site do sslip.io, valida com `caddy validate` e recarrega.
# Já configurado: sai sem fazer nada. Falhou: o motivo (com um diagnóstico) fica em data/caddy-falhou e aparece em /api/versao.
set -euo pipefail
DOMINIO=apuracaox1doscria.duckdns.org
SITE=apuracao-204-216-184-199.sslip.io
API=http://127.0.0.1:2019
MARCA=data/caddy-falhou # depois de uma falha, só tenta de novo quando este script mudar

falhou() { echo "caddy: $1"; mkdir -p data; echo "$(date -Is) $1" > "$MARCA"; exit 1; }
curto() { tail -n 3 | tr '\n' ' ' | cut -c1-400; }
diagnostico() {
  local p u d f
  p=$(ps -C caddy -o user=,args= 2>/dev/null | head -2 | tr '\n' ';' | cut -c1-300 || true)
  u=$(systemctl show caddy -p FragmentPath -p ExecStart 2>/dev/null | tr '\n' ' ' | cut -c1-300 || true)
  d=$(docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' 2>/dev/null | grep -i caddy | head -2 | tr '\n' ';' | cut -c1-300 || true)
  f=$(find /etc /home/ubuntu /opt /srv -maxdepth 4 -name 'Caddyfile*' 2>/dev/null | head -5 | tr '\n' ' ' || true)
  echo "processo=[$p] systemd=[$u] docker=[$d] arquivos=[$f] caddy=[$(command -v caddy || true)] grupos=[$(id -Gn)]"
}

# --- 1) API de administração
if cfg=$(curl -fsS -m 5 "$API/config/" 2>/dev/null); then
  case "$cfg" in *"\"$DOMINIO\""*) rm -f "$MARCA"; exit 0 ;; esac
  [ -f "$MARCA" ] && [ "$MARCA" -nt "$0" ] && exit 0
  caminho=$(printf '%s' "$cfg" | /usr/bin/node -e '
    let s = "", achou = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s || "null") || {}, servers = ((c.apps || {}).http || {}).servers || {};
      for (const [n, srv] of Object.entries(servers)) (srv.routes || []).forEach((r, i) => (r.match || []).forEach((m, j) => {
        if (!achou && (m.host || []).includes(process.argv[1])) achou = `/config/apps/http/servers/${encodeURIComponent(n)}/routes/${i}/match/${j}/host`;
      }));
      console.log(achou);
    });' "$SITE" || true)
  [ -n "$caminho" ] || falhou "a API do Caddy responde, mas nenhum route tem o host $SITE. $(diagnostico)"
  if ! saida=$(curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d "\"$DOMINIO\"" "$API$caminho" 2>&1); then
    falhou "POST $caminho na API do Caddy falhou: $(echo "$saida" | curto)"
  fi
  curl -fsS -m 5 "$API/config/" | grep -qF "\"$DOMINIO\"" || falhou "o domínio não apareceu na config depois do POST em $caminho"
  rm -f "$MARCA"
  echo "caddy: $DOMINIO adicionado pela API em $caminho"
  exit 0
fi

# --- 2) sem a API: Caddyfile
CF=/etc/caddy/Caddyfile
[ -r "$CF" ] && grep -qF "$DOMINIO" "$CF" && exit 0
[ -f "$MARCA" ] && [ "$MARCA" -nt "$0" ] && exit 0
[ -e "$CF" ] || falhou "API do Caddy fora do ar e $CF não existe. $(diagnostico)"
[ -r "$CF" ] || falhou "sem leitura em $CF ($(stat -c '%U:%G %a' "$CF")). $(diagnostico)"
grep -qF "$SITE" "$CF" || falhou "$CF não tem o site da apuração. $(diagnostico)"

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
