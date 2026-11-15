'use strict';
/* Reload Log — reloading + range data, all stored on this device (IndexedDB). */

const APP_VERSION = '1.11.0';
const GR_TO_G = 0.06479891;
const MOA_MM_PER_100M = 29.0888;
const COLS = ['rifles', 'bullets', 'powders', 'primers', 'brass', 'loads', 'batches', 'sessions'];
const SIZING = [['neck', 'Neck size'], ['fl', 'Full-length resize'], ['bump', 'FL + shoulder bump'], ['none', 'No sizing (new brass)']];
const STATUS = [['dev', 'In development'], ['proven', 'Proven / accurate'], ['rejected', 'Rejected']];
const PRIMER_SIZES = ['Small Rifle', 'Small Rifle Magnum', 'Large Rifle', 'Large Rifle Magnum', 'Small Pistol', 'Large Pistol', 'Other'].map(x => [x, x]);

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const fx = (v, d = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(d);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const byDate = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.created || 0) - (b.created || 0);
const get = (col, id) => S[col].find(x => x.id === id);
/* Natural order: alphabetical, numbers small → large (e.g. 140gr before 168gr). */
const nat = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
/* Calibre size in mm, so .223 < 6.5 CM < 7mm < .308 < 9.3x62 */
function calKey(c) {
  const t = String(c || '').trim(); if (!t) return 999;
  let m = t.match(/^\.(\d+)/); if (m) return parseFloat('0.' + m[1]) * 25.4;
  m = t.match(/(\d+(?:[.,]\d+)?)/); if (!m) return 998;
  const v = parseFloat(m[1].replace(',', '.'));
  if (/[.,]/.test(m[1]) || v < 17) return v;
  return v < 100 ? v / 100 * 25.4 : v < 1000 ? v / 1000 * 25.4 : v;
}
const by = (...fns) => (a, b) => { for (const f of fns) { const r = f(a, b); if (r) return r; } return 0; };
const num0 = v => (v == null || v === '' || isNaN(+v)) ? Infinity : +v;
const PRIMER_ORDER = ['Small Pistol', 'Small Rifle', 'Small Rifle Magnum', 'Large Pistol', 'Large Rifle', 'Large Rifle Magnum', 'Other'];
const SORTS = {
  rifles: by((a, b) => calKey(a.calibre) - calKey(b.calibre), (a, b) => nat(a.calibre, b.calibre), (a, b) => nat(a.name, b.name)),
  bullets: by((a, b) => calKey(a.diameter) - calKey(b.diameter), (a, b) => num0(a.weight) - num0(b.weight), (a, b) => nat(a.maker, b.maker), (a, b) => nat(a.name, b.name), (a, b) => nat(a.lot, b.lot)),
  powders: by((a, b) => nat(a.maker, b.maker), (a, b) => nat(a.name, b.name), (a, b) => nat(a.lot, b.lot)),
  primers: by((a, b) => (PRIMER_ORDER.indexOf(a.size) + 1 || 99) - (PRIMER_ORDER.indexOf(b.size) + 1 || 99), (a, b) => nat(a.maker, b.maker), (a, b) => nat(a.name, b.name), (a, b) => nat(a.lot, b.lot)),
  brass: by((a, b) => calKey(a.calibre) - calKey(b.calibre), (a, b) => num0(a.userLot) - num0(b.userLot), (a, b) => nat(a.name, b.name)),
  loads: by((a, b) => nat(nLoad(a), nLoad(b)), (a, b) => num0(a.charge) - num0(b.charge)),
  batches: byDate, sessions: byDate
};
function sortAll() { Object.entries(SORTS).forEach(([c, f]) => { if (Array.isArray(S[c])) S[c].sort(f); }); }
/* One option per product (recipes are per product; the lot is taken from the open lot when you load a batch). */
function prodOpts(kind, current) {
  const seen = new Set(), out = [];
  S[KIND_COL[kind]].forEach(x => {
    const k = pkey(kind, x); if (seen.has(k)) return;
    const grp = sameProduct(kind, x); if (grp.every(isFinished) && !grp.some(g => g.id === current)) return;
    seen.add(k);
    const r = grp.find(g => g.id === current) || activeLot(kind, x.id) || x;
    out.push([r.id, kind === 'powder' ? `${r.maker || ''} ${r.name || ''}`.trim() : kind === 'bullet' ? nBullet(r) : nPrimer(r)]);
  });
  return out;
}
const opts = (col, namer, filter) => S[col].filter(filter || (() => true)).map(x => [x.id, namer(x)]);

/* ---------- storage ---------- */
let S, _db;
function blank() {
  return {
    v: 1,
    settings: { lenUnit: 'mm', distance: 100, flAfter: 3, annealEvery: 5, retireAt: null, lowBullets: 50, lowPrimers: 100, lowPowderG: 200, currency: 'R', brassLife: 5 },
    rifles: [], bullets: [], powders: [], primers: [], brass: [], loads: [], batches: [], sessions: [], products: {}
  };
}
function idb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open('reload-log', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(_db = r.result);
    r.onerror = () => rej(r.error);
  });
}
async function load() {
  let data = null;
  try {
    const db = await idb();
    data = await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  } catch (e) { try { data = JSON.parse(localStorage.getItem('reload-log') || 'null'); } catch (_) {} }
  S = normalise(data || blank());
}
function normalise(d) {
  const b = blank();
  const out = { ...b, ...d, settings: { ...b.settings, ...(d.settings || {}) } };
  COLS.forEach(c => { if (!Array.isArray(out[c])) out[c] = []; });
  out.sessions.forEach(s => { if (!Array.isArray(s.strings)) s.strings = []; });
  if (!out.products || typeof out.products !== 'object' || Array.isArray(out.products)) out.products = {};
  return out;
}
function batchNo(b) {
  const l = get('loads', b.loadId), r = l && get('rifles', l.rifleId);
  const cal = ((r && r.calibre) || 'B').replace(/[^0-9a-z]/gi, '').slice(0, 6).toUpperCase() || 'B';
  const d = (b.date || today()).replace(/-/g, '').slice(2);
  const pre = `${cal}-${d}-`;
  const used = S.batches.filter(x => x !== b && x.no && x.no.startsWith(pre)).length;
  return pre + String(used + 1).padStart(2, '0');
}
function numberBatches() { [...S.batches].sort(byDate).forEach(b => { if (!b.no) b.no = batchNo(b); }); }
async function save() {
  sortAll();
  const el = $('#savestate');
  try {
    const db = await idb();
    await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(S, 'state'); t.oncomplete = res; t.onerror = () => rej(t.error); });
    el.textContent = 'Saved';
  } catch (e) {
    try { localStorage.setItem('reload-log', JSON.stringify(S)); el.textContent = 'Saved'; }
    catch (_) { el.textContent = 'NOT SAVED'; alert('Could not save data on this device: ' + e.message); }
  }
  clearTimeout(save._t); save._t = setTimeout(() => el.textContent = '', 1500);
}

/* ---------- units ----------
   Everything is stored in one base unit (mm, m/s, m, °C, hPa) and shown/entered in the unit chosen per measurement in Settings. */
const UNITS = {
  len: { key: 'lenUnit', def: 'mm', label: 'Cartridge & case lengths (COAL, CBTO, trim)', opts: { mm: ['mm', 1, 2], in: ['in', 25.4, 3] } },
  barrel: { key: 'barrelUnit', def: 'in', label: 'Barrel length', opts: { in: ['in', 25.4, 1], mm: ['mm', 1, 0] } },
  vel: { key: 'velUnit', def: 'ms', label: 'Velocity', opts: { ms: ['m/s', 1, 0], fps: ['fps', 0.3048, 0] } },
  dist: { key: 'distUnit', def: 'm', label: 'Range distance', opts: { m: ['m', 1, 0], yd: ['yd', 0.9144, 0] } },
  group: { key: 'groupUnit', def: 'mm', label: 'Group size', opts: { mm: ['mm', 1, 0], in: ['in', 25.4, 2] } },
  temp: { key: 'tempUnit', def: 'C', label: 'Temperature', opts: { C: ['°C', 1, 0], F: ['°F', 1, 0] } },
  alt: { key: 'altUnit', def: 'm', label: 'Altitude', opts: { m: ['m', 1, 0], ft: ['ft', 0.3048, 0] } },
  press: { key: 'pressUnit', def: 'hPa', label: 'Air pressure', opts: { hPa: ['hPa', 1, 0], inHg: ['inHg', 33.8639, 2] } }
};
const uCur = dim => { const U = UNITS[dim], c = S.settings[U.key]; return U.opts[c] ? c : U.def; };
const uLbl = dim => UNITS[dim].opts[uCur(dim)][0];
function toU(dim, base, unit = uCur(dim)) {
  if (base == null || base === '' || isNaN(base)) return null; base = +base;
  if (dim === 'temp') return unit === 'F' ? base * 9 / 5 + 32 : base;
  return base / UNITS[dim].opts[unit][1];
}
function fromU(dim, v, unit = uCur(dim)) {
  if (v == null || v === '' || isNaN(v)) return null; v = +v;
  if (dim === 'temp') return unit === 'F' ? (v - 32) * 5 / 9 : v;
  return v * UNITS[dim].opts[unit][1];
}
const fU = (dim, base, withUnit = true) => { const v = toU(dim, base); return v == null ? '–' : v.toFixed(UNITS[dim].opts[uCur(dim)][2]) + (withUnit ? (dim === 'temp' ? '' : ' ') + uLbl(dim) : ''); };
const inch = () => uCur('len') === 'in';
const unitLbl = () => uLbl('len');
const toDisp = mm => mm == null ? '' : +toU('len', mm).toFixed(4);
const fromDisp = v => fromU('len', v);
const fLen = mm => fU('len', mm);

/* ---------- names ---------- */
const nRifle = r => r ? r.name + (r.calibre ? ` (${r.calibre})` : '') : '?';
const nBullet = b => b ? `${b.maker || ''} ${b.weight ?? ''}gr ${b.name || ''}`.trim() : '?';
const nPowder = p => p ? `${p.maker || ''} ${p.name || ''}`.trim() + (p.lot ? ` · lot ${p.lot}` : '') : '?';
const nPrimer = p => p ? `${p.maker || ''} ${p.name || ''}`.trim() : '?';
/* Brass lots are known by YOUR lot number (1, 2, 3…); the maker's lot number is kept alongside. */
const brassTitle = b => b ? [b.userLot != null && b.userLot !== '' ? 'Lot ' + b.userLot : null, [b.headstamp, b.calibre].filter(Boolean).join(' ') || null, b.name || null].filter(Boolean).join(' · ') || 'Brass' : '?';
const nBrass = b => b ? brassTitle(b) + (b.mark ? ` [${b.mark}]` : '') : '?';
const nextUserLot = () => S.brass.reduce((m, b) => Math.max(m, +b.userLot || 0), 0) + 1;
function migrateUnits() {
  S.rifles.forEach(r => {
    if (r.barrelLen == null && r.barrel) { const m = String(r.barrel).match(/(\d+(?:[.,]\d+)?)/); if (m) { const v = parseFloat(m[1].replace(',', '.')); r.barrelLen = /mm/i.test(r.barrel) || v > 60 ? v : v * 25.4; delete r.barrel; } }
  });
  S.loads.forEach(l => {
    if (l.velUnit === 'fps') { testsOf(l).forEach(t => { if (t.vel != null) t.vel = t.vel * 0.3048; }); if (l.provenVel != null) l.provenVel *= 0.3048; }
    delete l.velUnit;
  });
}
function numberBrass() { [...S.brass].sort((a, b) => (a.created || 0) - (b.created || 0)).forEach(b => { if (b.userLot == null || b.userLot === '') b.userLot = nextUserLot(); }); }
const nLoad = l => l ? (l.name || `${fx(l.charge, 1)}gr ${nPowder(get('powders', l.powderId))}`) : '?';
const nBatch = b => { if (!b) return '?'; const l = get('loads', b.loadId); return `${b.date} · ${nLoad(l)}`; };

/* ---------- derived data ---------- */
function allStrings() {
  const out = [];
  S.sessions.forEach(s => s.strings.forEach(st => out.push({ ...st, session: s })));
  return out;
}
function batchFired(batchId, exceptStringId) {
  let n = 0;
  S.sessions.forEach(s => s.strings.forEach(st => { if (st.batchId === batchId && st.id !== exceptStringId) n += +st.shots || 0; }));
  return n;
}
const batchLeft = b => (+b.qty || 0) - batchFired(b.id);
function rifleRounds(r) {
  let n = +r.initRounds || 0;
  S.sessions.forEach(s => { if (s.rifleId === r.id) s.strings.forEach(st => n += +st.shots || 0); });
  return n;
}
function stockUsed(kind, id) {
  let used = 0;
  S.batches.forEach(b => {
    const l = get('loads', b.loadId); if (!l) return;
    const q = +b.qty || 0;
    if (kind === 'bullet' && (b.bulletLot || l.bulletId) === id) used += q;
    if (kind === 'primer' && (b.primerLot || l.primerId) === id) used += q;
    if (kind === 'powder' && (b.powderLot || l.powderId) === id) used += q * (+l.charge || 0) * GR_TO_G;
  });
  return used;
}
const bulletLeft = b => (+b.qtyBought || 0) - stockUsed('bullet', b.id) - (+b.writeOff || 0);
const primerLeft = p => (+p.qtyBought || 0) - stockUsed('primer', p.id) - (+p.writeOff || 0);
const powderLeft = p => (+p.grams || 0) - stockUsed('powder', p.id) - (+p.writeOff || 0);

/* ---------- cost ---------- */
const cur = () => S.settings.currency || 'R';
const money = (v, d = 2) => v == null || isNaN(v) ? '–' : cur() + ' ' + (+v).toFixed(d);
// Price per single unit: per bullet / primer / case, or per gram of powder.
const unitPrice = x => x && +x.price > 0 && +x.priceQty > 0 ? +x.price / +x.priceQty : null;
// Brass is reused, so its cost is spread over the lot's life (retire-at firings, else the Settings default).
const brassLife = br => rule(br, 'retireAt') || +S.settings.brassLife || 1;
function roundCost(l, brassId, b) {
  if (!l) return null;
  const br = get('brass', brassId || l.brassId);
  const pw = unitPrice(lotOf('powder', b, l)), bc = unitPrice(br);
  const parts = {
    bullet: unitPrice(lotOf('bullet', b, l)),
    powder: pw != null ? pw * (+l.charge || 0) * GR_TO_G : null,
    primer: unitPrice(lotOf('primer', b, l)),
    brass: bc != null ? bc / brassLife(br) : null
  };
  const have = Object.values(parts).filter(v => v != null);
  return { ...parts, total: have.length ? have.reduce((a, b) => a + b, 0) : null, missing: Object.keys(parts).filter(k => parts[k] == null) };
}
// Batches keep the cost from the day they were loaded, so later price changes don't rewrite history.
const batchCost = b => b.cost || roundCost(get('loads', b.loadId), b.brassId, b);
const costNote = c => c && c.missing.length ? ` <span class="sub">(no price: ${c.missing.join(', ')})</span>` : '';
function costBreakdown(c, extra = '') {
  if (!c || c.total == null) return '<div class="alert">No component prices yet — add them under Setup (bullets, powder, primers, brass) to see cost per round.</div>';
  return `<div class="card kv" style="margin-top:0"><div>Per round<b>${money(c.total)}</b></div>${extra}<div>Bullet<b>${money(c.bullet)}</b></div><div>Powder<b>${money(c.powder)}</b></div><div>Primer<b>${money(c.primer)}</b></div><div>Brass (per firing)<b>${money(c.brass)}</b></div></div>${c.missing.length ? `<div class="sub">Excludes ${c.missing.join(', ')} — no price recorded.</div>` : ''}`;
}
const priceFields = (forWhat, def) => [
  { type: 'section', label: 'Price (for cost per round)' },
  { k: 'price', label: `Price paid (${cur()})`, type: 'num', ph: 'e.g. 850' },
  { k: 'priceQty', label: `For how many ${forWhat}`, type: 'num', def, help: `e.g. price of ${def} ${forWhat}` }
];

