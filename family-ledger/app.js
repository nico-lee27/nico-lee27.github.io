/* 家庭账本 PWA
 * 数据层：localStorage 本地优先 + GitHub Contents API 云端共享（多人同一仓库即共享账本）
 * 原始数据源：腾讯文档智能表格「家庭账本 / 记账本」
 */
'use strict';

/* ========== 常量 ========== */
const CATS = [
  { n: '食品餐饮', e: '🍚' },
  { n: '交通出行', e: '🚗' },
  { n: '购物消费', e: '🛍️' },
  { n: '人情往来', e: '🎁' },
  { n: '住房支出', e: '🏠' },
  { n: '通信通话', e: '📱' },
  { n: '休闲娱乐', e: '🎮' },
  { n: '医疗保健', e: '💊' },
  { n: '其他', e: '📦' },
  { n: '服饰鞋袜', e: '👕' },
];
const CAT_EMOJI = Object.fromEntries(CATS.map(c => [c.n, c.e]));
const QUICK_AMTS = [5, 10, 20, 30, 50, 100, 200, 500];
const LS_DATA = 'fl.data.v1';
const LS_CFG = 'fl.cfg.v1';
const BUNDLED = 'data/records.json';

/* ========== 状态 ========== */
const S = {
  // owner/repo 为默认值，首次使用只需在设置页粘贴 GitHub Token
  cfg: { token: '', owner: 'nico-lee27', repo: 'family-ledger', branch: 'main', path: 'data/records.json' },
  records: [],
  sha: null,
  meta: null,
  view: 'ledger',
  month: '',          // 'YYYY-MM' | '' 表示全部
  allMonth: false,
  cat: '',
  q: '',
  range: 'month',     // month | last | all
  expanded: {},       // 全部模式下展开的月份
  syncing: false,
  dirty: false,
};

/* ========== 工具 ========== */
const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const monthOf = s => (s || '').slice(0, 7);
const ymLabel = m => { const [y, mo] = m.split('-'); return `${y}年${mo}月`; };
const money = n => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => '¥' + Math.round(n || 0).toLocaleString('zh-CN');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function daysInMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo, 0).getDate();
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 1900);
}

/* ========== 存储 ========== */
function saveLocal() {
  try {
    localStorage.setItem(LS_DATA, JSON.stringify({ records: S.records, sha: S.sha, meta: S.meta, at: Date.now() }));
  } catch (e) { toast('本地存储写入失败'); }
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_DATA);
    if (!raw) return false;
    const o = JSON.parse(raw);
    S.records = o.records || []; S.sha = o.sha || null; S.meta = o.meta || null;
    return S.records.length > 0;
  } catch (e) { return false; }
}
function saveCfg() {
  localStorage.setItem(LS_CFG, JSON.stringify(S.cfg));
}
function loadCfg() {
  try { Object.assign(S.cfg, JSON.parse(localStorage.getItem(LS_CFG) || '{}')); } catch (e) { }
}

/* 有效记录（排除墓碑） */
const alive = () => S.records.filter(r => !r._del);

