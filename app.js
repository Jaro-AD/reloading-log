'use strict';
/* Reload Log — reloading + range data, all stored on this device (IndexedDB). */

const APP_VERSION = '1.3.0';
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
async function save() {
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

/* ---------- units ---------- */
const inch = () => S.settings.lenUnit === 'in';
const unitLbl = () => inch() ? 'in' : 'mm';
const toDisp = mm => mm == null ? '' : inch() ? +(mm / 25.4).toFixed(4) : +(+mm).toFixed(3);
const fromDisp = v => inch() ? v * 25.4 : v;
const fLen = mm => mm == null ? '–' : inch() ? (mm / 25.4).toFixed(3) + '"' : (+mm).toFixed(2) + ' mm';

/* ---------- names ---------- */
const nRifle = r => r ? r.name + (r.calibre ? ` (${r.calibre})` : '') : '?';
const nBullet = b => b ? `${b.maker || ''} ${b.weight ?? ''}gr ${b.name || ''}`.trim() : '?';
const nPowder = p => p ? `${p.maker || ''} ${p.name || ''}`.trim() + (p.lot ? ` · lot ${p.lot}` : '') : '?';
const nPrimer = p => p ? `${p.maker || ''} ${p.name || ''}`.trim() : '?';
const nBrass = b => b ? b.name + (b.mark ? ` [${b.mark}]` : '') : '?';
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
    if (kind === 'bullet' && l.bulletId === id) used += q;
    if (kind === 'primer' && l.primerId === id) used += q;
    if (kind === 'powder' && l.powderId === id) used += q * (+l.charge || 0) * GR_TO_G;
  });
  return used;
}
const bulletLeft = b => (+b.qtyBought || 0) - stockUsed('bullet', b.id);
const primerLeft = p => (+p.qtyBought || 0) - stockUsed('primer', p.id);
const powderLeft = p => (+p.grams || 0) - stockUsed('powder', p.id);