/* ---------- lots: open / in stock / finished, containers, combining ---------- */
const KIND_COL = { bullet: 'bullets', powder: 'powders', primer: 'primers' };
const QTY_KEY = { bullet: 'qtyBought', powder: 'grams', primer: 'qtyBought' };
const PACK_WORD = { bullet: ['box', 'boxes'], powder: ['tub', 'tubs'], primer: ['box', 'boxes'] };
const STATUS_OPTS = [['stock', 'In stock (sealed)'], ['open', 'Open / in use'], ['finished', 'Finished (empty)']];
const low = v => String(v ?? '').trim().toLowerCase();
function pkey(kind, x) {
  if (!x) return '';
  if (kind === 'bullet') return [low(x.maker), low(x.name), num0(x.weight), low(x.diameter)].join('|');
  if (kind === 'powder') return [low(x.maker), low(x.name)].join('|');
  return [low(x.maker), low(x.name), low(x.size)].join('|');
}
const compLeft = (kind, x) => kind === 'bullet' ? bulletLeft(x) : kind === 'powder' ? powderLeft(x) : primerLeft(x);
const isFinished = x => !!x && x.status === 'finished';
const sameProduct = (kind, ref) => S[KIND_COL[kind]].filter(x => pkey(kind, x) === pkey(kind, ref));
/* The lot you're using now: the open one; else the oldest sealed lot with stock (first in, first out). */
function activeLot(kind, refId) {
  const ref = get(KIND_COL[kind], refId); if (!ref) return null;
  const cands = sameProduct(kind, ref).filter(x => !isFinished(x));
  const open = cands.filter(x => x.status === 'open').sort((a, b) => nat(b.openedOn || '', a.openedOn || '') || (b.created || 0) - (a.created || 0));
  if (open.length) return open[0];
  const stock = cands.filter(x => compLeft(kind, x) > 0).sort((a, b) => (a.created || 0) - (b.created || 0));
  return stock[0] || cands[0] || ref;
}
const lotOf = (kind, b, l) => (b && b[kind + 'Lot'] && get(KIND_COL[kind], b[kind + 'Lot'])) || (l && activeLot(kind, l[kind + 'Id']));
const lotLabel = (kind, x) => x ? `${kind === 'bullet' ? nBullet(x) : kind === 'powder' ? `${x.maker || ''} ${x.name || ''}`.trim() : nPrimer(x)}${x.lot ? ' · lot ' + x.lot : ''}` : '–';
function packInfo(kind, x) {
  if (isFinished(x)) return 'finished ' + (x.finishedOn || '');
  const left = Math.max(0, compLeft(kind, x)), pq = +x.packQty || 0, w = PACK_WORD[kind];
  if (!pq) return +x.packs > 1 ? `${x.packs} ${w[1]} bought` : '';
  const full = Math.floor(left / pq + 1e-6), part = left - full * pq > pq * 0.002 ? 1 : 0, n = full + part;
  if (!n) return 'empty — mark finished';
  return `${n} ${n === 1 ? w[0] : w[1]}` + (part ? ` (1 open${full ? `, ${full} sealed` : ''})` : ' sealed');
}
const statusPillFor = x => x.status === 'open' ? pill('ok', 'OPEN') : x.status === 'finished' ? pill('', 'Finished') : pill('acc', 'In stock');
/* Call after saving an item with a (possibly) new status. */
function applyStatus(kind, item, prev) {
  const st = item.status || 'stock';
  if (st === 'finished' && prev !== 'finished') { item.writeOff = (+item.writeOff || 0) + Math.max(0, compLeft(kind, item)); item.finishedOn = today(); }
  if (st !== 'finished' && prev === 'finished') { item.writeOff = 0; item.finishedOn = null; }
  if (st === 'open' && prev !== 'open') {
    item.openedOn = today();
    sameProduct(kind, item).forEach(x => { if (x !== item && x.status === 'open') x.status = 'stock'; });
  }
}
function dupGroups(kind) {
  const m = new Map();
  S[KIND_COL[kind]].filter(x => !isFinished(x) && low(x.lot)).forEach(x => { const k = pkey(kind, x) + '#' + low(x.lot); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
  return [...m.values()].filter(g => g.length > 1);
}
function combineLots(kind, ids) {
  const col = KIND_COL[kind], qk = QTY_KEY[kind];
  const items = ids.map(id => get(col, id)).filter(Boolean); if (items.length < 2) return;
  const keep = items.find(x => x.status === 'open') || items[0];
  const rest = items.filter(x => x !== keep), restIds = rest.map(x => x.id);
  let cost = 0, costQty = 0;
  items.forEach(x => { const u = unitPrice(x); if (u != null) { cost += u * (+x[qk] || 0); costQty += +x[qk] || 0; } });
  keep[qk] = items.reduce((a, x) => a + (+x[qk] || 0), 0);
  keep.packs = items.reduce((a, x) => a + (+x.packs || 1), 0);
  keep.writeOff = items.reduce((a, x) => a + (+x.writeOff || 0), 0);
  if (costQty) { keep.price = +cost.toFixed(2); keep.priceQty = costQty; }
  ['packQty', 'barcode', 'bc', 'diameter', 'size'].forEach(k => { if (keep[k] == null || keep[k] === '') { const s = rest.find(x => x[k] != null && x[k] !== ''); if (s) keep[k] = s[k]; } });
  keep.notes = [...new Set(items.map(x => x.notes).filter(Boolean))].join('\n');
  S.loads.forEach(l => { if (restIds.includes(l[kind + 'Id'])) l[kind + 'Id'] = keep.id; });
  S.batches.forEach(b => { if (restIds.includes(b[kind + 'Lot'])) b[kind + 'Lot'] = keep.id; });
  S[col] = S[col].filter(x => !restIds.includes(x.id));
}
function compListView(kind, act, newAct, sub, unit) {
  const col = KIND_COL[kind], qk = QTY_KEY[kind];
  const live = S[col].filter(x => !isFinished(x)), done = S[col].filter(isFinished);
  const dups = dupGroups(kind).map(g => `<div class="alert">${g.length} entries are the same product and lot <b>${esc(lotLabel(kind, g[0]))}</b>. <button class="btn sm" data-act="combine" data-kind="${kind}" data-ids="${g.map(x => x.id).join(',')}">Combine</button></div>`).join('');
  const cardFor = x => stockCard(act, x.id, lotLabel(kind, x), [...sub(x), packInfo(kind, x)], compLeft(kind, x), +x[qk] || 0, unit, statusPillFor(x));
  return `<div class="btns"><button class="btn pri" data-act="${newAct}">+ New</button><button class="btn" data-act="scan" data-kind="${kind}">▦ Scan</button><button class="btn" data-act="photo" data-kind="${kind}">📷 Photo</button></div>
    ${dups}${live.map(cardFor).join('') || empty('Nothing in stock.')}
    ${done.length ? `<details class="card"><summary class="sub" style="cursor:pointer">Finished (${done.length}) — kept for history</summary>${done.map(cardFor).join('')}</details>` : ''}`;
}

function rule(br, k) { return br[k] != null && br[k] !== '' ? +br[k] : (S.settings[k] != null && S.settings[k] !== '' ? +S.settings[k] : null); }

/* Brass life cycle — counted from the batches loaded with this lot. Each loading = one firing. */
function brassState(br) {
  const hist = S.batches.filter(b => b.brassId === br.id).sort(byDate);
  let firings = +br.initFirings || 0, neck = +br.initNeck || 0, anneal = +br.initAnneal || 0;
  let lastLen = br.lastLen ?? null, lastTrim = null;
  // Batches from the same lot on the same date = one loading cycle (e.g. a ladder test split across steps).
  const cycles = [];
  hist.forEach(b => { const c = cycles[cycles.length - 1]; if (c && c.date === b.date) c.items.push(b); else cycles.push({ date: b.date, items: [b] }); });
  cycles.forEach(({ items }) => {
    firings++;
    if (items.some(b => b.sizing === 'fl' || b.sizing === 'bump')) neck = 0;
    else if (items.some(b => b.sizing === 'neck')) neck++;
    anneal = items.some(b => b.annealed) ? 1 : anneal + 1;
    items.forEach(b => { if (b.trimmed) lastTrim = b.date; if (b.measuredLen != null) lastLen = b.measuredLen; });
  });
  const loaded = hist.reduce((a, b) => a + Math.max(0, batchLeft(b)), 0);
  const flAfter = rule(br, 'flAfter'), annealEvery = rule(br, 'annealEvery'), retireAt = rule(br, 'retireAt');
  const alerts = [];
  if (br.retired) alerts.push(['ok', 'Retired']);
  else {
    if (retireAt && firings >= retireAt) alerts.push(['bad', `Retire: ${firings} firings (limit ${retireAt})`]);
    else if (retireAt && firings >= retireAt - 1) alerts.push(['warn', `Last loading before retire limit (${retireAt})`]);
    if (flAfter != null && neck >= flAfter) alerts.push(['warn', `Full-length resize next (${neck} neck sizes since FL)`]);
    if (annealEvery && anneal >= annealEvery) alerts.push(['warn', `Anneal next (${anneal} firings since anneal)`]);
    if (br.maxLen != null && lastLen != null && lastLen > br.maxLen) alerts.push(['warn', `Trim: last measured ${fLen(lastLen)} > max ${fLen(br.maxLen)}` + (br.trimTo != null ? `, trim to ${fLen(br.trimTo)}` : '')]);
  }
  return { hist, firings, neck, anneal, lastLen, lastTrim, loaded, alerts, flAfter, annealEvery, retireAt };
}

function parseVels(txt) { return String(txt || '').split(/[\s,;]+/).map(Number).filter(v => v > 0); }
/* A string's velocities converted to the velocity unit chosen in Settings (each string remembers the unit it was typed in). */
const stringVels = st => parseVels(st.vels).map(v => toU('vel', fromU('vel', v, st.velUnit || 'ms')));
function stats(vels) {
  const n = vels.length; if (!n) return { n: 0 };
  const avg = vels.reduce((a, b) => a + b, 0) / n;
  const es = Math.max(...vels) - Math.min(...vels);
  const sd = n > 1 ? Math.sqrt(vels.reduce((a, v) => a + (v - avg) ** 2, 0) / (n - 1)) : null;
  return { n, avg, es, sd };
}
function moa(groupMm, distM) { return groupMm && distM ? groupMm / (distM / 100 * MOA_MM_PER_100M) : null; }
function mil(groupMm, distM) { return groupMm && distM ? groupMm / distM : null; }
function loadStrings(loadId) { return allStrings().filter(st => { const b = get('batches', st.batchId); return b && b.loadId === loadId; }); }
function loadSummary(loadId) {
  const strs = loadStrings(loadId);
  const vels = strs.flatMap(st => stringVels(st));
  const s = stats(vels);
  const moas = strs.map(st => moa(st.groupMm, st.session.distance)).filter(x => x);
  return { ...s, strings: strs.length, shots: strs.reduce((a, st) => a + (+st.shots || 0), 0), bestMoa: moas.length ? Math.min(...moas) : null, avgMoa: moas.length ? moas.reduce((a, b) => a + b, 0) / moas.length : null };
}

/* ---------- form engine ---------- */
function openForm(cfg) {
  const v = cfg.values || {};
  const f = fd => {
    if (fd.type === 'section') return `<h4 class="fsec">${esc(fd.label)}</h4>`;
    const val = v[fd.k] ?? fd.def;
    const cls = fd.full || fd.type === 'textarea' ? 'fld full' : 'fld';
    let inp;
    switch (fd.type) {
      case 'select':
        inp = `<select name="${fd.k}">${fd.noBlank ? '' : '<option value="">—</option>'}${fd.options.map(([o, l]) => `<option value="${esc(o)}"${String(o) === String(val ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`; break;
      case 'textarea': inp = `<textarea name="${fd.k}" placeholder="${esc(fd.ph || '')}">${esc(val)}</textarea>`; break;
      case 'check': return `<label class="chk full" style="grid-column:1/-1"><input type="checkbox" name="${fd.k}"${val ? ' checked' : ''}> ${esc(fd.label)}</label>`;
      case 'len': case 'u': { const dm = fd.type === 'len' ? 'len' : fd.dim, dv = toU(dm, val ?? null); inp = `<input name="${fd.k}" type="number" step="any" inputmode="decimal" value="${dv == null ? '' : +dv.toFixed(4)}" placeholder="${esc(fd.ph || '')}">`; break; }
      case 'num': inp = `<input name="${fd.k}" type="number" step="any" inputmode="decimal" value="${esc(val)}" placeholder="${esc(fd.ph || '')}">`; break;
      case 'date': inp = `<input name="${fd.k}" type="date" value="${esc(val || (fd.noDefault ? '' : today()))}">`; break;
      case 'password': inp = `<input name="${fd.k}" type="password" autocomplete="off" value="${esc(val)}" placeholder="${esc(fd.ph || '')}">`; break;
      default: inp = `<input name="${fd.k}" type="text" value="${esc(val)}" placeholder="${esc(fd.ph || '')}">`;
        if (fd.photo) inp = `<div class="row" style="flex-wrap:nowrap">${inp}<button type="button" class="btn sm" style="white-space:nowrap;flex:none" data-act="lotPhoto" data-k="${fd.k}" title="Photograph the lot number">📷 Lot</button></div>`;
    }
    return `<label class="${cls}"><span>${esc(fd.label)}${fd.type === 'len' ? ` (${unitLbl()})` : fd.type === 'u' ? ` (${uLbl(fd.dim)})` : ''}${fd.req ? ' *' : ''}</span>${inp}${fd.help ? `<small>${esc(fd.help)}</small>` : ''}</label>`;
  };
  const m = $('#modal');
  m.innerHTML = `<div class="sheet"><div class="sheet-h"><h3>${esc(cfg.title)}</h3><button type="button" data-close aria-label="Close">✕</button></div>
    <form id="mform" novalidate>${cfg.intro || v._intro || ''}${cfg.hintTop ? '<div id="fhint" class="hint"></div>' : ''}<div class="fgrid">${cfg.fields.map(f).join('')}</div>
    ${cfg.hintTop ? '' : '<div id="fhint" class="hint"></div>'}<div class="err" id="ferr"></div>
    <div class="frow"><button class="btn pri" type="submit">${esc(cfg.saveLabel || 'Save')}</button>${cfg.onDelete ? '<button type="button" class="btn danger" id="fdel">Delete</button>' : ''}</div></form></div>`;
  m.hidden = false;
  const form = $('#mform');
  const read = () => {
    const o = {};
    cfg.fields.forEach(fd => {
      if (fd.type === 'section') return;
      const el = form.elements[fd.k]; if (!el) return;
      if (fd.type === 'check') o[fd.k] = el.checked;
      else if (fd.type === 'num') o[fd.k] = num(el.value);
      else if (fd.type === 'len') o[fd.k] = el.value === '' ? null : fromDisp(+el.value);
      else if (fd.type === 'u') o[fd.k] = el.value === '' ? null : fromU(fd.dim, +el.value);
      else o[fd.k] = el.value.trim();
    });
    return o;
  };
  const err = t => { $('#ferr').textContent = t; };
  const upd = () => { if (cfg.hint) $('#fhint').innerHTML = cfg.hint(read(), form) || ''; };
  form.addEventListener('input', upd); form.addEventListener('change', upd); upd();
  form.onsubmit = async e => {
    e.preventDefault();
    const o = read();
    for (const fd of cfg.fields) if (fd.req && (o[fd.k] === '' || o[fd.k] == null)) return err(`${fd.label} is required`);
    const r = await cfg.onSave(o);
    if (typeof r === 'string') return err(r);
    closeModal(); await save();
    if (typeof r === 'object' && r && r.go && location.hash !== r.go) location.hash = r.go; else render();
    if (typeof r === 'object' && r && r.next) r.next();
  };
  if (cfg.onDelete) $('#fdel').onclick = async () => {
    if (!confirm('Delete this permanently?')) return;
    const r = cfg.onDelete(); if (typeof r === 'string') return err(r);
    closeModal(); await save(); if (cfg.afterDelete) location.hash = cfg.afterDelete; else render();
  };
}
function closeModal() { stopScanner(); const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
function upsert(col, obj, vals) {
  if (obj) { Object.assign(obj, vals); return obj; }
  const n = { id: uid(), created: Date.now(), ...vals }; S[col].push(n); return n;
}
function remove(col, id) { S[col] = S[col].filter(x => x.id !== id); }
function inUse(msg, n) { return n ? `Can't delete — ${msg} (${n}). Remove those first.` : null; }

/* ---------- forms ---------- */
const scanFields = unitHelp => [
  { type: 'section', label: 'Packet barcode (fills in next time you scan)' },
  { k: 'barcode', label: 'Barcode', ph: 'Scan or type' },
  { k: 'packQty', label: 'Pack size', type: 'num', help: unitHelp }
];
function learn(kind, o) {
  if (!o.barcode) return;
  const K = KINDS[kind];
  const values = {}; K.tpl.forEach(k => { if (o[k] != null && o[k] !== '') values[k] = o[k]; });
  S.products[o.barcode] = { kind, packQty: o.packQty ?? S.products[o.barcode]?.packQty ?? null, values };
}
function rifleForm(r) {
  openForm({
    title: r ? 'Edit rifle' : 'New rifle', values: r,
    fields: [
      { k: 'name', label: 'Name', req: true, full: true, ph: 'e.g. Tikka T3x 308' },
      { k: 'calibre', label: 'Calibre', req: true, ph: '.308 Win' },
      { k: 'twist', label: 'Twist rate', ph: '1:10' },
      { k: 'barrelLen', label: 'Barrel length', type: 'u', dim: 'barrel' },
      { k: 'initRounds', label: 'Rounds fired before app', type: 'num', def: 0 },
      { k: 'optic', label: 'Scope / optic', full: true },
      { k: 'notes', label: 'Notes (throat, chamber, etc.)', type: 'textarea' }
    ],
    onSave: o => { upsert('rifles', r, o); },
    onDelete: r && (() => inUse('loads use this rifle', S.loads.filter(l => l.rifleId === r.id).length) || inUse('range sessions use it', S.sessions.filter(s => s.rifleId === r.id).length) || remove('rifles', r.id)),
    afterDelete: '#/rifles'
  });
}
function bulletForm(b, preset) {
  openForm({
    title: b ? 'Edit bullet' : 'New bullet', values: b || preset,
    fields: [
      { k: 'maker', label: 'Maker', req: true, ph: 'Sierra' },
      { k: 'name', label: 'Model', req: true, ph: 'MatchKing HPBT' },
      { k: 'weight', label: 'Weight (gr)', type: 'num', req: true },
      { k: 'diameter', label: 'Diameter / calibre', ph: '.308' },
      { k: 'bc', label: 'BC (G1/G7)', ph: 'G7 0.243' },
      { k: 'lot', label: 'Lot number', photo: true, full: true },
      { k: 'status', label: 'Status', type: 'select', noBlank: true, options: STATUS_OPTS, def: 'stock', full: true, help: 'Open = the box you are loading from now. Finished = empty; any small difference is written off.' },
      { k: 'qtyBought', label: 'Total bought (qty)', type: 'num', full: true, help: 'For this lot only. Same product with a different lot = a new entry. Stock left is worked out from batches loaded.' },
      ...priceFields('bullets', 100),
      ...scanFields('Bullets per box, e.g. 100'),
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => { const prev = b ? b.status || 'stock' : 'stock'; const n = upsert('bullets', b, o); applyStatus('bullet', n, prev); learn('bullet', o); },
    onDelete: b && (() => inUse('loads use this bullet', S.loads.filter(l => l.bulletId === b.id).length) || remove('bullets', b.id))
  });
}
function powderForm(p, preset) {
  openForm({
    title: p ? 'Edit powder' : 'New powder', values: p || preset,
    fields: [
      { k: 'maker', label: 'Maker', req: true, ph: 'Somchem / Hodgdon' },
      { k: 'name', label: 'Powder', req: true, ph: 'S365 / Varget' },
      { k: 'lot', label: 'Lot number', photo: true, full: true, help: 'Add each new powder lot separately — burn rates vary between lots.' },
      { k: 'status', label: 'Status', type: 'select', noBlank: true, options: STATUS_OPTS, def: 'stock', full: true, help: 'Open = the tub you are loading from now. Finished = empty; the scale difference is written off.' },
      { k: 'grams', label: 'Total bought (grams)', type: 'num', full: true, help: 'For this lot, e.g. one 1 kg tub = 1000; two tubs of the same lot = 2000.' },
      ...priceFields('grams', 1000),
      ...scanFields('Grams per container, e.g. 1000'),
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => { const prev = p ? p.status || 'stock' : 'stock'; const n = upsert('powders', p, o); applyStatus('powder', n, prev); learn('powder', o); },
    onDelete: p && (() => inUse('loads use this powder', S.loads.filter(l => l.powderId === p.id).length) || remove('powders', p.id))
  });
}
function primerForm(p, preset) {
  openForm({
    title: p ? 'Edit primer' : 'New primer', values: p || preset,
    fields: [
      { k: 'maker', label: 'Maker', req: true, ph: 'CCI / PMP / Federal' },
      { k: 'name', label: 'Model', req: true, ph: 'BR2 / 210M' },
      { k: 'size', label: 'Type', type: 'select', options: PRIMER_SIZES },
      { k: 'lot', label: 'Lot number', photo: true, full: true },
      { k: 'status', label: 'Status', type: 'select', noBlank: true, options: STATUS_OPTS, def: 'stock', full: true },
      { k: 'qtyBought', label: 'Total bought (qty)', type: 'num', full: true, help: 'For this lot only.' },
      ...priceFields('primers', 100),
      ...scanFields('Primers per box, e.g. 1000'),
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => { const prev = p ? p.status || 'stock' : 'stock'; const n = upsert('primers', p, o); applyStatus('primer', n, prev); learn('primer', o); },
    onDelete: p && (() => inUse('loads use this primer', S.loads.filter(l => l.primerId === p.id).length) || remove('primers', p.id))
  });
}
function brassForm(br, preset) {
  const d = S.settings;
  openForm({
    title: br ? 'Edit brass lot' : 'New brass lot', values: br || { userLot: nextUserLot(), ...(preset || {}) },
    fields: [
      { k: 'userLot', label: 'Your lot no.', type: 'num', req: true, help: br ? 'Your own number for this lot' : 'Next free number filled in' },
      { k: 'calibre', label: 'Calibre', req: true, ph: '.308 Win' },
      { k: 'headstamp', label: 'Headstamp / maker', ph: 'Lapua' },
      { k: 'count', label: br ? 'Number of cases' : 'Number of cases (total)', type: 'num', req: true },
      { k: 'makerLot', label: "Maker's lot number", photo: true, full: true },
      ...(br ? [] : [{ k: 'splitSize', label: 'Work in batches of (cases per lot)', type: 'num', full: true, ph: 'e.g. 50, 75, 100, 200', help: 'Optional. Splits the cases into lots with your next lot numbers, e.g. 100 cases in batches of 50 = Lot 1 and Lot 2. For one lot bigger than a box (e.g. 200), enter Number of cases = 200 and leave this blank.' }]),
      { k: 'mark', label: 'Case marking / box label', full: true, ph: 'e.g. 1 dot on head · "Lot 1" on box', help: 'How you tell this lot apart physically' },
      { k: 'name', label: 'Description (optional)', full: true, ph: 'e.g. bought Nov 2026, once-fired' },
      { k: 'rifleId', label: 'Fire-formed to rifle', type: 'select', options: opts('rifles', nRifle) },
      { type: 'section', label: 'History when added (0 for new brass)' },
      { k: 'initFirings', label: 'Times fired', type: 'num', def: 0 },
      { k: 'initNeck', label: 'Neck sizes since FL', type: 'num', def: 0 },
      { k: 'initAnneal', label: 'Firings since anneal', type: 'num', def: 0 },
      { type: 'section', label: 'Your rules (blank = defaults in Settings)' },
      { k: 'flAfter', label: 'FL resize after N neck sizes', type: 'num', ph: String(d.flAfter ?? '') },
      { k: 'annealEvery', label: 'Anneal every N firings', type: 'num', ph: String(d.annealEvery ?? '') },
      { k: 'retireAt', label: 'Retire after N firings', type: 'num', ph: String(d.retireAt ?? '') },
      { k: 'maxLen', label: 'Max case length', type: 'len', help: 'Trim alert when measured length is over this' },
      { k: 'trimTo', label: 'Trim-to length', type: 'len' },
      { k: 'lastLen', label: 'Current measured length', type: 'len' },
      { k: 'retired', label: 'Lot retired', type: 'check' },
      ...priceFields('cases', 100),
      ...scanFields('Cases per box, e.g. 100'),
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => {
      const split = o.splitSize; delete o.splitSize;
      if (o.count <= 0) return 'Number of cases must be more than 0.';
      const parts = !br && split > 0 && o.count > split ? Math.ceil(o.count / split) : 1;
      for (let i = 0; i < parts; i++) { const taken = S.brass.find(x => x !== br && +x.userLot === o.userLot + i); if (taken) return `Lot no. ${o.userLot + i} is already used (${brassTitle(taken)}). Choose another number.`; }
      if (parts > 1) {
        for (let i = 0; i < parts; i++) upsert('brass', null, { ...o, userLot: o.userLot + i, count: Math.min(split, o.count - split * i), mark: o.mark || `Lot ${o.userLot + i}` });
        learn('brass', o); return { go: '#/brass' };
      }
      const n = upsert('brass', br, o); learn('brass', o); return br ? null : { go: '#/brasslot/' + n.id };
    },
    onDelete: br && (() => inUse('batches used this brass', S.batches.filter(b => b.brassId === br.id).length) || remove('brass', br.id)),
    afterDelete: '#/brass'
  });
}
function needComponents() {
  const miss = [];
  if (!S.rifles.length) miss.push('a rifle');
  if (!S.bullets.length) miss.push('a bullet');
  if (!S.powders.length) miss.push('a powder');
  if (!S.primers.length) miss.push('a primer');
  if (miss.length) { alert('First add ' + miss.join(', ') + ' under Setup.'); location.hash = '#/setup'; return true; }
  return false;
}
function chargeHint(o) {
  if (o.charge == null) return '';
  if (o.maxCharge == null) return `<div class="alert">Enter the <b>maximum charge from your load manual</b> to switch on over-max protection.</div>`;
  if (o.charge > o.maxCharge) return `<div class="alert bad">Charge ${fx(o.charge, 2)}gr is <b>over the manual max</b> of ${fx(o.maxCharge, 2)}gr. It can't be saved.</div>`;
  const pct = (o.maxCharge - o.charge) / o.maxCharge * 100;
  if (pct <= 3) return `<div class="alert">Within ${fx(pct, 1)}% of manual max — watch for pressure signs.</div>`;
  return `<div class="alert ok">${fx(pct, 1)}% below manual max.</div>`;
}
function loadForm(l, copyFrom) {
  if (!l && needComponents()) return;
  const v = l || (copyFrom ? { ...copyFrom, name: (copyFrom.name || '') + ' (copy)', id: undefined, status: 'dev' } : { status: 'dev' });
  openForm({
    title: l ? 'Edit load' : 'New load recipe', values: v,
    fields: [
      { k: 'name', label: 'Load name', full: true, ph: 'e.g. 308 168SMK S365 44.0' },
      { k: 'rifleId', label: 'Rifle', type: 'select', req: true, options: opts('rifles', nRifle), full: true },
      { k: 'bulletId', label: 'Bullet', type: 'select', req: true, options: prodOpts('bullet', v.bulletId), full: true },
      { k: 'powderId', label: 'Powder', type: 'select', req: true, options: prodOpts('powder', v.powderId), full: true },
      { k: 'primerId', label: 'Primer', type: 'select', req: true, options: prodOpts('primer', v.primerId) },
      { k: 'brassId', label: 'Brass lot (default)', type: 'select', options: opts('brass', nBrass, b => !b.retired) },
      { k: 'charge', label: 'Charge (gr)', type: 'num', req: true },
      { k: 'maxCharge', label: 'Manual max (gr)', type: 'num', help: 'From your load manual' },
      { k: 'coal', label: 'COAL', type: 'len' },
      { k: 'cbto', label: 'CBTO', type: 'len' },
      { k: 'jump', label: 'Jump to lands', type: 'len' },
      { k: 'neckTension', label: 'Neck tension', ph: '0.002"' },
      { k: 'source', label: 'Data source', full: true, ph: 'e.g. Somchem manual 2023, p.88' },
      { k: 'status', label: 'Status', type: 'select', options: STATUS, noBlank: true },
      { k: 'series', label: 'Test series tag', ph: 'groups ladder tests' },
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    hint: o => { const c = roundCost(o, o.brassId); return chargeHint(o) + (c && c.total != null ? `<div class="sub">Cost ≈ <b>${money(c.total)}</b> per round${costNote(c)}</div>` : ''); },
    onSave: o => {
      if (o.maxCharge != null && o.charge > o.maxCharge) return 'Charge is over the manual maximum.';
      if (o.charge <= 0) return 'Charge must be more than 0.';
      const n = upsert('loads', l, o); return l ? null : { go: '#/load/' + n.id };
    },
    onDelete: l && (() => inUse('batches were loaded with this recipe', S.batches.filter(b => b.loadId === l.id).length) || remove('loads', l.id)),
    afterDelete: '#/loads'
  });
}
function brassHint(brassId) {
  const br = get('brass', brassId); if (!br) return '';
  const st = brassState(br);
  const head = `<div class="sub" style="margin-bottom:6px">${esc(brassTitle(br))}: fired ${st.firings}×, ${st.neck} neck size(s) since FL, ${st.anneal} firing(s) since anneal${st.loaded ? ` · <b>${st.loaded} still loaded</b>` : ''}</div>`;
  return head + (st.alerts.length ? st.alerts.map(([c, t]) => `<div class="alert ${c}">${esc(t)}</div>`).join('') : '<div class="alert ok">No brass work due.</div>');
}
function batchForm(b, preset) {
  if (!S.loads.length) { alert('Create a load recipe first.'); location.hash = '#/loads'; return; }
  const v = b || { date: today(), sizing: 'neck', ...(preset || {}) };
  const rf = !b && preset && preset.rifleId ? get('rifles', preset.rifleId) : null;
  const bl = b && get('loads', b.loadId);
  if (b) ['bullet', 'powder', 'primer'].forEach(k => { if (!v[k + 'Lot']) { const x = lotOf(k, b, bl); if (x) v[k + 'Lot'] = x.id; } });
  const lotFields = b && bl ? [{ type: 'section', label: 'Lots used' }, ...['bullet', 'powder', 'primer'].map(k => ({ k: k + 'Lot', label: k[0].toUpperCase() + k.slice(1) + ' lot', type: 'select', noBlank: true, full: true, options: sameProduct(k, get(KIND_COL[k], bl[k + 'Id']) || {}).map(x => [x.id, lotLabel(k, x) + (isFinished(x) ? ' (finished)' : '')]) }))] : [];
  if (!b && v.loadId && !v.brassId) { const l = get('loads', v.loadId); if (l && l.brassId) v.brassId = l.brassId; }
  openForm({
    title: b ? 'Edit batch ' + (b.no || '') : 'Load a batch' + (rf ? ' — ' + rf.name : ''), values: v, hintTop: true,
    fields: [
      { k: 'date', label: 'Date loaded', type: 'date' },
      { k: 'qty', label: 'Rounds loaded', type: 'num', req: true },
      { k: 'loadId', label: 'Load recipe', type: 'select', req: true, options: opts('loads', nLoad, l => (l.status !== 'rejected' && (!rf || l.rifleId === rf.id)) || (b && b.loadId === l.id)), full: true },
      { k: 'brassId', label: 'Brass lot', type: 'select', req: true, options: opts('brass', nBrass, x => !x.retired || (b && b.brassId === x.id)), full: true },
      { type: 'section', label: 'Case prep done for this batch' },
      { k: 'sizing', label: 'Sizing', type: 'select', options: SIZING, noBlank: true, full: true },
      { k: 'annealed', label: 'Annealed', type: 'check' },
      { k: 'trimmed', label: 'Trimmed', type: 'check' },
      { k: 'measuredLen', label: 'Case length measured', type: 'len' },
      { k: 'bump', label: 'Shoulder bump', ph: '0.002"' },
      ...lotFields,
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    hint: o => {
      let h = '';
      const l = get('loads', o.loadId);
      if (l) {
        const q = o.qty || 0;
        const bu = get('bullets', l.bulletId), pr = get('primers', l.primerId), pw = get('powders', l.powderId);
        const need = [];
        const prodLeft = (k, ref) => ref ? sameProduct(k, ref).filter(x => !isFinished(x)).reduce((t, x) => t + Math.max(0, compLeft(k, x)), 0) : Infinity;
        if (!b) {
          if (prodLeft('bullet', bu) < q) need.push('bullets');
          if (prodLeft('primer', pr) < q) need.push('primers');
          if (prodLeft('powder', pw) < q * (+l.charge || 0) * GR_TO_G) need.push('powder');
          const lots = ['bullet', 'powder', 'primer'].map(k => [k, lotOf(k, null, l)]);
          h += `<div class="sub" style="margin-bottom:6px">Lots used (the open ones): ${lots.map(([k, x]) => `<b>${esc(lotLabel(k, x))}</b>${x && x.status !== 'open' ? ' <span class="pill acc">will be opened</span>' : ''}`).join(' · ')}</div>`;
          lots.forEach(([k, x]) => { if (!x) return; const left = compLeft(k, x), use = k === 'powder' ? q * (+l.charge || 0) * GR_TO_G : q; if (q && left < use && prodLeft(k, x) >= use) h += `<div class="alert">The open ${k} lot has only ${fx(left, 0)}${k === 'powder' ? ' g' : ''} left. If it runs out, load the rest as a second batch after opening the next lot.</div>`; });
        }
        h += `<div class="card" style="margin-bottom:8px"><div class="sub">${esc(nBullet(bu))} · ${esc(pw ? lotLabel('powder', { ...pw, lot: '' }) : '?')} <b>${fx(l.charge, 2)}gr</b> · ${esc(nPrimer(pr))}${l.cbto != null ? ` · CBTO ${fLen(l.cbto)}` : ''}${l.coal != null ? ` · COAL ${fLen(l.coal)}` : ''}</div>${q ? `<div class="sub">Uses ${fx(q * (l.charge || 0) * GR_TO_G, 1)} g powder</div>` : ''}</div>`;
        const c = roundCost(l, o.brassId);
        if (c && c.total != null) h += `<div class="sub" style="margin-bottom:6px">Cost ≈ <b>${money(c.total)}</b> per round${q ? ` · <b>${money(c.total * q)}</b> for ${q}` : ''}${costNote(c)}</div>`;
        if (need.length) h += `<div class="alert">Stock recorded is too low for: ${need.join(', ')}. Update stock under Setup if you've bought more.</div>`;
      }
      h += brassHint(o.brassId);
      const br = get('brass', o.brassId);
      if (br && !b) {
        const st = brassState(br);
        if (st.flAfter != null && st.neck >= st.flAfter && o.sizing === 'neck') h += `<div class="alert bad">This lot is due for a full-length resize — you've selected neck sizing.</div>`;
        if (st.annealEvery && st.anneal >= st.annealEvery && !o.annealed) h += `<div class="alert bad">This lot is due for annealing — tick "Annealed" once done.</div>`;
        if (o.qty && br.count && o.qty > br.count) h += `<div class="alert">More rounds than cases in the lot (${br.count}).</div>`;
      }
      return h;
    },
    onSave: o => {
      if (o.qty <= 0) return 'Rounds must be more than 0.';
      if (b && o.qty < batchFired(b.id)) return `Already ${batchFired(b.id)} fired from this batch.`;
      const reprice = !b || !b.cost || b.cost.missing.length || b.loadId !== o.loadId || b.brassId !== o.brassId;
      const n = upsert('batches', b, o);
      if (!n.no) n.no = batchNo(n);
      const nl = get('loads', n.loadId);
      ['bullet', 'powder', 'primer'].forEach(k => {
        let x = n[k + 'Lot'] && get(KIND_COL[k], n[k + 'Lot']);
        if (!x || pkey(k, x) !== pkey(k, get(KIND_COL[k], nl[k + 'Id']))) x = lotOf(k, null, nl);
        if (!x) return;
        if (n[k + 'Lot'] !== x.id && b) n.cost = null;
        n[k + 'Lot'] = x.id;
        if (!b && x.status !== 'open' && !isFinished(x)) { const prev = x.status || 'stock'; x.status = 'open'; applyStatus(k, x, prev); }
      });
      if (reprice || !n.cost) { const c = roundCost(nl, n.brassId, n); if (c && c.total != null) n.cost = c; }
      return b ? null : { go: '#/batch/' + n.id };
    },
    onDelete: b && (() => inUse('range strings were shot from this batch', allStrings().filter(s => s.batchId === b.id).length) || remove('batches', b.id)),
    afterDelete: '#/batches'
  });
}
function sessionForm(s) {
  if (!S.rifles.length) { alert('Add a rifle first under Setup.'); location.hash = '#/rifles'; return; }
  openForm({
    title: s ? 'Edit range session' : 'New range session', values: s || { date: today(), distance: S.settings.distance },
    fields: [
      { k: 'date', label: 'Date', type: 'date' },
      { k: 'rifleId', label: 'Rifle', type: 'select', req: true, options: opts('rifles', nRifle) },
      { k: 'location', label: 'Range / location', full: true },
      { k: 'distance', label: 'Distance', type: 'u', dim: 'dist', req: true },
      { k: 'tempC', label: 'Temp', type: 'u', dim: 'temp' },
      { k: 'pressure', label: 'Pressure', type: 'u', dim: 'press' },
      { k: 'humidity', label: 'Humidity (%)', type: 'num' },
      { k: 'altitude', label: 'Altitude', type: 'u', dim: 'alt' },
      { k: 'wind', label: 'Wind', ph: '3 m/s from 9 o\'clock' },
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => { const n = upsert('sessions', s, o); if (!s) n.strings = []; return s ? null : { go: '#/session/' + n.id }; },
    onDelete: s && (() => { remove('sessions', s.id); }),
    afterDelete: '#/range'
  });
}
function stringForm(sess, st) {
  const avail = S.batches.filter(b => batchLeft(b) > 0 || (st && st.batchId === b.id));
  const preferred = avail.filter(b => get('loads', b.loadId)?.rifleId === sess.rifleId);
  const list = preferred.length ? preferred : avail;
  if (!list.length) { alert('No loaded rounds available. Load a batch first.'); return; }
  openForm({
    title: st ? 'Edit string' : 'Record a string / group', values: st ? { ...st, vels: (st.velUnit || 'ms') === uCur('vel') ? st.vels : stringVels(st).map(v => Math.round(v * 10) / 10).join(' ') } : null,
    fields: [
      { k: 'batchId', label: 'Ammo batch', type: 'select', req: true, full: true, options: list.map(b => [b.id, `${nBatch(b)} (${batchLeft(b) + (st && st.batchId === b.id ? +st.shots || 0 : 0)} left)`]) },
      { k: 'vels', label: `Velocities (${uLbl('vel')})`, type: 'textarea', ph: 'e.g. 812 818 809 815 811 — paste from your chrono' },
      { k: 'shots', label: 'Shots fired', type: 'num', help: 'Leave blank to count the velocities' },
      { k: 'groupMm', label: 'Group size', type: 'u', dim: 'group', help: 'Centre-to-centre' },
      { k: 'poi', label: 'POI / clicks', ph: '0.3 mil up' },
      { k: 'pressureSigns', label: 'Pressure signs seen', type: 'check' },
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    hint: o => {
      const v = stats(parseVels(o.vels));
      const m = moa(o.groupMm, sess.distance);
      if (!v.n && !m) return '';
      return `<div class="kv card">${v.n ? `<div>Shots<b>${v.n}</b></div><div>Avg<b>${fx(v.avg, 0)}</b></div><div>ES<b>${fx(v.es, 0)}</b></div><div>SD<b>${fx(v.sd, 1)}</b></div>` : ''}${m ? `<div>Group<b>${fx(m, 2)} MOA</b></div><div>&nbsp;<b>${fx(mil(o.groupMm, sess.distance), 2)} mil</b></div>` : ''}</div>`;
    },
    onSave: o => {
      const nv = parseVels(o.vels).length;
      if (o.shots == null) o.shots = nv;
      if (!o.shots) return 'Enter shots fired or velocities.';
      const b = get('batches', o.batchId);
      const left = (+b.qty || 0) - batchFired(b.id, st && st.id);
      if (o.shots > left) return `Only ${left} rounds left in that batch.`;
      o.velUnit = uCur('vel');
      if (st) Object.assign(st, o); else sess.strings.push({ id: uid(), created: Date.now(), ...o });
    },
    onDelete: st && (() => { sess.strings = sess.strings.filter(x => x.id !== st.id); })
  });
}
function ladderForm() {
  if (needComponents()) return;
  openForm({
    title: 'Ladder / test series planner', saveLabel: 'Create loads',
    intro: `<div class="alert">Creates one load per step. Start low and work up from data in your load manual — every step is checked against the manual max you enter.</div>`,
    fields: [
      { k: 'tag', label: 'Series name', req: true, full: true, ph: 'e.g. 308 S365 ladder Nov' },
      { k: 'vary', label: 'Vary', type: 'select', noBlank: true, full: true, options: [['charge', 'Powder charge'], ['cbto', 'Seating depth (CBTO)']] },
      { k: 'rifleId', label: 'Rifle', type: 'select', req: true, options: opts('rifles', nRifle), full: true },
      { k: 'bulletId', label: 'Bullet', type: 'select', req: true, options: prodOpts('bullet'), full: true },
      { k: 'powderId', label: 'Powder', type: 'select', req: true, options: prodOpts('powder'), full: true },
      { k: 'primerId', label: 'Primer', type: 'select', req: true, options: prodOpts('primer') },
      { k: 'maxCharge', label: 'Manual max (gr)', type: 'num', req: true },
      { k: 'source', label: 'Data source', full: true, req: true, ph: 'Manual & page' },
      { type: 'section', label: 'Steps' },
      { k: 'start', label: 'Start value', type: 'num', req: true, help: 'gr for charge, or CBTO in ' + unitLbl() },
      { k: 'step', label: 'Step size', type: 'num', req: true, help: 'e.g. 0.3 gr, or 0.003 in / 0.08 mm' },
      { k: 'steps', label: 'Number of steps', type: 'num', req: true, def: 6 },
      { k: 'fixed', label: 'Fixed charge (gr) — seating test only', type: 'num' },
      { k: 'cbto', label: 'Fixed CBTO — charge test only', type: 'len' },
      { k: 'coal', label: 'COAL (reference)', type: 'len' },
      { type: 'section', label: 'Optional: create batches now' },
      { k: 'perStep', label: 'Rounds per step', type: 'num', ph: '0 = none' },
      { k: 'brassId', label: 'Brass lot', type: 'select', options: opts('brass', nBrass, b => !b.retired) },
      { k: 'sizing', label: 'Sizing', type: 'select', options: SIZING, noBlank: true }
    ],
    hint: o => {
      const vals = ladderValues(o); if (!vals.length) return '';
      const over = o.vary === 'charge' ? vals.filter(v => o.maxCharge != null && v > o.maxCharge + 1e-9) : (o.fixed != null && o.maxCharge != null && o.fixed > o.maxCharge ? [o.fixed] : []);
      return `<div class="card sub">Steps: ${vals.map(v => o.vary === 'charge' ? fx(v, 2) + 'gr' : fLen(v)).join(' · ')}</div>` + (over.length ? `<div class="alert bad">${over.length} step(s) over the manual max — reduce start, step or steps.</div>` : '');
    },
    onSave: o => {
      const vals = ladderValues(o);
      if (!vals.length) return 'Check start, step and number of steps (max 20).';
      if (o.vary === 'charge' && vals.some(v => v > o.maxCharge + 1e-9)) return 'Some steps are over the manual max.';
      if (o.vary === 'cbto' && o.fixed == null) return 'Enter the fixed charge for a seating test.';
      if (o.vary === 'cbto' && o.fixed > o.maxCharge) return 'Fixed charge is over the manual max.';
      if (o.perStep > 0 && !o.brassId) return 'Pick a brass lot to create batches.';
      vals.forEach((v, i) => {
        const charge = o.vary === 'charge' ? v : o.fixed;
        const cbto = o.vary === 'cbto' ? v : o.cbto;
        const l = upsert('loads', null, {
          name: `${o.tag} #${i + 1} ${o.vary === 'charge' ? fx(v, 2) + 'gr' : 'CBTO ' + fLen(v)}`,
          rifleId: o.rifleId, bulletId: o.bulletId, powderId: o.powderId, primerId: o.primerId, brassId: o.brassId,
          charge, maxCharge: o.maxCharge, cbto, coal: o.coal, source: o.source, status: 'dev', series: o.tag, seriesVar: o.vary, seriesStep: i + 1
        });
        if (o.perStep > 0) upsert('batches', null, { date: today(), qty: o.perStep, loadId: l.id, brassId: o.brassId, sizing: o.sizing, notes: 'Created by ladder planner' });
      });
      return { go: '#/series/' + encodeURIComponent(o.tag) };
    }
  });
}
function ladderValues(o) {
  if (o.start == null || !o.step || !o.steps || o.steps < 1 || o.steps > 20) return [];
  const base = o.vary === 'cbto' ? fromDisp(o.start) : o.start;
  const step = o.vary === 'cbto' ? fromDisp(o.step) : o.step;
  return Array.from({ length: Math.round(o.steps) }, (_, i) => +(base + step * i).toFixed(4));
}
/* ---------- barcode scanning ---------- */
const KINDS = {
  bullet: { col: 'bullets', qty: 'qtyBought', unit: 'bullets', tpl: ['maker', 'name', 'weight', 'diameter', 'bc'], form: (i, p) => bulletForm(i, p), namer: b => nBullet(b), label: 'Bullets' },
  powder: { col: 'powders', qty: 'grams', unit: 'g', tpl: ['maker', 'name'], form: (i, p) => powderForm(i, p), namer: p => nPowder(p), label: 'Powder' },
  primer: { col: 'primers', qty: 'qtyBought', unit: 'primers', tpl: ['maker', 'name', 'size'], form: (i, p) => primerForm(i, p), namer: p => nPrimer(p), label: 'Primers' },
  brass: { col: 'brass', qty: 'count', unit: 'cases', tpl: ['headstamp', 'calibre'], form: (i, p) => brassForm(i, p), namer: b => nBrass(b), label: 'Brass' }
};
let _scanner = null;
function loadScanLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/html5-qrcode.min.js'; s.onload = res; s.onerror = () => rej(new Error('Scanner could not load')); document.head.appendChild(s); });
}
async function stopScanner() { if (_scanner) { const s = _scanner; _scanner = null; try { await s.stop(); } catch (_) {} try { s.clear(); } catch (_) {} } }
function openScanner(onCode, kindHint) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet"><div class="sheet-h"><h3>Scan packet barcode</h3><button type="button" data-close aria-label="Close">✕</button></div>
    <div id="reader" class="reader"></div><div id="scanmsg" class="sub" style="margin:8px 0">Starting camera… hold the barcode flat, 10–20 cm away.</div>
    <form id="manualcode" class="row" style="margin:10px 0 6px"><input class="grow" name="code" inputmode="numeric" placeholder="Or type the barcode number" style="flex:1"><button class="btn" type="submit">Use</button></form></div>`;
  m.hidden = false;
  let done = false;
  const finish = async code => { if (done) return; done = true; await stopScanner(); closeModal(); onCode(String(code).trim(), kindHint); };
  $('#manualcode').onsubmit = e => { e.preventDefault(); const v = e.target.code.value.trim(); if (v) finish(v); };
  loadScanLib().then(() => {
    if (done || !$('#reader')) return;
    const F = Html5QrcodeSupportedFormats;
    _scanner = new Html5Qrcode('reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE, F.DATA_MATRIX], useBarCodeDetectorIfSupported: true, verbose: false });
    return _scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.5) }) }, code => { if (navigator.vibrate) navigator.vibrate(80); finish(code); }, () => {})
      .then(() => { const el = $('#scanmsg'); if (el) el.textContent = 'Point the camera at the barcode.'; });
  }).catch(e => { const el = $('#scanmsg'); if (el) el.innerHTML = `<span style="color:var(--warn)">Camera not available (${esc(e.message || e)}). Allow camera access, or type the number below.</span>`; });
}
function handleCode(code, kindHint) {
  const prod = S.products[code];
  if (prod && KINDS[prod.kind]) return stockInForm(code, prod);
  if (kindHint) return KINDS[kindHint].form(null, { barcode: code });
  openForm({
    title: 'New barcode', saveLabel: 'Next',
    intro: `<div class="alert">Barcode <b>${esc(code)}</b> isn't known yet. Enter the product once — next time this barcode fills everything in.</div>`,
    fields: [{ k: 'kind', label: 'What is it?', type: 'select', req: true, full: true, options: Object.entries(KINDS).map(([k, K]) => [k, K.label]) }],
    onSave: o => ({ next: () => KINDS[o.kind].form(null, { barcode: code }) })
  });
}
function stockInForm(code, prod, extra) {
  const K = KINDS[prod.kind];
  const items = S[K.col].filter(x => x.barcode === code);
  openForm({
    title: 'Stock in — ' + K.label, saveLabel: 'Add stock',
    intro: `<div class="card"><div class="ttl">${esc(K.namer({ ...prod.values, name: prod.values.name || prod.values.headstamp || '' }))}</div><div class="sub">Barcode ${esc(code)}</div></div>`,
    values: { itemId: items.length ? items[items.length - 1].id : 'new', packs: 1, packQty: prod.packQty, ...(extra || {}) },
    fields: [
      { k: 'itemId', label: 'Add to', type: 'select', noBlank: true, full: true, options: [...items.map(i => [i.id, K.namer(i) + (prod.kind !== 'powder' && i.lot ? ' · lot ' + i.lot : '')]), ['new', '+ New lot / new entry']] },
      { k: 'lot', label: 'Lot number on packet', photo: true, full: true, help: 'For powder, a different lot always becomes a new entry' },
      { k: 'packs', label: 'Number of packs', type: 'num', req: true },
      { k: 'packQty', label: `Per pack (${K.unit})`, type: 'num', req: true },
      { k: 'packPrice', label: `Price per pack (${cur()})`, type: 'num', full: true, help: 'Optional — updates the price used for cost per round' },
      ...(prod.kind === 'brass' ? [{ k: 'userLot', label: 'Your lot no. (for a new lot)', type: 'num', def: nextUserLot() }] : [])
    ],
    hint: o => o.packs && o.packQty ? `<div class="alert ok">Adds <b>${fx(o.packs * o.packQty, 0)} ${K.unit}</b>${o.itemId === 'new' ? ' as a new entry' : ''}.</div>` : '',
    onSave: o => {
      const add = o.packs * o.packQty;
      if (!(add > 0)) return 'Enter packs and pack size.';
      prod.packQty = o.packQty;
      let item = o.itemId !== 'new' ? get(K.col, o.itemId) : null;
      if (item && prod.kind !== 'brass' && o.lot && item.lot && low(o.lot) !== low(item.lot)) return `This packet is lot ${o.lot} but that entry is lot ${item.lot}. Choose "+ New lot".`;
      if (item) { item[K.qty] = (+item[K.qty] || 0) + add; item.packs = (+item.packs || 1) + o.packs; if (o.lot && !item.lot) item.lot = o.lot; if (item.status === 'finished') { item.status = 'stock'; item.finishedOn = null; } }
      else {
        item = upsert(K.col, null, { ...prod.values, barcode: code, packQty: o.packQty, packs: o.packs, lot: o.lot, status: 'stock', [K.qty]: add });
        if (prod.kind === 'brass') { item.userLot = o.userLot || nextUserLot(); item.makerLot = o.lot; item.lot = undefined; }
      }
      if (o.packPrice > 0) { item.price = o.packPrice; item.priceQty = o.packQty; }
      return { go: prod.kind === 'brass' ? '#/brasslot/' + item.id : '#/' + K.col };
    }
  });
}
/* ---------- photo reading (Anthropic API, key kept on this device only) ---------- */
async function kvGet(k) { try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (_) { try { return localStorage.getItem('rl-' + k); } catch (e) { return null; } } }
async function kvSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (_) { try { localStorage.setItem('rl-' + k, v); } catch (e) {} } }
async function aiForm() {
  const key = await kvGet('apikey');
  openForm({
    title: 'Photo reading (AI)', values: { key: key || '', model: S.settings.aiModel || 'claude-haiku-5-5' },
    intro: `<div class="card sub">Reads packet labels from a photo using your own Anthropic API key. The key is stored <b>only on this device</b> — not on GitHub and not in backups. Set a monthly spend limit in the Anthropic console. Needs signal.</div>`,
    fields: [
      { k: 'key', label: 'Anthropic API key', type: 'password', full: true, ph: 'sk-ant-…' },
      { k: 'model', label: 'Model', full: true, help: 'Default claude-haiku-5-5 (fast, cheapest). Try claude-sonnet-5-5 if labels are hard to read.' }
    ],
    onSave: async o => { await kvSet('apikey', o.key || ''); S.settings.aiModel = o.model || 'claude-haiku-5-5'; }
  });
}
function resizeImage(file, max = 1568) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => rej(new Error('Could not open the photo'));
    img.src = url;
  });
}
const AI_PROMPT = `This is a photo of a reloading component packet (bullets, powder, primers or cartridge brass). Read the label and reply with ONLY a JSON object, no other text:
{"kind":"bullet|powder|primer|brass|unknown","maker":"","name":"product/model name","weight_gr":null,"diameter":"e.g. .308","bc":"e.g. G1 0.462","primer_type":"Small Rifle|Small Rifle Magnum|Large Rifle|Large Rifle Magnum|Small Pistol|Large Pistol|Other","calibre":"for brass, e.g. .308 Win","lot":"lot/batch number exactly as printed","quantity":null,"quantity_unit":"count|g|kg|lb","barcode":"digits under the barcode if legible"}
Use null or "" for anything not visible. Do not guess lot numbers.`;
async function readPacketPhoto(file, kindHint) {
  const key = await kvGet('apikey');
  if (!key) { alert('Add your Anthropic API key first (Setup → Photo reading).'); return aiForm(); }
  const m = $('#modal');
  m.innerHTML = `<div class="sheet"><div class="sheet-h"><h3>Reading packet…</h3><button type="button" data-close>✕</button></div><div class="empty">Reading the label — a few seconds.</div></div>`; m.hidden = false;
  let d;
  try {
    const data = await resizeImage(file);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: S.settings.aiModel || 'claude-haiku-5-5', max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }, { type: 'text', text: AI_PROMPT }] }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'API key not accepted — check it under Setup → Photo reading.' : (j.error && j.error.message) || 'Request failed (' + r.status + ')');
    const txt = (j.content || []).map(c => c.text || '').join('');
    const mt = txt.match(/\{[\s\S]*\}/); if (!mt) throw new Error('Could not read the label. Try a sharper, closer photo.');
    d = JSON.parse(mt[0]);
  } catch (e) {
    if ($('#modal').hidden) return;
    m.innerHTML = `<div class="sheet"><div class="sheet-h"><h3>Couldn't read photo</h3><button type="button" data-close>✕</button></div><div class="alert bad">${esc(navigator.onLine === false ? 'No internet connection — photo reading needs signal.' : e.message)}</div></div>`;
    return;
  }
  if ($('#modal').hidden) return; // cancelled while reading
  closeModal();
  applyPhotoData(d, kindHint);
}
function applyPhotoData(d, kindHint) {
  const kind = KINDS[d.kind] ? d.kind : kindHint;
  const q = num(d.quantity), unit = String(d.quantity_unit || '').toLowerCase();
  const code = String(d.barcode || '').replace(/\D/g, '');
  const intro = `<div class="alert">Read from photo — <b>check every field</b> before saving.${d.lot ? '' : ' No lot number found — tap <b>📷 Lot</b> to photograph it.'}</div>`;
  if (code && S.products[code] && KINDS[S.products[code].kind]) return stockInForm(code, S.products[code], d.lot ? { lot: d.lot } : null);
  if (!kind) {
    return openForm({
      title: 'What is it?', saveLabel: 'Next', intro: `<div class="alert">Couldn't tell what the packet is. Read: ${esc([d.maker, d.name, d.lot && 'lot ' + d.lot].filter(Boolean).join(' · ') || 'nothing clear')}</div>`,
      fields: [{ k: 'kind', label: 'Type', type: 'select', req: true, full: true, options: Object.entries(KINDS).map(([k, K]) => [k, K.label]) }],
      onSave: o => ({ next: () => applyPhotoData({ ...d, kind: o.kind }) })
    });
  }
  const base = { _intro: intro, maker: d.maker || '', name: d.name || '', lot: d.lot || '', barcode: code };
  let p;
  if (kind === 'bullet') p = { ...base, weight: num(d.weight_gr), diameter: d.diameter || '', bc: d.bc || '', qtyBought: q, packQty: q };
  if (kind === 'primer') p = { ...base, size: PRIMER_SIZES.some(x => x[0] === d.primer_type) ? d.primer_type : '', qtyBought: q, packQty: q };
  if (kind === 'powder') { const g = q == null ? null : unit === 'kg' ? q * 1000 : unit === 'lb' ? Math.round(q * 453.59) : q; p = { ...base, grams: g, packQty: g }; }
  if (kind === 'brass') p = { _intro: intro, barcode: code, headstamp: d.maker || '', calibre: d.calibre || '', count: q, packQty: q, makerLot: d.lot || '' };
  KINDS[kind].form(null, p);
}
async function callVision(file, prompt, maxTokens) {
  const key = await kvGet('apikey');
  if (!key) throw new Error('Add your Anthropic API key first (Setup → Photo reading).');
  const data = await resizeImage(file);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: S.settings.aiModel || 'claude-haiku-5-5', max_tokens: maxTokens, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }, { type: 'text', text: prompt }] }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? 'API key not accepted — check it under Setup → Photo reading.' : (j.error && j.error.message) || 'Request failed (' + r.status + ')');
  const txt = (j.content || []).map(c => c.text || '').join('');
  const mt = txt.match(/\{[\s\S]*\}/); if (!mt) throw new Error('Could not read the photo. Try a sharper, closer shot.');
  return JSON.parse(mt[0]);
}
const LOT_PROMPT = `This photo shows the lot / batch number printed or stamped on a reloading component packet (bullets, powder, primers or brass). Reply with ONLY JSON: {"lot":"the lot or batch number exactly as printed","date":"manufacture date if printed, else empty"}. If there is no clear lot number, use "". Do not guess.`;
function lotPhoto(k) {
  const form = $('#mform'); if (!form || !form.elements[k]) return;
  const btn = form.querySelector(`[data-act="lotPhoto"][data-k="${k}"]`);
  let inp = $('#lotfile');
  if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.setAttribute('capture', 'environment'); inp.id = 'lotfile'; inp.hidden = true; document.body.appendChild(inp); }
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = ''; if (!f) return;
    const errEl = $('#ferr'); if (errEl) errEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
    try {
      const d = await callVision(f, LOT_PROMPT, 200);
      const field = $('#mform') && $('#mform').elements[k]; if (!field) return;
      if (!d.lot) throw new Error('No lot number found in that photo — try closer, with good light.');
      field.value = String(d.lot).trim();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.style.outline = '2px solid var(--ok)'; setTimeout(() => field.style.outline = '', 1500);
    } catch (e) {
      const el = $('#ferr'); if (el) el.textContent = navigator.onLine === false ? 'No internet — photo reading needs signal.' : e.message;
    } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '📷 Lot'; } }
  };
  inp.click();
}
function pickPhoto(kindHint) {
  let inp = $('#photofile');
  if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.setAttribute('capture', 'environment'); inp.id = 'photofile'; inp.hidden = true; document.body.appendChild(inp); }
  inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) readPacketPhoto(f, kindHint); };
  inp.click();
}
function settingsForm() {
  openForm({
    title: 'Settings', values: S.settings,
    fields: [
      { type: 'section', label: 'Units — choose per measurement' },
      ...Object.entries(UNITS).map(([dim, U]) => ({ k: U.key, label: U.label, type: 'select', noBlank: true, def: U.def, options: Object.entries(U.opts).map(([k, o]) => [k, o[0]]) })),
      { k: 'distance', label: 'Default distance', type: 'u', dim: 'dist' },
      { type: 'section', label: 'Default brass rules' },
      { k: 'flAfter', label: 'FL resize after N neck sizes', type: 'num' },
      { k: 'annealEvery', label: 'Anneal every N firings', type: 'num' },
      { k: 'retireAt', label: 'Retire after N firings', type: 'num' },
      { type: 'section', label: 'Cost' },
      { k: 'currency', label: 'Currency symbol', ph: 'R' },
      { k: 'brassLife', label: 'Spread brass cost over N firings', type: 'num', help: "Used when a lot has no 'retire after' rule" },
      { type: 'section', label: 'Low stock warnings' },
      { k: 'lowBullets', label: 'Bullets below', type: 'num' },
      { k: 'lowPrimers', label: 'Primers below', type: 'num' },
      { k: 'lowPowderG', label: 'Powder below (g)', type: 'num' }
    ],
    onSave: o => { Object.assign(S.settings, o); }
  });
}

