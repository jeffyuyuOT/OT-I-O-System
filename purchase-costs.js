// ============================================================
// purchase-costs.js — 批次追蹤第二期:其他支出分攤 + 海外採購(幣種/匯率)
//
// 資料放在進貨單(purchases.payload):
//   purchase.costs = { overseas, currency, basis, rates:{USD:1.52}, expenses:[{id,name,currency,amount,rate,aud}],
//                      expensesAud, invoiceAud, totalAud }
//   purchase.items[i]: amount(AUD 底價總額)、totalAmount(AUD 總價總額 = 底價 + 分攤支出)、
//                      海外時另有 origAmount / origCurrency / fxRate
// 所有金額一律以 AUD 計。沒有其他支出的進貨單,總價 = 底價。
// 只有「有編輯價錢權限」且批次追蹤功能開啟時,進貨表單才會出現這一區。
// ============================================================

const PC_DEFAULT_CURRENCIES = ['AUD', 'USD', 'CNY', 'TWD', 'NZD', 'EUR'];
let pcCurrencies = PC_DEFAULT_CURRENCIES.slice();
let pcExpenseNames = [];
let pcLoaded = false;
let pcLoading = false;
let pcManageOpen = false;
let pcDateHooked = false;
let pcState = pcNewState();

function pcNewState(){
  return { overseas: false, currency: 'AUD', rates: {}, manual: {}, expenses: [], basis: 'volume' };
}
function pcActive(){
  return typeof batchActive === 'function' && batchActive() && typeof canEditPrice === 'function' && canEditPrice();
}
function pcRound2(x){ return Math.round((Number(x) + Number.EPSILON) * 100) / 100; }
function pcFmt(x){ return (x === null || x === undefined || isNaN(x)) ? '–' : Number(x).toFixed(2); }
function pcEsc(s){ return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---------- 常用幣種 / 支出項目記憶 ----------
async function pcEnsureLoaded(){
  if(pcLoaded || pcLoading) return;
  pcLoading = true;
  try{
    const c = await dbGet('purchaseCurrencies');
    if(c && c.value){
      const arr = JSON.parse(c.value);
      if(Array.isArray(arr) && arr.length) pcCurrencies = Array.from(new Set(['AUD'].concat(arr.map(x => String(x).toUpperCase()))));
    }
  }catch(e){ /* 沒存過,用預設 */ }
  try{
    const n = await dbGet('purchaseExpenseNames');
    if(n && n.value){ const arr = JSON.parse(n.value); if(Array.isArray(arr)) pcExpenseNames = arr; }
  }catch(e){}
  pcLoaded = true; pcLoading = false;
  pcRender();
}
async function pcSaveCurrencies(){
  try{ await dbSet('purchaseCurrencies', JSON.stringify(pcCurrencies)); }catch(e){ console.error('儲存常用幣種失敗', e); }
}
async function pcRememberExpenseNames(names){
  let changed = false;
  names.forEach(n => {
    const name = (n || '').trim();
    if(name && !pcExpenseNames.some(x => x.toLowerCase() === name.toLowerCase())){ pcExpenseNames.push(name); changed = true; }
  });
  if(changed){
    try{ await dbSet('purchaseExpenseNames', JSON.stringify(pcExpenseNames)); }catch(e){ console.error('儲存支出項目失敗', e); }
  }
}
function pcAddCurrency(){
  const el = document.getElementById('pcNewCurrency');
  if(!el) return;
  const code = el.value.trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(code)) return;
  if(!pcCurrencies.includes(code)){ pcCurrencies.push(code); pcSaveCurrencies(); }
  pcRender();
}
function pcRemoveCurrency(code){
  if(code === 'AUD') return;
  pcCurrencies = pcCurrencies.filter(c => c !== code);
  pcSaveCurrencies();
  if(pcState.currency === code) pcState.currency = 'AUD';
  pcState.expenses.forEach(e => { if(e.currency === code) e.currency = 'AUD'; });
  pcRender();
}

