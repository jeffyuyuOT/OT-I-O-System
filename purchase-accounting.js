// ============================================================
// 進貨帳務(OT custom:purchaseAccounting)
//   · 進貨單「入會計紀錄」(取代「寄送給會計」勾選)+ 每個品項的 GST
//   · 會計 → Purchase List:日期、進貨方、Invoice number、金額、已付、未付、狀態、付款記錄
//   · 付款記錄存在 purchase_payments(sql/purchase_accounting.sql)
// 進貨單本身(金額、GST、是否入會計紀錄)存在 purchases.payload:
//   inAccounting(false = 不入會計;沒有這個欄位的舊進貨單一律算入會計)、gstMode('ex' 金額不含 GST / 'inc' 含 GST)、items[].gst(true / false)
// ============================================================
const PA_GST_RATE = 0.10;
const PA_METHODS = ['Bank Transfer', 'Cash', 'Card', 'Cheque', 'Other'];
let paFilter = { from: '', to: '', status: '', sup: '', q: '' };
let paRows = [];            // purchase_payments 全部資料
let paErr = '';             // '' | 'sql' | 'error'
let paPay = null;           // 付款記錄視窗狀態 { id, editingId }

function paOn(){ return typeof hasFeature === 'function' && hasFeature('purchaseAccounting'); }
function paEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function paR2(n){ return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function paM2(n){ return paR2(n).toFixed(2); }
function paDmy(iso){ return (typeof invIsoToDmy === 'function') ? invIsoToDmy(iso) : (iso || ''); }
function paToday(){ return (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0, 10); }
// 商品主檔設為「不入公司帳」的商品(只做庫存管理):進貨時在品項上記 noAcct,不計入會計金額 / GST
function paProductOffBooks(productId){
  const pr = (typeof products !== 'undefined') ? products.find(x => x.id === productId) : null;
  return typeof isOffBooksProduct === 'function' ? isOffBooksProduct(pr) : !!(pr && pr.noAccounting === true);
}
// 這張進貨單有沒有任何入帳的內容(入帳商品、非入庫商品);全部都是不入帳商品 = 不入會計
function paHasAccountedContent(p){
  if((p.nonStockItems || []).length) return true;
  if((p.lineExpenses || []).length && (p.items || []).every(it => it.noAcct || it.docType === 'others')) return true;
  return (p.items || []).some(it => it.docType !== 'others' && !it.noAcct);
}
function paCounted(p){ return !!p && p.inAccounting !== false && paHasAccountedContent(p); }

// 商品庫存總覽 / 商品資料裡的 GST 設定:true / false;沒有資料 → null(需要手動選)
function paProductGst(productId){
  const pr = (typeof products !== 'undefined') ? products.find(x => x.id === productId) : null;
  if(!pr) return null;
  return pr.gst === true ? true : (pr.gst === false ? false : null);
}
// 這張進貨單的 GST 與合計。ex:金額不含 GST,GST 另外加;inc:金額已含 GST,GST = 含 GST 品項金額 ÷ 11。
function paTotals(p){
  const mode = p && p.gstMode === 'inc' ? 'inc' : 'ex';
  let base = 0, gstBase = 0, unset = 0;
  ((p && p.nonStockItems) || []).forEach(n => {
    const a = Number(n.amount) || 0;
    base += a;
    if(n.gst === true) gstBase += a;
    else if(n.gst !== false && a > 0) unset++;
  });
  ((p && p.items) || []).forEach(it => {
    if(it.docType === 'others' || it.noAcct) return;
    const a = (Number(it.amount) || 0) * (it.docType === 'credit_note' ? -1 : 1);
    base += a;
    if(it.gst === true) gstBase += a;
    else if(it.gst !== false && Number(it.amount) > 0) unset++;
  });
  // 商品列的其他支出(收據上的 fuel levy 等)也是供應商發票的一部分,各自有 GST 設定
  ((p && p.lineExpenses) || []).forEach(l => {
    const a = Number(l.amount) || 0;
    base += a;
    if(l.gst === true) gstBase += a;
    else if(l.gst !== false && a > 0) unset++;
  });
  let gst, total, ex;
  if(mode === 'ex'){ gst = gstBase * PA_GST_RATE; ex = base; total = base + gst; }
  else { gst = gstBase * PA_GST_RATE / (1 + PA_GST_RATE); total = base; ex = base - gst; }
  return { mode, ex: paR2(ex), gst: paR2(gst), total: paR2(total), unset };
}
function paPaidOf(purchaseId){ return paR2(paRows.filter(r => r.purchase_id === purchaseId).reduce((s, r) => s + Number(r.amount), 0)); }
// 付款到期日:進貨單有填就用填的;沒填 → 發票日期 + 進貨方的 Payment terms;兩者都湊不齊 → 沒有到期日(不做到期判定)。
function paSupplierOf(p){
  const list = (typeof purchaseSuppliers !== 'undefined') ? purchaseSuppliers : [];
  return (p.supplierId && list.find(x => x.id === p.supplierId)) || list.find(x => x.name === (p.partyName || p.partyId)) || null;
}
function paDue(p){
  if(p.dueDate) return { date: p.dueDate, src: 'manual' };
  const s = paSupplierOf(p);
  if(p.invoiceDate && s && s.paymentTerms !== null && s.paymentTerms !== undefined){
    const d = new Date(p.invoiceDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(s.paymentTerms));
    return { date: d.toISOString().slice(0, 10), src: 'terms' };
  }
  return { date: '', src: '' };
}
function paInfo(p){
  const tt = paTotals(p), paid = paPaidOf(p.id);
  const balance = paR2(tt.total - paid);
  const status = paid <= 0.004 ? 'unpaid' : (balance > 0.004 ? 'partial' : (balance < -0.004 ? 'overpaid' : 'paid'));
  return Object.assign({ paid, balance, status }, tt);
}
// ---- 跟進貨單相關的其他支出(運費、關稅…):各自一列,各自記付款(purchase_payments.purchase_id = 進貨單ID#支出ID) ----
function paExpKey(p, e, idx){ return p.id + '#' + (e.id || ('i' + idx)); }
function paExpList(p){
  if(!paOn() || !p || !p.costs) return [];
  return (p.costs.expenses || []).map((e, idx) => ({ e, key: paExpKey(p, e, idx) })).filter(x => Number(x.e.aud) > 0);
}
function paExpInfo(p, x){
  const e = x.e, mode = p.gstMode === 'inc' ? 'inc' : 'ex', a = Number(e.aud) || 0;
  const gstBase = e.gst === true ? a : 0;
  let gst, total, ex;
  if(mode === 'ex'){ gst = gstBase * PA_GST_RATE; ex = a; total = a + gst; }
  else { gst = gstBase * PA_GST_RATE / (1 + PA_GST_RATE); total = a; ex = a - gst; }
  const paid = paPaidOf(x.key), balance = paR2(total - paid);
  const status = paid <= 0.004 ? 'unpaid' : (balance > 0.004 ? 'partial' : (balance < -0.004 ? 'overpaid' : 'paid'));
  return { paid, balance, status, ex: paR2(ex), gst: paR2(gst), total: paR2(total), unset: (e.gst !== true && e.gst !== false) ? 1 : 0 };
}
// 外幣支出一律用澳幣(系統幣種)顯示;旁邊的 ⓘ 點開可看原幣金額與當時的匯率
function paExpFxIcon(p, e){
  const base = (p.costs && p.costs.baseCurrency) || 'AUD';
  if(!e.currency || e.currency === base || !e.rate) return '';
  return ` <span class="batch-info-icon" style="cursor:pointer;" title="${paEsc(t('paFxTitle'))}" onclick="paShowFx('${paEsc(p.id)}','${paEsc(e.id || '')}','${paEsc(e.name || '')}')">ⓘ</span>`;
}
function paShowFx(pid, eid, name){
  const p = purchases.find(x => x.id === pid); if(!p || !p.costs) return;
  const e = (p.costs.expenses || []).find(x => (eid && x.id === eid) || (!eid && x.name === name)); if(!e) return;
  const base = p.costs.baseCurrency || 'AUD';
  showInfoModal(tf('paFxDetail', { name: e.name || '', amt: paM2(e.amount), cur: e.currency, rate: Number(e.rate).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''), aud: paM2(e.aud), base, date: paDmy(p.date) }));
}
function paStatusBadge(st){
  const col = { paid: ['#e7f6ec', '#1d7a3c'], partial: ['#fff4dc', '#9a6a00'], unpaid: ['#eef0f3', '#555'], overpaid: ['#efe6fb', '#6b3fa0'] }[st] || ['#eee', '#555'];
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;background:${col[0]};color:${col[1]};white-space:nowrap;">${paEsc(t('invSt_' + st))}</span>`;
}