/* ---------- views ---------- */
const pill = (c, t) => `<span class="pill ${c}">${esc(t)}</span>`;
const statusPill = s => s === 'proven' ? pill('ok', 'Proven') : s === 'rejected' ? pill('bad', 'Rejected') : pill('acc', 'Development');
const empty = t => `<div class="empty">${t}</div>`;
const card = (go, inner) => `<a class="card" href="${go}">${inner}</a>`;

/* ---------- velocity tests (development) & approved velocity (proven) — stored as m/s and °C ---------- */
const TEST_SLOTS = 5;
const velU = () => uLbl('vel');
function seasonOf(date) { // Southern hemisphere
  const m = +(String(date || '').slice(5, 7)); if (!m) return '';
  return m === 12 || m <= 2 ? 'Summer' : m <= 5 ? 'Autumn' : m <= 8 ? 'Winter' : 'Spring';
}
const testsOf = l => Array.isArray(l.tests) ? l.tests : [];
function testsAvg(l) { const v = testsOf(l).map(t => +t.vel).filter(x => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function velTestsForm(l) {
  const v = {}; testsOf(l).forEach((t, i) => Object.entries(t).forEach(([k, x]) => v[`t${i + 1}_${k}`] = x));
  const fields = [];
  for (let i = 1; i <= TEST_SLOTS; i++) fields.push(
    { type: 'section', label: `Test ${i}` },
    { k: `t${i}_date`, label: 'Date', type: 'date', noDefault: true },
    { k: `t${i}_season`, label: 'Time of year', ph: 'auto from date' },
    { k: `t${i}_vel`, label: 'Speed', type: 'u', dim: 'vel' },
    { k: `t${i}_ammoTemp`, label: 'Ammo / powder temp', type: 'u', dim: 'temp' },
    { k: `t${i}_airTemp`, label: 'Air temp', type: 'u', dim: 'temp' },
    { k: `t${i}_humidity`, label: 'Humidity (%)', type: 'num' });
  openForm({
    title: 'Velocity tests — ' + nLoad(l), values: v, fields,
    intro: `<div class="card sub">Up to ${TEST_SLOTS} tests while developing this load. Speed = average of that test's string. Time of year fills in from the date.</div>`,
    hint: o => { const vs = []; for (let i = 1; i <= TEST_SLOTS; i++) if (o[`t${i}_vel`] > 0) vs.push(toU('vel', o[`t${i}_vel`])); if (!vs.length) return ''; const s = stats(vs); return `<div class="card kv"><div>Tests<b>${s.n}</b></div><div>Average<b>${fx(s.avg, 0)} ${velU()}</b></div><div>Spread<b>${fx(s.es, 0)}</b></div></div>`; },
    onSave: o => {
      const tests = [];
      for (let i = 1; i <= TEST_SLOTS; i++) {
        const t = {}; ['date', 'season', 'vel', 'ammoTemp', 'airTemp', 'humidity'].forEach(k => { const x = o[`t${i}_${k}`]; if (x != null && x !== '') t[k] = x; });
        if (!Object.keys(t).length) continue;
        if (!t.season && t.date) t.season = seasonOf(t.date);
        tests.push(t);
      }
      l.tests = tests;
    }
  });
}
function approvedVelForm(l) {
  const avg = testsAvg(l);
  openForm({
    title: 'Approved velocity — ' + nLoad(l),
    values: { provenVel: l.provenVel ?? avg, provenTemp: l.provenTemp, provenDate: l.provenDate },
    intro: avg != null && l.provenVel == null ? `<div class="alert ok">Filled in from the average of your ${testsOf(l).length} development test(s) — change if needed.</div>` : '',
    fields: [
      { k: 'provenVel', label: 'Average speed', type: 'u', dim: 'vel', req: true },
      { k: 'provenTemp', label: 'Measured at temperature', type: 'u', dim: 'temp', req: true },
      { k: 'provenDate', label: 'Date measured', type: 'date', noDefault: true }
    ],
    onSave: o => { Object.assign(l, o); }
  });
}
function velSection(l) {
  const tests = testsOf(l);
  const approved = `<h2>Approved velocity</h2>${l.provenVel != null
    ? `<div class="card kv" style="margin-top:0" data-act="approvedVel" data-id="${l.id}"><div>Average speed<b>${fU('vel', l.provenVel)}</b></div><div>At temperature<b>${fU('temp', l.provenTemp)}</b></div><div>Date<b>${esc(l.provenDate || '–')}</b></div></div>`
    : empty('Not recorded yet.')}<div class="btns"><button class="btn${l.status === 'proven' ? ' pri' : ''}" data-act="approvedVel" data-id="${l.id}">${l.provenVel != null ? 'Edit' : 'Record'} approved velocity</button></div>`;
  const devTable = `<h2>Velocity tests (${tests.length}/${TEST_SLOTS})</h2>${tests.length ? `<div class="tblwrap"><table><tr><th>#</th><th>Date</th><th>Season</th><th>Speed ${velU()}</th><th>Ammo ${uLbl('temp')}</th><th>Air ${uLbl('temp')}</th><th>Hum %</th></tr>${tests.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.date || '')}</td><td>${esc(t.season || '')}</td><td>${fU('vel', t.vel, false)}</td><td>${t.ammoTemp != null ? fU('temp', t.ammoTemp, false) : ''}</td><td>${t.airTemp != null ? fU('temp', t.airTemp, false) : ''}</td><td>${t.humidity ?? ''}</td></tr>`).join('')}<tr><td></td><td colspan="2"><b>Average</b></td><td><b>${fU('vel', testsAvg(l), false)}</b></td><td colspan="3"></td></tr></table></div>` : empty('No tests recorded yet.')}<div class="btns"><button class="btn${l.status !== 'proven' ? ' pri' : ''}" data-act="velTests" data-id="${l.id}">${tests.length ? 'Edit' : 'Enter'} velocity tests</button></div>`;
  return l.status === 'proven' ? approved + (tests.length ? devTable : '') : devTable + (l.provenVel != null ? approved : '');
}
function loadCard(l) {
  const s = loadSummary(l.id);
  return card('#/load/' + l.id, `<div class="row"><div class="grow ttl">${esc(nLoad(l))}</div>${statusPill(l.status)}</div>
    <div class="sub">${esc(nRifle(get('rifles', l.rifleId)))} · ${esc(nBullet(get('bullets', l.bulletId)))}</div>
    <div class="kv"><div>Charge<b>${fx(l.charge, 2)} gr</b></div><div>CBTO<b>${fLen(l.cbto)}</b></div><div>${l.provenVel != null ? 'Approved speed' : 'Avg vel / SD'}<b>${l.provenVel != null ? fU('vel', l.provenVel) + (l.provenTemp != null ? ' @ ' + fU('temp', l.provenTemp) : '') : s.n ? fx(s.avg, 0) + ' / ' + fx(s.sd, 1) : testsAvg(l) != null ? fU('vel', testsAvg(l)) + ' (tests)' : '–'}</b></div><div>Best group<b>${s.bestMoa ? fx(s.bestMoa, 2) + ' MOA' : '–'}</b></div><div>Cost / round<b>${money(roundCost(l)?.total)}</b></div></div>`);
}

const views = {
  home() {
    const alerts = [];
    S.brass.filter(b => !b.retired).forEach(b => brassState(b).alerts.forEach(([c, t]) => alerts.push(`<a class="alert ${c}" style="display:block;color:inherit;text-decoration:none" href="#/brasslot/${b.id}"><b>${esc(brassTitle(b))}</b> — ${esc(t)}</a>`)));
    const st = S.settings;
    [['bullet', st.lowBullets, ' bullets'], ['primer', st.lowPrimers, ' primers'], ['powder', st.lowPowderG, ' g']].forEach(([kind, lim, unit]) => {
      const seen = new Set();
      S[KIND_COL[kind]].filter(x => !isFinished(x)).forEach(x => {
        const k = pkey(kind, x); if (seen.has(k)) return; seen.add(k);
        const grp = sameProduct(kind, x).filter(y => !isFinished(y));
        const bought = grp.reduce((t, y) => t + (+y[QTY_KEY[kind]] || 0), 0), left = grp.reduce((t, y) => t + Math.max(0, compLeft(kind, y)), 0);
        if (bought > 0 && left < (lim ?? 0)) alerts.push(`<a class="alert" style="display:block;color:inherit;text-decoration:none" href="#/${KIND_COL[kind]}">Low stock: ${esc(lotLabel(kind, { ...x, lot: '' }))} — ${fx(left, 0)}${unit} left</a>`);
      });
      S[KIND_COL[kind]].filter(x => x.status === 'open' && compLeft(kind, x) <= (kind === 'powder' ? 5 : 0)).forEach(x => alerts.push(`<a class="alert" style="display:block;color:inherit;text-decoration:none" href="#/${KIND_COL[kind]}">${esc(lotLabel(kind, x))} looks used up — open it and set Status to Finished.</a>`));
    });
    const ready = S.batches.filter(b => batchLeft(b) > 0).sort(byDate).reverse();
    const recent = [...S.sessions].sort(byDate).reverse().slice(0, 3);
    const first = !S.rifles.length;
    return `
      ${first ? `<div class="card"><div class="ttl">Welcome</div><div class="sub" style="margin:6px 0 10px">Start by adding your rifle, then your bullets, powder, primers and brass lots. Then create load recipes, load batches and record them at the range.</div><a class="btn pri" href="#/setup" style="display:inline-block;text-decoration:none">Go to Setup</a></div>` : ''}
      <div class="btns"><button class="btn pri" data-act="newBatch">+ Load a batch</button><button class="btn pri" data-act="newSession">+ Range session</button></div>
      <h2>Alerts</h2>${alerts.join('') || empty('Nothing due — brass and stock are fine.')}
      <h2>Loaded ammo ready</h2>${ready.map(b => card('#/batch/' + b.id, `<div class="row"><div class="grow"><div class="ttl">${esc(nLoad(get('loads', b.loadId)))}</div><div class="sub">${esc(b.date)} · ${esc(nBrass(get('brass', b.brassId)))}</div></div><div class="ttl">${batchLeft(b)}</div></div>`)).join('') || empty('No loaded rounds.')}
      <h2>Recent range sessions</h2>${recent.map(sessionCard).join('') || empty('No sessions yet.')}`;
  },
  loads(q) {
    const rf = q.rifle || '';
    const list = S.loads.filter(l => !rf || l.rifleId === rf);
    const series = [...new Set(list.map(l => l.series).filter(Boolean))].sort(nat);
    const grp = k => list.filter(l => (l.status || 'dev') === k).sort(SORTS.loads);
    return `<div class="btns"><button class="btn pri" data-act="newLoad">+ New load</button><button class="btn" data-act="ladder">Ladder planner</button></div>
      ${S.rifles.length > 1 ? `<select class="filter" data-filter="rifle"><option value="">All rifles</option>${S.rifles.map(r => `<option value="${r.id}"${r.id === rf ? ' selected' : ''}>${esc(nRifle(r))}</option>`).join('')}</select>` : ''}
      ${series.length ? `<h2>Test series</h2>${series.map(t => card('#/series/' + encodeURIComponent(t), `<div class="row"><div class="grow ttl">${esc(t)}</div><span class="sub">${list.filter(l => l.series === t).length} loads ›</span></div>`)).join('')}` : ''}
      ${STATUS.map(([k, lbl]) => { const g = grp(k); return g.length ? `<h2>${lbl}</h2>${g.map(loadCard).join('')}` : ''; }).join('') || empty('No load recipes yet.')}`;
  },
  load(q, id) {
    const l = get('loads', id); if (!l) return empty('Load not found.');
    const s = loadSummary(l.id);
    const strs = loadStrings(l.id).sort((a, b) => byDate(a.session, b.session));
    const batches = S.batches.filter(b => b.loadId === l.id).sort(byDate).reverse();
    return `<div class="card"><div class="row"><div class="grow ttl">${esc(nLoad(l))}</div>${statusPill(l.status)}</div>
      <div class="kv">
        <div>Rifle<b>${esc(nRifle(get('rifles', l.rifleId)))}</b></div><div>Bullet<b>${esc(nBullet(get('bullets', l.bulletId)))}</b></div>
        <div>Powder<b>${esc(nPowder(get('powders', l.powderId)))}</b></div><div>Charge<b>${fx(l.charge, 2)} gr</b></div>
        <div>Manual max<b>${l.maxCharge != null ? fx(l.maxCharge, 2) + ' gr' : '–'}</b></div><div>Primer<b>${esc(nPrimer(get('primers', l.primerId)))}</b></div>
        <div>COAL<b>${fLen(l.coal)}</b></div><div>CBTO<b>${fLen(l.cbto)}</b></div><div>Jump<b>${fLen(l.jump)}</b></div>
        <div>Neck tension<b>${esc(l.neckTension || '–')}</b></div><div>Brass<b>${esc(l.brassId ? nBrass(get('brass', l.brassId)) : '–')}</b></div><div>Source<b>${esc(l.source || '–')}</b></div>
      </div>${l.notes ? `<div class="note">${esc(l.notes)}</div>` : ''}</div>
      ${l.maxCharge == null ? '<div class="alert">No manual max recorded for this load.</div>' : ''}
      <div class="btns"><button class="btn pri" data-act="newBatch" data-load="${l.id}">+ Load a batch</button><button class="btn" data-act="editLoad" data-id="${l.id}">Edit</button><button class="btn" data-act="copyLoad" data-id="${l.id}">Copy &amp; tweak</button></div>
      ${l.series ? `<a class="card" href="#/series/${encodeURIComponent(l.series)}"><span class="sub">Part of test series</span> <b>${esc(l.series)}</b> ›</a>` : ''}
      ${velSection(l)}
      <h2>Cost per round (current prices)</h2>${costBreakdown(roundCost(l))}
      <h2>Performance</h2>
      <div class="card kv" style="margin-top:0"><div>Shots<b>${s.shots}</b></div><div>Avg vel<b>${fx(s.avg, 0)}</b></div><div>ES (all)<b>${fx(s.es, 0)}</b></div><div>SD (all)<b>${fx(s.sd, 1)}</b></div><div>Best group<b>${s.bestMoa ? fx(s.bestMoa, 2) + ' MOA' : '–'}</b></div><div>Avg group<b>${s.avgMoa ? fx(s.avgMoa, 2) + ' MOA' : '–'}</b></div></div>
      ${strs.length ? `<div class="tblwrap"><table><tr><th>Date</th><th>Dist</th><th>Shots</th><th>Avg</th><th>ES</th><th>SD</th><th>Group</th><th>MOA</th></tr>${strs.map(st => { const v = stats(stringVels(st)); return `<tr data-go="#/session/${st.session.id}"><td>${esc(st.session.date)}</td><td>${fU('dist', st.session.distance)}</td><td>${st.shots}</td><td>${fx(v.avg, 0)}</td><td>${fx(v.es, 0)}</td><td>${fx(v.sd, 1)}</td><td>${st.groupMm ? fU('group', st.groupMm) : '–'}</td><td>${fx(moa(st.groupMm, st.session.distance), 2)}${st.pressureSigns ? ' ⚠' : ''}</td></tr>`; }).join('')}</table></div>` : empty('Not shot yet.')}
      <h2>Batches</h2>${batches.map(batchCard).join('') || empty('No batches loaded.')}`;
  },
  series(q, tag) {
    tag = decodeURIComponent(tag);
    const list = S.loads.filter(l => l.series === tag);
    if (!list.length) return empty('Series not found.');
    const vary = list[0].seriesVar || 'charge';
    list.sort((a, b) => (vary === 'cbto' ? (a.cbto || 0) - (b.cbto || 0) : (a.charge || 0) - (b.charge || 0)));
    const rows = list.map(l => ({ l, s: loadSummary(l.id), x: vary === 'cbto' ? l.cbto : l.charge }));
    const xl = v => vary === 'cbto' ? (inch() ? (v / 25.4).toFixed(3) : fx(v, 2)) : fx(v, 1);
    const velPts = rows.filter(r => r.s.n && r.x != null).map(r => ({ x: r.x, y: r.s.avg, e: r.s.sd }));
    const grpPts = rows.filter(r => r.s.avgMoa && r.x != null).map(r => ({ x: r.x, y: r.s.avgMoa }));
    const xt = vary === 'cbto' ? `CBTO (${unitLbl()})` : 'Charge (gr)';
    return `<div class="card"><div class="ttl">${esc(tag)}</div><div class="sub">${list.length} loads · varying ${vary === 'cbto' ? 'seating depth' : 'powder charge'}</div></div>
      <h2>Velocity</h2>${velPts.length ? chart(velPts, xt, 'Avg velocity', xl, true) : empty('Shoot the series to see velocity.')}
      <h2>Group size</h2>${grpPts.length ? chart(grpPts, xt, 'Avg group (MOA)', xl) : empty('Record group sizes to see this chart.')}
      <div class="tblwrap"><table><tr><th>#</th><th>${vary === 'cbto' ? 'CBTO' : 'Charge'}</th><th>Shots</th><th>Avg</th><th>ES</th><th>SD</th><th>MOA</th><th></th></tr>
      ${rows.map(r => `<tr data-go="#/load/${r.l.id}"><td>${r.l.seriesStep || ''}</td><td>${vary === 'cbto' ? fLen(r.x) : fx(r.x, 2) + 'gr'}</td><td>${r.s.shots}</td><td>${fx(r.s.avg, 0)}</td><td>${fx(r.s.es, 0)}</td><td>${fx(r.s.sd, 1)}</td><td>${fx(r.s.avgMoa, 2)}</td><td>${r.l.status === 'proven' ? '✓' : ''}</td></tr>`).join('')}</table></div>
      <div class="sub">Look for a flat spot in velocity (a node) with small groups. Tap a load to mark it Proven or Rejected.</div>`;
  },
  batches() {
    const list = [...S.batches].sort(byDate).reverse();
    const ready = list.filter(b => batchLeft(b) > 0), done = list.filter(b => batchLeft(b) <= 0);
    return `<div class="btns"><button class="btn pri" data-act="newBatch">+ Load a batch</button><a class="btn" href="#/sheet" style="text-decoration:none;text-align:center">📋 Loading log sheet</a></div>
      <h2>Loaded (${ready.reduce((a, b) => a + batchLeft(b), 0)} rounds)</h2>${ready.map(batchCard).join('') || empty('No loaded rounds.')}
      <h2>Fired</h2>${done.map(batchCard).join('') || empty('None yet.')}`;
  },
  sheet(q) {
    const rf = q.sheetRifle || '';
    const rows = S.batches.map(b => ({ b, l: get('loads', b.loadId) || {} })).filter(x => !rf || x.l.rifleId === rf).sort((x, y) => byDate(y.b, x.b));
    const sum = keyFn => {
      const m = new Map();
      rows.forEach(({ b, l }) => { const k = keyFn(b, l); const e = m.get(k) || { loaded: 0, fired: 0, batches: 0, last: '' }; e.loaded += +b.qty || 0; e.fired += batchFired(b.id); e.batches++; if ((b.date || '') > e.last) e.last = b.date; m.set(k, e); });
      return [...m.entries()].sort((a, b) => nat(a[0], b[0]));
    };
    const tot = (title, list) => `<h2>${title}</h2>${list.length ? `<div class="tblwrap"><table><tr><th></th><th>Loaded</th><th>Fired</th><th>Left</th><th>Batches</th><th>Last</th></tr>${list.map(([k, e]) => `<tr><td style="white-space:normal">${esc(k)}</td><td>${e.loaded}</td><td>${e.fired}</td><td><b>${e.loaded - e.fired}</b></td><td>${e.batches}</td><td>${esc(e.last)}</td></tr>`).join('')}</table></div>` : empty('Nothing loaded yet.')}`;
    const all = rows.reduce((a, { b }) => a + (+b.qty || 0), 0), left = rows.reduce((a, { b }) => a + Math.max(0, batchLeft(b)), 0);
    return `<select class="filter" data-filter="sheetRifle"><option value="">All rifles</option>${S.rifles.map(r => `<option value="${r.id}"${r.id === rf ? ' selected' : ''}>${esc(nRifle(r))}</option>`).join('')}</select>
      <div class="btns"><button class="btn pri" data-act="newBatch" data-rifle="${esc(rf)}">+ Load a batch${rf ? ' for this rifle' : ''}</button><button class="btn" data-act="sheetCsv">Export CSV</button></div>
      <div class="card kv" style="margin-top:0"><div>Total loaded<b>${all}</b></div><div>Fired<b>${all - left}</b></div><div>Loaded &amp; ready<b>${left}</b></div><div>Batches<b>${rows.length}</b></div></div>
      ${tot('Totals by load', sum((b, l) => nLoad(l) + (rf ? '' : ' · ' + ((get('rifles', l.rifleId) || {}).name || ''))))}
      ${tot('Totals by bullet', sum((b, l) => nBullet(get('bullets', l.bulletId))))}
      <h2>Loading log</h2>${rows.length ? `<div class="tblwrap"><table><tr><th>Date</th><th>Batch</th>${rf ? '' : '<th>Rifle</th>'}<th>Load</th><th>Bullet</th><th>Charge</th><th>Qty</th><th>Left</th><th>Brass</th></tr>${rows.map(({ b, l }) => `<tr data-go="#/batch/${b.id}"><td>${esc(b.date)}</td><td>${esc(b.no || '')}</td>${rf ? '' : `<td>${esc((get('rifles', l.rifleId) || {}).name || '')}</td>`}<td>${esc(nLoad(l))}</td><td>${esc(nBullet(get('bullets', l.bulletId)))}</td><td>${fx(l.charge, 1)}gr</td><td>${b.qty}</td><td>${batchLeft(b)}</td><td>${esc(brassTitle(get('brass', b.brassId)))}</td></tr>`).join('')}</table></div>` : empty('No batches loaded yet.')}`;
  },
  batch(q, id) {
    const b = get('batches', id); if (!b) return empty('Batch not found.');
    const l = get('loads', b.loadId);
    const strs = allStrings().filter(s => s.batchId === b.id);
    return `<div class="card"><div class="ttl">${esc(nLoad(l))}</div><div class="sub">Batch <b>${esc(b.no || '–')}</b> · loaded ${esc(b.date)}</div>
      <div class="kv"><div>Loaded<b>${b.qty}</b></div><div>Fired<b>${batchFired(b.id)}</b></div><div>Left<b>${batchLeft(b)}</b></div>
      <div>Brass lot<b>${esc(nBrass(get('brass', b.brassId)))}</b></div><div>Sizing<b>${esc((SIZING.find(s => s[0] === b.sizing) || [, '–'])[1])}</b></div>
      <div>Annealed<b>${b.annealed ? 'Yes' : 'No'}</b></div><div>Trimmed<b>${b.trimmed ? 'Yes' : 'No'}</b></div><div>Case length<b>${fLen(b.measuredLen)}</b></div><div>Bump<b>${esc(b.bump || '–')}</b></div>
      ${['bullet', 'powder', 'primer'].map(k => `<div>${k[0].toUpperCase() + k.slice(1)} lot<b>${esc((x => x ? (x.lot || 'no lot no.') : '–')(lotOf(k, b, l)))}</b></div>`).join('')}</div>
      ${b.notes ? `<div class="note">${esc(b.notes)}</div>` : ''}</div>
      <div class="btns"><a class="btn" href="#/load/${b.loadId}" style="text-decoration:none;text-align:center">View load</a><button class="btn" data-act="editBatch" data-id="${b.id}">Edit</button></div>
      <h2>Cost</h2>${(c => costBreakdown(c, c && c.total != null ? `<div>Whole batch<b>${money(c.total * (+b.qty || 0))}</b></div><div>Fired so far<b>${money(c.total * batchFired(b.id))}</b></div>` : ''))(batchCost(b))}
      <h2>Shot at the range</h2>${strs.map(st => card('#/session/' + st.session.id, `<div class="ttl">${esc(st.session.date)} · ${fU('dist', st.session.distance)}</div><div class="sub">${st.shots} shots${st.groupMm ? ` · ${fx(moa(st.groupMm, st.session.distance), 2)} MOA` : ''}</div>`)).join('') || empty('Not fired yet.')}`;
  },
  range() {
    return `<div class="btns"><button class="btn pri" data-act="newSession">+ New range session</button></div>
      ${[...S.sessions].sort(byDate).reverse().map(sessionCard).join('') || empty('No range sessions yet.')}`;
  },
  session(q, id) {
    const s = get('sessions', id); if (!s) return empty('Session not found.');
    return `<div class="card"><div class="ttl">${esc(s.date)} · ${esc(nRifle(get('rifles', s.rifleId)))}</div><div class="sub">${esc(s.location || '')}</div>
      <div class="kv"><div>Distance<b>${fU('dist', s.distance)}</b></div><div>Temp<b>${fU('temp', s.tempC)}</b></div><div>Pressure<b>${fU('press', s.pressure)}</b></div><div>Humidity<b>${s.humidity != null ? s.humidity + '%' : '–'}</b></div><div>Altitude<b>${fU('alt', s.altitude)}</b></div><div>Wind<b>${esc(s.wind || '–')}</b></div></div>
      ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ''}</div>
      <div class="btns"><button class="btn pri" data-act="newString" data-id="${s.id}">+ Record string / group</button><button class="btn" data-act="editSession" data-id="${s.id}">Edit session</button></div>
      <h2>Strings</h2>${s.strings.map(st => {
        const v = stats(stringVels(st)); const b = get('batches', st.batchId);
        return `<div class="card" data-act="editString" data-id="${s.id}" data-sid="${st.id}" style="cursor:pointer"><div class="row"><div class="grow ttl">${esc(nLoad(get('loads', b && b.loadId)))}</div>${st.pressureSigns ? pill('bad', 'Pressure signs') : ''}</div>
        <div class="kv"><div>Shots<b>${st.shots}</b></div><div>Avg<b>${fx(v.avg, 0)} ${v.n ? uLbl('vel') : ''}</b></div><div>ES<b>${fx(v.es, 0)}</b></div><div>SD<b>${fx(v.sd, 1)}</b></div><div>Group<b>${st.groupMm ? fU('group', st.groupMm) : '–'}</b></div><div>MOA / mil<b>${st.groupMm ? fx(moa(st.groupMm, s.distance), 2) + ' / ' + fx(mil(st.groupMm, s.distance), 2) : '–'}</b></div></div>
        ${st.poi ? `<div class="sub">POI: ${esc(st.poi)}</div>` : ''}${st.notes ? `<div class="note">${esc(st.notes)}</div>` : ''}</div>`;
      }).join('') || empty('No strings recorded yet.')}`;
  },
  brass() {
    const act = S.brass.filter(b => !b.retired), ret = S.brass.filter(b => b.retired);
    const cals = [...new Set(act.map(b => (b.calibre || 'Other').trim()))].sort((a, b) => calKey(a) - calKey(b) || nat(a, b));
    return `<div class="btns"><button class="btn pri" data-act="newBrass">+ New brass lot</button><button class="btn" data-act="scan" data-kind="brass">▦ Scan</button><button class="btn" data-act="photo" data-kind="brass">📷 Photo</button></div>
      ${cals.map(c => { const lots = act.filter(b => (b.calibre || 'Other').trim() === c).sort(SORTS.brass); return `<h2>${esc(c)} — ${lots.length} lot(s), ${lots.reduce((a, b) => a + (+b.count || 0), 0)} cases</h2>${lots.map(brassCard).join('')}`; }).join('') || empty('No brass lots yet.')}
      ${ret.length ? `<h2>Retired</h2>${ret.map(brassCard).join('')}` : ''}`;
  },
  brasslot(q, id) {
    const br = get('brass', id); if (!br) return empty('Brass lot not found.');
    const st = brassState(br);
    return `<div class="card"><div class="ttl">${esc(brassTitle(br))}</div>${br.mark ? `<div class="sub" style="color:var(--acc)">Mark: ${esc(br.mark)}</div>` : ''}<div class="sub">${esc([br.headstamp, br.calibre, br.count ? br.count + ' cases' : '', br.makerLot ? 'maker lot ' + br.makerLot : ''].filter(Boolean).join(' · '))}</div>
      <div class="kv"><div>Times fired<b>${st.firings}</b></div><div>Neck sizes since FL<b>${st.neck}${st.flAfter != null ? ' / ' + st.flAfter : ''}</b></div><div>Firings since anneal<b>${st.anneal}${st.annealEvery ? ' / ' + st.annealEvery : ''}</b></div>
      <div>Retire at<b>${st.retireAt || '–'}</b></div><div>Last length<b>${fLen(st.lastLen)}</b></div><div>Max / trim-to<b>${fLen(br.maxLen)} / ${fLen(br.trimTo)}</b></div><div>Last trimmed<b>${esc(st.lastTrim || '–')}</b></div><div>Currently loaded<b>${st.loaded}</b></div></div>
      ${br.notes ? `<div class="note">${esc(br.notes)}</div>` : ''}</div>
      ${st.alerts.map(([c, t]) => `<div class="alert ${c}">${esc(t)}</div>`).join('') || '<div class="alert ok">No brass work due for the next loading.</div>'}
      <div class="btns"><button class="btn pri" data-act="newBatch" data-brass="${br.id}">+ Load a batch</button><button class="btn" data-act="editBrass" data-id="${br.id}">Edit lot</button></div>
      <h2>Life history</h2>${st.hist.length ? `<div class="tblwrap"><table><tr><th>Date</th><th>Load</th><th>Qty</th><th>Sizing</th><th>Anneal</th><th>Trim</th><th>Length</th></tr>${[...st.hist].reverse().map(b => `<tr data-go="#/batch/${b.id}"><td>${esc(b.date)}</td><td>${esc(nLoad(get('loads', b.loadId)))}</td><td>${b.qty}</td><td>${esc(b.sizing === 'fl' ? 'FL' : b.sizing === 'bump' ? 'FL+bump' : b.sizing === 'neck' ? 'Neck' : '–')}</td><td>${b.annealed ? '✓' : ''}</td><td>${b.trimmed ? '✓' : ''}</td><td>${b.measuredLen != null ? fLen(b.measuredLen) : ''}</td></tr>`).join('')}</table></div>` : empty('Not loaded yet.')}`;
  },
  setup() {
    const it = (href, t, n) => card(href, `<div class="row"><div class="grow ttl">${t}</div><span class="sub">${n} ›</span></div>`);
    return `<div class="btns"><button class="btn pri" data-act="scan">▦ Scan barcode</button><button class="btn pri" data-act="photo">📷 Photo of packet</button></div>
      <h2>Equipment &amp; components</h2>
      ${it('#/rifles', 'Rifles', S.rifles.length)}${it('#/bullets', 'Bullets', S.bullets.length)}${it('#/powders', 'Powders', S.powders.length)}${it('#/primers', 'Primers', S.primers.length)}${it('#/brass', 'Brass lots', S.brass.length)}
      <h2>App</h2>
      <div class="btns"><button class="btn" data-act="settings">Settings, units &amp; brass rules</button><button class="btn" data-act="ai">Photo reading (AI key)</button></div>
      <h2>Backup</h2>
      <div class="card sub">Your data is stored only on this device. Export a backup regularly (save it to OneDrive/Google Drive) — and use it to move data to another phone or PC.</div>
      <div class="btns"><button class="btn pri" data-act="export">Export backup</button><button class="btn" data-act="import">Import backup</button><button class="btn" data-act="csv">Export range data (CSV)</button></div>
      <input type="file" id="importfile" accept="application/json,.json" hidden>
      <div class="disclaimer">Reload Log v${APP_VERSION}. This app records your own data — it does not supply load data. Always use published load manuals, start low, and work up watching for pressure signs.</div>`;
  },
  rifles() {
    return `<div class="btns"><button class="btn pri" data-act="newRifle">+ New rifle</button></div>${S.rifles.map(r => `<div class="card" data-act="editRifle" data-id="${r.id}" style="cursor:pointer"><div class="ttl">${esc(r.name)}</div><div class="sub">${esc([r.calibre, r.twist && 'twist ' + r.twist, r.barrelLen != null ? fU('barrel', r.barrelLen) + ' barrel' : r.barrel, r.optic].filter(Boolean).join(' · '))}</div><div class="kv"><div>Round count<b>${rifleRounds(r)}</b></div><div>Loads<b>${S.loads.filter(l => l.rifleId === r.id).length}</b></div></div></div>`).join('') || empty('No rifles yet.')}`;
  },
  bullets() { return compListView('bullet', 'editBullet', 'newBullet', b => [b.diameter, b.bc, unitPrice(b) != null && money(unitPrice(b)) + ' each'], ''); },
  powders() { return compListView('powder', 'editPowder', 'newPowder', p => [unitPrice(p) != null && money(unitPrice(p) * 1000) + ' per kg'], ' g'); },
  primers() { return compListView('primer', 'editPrimer', 'newPrimer', p => [p.size, unitPrice(p) != null && money(unitPrice(p)) + ' each'], ''); }
};
function stockCard(act, id, title, sub, left, total, unit, badge) {
  const pct = total ? Math.max(0, Math.min(100, left / total * 100)) : 0;
  return `<div class="card" data-act="${act}" data-id="${id}" style="cursor:pointer"><div class="row"><div class="grow"><div class="ttl">${esc(title)} ${badge || ''}</div><div class="sub">${esc(sub.filter(Boolean).join(' · '))}</div></div><div class="ttl mono">${fx(left, 0)}${unit}</div></div>${total ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="sub">of ${fx(total, 0)}${unit} bought</div>` : ''}</div>`;
}
function batchCard(b) {
  const left = batchLeft(b);
  return card('#/batch/' + b.id, `<div class="row"><div class="grow"><div class="ttl">${esc(nLoad(get('loads', b.loadId)))}</div><div class="sub">${b.no ? esc(b.no) + ' · ' : ''}${esc(b.date)} · ${esc(nBrass(get('brass', b.brassId)))}${b.annealed ? ' · annealed' : ''}${(c => c && c.total != null ? ' · ' + money(c.total) + '/rd' : '')(batchCost(b))}</div></div><div style="text-align:right"><div class="ttl">${left}/${b.qty}</div><div class="sub">left</div></div></div>`);
}
function sessionCard(s) {
  const shots = s.strings.reduce((a, st) => a + (+st.shots || 0), 0);
  return card('#/session/' + s.id, `<div class="ttl">${esc(s.date)} · ${esc(nRifle(get('rifles', s.rifleId)))}</div><div class="sub">${esc(s.location || '')} ${fU('dist', s.distance)} · ${s.strings.length} string(s), ${shots} shots</div>`);
}
function brassCard(b) {
  const st = brassState(b);
  return card('#/brasslot/' + b.id, `<div class="ttl">${esc(brassTitle(b))}${b.count ? ` <span class="sub">· ${b.count} cases</span>` : ''}</div>${b.mark || b.makerLot ? `<div class="sub" style="color:var(--acc)">${esc([b.mark && 'Mark: ' + b.mark, b.makerLot && "Maker's lot " + b.makerLot].filter(Boolean).join(' · '))}</div>` : ''}${unitPrice(b) != null ? `<div class="sub">${money(unitPrice(b))}/case · ${money(unitPrice(b) / brassLife(b))} per firing</div>` : ''}<div class="sub">Fired ${st.firings}× · ${st.neck} neck since FL · ${st.anneal} since anneal${st.loaded ? ` · ${st.loaded} loaded` : ''}</div><div style="margin-top:6px">${st.alerts.map(([c, t]) => pill(c, t.split(' (')[0].split(':')[0])).join(' ') || pill('ok', 'Nothing due')}</div>`);
}
function chart(pts, xt, yt, xl, withErr) {
  const W = 340, H = 200, L = 46, R = 10, T = 12, B = 34;
  const xs = pts.map(p => p.x), ys = pts.flatMap(p => withErr && p.e ? [p.y - p.e, p.y + p.e] : [p.y]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x0 === x1) { x0 -= 1; x1 += 1; } if (y0 === y1) { y0 -= 1; y1 += 1; }
  const py = (y1 - y0) * 0.1; y0 -= py; y1 += py;
  const X = x => L + (x - x0) / (x1 - x0) * (W - L - R), Y = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const yt4 = [0, 1, 2, 3].map(i => y0 + (y1 - y0) * i / 3);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yt)} by ${esc(xt)}">
    ${yt4.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#333b44" stroke-width="1"/><text x="${L - 6}" y="${Y(v) + 4}" fill="#9aa3ad" font-size="10" text-anchor="end">${v >= 100 ? v.toFixed(0) : v.toFixed(2)}</text>`).join('')}
    ${withErr ? pts.filter(p => p.e).map(p => `<line x1="${X(p.x)}" x2="${X(p.x)}" y1="${Y(p.y - p.e)}" y2="${Y(p.y + p.e)}" stroke="#9aa3ad" stroke-width="1.5"/>`).join('') : ''}
    <path d="${line}" fill="none" stroke="#d4a24c" stroke-width="2"/>
    ${pts.map(p => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="#f0c36d"/><text x="${X(p.x)}" y="${H - B + 14}" fill="#9aa3ad" font-size="10" text-anchor="middle">${xl(p.x)}</text>`).join('')}
    <text x="${(L + W - R) / 2}" y="${H - 4}" fill="#9aa3ad" font-size="10" text-anchor="middle">${esc(xt)}${withErr ? ' · bars = ±1 SD' : ''}</text>
  </svg><div class="sub" style="padding:0 4px">${esc(yt)}</div></div>`;
}

/* ---------- CSV / backup ---------- */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function csvExport() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Rifle', 'Location', 'Distance m', 'Temp C', 'Load', 'Bullet', 'Powder', 'Charge gr', 'CBTO mm', 'Brass lot', 'Batch date', 'Shots', 'Avg vel', 'ES', 'SD', 'Vel unit', 'Group mm', 'MOA', 'Velocities', 'Notes']];
  allStrings().sort((a, b) => byDate(a.session, b.session)).forEach(st => {
    const s = st.session, b = get('batches', st.batchId) || {}, l = get('loads', b.loadId) || {}, v = stats(stringVels(st));
    rows.push([s.date, nRifle(get('rifles', s.rifleId)), s.location, s.distance, s.tempC, nLoad(l), nBullet(get('bullets', l.bulletId)), nPowder(get('powders', l.powderId)), l.charge, l.cbto, nBrass(get('brass', b.brassId)), b.date, st.shots, v.avg && v.avg.toFixed(1), v.es, v.sd && v.sd.toFixed(2), uLbl("vel"), st.groupMm, moa(st.groupMm, s.distance)?.toFixed(3), st.vels, st.notes]);
  });
  download(`reload-log-range-${today()}.csv`, rows.map(r => r.map(q).join(',')).join('\n'), 'text/csv');
}
async function importFile(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!d || typeof d !== 'object' || !COLS.every(c => Array.isArray(d[c]))) throw new Error('Not a Reload Log backup file.');
    if (!confirm(`Replace ALL data on this device with this backup?\n(${d.loads.length} loads, ${d.batches.length} batches, ${d.sessions.length} sessions)`)) return;
    S = normalise(d); await save(); render(); alert('Backup restored.');
  } catch (e) { alert('Import failed: ' + e.message); }
}