/* ========== GitHub 同步 ========== */
function b64enc(str) {
  const b = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(s) {
  const bin = atob(s.replace(/\s/g, '')); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(b);
}
function apiUrl(extra) {
  const c = S.cfg;
  return `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path.replace(/^\//, '')}${extra || ''}`;
}
function ghHeaders() {
  return {
    Authorization: 'Bearer ' + S.cfg.token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}
function setSync(state, text) {
  $('syncDot').className = 'sync-dot ' + state;
  $('syncText').textContent = text;
}
function log(msg) { const el = $('syncLog'); if (el) el.textContent = (el.textContent ? el.textContent + '\n' : '') + msg; }

/** 合并两份记录：按 id 去重，墓碑(_del)优先，updatedAt 新的优先 */
function merge(a, b) {
  const map = new Map();
  const put = r => {
    const old = map.get(r.id);
    if (!old) { map.set(r.id, r); return; }
    if (r._del && !old._del) { map.set(r.id, r); return; }
    if (old._del && !r._del) return;
    const tu = r.updatedAt || '', ou = old.updatedAt || '';
    if (tu > ou) map.set(r.id, r);
  };
  (a || []).forEach(put); (b || []).forEach(put);
  return [...map.values()];
}

async function pull() {
  if (!S.cfg.token || !S.cfg.owner || !S.cfg.repo) throw new Error('未配置');
  setSync('loading', '拉取中');
  const res = await fetch(apiUrl('?ref=' + encodeURIComponent(S.cfg.branch)), { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error('拉取失败 ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const j = await res.json();
  const remote = JSON.parse(b64dec(j.content));
  S.records = merge(S.records, (remote.records || []).map(r => ({ ...r, source: r.source || 'app' })));
  S.sha = j.sha; S.meta = { source: remote.source, updatedAt: remote.updatedAt };
  saveLocal();
  const sy = window.scrollY;      // 自动同步时不打断当前浏览位置
  renderAll();
  window.scrollTo(0, sy);
  setSync('ok', '已同步 ' + new Date().toTimeString().slice(0, 5));
  return S.records.length;
}

async function push() {
  if (!S.cfg.token || !S.cfg.owner || !S.cfg.repo) throw new Error('未配置');
  if (!S.sha) { await pull(); }
  setSync('loading', '推送中');
  const payload = {
    version: 1,
    source: '腾讯文档智能表格 家庭账本 / 记账本 + App 记账',
    updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    records: S.records,
  };
  const body = { message: '账本更新 ' + payload.updatedAt, content: b64enc(JSON.stringify(payload, null, 1)), sha: S.sha, branch: S.cfg.branch };
  let res = await fetch(apiUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) {          // sha 冲突：重新拉取合并后重试
    await pull();
    body.sha = S.sha;
    body.content = b64enc(JSON.stringify({ ...payload, records: S.records }, null, 1));
    res = await fetch(apiUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  }
  if (!res.ok) throw new Error('推送失败 ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const j = await res.json();
  S.sha = j.content.sha; saveLocal();
  S.dirty = false;
  setSync('ok', '已同步 ' + new Date().toTimeString().slice(0, 5));
  return true;
}

async function syncNow() {
  if (!S.cfg.token || !S.cfg.owner || !S.cfg.repo) { setSync('', '未配置'); return; }
  if (S.syncing) return;
  S.syncing = true;
  try {
    await pull();
    if (S.dirty) await push();
  } catch (e) {
    setSync('err', '同步失败');
    log('× ' + e.message);
  } finally { S.syncing = false; }
}

/* ========== 渲染：筛选与列表 ========== */
function filtered() {
  let rs = alive();
  const q = S.q.trim().toLowerCase();
  if (q) {
    rs = rs.filter(r => (r.note + ' ' + r.merchant + ' ' + r.category).toLowerCase().includes(q));
  } else if (!S.allMonth && S.month) {
    rs = rs.filter(r => monthOf(r.date) === S.month);
  }
  if (S.cat) rs = rs.filter(r => r.category === S.cat);
  return rs.sort((a, b) => a.date === b.date ? (a.id < b.id ? 1 : -1) : (a.date < b.date ? 1 : -1));
}

function rowHTML(r) {
  return `<div class="row" data-id="${r.id}">
    <div class="row-inner">
      <div class="row-ico">${CAT_EMOJI[r.category] || '📦'}</div>
      <div class="row-main">
        <div class="row-t"><span class="row-cat">${esc(r.category)}</span><span class="row-mer">${esc(r.merchant)}</span></div>
        ${r.note ? `<div class="row-note">${esc(r.note)}</div>` : ''}
      </div>
      <div class="row-amt">${money(r.amount)}</div>
    </div>
    <div class="row-del">删除</div>
  </div>`;
}

function renderLedger() {
  const rs = filtered();
  const box = $('ledgerList');
  $('ledgerEmpty').classList.toggle('hidden', rs.length > 0);
  if (!rs.length) { box.innerHTML = ''; }

  let html = '';
  if (S.q.trim() || !S.allMonth) {
    // 按日分组
    const g = new Map();
    rs.forEach(r => { (g.get(r.date) || g.set(r.date, []).get(r.date)).push(r); });
    for (const [d, arr] of g) {
      const sum = arr.reduce((s, r) => s + r.amount, 0);
      html += `<div class="daygrp"><div class="daygrp-h"><span class="d-date">${d}</span><span class="d-sum">${money(sum)} · ${arr.length}笔</span></div>
        <div class="daygrp-b">${arr.map(rowHTML).join('')}</div></div>`;
    }
  } else {
    // 全部：按月折叠
    const g = new Map();
    rs.forEach(r => { const m = monthOf(r.date); (g.get(m) || g.set(m, []).get(m)).push(r); });
    for (const [m, arr] of [...g].sort((a, b) => a[0] < b[0] ? 1 : -1)) {
      const sum = arr.reduce((s, r) => s + r.amount, 0);
      const open = S.expanded[m] !== false && (S.expanded[m] === true || m === S.month || monthOf(todayStr()) === m);
      html += `<div class="daygrp"><div class="daygrp-h" data-month="${m}" style="cursor:pointer">
          <span class="d-date">${open ? '▾' : '▸'} ${ymLabel(m)}</span>
          <span class="d-sum">${money0(sum)} · ${arr.length}笔</span></div>
        ${open ? `<div class="daygrp-b">${arr.map(rowHTML).join('')}</div>` : ''}</div>`;
    }
  }
  box.innerHTML = html;

  // 当前筛选合计
  const total = rs.reduce((s, r) => s + r.amount, 0);
  $('mTotal').textContent = money0(total);
  $('mCount').textContent = rs.length + ' 笔';
}

function renderCatChips() {
  const used = new Set(alive().map(r => r.category));
  let h = `<button class="chip ${S.cat ? '' : 'on'}" data-cat="">全部</button>`;
  CATS.forEach(c => {
    if (!used.has(c.n) && c.n !== S.cat) return;
    h += `<button class="chip ${S.cat === c.n ? 'on' : ''}" data-cat="${c.n}">${c.e} ${c.n}</button>`;
  });
  $('catChips').innerHTML = h;
}

/* ========== 渲染：看板 ========== */
function rangeRecords() {
  const now = new Date();
  const cm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  const lm = shiftMonth(cm, -1);
  const rs = alive();
  if (S.range === 'month') return { rs: rs.filter(r => monthOf(r.date) === cm), label: ymLabel(cm), cur: cm, prev: lm };
  if (S.range === 'last') return { rs: rs.filter(r => monthOf(r.date) === lm), label: ymLabel(lm), cur: lm, prev: shiftMonth(lm, -1) };
  return { rs, label: '全部 · ' + rs.length + ' 笔', cur: null, prev: null };
}

function renderBoard() {
  const { rs, label, cur, prev } = rangeRecords();
  $('rangeLabel').textContent = label;

  const total = rs.reduce((s, r) => s + r.amount, 0);
  const max = rs.reduce((m, r) => Math.max(m, r.amount), 0);
  let days = 0;
  if (cur) {
    const isCurMonth = cur === monthOf(todayStr());
    days = isCurMonth ? new Date().getDate() : daysInMonth(cur);
  } else {
    const ds = new Set(rs.map(r => r.date)); days = ds.size || 1;
  }
  $('kTotal').textContent = money0(total);
  $('kCount').textContent = rs.length;
  $('kAvg').textContent = money0(total / (days || 1));
  $('kMax').textContent = money0(max);

  // 环比
  if (prev) {
    const p = alive().filter(r => monthOf(r.date) === prev);
    const pt = p.reduce((s, r) => s + r.amount, 0);
    if (pt > 0) {
      const d = total - pt, pct = Math.abs(d / pt * 100);
      $('momHint').textContent = '对比 ' + ymLabel(prev) + ' ' + money0(pt);
      $('momBox').innerHTML = `<span class="mom-num ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '↑' : '↓'}${money0(Math.abs(d))}</span>
        <span class="mom-txt">较上月${d >= 0 ? '增加' : '减少'} <b>${pct.toFixed(1)}%</b><br>${money0(pt)} → ${money0(total)}</span>`;
    } else {
      $('momHint').textContent = '对比 ' + ymLabel(prev);
      $('momBox').innerHTML = `<span class="mom-txt">上月无记录，无法比较</span>`;
    }
  } else {
    $('momHint').textContent = '全部区间';
    $('momBox').innerHTML = `<span class="mom-txt">共 <b>${rs.length}</b> 笔，覆盖 <b>${new Set(rs.map(r => monthOf(r.date))).size}</b> 个月</span>`;
  }

  // 分类占比
  const byCat = new Map();
  rs.forEach(r => byCat.set(r.category, (byCat.get(r.category) || 0) + r.amount));
  const sorted = [...byCat].sort((a, b) => b[1] - a[1]);
  $('catBars').innerHTML = sorted.length ? sorted.map(([c, v]) => `
    <div class="cb"><div class="cb-t"><span class="cb-name">${CAT_EMOJI[c] || '📦'} ${esc(c)}</span>
      <span class="cb-val">${money0(v)} · ${(v / total * 100).toFixed(1)}%</span></div>
      <div class="cb-track"><div class="cb-fill" style="width:${(v / total * 100).toFixed(2)}%"></div></div></div>`).join('')
    : '<div class="note" style="margin:0">暂无数据</div>';

  // Top5
  $('topList').innerHTML = rs.length ? [...rs].sort((a, b) => b.amount - a.amount).slice(0, 5).map((r, i) => `
    <div class="top-row"><span class="top-i">${i + 1}</span>
      <span class="top-m">${CAT_EMOJI[r.category] || '📦'} ${esc(r.merchant || r.category)}${r.note ? ' · ' + esc(r.note) : ''}</span>
      <span class="top-a">${money0(r.amount)}</span></div>`).join('')
    : '<div class="note" style="margin:0">暂无数据</div>';

  buildMonthly();
  drawChart();
}

/* ---- 折线图（支持捏合缩放 / 拖动平移） ---- */
let chart = { months: [], vals: [], i0: 0, i1: 0, n: 0 };

function buildMonthly() {
  const byM = new Map();
  alive().forEach(r => byM.set(monthOf(r.date), (byM.get(monthOf(r.date)) || 0) + r.amount));
  const months = [...byM.keys()].sort();
  chart.months = months;
  chart.vals = months.map(m => byM.get(m));
  chart.n = months.length;
  if (chart.i1 === 0 || chart.i1 >= chart.n) { chart.i0 = 0; chart.i1 = Math.max(0, chart.n - 1); }
}

function fmtY(v) {
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '万';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

function drawChart() {
  const cv = $('lineChart'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (chart.n === 0) return;

  const P = { l: 42, r: 10, t: 12, b: 24 };
  const pw = w - P.l - P.r, ph = h - P.t - P.b;
  const i0 = Math.max(0, Math.floor(chart.i0)), i1 = Math.min(chart.n - 1, Math.ceil(chart.i1));
  const idxs = []; for (let i = i0; i <= i1; i++) idxs.push(i);
  const vals = idxs.map(i => chart.vals[i]);
  const maxV = Math.max(...vals, 1);
  const nice = Math.pow(10, Math.floor(Math.log10(maxV)));
  const top = Math.ceil(maxV / (nice / 2)) * (nice / 2) || 1;

  const X = i => P.l + (idxs.length === 1 ? pw / 2 : (idxs.indexOf(i) / (idxs.length - 1)) * pw);
  const Y = v => P.t + ph - (v / top) * ph;

  // 网格 + Y 轴
  g.strokeStyle = '#ecebe6'; g.lineWidth = 1; g.font = '10px -apple-system,sans-serif'; g.fillStyle = '#a29e96';
  for (let k = 0; k <= 4; k++) {
    const v = top * k / 4, y = Y(v);
    g.beginPath(); g.moveTo(P.l, y); g.lineTo(w - P.r, y); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(fmtY(v), P.l - 6, y);
  }

  // 面积
  g.beginPath(); g.moveTo(X(idxs[0]), Y(0));
  idxs.forEach(i => g.lineTo(X(i), Y(chart.vals[i])));
  g.lineTo(X(idxs[idxs.length - 1]), Y(0)); g.closePath();
  const grad = g.createLinearGradient(0, P.t, 0, P.t + ph);
  grad.addColorStop(0, 'rgba(200,102,63,.22)'); grad.addColorStop(1, 'rgba(200,102,63,0)');
  g.fillStyle = grad; g.fill();

  // 折线
  g.beginPath();
  idxs.forEach((i, k) => k ? g.lineTo(X(i), Y(chart.vals[i])) : g.moveTo(X(i), Y(chart.vals[i])));
  g.strokeStyle = '#c8663f'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();

  // 点 + X 轴标签
  const step = Math.max(1, Math.ceil(idxs.length / Math.max(2, Math.floor(pw / 52))));
  g.textAlign = 'center'; g.textBaseline = 'top';
  idxs.forEach((i, k) => {
    if (k % step === 0 || k === idxs.length - 1) {
      g.fillStyle = '#a29e96'; g.font = '10px -apple-system,sans-serif';
      g.fillText(chart.months[i].slice(2).replace('-', '/'), X(i), P.t + ph + 6);
    }
    if (idxs.length <= 30) {
      g.beginPath(); g.arc(X(i), Y(chart.vals[i]), 3, 0, 7);
      g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#c8663f'; g.lineWidth = 2; g.stroke();
    }
  });

  // 当前区间峰值标注
  const mi = idxs.reduce((a, b) => chart.vals[a] >= chart.vals[b] ? a : b);
  g.fillStyle = '#1c1b19'; g.font = '600 11px -apple-system,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
  g.fillText(money0(chart.vals[mi]), X(mi), Y(chart.vals[mi]) - 8);

  $('chartRange').textContent = `${chart.months[i0]} ~ ${chart.months[i1]} · ${idxs.length} 个月 · 合计 ${money0(vals.reduce((a, b) => a + b, 0))}`;
}

function initChartGesture() {
  const cv = $('lineChart');
  let start = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const clampWin = () => {
    let size = chart.i1 - chart.i0 + 1;
    if (size > chart.n) size = chart.n;
    if (size < 2) size = Math.min(2, chart.n);
    if (chart.i0 < 0) { chart.i0 = 0; chart.i1 = size - 1; }
    if (chart.i1 > chart.n - 1) { chart.i1 = chart.n - 1; chart.i0 = Math.max(0, chart.n - size); }
  };

  cv.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      start = { mode: 'pinch', d: dist(e.touches), i0: chart.i0, i1: chart.i1 };
    } else if (e.touches.length === 1) {
      start = { mode: 'pan', x: e.touches[0].clientX, i0: chart.i0, i1: chart.i1 };
    }
  }, { passive: true });

  cv.addEventListener('touchmove', e => {
    if (!start) return;
    e.preventDefault();
    if (start.mode === 'pinch' && e.touches.length === 2) {
      const f = start.d / Math.max(dist(e.touches), 1);
      const size = Math.min(chart.n, Math.max(2, (start.i1 - start.i0 + 1) * f));
      const c = (start.i0 + start.i1) / 2;
      chart.i0 = c - size / 2; chart.i1 = c + size / 2 - 1;
    } else if (start.mode === 'pan' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - start.x;
      const perPx = (start.i1 - start.i0 + 1) / Math.max(cv.clientWidth - 52, 1);
      const sh = -dx * perPx;
      chart.i0 = start.i0 + sh; chart.i1 = start.i1 + sh;
    }
    clampWin(); drawChart();
  }, { passive: false });

  cv.addEventListener('touchend', () => { start = null; }, { passive: true });
  cv.addEventListener('dblclick', resetZoom);

  // 桌面端鼠标拖动（便于调试）
  let md = false, mx = 0;
  cv.addEventListener('mousedown', e => { md = true; mx = e.clientX; start = { mode: 'pan', x: mx, i0: chart.i0, i1: chart.i1 }; });
  window.addEventListener('mousemove', e => {
    if (!md || !start) return;
    const dx = e.clientX - start.x;
    const perPx = (start.i1 - start.i0 + 1) / Math.max(cv.clientWidth - 52, 1);
    chart.i0 = start.i0 - dx * perPx; chart.i1 = start.i1 - dx * perPx;
    clampWin(); drawChart();
  });
  window.addEventListener('mouseup', () => { md = false; start = null; });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const size = Math.min(chart.n, Math.max(2, (chart.i1 - chart.i0 + 1) * f));
    const c = (chart.i0 + chart.i1) / 2;
    chart.i0 = c - size / 2; chart.i1 = c + size / 2 - 1;
    clampWin(); drawChart();
  }, { passive: false });
}
function resetZoom() { chart.i0 = 0; chart.i1 = Math.max(0, chart.n - 1); drawChart(); }

/* ========== 记账面板 ========== */
let draft = { cat: '', date: todayStr() };

function renderCatGrid() {
  $('catGrid').innerHTML = CATS.map(c =>
    `<button class="cg ${draft.cat === c.n ? 'on' : ''}" data-cat="${c.n}"><span class="e">${c.e}</span><span class="n">${c.n}</span></button>`).join('');
}
function renderQuickAmts() {
  $('quickAmts').innerHTML = QUICK_AMTS.map(v => `<button class="qa" data-a="${v}">${v}</button>`).join('');
}
function renderHistoryChips() {
  const freq = (field) => {
    const m = new Map();
    alive().forEach(r => { const v = (r[field] || '').trim(); if (v) m.set(v, (m.get(v) || 0) + 1); });
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  };
  const mc = freq('merchant'), nc = freq('note');
  $('merchantChips').innerHTML = mc.map(v => `<button class="chip" data-fill="fMerchant" data-v="${esc(v)}">${esc(v)}</button>`).join('');
  $('noteChips').innerHTML = nc.map(v => `<button class="chip" data-fill="fNote" data-v="${esc(v)}">${esc(v)}</button>`).join('');
  // 同类目下最常用的商家排在前面
  if (draft.cat) {
    const m = new Map();
    alive().filter(r => r.category === draft.cat).forEach(r => { const v = (r.merchant || '').trim(); if (v) m.set(v, (m.get(v) || 0) + 1); });
    const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
    if (top.length) {
      $('merchantChips').innerHTML = top.map(v => `<button class="chip" data-fill="fMerchant" data-v="${esc(v)}">${esc(v)}</button>`).join('')
        + mc.filter(v => !top.includes(v)).map(v => `<button class="chip" data-fill="fMerchant" data-v="${esc(v)}">${esc(v)}</button>`).join('');
    }
  }
}
function openSheet() {
  draft = { cat: draft.cat || '食品餐饮', date: todayStr() };
  $('fAmount').value = ''; $('fMerchant').value = ''; $('fNote').value = ''; $('fDate').value = draft.date;
  renderCatGrid(); renderQuickAmts(); renderHistoryChips();
  $('sheetMask').classList.remove('hidden'); $('sheet').classList.remove('hidden');
  setTimeout(() => $('fAmount').focus(), 260);
}
function closeSheet() { $('sheetMask').classList.add('hidden'); $('sheet').classList.add('hidden'); }

async function saveRecord() {
  const amount = parseFloat(($('fAmount').value || '').replace(/[^\d.]/g, ''));
  if (!amount || amount <= 0) { toast('请输入金额'); $('fAmount').focus(); return; }
  if (!draft.cat) { toast('请选择类别'); return; }
  const rec = {
    id: uid(),
    date: $('fDate').value || todayStr(),
    category: draft.cat,
    amount: Math.round(amount * 100) / 100,
    note: $('fNote').value.trim(),
    merchant: $('fMerchant').value.trim(),
    source: 'app',
    updatedAt: new Date().toISOString(),
  };
  S.records.push(rec);
  saveLocal(); S.dirty = true;
  if (!S.allMonth) S.month = monthOf(rec.date);
  closeSheet(); renderAll();
  toast('已记 ' + money(rec.amount));
  setSync('pending', '待同步');
  push().then(() => toast('已同步到云端')).catch(e => { setSync('err', '同步失败'); log('× ' + e.message); });
}

async function removeRecord(id) {
  const r = S.records.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`删除这笔 ${money(r.amount)} 的记录？`)) return;
  r._del = true; r.updatedAt = new Date().toISOString();
  saveLocal(); S.dirty = true; renderAll();
  toast('已删除');
  push().catch(e => { setSync('err', '同步失败'); });
}

/* ========== Excel 导出 ========== */
function toRows(rs) {
  return [...rs].sort((a, b) => a.date < b.date ? -1 : 1).map(r => ({
    '日期': r.date,
    '年月': ymLabel(monthOf(r.date)),
    '支出类别': r.category,
    '金额': r.amount,
    '说明': r.note || '',
    '商家/地点': r.merchant || '',
  }));
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => fallback());
  } else fallback();
  function fallback() {
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出 ' + name);
  }
}
function exportXlsx(rs, name) {
  if (typeof XLSX === 'undefined') { toast('导出组件未加载'); return; }
  const ws = XLSX.utils.json_to_sheet(toRows(rs));
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 34 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '记账本');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
}