// ------------------------------------------------------------
// 登記進貨表單
// ------------------------------------------------------------
// 登記進貨(type = 'in'):顯示「入會計紀錄」(取代「寄送給會計」);其他類型隱藏
function paFormInit(type){
  if(typeof applyCostVisibility === 'function') applyCostVisibility();
  const wrap = document.getElementById('purchaseAccWrap'), emailWrap = document.getElementById('purchaseEmailWrap');
  if(!wrap) return;
  const on = paOn();
  wrap.style.display = (on && type === 'in') ? 'inline-flex' : 'none';
  if(emailWrap && on) emailWrap.style.display = 'none';
  if(type !== 'in') paFormReset();
}
function paFormReset(){
  const c = document.getElementById('purchaseAccToggle'); if(c) c.checked = true;
  const g = document.getElementById('purchaseGstMode'); if(g) g.value = 'ex';
  const d = document.getElementById('purchaseDueDate'); if(d) d.value = '';
  const iv = document.getElementById('purchaseInvDate'); if(iv) iv.value = '';
}
// 是否入會計由商品設定決定(商品主檔「不入公司帳」),進貨單不再手動勾選;全部是不入帳商品的單會自動不出現在 Purchase List
function paFormInAccounting(){ return true; }
function paFormGstMode(){ const g = document.getElementById('purchaseGstMode'); return g && g.value === 'inc' ? 'inc' : 'ex'; }
function paGstSelectHtml(val, onchange){
  const v = val === true ? 'y' : (val === false ? 'n' : '');
  return `<select onchange="${onchange}" style="font-size:12px;max-width:92px;${v === '' ? 'border-color:#d9a400;background:#fff9e6;' : ''}">
    <option value="" ${v === '' ? 'selected' : ''}>${paEsc(t('paGstUnset'))}</option>
    <option value="y" ${v === 'y' ? 'selected' : ''}>GST</option>
    <option value="n" ${v === 'n' ? 'selected' : ''}>${paEsc(t('paGstNone'))}</option></select>`;
}
// 登記進貨清單的品項:商品資料有 GST 設定就自動帶入,沒有的要手動選
function paAutoFillGst(items){
  (items || []).forEach(it => { if(it.noAcct || (it.productId && paProductOffBooks(it.productId))) return; if(it.gst === undefined || it.gst === null){ const g = paProductGst(it.productId); if(g !== null) it.gst = g; } });
}
function paSetTxItemGst(batchItemId, v){
  const it = txBatchItems.find(x => x.batchItemId === batchItemId); if(!it) return;
  if(v === 'y') it.gst = true; else if(v === 'n') it.gst = false; else delete it.gst;
  renderTxBatchList();
}
// 送出進貨前:有價格的品項要有 GST;沒勾「入會計紀錄」但有價錢 → 跳窗確認。回傳 false = 中止送出。
async function paPreSubmit(msg){
  if(!paOn()) return true;
  if(typeof canViewPrice === 'function' && !canViewPrice()) return true;   // 看不到價錢的人(倉管員)不填金額 / GST,由會計之後在 Purchase List 補
  const lineExps = (typeof pcState !== 'undefined' && pcState.lineExpenses ? pcState.lineExpenses : []).filter(l => Number(l.amount) > 0).map(l => Object.assign({ name: l.name || '(其他支出)' }, l));
  const nsExps = (typeof pcState !== 'undefined' && pcState.nonStock ? pcState.nonStock : []).filter(n => Number(n.amount) > 0).map(n => Object.assign({}, n, { name: n.name || '(非入庫商品)' }));
  const priced = txBatchItems.filter(it => Number(it.amount) > 0 && !paProductOffBooks(it.productId)).concat(lineExps, nsExps);
  if(paFormInAccounting()){
    paAutoFillGst(txBatchItems);
    const miss = priced.filter(it => it.gst !== true && it.gst !== false);
    if(miss.length){
      msg.className = 'msg error';
      msg.textContent = '⚠ ' + tf('paErrNeedGst', { names: miss.map(x => x.name).join('、') });
      return false;
    }
    return true;
  }
  if(priced.length === 0) return true;
  return await new Promise(resolve => showConfirmModal(t('paConfirmNotInAcc'), () => resolve(true), () => resolve(false)));
}
// 組好進貨單之後:寫入 入會計 / GST 模式 / 每個品項的 GST(purchase.items 與 srcItems 同順序)
function paApplyToPurchase(purchase, srcItems){
  if(!paOn()) return;
  purchase.inAccounting = paFormInAccounting();
  purchase.gstMode = paFormGstMode();
  { const d = document.getElementById('purchaseDueDate'); if(d && d.value) purchase.dueDate = d.value; else delete purchase.dueDate; }
  { const iv = document.getElementById('purchaseInvDate'); if(iv && iv.value) purchase.invoiceDate = iv.value; else delete purchase.invoiceDate; }
  (purchase.items || []).forEach((it, i) => {
    const s = srcItems[i];
    if(paProductOffBooks(it.productId) || (s && paProductOffBooks(s.productId))){ it.noAcct = true; delete it.gst; return; }
    if(s && (s.gst === true || s.gst === false)) it.gst = s.gst;
    else { const g = paProductGst(it.productId); if(g !== null) it.gst = g; }
  });
}

