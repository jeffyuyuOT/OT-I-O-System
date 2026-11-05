// ============================================================
// purchase-costs.js — 批次追蹤第二期:其他支出分攤 + 海外採購(幣種/匯率)
//
// 資料放在進貨單(purchases.payload):
//   purchase.costs = { overseas, currency, basis, rates:{USD:1.52}, expenses:[{id,name,currency,amount,rate,aud}],
//                      expensesAud, invoiceAud, totalAud }
//   purchase.lineExpenses = [{id,name,amount(AUD),gst,origAmount?,origCurrency?,fxRate?}]  ← 收據(發票)上本來就有的其他支出(例如 fuel levy),
//                      算在供應商發票金額裡;金額併入分攤池一起分攤到商品,但自己不被分攤。costs.lineExpensesAud = 合計
//   purchase.nonStockItems = [{id,name,qty,unit,amount(AUD),gst,orig*?}]  ← 非入庫商品(樣品、少量直接出貨):公司採購、入會計,但不產生入出庫、不進批次、不被分攤
//   purchase.items[i].noAcct = true:這行商品在商品主檔設為「不入公司帳」(只做庫存管理),不計入會計金額/GST、不被分攤
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
let pcDateHooked = false;
let pcPartyHooked = false;
let pcState = pcNewState();

function pcNewState(){
  // 換算幣種固定跟隨「系統預設幣種」(見 settings.js getSystemCurrency,預設 AUD),這裡不能另外選。
  // currency = 發票幣種;rates[cur] = 1 單位 cur 等於多少系統幣種;ratesBase = 這些匯率是對哪個幣種取的
  return { overseas: false, currency: '', rates: {}, ratesBase: '', manual: {}, expenses: [], lineExpenses: [], nonStock: [], basis: 'volume' };
}
function pcActive(){
  return typeof batchActive === 'function' && batchActive() && typeof canEditPrice === 'function' && canEditPrice();
}
function pcBase(){ return (typeof getSystemCurrency === 'function') ? getSystemCurrency() : 'AUD'; }
function pcCurrencyList(){ return Array.from(new Set(['AUD'].concat(pcCurrencies).concat([pcBase()]))); }
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
  try{ await ensurePurchasesLoaded(); }catch(e){}   // 之前輸入過的支出(項目/金額/幣種)從進貨單歷史讀出來當記憶
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
// 常用幣種清單的新增/移除:介面在「系統管理 → 系統設置 → 系統預設幣種」(settings.js),這裡只放邏輯。
function pcAddCurrencyCode(code){
  code = String(code || '').trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(code)) return false;
  if(!pcCurrencies.includes(code)){ pcCurrencies.push(code); pcSaveCurrencies(); }
  pcRender();
  return true;
}
function pcRemoveCurrency(code){
  if(code === 'AUD' || code === pcBase()) return;
  pcCurrencies = pcCurrencies.filter(c => c !== code);
  pcSaveCurrencies();
  if(pcState.currency === code) pcState.currency = pcBase();
  pcState.expenses.forEach(e => { if(e.currency === code) e.currency = pcBase(); });
  pcRender();
}

