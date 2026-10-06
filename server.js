'use strict';
// Apuração Luta: coleta os resultados de presidente de 2026 (1º e 2º turno) direto do TSE,
// guarda o histórico por Brasil, região e UF em data/ e serve a página + /api/estado.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = process.env.TSE_BASE || 'https://resultados.tse.jus.br/oficial/ele2026';
const INTERVALO = Number(process.env.INTERVALO_MS || 15000);
const INTERVALO_LENTO = 5 * 60 * 1000; // 2º turno ainda sem arquivos, ou totalização encerrada
const ANTES = 60 * 60 * 1000; // a partir de quanto antes do fechamento das urnas o turno sem arquivos é consultado no ritmo normal
const PASSO = 60 * 1000; // no máximo um ponto de histórico por minuto de dados
const NO_AR = Date.now();
const DATA = path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');

const TURNOS = [
  { turno: 1, eleicao: '6257', inicio: Date.parse('2026-10-04T17:00:00-03:00') },
  { turno: 2, eleicao: '6258', inicio: Date.parse('2026-10-25T17:00:00-03:00') },
];
const REGIOES = [
  { id: 'r:SE', nome: 'Sudeste', ufs: ['es', 'mg', 'rj', 'sp'] },
  { id: 'r:S', nome: 'Sul', ufs: ['pr', 'rs', 'sc'] },
  { id: 'r:CO', nome: 'Centro-Oeste', ufs: ['df', 'go', 'ms', 'mt'] },
  { id: 'r:NE', nome: 'Nordeste', ufs: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'] },
  { id: 'r:N', nome: 'Norte', ufs: ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to'] },
];
const UFS = [...REGIOES.flatMap((r) => r.ufs), 'zz'];
const ABRS = ['br', ...UFS];

// ---------- leitura dos arquivos do TSE ----------

function num(s) {
  if (s === undefined || s === null || s === '') return 0;
  const v = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
}

function horaTSE(d, h) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || '');
  if (!m || !/^\d{2}:\d{2}:\d{2}$/.test(h || '')) return 0;
  const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${h}-03:00`);
  return Number.isFinite(t) ? t : 0;
}
// dg/hg (geração do arquivo) estão sempre no horário de Brasília; dt/ht seguem o fuso local da última seção
// (Acre, Amazonas, Noronha, exterior), então não servem para comparar versões nem arquivos entre si.
const gerado = (d) => horaTSE(d.dg, d.hg) || horaTSE(d.dt, d.ht);
const brasilia = (t) => new Date(t - 3 * 3600 * 1000).toISOString(); // o Brasil não tem horário de verão desde 2019
const hora = (t) => brasilia(t).slice(11, 19);
const dia = (t) => brasilia(t).slice(0, 10).split('-').reverse().join('/');

function ler(j) {
  const carg = (j.carg || [])[0] || {};
  const cands = [];
  for (const a of carg.agr || []) {
    for (const p of a.par || []) {
      for (const c of p.cand || []) {
        // depois da totalização o TSE marca e = "s" também em quem vai ao 2º turno (st = "2º turno"): eleito é só st = "Eleito"
        const st = c.st || '', turno2 = /2º turno|2o turno|segundo turno/i.test(st);
        cands.push({
          n: String(c.n), nome: c.nmu || c.nm, completo: c.nm, partido: p.sg,
          votos: num(c.vap), eleito: c.e === 's' && !turno2, situacao: st, destino: c.dvt || '',
        });
      }
    }
  }
  const s = j.s || {}, e = j.e || {}, v = j.v || {};
  // md: "N" indefinido, "E" matematicamente eleito, "S" matematicamente 2º turno (como no app do TSE).
  // Com a totalização finalizada, o TSE tira o md do arquivo: aí o resultado sai da situação dos candidatos.
  let md = String(j.md || '').toUpperCase();
  if (!md) md = cands.some((c) => /2º turno|2o turno|segundo turno/i.test(c.situacao)) ? 'S' : cands.some((c) => c.eleito) ? 'E' : 'N';
  return {
    dg: j.dg, hg: j.hg, dt: j.dt, ht: j.ht, md, tf: String(j.tf || 'N').toUpperCase(),
    ts: num(s.ts), st: num(s.st), pst: num(s.pstn),
    eleitorado: num(e.te), // eleitorado total da abrangência (as seções não apuradas têm e.esnt eleitores)
    comparecimento: num(e.c), abstencao: num(e.a),
    vv: num(v.vv), brancos: num(v.vb), nulos: num(v.tvn), cands,
  };
}

// entrada compacta de uma abrangência: [seções totalizadas, seções, válidos, comparecimento, abstenção, brancos, nulos, {número: votos}]
function entrada(u) {
  const votos = {};
  for (const c of u.cands) if (c.votos) votos[c.n] = c.votos;
  return [u.st, u.ts, u.vv, u.comparecimento, u.abstencao, u.brancos, u.nulos, votos];
}
function somar(lista) {
  const r = [0, 0, 0, 0, 0, 0, 0, {}];
  for (const x of lista) {
    for (let i = 0; i < 7; i++) r[i] += x[i] || 0;
    for (const n in x[7]) r[7][n] = (r[7][n] || 0) + x[7][n];
  }
  return r;
}

// ---------- estado por turno ----------

const estados = TURNOS.map((T) => ({
  ...T,
  arquivo: path.join(DATA, `historico-${T.eleicao}.json`),
  cache: new Map(),
  hist: [],
  atual: null,
  ativo: T.turno === 1,
  coleta: { ultima: null, erro: null, falhas: 0 },
}));

function url(T, abr) { return `${BASE}/${T.eleicao}/dados/${abr}/${abr}-c0001-e00${T.eleicao}-u.json`; }

async function baixar(T, abr) {
  const c = T.cache.get(abr);
  const headers = { 'User-Agent': 'apuracao-luta/2.1 (+https://apuracaox1doscria.duckdns.org)' };
  if (c && c.etag) headers['If-None-Match'] = c.etag;
  const r = await fetch(url(T, abr), { headers, signal: AbortSignal.timeout(15000) });
  if (r.status === 304 && c) return c.dados;
  if (!r.ok) { const e = new Error(`${abr}: HTTP ${r.status}`); e.status = r.status; throw e; }
  const dados = ler(await r.json());
  // um nó do CDN pode devolver uma versão anterior à que já temos
  if (c && gerado(dados) < gerado(c.dados)) return c.dados;
  T.cache.set(abr, { etag: r.headers.get('etag'), dados });
  return dados;
}

async function emLotes(itens, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) await fn(itens[i++]); }));
}

// histórico da primeira versão (só Brasil e regiões, votos em "v" e regiões em "r")
function converterAntigo(h) {
  return h.map((p) => {
    if (p.d) return p;
    const d = {};
    if (!p.inicio) d.br = [p.st, p.ts, p.vv, p.c || 0, p.ab || 0, p.b || 0, p.nu || 0, p.v || {}];
    for (const id in p.r || {}) {
      const [st, ts, vv, votos] = p.r[id];
      if (id === 'ZZ') d.zz = [st, ts, vv, 0, 0, 0, 0, votos];
      else d['r:' + id] = [st, ts, vv, 0, 0, 0, 0, votos];
    }
    return { t: p.t, ht: p.ht, def: p.def || 0, fim: p.fim || 0, ...(p.inicio ? { inicio: 1 } : {}), d };
  });
}

function carregar(T) {
  let h = null;
  try { h = JSON.parse(fs.readFileSync(T.arquivo, 'utf8')); } catch { /* ainda não existe */ }
  if (!h && T.turno === 1) {
    try { h = converterAntigo(JSON.parse(fs.readFileSync(path.join(DATA, 'historico.json'), 'utf8'))); } catch { /* sem histórico antigo */ }
  }
  T.hist = Array.isArray(h) ? h : [];
  if (T.hist.length) salvar(T);
}

function salvar(T) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = T.arquivo + '.tmp';
  T.histJSON = JSON.stringify(T.hist); // reaproveitado pela API quando a página carrega do zero
  T.legadoJSON = null;
  fs.writeFileSync(tmp, T.histJSON);
  fs.renameSync(tmp, T.arquivo);
}

// O arquivo nacional do TSE sai minutos depois dos estaduais. Quando os 28 arquivos estaduais (com o exterior)
// já somam mais seções totalizadas que o nacional, o placar do Brasil vem dessa soma.
function nacional(res) {
  const br = res.br;
  if (UFS.every((uf) => res[uf])) {
    const s = somar(UFS.map((uf) => entrada(res[uf])));
    if (s[0] > br.st) return { e: s, t: Math.max(...UFS.map((uf) => gerado(res[uf]))), estados: true };
  }
  return { e: entrada(br), t: gerado(br), estados: false };
}

function ponto(T, res, nac) {
  const br = res.br, d = { br: nac.e };
  for (const uf of UFS) if (res[uf]) d[uf] = entrada(res[uf]);
  for (const R of REGIOES) {
    const partes = R.ufs.map((uf) => d[uf]).filter(Boolean);
    if (partes.length === R.ufs.length) d[R.id] = somar(partes);
  }
  const t = nac.t || Date.now();
  return { t, ht: hora(t), def: br.md === 'E' || br.md === 'S' ? br.md : 0, fim: br.tf === 'S' ? 1 : 0, d };
}

async function ciclo(T) {
  if (!T.ativo) {
    try { await baixar(T, 'br'); T.ativo = true; console.log(`turno ${T.turno}: arquivos do TSE disponíveis`); } catch { return; }
  }
  const res = {};
  let falhas = 0;
  await emLotes(ABRS, 6, async (abr) => {
    try { res[abr] = await baixar(T, abr); } catch {
      falhas++;
      const c = T.cache.get(abr);
      if (c) res[abr] = c.dados;
    }
  });
  T.coleta.ultima = Date.now();
  T.coleta.falhas = falhas;
  if (!res.br) { T.coleta.erro = 'TSE indisponível no momento'; return; }
  T.coleta.erro = null;
  const br = res.br, nac = nacional(res), [st, ts, vv, , , , , votos] = nac.e;
  T.eleitorado = eleitorado(res);
  T.atual = {
    t: nac.t, dg: br.dg, hg: br.hg, dt: dia(nac.t), ht: hora(nac.t), origem: nac.estados ? 'estados' : 'br',
    definido: br.md === 'E' || br.md === 'S' ? br.md : '', finalizado: br.tf === 'S',
    ts, st, pst: nac.estados ? (ts ? (st / ts) * 100 : 0) : br.pst, vv,
    cands: br.cands.map((c) => ({ ...c, votos: votos[c.n] || 0 })).sort((a, b) => b.votos - a.votos),
  };
  const p = ponto(T, res, nac);
  if (!T.hist.length) T.hist.push({ t: T.inicio, ht: '17:00:00', def: 0, fim: 0, inicio: 1, d: {} });
  const u = T.hist[T.hist.length - 1];
  if (JSON.stringify([u.def, u.fim, u.d]) === JSON.stringify([p.def, p.fim, p.d])) return;
  // um ponto novo por minuto de dados; entre um e outro, o último ponto acompanha os dados (hora e números)
  if (u.inicio || p.t - (T.ancora || u.t) >= PASSO) {
    if (p.t <= u.t) p.t = u.t + 1000;
    T.hist.push(p);
    T.ancora = p.t;
  } else {
    u.t = Math.max(u.t, p.t); u.ht = hora(u.t); u.def = p.def; u.fim = p.fim; u.d = p.d;
  }
  salvar(T);
}

// eleitorado total por abrangência (não muda durante a apuração): a página usa para o peso de cada estado e para saber
// quantos eleitores ainda faltam apurar (eleitorado menos comparecimento e abstenção das seções já apuradas)
function eleitorado(res) {
  const r = {};
  for (const uf of UFS) if (res[uf] && res[uf].eleitorado) r[uf] = res[uf].eleitorado;
  for (const R of REGIOES) if (R.ufs.every((uf) => r[uf])) r[R.id] = R.ufs.reduce((s, uf) => s + r[uf], 0);
  if (res.br && res.br.eleitorado) r.br = res.br.eleitorado;
  return r;
}

async function laco(T) {
  try { await ciclo(T); } catch (e) { T.coleta.erro = String(e.message || e); console.error(`turno ${T.turno}:`, T.coleta.erro); }
  if (T.coleta.falhas) console.error(`turno ${T.turno}: ${T.coleta.falhas} arquivo(s) falharam`);
  // sem arquivos do TSE ainda: a cada 5 min, mas a partir de 1 h antes de as urnas fecharem, a cada 15 s
  // (os arquivos do 2º turno aparecem perto das 17h e a página deve entrar nele assim que saírem)
  const falta = T.ativo ? 0 : T.inicio - ANTES - Date.now();
  const lento = falta > 0 || (T.atual && T.atual.finalizado);
  setTimeout(() => laco(T), !lento ? INTERVALO : falta > 0 ? Math.max(INTERVALO, Math.min(INTERVALO_LENTO, falta)) : INTERVALO_LENTO);
}

// ---------- público online ----------
// Cada aba visível da página manda um id aleatório (?id=) nas consultas; conta quem apareceu nos últimos 40 s.
// O Map fica em ordem de última visita, então a limpeza só olha o começo dele.
const ONLINE_MS = 40 * 1000;
const vistos = new Map(); // id -> { t, ip }
const porIp = new Map(); // ip -> ids ativos (limita quem tenta inflar a contagem)
function visto(req, id) {
  if (!/^[A-Za-z0-9]{8,32}$/.test(id || '')) return;
  const v = vistos.get(id);
  if (v) { vistos.delete(id); v.t = Date.now(); vistos.set(id, v); return; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if ((porIp.get(ip) || 0) >= 30 || vistos.size >= 200000) return;
  vistos.set(id, { t: Date.now(), ip });
  porIp.set(ip, (porIp.get(ip) || 0) + 1);
}
function online() {
  const lim = Date.now() - ONLINE_MS;
  for (const [id, v] of vistos) {
    if (v.t >= lim) break;
    vistos.delete(id);
    const n = (porIp.get(v.ip) || 1) - 1;
    if (n > 0) porIp.set(v.ip, n); else porIp.delete(v.ip);
  }
  return vistos.size;
}

// ---------- HTTP ----------

// ---------- segurança ----------
// Cabeçalhos em todas as respostas. A página só carrega o próprio script (pelo hash, calculado na hora em que ela é
// servida), o CSS dela e as fontes do Google; não pode ser posta num iframe nem chamar outros endereços.
const SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
};
const CSP_RESTO = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
function cspPagina(html) {
  const hashes = [];
  for (const m of html.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return [`default-src 'none'`, `script-src ${hashes.join(' ') || "'none'"}`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src https://fonts.gstatic.com`, `img-src 'self' data:`, `connect-src 'self'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`].join('; ');
}
function cabecalhos(extra) { return { ...SEGURANCA, 'Content-Security-Policy': CSP_RESTO, ...extra }; }