// ---------- 匯率 ----------
// 1 單位外幣 = ? AUD。AUD 固定 1;其他幣種沒填回傳 null。
function pcRateOf(cur){
  if(!cur || cur === 'AUD') return 1;
  const r = parseFloat(pcState.rates[cur]);
  return (isFinite(r) && r > 0) ? r : null;
}
function pcUsedForeignCurrencies(){
  const set = new Set();
  if(pcState.overseas && pcState.currency && pcState.currency !== 'AUD') set.add(pcState.currency);
  pcState.expenses.forEach(e => { if(e.currency && e.currency !== 'AUD') set.add(e.currency); });
  return Array.from(set);
}
// Frankfurter 沒有 TWD,TWD 改用 open.er-api.com(只有當日匯率)。取不到就回傳 null,讓使用者手動輸入。
async function pcFetchRate(cur, dateStr){
  try{
    if(cur === 'TWD'){
      const r = await fetch('https://open.er-api.com/v6/latest/TWD');
      const j = await r.json();
      const v = j && j.rates && j.rates.AUD;
      return (isFinite(v) && v > 0) ? v : null;
    }
    const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : 'latest';
    const r = await fetch(`https://api.frankfurter.dev/v1/${d}?base=${encodeURIComponent(cur)}&symbols=AUD`);
    const j = await r.json();
    const v = j && j.rates && j.rates.AUD;
    return (isFinite(v) && v > 0) ? v : null;
  }catch(e){ console.error('取得匯率失敗', cur, e); return null; }
}
// force=true:連已經有值的也重抓(換日期時);手動改過的幣種不覆蓋
async function pcFetchRates(force){
  const dateEl = document.getElementById('txDate');
  const dateStr = dateEl ? dateEl.value : '';
  const failed = [];
  for(const cur of pcUsedForeignCurrencies()){
    if(pcState.manual[cur]) continue;
    if(!force && pcRateOf(cur)) continue;
    const v = await pcFetchRate(cur, dateStr);
    if(v) pcState.rates[cur] = v; else failed.push(cur);
  }
  pcState.fetchFailed = failed;
  pcRender();
}
function pcSetRate(cur, value){
  const v = parseFloat(value);
  pcState.rates[cur] = (isFinite(v) && v > 0) ? v : '';
  pcState.manual[cur] = true;
  pcRender();
}
function pcRefetchRate(cur){
  delete pcState.manual[cur];
  pcFetchRates(true);
}

// ---------- 沿用上次(預估) ----------
// 海外採購常見情況:新貨已到、報關行的 invoice 還沒來,但已經要出貨算成本。
// 其他支出的項目沒填金額時,先抓「同一個供應商、同名項目」最近一次進貨單的金額(含幣種)當預估,
// 標記為「預估」;之後拿到正式報關資料,再到「編輯進貨單」改成實際金額即可。
function pcSupplierName(){
  const el = document.getElementById('txParty');
  return el ? el.value.trim() : '';
}
function pcLastExpenseFor(supplier, name, excludePurchaseId){
  const sup = (supplier || '').trim().toLowerCase(), nm = (name || '').trim().toLowerCase();
  if(!sup || !nm || typeof purchases === 'undefined') return null;
  let best = null;
  purchases.forEach(p => {
    if(p.id === excludePurchaseId) return;
    if((p.partyName || p.partyId || '').trim().toLowerCase() !== sup) return;
    const e = ((p.costs && p.costs.expenses) || []).find(x => (x.name || '').trim().toLowerCase() === nm && x.amount !== undefined && x.amount !== null);
    if(!e) return;
    const key = (p.date || '') + '|' + (p.createdAt || '');
    if(!best || key > best.key) best = { key, exp: e, date: p.date || '' };
  });
  return best;
}
// 填入成功回傳 true。已有金額、找不到歷史都不動。
function pcFillFromLast(e, supplier, excludePurchaseId){
  if(!e.name || !e.name.trim() || (e.amount !== '' && e.amount !== undefined && e.amount !== null)) return false;
  const last = pcLastExpenseFor(supplier, e.name, excludePurchaseId);
  if(!last) return false;
  e.amount = Number(last.exp.amount);
  e.currency = last.exp.currency || 'AUD';
  e.estimated = true;
  e.estimatedFrom = last.date;
  return true;
}
// 送出前:載入進貨單歷史,海外採購且有項目沒填金額 → 沿用上次;再補抓需要的匯率。
async function pcPrepare(){
  if(!pcActive() || !pcState.overseas) return;
  try{ await ensurePurchasesLoaded(); }catch(e){}
  const sup = pcSupplierName();
  let filled = false;
  pcState.expenses.forEach(e => { if(pcFillFromLast(e, sup)) filled = true; });
  if(filled) await pcFetchRates(false);
}

// ---------- 表單狀態 ----------
function pcSetOverseas(on){
  pcState.overseas = !!on;
  if(!on) pcState.currency = 'AUD';
  else if(pcState.currency === 'AUD') pcState.currency = pcCurrencies.find(c => c !== 'AUD') || 'USD';
  pcRender();
  pcFetchRates(false);
}
function pcSetInvoiceCurrency(cur){ pcState.currency = cur; pcRender(); pcFetchRates(false); }
function pcAddExpense(){
  pcState.expenses.push({ id: genId(), name: '', currency: 'AUD', amount: '' });
  pcRender();
}
function pcRemoveExpense(id){ pcState.expenses = pcState.expenses.filter(e => e.id !== id); pcRender(); }
function pcUpdateExpense(id, field, value){
  const e = pcState.expenses.find(x => x.id === id);
  if(!e) return;
  if(field === 'amount'){
    const n = parseFloat(value); e.amount = (isFinite(n) && n >= 0) ? n : '';
    delete e.estimated; delete e.estimatedFrom; // 手動輸入 = 正式金額
  } else e[field] = value;
  pcRender();
  if(field === 'currency') pcFetchRates(false);
  if(field === 'name' && pcState.overseas && (e.amount === '' || e.amount === undefined)){
    ensurePurchasesLoaded().then(() => {
      if(pcFillFromLast(e, pcSupplierName())){ pcRender(); pcFetchRates(false); }
    }).catch(() => {});
  }
}
function pcSetBasis(b){ pcState.basis = b; pcRender(); }
function pcReset(){ pcState = pcNewState(); pcRender(); }