/* ========== 交互绑定 ========== */
function switchView(v) {
  S.view = v;
  ['ledger', 'board', 'settings'].forEach(k => $('view-' + k).classList.toggle('hidden', k !== v));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === v));
  $('tbTitle').textContent = { ledger: '账本', board: '看板', settings: '设置' }[v];
  if (v === 'board') { buildMonthly(); drawChart(); }
  if (v === 'settings') renderMeta();
}
function renderMeta() {
  const n = alive().length;
  const ds = alive().map(r => r.date).sort();
  $('metaInfo').innerHTML = S.meta && S.meta.source
    ? `${esc(S.meta.source)}<br>云端更新：${esc(S.meta.updatedAt || '—')}<br>本地记录：<b>${n}</b> 条${ds.length ? '，' + ds[0] + ' ~ ' + ds[ds.length - 1] : ''}`
    : `本地内置数据 <b>${n}</b> 条${ds.length ? '，' + ds[0] + ' ~ ' + ds[ds.length - 1] : ''}。填入 Token 后可与云端同步。`;
}
function renderAll() {
  if (!S.month) S.month = monthOf(todayStr());
  $('mLabel').textContent = S.allMonth ? '全部' : S.month;
  $('mPrev').style.visibility = S.allMonth ? 'hidden' : 'visible';
  $('mNext').style.visibility = S.allMonth ? 'hidden' : 'visible';
  renderCatChips(); renderLedger();
  if (S.view === 'board') renderBoard();
}

