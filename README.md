# Apuração 2026 · Modo Luta

A apuração do 1º turno para presidente (eleição de 4 de outubro de 2026) mostrada como uma luta de boxe em pixel art.
Os dois candidatos mais votados sobem no ringue; quem tem mais votos válidos bate mais e empurra o rival para o corner.
Passou de 50%, é nocaute.

No ar: https://apuracao-204-216-184-199.sslip.io

## Dados

Tudo vem dos arquivos públicos do TSE, os mesmos que alimentam
[resultados.tse.jus.br](https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/6257/uf/br/cargo/1/vis/nominal/resultados):

- `oficial/comum/config/ele-c.json`: lista de eleições (6257 = Eleição Ordinária Federal 2026, 1º turno).
- `oficial/ele2026/6257/dados/<uf>/<uf>-c0001-e006257-u.json`: resultado de presidente para `br`, cada UF e `zz` (exterior).

O `server.js` (Node 20, sem dependências) baixa esses 29 arquivos a cada 20 segundos com `If-None-Match`,
soma as UFs em regiões, guarda cada mudança em `data/historico.json` e expõe:

- `GET /api/estado?desde=<ms>`: situação atual e os pontos do histórico depois de `desde`.
- `GET /health`

A situação final segue os campos do próprio TSE: `md` = `E` (matematicamente eleito) ou `S` (2º turno), `tf` = `S` (totalização finalizada).

## Página

`public/index.html` é autossuficiente (HTML, CSS e JS sem build). Modos:

- **Ao vivo**: consulta `/api/estado` a cada 15 s; cada atualização vira golpe de quem ganhou mais votos.
- **Replay**: a linha do tempo repassa o histórico coletado desde a abertura das urnas, em 1×, 2× ou 4×.

## Rodar local

```
node server.js          # PORT=3100 HOST=127.0.0.1 por padrão
```

## Deploy

Serviço `apuracao` (systemd) no servidor Oracle, atrás do proxy de borda Caddy. `.\deploy.ps1` copia os arquivos e reinicia.
