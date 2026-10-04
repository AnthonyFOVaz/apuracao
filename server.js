'use strict';
// Apuração Luta: coleta os resultados de presidente de 2026 (1º e 2º turno) direto do TSE,
// guarda o histórico por Brasil, região e UF em data/ e serve a página + /api/estado.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = process.env.TSE_BASE || 'https://resultados.tse.jus.br/oficial/ele2026';
const INTERVALO = Number(process.env.INTERVALO_MS || 20000);
const INTERVALO_LENTO = 5 * 60 * 1000; // 2º turno ainda sem arquivos, ou totalização encerrada
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
  const headers = { 'User-Agent': 'apuracao-luta/2.0 (+https://apuracao-204-216-184-199.sslip.io)' };
  if (c && c.etag) headers['If-None-Match'] = c.etag;
  const r = await fetch(url(T, abr), { headers, signal: AbortSignal.timeout(15000) });
  if (r.status === 304 && c) return c.dados;
  if (!r.ok) { const e = new Error(`${abr}: HTTP ${r.status}`); e.status = r.status; throw e; }
  const dados = ler(await r.json());
  // um nó do CDN pode devolver uma versão anterior à que já temos
  if (c && horaTSE(dados.dt, dados.ht) < horaTSE(c.dados.dt, c.dados.ht)) return c.dados;
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
  fs.writeFileSync(tmp, JSON.stringify(T.hist));
  fs.renameSync(tmp, T.arquivo);
}

function ponto(T, res) {
  const br = res.br, d = { br: entrada(br) };
  for (const uf of UFS) if (res[uf]) d[uf] = entrada(res[uf]);
  for (const R of REGIOES) {
    const partes = R.ufs.map((uf) => d[uf]).filter(Boolean);
    if (partes.length === R.ufs.length) d[R.id] = somar(partes);
  }
  return {
    t: horaTSE(br.dt, br.ht) || Date.now(), ht: br.ht,
    def: br.md === 'E' || br.md === 'S' ? br.md : 0, fim: br.tf === 'S' ? 1 : 0, d,
  };
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
  const br = res.br;
  T.atual = {
    t: horaTSE(br.dt, br.ht), dg: br.dg, hg: br.hg, dt: br.dt, ht: br.ht,
    definido: br.md === 'E' || br.md === 'S' ? br.md : '', finalizado: br.tf === 'S',
    ts: br.ts, st: br.st, pst: br.pst, vv: br.vv,
    cands: br.cands.slice().sort((a, b) => b.votos - a.votos),
  };
  const p = ponto(T, res);
  const ult = T.hist[T.hist.length - 1];
  if (!ult) T.hist.push({ t: T.inicio, ht: '17:00:00', def: 0, fim: 0, inicio: 1, d: {} });
  const u = T.hist[T.hist.length - 1];
  const ub = u.d.br;
  if (u.inicio || !ub || ub[0] !== p.d.br[0] || ub[2] !== p.d.br[2]) {
    if (p.t <= u.t) p.t = u.t + 1000;
    T.hist.push(p);
    salvar(T);
  } else if (JSON.stringify([u.def, u.fim, u.d]) !== JSON.stringify([p.def, p.fim, p.d])) {
    // só as UFs mudaram (cada arquivo sai num horário): atualiza o ponto atual no lugar
    u.def = p.def; u.fim = p.fim; u.d = p.d;
    salvar(T);
  }
}

async function laco(T) {
  try { await ciclo(T); } catch (e) { T.coleta.erro = String(e.message || e); console.error(`turno ${T.turno}:`, T.coleta.erro); }
  if (T.coleta.falhas) console.error(`turno ${T.turno}: ${T.coleta.falhas} arquivo(s) falharam`);
  const lento = !T.ativo || (T.atual && T.atual.finalizado);
  setTimeout(() => laco(T), lento ? INTERVALO_LENTO : INTERVALO);
}

// ---------- HTTP ----------

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

const disponivel = (T) => !!(T.ativo && T.atual && Date.now() >= T.inicio);

// formato da primeira versão da página (sem ?v=2), mantido enquanto houver aba antiga aberta
const LEGADO = [['SE', 'r:SE', 'Sudeste'], ['S', 'r:S', 'Sul'], ['CO', 'r:CO', 'Centro-Oeste'], ['NE', 'r:NE', 'Nordeste'], ['N', 'r:N', 'Norte'], ['ZZ', 'zz', 'Exterior']];
function legado(p) {
  const b = p.d.br || [0, 0, 0, 0, 0, 0, 0, {}], r = {};
  for (const [id, k] of LEGADO) { const x = p.d[k]; if (x) r[id] = [x[0], x[1], x[2], x[7]]; }
  return { t: p.t, ht: p.ht, st: b[0], ts: b[1], pst: b[1] ? (b[0] / b[1]) * 100 : 0, vv: b[2], c: b[3], ab: b[4], b: b[5], nu: b[6], def: p.def, fim: p.fim, v: b[7], r, ...(p.inicio ? { inicio: 1 } : {}) };
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
    const T = estados.find((x) => String(x.turno) === (u.searchParams.get('turno') || '1')) || estados[0];
    const desde = Number(u.searchParams.get('desde')) || 0;
    if (u.searchParams.get('v') !== '2') {
      if (!T.atual) return json(res, 503, { erro: T.coleta.erro || 'coletando os primeiros dados do TSE' });
      return json(res, 200, {
        inicio: T.inicio, regioes: LEGADO.map(([id, , nome]) => ({ id, nome })), atual: T.atual,
        hist: T.hist.filter((p, i) => p.t > desde || i === T.hist.length - 1).map(legado),
      });
    }
    const base = {
      turno: T.turno, eleicao: T.eleicao, inicio: T.inicio,
      turnos: estados.map((x) => ({ turno: x.turno, disponivel: disponivel(x), inicio: x.inicio })),
      regioes: REGIOES.map((r) => ({ id: r.id, nome: r.nome, ufs: r.ufs })),
      fonte: `https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/${T.eleicao}/uf/br/cargo/1/vis/nominal/resultados`,
    };
    if (!disponivel(T)) {
      if (T.turno === 1 && !T.atual) return json(res, 503, { ...base, erro: T.coleta.erro || 'coletando os primeiros dados do TSE' });
      return json(res, 200, { ...base, atual: null, hist: [] });
    }
    return json(res, 200, {
      ...base,
      atual: T.atual,
      // o último ponto vai sempre: ele pode ter sido atualizado no lugar (UFs)
      hist: T.hist.filter((p, i) => p.t > desde || i === T.hist.length - 1),
      coleta: { ultima: T.coleta.ultima, erro: T.coleta.erro, falhas: T.coleta.falhas },
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

for (const T of estados) { carregar(T); laco(T); }