function bind() {
  // Tab
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
  $('btnAdd').onclick = openSheet;
  $('sheetCancel').onclick = closeSheet;
  $('sheetMask').onclick = closeSheet;
  $('sheetSave').onclick = saveRecord;

  // 月份
  $('mPrev').onclick = () => { S.month = shiftMonth(S.month, -1); S.allMonth = false; renderAll(); };
  $('mNext').onclick = () => { S.month = shiftMonth(S.month, 1); S.allMonth = false; renderAll(); };
  $('mLabel').onclick = () => { S.allMonth = !S.allMonth; renderAll(); };

  // 搜索
  $('qInput').oninput = e => { S.q = e.target.value; $('qClear').classList.toggle('hidden', !S.q); renderLedger(); };
  $('qClear').onclick = () => { S.q = ''; $('qInput').value = ''; $('qClear').classList.add('hidden'); renderLedger(); };

  // 类别 chips
  $('catChips').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    S.cat = b.dataset.cat; renderAll();
  };

  // 列表：删除滑动 + 月份折叠
  const list = $('ledgerList');
  let sx = 0, sy = 0, curRow = null, moved = false;
  list.addEventListener('touchstart', e => {
    const inner = e.target.closest('.row-inner');
    const head = e.target.closest('.daygrp-h');
    if (head && head.dataset.month) return;
    curRow = inner; moved = false;
    if (inner) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, { passive: true });
  list.addEventListener('touchmove', e => {
    if (!curRow) return;
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if (Math.abs(dy) > Math.abs(dx)) { curRow = null; return; }
    if (dx < -6) { moved = true; curRow.style.transform = `translateX(${Math.max(dx, -100)}px)`; }
  }, { passive: true });
  list.addEventListener('touchend', e => {
    if (!curRow) return;
    const inner = curRow;
    if (moved) {
      const dx = e.changedTouches[0].clientX - sx;
      if (dx < -40) { inner.classList.add('swiped'); }
      else { inner.classList.remove('swiped'); inner.style.transform = ''; }
    }
    curRow = null;
  });
  list.addEventListener('click', e => {
    const del = e.target.closest('.row-del');
    if (del) { removeRecord(del.closest('.row').dataset.id); return; }
    const inner = e.target.closest('.row-inner');
    if (inner && inner.classList.contains('swiped')) { inner.classList.remove('swiped'); inner.style.transform = ''; return; }
    const head = e.target.closest('.daygrp-h');
    if (head && head.dataset.month) {
      const m = head.dataset.month;
      S.expanded[m] = !(S.expanded[m] !== false && (S.expanded[m] === true || m === S.month || monthOf(todayStr()) === m));
      renderLedger();
    }
  });

  // 看板
  $('rangeSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.range = b.dataset.range;
    [...$('rangeSeg').children].forEach(x => x.classList.toggle('on', x === b));
    renderBoard();
  };
  $('zoomReset').onclick = resetZoom;
  initChartGesture();
  window.addEventListener('resize', () => { if (S.view === 'board') drawChart(); });

  // 顶部同步状态：点一下立即同步
  const tbRight = document.querySelector('.tb-right');
  if (tbRight) tbRight.addEventListener('click', () => {
    if (!S.cfg.token) { switchView('settings'); return; }
    toast('同步中…'); maybeSync(0);
  });

  // 账本页下拉刷新（仅在页面顶部、非弹层内、垂直下滑时触发）
  let pullY = null;
  const sheetOpen = () => !$('sheet').classList.contains('hidden');
  document.addEventListener('touchstart', e => {
    if (S.view !== 'ledger' || window.scrollY > 0 || sheetOpen()) { pullY = null; return; }
    pullY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (pullY === null) return;
    if (e.touches[0].clientY - pullY > 70) {
      pullY = null;
      if (S.cfg.token) { toast('同步中…'); maybeSync(0); }
    }
  }, { passive: true });
  document.addEventListener('touchend', () => { pullY = null; }, { passive: true });

  // 记账面板
  $('catGrid').onclick = e => {
    const b = e.target.closest('.cg'); if (!b) return;
    draft.cat = b.dataset.cat; renderCatGrid(); renderHistoryChips();
  };
  $('quickAmts').onclick = e => {
    const b = e.target.closest('.qa'); if (!b) return;
    $('fAmount').value = b.dataset.a;
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-fill]'); if (!b) return;
    $(b.dataset.fill).value = b.dataset.v;
  });
  $('fDate').onchange = e => { draft.date = e.target.value; };
  document.querySelectorAll('.date-quick button').forEach(b => b.onclick = () => {
    const d = new Date(); d.setDate(d.getDate() + parseInt(b.dataset.d, 10));
    const v = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    $('fDate').value = v; draft.date = v;
    document.querySelectorAll('.date-quick button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  });

  // 设置
  $('btnSaveCfg').onclick = () => {
    S.cfg.token = $('cfgToken').value.trim();
    S.cfg.owner = $('cfgOwner').value.trim();
    S.cfg.repo = $('cfgRepo').value.trim();
    S.cfg.branch = $('cfgBranch').value.trim() || 'main';
    saveCfg(); toast('配置已保存'); $('syncLog').textContent = '';
    syncNow().then(() => log('✓ 同步成功，共 ' + alive().length + ' 条')).catch(e => log('× ' + e.message));
  };
  $('btnPull').onclick = async () => {
    try { const n = await pull(); log('✓ 拉取成功，共 ' + n + ' 条'); toast('已拉取'); }
    catch (e) { log('× ' + e.message); toast('拉取失败'); }
  };
  $('btnPush').onclick = async () => {
    try { await push(); log('✓ 推送成功'); toast('已推送'); }
    catch (e) { log('× ' + e.message); toast('推送失败'); }
  };
  $('btnExportAll').onclick = () => exportXlsx(alive(), `家庭账本_全部_${todayStr()}.xlsx`);
  $('btnExportMonth').onclick = () => {
    const m = S.allMonth ? monthOf(todayStr()) : S.month;
    const rs = alive().filter(r => monthOf(r.date) === m);
    if (!rs.length) { toast('该月无记录'); return; }
    exportXlsx(rs, `家庭账本_${m}_${todayStr()}.xlsx`);
  };
  $('btnReloadBundled').onclick = async () => {
    if (!confirm('用内置数据覆盖本地缓存？未同步的改动会丢失。')) return;
    localStorage.removeItem(LS_DATA); await boot(); toast('已恢复内置数据');
  };
  $('btnClearLocal').onclick = () => {
    if (!confirm('清空本地缓存？下次打开会重新从云端拉取。')) return;
    localStorage.removeItem(LS_DATA); S.records = []; S.sha = null; renderAll(); toast('已清空');
  };
}

/* 从分享链接自动导入配置：#t=<token>[&owner=&repo=&branch=]
   保留 hash 不清空 —— 添加到主屏幕后每次启动都能自愈配置 */
function applyUrlConfig() {
  try {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const get = k => q.get(k) || h.get(k);
    const t = get('t') || get('token');
    if (!t) return false;
    S.cfg.token = t.trim();
    if (get('owner')) S.cfg.owner = get('owner').trim();
    if (get('repo')) S.cfg.repo = get('repo').trim();
    if (get('branch')) S.cfg.branch = get('branch').trim();
    saveCfg();
    return true;
  } catch (e) { return false; }
}

/* ========== 自动同步 ==========
   纯前端没有服务端推送，靠三条腿保证「别人记的账能尽快看到」：
   1) 从后台切回前台 / 窗口获焦 → 立即拉
   2) 停留在前台时 → 每 25 秒轮询一次（iOS 把 App 切到后台会冻结定时器，所以只在可见时跑）
   3) 账本页顶部下拉 → 手动立即拉 */
let lastSyncAt = 0;
function maybeSync(minGap) {
  const now = Date.now();
  if (now - lastSyncAt < minGap) return;
  if (!S.cfg.token || !S.cfg.owner || !S.cfg.repo) return;
  lastSyncAt = now;
  syncNow();
}
function startAutoSync() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeSync(2000);
  });
  window.addEventListener('focus', () => maybeSync(2000));
  window.addEventListener('online', () => maybeSync(0));
  setInterval(() => {
    if (document.visibilityState === 'visible') maybeSync(25000);
  }, 10000);
}

/* ========== 启动 ========== */
async function boot() {
  loadCfg();
  const autoCfg = applyUrlConfig();
  ['cfgToken', 'cfgOwner', 'cfgRepo', 'cfgBranch'].forEach(id => { $(id).value = S.cfg[id.slice(3).toLowerCase()] || ''; });
  $('cfgBranch').value = S.cfg.branch || 'main';

  if (!loadLocal()) {
    try {
      const res = await fetch(BUNDLED, { cache: 'no-store' });
      if (!res.ok) throw new Error('no bundled data');
      const j = await res.json();
      S.records = (j.records || []).map(r => ({ ...r, source: r.source || 'docs' }));
      S.meta = { source: j.source, updatedAt: j.updatedAt };
      saveLocal();
    } catch (e) { /* 云端版无内置数据属正常，靠同步拉取 */ }
  }
  renderAll();
  if (S.cfg.token && S.cfg.owner && S.cfg.repo) {
    if (autoCfg) toast('配置已自动导入，正在同步…');
    syncNow();
  } else {
    setSync('', '未配置');
    switchView('settings');
    toast('首次使用：请粘贴配置链接，或在下方填 Token');
  }
}

bind();
boot();
startAutoSync();
