# Apuração 2026 · Modo Luta

A apuração de presidente de 2026 mostrada como luta de boxe em pixel art, com os dados oficiais do TSE ao vivo.
Os dois mais votados sobem no ringue; quem tem mais votos válidos bate mais e empurra o rival para o corner. Passou de 50%, é nocaute.

No ar: https://apuracaox1doscria.duckdns.org (o endereço antigo, https://apuracao-204-216-184-199.sslip.io, continua funcionando).

## Dados (TSE)

- `oficial/comum/config/ele-c.json`: lista de eleições. 6257 = 1º turno (04/10/2026), 6258 = 2º turno (25/10/2026).
- `oficial/ele2026/<eleição>/dados/<uf>/<uf>-c0001-e00<eleição>-u.json`: resultado de presidente para `br`, cada UF e `zz` (exterior).
- Situação final pelos campos do próprio TSE: `md` = `E` (matematicamente eleito) ou `S` (2º turno); `tf` = `S` (totalização finalizada).
  Com a totalização finalizada, o TSE **tira o `md`** do arquivo e marca `e = "s"` também em quem vai ao 2º turno
  (`st = "2º turno"`); aí o resultado sai da situação (`st`) dos candidatos: eleito é só quem tem `st = "Eleito"`.

## Back (`server.js`, Node 20, sem dependências)

- Baixa os 29 arquivos a cada 15 s com `If-None-Match` e ignora cópias antigas vindas do CDN (compara `dg/hg`, a hora de geração,
  que é sempre de Brasília; `dt/ht` segue o fuso da última seção: Acre, Amazonas, Noronha, exterior).
- **Placar nacional pela soma dos estados:** o arquivo `br` do TSE sai vários minutos depois dos estaduais. Quando os 28 arquivos
  (27 UFs + exterior) somam mais seções totalizadas que o `br`, o Brasil vem dessa soma (`atual.origem = "estados"`).
  O `md`/`tf` (resultado oficial) continuam vindo do `br`.
- Histórico: no máximo um ponto por minuto de dados; entre um e outro, o último ponto acompanha os números.
- Cada ponto guarda Brasil, 5 regiões e 28 UFs: `[seções totalizadas, seções, válidos, comparecimento, abstenção, brancos, nulos, {número: votos}]`.
- Histórico em `data/historico-<eleição>.json`. Um turno sem arquivos no TSE é consultado a cada 5 min, e a cada 15 s
  a partir de 1 h antes de as urnas fecharem (no dia 25/10, das 16h de Brasília em diante), para a página entrar no
  2º turno assim que os arquivos saírem.
- Público online: cada navegador guarda um id aleatório (F5 e outras abas não contam de novo) e o manda (`&id=`) nas
  consultas com a página visível; `online` = ids vistos nos últimos 40 s.
- `eleitorado` na API: eleitorado total do TSE (`e.te`) por área (Brasil, regiões, UFs, exterior). A página usa para o
  peso de cada estado e para saber quantos eleitores ainda faltam apurar (eleitorado menos comparecimento e abstenção
  das seções já apuradas), que é a conta do "matematicamente eleito".
- `t1` na API (só na carga completa do 2º turno): o último ponto do 1º turno por área, para comparar os turnos.
- API: `GET /api/estado?v=2&turno=1|2&desde=<ms>&id=<aba>` (formato novo, com `online`), `GET /api/estado` (formato da página v1),
  `GET /api/versao` (commit em uso e falha do `caddy.sh`, se houver), `GET /health`.

## Front (`public/index.html`)

Port de `design/Apuracao Luta v5.dc.html` para HTML/JS puro, ligado a `/api/estado?v=2` (consulta a cada 10 s).
Os desenhos anteriores (v1 a v4) ficam em `design/` como referência.

- **Intervalo** entre os turnos (botão INTERVALO; é onde a página abre quando o 1º turno termina sem nocaute e o 2º
  ainda não começou): resultado do 1º turno, contagem regressiva até as urnas do 2º turno fecharem (horário vindo do
  servidor), o treino do dia no ringue, que segue o calendário de 5 a 25/10 e muda sozinho à meia-noite de Brasília
  (corner, coletiva, saco, corda, comício, corrida, debate, flexões, manopla, sombra, pesagem, véspera e, no dia 25,
  a encarada), a faixa dos dias até a luta, sala de golpes (os 25 golpes,
  um a um ou em demo), palpite para o 2º turno (salvo no aparelho; o banner do nocaute diz se acertou), torcida com
  confete e o painel de previsão do 1º turno com a conta do 2º. Quando o 2º turno começa, a página vai sozinha para ele.