// Limite por IP (janela de 1 min): consultas em geral e cargas do histórico completo, que são as pesadas.
// É folgado de propósito: muita gente de operadora de celular sai pelo mesmo IP.
const LIMITE = { janela: 60 * 1000, geral: 600, cheio: 120 };
const acessos = new Map(); // ip -> { ini, n, cheio }
function ipDe(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function permitido(ip, cheio) {
  const agora = Date.now();
  let a = acessos.get(ip);
  if (!a || agora - a.ini >= LIMITE.janela) { a = { ini: agora, n: 0, cheio: 0 }; acessos.set(ip, a); }
  a.n++;
  if (cheio) a.cheio++;
  // estourar as cargas completas não corta a atualização de quem já está com a página aberta
  return a.n <= LIMITE.geral && (!cheio || a.cheio <= LIMITE.cheio);
}
setInterval(() => { const lim = Date.now() - LIMITE.janela; for (const [ip, a] of acessos) if (a.ini < lim) acessos.delete(ip); }, LIMITE.janela).unref();

function json(res, code, obj, extra) {
  res.writeHead(code, cabecalhos({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }));
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
// resposta com o histórico já serializado no fim (sem refazer o JSON de todos os pontos a cada página aberta)
const comHist = (obj, histJSON) => JSON.stringify(obj).slice(0, -1) + ',"hist":' + histJSON + '}';

const disponivel = (T) => !!(T.ativo && T.atual && Date.now() >= T.inicio);

// formato da primeira versão da página (sem ?v=2), mantido enquanto houver aba antiga aberta
const LEGADO = [['SE', 'r:SE', 'Sudeste'], ['S', 'r:S', 'Sul'], ['CO', 'r:CO', 'Centro-Oeste'], ['NE', 'r:NE', 'Nordeste'], ['N', 'r:N', 'Norte'], ['ZZ', 'zz', 'Exterior']];
function legado(p) {
  const b = p.d.br || [0, 0, 0, 0, 0, 0, 0, {}], r = {};
  for (const [id, k] of LEGADO) { const x = p.d[k]; if (x) r[id] = [x[0], x[1], x[2], x[7]]; }
  return { t: p.t, ht: p.ht, st: b[0], ts: b[1], pst: b[1] ? (b[0] / b[1]) * 100 : 0, vv: b[2], c: b[3], ab: b[4], b: b[5], nu: b[6], def: p.def, fim: p.fim, v: b[7], r, ...(p.inicio ? { inicio: 1 } : {}) };
}

// commit em uso (a pasta do servidor é um clone do repositório) e o resultado do scripts/caddy.sh, para conferir o deploy
function commit() {
  const git = (f) => fs.readFileSync(path.join(__dirname, '.git', f), 'utf8');
  try {
    const head = git('HEAD').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    try { return git(ref).trim(); } catch { /* ref compactada */ }
    const l = git('packed-refs').split('\n').find((x) => x.endsWith(' ' + ref));
    return l ? l.split(' ')[0] : null;
  } catch { return null; }
}
function versao() {
  // o detalhe de uma falha do caddy.sh fica só em data/caddy-falhou e no journal, não na resposta pública
  return { commit: commit(), noAr: NO_AR, caddy: fs.existsSync(path.join(DATA, 'caddy-falhou')) ? 'falhou' : 'ok' };
}

const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/og.png': ['og.png', 'image/png'], // prévia de quando o link é compartilhado
};

function atender(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, cabecalhos({ Allow: 'GET, HEAD' })); return res.end(); }
  if (req.url.length > 2048) { res.writeHead(414, cabecalhos()); return res.end(); }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200, cabecalhos({ 'Content-Type': 'text/plain' })); return res.end('ok\n'); }
  const api = u.pathname.startsWith('/api/'), desde = Number(u.searchParams.get('desde')) || 0;
  if (!permitido(ipDe(req), u.pathname === '/api/estado' && !desde)) {
    return json(res, 429, { erro: 'muitas consultas; tente de novo em instantes' }, { 'Retry-After': '30' });
  }
  if (u.pathname === '/api/versao') return json(res, 200, versao());
  if (u.pathname === '/api/estado') {
    const T = estados.find((x) => String(x.turno) === (u.searchParams.get('turno') || '1')) || estados[0];
    visto(req, u.searchParams.get('id'));
    if (u.searchParams.get('v') !== '2') {
      if (!T.atual) return json(res, 503, { erro: T.coleta.erro || 'coletando os primeiros dados do TSE' });
      const cab = { inicio: T.inicio, regioes: LEGADO.map(([id, , nome]) => ({ id, nome })), atual: T.atual };
      if (!desde) return json(res, 200, comHist(cab, T.legadoJSON || (T.legadoJSON = JSON.stringify(T.hist.map(legado)))));
      return json(res, 200, { ...cab, hist: T.hist.filter((p, i) => p.t > desde || i === T.hist.length - 1).map(legado) });
    }
    const base = {
      turno: T.turno, eleicao: T.eleicao, inicio: T.inicio,
      turnos: estados.map((x) => ({ turno: x.turno, disponivel: disponivel(x), inicio: x.inicio })),
      online: online(),
      regioes: REGIOES.map((r) => ({ id: r.id, nome: r.nome, ufs: r.ufs })),
      fonte: `https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/${T.eleicao}/uf/br/cargo/1/vis/nominal/resultados`,
    };
    if (!disponivel(T)) {
      if (T.turno === 1 && !T.atual) return json(res, 503, { ...base, erro: T.coleta.erro || 'coletando os primeiros dados do TSE' });
      return json(res, 200, { ...base, atual: null, hist: [] });
    }
    const cab = { ...base, atual: T.atual, eleitorado: T.eleitorado || {}, coleta: { ultima: T.coleta.ultima, erro: T.coleta.erro, falhas: T.coleta.falhas } };
    // no 2º turno, a carga completa leva o fim do 1º turno por área (comparação entre os turnos na aba de dados)
    const h1 = estados[0].hist;
    if (T.turno === 2 && !desde && h1.length) cab.t1 = { t: h1[h1.length - 1].t, d: h1[h1.length - 1].d };
    if (!desde) return json(res, 200, comHist(cab, T.histJSON || (T.histJSON = JSON.stringify(T.hist))));
    // o último ponto vai sempre: ele pode ter sido atualizado no lugar
    return json(res, 200, { ...cab, hist: T.hist.filter((p, i) => p.t > desde || i === T.hist.length - 1) });
  }
  const est = !api && ESTATICOS[u.pathname];
  if (!est) { res.writeHead(404, cabecalhos({ 'Content-Type': 'text/plain; charset=utf-8' })); return res.end('não encontrado\n'); }
  fs.readFile(path.join(PUBLIC, est[0]), (err, buf) => {
    if (err) { res.writeHead(500, cabecalhos()); return res.end(); }
    const extra = { 'Content-Type': est[1], 'Cache-Control': 'no-cache' };
    if (est[0] === 'index.html') extra['Content-Security-Policy'] = cspPagina(buf);
    if (est[0] === 'og.png') extra['Cross-Origin-Resource-Policy'] = 'cross-origin'; // apps de mensagem e redes sociais mostram a imagem
    res.writeHead(200, cabecalhos(extra));
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const servidor = http.createServer((req, res) => {
  try { atender(req, res); } catch (e) {
    console.error('erro ao atender', req.url, e);
    if (!res.headersSent) res.writeHead(500, cabecalhos());
    res.end();
  }
});
servidor.headersTimeout = 20 * 1000;
servidor.requestTimeout = 30 * 1000;
servidor.listen(PORT, HOST, () => console.log(`apuracao ouvindo em ${HOST}:${PORT}`));

for (const T of estados) { carregar(T); laco(T); }