// ---------- 分攤計算 ----------
// 箱數:沿用進貨預估的換算規則(進貨單位是 CTN 直接用;否則用 multipack 加權數換算成「一箱」)。
// 這裡的單位商品就是進貨單這一行的商品本身,不使用進貨預估頁面上的單位選擇。
function pcBoxes(prod, qty){
  if(!prod) return null;
  if(isCartonUnit(prod.unit)) return qty;
  const anchor = prod.parentId ? (products.find(x => x.id === prod.parentId) || prod) : prod;
  const boxProd = resolveForecastBoxProduct(anchor);
  if(!boxProd){
    if(getForecastBoxCandidates(anchor).length === 0 && /^(can|cans|罐)$/i.test((prod.unit || '').trim())) return qty;
    return null;
  }
  return qty * getBasisWeight(prod, anchor) / getBasisWeight(boxProd, anchor);
}
// 回傳這一行在該分攤依據下的「份量」;缺資料回傳 null。
function pcBasisValue(basis, prod, qty, amountAud){
  if(basis === 'amount') return amountAud > 0 ? amountAud : null;
  if(!prod) return null;
  if(basis === 'weight') return (prod.weightKg > 0) ? prod.weightKg * qty : null;
  if(basis === 'volume'){ const v = computeBoxVolumeCm3(prod); return (v !== null && v > 0) ? v * qty : null; }
  if(basis === 'boxes'){ const b = pcBoxes(prod, qty); return (b !== null && b > 0) ? b : null; }
  return null;
}
// rows: [{ key, product, name, qty, amountAud, skip }]。回傳 { shares:{key:AUD}, missing:[商品名稱] }。
// 分到分(cent)用最大餘數法,確保每行加起來剛好等於支出總額。
function pcAllocate(rows, basis, expensesAud){
  const act = rows.filter(r => !r.skip);
  const shares = {};
  if(!(expensesAud > 0) || act.length === 0) return { shares, missing: [] };
  const vals = act.map(r => ({ r, v: pcBasisValue(basis, r.product, r.qty, r.amountAud) }));
  const missing = vals.filter(x => x.v === null).map(x => (x.r.product && x.r.product.name) || x.r.name || '?');
  if(missing.length) return { shares, missing: Array.from(new Set(missing)) };
  const sum = vals.reduce((s, x) => s + x.v, 0);
  const totalCents = Math.round(expensesAud * 100);
  const parts = vals.map(x => {
    const raw = totalCents * x.v / sum;
    return { r: x.r, cents: Math.floor(raw), frac: raw - Math.floor(raw) };
  });
  let left = totalCents - parts.reduce((s, p) => s + p.cents, 0);
  parts.slice().sort((a, b) => b.frac - a.frac).forEach(p => { if(left > 0){ p.cents += 1; left -= 1; } });
  parts.forEach(p => { shares[p.r.key] = p.cents / 100; });
  return { shares, missing: [] };
}
function pcBasisLabel(b){
  return t({ volume: 'pcBasisVolume', weight: 'pcBasisWeight', boxes: 'pcBasisBoxes', amount: 'pcBasisAmount' }[b] || 'pcBasisVolume');
}

// 目前畫面上的待送出清單 → 分攤用的行(跟送出時的自動切換換算一致:自動切換的批量商品算成主商品)
function pcMapTxItems(){
  const overseas = pcState.overseas && pcState.currency !== 'AUD';
  const rate = overseas ? pcRateOf(pcState.currency) : 1;
  return txBatchItems.map(it => {
    let prod = products.find(p => p.id === it.productId);
    let qty = Number(it.qty) || 0;
    if(prod && prod.parentId && prod.autoConvertOnStockIn){
      const parent = products.find(p => p.id === prod.parentId);
      qty = qty * (prod.childWeight || 1);
      prod = parent || prod;
    }
    const amountAud = (it.amount !== undefined && it.amount !== null && rate) ? Number(it.amount) * rate : 0;
    return { key: it.batchItemId, product: prod, name: it.name, qty, amountAud, skip: it.docType === 'credit_note' || it.docType === 'others' };
  });
}
// 支出列 → 含 rate/aud;金額或匯率有缺回傳 null 的 aud
function pcExpenseRows(){
  return pcState.expenses.map(e => {
    const rate = pcRateOf(e.currency);
    const amt = (e.amount === '' || e.amount === undefined) ? null : Number(e.amount);
    return { id: e.id, name: (e.name || '').trim(), currency: e.currency || 'AUD', amount: amt, rate, aud: (amt !== null && rate) ? pcRound2(amt * rate) : null, estimated: !!e.estimated, estimatedFrom: e.estimatedFrom || '' };
  });
}
function pcExpensesAudTotal(){
  return pcExpenseRows().reduce((s, e) => s + (e.aud || 0), 0);
}