/* ---------- routing & events ---------- */
const TITLES = { sheet: 'Loading log sheet', home: 'Reload Log', loads: 'Load recipes', load: 'Load', series: 'Test series', batches: 'Batches', batch: 'Batch', range: 'Range sessions', session: 'Range session', brass: 'Brass lots', brasslot: 'Brass lot', setup: 'Setup', rifles: 'Rifles', bullets: 'Bullets', powders: 'Powders', primers: 'Primers' };
const TAB_OF = { sheet: 'batches', load: 'loads', series: 'loads', batch: 'batches', session: 'range', brasslot: 'brass', rifles: 'setup', bullets: 'setup', powders: 'setup', primers: 'setup' };
const query = {};
function route() {
  const [path] = (location.hash || '#/home').slice(2).split('?');
  const [name, id] = path.split('/');
  return { name: views[name] ? name : 'home', id };
}
function render() {
  const { name, id } = route();
  $('#title').textContent = TITLES[name];
  $('#back').hidden = !TAB_OF[name] && !['load', 'batch', 'session', 'brasslot', 'series'].includes(name);
  const tab = TAB_OF[name] || name;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  const y = render._last === location.hash ? window.scrollY : 0;
  $('#view').innerHTML = views[name](query, id);
  window.scrollTo(0, y); render._last = location.hash;
}
const ACTIONS = {
  newBatch: d => batchForm(null, { loadId: d.load || undefined, brassId: d.brass || undefined, rifleId: d.rifle || undefined }),
  editBatch: d => batchForm(get('batches', d.id)),
  velTests: d => velTestsForm(get('loads', d.id)),
  approvedVel: d => approvedVelForm(get('loads', d.id)),
  newLoad: () => loadForm(), editLoad: d => loadForm(get('loads', d.id)), copyLoad: d => loadForm(null, get('loads', d.id)),
  ladder: () => ladderForm(),
  newSession: () => sessionForm(), editSession: d => sessionForm(get('sessions', d.id)),
  newString: d => stringForm(get('sessions', d.id)),
  editString: d => { const s = get('sessions', d.id); stringForm(s, s.strings.find(x => x.id === d.sid)); },
  newBrass: () => brassForm(), editBrass: d => brassForm(get('brass', d.id)),
  newRifle: () => rifleForm(), editRifle: d => rifleForm(get('rifles', d.id)),
  newBullet: () => bulletForm(), editBullet: d => bulletForm(get('bullets', d.id)),
  newPowder: () => powderForm(), editPowder: d => powderForm(get('powders', d.id)),
  newPrimer: () => primerForm(), editPrimer: d => primerForm(get('primers', d.id)),
  settings: () => settingsForm(),
  scan: d => openScanner(handleCode, d.kind),
  photo: d => pickPhoto(d.kind),
  lotPhoto: d => lotPhoto(d.k),
  ai: () => aiForm(),
  export: () => download(`reload-log-backup-${today()}.json`, JSON.stringify({ ...S, exported: new Date().toISOString(), app: APP_VERSION }, null, 1), 'application/json'),
  import: () => $('#importfile').click(),
  csv: () => csvExport(),
  combine: async d => {
    const ids = d.ids.split(','), k = d.kind, items = ids.map(id => get(KIND_COL[k], id)).filter(Boolean);
    if (!confirm(`Combine ${items.length} entries of ${lotLabel(k, items[0])} into one? Stock, prices, recipes and batches are merged.`)) return;
    combineLots(k, ids); await save(); render();
  },
  sheetCsv: () => {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Batch', 'Rifle', 'Load', 'Bullet', 'Powder', 'Charge gr', 'Primer', 'Brass lot', 'Qty loaded', 'Fired', 'Left', 'Sizing', 'Annealed', 'Notes']];
    [...S.batches].sort(byDate).forEach(b => { const l = get('loads', b.loadId) || {}; rows.push([b.date, b.no, (get('rifles', l.rifleId) || {}).name, nLoad(l), nBullet(get('bullets', l.bulletId)), nPowder(get('powders', l.powderId)), l.charge, nPrimer(get('primers', l.primerId)), brassTitle(get('brass', b.brassId)), b.qty, batchFired(b.id), batchLeft(b), b.sizing, b.annealed ? 'yes' : '', b.notes]); });
    download(`reload-log-loading-${today()}.csv`, rows.map(r => r.map(q).join(',')).join('\n'), 'text/csv');
  }
};
document.addEventListener('click', e => {
  if (e.target.closest('[data-close]') || e.target.id === 'modal') return closeModal();
  const go = e.target.closest('[data-go]'); if (go) { location.hash = go.dataset.go; return; }
  const a = e.target.closest('[data-act]'); if (a && ACTIONS[a.dataset.act]) { e.preventDefault(); ACTIONS[a.dataset.act](a.dataset); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'importfile' && e.target.files[0]) { importFile(e.target.files[0]); e.target.value = ''; }
  if (e.target.dataset.filter) { query[e.target.dataset.filter] = e.target.value; render(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
$('#back').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/home');
window.addEventListener('hashchange', () => { closeModal(); render(); });

(async () => {
  await load();
  migrateUnits();
  numberBrass();
  sortAll();
  numberBatches();
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