- Brasil, região, UF ou exterior (seletor, mapa de quadradinhos, regiões clicáveis, "disputa mais apertada"); 1º/2º turno.
- Ao vivo e replay do histórico (1×, 2×, 4×, 8×), com marcas de virada na linha do tempo; lance a lance por área.
  A linha do tempo anda pela apuração, não pelo relógio: a posição mistura 90% da parte das urnas apuradas na área
  com 10% da hora. O replay (60 s em 1×) passa devagar quando as urnas chegam em massa e rápido pelas horas em que
  quase nada muda (no 1º turno, o Brasil foi de 90% a 100% em 7 das 10 horas); o meio da barra é ~50% das urnas.
  A linha do tempo de cada área vai até ela chegar a 100% das urnas apuradas (no 1º turno, o Brasil às 02:59 de 05/10;
  a totalização oficial do TSE só saiu às 12:51, sem mudar votos); depois disso, a página mostra o resultado final.
- Fim de luta quando a área chega a 100% das urnas apuradas (ou com a totalização do TSE). No Brasil, nocaute ou
  2º turno vêm do resultado oficial (`md`/situação dos candidatos); nas outras áreas, dos votos. Quando o TSE confirma
  o 2º turno antes disso, entra um lance "2º TURNO" no lance a lance.
- **Matematicamente eleito / vitória garantida**: antes dos 100%, quando a conta já não deixa virar. No 2º turno, a
  vantagem passa a ser maior que os eleitores que faltam apurar; no 1º, o líder já tem mais da metade de todos os votos
  válidos possíveis (os que faltam contados como válidos). No Brasil vale também a declaração do TSE (`md = E`).
  O selo do round vira ELEITO/GARANTIDO, aparece uma faixa amarela com a conta e o ringue ganha aura dourada.
- **Supercenas** (7,4 s no "matematicamente eleito", 6,4 s no nocaute), com os estados onde o vencedor abriu
  vantagem em cada golpe; Espaço, Esc, Enter ou um toque no ringue pulam. Desligadas para quem pede menos movimento.
  No fundo do ringue, easter eggs: estrela cadente, ET de Varginha, placas da torcida, vira-lata caramelo e capivara.
- **Entenda a apuração** (computador: visão geral; celular: aba RESUMO): o momento em uma frase, quanto o 2º colocado
  precisa dos votos que faltam, cartões (vantagem a cada 100 votos, em Maracanãs, hora prevista para 100% no ritmo
  dos últimos 20 min, estados de cada um e o eleitorado deles), "se fossem 100 eleitores", onde estão os votos que
  faltam e onde cada um ganhou mais votos.
- **Aba DADOS** (computador: botão ao lado de VISÃO GERAL; celular: última aba), sempre para o local e o momento da
  linha do tempo: curva da apuração (% dos válidos por % das urnas, com as viradas), quanto falta e quanto o 2º
  precisa, ritmo da apuração por região, saldo de votos por estado, estados mais disputados, quem ganhou terreno no
  2º turno (contra o fim do 1º turno de 2026 ou o 2º turno de 2022), comparecimento (com 2022), peso do eleitorado
  (mapa de retângulos proporcionais ao eleitorado) e a tabela de todos os estados, ordenável e com download em CSV
  (ponto e vírgula e vírgula decimal, abre no Excel). Os números de 2022 foram conferidos com os dados abertos do TSE
  (`votacao_partido_munzona_2022_BR` e `detalhe_votacao_munzona_2022_BR`). No replay, a aba se refaz no máximo ~3 vezes por segundo.
- Modo jogável com 25 golpes (socos, chutes, joelhadas, aéreos, arremesso, especial e ultra, provocação, esquiva) pelo
  teclado ou pelos botões; especial carregado pelos votos e por golpes certos. A ULTRA (tecla 1) fica liberada para
  quem joga, sem precisar nem gastar o especial (os lutadores automáticos ainda dependem da barra). Quedas, tontura, contra-golpes e juiz
  que conta as quedas e, no nocaute, conta até 10 e levanta o braço do vencedor. Estatísticas, som e vibração.
- Público online no topo. Layout de celular (largura < 720 px ou altura < 500 px): placar e ringue fixos no topo,
  golpes principais embaixo do ringue (os outros numa faixa que rola de lado) e abas Resumo / Previsão / Estados /
  Lances / Regiões / Luta / Dados.
