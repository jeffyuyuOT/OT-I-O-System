// ============================================================
// 會計報表(會計 → 會計報表)
//   篩選:日期區間、財年(7/1–6/30)、季度。資料全部來自現有資料,不需要新 SQL:
//   收入 = invoices − credit_notes;進貨 = Purchase List(inAccounting);其他支出 = 進貨單相關支出 + 獨立其他支出;
//   庫存價值 = 批次剩餘量 × 批次單價(截至今天);耗損 = 庫存調整原因(transactions.adj_reason)× 批次異動成本;
//   銷貨成本 = 出貨當下的批次單價快照(batch_movements.unit_cost)。
// ============================================================
let arpFilter = { from: '', to: '', fy: '', q: '' };
let arpRaw = null;          // { cns, adjTx, errs:[] }
let arpMvCache = {};
let arpReport = null;       // 最近一次算出的報表(給匯出用)
let arpRunId = 0;
let arpAsOf = '';           // 庫存價值「某日當天」;空白 = 現在
let arpAfterCache = {};

function arpM(n){ return (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function arpR2(n){ return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function arpN(n){ return Number(n) || 0; }
function arpDays(a, b){ return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

// ---- 財年 / 季度 ----
function arpCurrentFyStart(){
  const d = new Date(); const y = d.getFullYear(), m = d.getMonth() + 1;
  return m >= 7 ? y : y - 1;
}
function arpFyList(){ const out = []; for(let y = arpCurrentFyStart(); y >= 2024; y--) out.push(y); return out; }
function arpFyLabel(y){ return 'FY' + String(y).slice(2) + '-' + String(y + 1).slice(2); }
function arpRangeFor(fy, q){
  const y = Number(fy); if(!y) return { from: '', to: '' };
  const Q = { 1: [`${y}-07-01`, `${y}-09-30`], 2: [`${y}-10-01`, `${y}-12-31`], 3: [`${y + 1}-01-01`, `${y + 1}-03-31`], 4: [`${y + 1}-04-01`, `${y + 1}-06-30`] };
  if(q && Q[q]) return { from: Q[q][0], to: Q[q][1] };
  return { from: `${y}-07-01`, to: `${y + 1}-06-30` };
}
function arpInRange(d){ return !!d && (!arpFilter.from || d >= arpFilter.from) && (!arpFilter.to || d <= arpFilter.to); }

// ---- 載入 ----
async function arpLoadRaw(){
  const errs = [];
  const cns = [], adjTx = [];
  try{ await invLoadList(true); }catch(e){ errs.push('Invoice'); }
  try{
    const r = await fetchAllPages(() => sb.from('credit_notes').select('id,cn_no,cn_date,customer,party_id,invoice_id,before_tax,tax,total').order('cn_no', { ascending: true }));
    cns.push(...r);
  }catch(e){ if(!(e && (e.code === '42P01' || e.code === 'PGRST205'))) errs.push('Credit Note'); }
  try{ if(typeof ensurePurchasesLoaded === 'function') await ensurePurchasesLoaded(); }catch(e){ errs.push('Purchases'); }
  try{ await paLoadPayments(); if(paErr) errs.push('Purchase payments'); }catch(e){ errs.push('Purchase payments'); }
  try{ await oeLoad(); if(oeErr === 'error') errs.push('Other expenses'); }catch(e){ errs.push('Other expenses'); }
  try{ if(typeof batchFeatureOn === 'function' && batchFeatureOn() && typeof ensureBatchDataLoaded === 'function') await ensureBatchDataLoaded(true); }catch(e){ errs.push('Batches'); }
  try{
    const r = await fetchAllPages(() => sb.from('transactions').select('id,product_id,type,qty,date,adj_reason').not('adj_reason', 'is', null).order('id', { ascending: true }));
    adjTx.push(...r);
  }catch(e){ if(!(e && (e.code === '42703' || /adj_reason/.test(e.message || '')))) errs.push('Adjustments'); }
  arpRaw = { cns, adjTx, errs };
}
async function arpLoadMovements(from, to){
  const key = from + '|' + to;
  if(arpMvCache[key]) return arpMvCache[key];
  let rows = [];
  try{
    rows = await fetchAllPages(() => {
      let q = sb.from('batch_movements').select('id,tx_id,qty,kind,unit_cost,mv_date').in('kind', ['out', 'return']).order('id', { ascending: true });
      if(from) q = q.gte('mv_date', from);
      if(to) q = q.lte('mv_date', to);
      return q;
    });
  }catch(e){ rows = []; }
  arpMvCache[key] = rows;
  return rows;
}

// ---- 計算 ----
function arpInvCustomer(r){ return (r.customer || r.party_id || '').trim() || '(?)'; }
function arpCompute(movements){
  const R = {};
  const prods = (typeof products !== 'undefined') ? products : [];
  const pById = {}; prods.forEach(p => { pById[p.id] = p; });
  // 收入
  const invs = (typeof invList !== 'undefined' ? invList : []).filter(r => arpInRange(r.invoice_date));
  const cns = arpRaw.cns.filter(r => arpInRange(r.cn_date));
  const inc = { count: invs.length, ex: 0, gst: 0, inc: 0, cnCount: cns.length, cnEx: 0, cnGst: 0, cnInc: 0 };
  const byCust = {};
  invs.forEach(r => { const ex = arpN(r.before_tax), g = arpN(r.tax), t = arpN(r.total); inc.ex += ex; inc.gst += g; inc.inc += t; const k = arpInvCustomer(r); (byCust[k] = byCust[k] || { n: 0, ex: 0, inc: 0 }); byCust[k].n++; byCust[k].ex += ex; byCust[k].inc += t; });
  cns.forEach(r => { const ex = arpN(r.before_tax), g = arpN(r.tax), t = arpN(r.total); inc.cnEx += ex; inc.cnGst += g; inc.cnInc += t; const k = arpInvCustomer(r); (byCust[k] = byCust[k] || { n: 0, ex: 0, inc: 0 }); byCust[k].ex -= ex; byCust[k].inc -= t; });
  inc.netEx = arpR2(inc.ex - inc.cnEx); inc.netGst = arpR2(inc.gst - inc.cnGst); inc.netInc = arpR2(inc.inc - inc.cnInc);
  R.income = inc; R.byCust = Object.keys(byCust).map(k => Object.assign({ name: k }, byCust[k])).sort((a, b) => b.ex - a.ex);
  R.invs = invs; R.cns = cns;
  // 進貨(供應商發票)
  const pur = (typeof purchases !== 'undefined' ? purchases : []).filter(p => paCounted(p) && arpInRange(p.date));
  const P = { count: pur.length, ex: 0, gst: 0, inc: 0, paid: 0, unpaid: 0 };
  const bySup = {};
  pur.forEach(p => { const i = paInfo(p); P.ex += i.ex; P.gst += i.gst; P.inc += i.total; P.paid += i.paid; P.unpaid += i.balance; const k = (p.partyName || '(?)'); (bySup[k] = bySup[k] || { n: 0, ex: 0, inc: 0 }); bySup[k].n++; bySup[k].ex += i.ex; bySup[k].inc += i.total; });
  // 其他支出:進貨單相關 + 獨立
  const rel = { count: 0, ex: 0, gst: 0, inc: 0, paid: 0, unpaid: 0 }, sa = { count: 0, ex: 0, gst: 0, inc: 0, paid: 0, unpaid: 0 };
  const expRows = [];
  oeAllEntries().filter(en => arpInRange(en.date)).forEach(en => {
    const t = en.kind === 'rel' ? rel : sa, i = en.info;
    t.count++; t.ex += i.ex; t.gst += i.gst; t.inc += i.total; t.paid += i.paid; t.unpaid += i.balance;
    const k = en.payee || (en.kind === 'rel' ? (en.p.partyName || '(?)') : '(–)'); (bySup[k] = bySup[k] || { n: 0, ex: 0, inc: 0 }); bySup[k].n++; bySup[k].ex += i.ex; bySup[k].inc += i.total;
    expRows.push(en);
  });
  R.pur = P; R.rel = rel; R.sa = sa; R.purRows = pur; R.expRows = expRows;
  R.bySup = Object.keys(bySup).map(k => Object.assign({ name: k }, bySup[k])).sort((a, b) => b.ex - a.ex);
  // GST
  const gstIn = arpR2(P.gst + rel.gst + sa.gst);
  R.gst = { g1: inc.netInc, sales: inc.netGst, purch: gstIn, net: arpR2(inc.netGst - gstIn) };
  // 庫存調整 / 耗損
  const adjIds = new Set(arpRaw.adjTx.map(x => x.id));
  const mvByTx = {}; const cogsMv = [];
  movements.forEach(m => { if(m.tx_id && adjIds.has(m.tx_id)) (mvByTx[m.tx_id] = mvByTx[m.tx_id] || []).push(m); else cogsMv.push(m); });
  const reasons = {}; let noCostQty = 0;
  arpRaw.adjTx.filter(x => arpInRange(x.date)).forEach(x => {
    const code = x.adj_reason, info = (typeof adjReasonInfo === 'function') ? adjReasonInfo(code) : null;
    const r = (reasons[code] = reasons[code] || { code, group: info ? info.group : 'other', qty: 0, cost: 0, n: 0 });
    const q = arpN(x.qty); r.qty += q; r.n++;
    if(x.type === 'out' || (info && info.dir === 'out')){
      const mvs = mvByTx[x.id] || [];
      if(mvs.length) r.cost += mvs.reduce((s, m) => s - arpN(m.qty) * arpN(m.unit_cost), 0);
      else noCostQty += q;
    }
  });
  R.reasons = Object.values(reasons).sort((a, b) => b.cost - a.cost);
  R.wastageCost = arpR2(R.reasons.filter(r => r.group === 'wastage').reduce((s, r) => s + r.cost, 0));
  R.adjNoCostQty = noCostQty;
  // 銷貨成本 / 毛利(只含有批次單價快照的出貨)
  const cogs = arpR2(cogsMv.reduce((s, m) => s - arpN(m.qty) * arpN(m.unit_cost), 0));
  R.cogs = cogs; R.marginAmt = arpR2(inc.netEx - cogs); R.marginPct = inc.netEx > 0 ? arpR2(R.marginAmt / inc.netEx * 100) : null;
  // 庫存價值(現在)
  R.inv = arpInvCompute(pById, null);
  // 應收帳齡(截至今天)
  const today = (typeof invToday === 'function') ? invToday() : new Date().toISOString().slice(0, 10);
  const arB = ['cur', 'd30', 'd60', 'd90', 'd90p'];
  const arBucket = d => d <= 0 ? 'cur' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'd90p';
  const ar = { total: 0, buckets: { cur: 0, d30: 0, d60: 0, d90: 0, d90p: 0 }, byCust: {} };
  (typeof invList !== 'undefined' ? invList : []).forEach(r => {
    const i = invRowInfo(r); if(i.balance <= 0.004) return;
    const b = arBucket(i.due ? arpDays(i.due, today) : 0);
    ar.total += i.balance; ar.buckets[b] += i.balance;
    const k = arpInvCustomer(r); const c = (ar.byCust[k] = ar.byCust[k] || { cur: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0 });
    c[b] += i.balance; c.total += i.balance;
  });
  ar.rows = Object.keys(ar.byCust).map(k => Object.assign({ name: k }, ar.byCust[k])).sort((a, b) => b.total - a.total);
  R.ar = ar; R.arKeys = arB;
  // 應付(未付;依單據日期帳齡)
  const ap = { total: 0, buckets: { cur: 0, d30: 0, d60: 0, d90: 0, d90p: 0 }, byName: {} };
  const apAdd = (name, date, bal) => {
    if(bal <= 0.004) return;
    const d = arpDays(date || today, today);
    const bk = d <= 30 ? 'cur' : d <= 60 ? 'd30' : d <= 90 ? 'd60' : d <= 120 ? 'd90' : 'd90p';
    ap.total += bal; ap.buckets[bk] += bal;
    const c = (ap.byName[name] = ap.byName[name] || { cur: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0 });
    c[bk] += bal; c.total += bal;
  };
  (typeof purchases !== 'undefined' ? purchases : []).filter(p => paCounted(p)).forEach(p => apAdd(p.partyName || '(?)', p.date, paInfo(p).balance));
  oeAllEntries().forEach(en => apAdd(en.payee || (en.kind === 'rel' ? (en.p.partyName || '(?)') : '(–)'), en.date, en.info.balance));
  ap.rows = Object.keys(ap.byName).map(k => Object.assign({ name: k }, ap.byName[k])).sort((a, b) => b.total - a.total);
  R.ap = ap;
  return R;
}


// 庫存價值。after = null → 現在;after = { batch_item_id: 該日之後異動合計 } → 還原成「asOf 當天」:
//   當天餘量 = 現在餘量 − 當天之後的異動合計(異動 qty 出貨為負、退回為正);批次日期晚於 asOf 的批次不計。
function arpInvCompute(pById, asOf, after){
  const invVal = {}; let total = 0, noCost = 0;
  const items = (typeof batchData !== 'undefined' && batchData.items) ? batchData.items : [];
  items.forEach(it => {
    if(asOf && it.batchDate && it.batchDate > asOf) return;
    const rem = asOf ? arpN(it.remaining) - arpN((after || {})[it.id]) : arpN(it.remaining);
    if(rem <= 0.0000001) return;
    if(paProductOffBooks(it.productId)) return;
    const c = (it.unitCostTotal !== null && it.unitCostTotal !== undefined) ? it.unitCostTotal : it.unitCostBase;
    if(c === null || c === undefined){ noCost++; return; }
    const v = rem * c; total += v;
    const p = pById[it.productId] || {};
    const k = it.productId; (invVal[k] = invVal[k] || { name: p.name || k, sku: p.sku || '', category: p.category || '', unit: p.unit || '', qty: 0, value: 0 });
    invVal[k].qty += rem; invVal[k].value += v;
  });
  return { total: arpR2(total), noCost, rows: Object.values(invVal).sort((a, b) => b.value - a.value), tracked: items.length > 0, asOf: asOf || '' };
}
async function arpLoadAfter(asOf){
  if(arpAfterCache[asOf]) return arpAfterCache[asOf];
  const m = {};
  const rows = await fetchAllPages(() => sb.from('batch_movements').select('batch_item_id,qty,mv_date').gt('mv_date', asOf).order('id', { ascending: true }));
  rows.forEach(r => { m[r.batch_item_id] = (m[r.batch_item_id] || 0) + arpN(r.qty); });
  arpAfterCache[asOf] = m;
  return m;
}

// ---- 畫面 ----
async function arpOpenPage(){
  const root = document.getElementById('accReportsRoot'); if(!root) return;
  if(!paOn()){ root.innerHTML = ''; return; }
  if(!arpFilter.from && !arpFilter.to && !arpFilter.fy){ arpFilter.fy = String(arpCurrentFyStart()); const r = arpRangeFor(arpFilter.fy, ''); arpFilter.from = r.from; arpFilter.to = r.to; }
  root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  await arpLoadRaw();
  arpMvCache = {}; arpAfterCache = {};
  await arpRefresh();
}
async function arpRefresh(){
  const root = document.getElementById('accReportsRoot'); if(!root || !arpRaw) return;
  const run = ++arpRunId;
  const mv = await arpLoadMovements(arpFilter.from, arpFilter.to);
  if(run !== arpRunId) return;
  arpReport = arpCompute(mv);
  arpReport.invAsOf = null; arpReport.invAsOfErr = false;
  if(arpAsOf){
    try{
      const after = await arpLoadAfter(arpAsOf);
      if(run !== arpRunId) return;
      const pById = {}; ((typeof products !== 'undefined') ? products : []).forEach(p => { pById[p.id] = p; });
      arpReport.invAsOf = arpInvCompute(pById, arpAsOf, after);
    }catch(e){ arpReport.invAsOfErr = true; }
  }
  arpRender();
}
function arpSetFy(v){
  arpFilter.fy = v;
  if(!v){ arpFilter.q = ''; } else { const r = arpRangeFor(v, arpFilter.q); arpFilter.from = r.from; arpFilter.to = r.to; }
  arpRefresh();
}
function arpSetQ(v){
  arpFilter.q = v;
  if(v && !arpFilter.fy) arpFilter.fy = String(arpCurrentFyStart());
  if(arpFilter.fy){ const r = arpRangeFor(arpFilter.fy, v); arpFilter.from = r.from; arpFilter.to = r.to; }
  arpRefresh();
}
function arpOnDates(){
  arpFilter.from = (document.getElementById('arpFrom') || {}).value || '';
  arpFilter.to = (document.getElementById('arpTo') || {}).value || '';
  arpFilter.fy = ''; arpFilter.q = '';
  arpRefresh();
}
function arpClear(){ arpFilter = { from: '', to: '', fy: '', q: '' }; arpAsOf = ''; arpRefresh(); }
function arpOnAsOf(v){ arpAsOf = v || ''; arpRefresh(); }
async function arpReload(){ const root = document.getElementById('accReportsRoot'); if(root) root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`; await arpLoadRaw(); arpMvCache = {}; arpAfterCache = {}; await arpRefresh(); }

function arpRender(){
  const root = document.getElementById('accReportsRoot'); if(!root || !arpReport) return;
  const R = arpReport, f = arpFilter, E = paEsc;
  const sel = (id, val, opts, fn) => `<select id="${id}" onchange="${fn}(this.value)">${opts.map(o => `<option value="${E(o[0])}" ${String(val) === String(o[0]) ? 'selected' : ''}>${E(o[1])}</option>`).join('')}</select>`;
  const card = (label, val, sub) => `<div style="flex:1 1 150px;min-width:140px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${label}</div><div style="font-size:17px;font-weight:700;">${val}</div>${sub ? `<div style="font-size:11px;color:var(--ink-soft);">${sub}</div>` : ''}</div>`;
  const sec = (title, body, note) => `<div style="margin:18px 0 6px;font-size:14px;font-weight:700;">${title}</div>${note ? `<div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">${note}</div>` : ''}<div style="overflow-x:auto;">${body}</div>`;
  const tbl = (head, rows, foot) => `<table class="stock-table"><thead><tr>${head.map((h, i) => `<th${h[1] ? ' class="num"' : ''}>${h[0]}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}" style="color:var(--ink-soft);">${E(t('arpNoData'))}</td></tr>`}${foot || ''}</tbody></table>`;
  const tr = cells => `<tr>${cells.map((c, i) => `<td${(typeof c === 'object' && c.n) ? ' class="num"' : ''}>${typeof c === 'object' ? c.v : c}</td>`).join('')}</tr>`;
  const N = v => ({ n: 1, v: v });
  const B = v => ({ n: 1, v: '<b>' + v + '</b>' });
  const errs = (arpRaw.errs || []).length ? `<div class="msg error" style="margin-bottom:8px;">⚠ ${E(tf('arpErrPartial', { names: arpRaw.errs.join(', ') }))}</div>` : '';
  const grpLabel = g => t('arpGrp_' + g);
  const adjName = c => (typeof adjReasonLabel === 'function') ? adjReasonLabel(c) : c;
  const bk = ['cur', 'd30', 'd60', 'd90', 'd90p'];
  const incTbl = tbl([[t('arpColItem')], [t('arpColEx'), 1], [t('arpColGst'), 1], [t('arpColTotal'), 1]], [
    tr([`${t('arpInvoices')} (${R.income.count})`, N(arpM(R.income.ex)), N(arpM(R.income.gst)), N(arpM(R.income.inc))]),
    tr([`${t('arpCreditNotes')} (${R.income.cnCount})`, N('-' + arpM(R.income.cnEx)), N('-' + arpM(R.income.cnGst)), N('-' + arpM(R.income.cnInc))]),
    tr([`<b>${t('arpNetRevenue')}</b>`, B(arpM(R.income.netEx)), B(arpM(R.income.netGst)), B(arpM(R.income.netInc))])
  ].join(''));
  const purRow = (label, x) => tr([`${label} (${x.count})`, N(arpM(x.ex)), N(arpM(x.gst)), N(arpM(x.inc)), N(arpM(x.paid)), N(arpM(x.unpaid))]);
  const tot = { count: R.pur.count + R.rel.count + R.sa.count, ex: R.pur.ex + R.rel.ex + R.sa.ex, gst: R.pur.gst + R.rel.gst + R.sa.gst, inc: R.pur.inc + R.rel.inc + R.sa.inc, paid: R.pur.paid + R.rel.paid + R.sa.paid, unpaid: R.pur.unpaid + R.rel.unpaid + R.sa.unpaid };
  const purTbl = tbl([[t('arpColItem')], [t('arpColEx'), 1], [t('arpColGst'), 1], [t('arpColTotal'), 1], [t('paColPaid'), 1], [t('paColUnpaid'), 1]],
    purRow(t('arpPurSupplier'), R.pur) + purRow(t('arpPurRelated'), R.rel) + purRow(t('arpPurStandalone'), R.sa) +
    tr([`<b>${t('arpTotal')}</b>`, B(arpM(tot.ex)), B(arpM(tot.gst)), B(arpM(tot.inc)), B(arpM(tot.paid)), B(arpM(tot.unpaid))]));
  const gstTbl = tbl([[t('arpColItem')], [t('arpColAmount'), 1]], [
    tr([t('arpGstG1'), N(arpM(R.gst.g1))]), tr([t('arpGstSales'), N(arpM(R.gst.sales))]), tr([t('arpGstPurch'), N(arpM(R.gst.purch))]),
    tr([`<b>${t('arpGstNet')}</b>`, B(arpM(R.gst.net))])].join(''));
  const marginTbl = tbl([[t('arpColItem')], [t('arpColAmount'), 1]], [
    tr([t('arpNetRevenue') + ' (' + t('arpColEx') + ')', N(arpM(R.income.netEx))]), tr([t('arpCogs'), N('-' + arpM(R.cogs))]),
    tr([`<b>${t('arpMarginAmt')}</b>`, B(arpM(R.marginAmt))]), tr([t('arpMarginPct'), N(R.marginPct === null ? '–' : R.marginPct.toFixed(1) + '%')])].join(''));
  const IV = R.invAsOf || R.inv;
  const invTbl = tbl([[t('colProduct')], [t('colQty'), 1], [t('arpColValue'), 1]],
    IV.rows.slice(0, 50).map(r => tr([E(r.name) + (r.sku ? ` <span style="color:var(--ink-soft);font-size:11px;">(${E(r.sku)})</span>` : ''), N(arpM(r.qty) + ' ' + E(r.unit)), N(arpM(r.value))])).join(''),
    tr([`<b>${t('arpTotal')}</b>`, '', B(arpM(IV.total))]));
  const wasteTbl = tbl([[t('arpColReason')], [t('arpColCount'), 1], [t('colQty'), 1], [t('arpColCost'), 1]],
    R.reasons.map(r => tr([E(adjName(r.code)) + ` <span style="color:var(--ink-soft);font-size:11px;">[${E(grpLabel(r.group))}]</span>`, N(r.n), N(arpM(r.qty)), N(arpM(r.cost))])).join(''),
    tr([`<b>${t('arpWastageTotal')}</b>`, '', '', B(arpM(R.wastageCost))]));
  const ageHead = [[t('arpColName')], ...bk.map(k => [t('arpBk_' + k), 1]), [t('arpColTotal'), 1]];
  const ageRows = (x) => x.rows.map(r => tr([E(r.name), ...bk.map(k => N(r[k] ? arpM(r[k]) : '–')), B(arpM(r.total))])).join('') +
    tr([`<b>${t('arpTotal')}</b>`, ...bk.map(k => B(arpM(x.buckets[k]))), B(arpM(x.total))]);
  const custTbl = tbl([[t('arpColName')], [t('arpColCount'), 1], [t('arpColEx'), 1], [t('arpColTotal'), 1]], R.byCust.slice(0, 30).map(r => tr([E(r.name), N(r.n), N(arpM(r.ex)), N(arpM(r.inc))])).join(''));
  const supTbl = tbl([[t('arpColName')], [t('arpColCount'), 1], [t('arpColEx'), 1], [t('arpColTotal'), 1]], R.bySup.slice(0, 30).map(r => tr([E(r.name), N(r.n), N(arpM(r.ex)), N(arpM(r.inc))])).join(''));
  const fyOpts = [['', t('arpAll')]].concat(arpFyList().map(y => [String(y), arpFyLabel(y)]));
  const qOpts = [['', t('arpAll')], ['1', 'Q1 (Jul–Sep)'], ['2', 'Q2 (Oct–Dec)'], ['3', 'Q3 (Jan–Mar)'], ['4', 'Q4 (Apr–Jun)']];
  root.innerHTML = `${errs}
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('lblFromDate')}</label><input type="date" id="arpFrom" value="${E(f.from)}" onchange="arpOnDates()" /></div>
      <div class="field"><label>${t('lblToDate')}</label><input type="date" id="arpTo" value="${E(f.to)}" onchange="arpOnDates()" /></div>
      <div class="field"><label>${t('arpFy')}</label>${sel('arpFySel', f.fy, fyOpts, 'arpSetFy')}</div>
      <div class="field"><label>${t('arpQuarter')}</label>${sel('arpQSel', f.q, qOpts, 'arpSetQ')}</div>
      <button class="btn ghost" onclick="arpClear()" style="align-self:flex-end;">${t('btnClearFilter')}</button>
      <button class="btn ghost" onclick="arpReload()" style="align-self:flex-end;">${t('arpBtnReload')}</button>
      <button class="btn" onclick="arpExport()" style="align-self:flex-end;">${t('arpBtnExport')}</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${card(t('arpRevenue'), arpM(R.income.netEx), tf('arpInvCount', { n: R.income.count }))}
      ${card(t('arpPurchasesCard'), arpM(tot.ex), tf('arpPurCount', { n: tot.count }))}
      ${card(t('arpMarginAmt'), arpM(R.marginAmt), R.marginPct === null ? '' : R.marginPct.toFixed(1) + '%')}
      ${card(t('arpWastageCard'), arpM(R.wastageCost))}
      ${card(t('arpInvValueCard'), arpM(R.inv.total), t('arpAsOfToday'))}
      ${R.invAsOf ? card(tf('arpInvAsOfCard', { d: arpAsOf }), arpM(R.invAsOf.total), R.invAsOf.total - R.inv.total >= 0 ? '+' + arpM(R.invAsOf.total - R.inv.total) + ' ' + t('arpVsNow') : '−' + arpM(R.inv.total - R.invAsOf.total) + ' ' + t('arpVsNow')) : ''}
      ${card(t('arpGstNet'), arpM(R.gst.net))}
    </div>
    ${sec(t('arpSecIncome'), incTbl)}
    ${sec(t('arpSecPurchase'), purTbl, t('arpPurNote'))}
    ${sec(t('arpSecGst'), gstTbl, t('arpGstHint'))}
    ${sec(t('arpSecMargin'), marginTbl, t('arpMarginNote'))}
    ${sec(t('arpSecInventory') + (R.invAsOf ? ' — ' + arpAsOf : ' — ' + t('arpAsOfToday')), `<div class="filter-row" style="margin-bottom:6px;"><div class="field"><label>${t('arpInvAsOfLbl')}</label><input type="date" id="arpAsOfIn" value="${E(arpAsOf)}" max="${E((typeof invToday === 'function') ? invToday() : '')}" onchange="arpOnAsOf(this.value)" /></div>${arpAsOf ? `<button class="btn ghost" onclick="arpOnAsOf('')" style="align-self:flex-end;">${t('arpInvAsOfNow')}</button>` : ''}</div>${R.invAsOfErr ? `<div class="msg error">⚠ ${t('arpInvAsOfErr')}</div>` : ''}` + invTbl, t('arpInvNote') + (R.invAsOf ? ' ' + t('arpInvAsOfNote') : '') + (IV.noCost ? ' ' + tf('arpInvNoCost', { n: IV.noCost }) : '') + (IV.rows.length > 50 ? ' ' + t('arpTop50') : ''))}
    ${sec(t('arpSecWastage'), wasteTbl, t('arpWastageNote') + (R.adjNoCostQty ? ' ' + tf('arpWastageNoCost', { qty: arpM(R.adjNoCostQty) }) : ''))}
    ${sec(t('arpSecAr'), tbl(ageHead, ageRows(R.ar)), t('arpArNote'))}
    ${sec(t('arpSecAp'), tbl(ageHead.map((h, i) => i >= 1 && i <= 5 ? [t('arpApBk_' + bk[i - 1]), 1] : h), ageRows(R.ap)), t('arpApNote'))}
    ${sec(t('arpSecByCust'), custTbl, R.byCust.length > 30 ? t('arpTop30') : '')}
    ${sec(t('arpSecBySup'), supTbl, R.bySup.length > 30 ? t('arpTop30') : '')}`;
}

// ---- 匯出 Excel ----
function arpExport(){
  if(!arpReport || typeof XLSX === 'undefined') return;
  const R = arpReport, f = arpFilter, wb = XLSX.utils.book_new();
  const add = (name, aoa) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = (aoa[0] || []).map((_, i) => ({ wch: i === 0 ? 34 : 16 })); XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); };
  const q = n => arpR2(n);
  const tot = { ex: R.pur.ex + R.rel.ex + R.sa.ex, gst: R.pur.gst + R.rel.gst + R.sa.gst, inc: R.pur.inc + R.rel.inc + R.sa.inc };
  add('Summary', [
    ['Period', (f.from || '…') + ' to ' + (f.to || '…')], [],
    ['Revenue (ex GST, net of credit notes)', q(R.income.netEx)], ['GST collected (net)', q(R.income.netGst)], ['Revenue (inc GST)', q(R.income.netInc)], [],
    ['Purchases (supplier invoices) ex GST', q(R.pur.ex)], ['Related expenses ex GST', q(R.rel.ex)], ['Other expenses (standalone) ex GST', q(R.sa.ex)], ['Total purchases & expenses ex GST', q(tot.ex)], ['GST paid (inputs)', q(tot.gst)], [],
    ['Cost of goods sold (batch cost)', q(R.cogs)], ['Gross margin', q(R.marginAmt)], ['Gross margin %', R.marginPct === null ? '' : R.marginPct], [],
    ['GST net payable / (refundable)', q(R.gst.net)], ['Wastage cost', q(R.wastageCost)], ['Inventory value (as of today)', q(R.inv.total)]
  ].concat(R.invAsOf ? [['Inventory value (as of ' + arpAsOf + ')', q(R.invAsOf.total)]] : []));
  add('Invoices', [['Invoice No', 'Date', 'Customer', 'Ex GST', 'GST', 'Total', 'Paid']].concat(R.invs.map(r => [r.invoice_no, r.invoice_date, arpInvCustomer(r), q(arpN(r.before_tax)), q(arpN(r.tax)), q(arpN(r.total)), q(arpN(r.paid))])));
  add('Credit Notes', [['CN No', 'Date', 'Customer', 'Ex GST', 'GST', 'Total']].concat(R.cns.map(r => [r.cn_no, r.cn_date, arpInvCustomer(r), q(arpN(r.before_tax)), q(arpN(r.tax)), q(arpN(r.total))])));
  add('Purchases', [['Date', 'Supplier', 'Invoice No', 'Ex GST', 'GST', 'Total', 'Paid', 'Unpaid']].concat(R.purRows.map(p => { const i = paInfo(p); return [p.date, p.partyName || '', p.invoiceNo || '', i.ex, i.gst, i.total, i.paid, i.balance]; })));
  add('Expenses', [['Date', 'Type', 'Item', 'Payee', 'Linked supplier', 'Linked INV', 'Ex GST', 'GST', 'Total', 'Paid', 'Unpaid']].concat(R.expRows.map(en => [en.date, en.kind === 'rel' ? 'Purchase-related' : 'Standalone', en.name, en.payee || '', en.kind === 'rel' ? (en.p.partyName || '') : '', en.kind === 'rel' ? (en.p.invoiceNo || '') : '', en.info.ex, en.info.gst, en.info.total, en.info.paid, en.info.balance])));
  add('Wastage & adjustments', [['Reason', 'Group', 'Count', 'Qty', 'Cost']].concat(R.reasons.map(r => [(typeof adjReasonLabel === 'function' ? adjReasonLabel(r.code) : r.code), r.group, r.n, q(r.qty), q(r.cost)])));
  add('Inventory value' + (R.invAsOf ? ' ' + arpAsOf : ''), [['SKU', 'Product', 'Category', 'Qty', 'Unit', 'Value']].concat((R.invAsOf || R.inv).rows.map(r => [r.sku, r.name, r.category, q(r.qty), r.unit, q(r.value)])));
  const bk = ['cur', 'd30', 'd60', 'd90', 'd90p'];
  add('AR aging', [['Customer', 'Not due', '1-30', '31-60', '61-90', '90+', 'Total']].concat(R.ar.rows.map(r => [r.name, ...bk.map(k => q(r[k])), q(r.total)])));
  add('AP unpaid', [['Payee / supplier', '0-30 days', '31-60', '61-90', '91-120', '120+', 'Total']].concat(R.ap.rows.map(r => [r.name, ...bk.map(k => q(r[k])), q(r.total)])));
  XLSX.writeFile(wb, `Accounting_Report_${f.from || 'all'}_${f.to || 'all'}.xlsx`);
}

function arpApplyVisibility(){
  const sel = document.getElementById('accountingSubtabSelect'); if(!sel) return;
  const o = Array.from(sel.options).find(x => x.value === 'subtab-acc-reports');
  if(o){ o.hidden = !paOn(); o.disabled = !paOn(); }
}
document.addEventListener('DOMContentLoaded', () => { try{ arpApplyVisibility(); }catch(e){} });
