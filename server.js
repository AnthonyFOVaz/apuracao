'use strict';
// Apuração Luta: coleta os resultados de presidente (1º turno de 2026) direto do TSE,
// agrega por região, guarda o histórico em data/ e serve a página + /api/estado.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = process.env.TSE_BASE || 'https://resultados.tse.jus.br/oficial/ele2026/6257/dados';
const ARQ = (abr) => `${BASE}/${abr}/${abr}-c0001-e006257-u.json`;
const INTERVALO = Number(process.env.INTERVALO_MS || 20000);
const INICIO = Date.parse('2026-10-04T17:00:00-03:00'); // fechamento das urnas, horário de Brasília
const DATA = path.join(__dirname, 'data');
const HIST_FILE = path.join(DATA, 'historico.json');
const PUBLIC = path.join(__dirname, 'public');

const REGIOES = [
  { id: 'SE', nome: 'Sudeste', ufs: ['es', 'mg', 'rj', 'sp'] },
  { id: 'S', nome: 'Sul', ufs: ['pr', 'rs', 'sc'] },
  { id: 'CO', nome: 'Centro-Oeste', ufs: ['df', 'go', 'ms', 'mt'] },
  { id: 'NE', nome: 'Nordeste', ufs: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'] },
  { id: 'N', nome: 'Norte', ufs: ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to'] },
  { id: 'ZZ', nome: 'Exterior', ufs: ['zz'] },
];
const ABRS = ['br', ...REGIOES.flatMap((r) => r.ufs)];

// ---------- coleta ----------

const cache = new Map(); // abr -> { etag, dados }

function num(s) {
  if (s === undefined || s === null || s === '') return 0;
  const v = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
}

function ler(j) {
  const carg = (j.carg || [])[0] || {};
  const cands = [];
  for (const a of carg.agr || []) {
    for (const p of a.par || []) {
      for (const c of p.cand || []) {
        cands.push({
          n: String(c.n), nome: c.nmu || c.nm, completo: c.nm, partido: p.sg,
          votos: num(c.vap), eleito: c.e === 's', situacao: c.st || '', destino: c.dvt || '',
        });
      }
    }
  }
  const s = j.s || {}, e = j.e || {}, v = j.v || {};
  return {
    // md: "N" indefinido, "E" matematicamente eleito, "S" matematicamente 2º turno (como no app do TSE)
    dg: j.dg, hg: j.hg, dt: j.dt, ht: j.ht, md: String(j.md || 'N').toUpperCase(), tf: String(j.tf || 'N').toUpperCase(),
    ts: num(s.ts), st: num(s.st), pst: num(s.pstn),
    eleitores: num(e.te), comparecimento: num(e.c), abstencao: num(e.a),
    vv: num(v.vv), brancos: num(v.vb), nulos: num(v.tvn), cands,
  };
}

async function baixar(abr) {
  const c = cache.get(abr);
  const headers = { 'User-Agent': 'apuracao-luta/1.0 (+https://apuracao-204-216-184-199.sslip.io)' };
  if (c && c.etag) headers['If-None-Match'] = c.etag;
  const r = await fetch(ARQ(abr), { headers, signal: AbortSignal.timeout(15000) });
  if (r.status === 304 && c) return c.dados;
  if (!r.ok) throw new Error(`${abr}: HTTP ${r.status}`);
  const dados = ler(await r.json());
  cache.set(abr, { etag: r.headers.get('etag'), dados });
  return dados;
}

async function emLotes(itens, n, fn) {
  let i = 0;
  const trab = Array.from({ length: n }, async () => {
    while (i < itens.length) { const x = itens[i++]; await fn(x); }
  });
  await Promise.all(trab);
}

function horaTSE(d, h) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || '');
  if (!m || !/^\d{2}:\d{2}:\d{2}$/.test(h || '')) return Date.now();
  const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${h}-03:00`);
  return Number.isFinite(t) ? t : Date.now();
}

// ---------- estado ----------

let hist = carregar();
let atual = null;
let coleta = { ultima: null, erro: null, falhas: [] };

function carregar() {
  try {
    const h = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}

function salvar() {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = HIST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(hist));
  fs.renameSync(tmp, HIST_FILE);
}

function votosDe(cands) {
  const o = {};
  for (const c of cands) if (c.votos) o[c.n] = c.votos;
  return o;
}

function montar(res) {
  const br = res.br;
  const regioes = REGIOES.map((R) => {
    let ts = 0, st = 0, vv = 0, faltam = 0;
    const votos = {};
    for (const uf of R.ufs) {
      const u = res[uf];
      if (!u) { faltam++; continue; }
      ts += u.ts; st += u.st; vv += u.vv;
      for (const c of u.cands) if (c.votos) votos[c.n] = (votos[c.n] || 0) + c.votos;
    }
    return { id: R.id, nome: R.nome, ts, st, pst: ts ? (st / ts) * 100 : 0, vv, votos, faltam };
  });
  return {
    t: horaTSE(br.dt, br.ht),
    dg: br.dg, hg: br.hg, dt: br.dt, ht: br.ht,
    definido: br.md === 'E' || br.md === 'S' ? br.md : '', finalizado: br.tf === 'S',
    ts: br.ts, st: br.st, pst: br.pst,
    eleitores: br.eleitores, comparecimento: br.comparecimento, abstencao: br.abstencao,
    vv: br.vv, brancos: br.brancos, nulos: br.nulos,
    cands: br.cands.slice().sort((a, b) => b.votos - a.votos),
    regioes,
  };
}

function ponto(a) {
  const r = {};
  for (const g of a.regioes) r[g.id] = [g.st, g.ts, g.vv, g.votos];
  return {
    t: a.t, ht: a.ht, st: a.st, ts: a.ts, pst: a.pst, vv: a.vv,
    c: a.comparecimento, ab: a.abstencao, b: a.brancos, nu: a.nulos,
    def: a.definido || 0, fim: a.finalizado ? 1 : 0, v: votosDe(a.cands), r,
  };
}

function assinatura(p) {
  return JSON.stringify([p.st, p.vv, p.def, p.fim, Object.values(p.r).map((x) => [x[0], x[2]])]);
}

async function ciclo() {
  const res = {}, falhas = [];
  await emLotes(ABRS, 6, async (abr) => {
    try { res[abr] = await baixar(abr); } catch (e) {
      falhas.push(abr);
      const c = cache.get(abr);
      if (c) res[abr] = c.dados;
    }
  });
  coleta.ultima = Date.now();
  coleta.falhas = falhas;
  if (!res.br) { coleta.erro = 'TSE indisponível no momento'; return; }
  coleta.erro = null;
  atual = montar(res);
  const p = ponto(atual);
  if (!hist.length) hist.push({ t: INICIO, ht: '17:00:00', st: 0, ts: p.ts, pst: 0, vv: 0, def: 0, fim: 0, v: {}, r: {}, inicio: 1 });
  const ult = hist[hist.length - 1];
  if (assinatura(ult) !== assinatura(p)) {
    if (p.t <= ult.t) p.t = ult.t + 1000; // UF atualizada depois do arquivo nacional
    hist.push(p);
    salvar();
  }
}

async function laco() {
  try { await ciclo(); } catch (e) { coleta.erro = String(e.message || e); console.error('coleta:', coleta.erro); }
  if (coleta.falhas.length) console.error('falhas:', coleta.falhas.join(','));
  setTimeout(laco, INTERVALO);
}

// ---------- HTTP ----------

function json(res, code, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(corpo);
}

const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (u.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok\n'); }
  if (u.pathname === '/api/estado') {
    const desde = Number(u.searchParams.get('desde')) || 0;
    if (!atual) return json(res, 503, { erro: coleta.erro || 'coletando os primeiros dados do TSE' });
    return json(res, 200, {
      fonte: 'https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/6257/uf/br/cargo/1/vis/nominal/resultados',
      inicio: INICIO,
      regioes: REGIOES.map((r) => ({ id: r.id, nome: r.nome })),
      atual,
      hist: hist.filter((p) => p.t > desde),
      coleta: { ultima: coleta.ultima, erro: coleta.erro, falhas: coleta.falhas.length },
    });
  }
  const est = ESTATICOS[u.pathname];
  if (!est) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('não encontrado\n'); }
  fs.readFile(path.join(PUBLIC, est[0]), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': est[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}).listen(PORT, HOST, () => console.log(`apuracao ouvindo em ${HOST}:${PORT}`));

laco();