// ------------------------------------------------------------
// 編輯進貨單
// ------------------------------------------------------------
function paEditLoad(p){
  const w = document.getElementById('editPurchaseAccWrap'); if(!w) return;
  w.style.display = paOn() ? 'block' : 'none';
  const c = document.getElementById('editPurchaseAccToggle'); if(c) c.checked = paCounted(p);
  const g = document.getElementById('editPurchaseGstMode'); if(g) g.value = p.gstMode === 'inc' ? 'inc' : 'ex';
  const dd = document.getElementById('editPurchaseDueDate'); if(dd) dd.value = p.dueDate || '';
  const iv = document.getElementById('editPurchaseInvDate'); if(iv) iv.value = p.invoiceDate || '';
  // 舊進貨單的品項沒有 GST 資料:商品資料有設定的自動帶入
  paAutoFillGst(editPurchaseWorkingItems);
}
function paEditSetGst(i, v){
  const it = editPurchaseWorkingItems[i]; if(!it) return;
  if(v === 'y') it.gst = true; else if(v === 'n') it.gst = false; else delete it.gst;
  renderEditPurchaseItemsList();
}
// 儲存前檢查(回傳錯誤文字或 ''),並把設定寫進 p
function paEditCheck(items){
  if(!paOn()) return '';
  const c = document.getElementById('editPurchaseAccToggle');
  if(!c || !c.checked) return '';
  const lineMiss = (typeof pcEd !== 'undefined' && pcEd && pcEd.lineExpenses ? pcEd.lineExpenses : []).filter(l => Number(l.amount) > 0 && l.gst !== true && l.gst !== false);
  const nsMiss = (typeof pcEd !== 'undefined' && pcEd && pcEd.nonStock ? pcEd.nonStock : []).filter(n => Number(n.amount) > 0 && n.gst !== true && n.gst !== false);
  const miss = items.filter(it => it.docType !== 'others' && !it.noAcct && Number(it.amount) > 0 && it.gst !== true && it.gst !== false).concat(lineMiss.map(l => ({ name: l.name || '(其他支出)' })), nsMiss.map(n => ({ name: n.name || '(非入庫商品)' })));
  return miss.length ? tf('paErrNeedGst', { names: miss.map(x => x.name).join('、') }) : '';
}
function paEditApply(p){
  if(!paOn()) return;
  const c = document.getElementById('editPurchaseAccToggle'), g = document.getElementById('editPurchaseGstMode');
  p.inAccounting = !c || c.checked;
  p.gstMode = g && g.value === 'inc' ? 'inc' : 'ex';
  const dd = document.getElementById('editPurchaseDueDate');
  if(dd){ if(dd.value) p.dueDate = dd.value; else delete p.dueDate; }
  const iv = document.getElementById('editPurchaseInvDate');
  if(iv){ if(iv.value) p.invoiceDate = iv.value; else delete p.invoiceDate; }
}