// ---------- 匯率 ----------
// 1 單位外幣 = ? (換算幣種,預設 AUD)。跟換算幣種相同固定 1;其他幣種沒填回傳 null。
function pcRateOf(cur){
  if(!cur || cur === pcBase()) return 1;
  const r = parseFloat(pcState.rates[cur]);
  return (isFinite(r) && r > 0) ? r : null;
}
function pcUsedForeignCurrencies(){
  const set = new Set();
  const base = pcBase();
  if(pcState.overseas && pcState.currency && pcState.currency !== base) set.add(pcState.currency);
  pcState.expenses.forEach(e => { if(e.currency && e.currency !== base) set.add(e.currency); });
  return Array.from(set);
}
// Frankfurter 沒有 TWD(不管是來源還是換算幣種),TWD 相關改用 open.er-api.com(只有當日匯率)。
// 取不到就回傳 null,讓使用者手動輸入。base = 換算幣種,預設 AUD。
async function pcFetchRate(cur, dateStr, base){
  base = base || 'AUD';
  if(cur === base) return 1;
  try{
    if(cur === 'TWD' || base === 'TWD'){
      const r = await fetch('https://open.er-api.com/v6/latest/' + encodeURIComponent(cur));
      const j = await r.json();
      const v = j && j.rates && j.rates[base];
      return (isFinite(v) && v > 0) ? v : null;
    }
    const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : 'latest';
    const r = await fetch(`https://api.frankfurter.dev/v1/${d}?base=${encodeURIComponent(cur)}&symbols=${encodeURIComponent(base)}`);
    const j = await r.json();
    const v = j && j.rates && j.rates[base];
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
    const v = await pcFetchRate(cur, dateStr, pcBase());
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
// 所有進貨單裡出現過的其他支出(新的在前)
function pcExpenseHistory(excludePurchaseId){
  const out = [];
  if(typeof purchases === 'undefined') return out;
  purchases.forEach(p => {
    if(p.id === excludePurchaseId) return;
    ((p.costs && p.costs.expenses) || []).forEach(e => {
      if(!e.name || e.amount === undefined || e.amount === null) return;
      out.push({ name: e.name.trim(), currency: e.currency || 'AUD', amount: Number(e.amount), date: p.date || '', key: (p.date || '') + '|' + (p.createdAt || ''), supplier: (p.partyName || p.partyId || '').trim(), estimated: !!e.estimated, exp: e });
    });
  });
  out.sort((a, b) => b.key.localeCompare(a.key));
  return out;
}
// 同名項目最近一次的資料:優先同一個供應商,沒有再用其他供應商最近一次。
function pcLastExpenseFor(supplier, name, excludePurchaseId){
  const sup = (supplier || '').trim().toLowerCase(), nm = (name || '').trim().toLowerCase();
  if(!nm) return null;
  const hist = pcExpenseHistory(excludePurchaseId).filter(h => h.name.toLowerCase() === nm);
  if(!hist.length) return null;
  const same = sup ? hist.find(h => h.supplier.toLowerCase() === sup) : null;
  const h = same || hist[0];
  return { key: h.key, exp: h.exp, date: h.date, supplier: h.supplier, sameSupplier: !!same };
}
// 輸入項目名稱時的建議清單:這個供應商用過的在前(顯示上次的幣種/金額/日期),其次其他供應商用過的,最後是記住的名稱。
function pcExpenseSuggestions(supplier, excludePurchaseId){
  const sup = (supplier || '').trim().toLowerCase();
  const hist = pcExpenseHistory(excludePurchaseId);
  const seen = new Map();
  const add = (h, withSupplier) => {
    const k = h.name.toLowerCase();
    if(seen.has(k)) return;
    seen.set(k, { name: h.name, label: `${h.currency} ${h.amount}${h.estimated ? ' ⚠' : ''} · ${withSupplier && h.supplier ? h.supplier + ' ' : ''}${h.date}` });
  };
  if(sup) hist.filter(h => h.supplier.toLowerCase() === sup).forEach(h => add(h, false));
  hist.forEach(h => add(h, true));
  pcExpenseNames.forEach(n => { const k = n.toLowerCase(); if(!seen.has(k)) seen.set(k, { name: n, label: '' }); });
  return Array.from(seen.values());
}
// 付款對象記憶:進貨單裡填過的付款對象(新的在前)
function pcPayeeNames(){
  const out = [], seen = new Set();
  const rows = [];
  if(typeof purchases !== 'undefined') purchases.forEach(p => ((p.costs && p.costs.expenses) || []).forEach(e => { if(e.payee) rows.push({ k: (p.date || '') + '|' + (p.createdAt || ''), n: String(e.payee).trim() }); }));
  rows.sort((a, b) => b.k.localeCompare(a.k));
  rows.forEach(r => { const k = r.n.toLowerCase(); if(r.n && !seen.has(k)){ seen.add(k); out.push(r.n); } });
  return out;
}
// 選了項目名稱 → 帶入同名項目上次的付款對象與 GST(只補空白的)
function pcFillMeta(e, supplier, excludePurchaseId){
  if(!e.name || !e.name.trim()) return false;
  const last = pcLastExpenseFor(supplier, e.name, excludePurchaseId);
  if(!last) return false;
  let ch = false;
  if(!e.payee && last.exp.payee){ e.payee = last.exp.payee; ch = true; }
  if(e.gst !== true && e.gst !== false && (last.exp.gst === true || last.exp.gst === false)){ e.gst = last.exp.gst; ch = true; }
  return ch;
}
function pcExpMetaHtml(e, fn){
  const gstHtml = (typeof paOn === 'function' && paOn() && typeof paGstSelectHtml === 'function') ? paGstSelectHtml(e.gst, `${fn}('${e.id}','gst',this.value==='y'?true:(this.value==='n'?false:''))`) : '';
  return `<input type="text" list="pcPayeeList" value="${pcEsc(e.payee || '')}" placeholder="${pcEsc(t('pcPayeePh'))}" style="width:130px;" onchange="${fn}('${e.id}','payee',this.value)" />${gstHtml}`;
}
function pcNameDatalist(id, supplier, excludePurchaseId){
  return `<datalist id="pcPayeeList">${pcPayeeNames().map(n => `<option value="${pcEsc(n)}"></option>`).join('')}</datalist><datalist id="${id}">${pcExpenseSuggestions(supplier, excludePurchaseId).map(s => `<option value="${pcEsc(s.name)}" label="${pcEsc(s.label ? s.name + ' (' + s.label + ')' : s.name)}"></option>`).join('')}</datalist>`;
}
// 填入成功回傳 true。已有金額、找不到歷史都不動。
// opts.strict:只接受同一供應商的紀錄(送出時沿用用);opts.overseas:海外採購且同供應商 → 標記為「預估」。
function pcFillFromLast(e, supplier, excludePurchaseId, opts){
  opts = opts || {};
  if(!e.name || !e.name.trim() || (e.amount !== '' && e.amount !== undefined && e.amount !== null)) return false;
  const last = pcLastExpenseFor(supplier, e.name, excludePurchaseId);
  if(!last || (opts.strict && !last.sameSupplier)) return false;
  e.amount = Number(last.exp.amount);
  e.currency = last.exp.currency || pcBase();
  if(opts.overseas && last.sameSupplier){ e.estimated = true; e.estimatedFrom = last.date; }
  else { delete e.estimated; delete e.estimatedFrom; }
  return true;
}
// 這個供應商最近一張有其他支出的進貨單的支出清單(給「帶入上次的其他支出」用)
function pcLastExpenseSetFor(supplier, excludePurchaseId){
  const sup = (supplier || '').trim().toLowerCase();
  if(!sup || typeof purchases === 'undefined') return null;
  let best = null;
  purchases.forEach(p => {
    if(p.id === excludePurchaseId) return;
    if((p.partyName || p.partyId || '').trim().toLowerCase() !== sup) return;
    if(!p.costs || !(p.costs.expenses || []).length) return;
    const key = (p.date || '') + '|' + (p.createdAt || '');
    if(!best || key > best.key) best = { key, date: p.date || '', expenses: p.costs.expenses };
  });
  return best;
}
function pcLoadLastSet(){
  const last = pcLastExpenseSetFor(pcSupplierName());
  if(!last) return;
  const have = new Set(pcState.expenses.map(e => (e.name || '').trim().toLowerCase()));
  last.expenses.forEach(e => {
    if(!e.name || have.has(e.name.trim().toLowerCase())) return;
    const row = { id: genId(), name: e.name, currency: e.currency || pcBase(), amount: Number(e.amount) };
    if(e.payee) row.payee = e.payee;
    if(e.gst === true || e.gst === false) row.gst = e.gst;
    if(pcState.overseas){ row.estimated = true; row.estimatedFrom = last.date; }  // 海外採購:沿用上次 = 預估
    pcState.expenses.push(row);
  });
  pcRender();
  pcFetchRates(false);
}
// 送出前:載入進貨單歷史,海外採購且有項目沒填金額 → 沿用上次;再補抓需要的匯率。
async function pcPrepare(){
  if(!pcActive() || !pcState.overseas) return;
  try{ await ensurePurchasesLoaded(); }catch(e){}
  const sup = pcSupplierName();
  let filled = false;
  pcState.expenses.forEach(e => { if(pcFillFromLast(e, sup, undefined, { strict: true, overseas: true })) filled = true; });
  if(filled) await pcFetchRates(false);
}

// ---------- 表單狀態 ----------
function pcSetOverseas(on){
  pcState.overseas = !!on;
  if(!on) pcState.currency = pcBase();
  else if(!pcState.currency || pcState.currency === pcBase()) pcState.currency = pcCurrencyList().find(c => c !== pcBase()) || 'USD';
  pcRender();
  pcFetchRates(false);
}
function pcSetInvoiceCurrency(cur){ pcState.currency = cur; pcRender(); pcFetchRates(false); }
function pcAddExpense(){
  pcState.expenses.push({ id: genId(), name: '', currency: pcBase(), amount: '' });
  pcRender();
}
function pcRemoveExpense(id){ pcState.expenses = pcState.expenses.filter(e => e.id !== id); pcRender(); }
function pcUpdateExpense(id, field, value){
  const e = pcState.expenses.find(x => x.id === id);
  if(!e) return;
  if(field === 'amount'){
    const n = parseFloat(value); e.amount = (isFinite(n) && n >= 0) ? n : '';
    delete e.estimated; delete e.estimatedFrom; // 手動輸入 = 正式金額
  } else if(field === 'gst'){ if(value === true || value === false) e.gst = value; else delete e.gst; }
  else e[field] = value;
  if(field === 'name') pcFillMeta(e, pcSupplierName());
  pcRender();
  if(field === 'currency') pcFetchRates(false);
  if(field === 'name' && (e.amount === '' || e.amount === undefined)){
    // 選了(或輸入了)之前用過的項目 → 帶入上次的幣種與金額(可以再改);海外採購且同供應商 = 標記為預估
    ensurePurchasesLoaded().then(() => {
      if(pcFillFromLast(e, pcSupplierName(), undefined, { overseas: pcState.overseas })){ pcRender(); pcFetchRates(false); }
    }).catch(() => {});
  }
}
function pcSetBasis(b){ pcState.basis = b; pcRender(); }
function pcReset(){ pcState = pcNewState(); pcRender(); }

// ---------- 商品列的其他支出(收據上本來就有的,例如 fuel levy)----------
// 放在進貨單商品清單裡、標示「其他支出」;金額跟商品一樣用發票幣種輸入,送出時換算成系統幣種。
// 它們併入分攤池,和下面「跟此進貨單相關的其他支出」加起來一起分攤到商品上,自己不被分攤。
function pcLineExpOn(){ return pcActive(); }
function pcLineExpenseNames(){
  const set = new Set(pcExpenseNames.slice());
  try{ (purchases || []).forEach(p => (p.lineExpenses || []).forEach(l => { if(l.name) set.add(l.name); })); }catch(e){}
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
function pcAddLineExpense(){
  pcState.lineExpenses.push({ id: genId(), name: '', amount: '' });
  renderTxBatchList();
}
function pcRemoveLineExpense(id){ pcState.lineExpenses = pcState.lineExpenses.filter(l => l.id !== id); renderTxBatchList(); }
function pcUpdateLineExpense(id, field, value){
  const l = pcState.lineExpenses.find(x => x.id === id);
  if(!l) return;
  if(field === 'amount'){ const n = parseFloat(value); l.amount = (isFinite(n) && n >= 0) ? n : ''; }
  else if(field === 'gst'){ if(value === 'y') l.gst = true; else if(value === 'n') l.gst = false; else delete l.gst; }
  else l[field] = value;
  renderTxBatchList();
}
// 金額換算:跟商品列同一個發票幣種與匯率
function pcLineExpRows(){
  const overseas = pcState.overseas && pcState.currency !== pcBase();
  const rate = overseas ? pcRateOf(pcState.currency) : 1;
  return (pcState.lineExpenses || []).map(l => {
    const amt = (l.amount === '' || l.amount === undefined) ? null : Number(l.amount);
    return { id: l.id, name: (l.name || '').trim(), amount: amt, gst: l.gst, aud: (amt !== null && rate) ? pcRound2(amt * rate) : null };
  });
}
function pcLineExpAudTotal(){ return pcLineExpRows().reduce((s, l) => s + (l.aud || 0), 0); }
// 進貨清單表格裡的「其他支出」列。cols = { batch:是否有有效期+位置兩欄, amount, gst }
function pcLineExpenseRowsHtml(cols){
  if(!pcLineExpOn() || !cols.amount) return '';
  const dl = `<datalist id="pcLineExpNameList">${pcLineExpenseNames().map(n => `<option value="${pcEsc(n)}"></option>`).join('')}</datalist>`;
  const rows = (pcState.lineExpenses || []).map(l => `
      <tr style="background:var(--bg-soft,#f5f5f0);">
        <td class="row-name"><input type="text" list="pcLineExpNameList" value="${pcEsc(l.name)}" placeholder="${t('pcLineExpName')}" style="width:min(200px,60vw);" onchange="pcUpdateLineExpense('${l.id}','name',this.value)" /> <span style="color:var(--ink-soft);font-weight:600;font-size:11px;">(${t('pcLineExpBadge')})</span></td>
        <td class="row-num"></td>
        ${cols.batch ? '<td></td><td></td>' : ''}
        <td class="row-num tx-amt" data-label="${t('colAmount')}"><input type="number" class="order-qty-input" step="0.01" min="0" value="${l.amount === '' || l.amount === undefined ? '' : l.amount}" placeholder="–" onchange="pcUpdateLineExpense('${l.id}','amount',this.value)" /></td>
        ${cols.gst ? `<td class="row-num tx-gst" data-label="GST">${paGstSelectHtml(l.gst, "pcUpdateLineExpense('" + l.id + "','gst',this.value)")}</td>` : ''}
        <td class="row-action"><button onclick="pcRemoveLineExpense('${l.id}')" title="${t('btnDelete')}">✕</button></td>
      </tr>`).join('');
  return dl + rows;
}
function pcLineExpenseAddButtonHtml(){
  if(!pcLineExpOn()) return '';
  return `<div style="margin-top:6px;"><button type="button" class="btn ghost" style="font-size:12.5px;" onclick="pcAddLineExpense()">${t('pcAddLineExpense')}</button> <button type="button" class="btn ghost" style="font-size:12.5px;" onclick="pcAddNonStock()">${t('pcAddNonStock')}</button> <span style="font-size:11.5px;color:var(--ink-soft);">${t('pcLineExpHint')}</span></div>`;
}

// ---------- 非入庫商品(樣品、少量直接出貨)----------
// 公司採購、要入會計,但不需要進出庫:不建商品、不產生入庫紀錄、不進批次。金額和數量由使用者直接輸入。
function pcNonStockNames(){
  const set = new Set();
  try{ (purchases || []).forEach(p => (p.nonStockItems || []).forEach(n => { if(n.name) set.add(n.name); })); }catch(e){}
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
function pcAddNonStock(){
  pcState.nonStock.push({ id: genId(), name: '', qty: 1, unit: '', amount: '' });
  renderTxBatchList();
}
function pcRemoveNonStock(id){ pcState.nonStock = pcState.nonStock.filter(n => n.id !== id); renderTxBatchList(); }
function pcUpdateNonStock(id, field, value){
  const n = pcState.nonStock.find(x => x.id === id);
  if(!n) return;
  if(field === 'amount'){ const v = parseFloat(value); n.amount = (isFinite(v) && v >= 0) ? v : ''; }
  else if(field === 'qty'){ const v = parseFloat(value); n.qty = (isFinite(v) && v > 0) ? v : ''; }
  else if(field === 'gst'){ if(value === 'y') n.gst = true; else if(value === 'n') n.gst = false; else delete n.gst; }
  else n[field] = value;
  renderTxBatchList();
}
function pcNonStockRows(){
  const overseas = pcState.overseas && pcState.currency !== pcBase();
  const rate = overseas ? pcRateOf(pcState.currency) : 1;
  return (pcState.nonStock || []).map(n => {
    const amt = (n.amount === '' || n.amount === undefined) ? null : Number(n.amount);
    const qty = (n.qty === '' || n.qty === undefined) ? null : Number(n.qty);
    return { id: n.id, name: (n.name || '').trim(), qty, unit: (n.unit || '').trim(), amount: amt, gst: n.gst, aud: (amt !== null && rate) ? pcRound2(amt * rate) : null };
  });
}
function pcNonStockRowsHtml(cols){
  if(!pcLineExpOn() || !cols.amount) return '';
  const dl = `<datalist id="pcNonStockNameList">${pcNonStockNames().map(n => `<option value="${pcEsc(n)}"></option>`).join('')}</datalist>`;
  const rows = (pcState.nonStock || []).map(n => `
      <tr style="background:var(--bg-soft,#f5f5f0);">
        <td class="row-name"><input type="text" list="pcNonStockNameList" value="${pcEsc(n.name)}" placeholder="${t('pcNonStockName')}" style="width:min(200px,60vw);" onchange="pcUpdateNonStock('${n.id}','name',this.value)" /> <span style="color:var(--ink-soft);font-weight:600;font-size:11px;">(${t('pcNonStockBadge')})</span></td>
        <td class="row-num"><input type="number" class="order-qty-input" step="any" min="0" value="${n.qty === '' || n.qty === undefined ? '' : n.qty}" onchange="pcUpdateNonStock('${n.id}','qty',this.value)" /><input type="text" value="${pcEsc(n.unit || '')}" placeholder="${t('pcNonStockUnit')}" style="width:56px;margin-left:4px;" onchange="pcUpdateNonStock('${n.id}','unit',this.value)" /></td>
        ${cols.batch ? '<td></td><td></td>' : ''}
        <td class="row-num tx-amt" data-label="${t('colAmount')}"><input type="number" class="order-qty-input" step="0.01" min="0" value="${n.amount === '' || n.amount === undefined ? '' : n.amount}" placeholder="–" onchange="pcUpdateNonStock('${n.id}','amount',this.value)" /></td>
        ${cols.gst ? `<td class="row-num tx-gst" data-label="GST">${paGstSelectHtml(n.gst, "pcUpdateNonStock('" + n.id + "','gst',this.value)")}</td>` : ''}
        <td class="row-action"><button onclick="pcRemoveNonStock('${n.id}')" title="${t('btnDelete')}">✕</button></td>
      </tr>`).join('');
  return dl + rows;
}

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
function pcOffBooks(productId){
  const pr = (typeof products !== 'undefined') ? products.find(x => x.id === productId) : null;
  return typeof isOffBooksProduct === 'function' ? isOffBooksProduct(pr) : !!(pr && pr.noAccounting === true);
}
function pcMapTxItems(){
  const overseas = pcState.overseas && pcState.currency !== pcBase();
  const rate = overseas ? pcRateOf(pcState.currency) : 1;
  return txBatchItems.map(it => {
    let prod = products.find(p => p.id === it.productId);
    const offBooks = pcOffBooks(it.productId);
    let qty = Number(it.qty) || 0;
    if(prod && prod.parentId && prod.autoConvertOnStockIn){
      const parent = products.find(p => p.id === prod.parentId);
      qty = qty * (prod.childWeight || 1);
      prod = parent || prod;
    }
    const amountAud = (it.amount !== undefined && it.amount !== null && rate) ? Number(it.amount) * rate : 0;
    return { key: it.batchItemId, product: prod, name: it.name, qty, amountAud, skip: it.docType === 'credit_note' || it.docType === 'others' || offBooks };
  });
}
// 支出列 → 含 rate/aud;金額或匯率有缺回傳 null 的 aud
function pcExpenseRows(){
  return pcState.expenses.map(e => {
    const rate = pcRateOf(e.currency);
    const amt = (e.amount === '' || e.amount === undefined) ? null : Number(e.amount);
    return { id: e.id, name: (e.name || '').trim(), currency: e.currency || pcBase(), amount: amt, rate, payee: (e.payee || '').trim(), gst: (e.gst === true || e.gst === false) ? e.gst : undefined, aud: (amt !== null && rate) ? pcRound2(amt * rate) : null, estimated: !!e.estimated, estimatedFrom: e.estimatedFrom || '' };
  });
}
function pcExpensesAudTotal(){
  return pcExpenseRows().reduce((s, e) => s + (e.aud || 0), 0);
}

// 送出前檢查。回傳錯誤訊息(空字串 = 通過)。
function pcValidate(){
  if(!pcActive()) return '';
  if(pcState.overseas && pcState.currency !== pcBase() && !pcRateOf(pcState.currency)) return tf('pcErrNoRate', { cur: pcState.currency });
  // 完全空白的支出列直接略過;只填一半的擋下
  const rows = pcExpenseRows().filter(e => e.name || e.amount !== null);
  for(const e of rows){
    if(e.name && e.amount === null && pcState.overseas) return tf('pcErrNoHistory', { name: e.name });
    if(!e.name || e.amount === null || !(e.amount >= 0)) return t('pcErrExpenseInvalid');
    if(!e.rate) return tf('pcErrNoRate', { cur: e.currency });
    if(typeof paOn === 'function' && paOn() && e.amount > 0 && e.gst !== true && e.gst !== false) return tf('pcErrExpNeedGst', { name: e.name });
  }
  // 商品列的其他支出:名稱和金額要一起填;完全空白的列略過
  const lineRows = pcLineExpRows().filter(l => l.name || l.amount !== null);
  for(const l of lineRows){
    if(!l.name || l.amount === null || !(l.amount >= 0)) return t('pcErrLineExpInvalid');
  }
  const nsRows = pcNonStockRows().filter(n => n.name || n.amount !== null);
  for(const n of nsRows){
    if(!n.name || n.amount === null || !(n.amount >= 0) || !(n.qty > 0)) return t('pcErrNonStockInvalid');
  }
  const total = rows.reduce((s, e) => s + (e.aud || 0), 0) + lineRows.reduce((s, l) => s + (l.aud || 0), 0);
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
  const base = pcBase();
  const overseas = pcState.overseas && pcState.currency !== base;
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
  const ns = pcNonStockRows().filter(n => n.name && n.aud !== null);
  if(ns.length){
    purchase.nonStockItems = ns.map(n => {
      const o = { id: n.id, name: n.name, qty: n.qty, unit: n.unit, amount: n.aud };
      if(n.gst === true || n.gst === false) o.gst = n.gst;
      if(overseas){ o.origAmount = n.amount; o.origCurrency = pcState.currency; o.fxRate = rate; }
      return o;
    });
  } else delete purchase.nonStockItems;
  const lines = pcLineExpRows().filter(l => l.name && l.aud !== null);
  if(lines.length){
    purchase.lineExpenses = lines.map(l => {
      const o = { id: l.id, name: l.name, amount: l.aud };
      if(l.gst === true || l.gst === false) o.gst = l.gst;
      if(overseas){ o.origAmount = l.amount; o.origCurrency = pcState.currency; o.fxRate = rate; }
      return o;
    });
  } else delete purchase.lineExpenses;
  purchase.costs = {
    overseas, currency: overseas ? pcState.currency : base, baseCurrency: base, basis: pcState.basis, rates,
    expenses: exps.map(e => { const o = { id: e.id, name: e.name, currency: e.currency, amount: e.amount, rate: e.rate, aud: e.aud }; if(e.payee) o.payee = e.payee; if(e.gst === true || e.gst === false) o.gst = e.gst; if(e.estimated){ o.estimated = true; o.estimatedFrom = e.estimatedFrom; } return o; }),
    expensesAud
  };
  pcRecompute(purchase);
}

// 依 purchase.costs 重新算每行總價與合計(送出、編輯進貨單都用這個)。回傳 { error }。
function pcRecompute(purchase){
  const costs = purchase.costs || { expenses: [], expensesAud: 0, basis: 'volume' };
  const rows = (purchase.items || []).map((it, i) => ({
    key: 'r' + i, product: products.find(p => p.id === it.productId), name: it.name, qty: Number(it.qty) || 0,
    amountAud: Number(it.amount) || 0, skip: it.docType === 'credit_note' || it.docType === 'others' || !!it.noAcct
  }));
  const lineAud = pcRound2((purchase.lineExpenses || []).reduce((s, l) => s + (Number(l.amount) || 0), 0));
  costs.lineExpensesAud = lineAud;
  // 分攤池 = 商品列的其他支出 + 跟此進貨單相關的其他支出;兩者加起來一起分攤到發票商品
  const expensesAud = pcRound2((Number(costs.expensesAud) || 0) + lineAud);
  const res = pcAllocate(rows, costs.basis || 'volume', expensesAud);
  if(res.missing.length) return { error: tf('pcErrMissingBasis', { basis: pcBasisLabel(costs.basis || 'volume'), names: res.missing.join('、') }) };
  (purchase.items || []).forEach((it, i) => {
    if(it.docType === 'credit_note' || it.docType === 'others' || it.noAcct){ delete it.totalAmount; return; }
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
    if(it.docType === 'others' || it.noAcct) return;   // noAcct = 不入公司帳的商品
    const a = Number(it.amount) || 0;
    base += (it.docType === 'credit_note') ? -a : a;
  });
  (p.nonStockItems || []).forEach(n => { base += Number(n.amount) || 0; });   // 非入庫商品是公司採購,算在發票商品合計
  const rel = (p.costs && Number(p.costs.expensesAud)) || 0;
  const line = (p.lineExpenses || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  // expenses = 兩種其他支出合計(給只要看「其他支出」總數的畫面用);另附分開的數字
  return { base: pcRound2(base), lineExpenses: pcRound2(line), relatedExpenses: pcRound2(rel), expenses: pcRound2(rel + line), total: pcRound2(base + rel + line) };
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
  return (typeof pcActive === 'function' && pcActive() && pcState.overseas && pcState.currency !== pcBase()) ? ` (${pcState.currency})` : '';
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
  if(!pcPartyHooked){
    const sp = document.getElementById('txParty');
    if(sp){ sp.addEventListener('change', () => pcRender()); pcPartyHooked = true; }   // 換供應商 → 建議清單與「帶入上次」按鈕跟著更新
  }
  wrap.style.display = '';
  // 系統預設幣種改了 → 之前取的匯率(對舊幣種)作廢
  if(pcState.ratesBase !== pcBase()){ pcState.rates = {}; pcState.manual = {}; pcState.fetchFailed = []; pcState.ratesBase = pcBase(); if(pcState.overseas && pcState.currency === pcBase()) pcState.currency = pcCurrencyList().find(c => c !== pcBase()) || 'USD'; setTimeout(() => { if(pcUsedForeignCurrencies().length) pcFetchRates(false); }, 0); }
  const curOpts = (sel) => pcCurrencyList().map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  const foreign = pcUsedForeignCurrencies();
  const exps = pcExpenseRows();
  const supplierNow = pcSupplierName();
  const dl = pcNameDatalist('pcExpenseNameList', supplierNow);
  const lastSet = pcLastExpenseSetFor(supplierNow);

  const expRows = pcState.expenses.map(e => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;">
      <input type="text" list="pcExpenseNameList" value="${pcEsc(e.name)}" placeholder="${t('pcExpenseName')}" style="width:190px;" onchange="pcUpdateExpense('${e.id}','name',this.value)" />
      <select onchange="pcUpdateExpense('${e.id}','currency',this.value)">${curOpts(e.currency)}</select>
      <input type="number" step="0.01" min="0" value="${e.amount === '' ? '' : e.amount}" placeholder="${t('pcExpenseAmount')}" style="width:110px;" onchange="pcUpdateExpense('${e.id}','amount',this.value)" />
      ${pcExpMetaHtml(e, 'pcUpdateExpense')}
      <button class="btn ghost" onclick="pcRemoveExpense('${e.id}')" title="${t('btnDelete')}">✕</button>
      ${e.estimated ? `<span style="color:var(--warn-dark,#b45309);font-size:11.5px;font-weight:600;">⚠ ${tf('pcEstimatedBadge', { date: e.estimatedFrom || '' })}</span>` : ''}
    </div>`).join('');

  const base = pcBase();
  // 匯率輸入:1 單位外幣 = ? 換算幣種
  const rateInline = (cur) => `
      <span style="font-size:12.5px;">1 ${cur} =</span>
      <input type="number" step="0.000001" min="0" value="${pcState.rates[cur] || ''}" style="width:120px;" onchange="pcSetRate('${cur}',this.value)" />
      <span style="font-size:12.5px;">${base}</span>
      <button class="btn ghost" onclick="pcRefetchRate('${cur}')">${t('pcFetchRate')}</button>
      ${pcState.manual[cur] ? `<span style="color:var(--ink-soft);font-size:11.5px;">${t('pcRateManual')}</span>` : ''}`;
  // 發票幣種的匯率直接放在發票幣種旁邊;其他支出用到的其他外幣另外列在支出下方
  const invoiceForeign = (pcState.overseas && pcState.currency !== base) ? pcState.currency : null;
  const otherForeign = foreign.filter(c => c !== invoiceForeign);
  const rateRows = otherForeign.map(cur => `<div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;">${rateInline(cur)}</div>`).join('');

  // 成本預覽
  let preview = '';
  const relTotal = exps.reduce((s, e) => s + (e.aud || 0), 0);
  const lineTotal = pcLineExpAudTotal();
  const expTotal = pcRound2(relTotal + lineTotal);   // 分攤池 = 商品列其他支出 + 相關其他支出
  if(txBatchItems.length > 0 && (expTotal > 0 || (pcState.overseas && pcState.currency !== pcBase()))){
    const items = pcMapTxItems();
    const res = pcAllocate(items, pcState.basis, expTotal);
    const lines = items.filter(r => !r.skip).map(r => {
      const alloc = res.shares[r.key] || 0;
      return `<tr><td class="row-name">${pcEsc(r.name)}</td><td class="row-num">${pcFmt(r.amountAud)}</td><td class="row-num">${expTotal > 0 ? pcFmt(alloc) : '–'}</td><td class="row-num"><strong>${pcFmt(r.amountAud + alloc)}</strong></td></tr>`;
    }).join('');
    const fxRate = (pcState.overseas && pcState.currency !== pcBase()) ? (pcRateOf(pcState.currency) || 0) : 1;
    const baseSum = txBatchItems.reduce((s, it) => {
      if(it.docType === 'others' || it.amount === undefined || it.amount === null) return s;
      return s + (it.docType === 'credit_note' ? -1 : 1) * Number(it.amount) * fxRate;
    }, 0);
    preview = `
      <div style="margin-top:8px;">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:4px;">${tf('pcPreviewTitle', { base })}</div>
        ${res.missing.length ? `<div style="font-size:12px;color:var(--warn);margin-bottom:4px;">${tf('pcErrMissingBasis', { basis: pcBasisLabel(pcState.basis), names: res.missing.map(pcEsc).join('、') })}</div>` : ''}
        <table class="stock-table"><thead><tr><th>${t('colProduct')}</th><th class="num">${t('pcColBase')}</th><th class="num">${t('pcColAlloc')}</th><th class="num">${t('pcColTotal')}</th></tr></thead><tbody>${lines}</tbody></table>
        <div style="font-size:12.5px;margin-top:4px;">${t('pcInvoiceTotal')}: <strong>${pcFmt(baseSum)}</strong>${lineTotal > 0 ? ` + ${t('pcLineExpTotal')}: <strong>${pcFmt(lineTotal)}</strong>` : ''} + ${t('pcExpenseTotal')}: <strong>${pcFmt(relTotal)}</strong> = ${t('pcGrandTotal')}: <strong>${pcFmt(baseSum + expTotal)}</strong> ${base}</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-top:2px;">${t('pcPoolNote')}</div>
      </div>`;
  }

  wrap.innerHTML = `
    <div style="border:1px solid var(--line,#ddd);border-radius:8px;padding:10px 12px;margin-top:12px;">
      <div class="section-title" style="font-size:13px;margin:0 0 6px;">${t('pcSectionTitle')}</div>
      <div style="display:flex;gap:8px 12px;align-items:center;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;">
          <input type="checkbox" ${pcState.overseas ? 'checked' : ''} onchange="pcSetOverseas(this.checked)" style="width:16px;height:16px;" />
          ${t('pcOverseas')}
        </label>
        ${pcState.overseas ? `
        <span style="font-size:12.5px;">${t('pcInvoiceCurrency')}</span>
        <select onchange="pcSetInvoiceCurrency(this.value)">${curOpts(pcState.currency)}</select>
        <span style="font-size:12.5px;color:var(--ink-soft);">${tf('pcConvertToFixed', { base })}</span>
        ${invoiceForeign ? rateInline(invoiceForeign) : ''}` : ''}
      </div>
      ${pcState.overseas ? `<div style="font-size:11.5px;color:var(--ink-soft);margin:2px 0 0 24px;">${tf('pcInvoiceCurrencyHint', { base })}</div>` : ''}

      <div style="font-size:12.5px;font-weight:700;margin-top:10px;">${t('pcExpenses')} <span role="button" tabindex="0" title="${t('pcInfoIconTitle')}" aria-label="${t('pcInfoIconTitle')}" style="cursor:pointer;color:var(--ink-soft);font-size:14px;font-weight:400;margin-left:4px;user-select:none;" onclick="showInfoModal(t('pcAutoFillHint'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showInfoModal(t('pcAutoFillHint'));}">ⓘ</span></div>
      ${dl}${expRows}
      <button class="btn ghost" onclick="pcAddExpense()" style="margin-top:2px;">${t('pcAddExpense')}</button>
      ${lastSet ? `<button class="btn ghost" onclick="pcLoadLastSet()" style="margin-top:2px;">${tf('pcLoadLastSet', { supplier: pcEsc(supplierNow), date: lastSet.date })}</button>` : ''}

      ${(pcState.expenses.length || (pcState.lineExpenses || []).length) ? `
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <span style="font-size:12.5px;">${t('pcBasis')}</span>
        <select onchange="pcSetBasis(this.value)">
          ${['volume', 'weight', 'boxes', 'amount'].map(b => `<option value="${b}" ${pcState.basis === b ? 'selected' : ''}>${pcBasisLabel(b)}</option>`).join('')}
        </select>
      </div>` : ''}

      ${otherForeign.length ? `
      <div style="font-size:12.5px;font-weight:700;margin-top:10px;">${tf('pcRates', { base })}</div>
      ${rateRows}` : ''}
      ${foreign.length ? `<div style="font-size:11.5px;color:var(--ink-soft);margin-top:4px;">${t('pcRateSourceNote')}</div>
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
    base: c.baseCurrency || pcBase(),
    expenses: (c.expenses || []).map(e => ({ id: e.id || genId(), name: e.name, currency: e.currency || c.baseCurrency || 'AUD', amount: e.amount, estimated: !!e.estimated, estimatedFrom: e.estimatedFrom || '', payee: e.payee || '', gst: e.gst })),
    lineExpenses: (p.lineExpenses || []).map(l => ({ id: l.id || genId(), name: l.name, amount: l.amount, gst: l.gst, origAmount: l.origAmount, origCurrency: l.origCurrency, fxRate: l.fxRate })),
    nonStock: (p.nonStockItems || []).map(n => ({ id: n.id || genId(), name: n.name, qty: n.qty, unit: n.unit || '', amount: n.amount, gst: n.gst, origAmount: n.origAmount, origCurrency: n.origCurrency, fxRate: n.fxRate })),
    basis: c.basis || 'volume',
    rates: Object.assign({}, c.rates || {}),
    overseas: !!c.overseas,
    fetchFailed: [],
    // 舊進貨單原本用外幣(例如台幣)輸入、當成澳幣存下來:可以在編輯時轉成海外採購(金額 × 匯率 = 澳幣)
    convert: { available: !c.overseas && !(p.items || []).some(it => it.origCurrency), on: false, currency: '' }
  };
  (c.expenses || []).forEach(e => { if(e.currency && e.currency !== pcEd.base && e.rate && !pcEd.rates[e.currency]) pcEd.rates[e.currency] = e.rate; });
  if(!pcLoaded) pcEnsureLoaded();
  pcEditRender();
}
function pcEditClose(){ pcEd = null; const w = document.getElementById('editPurchaseCostsWrap'); if(w) w.innerHTML = ''; }
function pcEdRateOf(cur){
  if(!cur || cur === pcEd.base) return 1;
  const r = parseFloat(pcEd.rates[cur]);
  return (isFinite(r) && r > 0) ? r : null;
}
function pcEdAdd(){ pcEd.expenses.push({ id: genId(), name: '', currency: pcEd.base, amount: '' }); pcEditRender(); }
function pcEdRemove(id){ pcEd.expenses = pcEd.expenses.filter(e => e.id !== id); pcEditRender(); }
function pcEdUpdate(id, field, value){
  const e = pcEd.expenses.find(x => x.id === id);
  if(!e) return;
  if(field === 'amount'){
    const n = parseFloat(value); e.amount = (isFinite(n) && n >= 0) ? n : '';
    e.estimated = false; e.estimatedFrom = ''; // 重新輸入 = 正式金額
  } else if(field === 'gst'){ if(value === true || value === false) e.gst = value; else delete e.gst; }
  else e[field] = value;
  if(field === 'name'){ const pp = (typeof purchases !== 'undefined') ? purchases.find(x => x.id === pcEd.purchaseId) : null; pcFillMeta(e, pp ? (pp.partyName || pp.partyId || '') : '', pcEd.purchaseId); }
  pcEditRender();
  if(field === 'currency') pcEdFetchRates(false);
  if(field === 'name' && (e.amount === '' || e.amount === undefined)){
    // 選了之前用過的項目 → 帶入上次的幣種與金額(可以再改)
    const p = (typeof purchases !== 'undefined') ? purchases.find(x => x.id === pcEd.purchaseId) : null;
    if(pcFillFromLast(e, p ? (p.partyName || p.partyId || '') : '', pcEd.purchaseId, { overseas: !!pcEd.overseas })){ pcEditRender(); pcEdFetchRates(false); }
  }
}
function pcEdConfirmFinal(id){
  const e = pcEd.expenses.find(x => x.id === id);
  if(e){ e.estimated = false; e.estimatedFrom = ''; }
  pcEditRender();
}
function pcEdAddLine(){ pcEd.lineExpenses.push({ id: genId(), name: '', amount: '' }); pcEditRender(); }
function pcEdRemoveLine(id){ pcEd.lineExpenses = pcEd.lineExpenses.filter(l => l.id !== id); pcEditRender(); }
function pcEdUpdateLine(id, field, value){
  const l = pcEd.lineExpenses.find(x => x.id === id);
  if(!l) return;
  if(field === 'amount'){ const n = parseFloat(value); l.amount = (isFinite(n) && n >= 0) ? n : ''; }
  else if(field === 'gst'){ if(value === 'y') l.gst = true; else if(value === 'n') l.gst = false; else delete l.gst; }
  else l[field] = value;
  pcEditRender();
}
function pcEdAddNs(){ pcEd.nonStock.push({ id: genId(), name: '', qty: 1, unit: '', amount: '' }); pcEditRender(); }
function pcEdRemoveNs(id){ pcEd.nonStock = pcEd.nonStock.filter(n => n.id !== id); pcEditRender(); }
function pcEdUpdateNs(id, field, value){
  const n = pcEd.nonStock.find(x => x.id === id);
  if(!n) return;
  if(field === 'amount'){ const v = parseFloat(value); n.amount = (isFinite(v) && v >= 0) ? v : ''; }
  else if(field === 'qty'){ const v = parseFloat(value); n.qty = (isFinite(v) && v > 0) ? v : ''; }
  else if(field === 'gst'){ if(value === 'y') n.gst = true; else if(value === 'n') n.gst = false; else delete n.gst; }
  else n[field] = value;
  pcEditRender();
}
function pcEdConvToggle(on){
  const cv = pcEd.convert; cv.on = !!on;
  if(on && !cv.currency){ const l = pcCurrencyList().filter(c => c !== pcEd.base); cv.currency = l.includes('TWD') ? 'TWD' : (l[0] || ''); }
  pcEditRender();
  if(on) pcEdFetchRates(false);
}
function pcEdConvCur(cur){ pcEd.convert.currency = cur; pcEditRender(); pcEdFetchRates(false); }
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
  const curs = Array.from(new Set(pcEd.expenses.map(e => e.currency).filter(c => c && c !== pcEd.base)));
  if(pcEd.convert && pcEd.convert.on && pcEd.convert.currency && !curs.includes(pcEd.convert.currency)) curs.push(pcEd.convert.currency);
  for(const cur of curs){
    if(!force && pcEdRateOf(cur)) continue;
    const v = await pcFetchRate(cur, dateStr, pcEd.base);
    if(v) pcEd.rates[cur] = v; else failed.push(cur);
  }
  pcEd.fetchFailed = failed;
  pcEditRender();
}
function pcEditRender(){
  const wrap = document.getElementById('editPurchaseCostsWrap');
  if(!wrap) return;
  if(!pcEd){ wrap.innerHTML = ''; return; }
  const curOpts = (sel) => pcCurrencyList().map(c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  const edPurchase = (typeof purchases !== 'undefined') ? purchases.find(x => x.id === pcEd.purchaseId) : null;
  const dl = pcNameDatalist('pcEdExpenseNameList', edPurchase ? (edPurchase.partyName || edPurchase.partyId || '') : '', pcEd.purchaseId);
  const rows = pcEd.expenses.map(e => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;${e.estimated ? 'background:var(--warn-bg);padding:4px;border-radius:6px;' : ''}">
      <input type="text" list="pcEdExpenseNameList" value="${pcEsc(e.name)}" placeholder="${t('pcExpenseName')}" style="width:170px;" onchange="pcEdUpdate('${e.id}','name',this.value)" />
      <select onchange="pcEdUpdate('${e.id}','currency',this.value)">${curOpts(e.currency)}</select>
      <input type="number" step="0.01" min="0" value="${e.amount === '' || e.amount === undefined ? '' : e.amount}" placeholder="${t('pcExpenseAmount')}" style="width:110px;" onchange="pcEdUpdate('${e.id}','amount',this.value)" />
      ${pcExpMetaHtml(e, 'pcEdUpdate')}
      <span class="del-link" onclick="pcEdRemove('${e.id}')">✕</span>
      ${e.estimated ? `<span style="color:var(--warn-dark,#b45309);font-size:11.5px;font-weight:600;">⚠ ${tf('pcEstimatedBadge', { date: e.estimatedFrom || '' })}</span>
        <span class="del-link" style="font-size:11.5px;" onclick="pcEdConfirmFinal('${e.id}')">${t('pcMarkFinal')}</span>` : ''}
    </div>`).join('');
  const cvOn = !!(pcEd.convert && pcEd.convert.on);
  const foreign = Array.from(new Set(pcEd.expenses.map(e => e.currency).filter(c => c && c !== pcEd.base && !(cvOn && c === pcEd.convert.currency))));
  const convHtml = (pcEd.convert && pcEd.convert.available) ? `
    <div style="border-bottom:1px dashed var(--line,#ddd);margin-bottom:8px;padding-bottom:8px;">
      <label style="display:flex;gap:6px;align-items:center;font-weight:600;"><input type="checkbox" ${cvOn ? 'checked' : ''} onchange="pcEdConvToggle(this.checked)" /> ${t('pcEdConvLabel')}</label>
      ${cvOn ? `<div style="display:flex;gap:6px;align-items:center;margin:6px 0 2px;flex-wrap:wrap;font-size:12.5px;">
        <select onchange="pcEdConvCur(this.value)">${pcCurrencyList().filter(c => c !== pcEd.base).map(c => `<option value="${c}" ${c === pcEd.convert.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <span>1 ${pcEsc(pcEd.convert.currency)} =</span>
        <input type="number" step="0.000001" min="0" value="${pcEd.rates[pcEd.convert.currency] || ''}" style="width:120px;" onchange="pcEdSetRate('${pcEd.convert.currency}',this.value)" />
        <span>${pcEsc(pcEd.base)}</span>
        <button type="button" class="btn ghost" style="font-size:12px;" onclick="pcEdFetchRates(true)">${t('pcFetchRate')}</button>
      </div>
      <div style="font-size:11.5px;color:var(--warn-dark,#b45309);">${tf('pcEdConvHint', { cur: pcEsc(pcEd.convert.currency) })}</div>` : `<div style="font-size:11.5px;color:var(--ink-soft);">${t('pcEdConvNote')}</div>`}
    </div>` : '';
  const rateRows = foreign.map(cur => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;font-size:12.5px;flex-wrap:wrap;">
      <span>1 ${cur} =</span>
      <input type="number" step="0.000001" min="0" value="${pcEd.rates[cur] || ''}" style="width:120px;" onchange="pcEdSetRate('${cur}',this.value)" />
      <span>${pcEd.base}</span>
    </div>`).join('');
  const lineRowsEd = (pcEd.lineExpenses || []).map(l => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;">
      <input type="text" value="${pcEsc(l.name)}" placeholder="${t('pcLineExpName')}" style="width:170px;" onchange="pcEdUpdateLine('${l.id}','name',this.value)" />
      <input type="number" step="0.01" min="0" value="${l.amount === '' || l.amount === undefined ? '' : l.amount}" placeholder="${t('pcExpenseAmount')}" style="width:110px;" onchange="pcEdUpdateLine('${l.id}','amount',this.value)" />
      <span style="font-size:12px;">${pcEsc(pcEd.base)}</span>
      ${(typeof paGstSelectHtml === 'function') ? paGstSelectHtml(l.gst, "pcEdUpdateLine('" + l.id + "','gst',this.value)") : ''}
      <span class="del-link" onclick="pcEdRemoveLine('${l.id}')">✕</span>
    </div>`).join('');
  const nsRowsEd = (pcEd.nonStock || []).map(n => `
    <div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap;">
      <input type="text" value="${pcEsc(n.name)}" placeholder="${t('pcNonStockName')}" style="width:170px;" onchange="pcEdUpdateNs('${n.id}','name',this.value)" />
      <input type="number" step="any" min="0" value="${n.qty === '' || n.qty === undefined ? '' : n.qty}" style="width:70px;" onchange="pcEdUpdateNs('${n.id}','qty',this.value)" />
      <input type="text" value="${pcEsc(n.unit || '')}" placeholder="${t('pcNonStockUnit')}" style="width:56px;" onchange="pcEdUpdateNs('${n.id}','unit',this.value)" />
      <input type="number" step="0.01" min="0" value="${n.amount === '' || n.amount === undefined ? '' : n.amount}" placeholder="${t('pcExpenseAmount')}" style="width:100px;" onchange="pcEdUpdateNs('${n.id}','amount',this.value)" />
      <span style="font-size:12px;">${pcEsc(pcEd.base)}</span>
      ${(typeof paGstSelectHtml === 'function') ? paGstSelectHtml(n.gst, "pcEdUpdateNs('" + n.id + "','gst',this.value)") : ''}
      <span class="del-link" onclick="pcEdRemoveNs('${n.id}')">✕</span>
    </div>`).join('');
  wrap.innerHTML = `
    <div class="field-block" style="border:1px solid var(--line,#ddd);border-radius:8px;padding:8px 10px;">
      ${convHtml}
      <label>${t('pcNonStockTitle')}</label>
      ${nsRowsEd}
      <button type="button" class="btn ghost" style="font-size:12px;margin-bottom:10px;" onclick="pcEdAddNs()">${t('pcAddNonStock')}</button>
      <label style="display:block;">${t('pcLineExpTitle')}</label>
      ${lineRowsEd}
      <button type="button" class="btn ghost" style="font-size:12px;margin-bottom:10px;" onclick="pcEdAddLine()">${t('pcAddLineExpense')}</button>
      <label style="display:block;">${t('pcExpenses')} <span role="button" tabindex="0" title="${t('pcInfoIconTitle')}" aria-label="${t('pcInfoIconTitle')}" style="cursor:pointer;color:var(--ink-soft);font-size:14px;margin-left:4px;user-select:none;" onclick="showInfoModal(t('pcEditHint'))" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showInfoModal(t('pcEditHint'));}">ⓘ</span></label>
      ${dl}${rows}
      <button type="button" class="btn ghost" style="font-size:12px;" onclick="pcEdAdd()">${t('pcAddExpense')}</button>
      ${(pcEd.expenses.length || (pcEd.lineExpenses || []).length) ? `
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <span style="font-size:12.5px;">${t('pcBasis')}</span>
        <select onchange="pcEdSetBasis(this.value)">${['volume', 'weight', 'boxes', 'amount'].map(b => `<option value="${b}" ${pcEd.basis === b ? 'selected' : ''}>${pcBasisLabel(b)}</option>`).join('')}</select>
      </div>` : ''}
      ${foreign.length ? `<div style="font-size:12.5px;font-weight:700;margin-top:8px;">${tf('pcRates', { base: pcEd.base })}</div>${rateRows}
        <button type="button" class="btn ghost" style="font-size:12px;" onclick="pcEdFetchRates(true)">${t('pcFetchRate')}</button>` : ''}
      ${(pcEd.fetchFailed || []).length ? `<div style="font-size:12px;color:var(--warn);">${tf('pcRateFetchFailed', { cur: pcEd.fetchFailed.join(', ') })}</div>` : ''}
    </div>`;
}

// 儲存編輯時呼叫:依編輯後的支出建立新的 costs,重算每行總價。
// 回傳 { error, changed }。沒有支出也沒有舊的 costs → 什麼都不做。
function pcEditApply(p, cleanItems){
  const oldCosts = p.costs ? JSON.stringify(p.costs) : '';
  const oldLines = JSON.stringify(p.lineExpenses || []);
  const oldNs = JSON.stringify(p.nonStockItems || []);
  const oldTotals = JSON.stringify((p.items || []).map(i => i.totalAmount === undefined ? null : i.totalAmount));
  if(!pcEd || pcEd.purchaseId !== p.id){
    if(!p.costs) return { changed: false };
    const r = pcRecompute({ items: cleanItems, costs: p.costs, lineExpenses: p.lineExpenses, nonStockItems: p.nonStockItems });
    return r.error ? r : { changed: JSON.stringify(cleanItems.map(i => i.totalAmount === undefined ? null : i.totalAmount)) !== oldTotals };
  }
  const rows = pcEd.expenses.filter(e => (e.name && e.name.trim()) || (e.amount !== '' && e.amount !== undefined));
  const exps = [];
  for(const e of rows){
    const amt = (e.amount === '' || e.amount === undefined) ? null : Number(e.amount);
    if(!e.name || !e.name.trim() || amt === null || !(amt >= 0)) return { error: t('pcErrExpenseInvalid') };
    const rate = pcEdRateOf(e.currency);
    if(!rate) return { error: tf('pcErrNoRate', { cur: e.currency }) };
    if(typeof paOn === 'function' && paOn() && amt > 0 && e.gst !== true && e.gst !== false) return { error: tf('pcErrExpNeedGst', { name: e.name.trim() }) };
    const o = { id: e.id, name: e.name.trim(), currency: e.currency || pcEd.base, amount: amt, rate, aud: pcRound2(amt * rate) };
    if((e.payee || '').trim()) o.payee = e.payee.trim();
    if(e.gst === true || e.gst === false) o.gst = e.gst;
    if(e.estimated){ o.estimated = true; o.estimatedFrom = e.estimatedFrom || ''; }
    exps.push(o);
  }
  const lineRowsIn = (pcEd.lineExpenses || []).filter(l => (l.name && l.name.trim()) || (l.amount !== '' && l.amount !== undefined));
  const lines = [];
  for(const l of lineRowsIn){
    const amt = (l.amount === '' || l.amount === undefined) ? null : Number(l.amount);
    if(!l.name || !l.name.trim() || amt === null || !(amt >= 0)) return { error: t('pcErrLineExpInvalid') };
    const o = { id: l.id, name: l.name.trim(), amount: pcRound2(amt) };
    if(l.gst === true || l.gst === false) o.gst = l.gst;
    if(l.origCurrency && l.fxRate){ o.origCurrency = l.origCurrency; o.fxRate = l.fxRate; o.origAmount = pcRound2(amt / l.fxRate); }
    lines.push(o);
  }
  const nsIn = (pcEd.nonStock || []).filter(n => (n.name && n.name.trim()) || (n.amount !== '' && n.amount !== undefined));
  const nsItems = [];
  for(const n of nsIn){
    const amt = (n.amount === '' || n.amount === undefined) ? null : Number(n.amount);
    const qty = (n.qty === '' || n.qty === undefined) ? null : Number(n.qty);
    if(!n.name || !n.name.trim() || amt === null || !(amt >= 0) || !(qty > 0)) return { error: t('pcErrNonStockInvalid') };
    const o = { id: n.id, name: n.name.trim(), qty, unit: (n.unit || '').trim(), amount: pcRound2(amt) };
    if(n.gst === true || n.gst === false) o.gst = n.gst;
    if(n.origCurrency && n.fxRate){ o.origCurrency = n.origCurrency; o.fxRate = n.fxRate; o.origAmount = pcRound2(amt / n.fxRate); }
    nsItems.push(o);
  }
  const cv = pcEd.convert;
  const convOn = !!(cv && cv.on);
  if(!exps.length && !lines.length && !nsItems.length && !p.costs && !p.lineExpenses && !p.nonStockItems && !convOn) return { changed: false };
  const rates = {};
  exps.forEach(e => { if(e.currency !== pcEd.base) rates[e.currency] = e.rate; });
  if(convOn){
    const crate = parseFloat(pcEd.rates[cv.currency]);
    if(!cv.currency || !(crate > 0)) return { error: tf('pcErrNoRate', { cur: cv.currency || '?' }) };
    const conv = o => { if(o.amount !== undefined && o.amount !== null && o.amount !== ''){ o.origAmount = Number(o.amount); o.origCurrency = cv.currency; o.fxRate = crate; o.amount = pcRound2(Number(o.amount) * crate); } };
    cleanItems.forEach(conv); lines.forEach(conv); nsItems.forEach(conv);
    rates[cv.currency] = crate;
  }
  const base = p.costs || { overseas: false, currency: pcEd.base, baseCurrency: pcEd.base };
  const newCosts = Object.assign({}, base, convOn ? { overseas: true, currency: cv.currency } : {}, {
    basis: pcEd.basis,
    rates: Object.assign({}, base.rates || {}, rates),
    expenses: exps,
    expensesAud: pcRound2(exps.reduce((s, e) => s + e.aud, 0))
  });
  const r = pcRecompute({ items: cleanItems, costs: newCosts, lineExpenses: lines, nonStockItems: nsItems });
  if(r.error) return r;
  p.costs = newCosts;
  if(lines.length) p.lineExpenses = lines; else delete p.lineExpenses;
  if(nsItems.length) p.nonStockItems = nsItems; else delete p.nonStockItems;
  const newTotals = JSON.stringify(cleanItems.map(i => i.totalAmount === undefined ? null : i.totalAmount));
  return { converted: convOn, changed: convOn || JSON.stringify(newCosts) !== oldCosts || newTotals !== oldTotals || JSON.stringify(lines) !== oldLines || JSON.stringify(nsItems) !== oldNs };
}
// 進貨紀錄清單上的小標記:這張單有「預估」的其他支出,還沒換成正式金額
function pcEstimateBadge(p){
  if(!p || !p.costs || !(p.costs.expenses || []).some(e => e.estimated)) return '';
  return ` <span title="${pcEsc(t('pcEstimatedPurchaseTitle'))}" style="color:var(--warn-dark,#b45309);font-weight:600;font-size:11px;">⚠ ${t('pcEstimatedPurchaseBadge')}</span>`;
}

// ============================================================
// 進貨紀錄 → 「查看原始紀錄」:顯示原本幣種的金額、幣種、匯率與換算後金額
// ============================================================
function pcHasOriginalData(p){
  if(!p || !p.costs) return false;
  const base = p.costs.baseCurrency || 'AUD';
  return !!p.costs.overseas
    || (p.costs.expenses || []).some(e => e.currency && e.currency !== base)
    || (p.items || []).some(it => it.origCurrency)
    || (p.lineExpenses || []).some(l => l.origCurrency)
    || (p.nonStockItems || []).some(n => n.origCurrency);
}
function pcCloseOriginalModal(){ const ov = document.getElementById('pcOriginalOverlay'); if(ov) ov.remove(); }
function pcOpenOriginalModal(purchaseId){
  const p = (typeof purchases !== 'undefined') ? purchases.find(x => x.id === purchaseId) : null;
  if(!p || !p.costs) return;
  pcCloseOriginalModal();
  const base = p.costs.baseCurrency || 'AUD';
  const fm = n => (n === null || n === undefined || n === '' || isNaN(n)) ? '–' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fx = r => (r === null || r === undefined || r === '') ? '–' : String(Number(Number(r).toPrecision(8)));
  const items = (p.items || []).filter(it => it.docType !== 'others');
  let origSum = 0, origCur = '', origAny = false;
  const itemRows = items.map(it => {
    const isCn = it.docType === 'credit_note';
    const sign = isCn ? -1 : 1;
    const hasOrig = it.origAmount !== undefined && it.origAmount !== null;
    if(hasOrig){ origSum += sign * Number(it.origAmount); origCur = it.origCurrency || origCur; origAny = true; }
    return `<tr>
      <td>${pcEsc(it.name || '')}${isCn ? ` <span style="color:var(--crit);font-size:11px;">(${t('docTypeCreditNoteBadge')})</span>` : ''}</td>
      <td class="num">${isCn ? -it.qty : it.qty} ${pcEsc(it.unit || '')}</td>
      <td class="num">${hasOrig ? `${fm(sign * it.origAmount)} ${pcEsc(it.origCurrency || '')}` : (it.amount !== undefined && it.amount !== null ? `${fm(sign * it.amount)} ${pcEsc(base)}` : '–')}</td>
      <td class="num">${hasOrig ? fx(it.fxRate) : '–'}</td>
      <td class="num">${it.amount !== undefined && it.amount !== null ? `${fm(sign * it.amount)} ${pcEsc(base)}` : '–'}</td>
    </tr>`;
  }).join('');
  const expRows = (p.costs.expenses || []).map(e => `<tr>
      <td>${pcEsc(e.name)}${e.payee ? ` <span style="color:var(--ink-soft);font-size:11px;">· ${pcEsc(e.payee)}</span>` : ''}${e.estimated ? ` <span style="color:var(--warn-dark,#b45309);font-size:11px;">⚠ ${tf('pcEstimatedBadge', { date: e.estimatedFrom || '' })}</span>` : ''}</td>
      <td class="num">${fm(e.amount)} ${pcEsc(e.currency || '')}</td>
      <td class="num">${e.currency && e.currency !== base ? fx(e.rate) : '–'}</td>
      <td class="num">${fm(e.aud)} ${pcEsc(base)}</td>
    </tr>`).join('');
  const lineRows = (p.lineExpenses || []).map(l => `<tr>
      <td>${pcEsc(l.name)} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcLineExpBadge')})</span></td>
      <td class="num">${l.origAmount !== undefined && l.origAmount !== null ? `${fm(l.origAmount)} ${pcEsc(l.origCurrency || '')}` : `${fm(l.amount)} ${pcEsc(base)}`}</td>
      <td class="num">${l.origAmount !== undefined && l.origAmount !== null ? fx(l.fxRate) : '–'}</td>
      <td class="num">${fm(l.amount)} ${pcEsc(base)}</td>
    </tr>`).join('');
  const nsRowsOrig = (p.nonStockItems || []).map(n => `<tr>
      <td>${pcEsc(n.name)} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcNonStockBadge')})</span></td>
      <td class="num">${n.qty} ${pcEsc(n.unit || '')}</td>
      <td class="num">${n.origAmount !== undefined && n.origAmount !== null ? `${fm(n.origAmount)} ${pcEsc(n.origCurrency || '')}` : `${fm(n.amount)} ${pcEsc(base)}`}</td>
      <td class="num">${n.origAmount !== undefined && n.origAmount !== null ? fx(n.fxRate) : '–'}</td>
      <td class="num">${fm(n.amount)} ${pcEsc(base)}</td>
    </tr>`).join('');
  const rateLine = Object.keys(p.costs.rates || {}).map(c => `1 ${pcEsc(c)} = ${fx(p.costs.rates[c])} ${pcEsc(base)}`).join(' · ');
  const tt = pcPurchaseTotals(p);
  const html = `
    <div style="font-size:12.5px;margin-bottom:8px;">${pcEsc(p.date || '')} · ${pcEsc(p.partyName || p.partyId || '') || '–'}${p.invoiceNo ? ' · Invoice ' + pcEsc(p.invoiceNo) : ''}</div>
    <div style="font-size:12.5px;margin-bottom:8px;">${p.costs.overseas ? `${t('pcInvoiceCurrency')}: <strong>${pcEsc(p.costs.currency)}</strong> → ${tf('pcConvertToFixed', { base: pcEsc(base) })}` : tf('pcConvertToFixed', { base: pcEsc(base) })}${rateLine ? `<br><span style="color:var(--ink-soft);">${t('pcOriginalRates')}: ${rateLine}</span>` : ''}</div>
    <div style="font-size:12.5px;font-weight:700;margin:6px 0 4px;">${t('pcOriginalItems')}</div>
    <table class="stock-table"><thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th><th class="num">${t('pcColOrigAmount')}</th><th class="num">${t('pcColFxRate')}</th><th class="num">${t('pcColConverted')}</th></tr></thead><tbody>${itemRows}${nsRowsOrig}</tbody></table>
    ${origAny ? `<div style="font-size:12.5px;margin-top:4px;">${t('pcOriginalInvoiceTotal')}: <strong>${fm(origSum)} ${pcEsc(origCur)}</strong> → <strong>${fm(tt.base)} ${pcEsc(base)}</strong></div>` : ''}
    ${lineRows ? `<div style="font-size:12.5px;font-weight:700;margin:10px 0 4px;">${t('pcLineExpTitle')}</div>
    <table class="stock-table"><thead><tr><th>${t('pcExpenseName')}</th><th class="num">${t('pcColOrigAmount')}</th><th class="num">${t('pcColFxRate')}</th><th class="num">${t('pcColConverted')}</th></tr></thead><tbody>${lineRows}</tbody></table>` : ''}
    ${expRows ? `<div style="font-size:12.5px;font-weight:700;margin:10px 0 4px;">${t('pcExpenses')}</div>
    <table class="stock-table"><thead><tr><th>${t('pcExpenseName')}</th><th class="num">${t('pcColOrigAmount')}</th><th class="num">${t('pcColFxRate')}</th><th class="num">${t('pcColConverted')}</th></tr></thead><tbody>${expRows}</tbody></table>
    <div style="font-size:12.5px;margin-top:4px;">${t('pcExpenseTotal')}: <strong>${fm(tt.relatedExpenses)} ${pcEsc(base)}</strong></div>` : ''}
    <div style="font-size:12.5px;margin-top:8px;">${t('pcGrandTotal')}: <strong>${fm(tt.total)} ${pcEsc(base)}</strong></div>`;
  const ov = document.createElement('div');
  ov.id = 'pcOriginalOverlay';
  ov.className = 'modal-overlay';
  ov.style.display = 'flex';
  ov.style.zIndex = '1150';
  ov.onclick = (e) => { if(e.target === ov) pcCloseOriginalModal(); };
  ov.innerHTML = `<div class="modal-box modal-box-wide"><div class="section-title" style="margin-top:0;">${t('pcOriginalTitle')}</div>${html}
    <div class="modal-actions"><button class="btn ghost" onclick="pcCloseOriginalModal()">${t('btnClose') !== 'btnClose' ? t('btnClose') : 'Close'}</button></div></div>`;
  document.body.appendChild(ov);
}