- Abre no 2º turno quando ele estiver disponível (antes disso, no intervalo); `?turno=1` força a luta do 1º turno.
- **Previsão** (primeiro painel; no celular, aba PREVISÃO), refeita a cada ponto, também no replay e para cada área:
  - em cada UF, os votos que faltam (estimados pelas seções que faltam) se dividem como os das últimas urnas apuradas
    nela (últimos 10 pontos de seções). Testado com a noite do 1º turno: mais estável que usar só o acumulado;
  - todos os candidatos entram (os 5 mais votados um a um, os demais juntos); 1.200 simulações com erro nacional (4,5%)
    e por UF (8%) na divisão de cada candidato e 5% no comparecimento do que falta. Daí saem a chance de vitória no
    1º turno de cada um, a de 2º turno e a faixa de 90% do resultado final; o resultado oficial do TSE prevalece;
  - 2º turno: os votos dos outros candidatos decidem. A página mostra quanto deles cada um precisa e a chance de vencer
    supondo qualquer divisão desses votos igualmente provável (não há dado sobre para onde vão);
  - gráfico "ao longo da apuração" com a projeção tracejada e tabela por região (líder, % apurado, votos que faltam,
    projeção e chance de o líder terminar na frente).

## Segurança

- HTTPS pelo Caddy (HTTP redireciona) e `Strict-Transport-Security` de 1 ano.
- Content-Security-Policy: a página só roda o próprio script (liberado pelo hash SHA-256, calculado pelo servidor a
  cada vez que serve o `index.html`, então editar a página não quebra a política), o CSS dela e as fontes do Google;
  só consulta o próprio servidor. As respostas da API e do favicon têm `default-src 'none'`.
- Não pode ser aberta dentro de iframe (`frame-ancestors 'none'` e `X-Frame-Options: DENY`); `nosniff`,
  `Referrer-Policy`, `Permissions-Policy` (câmera, microfone, localização etc. desligados), COOP e CORP.
- Só GET/HEAD; arquivos estáticos por lista fixa (`index.html`, `favicon.svg` e `og.png`, a imagem de prévia dos
  links compartilhados, que pode ser carregada por outros sites); URL acima de 2 KB recusada.
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

- 11/10/2026: ULTRA liberada para quem joga (no celular, primeira da faixa de golpes).
- 06/10/2026: limpeza: título `h1` único, prévia completa para redes sociais (`og.png`, 1200×630, feita com a cena
  da encarada), sem cartão dentro de cartão no Entenda, indicador de online sem piscar, textos mais diretos, sem
  comentários que só repetiam o código.
- 05/10/2026: replay e linha do tempo pela % de urnas apuradas; 2º turno consultado a cada 15 s a partir das 16h de 25/10.
- 05/10/2026: front v5: Entenda a apuração, aba DADOS (gráficos, tabela e CSV), matematicamente eleito/vitória
  garantida pelo eleitorado do TSE, supercenas, easter eggs, juiz novo e treinos redesenhados; a luta termina nos
  100% das urnas. Back: `eleitorado` por área e `t1` (fim do 1º turno) no 2º turno.
- 05/10/2026: replay só até 100% das urnas apuradas (antes ia até a totalização oficial, às 12:51).
- 05/10/2026: o treino do intervalo segue a data (sem escolher dia nem montagem).
- 05/10/2026: corrigido "Flávio eleito no 1º turno" depois da totalização (o TSE passou a marcar os dois do 2º turno como `e = "s"`).
- 04/10/2026: front v3: intervalo até o 2º turno (calendário de treinos, contagem, sala de golpes, palpite, torcida),
  25 golpes, quedas e juiz no ringue.
- 04/10/2026: coletor do TSE, API e página v1 publicados; histórico deduplicado por atualização nacional.
- 04/10/2026: back v2 com histórico por UF/região, suporte ao 2º turno e API `?v=2`; atualização automática pelo GitHub.
- 04/10/2026: painel de previsão (projeção por UF, chances por simulação, conta do 2º turno).
- 04/10/2026: cabeçalhos de segurança (CSP, HSTS, anti-iframe), limite por IP e cache do histórico na API.
- 04/10/2026: placar nacional pela soma dos estados (o arquivo nacional do TSE atrasava minutos); público online;
  front v2 (estados, 2º turno, modo jogável, layout de celular); domínio apuracaox1doscria.duckdns.org.