// ------------------------------------------------------------
// Purchase List(會計)
// ------------------------------------------------------------
async function paLoadPayments(){
  paErr = '';
  try{
    const { data, error } = await sb.from('purchase_payments').select('*').order('pay_date', { ascending: true }).order('created_at', { ascending: true }).limit(20000);
    if(error) throw error;
    paRows = data || [];
  }catch(e){
    paRows = [];
    paErr = (e && (e.code === '42P01' || /purchase_payments/.test(e.message || ''))) ? 'sql' : 'error';
    if(paErr === 'error') console.error('讀取進貨付款記錄失敗', e);
  }
}
async function paOpenPage(){
  const root = document.getElementById('purchaseListRoot'); if(!root) return;
  if(!paOn()) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  try{ if(typeof ensurePurchasesLoaded === 'function') await ensurePurchasesLoaded(); }catch(e){}
  await paLoadPayments();
  paRenderList();
}
// 會計清單共用的 Excel 匯出(目前篩選結果)
function accExportXlsx(aoa, sheetName, filePrefix, widths){
  if(typeof XLSX === 'undefined'){ showInfoModal(t('psImportNoXlsx')); return; }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if(widths) ws['!cols'] = widths.map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filePrefix}_${(typeof invToday === 'function') ? invToday() : new Date().toISOString().slice(0, 10)}.xlsx`);
}
function paExportXlsx(){
  const aoa = [['Date', 'Supplier', 'Invoice No', 'Amount (Ex. GST)', 'GST', 'Total (Inc. GST)', 'Paid', 'Balance', 'Status']]
    .concat(paFiltered().map(p => { const i = paInfo(p); return [p.date || '', p.partyName || '', p.invoiceNo || '', i.ex, i.gst, i.total, i.paid, i.balance, t('invSt_' + i.status)]; }));
  accExportXlsx(aoa, 'Purchases', 'purchases', [12, 28, 16, 16, 10, 16, 12, 12, 12]);
}
function paFiltered(){
  const f = paFilter, q = (f.q || '').trim().toLowerCase();
  return purchases.filter(p => paCounted(p)
    && (!f.from || (p.date || '') >= f.from) && (!f.to || (p.date || '') <= f.to)
    && (!f.sup || (p.partyName || '') === f.sup)
    && (!f.status || paInfo(p).status === f.status)
    && (!q || [p.partyName, p.invoiceNo, p.note].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}
function paRenderList(){
  const root = document.getElementById('purchaseListRoot'); if(!root) return;
  if(paErr === 'sql'){ root.innerHTML = `<div class="empty-note">${t('paNeedSql')}</div>`; return; }
  if(paErr){ root.innerHTML = `<div class="empty-note">${t('invLoadFailed')}</div>`; return; }
  const f = paFilter;
  const all = purchases.filter(p => paCounted(p));
  const sups = Array.from(new Set(all.map(p => p.partyName).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const list = paFiltered();
  const sum = { t: 0, p: 0, b: 0 };
  const rows = list.map(p => {
    const i = paInfo(p);
    const showMain = !f.status || i.status === f.status;
    let html = '';
    if(showMain){
      sum.t += i.total; sum.p += i.paid; sum.b += i.balance;
      html += `<tr>
      <td style="white-space:nowrap;">${paEsc(paDmy(p.date))}</td>
      <td>${paEsc(p.partyName || '')}</td>
      <td>${paEsc(p.invoiceNo || '')}</td>
      <td class="num"><b>${paM2(i.total)}</b></td>
      <td class="num">${paM2(i.paid)}</td><td class="num"><b>${paM2(i.balance)}</b></td>
      <td style="white-space:nowrap;">${paStatusBadge(i.status)}</td>
      <td style="white-space:nowrap;"><span class="del-link" onclick="paOpenPayments('${paEsc(p.id)}')">${t('paBtnPayments')}</span> <span class="batch-info-icon" style="margin-left:6px;" title="${paEsc(t('invBtnDetails'))}" onclick="paOpenDetails('${paEsc(p.id)}')">ⓘ</span></td>
    </tr>`;
    }
    return html;
  }).join('');
  const sel = (id, val, opts) => `<select id="${id}" onchange="paOnFilter()">${opts.map(o => `<option value="${paEsc(o[0])}" ${val === o[0] ? 'selected' : ''}>${paEsc(o[1])}</option>`).join('')}</select>`;
  const card = (label, val) => `<div style="flex:1 1 130px;min-width:120px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${label}</div><div style="font-size:17px;font-weight:700;">${val}</div></div>`;
  root.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
      ${card(t('paSumTotal') + ' (' + list.length + ')', paM2(sum.t))}
      ${card(t('paSumPaid'), paM2(sum.p))}
      ${card(t('paSumBalance'), paM2(sum.b))}
    </div>
    ${paLegacyBarHtml()}
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('lblFromDate')}</label><input type="date" id="paFlt_from" value="${paEsc(f.from)}" onchange="paOnFilter()" /></div>
      <div class="field"><label>${t('lblToDate')}</label><input type="date" id="paFlt_to" value="${paEsc(f.to)}" onchange="paOnFilter()" /></div>
      <div class="field"><label>${t('paColSupplier')}</label>${sel('paFlt_sup', f.sup, [['', t('invFltAll')]].concat(sups.map(x => [x, x])))}</div>
      <div class="field"><label>${t('invFltStatus')}</label>${sel('paFlt_status', f.status, [['', t('invFltAll')], ['unpaid', t('invSt_unpaid')], ['partial', t('invSt_partial')], ['paid', t('invSt_paid')], ['overpaid', t('invSt_overpaid')]])}</div>
      <div class="field" style="min-width:220px;"><label>${t('invFltSearch')}</label><input type="search" id="paFlt_q" value="${paEsc(f.q)}" oninput="paOnFilter(true)" placeholder="${paEsc(t('paSearchPh'))}" /></div>
      <button class="btn ghost" onclick="paClearFilter()" style="align-self:flex-end;">${t('btnClearFilter')}</button>
      <button class="btn ghost exp-btn" onclick="paExportXlsx()" style="align-self:flex-end;">${t('accExportXlsx')}</button>
      <button class="btn ghost exp-btn" id="evBtn" onclick="evDownload()" style="align-self:flex-end;" title="${paEsc(t('evHint'))}">${t('evPackBtn')}</button>
      <button class="btn ghost" id="evCancelBtn" style="display:none;align-self:flex-end;" onclick="evCancelRun()">${t('evCancel')}</button>
    </div>
    <div id="evMsg" style="font-size:12px;color:var(--ink-soft);margin:-4px 0 8px;"></div>
    ${list.length === 0 ? `<div class="empty-note">${t('paListEmpty')}</div>` : `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('colDate')}</th><th>${t('paColSupplier')}</th><th>Invoice No</th><th class="num">${t('paColAmount')}</th><th class="num">${t('paColPaid')}</th><th class="num">${t('paColUnpaid')}</th><th>${t('invFltStatus')}</th><th></th></tr></thead>
      <tbody>${rows}<tr style="font-weight:700;border-top:2px solid var(--line, #ccc);"><td colspan="3" style="text-align:right;">${t('invListTotals')} (${list.length})</td><td class="num">${paM2(sum.t)}</td><td class="num">${paM2(sum.p)}</td><td class="num">${paM2(sum.b)}</td><td colspan="2"></td></tr></tbody>
    </table></div>`}`;
}
// ---- 舊進貨單整理:還沒有入帳設定的舊進貨單,依「有沒有寄給會計」決定入不入帳 ----
function paLegacyList(){ return (purchases || []).filter(p => p.inAccounting === undefined || p.inAccounting === null); }
function paLegacyBarHtml(){
  const l = paLegacyList();
  if(!l.length) return '';
  const a = l.filter(p => p.emailedAt).length, b = l.length - a;
  return `<div style="border:1px solid #d9a400;background:#fff9e6;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12.5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
    <span>${paEsc(tf('paLegacyNotice', { n: l.length, a, b }))}</span>
    <button class="btn ghost" onclick="paLegacyApply()">${paEsc(t('paLegacyBtn'))}</button></div>`;
}
function paLegacyApply(){
  const l = paLegacyList();
  const a = l.filter(p => p.emailedAt).length, b = l.length - a;
  showConfirmModal(tf('paLegacyConfirm', { a, b }), async () => {
    let fail = 0;
    for(const p of l){
      const prev = p.inAccounting;
      p.inAccounting = !!p.emailedAt;
      try{ await upsertPurchase(p); }catch(e){ console.error(e); p.inAccounting = prev; fail++; }
    }
    paRenderList();
    showInfoModal(fail ? tf('paLegacyFail', { n: fail }) : t('paLegacyDone'));
  });
}
function paOnFilter(keepFocus){
  paFilter = {
    from: (document.getElementById('paFlt_from') || {}).value || '', to: (document.getElementById('paFlt_to') || {}).value || '',
    sup: (document.getElementById('paFlt_sup') || {}).value || '', status: (document.getElementById('paFlt_status') || {}).value || '',
    q: (document.getElementById('paFlt_q') || {}).value || ''
  };
  const pos = keepFocus ? ((document.getElementById('paFlt_q') || {}).selectionStart || 0) : 0;
  paRenderList();
  if(keepFocus){ const el = document.getElementById('paFlt_q'); if(el){ el.focus(); try{ el.setSelectionRange(pos, pos); }catch(e){} } }
}
function paClearFilter(){ paFilter = { from: '', to: '', status: '', sup: '', q: '' }; paRenderList(); }
function paCloseOverlay(id){ const o = document.getElementById(id); if(o) o.remove(); }

// ---- 詳細資料 ----
function paOpenDetails(id){
  const p = purchases.find(x => x.id === id); if(!p) return;
  const i = paInfo(p);
  const row = (k, v) => `<tr><td style="color:var(--ink-soft);white-space:nowrap;vertical-align:top;">${k}</td><td>${v === '' || v === null || v === undefined ? '–' : v}</td></tr>`;
  const items = (p.items || []).filter(it => it.docType !== 'others' && !it.noAcct).map(it => {
    const sign = it.docType === 'credit_note' ? -1 : 1;
    const g = it.gst === true ? 'GST' : (it.gst === false ? t('paGstNone') : '<span style="color:#b26a00;">' + paEsc(t('paGstUnset')) + '</span>');
    return `<tr><td>${paEsc(it.name || '')}${it.docType === 'credit_note' ? ` <span style="color:var(--crit);font-size:11px;">(${t('docTypeCreditNoteBadge')})</span>` : ''}</td><td class="num">${paEsc(it.qty)} ${paEsc(it.unit || '')}</td><td class="num">${it.amount !== undefined && it.amount !== null ? paM2(sign * Number(it.amount)) : '–'}</td><td>${g}</td></tr>`;
  }).join('');
  const nsDetail = (p.nonStockItems || []).map(n => {
    const g = n.gst === true ? 'GST' : (n.gst === false ? t('paGstNone') : '<span style="color:#b26a00;">' + paEsc(t('paGstUnset')) + '</span>');
    return `<tr style="background:var(--bg-soft,#f5f5f0);"><td>${paEsc(n.name || '')} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcNonStockBadge')})</span></td><td class="num">${paEsc(n.qty)} ${paEsc(n.unit || '')}</td><td class="num">${paM2(Number(n.amount) || 0)}</td><td>${g}</td></tr>`;
  }).join('');
  const offCnt = (p.items || []).filter(it => it.noAcct).length;
  const lineItems = (p.lineExpenses || []).map(l => {
    const g = l.gst === true ? 'GST' : (l.gst === false ? t('paGstNone') : '<span style="color:#b26a00;">' + paEsc(t('paGstUnset')) + '</span>');
    return `<tr style="background:var(--bg-soft,#f5f5f0);"><td>${paEsc(l.name || '')} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcLineExpBadge')})</span></td><td class="num"></td><td class="num">${paM2(Number(l.amount) || 0)}</td><td>${g}</td></tr>`;
  }).join('');
  const exp = (p.costs && Number(p.costs.expensesAud)) || 0;
  paCloseOverlay('paDetailsOverlay');
  const ov = document.createElement('div');
  ov.id = 'paDetailsOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.onclick = e => { if(e.target === ov) paCloseOverlay('paDetailsOverlay'); };
  ov.innerHTML = `<div class="modal-box" style="max-width:min(600px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('paDetailTitle')}</div>
    <div style="font-size:12.5px;margin:0 0 8px;">${paEsc(p.partyName || '')} · ${paStatusBadge(i.status)}</div>
    <table style="width:100%;font-size:13px;border-collapse:collapse;"><tbody>
      ${row(t('colDate'), paEsc(paDmy(p.date)))}
      ${row('Invoice No', paEsc(p.invoiceNo || ''))}
      ${row(t('paGstModeLabel'), paEsc(t(i.mode === 'inc' ? 'paGstModeInc' : 'paGstModeEx')))}
      ${row(t('paAmtExGst'), paM2(i.ex))}
      ${row('GST', paM2(i.gst))}
      ${row(t('paColAmount'), '<b>' + paM2(i.total) + '</b>')}
      ${row(t('paColPaid'), paM2(i.paid))}
      ${row(t('paColUnpaid'), '<b>' + paM2(i.balance) + '</b>')}
      ${exp > 0 ? row(t('paOtherExpenses'), paM2(exp) + ` <span style="font-size:11px;color:var(--ink-soft);">${paEsc(t('paOtherExpensesNote'))}</span>`) : ''}
      ${paExpList(p).map(x => { const ei = paExpInfo(p, x); return row('↳ ' + paEsc(x.e.name || ''), `${paM2(ei.total)}${paExpFxIcon(p, x.e)} · ${paEsc(x.e.payee || '–')} · ${x.e.gst === true ? 'GST' : (x.e.gst === false ? paEsc(t('paGstNone')) : '<span style="color:#b26a00;">' + paEsc(t('paGstUnset')) + '</span>')} · ${paStatusBadge(ei.status)}`); }).join('')}
      ${p.note ? row(t('colNote'), paEsc(p.note)) : ''}
    </tbody></table>
    ${i.unset > 0 ? `<div style="margin-top:8px;font-size:12px;color:#b26a00;">${paEsc(tf('paUnsetWarn', { n: i.unset }))}</div>` : ''}
    <div style="margin-top:12px;overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th><th class="num">${t('colAmount')}</th><th>GST</th></tr></thead><tbody>${items}${nsDetail}${lineItems}</tbody></table></div>
    ${offCnt > 0 ? `<div style="margin-top:6px;font-size:12px;color:var(--ink-soft);">${paEsc(tf('paOffBooksNote', { n: offCnt }))}</div>` : ''}
    <div class="modal-actions">
      <button class="btn ghost" onclick="paCloseOverlay('paDetailsOverlay')">${t('btnClose')}</button>
      <button class="btn ghost" onclick="paCloseOverlay('paDetailsOverlay');openEditPurchaseModal('${paEsc(p.id)}')">${t('btnEdit')}</button>
      <button class="btn ghost" onclick="paRemoveFromAccounting('${paEsc(p.id)}')">${t('paBtnRemove')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
function paRemoveFromAccounting(id){
  const p = purchases.find(x => x.id === id); if(!p) return;
  const hasPay = paRows.some(r => r.purchase_id === id || String(r.purchase_id).startsWith(id + '#'));
  showConfirmModal(t(hasPay ? 'paConfirmRemoveHasPay' : 'paConfirmRemove'), async () => {
    try{
      p.inAccounting = false;
      await upsertPurchase(p);
      paCloseOverlay('paDetailsOverlay');
      paRenderList();
    }catch(e){ console.error(e); p.inAccounting = true; showInfoModal(t('invPaidFailed')); }
  });
}

// ---- 付款記錄 ----
function paOpenPayments(id, expId, expName, sid){
  paPay = { id, editingId: null, expId: expId || '', expName: expName || '', sid: sid || '' };
  paRenderPayments();
  if(typeof ppLoad === 'function' && typeof ppOn === 'function' && ppOn() && !ppLoaded){
    const loadF = (typeof loadForecastRecords === 'function') ? loadForecastRecords().catch(() => {}) : Promise.resolve();
    Promise.all([ppLoad(), loadF]).then(() => { if(paPay) paRenderPayments(); });
  }
}
function paClosePayments(){ paCloseOverlay('paPaymentsOverlay'); paPay = null; paRenderList(); if(typeof oeRender === 'function' && document.getElementById('otherExpensesRoot') && document.getElementById('otherExpensesRoot').innerHTML) oeRender(); }
function paRenderPayments(){
  if(!paPay) return;
  const p = paPayPurchase(); if(!p){ paClosePayments(); return; }
  const tg = paPayTarget(p);
  const i = tg.info;
  const pays = paRows.filter(r => r.purchase_id === tg.key);
  const ed = pays.find(x => x.id === paPay.editingId) || null;
  const dateV = ed ? ed.pay_date : paToday();
  const amtV = ed ? paM2(ed.amount) : (i.balance > 0 ? paM2(i.balance) : '');
  const methodV = ed ? (ed.method || 'Bank Transfer') : 'Bank Transfer';
  const methods = PA_METHODS.concat(methodV && !PA_METHODS.includes(methodV) ? [methodV] : []);
  let ov = document.getElementById('paPaymentsOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'paPaymentsOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
    ov.onclick = e => { if(e.target === ov) paClosePayments(); };
    document.body.appendChild(ov);
  }
  const box = (label, v) => `<div style="flex:1 1 110px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${label}</div><b>${v}</b></div>`;
  const rows = pays.map(x => `<tr>
      <td style="white-space:nowrap;">${paEsc(paDmy(x.pay_date))}</td><td class="num">${paM2(x.amount)}</td><td>${paEsc(x.method || '')}</td>
      <td>${paEsc(x.note || '')}<div style="font-size:10.5px;color:var(--ink-soft);">${paEsc(x.created_by || '')}</div></td>
      <td style="white-space:nowrap;text-align:right;"><span class="del-link" onclick="paPayEdit('${paEsc(x.id)}')" style="margin-right:6px;">${t('btnEdit')}</span><span class="del-link" onclick="paPayDelete('${paEsc(x.id)}')">${t('btnDelete')}</span></td>
    </tr>`).join('');
  ov.innerHTML = `<div class="modal-box" style="max-width:min(640px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('paPayTitle')}</div>
    <div style="font-size:12.5px;margin:0 0 8px;">${tg.exp ? paEsc((tg.exp.e.name || '') + ' · ' + (tg.exp.e.payee || '–') + ' · ') : ''}${paEsc(p.partyName || '')}${p.invoiceNo ? ' · ' + paEsc(p.invoiceNo) : ''} · ${paStatusBadge(i.status)}${tg.exp ? paExpFxIcon(p, tg.exp.e) : ''}</div>
    ${tg.exp && tg.exp.e.estimated ? `<div style="font-size:12px;color:#b45309;background:var(--warn-bg,#fff4dc);padding:6px 10px;border-radius:6px;margin-bottom:8px;">⚠ ${paEsc(t('paExpEstimatedWarn'))}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">${box(t('paColAmount'), paM2(i.total))}${box(t('paColPaid'), paM2(i.paid))}${box(t('paColUnpaid'), paM2(i.balance))}</div>
    ${pays.length === 0 ? `<div class="empty-note" style="margin:6px 0;">${t('paPayEmpty')}</div>` : `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('paPayDate')}</th><th class="num">${t('invPayAmount')}</th><th>${t('invPayMethod')}</th><th>${t('colNote')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">
      <div style="font-size:12.5px;font-weight:700;margin-bottom:6px;">${ed ? t('paPayEditTitle') : t('paPayAddTitle')}</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;">
        <div class="field"><label>${t('paPayDate')}</label><input type="date" id="paPayDate" value="${paEsc(dateV)}" /></div>
        <div class="field"><label>${t('invPayAmount')}</label><input type="number" id="paPayAmount" step="0.01" value="${paEsc(amtV)}" placeholder="0.00" /></div>
        <div class="field"><label>${t('invPayMethod')}</label><select id="paPayMethod">${methods.map(m => `<option value="${paEsc(m)}" ${m === methodV ? 'selected' : ''}>${paEsc(m)}</option>`).join('')}</select></div>
        <div class="field"><label>${t('colNote')}</label><input type="text" id="paPayNote" value="${paEsc(ed ? (ed.note || '') : '')}" /></div>
      </div>
      <div id="paPayMsg" class="msg"></div>
    </div>
    ${typeof ppApplyHtml === 'function' ? ppApplyHtml(p, tg) : ''}
    <div class="modal-actions">
      <button class="btn ghost" onclick="paClosePayments()">${t('btnClose')}</button>
      ${ed ? `<button class="btn ghost" onclick="paPay.editingId=null;paRenderPayments()">${t('btnCancel')}</button>` : ''}
      <button class="btn" onclick="paPaySave()">${ed ? t('btnSave') : t('paPayAddBtn')}</button>
    </div>
  </div>`;
}
function paPayPurchase(){
  if(paPay && paPay.sid){ const e = (typeof oeFind === 'function') ? oeFind(paPay.sid) : null; return e ? { id: 'exp:' + e.id, partyName: '', invoiceNo: '', _sa: e } : null; }
  return paPay ? purchases.find(x => x.id === paPay.id) : null;
}
function paPayTarget(p){
  if(p && p._sa) return { key: 'exp:' + p._sa.id, exp: { e: { name: p._sa.name, payee: p._sa.payee || '' } }, info: oeInfo(p._sa) };
  if(paPay && (paPay.expId || paPay.expName)){
    const x = paExpList(p).find(y => (paPay.expId && y.e.id === paPay.expId) || (!paPay.expId && y.e.name === paPay.expName));
    if(x) return { key: x.key, exp: x, info: paExpInfo(p, x) };
  }
  return { key: p.id, exp: null, info: paInfo(p) };
}
function paPayEdit(id){ if(paPay){ paPay.editingId = id; paRenderPayments(); } }
async function paPaySave(){
  if(!paPay) return;
  const p = paPayPurchase(); if(!p) return;
  const msg = document.getElementById('paPayMsg');
  const date = (document.getElementById('paPayDate') || {}).value;
  const amt = paR2(parseFloat((document.getElementById('paPayAmount') || {}).value));
  const method = (document.getElementById('paPayMethod') || {}).value || '';
  const note = ((document.getElementById('paPayNote') || {}).value || '').trim();
  const fail = k => { msg.className = 'msg error'; msg.textContent = '⚠ ' + t(k); };
  if(!date){ fail('paPayBadDate'); return; }
  if(!Number.isFinite(amt) || amt === 0){ fail('invPayBadAmount'); return; }
  const tg = paPayTarget(p);
  const total = tg.info.total;
  const other = paR2(paRows.filter(r => r.purchase_id === tg.key && r.id !== paPay.editingId).reduce((s, r) => s + Number(r.amount), 0));
  if(other + amt > total + 0.004){ fail('paPayErrOver'); return; }
  if(tg.exp && tg.exp.e.estimated && !paPay.estOk){
    const ok = await new Promise(resolve => showConfirmModal(t('paExpEstimatedConfirm'), () => resolve(true), () => resolve(false)));
    if(!ok) return;
    paPay.estOk = true;
  }
  msg.className = 'msg'; msg.textContent = t('savingMsg');
  try{
    const { error } = await sb.rpc('purchase_payment_save', { p_purchase_id: tg.key, p_payment_id: paPay.editingId || null, p_date: date, p_amount: amt, p_method: method, p_note: note });
    if(error) throw error;
    await paLoadPayments();
    paPay.editingId = null;
    paRenderPayments();
  }catch(e){
    console.error('儲存進貨付款失敗', e);
    msg.className = 'msg error'; msg.textContent = '⚠ ' + t((e && (e.code === 'PGRST202' || /purchase_payment_save/.test(e.message || ''))) ? 'paNeedSql' : 'invSaveFailed');
  }
}
function paPayDelete(id){
  showConfirmModal(t('paPayDeleteConfirm'), async () => {
    try{
      const { error } = await sb.rpc('purchase_payment_delete', { p_payment_id: id });
      if(error) throw error;
      await paLoadPayments();
      if(paPay){ paPay.editingId = null; paRenderPayments(); }
    }catch(e){ console.error(e); showInfoModal(t('invPaidFailed')); }
  });
}

