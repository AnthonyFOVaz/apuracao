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

Port de `design/Apuracao Luta v2.dc.html` para HTML/JS puro, ligado a `/api/estado?v=2` (consulta a cada 10 s).

- Brasil, região, UF ou exterior (seletor, mapa de quadradinhos, regiões clicáveis, "disputa mais apertada"); 1º/2º turno.
- Ao vivo e replay do histórico (1×, 2×, 4×, 8×), com marcas de virada na linha do tempo; lance a lance por área.
- Fim de luta: Brasil pelo resultado oficial do TSE (`md`/`tf`); estado ou região quando chega a 100% das seções.
- Modo jogável (teclado ou botões; especial carregado pelos votos e por golpes certos), estatísticas, som e vibração.
- Público online no topo. Layout de celular (largura < 720 px ou altura < 500 px): placar e ringue fixos no topo,
  botões embaixo do ringue e abas Estados / Lances / Regiões / Luta.
- Abre no 2º turno quando ele estiver disponível; `?turno=1` força o 1º.

## Segurança

- HTTPS pelo Caddy (HTTP redireciona) e `Strict-Transport-Security` de 1 ano.
- Content-Security-Policy: a página só roda o próprio script (liberado pelo hash SHA-256, calculado pelo servidor a
  cada vez que serve o `index.html`, então editar a página não quebra a política), o CSS dela e as fontes do Google;
  só consulta o próprio servidor. As respostas da API e do favicon têm `default-src 'none'`.
- Não pode ser aberta dentro de iframe (`frame-ancestors 'none'` e `X-Frame-Options: DENY`); `nosniff`,
  `Referrer-Policy`, `Permissions-Policy` (câmera, microfone, localização etc. desligados), COOP e CORP.
- Só GET/HEAD; arquivos estáticos por lista fixa (sem acesso a outros arquivos); URL acima de 2 KB recusada.
- Limite por IP: 600 consultas/min e 120 cargas do histórico completo/min (resposta 429 com `Retry-After`; a página
  espera e tenta de novo). O histórico completo sai de um JSON já pronto, refeito só quando os dados mudam.
- Um erro ao atender uma requisição não derruba o servidor; tempo máximo para cabeçalhos e requisição.
- `/api/versao` mostra só o commit e se o `caddy.sh` falhou (o detalhe fica em `data/caddy-falhou`).
- O deploy executa o que estiver no `main` do GitHub com permissão de administrador no servidor: proteja a conta
  do GitHub com verificação em duas etapas.

## Deploy

O servidor Oracle (`/home/ubuntu/projects/apuracao`, serviço systemd `apuracao` na porta 3100, atrás do Caddy)
é um clone deste repositório. O `apuracao-atualizar.timer` roda `scripts/atualizar.sh` a cada minuto:
puxa o `main`, valida o `server.js` e reinicia o serviço só quando o back muda. Ou seja, **push no `main` = deploy** em até 1 minuto.
Forçar agora: `sudo systemctl start apuracao-atualizar`. Logs: `journalctl -u apuracao-atualizar`.

Domínio: o DuckDNS `apuracaox1doscria.duckdns.org` aponta para o IP do servidor. O Caddy roda no container `edge-caddy`
(config em `/etc/caddy`, montada só para leitura; o site está em `sites/apuracao.caddy`; API de administração desligada).
A cada execução, o `atualizar.sh` chama
`scripts/caddy.sh`: se o domínio ainda não responde, o script põe o domínio na mesma linha do site do sslip.io (mesmo
bloco, mesma configuração), valida com `caddy validate` dentro do container e reinicia o container (1 a 2 s fora do ar),
conferindo que o sslip.io voltou; se algo falhar, desfaz. O certificado sai sozinho pelo Let's Encrypt.
Com o domínio já respondendo (ou já na config), não faz nada. Falhas ficam em `data/caddy-falhou` e aparecem em `/api/versao`.

## Rodar local

```
PORT=3100 node server.js
```

## Histórico

- 04/10/2026: coletor do TSE, API e página v1 publicados; histórico deduplicado por atualização nacional.
- 04/10/2026: back v2 com histórico por UF/região, suporte ao 2º turno e API `?v=2`; atualização automática pelo GitHub.
- 04/10/2026: cabeçalhos de segurança (CSP, HSTS, anti-iframe), limite por IP e cache do histórico na API.
- 04/10/2026: placar nacional pela soma dos estados (o arquivo nacional do TSE atrasava minutos); público online;
  front v2 (estados, 2º turno, modo jogável, layout de celular); domínio apuracaox1doscria.duckdns.org.