// 送出前檢查。回傳錯誤訊息(空字串 = 通過)。
function pcValidate(){
  if(!pcActive()) return '';
  if(pcState.overseas && pcState.currency !== 'AUD' && !pcRateOf(pcState.currency)) return tf('pcErrNoRate', { cur: pcState.currency });
  // 完全空白的支出列直接略過;只填一半的擋下
  const rows = pcExpenseRows().filter(e => e.name || e.amount !== null);
  for(const e of rows){
    if(e.name && e.amount === null && pcState.overseas) return tf('pcErrNoHistory', { name: e.name });
    if(!e.name || e.amount === null || !(e.amount >= 0)) return t('pcErrExpenseInvalid');
    if(!e.rate) return tf('pcErrNoRate', { cur: e.currency });
  }
  const total = rows.reduce((s, e) => s + (e.aud || 0), 0);
  if(total > 0){
    const items = pcMapTxItems();
    if(!items.some(r => !r.skip)) return t('pcErrNoInvoiceRows');
    const res = pcAllocate(items, pcState.basis, total);
    if(res.missing.length) return tf('pcErrMissingBasis', { basis: pcBasisLabel(pcState.basis), names: res.missing.join('、') });
  }
  return '';
}

// 送出時:把幣種換算、分攤結果、成本摘要寫進進貨單。purchase.items 已經是最後要存的版本。
function pcApplyToPurchase(purchase){
  if(!pcActive()) return;
  const overseas = pcState.overseas && pcState.currency !== 'AUD';
  const rate = overseas ? pcRateOf(pcState.currency) : 1;
  purchase.items.forEach(it => {
    if(overseas && it.amount !== undefined && it.amount !== null){
      it.origAmount = Number(it.amount);
      it.origCurrency = pcState.currency;
      it.fxRate = rate;
      it.amount = pcRound2(Number(it.amount) * rate);
    }
  });
  const exps = pcExpenseRows().filter(e => e.name && e.aud !== null);
  const expensesAud = pcRound2(exps.reduce((s, e) => s + e.aud, 0));
  const rates = {};
  pcUsedForeignCurrencies().forEach(c => { const r = pcRateOf(c); if(r) rates[c] = r; });
  purchase.costs = {
    overseas, currency: overseas ? pcState.currency : 'AUD', basis: pcState.basis, rates,
    expenses: exps.map(e => { const o = { id: e.id, name: e.name, currency: e.currency, amount: e.amount, rate: e.rate, aud: e.aud }; if(e.estimated){ o.estimated = true; o.estimatedFrom = e.estimatedFrom; } return o; }),
    expensesAud
  };
  pcRecompute(purchase);
}

// 依 purchase.costs 重新算每行總價與合計(送出、編輯進貨單都用這個)。回傳 { error }。
function pcRecompute(purchase){
  const costs = purchase.costs || { expenses: [], expensesAud: 0, basis: 'volume' };
  const rows = (purchase.items || []).map((it, i) => ({
    key: 'r' + i, product: products.find(p => p.id === it.productId), name: it.name, qty: Number(it.qty) || 0,
    amountAud: Number(it.amount) || 0, skip: it.docType === 'credit_note' || it.docType === 'others'
  }));
  const expensesAud = Number(costs.expensesAud) || 0;
  const res = pcAllocate(rows, costs.basis || 'volume', expensesAud);
  if(res.missing.length) return { error: tf('pcErrMissingBasis', { basis: pcBasisLabel(costs.basis || 'volume'), names: res.missing.join('、') }) };
  (purchase.items || []).forEach((it, i) => {
    if(it.docType === 'credit_note' || it.docType === 'others'){ delete it.totalAmount; return; }
    if(it.origCurrency && it.fxRate && it.origAmount !== undefined && Math.abs((Number(it.amount) || 0) - it.origAmount * it.fxRate) > 0.01){
      it.origAmount = pcRound2((Number(it.amount) || 0) / it.fxRate); // 編輯進貨單時直接改了 AUD 金額
    }
    const alloc = res.shares['r' + i] || 0;
    if(expensesAud > 0) it.totalAmount = pcRound2((Number(it.amount) || 0) + alloc);
    else delete it.totalAmount;
  });
  const t0 = pcPurchaseTotals(purchase);
  costs.invoiceAud = t0.base;
  costs.totalAud = t0.total;
  purchase.costs = costs;
  return {};
}