// ------------------------------------------------------------
// 備份 / 還原 / 清除全部資料(跟 Invoice 一起)
// ------------------------------------------------------------
async function paBackupExport(){
  try{
    const { data, error } = await sb.from('purchase_payments').select('*').limit(50000);
    if(error) return null;
    return data || [];
  }catch(e){ return null; }
}
async function paBackupRestore(rows){
  if(!Array.isArray(rows)) { try{ await sb.rpc('purchase_payments_clear_all'); }catch(e){} return; }
  const { error } = await sb.rpc('purchase_payments_restore_all', { p_rows: rows });
  if(error) throw error;
}
async function paBackupClear(){
  // 還沒執行 SQL(函式不存在)= 沒有這張表,不用清;其他錯誤要丟出去,讓呼叫的地方顯示警告
  const _r = await sb.rpc('purchase_payments_clear_all'); if(_r && _r.error && !(typeof invIsMissingFn === 'function' && invIsMissingFn(_r.error))) throw _r.error;
}

// 這個功能沒開時隱藏會計分頁裡的 Purchase List 選項
// Purchase List 的「＋ New purchase」:跳到 登記進出貨 → 進貨
function paNewPurchase(){
  if(!getCurrentUserTabPermissions().includes('tab-warehouse-ops')){ showInfoModal(t('paNewPurchaseNoAccess')); return; }
  switchTab('tab-warehouse-ops');
  switchWarehouseOpsSubTab('subtab-tx-register');
  setTxType('in');
}
function paApplyVisibility(){
  const sel = document.getElementById('accountingSubtabSelect');
  if(!sel) return;
  const o = Array.from(sel.options).find(x => x.value === 'subtab-acc-purchases');
  if(o){ o.hidden = !paOn(); o.disabled = !paOn(); }
  const o2 = Array.from(sel.options).find(x => x.value === 'subtab-acc-prepay');
  if(o2){ o2.hidden = !paOn(); o2.disabled = !paOn(); }
}
document.addEventListener('DOMContentLoaded', () => { try{ paApplyVisibility(); }catch(e){} });