/* ---------- cost ---------- */
const cur = () => S.settings.currency || 'R';
const money = (v, d = 2) => v == null || isNaN(v) ? '–' : cur() + ' ' + (+v).toFixed(d);
// Price per single unit: per bullet / primer / case, or per gram of powder.
const unitPrice = x => x && +x.price > 0 && +x.priceQty > 0 ? +x.price / +x.priceQty : null;
// Brass is reused, so its cost is spread over the lot's life (retire-at firings, else the Settings default).
const brassLife = br => rule(br, 'retireAt') || +S.settings.brassLife || 1;
function roundCost(l, brassId) {
  if (!l) return null;
  const br = get('brass', brassId || l.brassId);
  const pw = unitPrice(get('powders', l.powderId)), bc = unitPrice(br);
  const parts = {
    bullet: unitPrice(get('bullets', l.bulletId)),
    powder: pw != null ? pw * (+l.charge || 0) * GR_TO_G : null,
    primer: unitPrice(get('primers', l.primerId)),
    brass: bc != null ? bc / brassLife(br) : null
  };
  const have = Object.values(parts).filter(v => v != null);
  return { ...parts, total: have.length ? have.reduce((a, b) => a + b, 0) : null, missing: Object.keys(parts).filter(k => parts[k] == null) };
}
// Batches keep the cost from the day they were loaded, so later price changes don't rewrite history.
const batchCost = b => b.cost || roundCost(get('loads', b.loadId), b.brassId);
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
  const vels = strs.flatMap(st => parseVels(st.vels));
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
      case 'len': inp = `<input name="${fd.k}" type="number" step="any" inputmode="decimal" value="${esc(toDisp(val ?? null))}" placeholder="${esc(fd.ph || '')}">`; break;
      case 'num': inp = `<input name="${fd.k}" type="number" step="any" inputmode="decimal" value="${esc(val)}" placeholder="${esc(fd.ph || '')}">`; break;
      case 'date': inp = `<input name="${fd.k}" type="date" value="${esc(val || today())}">`; break;
      case 'password': inp = `<input name="${fd.k}" type="password" autocomplete="off" value="${esc(val)}" placeholder="${esc(fd.ph || '')}">`; break;
      default: inp = `<input name="${fd.k}" type="text" value="${esc(val)}" placeholder="${esc(fd.ph || '')}">`;
    }
    return `<label class="${cls}"><span>${esc(fd.label)}${fd.type === 'len' ? ` (${unitLbl()})` : ''}${fd.req ? ' *' : ''}</span>${inp}${fd.help ? `<small>${esc(fd.help)}</small>` : ''}</label>`;
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
    if (typeof r === 'object' && r && r.go) location.hash = r.go; else render();
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
      { k: 'barrel', label: 'Barrel length', ph: '24 in' },
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
      { k: 'lot', label: 'Lot number' },
      { k: 'qtyBought', label: 'Total bought (qty)', type: 'num', full: true, help: 'Add to this number each time you buy more (or use Scan packet). Stock left is worked out from batches loaded.' },
      ...priceFields('bullets', 100),
      ...scanFields('Bullets per box, e.g. 100'),
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => { upsert('bullets', b, o); learn('bullet', o); },
    onDelete: b && (() => inUse('loads use this bullet', S.loads.filter(l => l.bulletId === b.id).length) || remove('bullets', b.id))
  });
}
function powderForm(p, preset) {
  openForm({
    title: p ? 'Edit powder' : 'New powder', values: p || preset,
    fields: [
      { k: 'maker', label: 'Maker', req: true, ph: 'Somchem / Hodgdon' },
      { k: 'name', label: 'Powder', req: true, ph: 'S365 / Varget' },
      { k: 'lot', label: 'Lot number', full: true, help: 'Add each new powder lot separately — burn rates vary between lots.' },
      { k: 'grams', label: 'Total bought (grams)', type: 'num', full: true, help: 'e.g. 1 kg tub = 1000. Add to it when you buy more of the same lot.' },
      ...priceFields('grams', 1000),
      ...scanFields('Grams per container, e.g. 1000'),
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => { upsert('powders', p, o); learn('powder', o); },
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
      { k: 'lot', label: 'Lot number' },
      { k: 'qtyBought', label: 'Total bought (qty)', type: 'num', full: true },
      ...priceFields('primers', 100),
      ...scanFields('Primers per box, e.g. 1000'),
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    onSave: o => { upsert('primers', p, o); learn('primer', o); },
    onDelete: p && (() => inUse('loads use this primer', S.loads.filter(l => l.primerId === p.id).length) || remove('primers', p.id))
  });
}
function brassForm(br, preset) {
  const d = S.settings;
  openForm({
    title: br ? 'Edit brass lot' : 'New brass lot', values: br || preset,
    fields: [
      { k: 'name', label: 'Lot name', req: true, full: true, ph: 'e.g. Lapua 308 – Lot A' },
      { k: 'mark', label: 'Case marking / box label', full: true, ph: 'e.g. 1 red dot on head · box "308-A"', help: 'How you tell this lot apart physically — mark the case heads and label the box' },
      { k: 'headstamp', label: 'Headstamp / maker', ph: 'Lapua' },
      { k: 'calibre', label: 'Calibre', ph: '.308 Win' },
      { k: 'count', label: 'Number of cases', type: 'num' },
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
    onSave: o => { const n = upsert('brass', br, o); learn('brass', o); return br ? null : { go: '#/brasslot/' + n.id }; },
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
      { k: 'bulletId', label: 'Bullet', type: 'select', req: true, options: opts('bullets', nBullet), full: true },
      { k: 'powderId', label: 'Powder', type: 'select', req: true, options: opts('powders', nPowder), full: true },
      { k: 'primerId', label: 'Primer', type: 'select', req: true, options: opts('primers', nPrimer) },
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
  const head = `<div class="sub" style="margin-bottom:6px">${esc(br.name)}: fired ${st.firings}×, ${st.neck} neck size(s) since FL, ${st.anneal} firing(s) since anneal${st.loaded ? ` · <b>${st.loaded} still loaded</b>` : ''}</div>`;
  return head + (st.alerts.length ? st.alerts.map(([c, t]) => `<div class="alert ${c}">${esc(t)}</div>`).join('') : '<div class="alert ok">No brass work due.</div>');
}
function batchForm(b, preset) {
  if (!S.loads.length) { alert('Create a load recipe first.'); location.hash = '#/loads'; return; }
  const v = b || { date: today(), sizing: 'neck', ...(preset || {}) };
  if (!b && v.loadId && !v.brassId) { const l = get('loads', v.loadId); if (l && l.brassId) v.brassId = l.brassId; }
  openForm({
    title: b ? 'Edit batch' : 'Load a batch', values: v, hintTop: true,
    fields: [
      { k: 'date', label: 'Date loaded', type: 'date' },
      { k: 'qty', label: 'Rounds loaded', type: 'num', req: true },
      { k: 'loadId', label: 'Load recipe', type: 'select', req: true, options: opts('loads', nLoad, l => l.status !== 'rejected' || (b && b.loadId === l.id)), full: true },
      { k: 'brassId', label: 'Brass lot', type: 'select', req: true, options: opts('brass', nBrass, x => !x.retired || (b && b.brassId === x.id)), full: true },
      { type: 'section', label: 'Case prep done for this batch' },
      { k: 'sizing', label: 'Sizing', type: 'select', options: SIZING, noBlank: true, full: true },
      { k: 'annealed', label: 'Annealed', type: 'check' },
      { k: 'trimmed', label: 'Trimmed', type: 'check' },
      { k: 'measuredLen', label: 'Case length measured', type: 'len' },
      { k: 'bump', label: 'Shoulder bump', ph: '0.002"' },
      { k: 'notes', label: 'Notes', type: 'textarea' }
    ],
    hint: o => {
      let h = '';
      const l = get('loads', o.loadId);
      if (l) {
        const q = o.qty || 0;
        const bu = get('bullets', l.bulletId), pr = get('primers', l.primerId), pw = get('powders', l.powderId);
        const need = [];
        const own = b && b.loadId === l.id ? +b.qty || 0 : 0;
        if (bu && bulletLeft(bu) + (b && get('loads', b.loadId)?.bulletId === bu.id ? +b.qty || 0 : 0) < q) need.push('bullets');
        if (pr && primerLeft(pr) + (b && get('loads', b.loadId)?.primerId === pr.id ? +b.qty || 0 : 0) < q) need.push('primers');
        if (pw && powderLeft(pw) + own * (+l.charge || 0) * GR_TO_G < q * (+l.charge || 0) * GR_TO_G) need.push('powder');
        h += `<div class="card" style="margin-bottom:8px"><div class="sub">${esc(nBullet(bu))} · ${esc(nPowder(pw))} <b>${fx(l.charge, 2)}gr</b> · ${esc(nPrimer(pr))}${l.cbto != null ? ` · CBTO ${fLen(l.cbto)}` : ''}${l.coal != null ? ` · COAL ${fLen(l.coal)}` : ''}</div>${q ? `<div class="sub">Uses ${fx(q * (l.charge || 0) * GR_TO_G, 1)} g powder</div>` : ''}</div>`;
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
      if (reprice) { const c = roundCost(get('loads', n.loadId), n.brassId); if (c && c.total != null) n.cost = c; }
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
      { k: 'distance', label: 'Distance (m)', type: 'num', req: true },
      { k: 'tempC', label: 'Temp (°C)', type: 'num' },
      { k: 'pressure', label: 'Pressure (hPa)', type: 'num' },
      { k: 'humidity', label: 'Humidity (%)', type: 'num' },
      { k: 'altitude', label: 'Altitude (m)', type: 'num' },
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
    title: st ? 'Edit string' : 'Record a string / group', values: st,
    fields: [
      { k: 'batchId', label: 'Ammo batch', type: 'select', req: true, full: true, options: list.map(b => [b.id, `${nBatch(b)} (${batchLeft(b) + (st && st.batchId === b.id ? +st.shots || 0 : 0)} left)`]) },
      { k: 'vels', label: 'Velocities (m/s or fps)', type: 'textarea', ph: 'e.g. 812 818 809 815 811 — paste from your chrono' },
      { k: 'shots', label: 'Shots fired', type: 'num', help: 'Leave blank to count the velocities' },
      { k: 'groupMm', label: 'Group size (mm)', type: 'num', help: 'Centre-to-centre' },
      { k: 'velUnit', label: 'Velocity unit', type: 'select', options: [['ms', 'm/s'], ['fps', 'fps']], noBlank: true, def: S.settings.velUnit || 'ms' },
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
      S.settings.velUnit = o.velUnit;
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
      { k: 'bulletId', label: 'Bullet', type: 'select', req: true, options: opts('bullets', nBullet), full: true },
      { k: 'powderId', label: 'Powder', type: 'select', req: true, options: opts('powders', nPowder), full: true },
      { k: 'primerId', label: 'Primer', type: 'select', req: true, options: opts('primers', nPrimer) },
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
      { k: 'lot', label: 'Lot number on packet', full: true, help: 'For powder, a different lot always becomes a new entry' },
      { k: 'packs', label: 'Number of packs', type: 'num', req: true },
      { k: 'packQty', label: `Per pack (${K.unit})`, type: 'num', req: true },
      { k: 'packPrice', label: `Price per pack (${cur()})`, type: 'num', full: true, help: 'Optional — updates the price used for cost per round' },
      ...(prod.kind === 'brass' ? [{ k: 'name', label: 'Lot name (for new lot)', full: true, ph: `${prod.values.headstamp || ''} ${prod.values.calibre || ''} – Lot B`.trim() }] : [])
    ],
    hint: o => o.packs && o.packQty ? `<div class="alert ok">Adds <b>${fx(o.packs * o.packQty, 0)} ${K.unit}</b>${o.itemId === 'new' ? ' as a new entry' : ''}.</div>` : '',
    onSave: o => {
      const add = o.packs * o.packQty;
      if (!(add > 0)) return 'Enter packs and pack size.';
      prod.packQty = o.packQty;
      let item = o.itemId !== 'new' ? get(K.col, o.itemId) : null;
      if (item && prod.kind === 'powder' && o.lot && item.lot && o.lot !== item.lot) return `This tub is lot ${o.lot} but the entry is lot ${item.lot}. Choose "+ New lot".`;
      if (item) { item[K.qty] = (+item[K.qty] || 0) + add; if (o.lot && !item.lot) item.lot = o.lot; }
      else {
        item = upsert(K.col, null, { ...prod.values, barcode: code, packQty: o.packQty, lot: o.lot, [K.qty]: add });
        if (prod.kind === 'brass') item.name = o.name || `${prod.values.headstamp || 'Brass'} ${prod.values.calibre || ''} – ${o.lot || today()}`.replace(/\s+/g, ' ');
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
  const intro = `<div class="alert">Read from photo — <b>check every field</b> before saving.</div>`;
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
  if (kind === 'brass') p = { _intro: intro, barcode: code, headstamp: d.maker || '', calibre: d.calibre || '', count: q, packQty: q, name: `${d.maker || ''} ${d.calibre || ''} – Lot ${d.lot || 'A'}`.replace(/\s+/g, ' ').trim(), notes: d.lot ? 'Maker lot ' + d.lot : '' };
  KINDS[kind].form(null, p);
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
      { k: 'lenUnit', label: 'Length unit', type: 'select', noBlank: true, options: [['mm', 'Millimetres'], ['in', 'Inches']] },
      { k: 'distance', label: 'Default distance (m)', type: 'num' },
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

function loadCard(l) {
  const s = loadSummary(l.id);
  return card('#/load/' + l.id, `<div class="row"><div class="grow ttl">${esc(nLoad(l))}</div>${statusPill(l.status)}</div>
    <div class="sub">${esc(nRifle(get('rifles', l.rifleId)))} · ${esc(nBullet(get('bullets', l.bulletId)))}</div>
    <div class="kv"><div>Charge<b>${fx(l.charge, 2)} gr</b></div><div>CBTO<b>${fLen(l.cbto)}</b></div><div>Avg vel / SD<b>${s.n ? fx(s.avg, 0) + ' / ' + fx(s.sd, 1) : '–'}</b></div><div>Best group<b>${s.bestMoa ? fx(s.bestMoa, 2) + ' MOA' : '–'}</b></div><div>Cost / round<b>${money(roundCost(l)?.total)}</b></div></div>`);
}

const views = {
  home() {
    const alerts = [];
    S.brass.filter(b => !b.retired).forEach(b => brassState(b).alerts.forEach(([c, t]) => alerts.push(`<a class="alert ${c}" style="display:block;color:inherit;text-decoration:none" href="#/brasslot/${b.id}"><b>${esc(b.name)}</b> — ${esc(t)}</a>`)));
    const st = S.settings;
    S.bullets.forEach(b => { const n = bulletLeft(b); if ((+b.qtyBought || 0) > 0 && n < (st.lowBullets ?? 0)) alerts.push(`<div class="alert">${esc(nBullet(b))}: ${n} bullets left</div>`); });
    S.primers.forEach(p => { const n = primerLeft(p); if ((+p.qtyBought || 0) > 0 && n < (st.lowPrimers ?? 0)) alerts.push(`<div class="alert">${esc(nPrimer(p))}: ${n} primers left</div>`); });
    S.powders.forEach(p => { const n = powderLeft(p); if ((+p.grams || 0) > 0 && n < (st.lowPowderG ?? 0)) alerts.push(`<div class="alert">${esc(nPowder(p))}: ${fx(n, 0)} g left</div>`); });
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
    const series = [...new Set(list.map(l => l.series).filter(Boolean))];
    const grp = k => list.filter(l => (l.status || 'dev') === k).sort((a, b) => nLoad(a).localeCompare(nLoad(b)));
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
      <h2>Cost per round (current prices)</h2>${costBreakdown(roundCost(l))}
      <h2>Performance</h2>
      <div class="card kv" style="margin-top:0"><div>Shots<b>${s.shots}</b></div><div>Avg vel<b>${fx(s.avg, 0)}</b></div><div>ES (all)<b>${fx(s.es, 0)}</b></div><div>SD (all)<b>${fx(s.sd, 1)}</b></div><div>Best group<b>${s.bestMoa ? fx(s.bestMoa, 2) + ' MOA' : '–'}</b></div><div>Avg group<b>${s.avgMoa ? fx(s.avgMoa, 2) + ' MOA' : '–'}</b></div></div>
      ${strs.length ? `<div class="tblwrap"><table><tr><th>Date</th><th>Dist</th><th>Shots</th><th>Avg</th><th>ES</th><th>SD</th><th>Group</th><th>MOA</th></tr>${strs.map(st => { const v = stats(parseVels(st.vels)); return `<tr data-go="#/session/${st.session.id}"><td>${esc(st.session.date)}</td><td>${esc(st.session.distance)}m</td><td>${st.shots}</td><td>${fx(v.avg, 0)}</td><td>${fx(v.es, 0)}</td><td>${fx(v.sd, 1)}</td><td>${st.groupMm ? fx(st.groupMm, 0) + 'mm' : '–'}</td><td>${fx(moa(st.groupMm, st.session.distance), 2)}${st.pressureSigns ? ' ⚠' : ''}</td></tr>`; }).join('')}</table></div>` : empty('Not shot yet.')}
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
    return `<div class="btns"><button class="btn pri" data-act="newBatch">+ Load a batch</button></div>
      <h2>Loaded (${ready.reduce((a, b) => a + batchLeft(b), 0)} rounds)</h2>${ready.map(batchCard).join('') || empty('No loaded rounds.')}
      <h2>Fired</h2>${done.map(batchCard).join('') || empty('None yet.')}`;
  },
  batch(q, id) {
    const b = get('batches', id); if (!b) return empty('Batch not found.');
    const l = get('loads', b.loadId);
    const strs = allStrings().filter(s => s.batchId === b.id);
    return `<div class="card"><div class="ttl">${esc(nLoad(l))}</div><div class="sub">Loaded ${esc(b.date)}</div>
      <div class="kv"><div>Loaded<b>${b.qty}</b></div><div>Fired<b>${batchFired(b.id)}</b></div><div>Left<b>${batchLeft(b)}</b></div>
      <div>Brass lot<b>${esc(nBrass(get('brass', b.brassId)))}</b></div><div>Sizing<b>${esc((SIZING.find(s => s[0] === b.sizing) || [, '–'])[1])}</b></div>
      <div>Annealed<b>${b.annealed ? 'Yes' : 'No'}</b></div><div>Trimmed<b>${b.trimmed ? 'Yes' : 'No'}</b></div><div>Case length<b>${fLen(b.measuredLen)}</b></div><div>Bump<b>${esc(b.bump || '–')}</b></div></div>
      ${b.notes ? `<div class="note">${esc(b.notes)}</div>` : ''}</div>
      <div class="btns"><a class="btn" href="#/load/${b.loadId}" style="text-decoration:none;text-align:center">View load</a><button class="btn" data-act="editBatch" data-id="${b.id}">Edit</button></div>
      <h2>Cost</h2>${(c => costBreakdown(c, c && c.total != null ? `<div>Whole batch<b>${money(c.total * (+b.qty || 0))}</b></div><div>Fired so far<b>${money(c.total * batchFired(b.id))}</b></div>` : ''))(batchCost(b))}
      <h2>Shot at the range</h2>${strs.map(st => card('#/session/' + st.session.id, `<div class="ttl">${esc(st.session.date)} · ${esc(st.session.distance)}m</div><div class="sub">${st.shots} shots${st.groupMm ? ` · ${fx(moa(st.groupMm, st.session.distance), 2)} MOA` : ''}</div>`)).join('') || empty('Not fired yet.')}`;
  },
  range() {
    return `<div class="btns"><button class="btn pri" data-act="newSession">+ New range session</button></div>
      ${[...S.sessions].sort(byDate).reverse().map(sessionCard).join('') || empty('No range sessions yet.')}`;
  },
  session(q, id) {
    const s = get('sessions', id); if (!s) return empty('Session not found.');
    return `<div class="card"><div class="ttl">${esc(s.date)} · ${esc(nRifle(get('rifles', s.rifleId)))}</div><div class="sub">${esc(s.location || '')}</div>
      <div class="kv"><div>Distance<b>${esc(s.distance)} m</b></div><div>Temp<b>${s.tempC != null ? s.tempC + ' °C' : '–'}</b></div><div>Pressure<b>${s.pressure != null ? s.pressure + ' hPa' : '–'}</b></div><div>Humidity<b>${s.humidity != null ? s.humidity + '%' : '–'}</b></div><div>Altitude<b>${s.altitude != null ? s.altitude + ' m' : '–'}</b></div><div>Wind<b>${esc(s.wind || '–')}</b></div></div>
      ${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ''}</div>
      <div class="btns"><button class="btn pri" data-act="newString" data-id="${s.id}">+ Record string / group</button><button class="btn" data-act="editSession" data-id="${s.id}">Edit session</button></div>
      <h2>Strings</h2>${s.strings.map(st => {
        const v = stats(parseVels(st.vels)); const b = get('batches', st.batchId);
        return `<div class="card" data-act="editString" data-id="${s.id}" data-sid="${st.id}" style="cursor:pointer"><div class="row"><div class="grow ttl">${esc(nLoad(get('loads', b && b.loadId)))}</div>${st.pressureSigns ? pill('bad', 'Pressure signs') : ''}</div>
        <div class="kv"><div>Shots<b>${st.shots}</b></div><div>Avg<b>${fx(v.avg, 0)} ${st.velUnit === 'fps' ? 'fps' : v.n ? 'm/s' : ''}</b></div><div>ES<b>${fx(v.es, 0)}</b></div><div>SD<b>${fx(v.sd, 1)}</b></div><div>Group<b>${st.groupMm ? fx(st.groupMm, 0) + ' mm' : '–'}</b></div><div>MOA / mil<b>${st.groupMm ? fx(moa(st.groupMm, s.distance), 2) + ' / ' + fx(mil(st.groupMm, s.distance), 2) : '–'}</b></div></div>
        ${st.poi ? `<div class="sub">POI: ${esc(st.poi)}</div>` : ''}${st.notes ? `<div class="note">${esc(st.notes)}</div>` : ''}</div>`;
      }).join('') || empty('No strings recorded yet.')}`;
  },
  brass() {
    const act = S.brass.filter(b => !b.retired), ret = S.brass.filter(b => b.retired);
    const cals = [...new Set(act.map(b => (b.calibre || 'Other').trim()))].sort();
    return `<div class="btns"><button class="btn pri" data-act="newBrass">+ New brass lot</button><button class="btn" data-act="scan" data-kind="brass">▦ Scan</button><button class="btn" data-act="photo" data-kind="brass">📷 Photo</button></div>
      ${cals.map(c => { const lots = act.filter(b => (b.calibre || 'Other').trim() === c).sort((a, b) => a.name.localeCompare(b.name)); return `<h2>${esc(c)} — ${lots.length} lot(s), ${lots.reduce((a, b) => a + (+b.count || 0), 0)} cases</h2>${lots.map(brassCard).join('')}`; }).join('') || empty('No brass lots yet.')}
      ${ret.length ? `<h2>Retired</h2>${ret.map(brassCard).join('')}` : ''}`;
  },
  brasslot(q, id) {
    const br = get('brass', id); if (!br) return empty('Brass lot not found.');
    const st = brassState(br);
    return `<div class="card"><div class="ttl">${esc(br.name)}</div>${br.mark ? `<div class="sub" style="color:var(--acc)">Mark: ${esc(br.mark)}</div>` : ''}<div class="sub">${esc([br.headstamp, br.calibre, br.count ? br.count + ' cases' : ''].filter(Boolean).join(' · '))}</div>
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
      <div class="btns"><button class="btn" data-act="settings">Settings &amp; brass rules</button><button class="btn" data-act="ai">Photo reading (AI key)</button></div>
      <h2>Backup</h2>
      <div class="card sub">Your data is stored only on this device. Export a backup regularly (save it to OneDrive/Google Drive) — and use it to move data to another phone or PC.</div>
      <div class="btns"><button class="btn pri" data-act="export">Export backup</button><button class="btn" data-act="import">Import backup</button><button class="btn" data-act="csv">Export range data (CSV)</button></div>
      <input type="file" id="importfile" accept="application/json,.json" hidden>
      <div class="disclaimer">Reload Log v${APP_VERSION}. This app records your own data — it does not supply load data. Always use published load manuals, start low, and work up watching for pressure signs.</div>`;
  },
  rifles() {
    return `<div class="btns"><button class="btn pri" data-act="newRifle">+ New rifle</button></div>${S.rifles.map(r => `<div class="card" data-act="editRifle" data-id="${r.id}" style="cursor:pointer"><div class="ttl">${esc(r.name)}</div><div class="sub">${esc([r.calibre, r.twist && 'twist ' + r.twist, r.barrel, r.optic].filter(Boolean).join(' · '))}</div><div class="kv"><div>Round count<b>${rifleRounds(r)}</b></div><div>Loads<b>${S.loads.filter(l => l.rifleId === r.id).length}</b></div></div></div>`).join('') || empty('No rifles yet.')}`;
  },
  bullets() {
    return `<div class="btns"><button class="btn pri" data-act="newBullet">+ New bullet</button><button class="btn" data-act="scan" data-kind="bullet">▦ Scan</button><button class="btn" data-act="photo" data-kind="bullet">📷 Photo</button></div>${S.bullets.map(b => stockCard('editBullet', b.id, nBullet(b), [b.diameter, b.bc, b.lot && 'lot ' + b.lot, unitPrice(b) != null && money(unitPrice(b)) + ' each'], bulletLeft(b), +b.qtyBought || 0, '')).join('') || empty('No bullets yet.')}`;
  },
  powders() {
    return `<div class="btns"><button class="btn pri" data-act="newPowder">+ New powder</button><button class="btn" data-act="scan" data-kind="powder">▦ Scan</button><button class="btn" data-act="photo" data-kind="powder">📷 Photo</button></div>${S.powders.map(p => stockCard('editPowder', p.id, nPowder(p), [unitPrice(p) != null && money(unitPrice(p) * 1000) + ' per kg'], powderLeft(p), +p.grams || 0, ' g')).join('') || empty('No powders yet.')}`;
  },
  primers() {
    return `<div class="btns"><button class="btn pri" data-act="newPrimer">+ New primer</button><button class="btn" data-act="scan" data-kind="primer">▦ Scan</button><button class="btn" data-act="photo" data-kind="primer">📷 Photo</button></div>${S.primers.map(p => stockCard('editPrimer', p.id, nPrimer(p), [p.size, p.lot && 'lot ' + p.lot, unitPrice(p) != null && money(unitPrice(p)) + ' each'], primerLeft(p), +p.qtyBought || 0, '')).join('') || empty('No primers yet.')}`;
  }
};
function stockCard(act, id, title, sub, left, total, unit) {
  const pct = total ? Math.max(0, Math.min(100, left / total * 100)) : 0;
  return `<div class="card" data-act="${act}" data-id="${id}" style="cursor:pointer"><div class="row"><div class="grow"><div class="ttl">${esc(title)}</div><div class="sub">${esc(sub.filter(Boolean).join(' · '))}</div></div><div class="ttl mono">${fx(left, 0)}${unit}</div></div>${total ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="sub">of ${fx(total, 0)}${unit} bought</div>` : ''}</div>`;
}
function batchCard(b) {
  const left = batchLeft(b);
  return card('#/batch/' + b.id, `<div class="row"><div class="grow"><div class="ttl">${esc(nLoad(get('loads', b.loadId)))}</div><div class="sub">${esc(b.date)} · ${esc(nBrass(get('brass', b.brassId)))}${b.annealed ? ' · annealed' : ''}${(c => c && c.total != null ? ' · ' + money(c.total) + '/rd' : '')(batchCost(b))}</div></div><div style="text-align:right"><div class="ttl">${left}/${b.qty}</div><div class="sub">left</div></div></div>`);
}
function sessionCard(s) {
  const shots = s.strings.reduce((a, st) => a + (+st.shots || 0), 0);
  return card('#/session/' + s.id, `<div class="ttl">${esc(s.date)} · ${esc(nRifle(get('rifles', s.rifleId)))}</div><div class="sub">${esc(s.location || '')} ${esc(s.distance)}m · ${s.strings.length} string(s), ${shots} shots</div>`);
}
function brassCard(b) {
  const st = brassState(b);
  return card('#/brasslot/' + b.id, `<div class="ttl">${esc(b.name)}${b.count ? ` <span class="sub">· ${b.count} cases</span>` : ''}</div>${b.mark ? `<div class="sub" style="color:var(--acc)">Mark: ${esc(b.mark)}</div>` : ''}${unitPrice(b) != null ? `<div class="sub">${money(unitPrice(b))}/case · ${money(unitPrice(b) / brassLife(b))} per firing</div>` : ''}<div class="sub">Fired ${st.firings}× · ${st.neck} neck since FL · ${st.anneal} since anneal${st.loaded ? ` · ${st.loaded} loaded` : ''}</div><div style="margin-top:6px">${st.alerts.map(([c, t]) => pill(c, t.split(' (')[0].split(':')[0])).join(' ') || pill('ok', 'Nothing due')}</div>`);
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
    const s = st.session, b = get('batches', st.batchId) || {}, l = get('loads', b.loadId) || {}, v = stats(parseVels(st.vels));
    rows.push([s.date, nRifle(get('rifles', s.rifleId)), s.location, s.distance, s.tempC, nLoad(l), nBullet(get('bullets', l.bulletId)), nPowder(get('powders', l.powderId)), l.charge, l.cbto, nBrass(get('brass', b.brassId)), b.date, st.shots, v.avg && v.avg.toFixed(1), v.es, v.sd && v.sd.toFixed(2), st.velUnit, st.groupMm, moa(st.groupMm, s.distance)?.toFixed(3), st.vels, st.notes]);
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
const TITLES = { home: 'Reload Log', loads: 'Load recipes', load: 'Load', series: 'Test series', batches: 'Batches', batch: 'Batch', range: 'Range sessions', session: 'Range session', brass: 'Brass lots', brasslot: 'Brass lot', setup: 'Setup', rifles: 'Rifles', bullets: 'Bullets', powders: 'Powders', primers: 'Primers' };
const TAB_OF = { load: 'loads', series: 'loads', batch: 'batches', session: 'range', brasslot: 'brass', rifles: 'setup', bullets: 'setup', powders: 'setup', primers: 'setup' };
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
  newBatch: d => batchForm(null, { loadId: d.load || undefined, brassId: d.brass || undefined }),
  editBatch: d => batchForm(get('batches', d.id)),
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
  ai: () => aiForm(),
  export: () => download(`reload-log-backup-${today()}.json`, JSON.stringify({ ...S, exported: new Date().toISOString(), app: APP_VERSION }, null, 1), 'application/json'),
  import: () => $('#importfile').click(),
  csv: () => csvExport()
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
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
