# Apuração 2026 · Modo Luta

A apuração de presidente de 2026 mostrada como luta de boxe em pixel art, com os dados oficiais do TSE ao vivo.
Os dois mais votados sobem no ringue; quem tem mais votos válidos bate mais e empurra o rival para o corner. Passou de 50%, é nocaute.

No ar: https://apuracaox1doscria.duckdns.org (o endereço antigo, https://apuracao-204-216-184-199.sslip.io, continua funcionando).

## Dados (TSE)

- `oficial/comum/config/ele-c.json`: lista de eleições. 6257 = 1º turno (04/10/2026), 6258 = 2º turno (25/10/2026).
- `oficial/ele2026/<eleição>/dados/<uf>/<uf>-c0001-e00<eleição>-u.json`: resultado de presidente para `br`, cada UF e `zz` (exterior).
- Situação final pelos campos do próprio TSE: `md` = `E` (matematicamente eleito) ou `S` (2º turno); `tf` = `S` (totalização finalizada).

## Back (`server.js`, Node 20, sem dependências)

- Baixa os 29 arquivos a cada 15 s com `If-None-Match` e ignora cópias antigas vindas do CDN (compara `dg/hg`, a hora de geração,
  que é sempre de Brasília; `dt/ht` segue o fuso da última seção: Acre, Amazonas, Noronha, exterior).
- **Placar nacional pela soma dos estados:** o arquivo `br` do TSE sai vários minutos depois dos estaduais. Quando os 28 arquivos
  (27 UFs + exterior) somam mais seções totalizadas que o `br`, o Brasil vem dessa soma (`atual.origem = "estados"`).
  O `md`/`tf` (resultado oficial) continuam vindo do `br`.
- Histórico: no máximo um ponto por minuto de dados; entre um e outro, o último ponto acompanha os números.
- Cada ponto guarda Brasil, 5 regiões e 28 UFs: `[seções totalizadas, seções, válidos, comparecimento, abstenção, brancos, nulos, {número: votos}]`.
- Histórico em `data/historico-<eleição>.json`. O 2º turno é consultado a cada 5 min até o TSE publicar os arquivos.
- Público online: cada aba visível manda um id aleatório (`&id=`) nas consultas; `online` = ids vistos nos últimos 40 s.
- API: `GET /api/estado?v=2&turno=1|2&desde=<ms>&id=<aba>` (formato novo, com `online`), `GET /api/estado` (formato da página v1),
  `GET /api/versao` (commit em uso e falha do `caddy.sh`, se houver), `GET /health`.

## Front (`public/index.html`)

Versão atual: port da v1 do design (`design/Apuracao Luta.dc.html`) para HTML/JS puro, ligada ao formato v1 da API.
Modo ao vivo (consulta a cada 15 s) e replay do histórico, com virada, marcos de apuração, regiões e resultado oficial.

**Pendente:** portar `design/Apuracao Luta v2.dc.html` (escolha de Brasil/região/UF, 1º/2º turno, mapa de estados,
modo jogável, especial, estatísticas, som). O back já entrega tudo o que a v2 precisa em `/api/estado?v=2`.

## Deploy

O servidor Oracle (`/home/ubuntu/projects/apuracao`, serviço systemd `apuracao` na porta 3100, atrás do Caddy)
é um clone deste repositório. O `apuracao-atualizar.timer` roda `scripts/atualizar.sh` a cada minuto:
puxa o `main`, valida o `server.js` e reinicia o serviço só quando o back muda. Ou seja, **push no `main` = deploy** em até 1 minuto.
Forçar agora: `sudo systemctl start apuracao-atualizar`. Logs: `journalctl -u apuracao-atualizar`.

Domínio: o DuckDNS `apuracaox1doscria.duckdns.org` aponta para o IP do servidor. A cada execução, o `atualizar.sh` chama
`scripts/caddy.sh`, que acrescenta ao `/etc/caddy/Caddyfile` um bloco com esse domínio (mesmo `reverse_proxy` do site do sslip.io),
valida com `caddy validate` e recarrega o Caddy; o certificado sai sozinho pelo Let's Encrypt. Se o domínio já está no Caddyfile,
não faz nada. Se algo falhar, o Caddyfile anterior é mantido (cópia em `Caddyfile.antes-duckdns`) e o motivo fica em `data/caddy-falhou`.

## Rodar local

```
PORT=3100 node server.js
```

## Histórico

- 04/10/2026: coletor do TSE, API e página v1 publicados; histórico deduplicado por atualização nacional.
- 04/10/2026: back v2 com histórico por UF/região, suporte ao 2º turno e API `?v=2`; atualização automática pelo GitHub.