// 進貨單合計(AUD):底價 = 發票品項 − Credit Note;總額 = 底價 + 其他支出
function pcPurchaseTotals(p){
  let base = 0;
  (p.items || []).forEach(it => {
    if(it.docType === 'others') return;
    const a = Number(it.amount) || 0;
    base += (it.docType === 'credit_note') ? -a : a;
  });
  const exp = (p.costs && Number(p.costs.expensesAud)) || 0;
  return { base: pcRound2(base), expenses: pcRound2(exp), total: pcRound2(base + exp) };
}
// 單一品項的底價/總價(AUD),給匯出用:沒有 totalAmount 就等於底價
function pcItemPrices(it){
  const sign = it.docType === 'credit_note' ? -1 : 1;
  const base = (it.amount !== undefined && it.amount !== null && it.amount !== '') ? sign * Number(it.amount) : null;
  const totalRaw = (it.totalAmount !== undefined && it.totalAmount !== null) ? it.totalAmount : it.amount;
  const total = (totalRaw !== undefined && totalRaw !== null && totalRaw !== '') ? sign * Number(totalRaw) : null;
  return { base, total };
}

// ---------- 畫面 ----------
function pcAmountColSuffix(){
  return (typeof pcActive === 'function' && pcActive() && pcState.overseas && pcState.currency !== 'AUD') ? ` (${pcState.currency})` : '';
}
function pcRender(){
  const wrap = document.getElementById('txPurchaseCostsWrap');
  if(!wrap) return;
  const show = typeof currentTxType !== 'undefined' && currentTxType === 'in' && pcActive();
  if(!show){ wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  if(!pcLoaded) pcEnsureLoaded();
  if(!pcDateHooked){
    const d = document.getElementById('txDate');
    if(d){ d.addEventListener('change', () => { if(pcUsedForeignCurrencies().length) pcFetchRates(true); }); pcDateHooked = true; }
  }
  wrap.style.display = '';
  const curOpts = (sel) => pcCurrencies.map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  const foreign = pcUsedForeignCurrencies();
  const exps = pcExpenseRows();
  const dl = `<datalist id="pcExpenseNameList">${pcExpenseNames.map(n => `<option value="${pcEsc(n)}"></option>`).join('')}</datalist>`;

  const expRows = pcState.expenses.map(e => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;">
      <input type="text" list="pcExpenseNameList" value="${pcEsc(e.name)}" placeholder="${t('pcExpenseName')}" style="width:190px;" onchange="pcUpdateExpense('${e.id}','name',this.value)" />
      <select onchange="pcUpdateExpense('${e.id}','currency',this.value)">${curOpts(e.currency)}</select>
      <input type="number" step="0.01" min="0" value="${e.amount === '' ? '' : e.amount}" placeholder="${t('pcExpenseAmount')}" style="width:110px;" onchange="pcUpdateExpense('${e.id}','amount',this.value)" />
      <button class="btn ghost" onclick="pcRemoveExpense('${e.id}')" title="${t('btnDelete')}">✕</button>
      ${e.estimated ? `<span style="color:var(--warn-dark,#b45309);font-size:11.5px;font-weight:600;">⚠ ${tf('pcEstimatedBadge', { date: e.estimatedFrom || '' })}</span>` : ''}
    </div>`).join('');

  const rateRows = foreign.map(cur => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;font-size:12.5px;">
      <span>1 ${cur} =</span>
      <input type="number" step="0.000001" min="0" value="${pcState.rates[cur] || ''}" style="width:120px;" onchange="pcSetRate('${cur}',this.value)" />
      <span>AUD</span>
      <button class="btn ghost" onclick="pcRefetchRate('${cur}')">${t('pcFetchRate')}</button>
      ${pcState.manual[cur] ? `<span style="color:var(--ink-soft);font-size:11.5px;">${t('pcRateManual')}</span>` : ''}
    </div>`).join('');

  // 成本預覽
  let preview = '';
  const expTotal = exps.reduce((s, e) => s + (e.aud || 0), 0);
  if(txBatchItems.length > 0 && (expTotal > 0 || (pcState.overseas && pcState.currency !== 'AUD'))){
    const items = pcMapTxItems();
    const res = pcAllocate(items, pcState.basis, expTotal);
    const lines = items.filter(r => !r.skip).map(r => {
      const alloc = res.shares[r.key] || 0;
      return `<tr><td class="row-name">${pcEsc(r.name)}</td><td class="row-num">${pcFmt(r.amountAud)}</td><td class="row-num">${expTotal > 0 ? pcFmt(alloc) : '–'}</td><td class="row-num"><strong>${pcFmt(r.amountAud + alloc)}</strong></td></tr>`;
    }).join('');
    const fxRate = (pcState.overseas && pcState.currency !== 'AUD') ? (pcRateOf(pcState.currency) || 0) : 1;
    const baseSum = txBatchItems.reduce((s, it) => {
      if(it.docType === 'others' || it.amount === undefined || it.amount === null) return s;
      return s + (it.docType === 'credit_note' ? -1 : 1) * Number(it.amount) * fxRate;
    }, 0);
    preview = `
      <div style="margin-top:8px;">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:4px;">${t('pcPreviewTitle')}</div>
        ${res.missing.length ? `<div style="font-size:12px;color:var(--warn);margin-bottom:4px;">${tf('pcErrMissingBasis', { basis: pcBasisLabel(pcState.basis), names: res.missing.map(pcEsc).join('、') })}</div>` : ''}
        <table class="stock-table"><thead><tr><th>${t('colProduct')}</th><th class="num">${t('pcColBase')}</th><th class="num">${t('pcColAlloc')}</th><th class="num">${t('pcColTotal')}</th></tr></thead><tbody>${lines}</tbody></table>
        <div style="font-size:12.5px;margin-top:4px;">${t('pcInvoiceTotal')}: <strong>${pcFmt(baseSum)}</strong> + ${t('pcExpenseTotal')}: <strong>${pcFmt(expTotal)}</strong> = ${t('pcGrandTotal')}: <strong>${pcFmt(baseSum + expTotal)}</strong> AUD</div>
      </div>`;
  }

  wrap.innerHTML = `
    <div style="border:1px solid var(--line,#ddd);border-radius:8px;padding:10px 12px;margin-top:12px;">
      <div class="section-title" style="font-size:13px;margin:0 0 6px;">${t('pcSectionTitle')}</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;cursor:pointer;">
        <input type="checkbox" ${pcState.overseas ? 'checked' : ''} onchange="pcSetOverseas(this.checked)" style="width:16px;height:16px;" />
        ${t('pcOverseas')}
      </label>
      ${pcState.overseas ? `
      <div style="display:flex;gap:8px;align-items:center;margin:6px 0 0 24px;flex-wrap:wrap;">
        <span style="font-size:12.5px;">${t('pcInvoiceCurrency')}</span>
        <select onchange="pcSetInvoiceCurrency(this.value)">${curOpts(pcState.currency)}</select>
        <span class="del-link" style="cursor:pointer;font-size:12px;" onclick="pcManageOpen=!pcManageOpen;pcRender();">${t('pcManageCurrencies')}</span>
      </div>
      <div style="font-size:11.5px;color:var(--ink-soft);margin:2px 0 0 24px;">${t('pcInvoiceCurrencyHint')}</div>` : `
      <div style="margin:4px 0 0 24px;"><span class="del-link" style="cursor:pointer;font-size:12px;" onclick="pcManageOpen=!pcManageOpen;pcRender();">${t('pcManageCurrencies')}</span></div>`}
      ${pcManageOpen ? `
      <div style="margin:6px 0 0 24px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        ${pcCurrencies.map(c => `<span style="background:var(--bg-soft,#f5f5f0);border-radius:12px;padding:2px 10px;font-size:12px;">${c}${c !== 'AUD' ? ` <span style="cursor:pointer;color:var(--crit);" onclick="pcRemoveCurrency('${c}')">✕</span>` : ''}</span>`).join('')}
        <input id="pcNewCurrency" type="text" maxlength="3" placeholder="${t('pcCurrencyCodePlaceholder')}" style="width:110px;text-transform:uppercase;" />
        <button class="btn ghost" onclick="pcAddCurrency()">${t('pcAddCurrency')}</button>
      </div>` : ''}

      <div style="font-size:12.5px;font-weight:700;margin-top:10px;">${t('pcExpenses')}</div>
      ${pcState.overseas ? `<div style="font-size:11.5px;color:var(--ink-soft);">${t('pcAutoFillHint')}</div>` : ''}
      ${dl}${expRows}
      <button class="btn ghost" onclick="pcAddExpense()" style="margin-top:2px;">${t('pcAddExpense')}</button>

      ${pcState.expenses.length ? `
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <span style="font-size:12.5px;">${t('pcBasis')}</span>
        <select onchange="pcSetBasis(this.value)">
          ${['volume', 'weight', 'boxes', 'amount'].map(b => `<option value="${b}" ${pcState.basis === b ? 'selected' : ''}>${pcBasisLabel(b)}</option>`).join('')}
        </select>
      </div>` : ''}

      ${foreign.length ? `
      <div style="font-size:12.5px;font-weight:700;margin-top:10px;">${t('pcRates')}</div>
      ${rateRows}
      <div style="font-size:11.5px;color:var(--ink-soft);">${t('pcRateSourceNote')}</div>
      ${(pcState.fetchFailed || []).length ? `<div style="font-size:12px;color:var(--warn);">${tf('pcRateFetchFailed', { cur: pcState.fetchFailed.join(', ') })}</div>` : ''}` : ''}
      ${preview}
    </div>`;
}

// ============================================================
// 編輯進貨單:其他支出(例如報關行的正式 invoice 到了,把「預估」改成實際金額)
// 改完儲存時,會依新的支出重算每行總價,並同步更新批次單價。
// ============================================================
let pcEd = null; // { purchaseId, expenses:[{id,name,currency,amount,estimated,estimatedFrom}], basis, rates:{}, overseas, fetchFailed:[] }

function pcEditInit(p){
  if(!pcActive()){ pcEd = null; pcEditRender(); return; }
  const c = p.costs || {};
  pcEd = {
    purchaseId: p.id,
    expenses: (c.expenses || []).map(e => ({ id: e.id || genId(), name: e.name, currency: e.currency || 'AUD', amount: e.amount, estimated: !!e.estimated, estimatedFrom: e.estimatedFrom || '' })),
    basis: c.basis || 'volume',
    rates: Object.assign({}, c.rates || {}),
    overseas: !!c.overseas,
    fetchFailed: []
  };
  (c.expenses || []).forEach(e => { if(e.currency && e.currency !== 'AUD' && e.rate && !pcEd.rates[e.currency]) pcEd.rates[e.currency] = e.rate; });
  if(!pcLoaded) pcEnsureLoaded();
  pcEditRender();
}
function pcEditClose(){ pcEd = null; const w = document.getElementById('editPurchaseCostsWrap'); if(w) w.innerHTML = ''; }
function pcEdRateOf(cur){
  if(!cur || cur === 'AUD') return 1;
  const r = parseFloat(pcEd.rates[cur]);
  return (isFinite(r) && r > 0) ? r : null;
}
function pcEdAdd(){ pcEd.expenses.push({ id: genId(), name: '', currency: 'AUD', amount: '' }); pcEditRender(); }
function pcEdRemove(id){ pcEd.expenses = pcEd.expenses.filter(e => e.id !== id); pcEditRender(); }
function pcEdUpdate(id, field, value){
  const e = pcEd.expenses.find(x => x.id === id);
  if(!e) return;
  if(field === 'amount'){
    const n = parseFloat(value); e.amount = (isFinite(n) && n >= 0) ? n : '';
    e.estimated = false; e.estimatedFrom = ''; // 重新輸入 = 正式金額
  } else e[field] = value;
  pcEditRender();
  if(field === 'currency') pcEdFetchRates(false);
}
function pcEdConfirmFinal(id){
  const e = pcEd.expenses.find(x => x.id === id);
  if(e){ e.estimated = false; e.estimatedFrom = ''; }
  pcEditRender();
}
function pcEdSetBasis(b){ pcEd.basis = b; pcEditRender(); }
function pcEdSetRate(cur, v){
  const n = parseFloat(v);
  pcEd.rates[cur] = (isFinite(n) && n > 0) ? n : '';
  pcEditRender();
}
async function pcEdFetchRates(force){
  const dateEl = document.getElementById('editPurchaseDateInput');
  const dateStr = dateEl ? dateEl.value : '';
  const failed = [];
  const curs = Array.from(new Set(pcEd.expenses.map(e => e.currency).filter(c => c && c !== 'AUD')));
  for(const cur of curs){
    if(!force && pcEdRateOf(cur)) continue;
    const v = await pcFetchRate(cur, dateStr);
    if(v) pcEd.rates[cur] = v; else failed.push(cur);
  }
  pcEd.fetchFailed = failed;
  pcEditRender();
}
function pcEditRender(){
  const wrap = document.getElementById('editPurchaseCostsWrap');
  if(!wrap) return;
  if(!pcEd){ wrap.innerHTML = ''; return; }
  const curOpts = (sel) => pcCurrencies.map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  const dl = `<datalist id="pcEdExpenseNameList">${pcExpenseNames.map(n => `<option value="${pcEsc(n)}"></option>`).join('')}</datalist>`;
  const rows = pcEd.expenses.map(e => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;${e.estimated ? 'background:var(--warn-bg);padding:4px;border-radius:6px;' : ''}">
      <input type="text" list="pcEdExpenseNameList" value="${pcEsc(e.name)}" placeholder="${t('pcExpenseName')}" style="width:170px;" onchange="pcEdUpdate('${e.id}','name',this.value)" />
      <select onchange="pcEdUpdate('${e.id}','currency',this.value)">${curOpts(e.currency)}</select>
      <input type="number" step="0.01" min="0" value="${e.amount === '' || e.amount === undefined ? '' : e.amount}" placeholder="${t('pcExpenseAmount')}" style="width:110px;" onchange="pcEdUpdate('${e.id}','amount',this.value)" />
      <span class="del-link" onclick="pcEdRemove('${e.id}')">✕</span>
      ${e.estimated ? `<span style="color:var(--warn-dark,#b45309);font-size:11.5px;font-weight:600;">⚠ ${tf('pcEstimatedBadge', { date: e.estimatedFrom || '' })}</span>
        <span class="del-link" style="font-size:11.5px;" onclick="pcEdConfirmFinal('${e.id}')">${t('pcMarkFinal')}</span>` : ''}
    </div>`).join('');
  const foreign = Array.from(new Set(pcEd.expenses.map(e => e.currency).filter(c => c && c !== 'AUD')));
  const rateRows = foreign.map(cur => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;font-size:12.5px;flex-wrap:wrap;">
      <span>1 ${cur} =</span>
      <input type="number" step="0.000001" min="0" value="${pcEd.rates[cur] || ''}" style="width:120px;" onchange="pcEdSetRate('${cur}',this.value)" />
      <span>AUD</span>
    </div>`).join('');
  wrap.innerHTML = `
    <div class="field-block" style="border:1px solid var(--line,#ddd);border-radius:8px;padding:8px 10px;">
      <label>${t('pcExpenses')}</label>
      <div style="font-size:11.5px;color:var(--ink-soft);">${t('pcEditHint')}</div>
      ${dl}${rows}
      <button type="button" class="btn ghost" style="font-size:12px;" onclick="pcEdAdd()">${t('pcAddExpense')}</button>
      ${pcEd.expenses.length ? `
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <span style="font-size:12.5px;">${t('pcBasis')}</span>
        <select onchange="pcEdSetBasis(this.value)">${['volume', 'weight', 'boxes', 'amount'].map(b => `<option value="${b}" ${pcEd.basis === b ? 'selected' : ''}>${pcBasisLabel(b)}</option>`).join('')}</select>
      </div>` : ''}
      ${foreign.length ? `<div style="font-size:12.5px;font-weight:700;margin-top:8px;">${t('pcRates')}</div>${rateRows}
        <button type="button" class="btn ghost" style="font-size:12px;" onclick="pcEdFetchRates(true)">${t('pcFetchRate')}</button>` : ''}
      ${(pcEd.fetchFailed || []).length ? `<div style="font-size:12px;color:var(--warn);">${tf('pcRateFetchFailed', { cur: pcEd.fetchFailed.join(', ') })}</div>` : ''}
    </div>`;
}

// 儲存編輯時呼叫:依編輯後的支出建立新的 costs,重算每行總價。
// 回傳 { error, changed }。沒有支出也沒有舊的 costs → 什麼都不做。
function pcEditApply(p, cleanItems){
  const oldCosts = p.costs ? JSON.stringify(p.costs) : '';
  const oldTotals = JSON.stringify((p.items || []).map(i => i.totalAmount === undefined ? null : i.totalAmount));
  if(!pcEd || pcEd.purchaseId !== p.id){
    if(!p.costs) return { changed: false };
    const r = pcRecompute({ items: cleanItems, costs: p.costs });
    return r.error ? r : { changed: JSON.stringify(cleanItems.map(i => i.totalAmount === undefined ? null : i.totalAmount)) !== oldTotals };
  }
  const rows = pcEd.expenses.filter(e => (e.name && e.name.trim()) || (e.amount !== '' && e.amount !== undefined));
  const exps = [];
  for(const e of rows){
    const amt = (e.amount === '' || e.amount === undefined) ? null : Number(e.amount);
    if(!e.name || !e.name.trim() || amt === null || !(amt >= 0)) return { error: t('pcErrExpenseInvalid') };
    const rate = pcEdRateOf(e.currency);
    if(!rate) return { error: tf('pcErrNoRate', { cur: e.currency }) };
    const o = { id: e.id, name: e.name.trim(), currency: e.currency || 'AUD', amount: amt, rate, aud: pcRound2(amt * rate) };
    if(e.estimated){ o.estimated = true; o.estimatedFrom = e.estimatedFrom || ''; }
    exps.push(o);
  }
  if(!exps.length && !p.costs) return { changed: false };
  const rates = {};
  exps.forEach(e => { if(e.currency !== 'AUD') rates[e.currency] = e.rate; });
  const base = p.costs || { overseas: false, currency: 'AUD' };
  const newCosts = Object.assign({}, base, {
    basis: pcEd.basis,
    rates: Object.assign({}, base.rates || {}, rates),
    expenses: exps,
    expensesAud: pcRound2(exps.reduce((s, e) => s + e.aud, 0))
  });
  const r = pcRecompute({ items: cleanItems, costs: newCosts });
  if(r.error) return r;
  p.costs = newCosts;
  const newTotals = JSON.stringify(cleanItems.map(i => i.totalAmount === undefined ? null : i.totalAmount));
  return { changed: JSON.stringify(newCosts) !== oldCosts || newTotals !== oldTotals };
}
// 進貨紀錄清單上的小標記:這張單有「預估」的其他支出,還沒換成正式金額
function pcEstimateBadge(p){
  if(!p || !p.costs || !(p.costs.expenses || []).some(e => e.estimated)) return '';
  return ` <span title="${pcEsc(t('pcEstimatedPurchaseTitle'))}" style="color:var(--warn-dark,#b45309);font-weight:600;font-size:11px;">⚠ ${t('pcEstimatedPurchaseBadge')}</span>`;
}
