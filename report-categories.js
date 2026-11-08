// ============================================================
// 會計報表分類(Report category)
//  · 跟庫存總覽的分類(product.category)是兩套:這個只用在會計報表,由會計在「會計設定」管理
//  · 商品視窗的「會計」分頁裡,每個商品選一個報表分類(product.reportCategory,存名稱)
//  · 清單存在 app_data 的 reportCategories(名稱陣列,順序即報表顯示順序)
// ============================================================
Object.assign(I18N.zh, {
  rcTitle: '會計報表分類', rcHint: '這是會計報表用的商品分類,跟庫存總覽的分類不一樣,只在商品視窗的「會計」分頁選擇。刪除或改名會同步更新已選這個分類的商品。',
  rcAddPh: '新分類名稱', rcAddBtn: '新增', rcEmpty: '還沒有報表分類。', rcRename: '改名', rcRenamePrompt: '把「{name}」改成:', rcDelete: '刪除',
  rcDeleteConfirm: '刪除報表分類「{name}」?有 {n} 個商品選了這個分類,它們會變成「未設定」。', rcDup: '已經有這個分類名稱了。', rcUsed: '{n} 個商品', rcSaveFail: '儲存失敗,請再試一次。',
  rcAddLink: '＋ 新增分類', rcManageLink: '管理分類', rcNewPrompt: '新報表分類名稱:', rcFieldLabel: '報表分類', rcUnset: '(未設定)', rcFieldHint: '會計報表用的分類,跟庫存總覽的分類不同。',
  rcAcctHint: 'MYOB 科目代碼(匯出月結資料用,選填):', rcAcctIncome: '收入', rcAcctCogs: '銷貨成本', rcAcctInv: '存貨', rcAcctPurchase: '進貨', rcAcctPh: '例 4-2001'
});
Object.assign(I18N.en, {
  rcTitle: 'Accounting report categories', rcHint: 'Product categories used only in accounting reports — separate from the stock overview categories. Pick one per product in the product window\'s Accounting tab. Renaming or deleting updates the products that use it.',
  rcAddPh: 'New category name', rcAddBtn: 'Add', rcEmpty: 'No report categories yet.', rcRename: 'Rename', rcRenamePrompt: 'Rename "{name}" to:', rcDelete: 'Delete',
  rcDeleteConfirm: 'Delete report category "{name}"? {n} product(s) use it and will become unset.', rcDup: 'That category name already exists.', rcUsed: '{n} product(s)', rcSaveFail: 'Save failed, please try again.',
  rcAddLink: '＋ Add category', rcManageLink: 'Manage', rcNewPrompt: 'New report category name:', rcFieldLabel: 'Report category', rcUnset: '(unset)', rcFieldHint: 'Category used in accounting reports — separate from the stock overview category.',
  rcAcctHint: 'MYOB account codes (for the monthly export, optional):', rcAcctIncome: 'Income', rcAcctCogs: 'Cost of sales', rcAcctInv: 'Inventory', rcAcctPurchase: 'Purchases', rcAcctPh: 'e.g. 4-2001'
});

let reportCategories = [];
let rcAccounts = {};   // { 分類名稱: { income, cogs, inventory, purchase } } — MYOB 科目代碼
const RC_ACCT_FIELDS = [['income','rcAcctIncome'],['cogs','rcAcctCogs'],['inventory','rcAcctInv'],['purchase','rcAcctPurchase']];
async function rcLoad(){
  try{
    const r = await dbGet('reportCategories');
    if(r && r.value){ const a = JSON.parse(r.value); if(Array.isArray(a)) reportCategories = a.filter(x => typeof x === 'string' && x.trim()); }
  }catch(e){ /* 還沒設定過 */ }
  try{
    const r2 = await dbGet('reportCategoryAccounts');
    if(r2 && r2.value){ const o = JSON.parse(r2.value); if(o && typeof o === 'object' && !Array.isArray(o)) rcAccounts = o; }
  }catch(e){ /* 還沒設定過 */ }
}
async function rcSaveAccounts(){ await dbSet('reportCategoryAccounts', JSON.stringify(rcAccounts)); }
async function rcSetAcct(i, field, val){
  const name = reportCategories[i]; if(!name) return;
  const prev = JSON.stringify(rcAccounts);
  rcAccounts[name] = Object.assign({}, rcAccounts[name] || {}, { [field]: String(val || '').trim() });
  try{ await rcSaveAccounts(); }catch(e){ console.error(e); rcAccounts = JSON.parse(prev); rcRenderSettings(); rcMsg('rcSaveFail'); }
}
async function rcSave(){ await dbSet('reportCategories', JSON.stringify(reportCategories)); }
function rcEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function rcCount(name){ return products.filter(p => p.reportCategory === name).length; }
// 商品視窗「會計」分頁的下拉選單
function rcSelectHtml(current){
  const list = reportCategories.slice();
  if(current && !list.includes(current)) list.push(current);
  return `<select id="editProdReportCategory" style="width:100%;padding:8px;"><option value="">${t('rcUnset')}</option>${list.map(c => `<option value="${rcEsc(c)}" ${c === current ? 'selected' : ''}>${rcEsc(c)}</option>`).join('')}</select>
    <span class="del-link" style="display:inline-block;margin-top:4px;" onclick="rcAddInModal()">${t('rcAddLink')}</span>
    <span class="del-link" style="display:inline-block;margin:4px 0 0 12px;" onclick="rcOpenManage()">${t('rcManageLink')}</span>`;
}
// 商品視窗的下拉選單重新整理(保留目前選的值)
function rcRefreshSelect(selectValue){
  const sel = document.getElementById('editProdReportCategory'); if(!sel) return;
  const cur = selectValue !== undefined ? selectValue : sel.value;
  const list = reportCategories.slice(); if(cur && !list.includes(cur)) list.push(cur);
  sel.innerHTML = `<option value="">${t('rcUnset')}</option>` + list.map(c => `<option value="${rcEsc(c)}">${rcEsc(c)}</option>`).join('');
  sel.value = list.includes(cur) ? cur : '';
}
async function rcAddInModal(){
  const input = window.prompt(t('rcNewPrompt'), ''); if(input === null) return;
  const name = input.trim(); if(!name) return;
  const existing = reportCategories.find(c => c.trim().toLowerCase() === name.toLowerCase());
  if(existing){ rcRefreshSelect(existing); return; }
  const prev = reportCategories.slice(); reportCategories.push(name);
  try{ await rcSave(); }catch(e){ console.error('儲存報表分類失敗', e); reportCategories = prev; showInfoModal(t('rcSaveFail')); return; }
  rcRefreshSelect(name);
}
// 管理分類(改名 / 刪除 / 調整順序)
function rcOpenManage(){
  let ov = document.getElementById('rcManageOverlay');
  if(!ov){
    ov = document.createElement('div'); ov.id = 'rcManageOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1300';
    ov.onclick = e => { if(e.target === ov) rcCloseManage(); };
    ov.innerHTML = `<div class="modal-box" style="max-width:min(480px,96vw);max-height:90vh;overflow:auto;"><div id="reportCategoryCard"></div><div class="modal-actions"><button class="btn ghost" onclick="rcCloseManage()">${t('btnClose')}</button></div></div>`;
    document.body.appendChild(ov);
  }
  rcRenderSettings();
}
function rcCloseManage(){ const o = document.getElementById('rcManageOverlay'); if(o) o.remove(); rcRefreshSelect(); }
function rcRenderSettings(){
  const box = document.getElementById('reportCategoryCard'); if(!box) return;
  const rows = reportCategories.map((c, i) => `<div class="cat-order-row">
      <span class="cat-order-name">${rcEsc(c)} <span style="font-size:11px;color:var(--ink-soft);">${tf('rcUsed', { n: rcCount(c) })}</span></span>
      <button onclick="rcMove(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button onclick="rcMove(${i}, 1)" ${i === reportCategories.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="cat-order-rename-btn" onclick="rcRename(${i})">${t('rcRename')}</button>
      <button class="cat-order-rename-btn" style="color:var(--crit);" onclick="rcDelete(${i})">${t('rcDelete')}</button></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 10px;font-size:11.5px;color:var(--ink-soft);">${RC_ACCT_FIELDS.map(([f, k]) => `<label style="display:flex;flex-direction:column;gap:2px;">${t(k)}<input type="text" style="width:96px;padding:4px 6px;" placeholder="${rcEsc(t('rcAcctPh'))}" value="${rcEsc((rcAccounts[c] || {})[f] || '')}" onchange="rcSetAcct(${i}, '${f}', this.value)" /></label>`).join('')}</div>`).join('');
  box.innerHTML = `<div class="section-title">${t('rcTitle')}</div>
    <p style="font-size:11.5px;color:var(--ink-soft);margin:0 0 4px;">${t('rcHint')}</p>
    <p style="font-size:11.5px;color:var(--ink-soft);margin:0 0 8px;">${t('rcAcctHint')}</p>
    ${rows || `<div class="empty-note">${t('rcEmpty')}</div>`}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">
      <input id="rcNew" type="text" placeholder="${rcEsc(t('rcAddPh'))}" onkeydown="if(event.key==='Enter')rcAdd()" />
      <button class="btn ghost" onclick="rcAdd()">${t('rcAddBtn')}</button><span id="rcMsg" style="font-size:12px;"></span></div>`;
}
function rcMsg(k){ const m = document.getElementById('rcMsg'); if(m){ m.style.color = 'var(--crit)'; m.textContent = k ? t(k) : ''; } }
async function rcPersist(prev){
  try{ await rcSave(); }catch(e){ console.error('儲存報表分類失敗', e); reportCategories = prev; rcRenderSettings(); rcMsg('rcSaveFail'); return false; }
  rcRenderSettings(); return true;
}
async function rcAdd(){
  const el = document.getElementById('rcNew'); const name = (el.value || '').trim(); if(!name) return;
  if(reportCategories.some(c => c.trim().toLowerCase() === name.toLowerCase())){ rcMsg('rcDup'); return; }
  const prev = reportCategories.slice(); reportCategories.push(name); await rcPersist(prev);
}
async function rcMove(i, d){
  const j = i + d; if(j < 0 || j >= reportCategories.length) return;
  const prev = reportCategories.slice(); [reportCategories[i], reportCategories[j]] = [reportCategories[j], reportCategories[i]]; await rcPersist(prev);
}
async function rcRename(i){
  const old = reportCategories[i]; if(!old) return;
  const input = window.prompt(tf('rcRenamePrompt', { name: old }), old); if(input === null) return;
  const name = input.trim(); if(!name || name === old) return;
  if(reportCategories.some((c, k) => k !== i && c.trim().toLowerCase() === name.toLowerCase())){ rcMsg('rcDup'); return; }
  const prev = reportCategories.slice(); reportCategories[i] = name;
  if(rcAccounts[old]){ rcAccounts[name] = rcAccounts[old]; delete rcAccounts[old]; try{ await rcSaveAccounts(); }catch(e){ console.error(e); } }
  products.forEach(p => { if(p.reportCategory === old) p.reportCategory = name; });
  try{ await saveProducts(); }catch(e){ console.error(e); }
  await rcPersist(prev);
}
function rcDelete(i){
  const name = reportCategories[i]; if(!name) return;
  showConfirmModal(tf('rcDeleteConfirm', { name, n: rcCount(name) }), async () => {
    const prev = reportCategories.slice(); reportCategories.splice(i, 1);
    if(rcAccounts[name]){ delete rcAccounts[name]; try{ await rcSaveAccounts(); }catch(e){ console.error(e); } }
    products.forEach(p => { if(p.reportCategory === name) delete p.reportCategory; });
    try{ await saveProducts(); }catch(e){ console.error(e); }
    await rcPersist(prev);
  });
}


// ----- 完整備份 / 還原:會計報表分類、科目代碼、MYOB 卡片名稱、手動新增的庫存分類 -----
// 舊備份沒有 acctSettings 時,不動目前的設定(這些是設定,不是交易資料)
// 其他會計/系統設定(app_data 原始字串):預設幣種、常用幣種與支出項目、會計 Email、Sell price 設定、批次到期警示天數
const ACCT_APPDATA_KEYS = ['systemCurrency', 'purchaseCurrencies', 'purchaseExpenseNames', 'accountingEmails', 'sellPriceBasis', 'sellWarnMargin', 'batchDefaultMargin', 'batchExpiryWarnDays', 'docEmailTemplate'];
async function acctAppDataExport(){
  const out = {};
  for(const k of ACCT_APPDATA_KEYS){
    try{ const r = await dbGet(k); if(r && r.value !== undefined && r.value !== null) out[k] = String(r.value); }catch(e){}
  }
  return out;
}
async function acctAppDataRestore(m){
  if(!m || typeof m !== 'object' || Array.isArray(m)) return;
  for(const k of ACCT_APPDATA_KEYS){
    if(typeof m[k] !== 'string') continue;
    try{ await dbSet(k, m[k]); }catch(e){ console.error('還原設定失敗:' + k, e); }
  }
  // 重新載入到畫面使用的變數
  try{ if(typeof loadSystemCurrency === 'function') await loadSystemCurrency(); }catch(e){}
  try{ if(typeof loadSellPriceSettings === 'function') await loadSellPriceSettings(); }catch(e){}
  try{ if(typeof loadBatchExpiryWarnDays === 'function') await loadBatchExpiryWarnDays(); }catch(e){}
  try{ if(typeof pcLoaded !== 'undefined'){ pcLoaded = false; pcLoading = false; if(typeof pcEnsureLoaded === 'function') await pcEnsureLoaded(); } }catch(e){}
  try{ if(typeof accountingEmails !== 'undefined' && typeof m.accountingEmails === 'string'){ const a = JSON.parse(m.accountingEmails); if(Array.isArray(a)){ accountingEmails = a; if(typeof renderAccountingEmailList === 'function') renderAccountingEmailList(); } } }catch(e){}
}
// Clear All Data / Clear Data, Keep Settings 用:
//   清「跟商品、客戶資料綁在一起」的設定(報表分類、科目代碼、MYOB 卡名稱、手動新增的庫存分類);
//   includePrefs = true(完全清除)時,連偏好也重設成預設值(幣種、平均成本算法、Sell price 設定、Invoice 格式與公司資料、批次到期警示天數)。
// 這些設定都包含在完整備份裡,還原備份就會回來。
async function acctSettingsWipe(includePrefs){
  reportCategories = []; await rcSave();
  rcAccounts = {}; await rcSaveAccounts();
  if(typeof myobCards !== 'undefined'){ myobCards = {}; await dbSet('myobCards', '{}'); }
  if(typeof categoryManual !== 'undefined'){ categoryManual = []; await saveCategoryManual(); }
  if(typeof categoryOrder !== 'undefined'){ categoryOrder = ['未分類']; await saveCategoryOrder(); }
  if(!includePrefs) return;
  if(typeof psAvgMethod !== 'undefined'){ psAvgMethod = 'batch'; psMovByItem = null; await dbSet('avgCostMethod', 'batch'); }
  if(typeof systemCurrency !== 'undefined'){ systemCurrency = 'AUD'; await dbSet('systemCurrency', 'AUD'); }
  if(typeof pcCurrencies !== 'undefined'){ pcCurrencies = PC_DEFAULT_CURRENCIES.slice(); await dbSet('purchaseCurrencies', '[]'); }
  if(typeof pcExpenseNames !== 'undefined'){ pcExpenseNames = []; await dbSet('purchaseExpenseNames', '[]'); }
  if(typeof spSellBasis !== 'undefined'){ spSellBasis = 'batch'; spWarnMarginPct = 0; spDefaultMarginPct = 0; await dbSet('sellPriceBasis', 'batch'); await dbSet('sellWarnMargin', '0'); await dbSet('batchDefaultMargin', '0'); }
  if(typeof batchExpiryWarnDays !== 'undefined'){ batchExpiryWarnDays = 30; await dbSet('batchExpiryWarnDays', '30'); }
  if(typeof invSettings !== 'undefined'){ Object.keys(invSettings).forEach(k => { invSettings[k] = (k === 'codGraceDays') ? '7' : ''; }); await dbSet('invoiceSettings', JSON.stringify(invSettings)); }
}
async function acctSettingsBackupExport(){
  return {
    appData: await acctAppDataExport(),
    reportCategories, reportCategoryAccounts: rcAccounts, myobCards: (typeof myobCards !== 'undefined') ? myobCards : {}, categoryManual: (typeof categoryManual !== 'undefined') ? categoryManual : [], avgCostMethod: (typeof psAvgMethod !== 'undefined') ? psAvgMethod : 'batch' };
}
async function acctSettingsBackupRestore(backup){
  const d = backup && backup.acctSettings; if(!d || typeof d !== 'object') return;
  await acctAppDataRestore(d.appData);
  if(Array.isArray(d.reportCategories)){ reportCategories = d.reportCategories.filter(x => typeof x === 'string' && x.trim()); await rcSave(); }
  if(d.reportCategoryAccounts && typeof d.reportCategoryAccounts === 'object' && !Array.isArray(d.reportCategoryAccounts)){ rcAccounts = d.reportCategoryAccounts; await rcSaveAccounts(); }
  if(d.myobCards && typeof d.myobCards === 'object' && !Array.isArray(d.myobCards) && typeof myobCards !== 'undefined'){ myobCards = d.myobCards; await dbSet('myobCards', JSON.stringify(myobCards)); }
  if((d.avgCostMethod === 'moving' || d.avgCostMethod === 'batch') && typeof psAvgMethod !== 'undefined'){ psAvgMethod = d.avgCostMethod; await dbSet('avgCostMethod', psAvgMethod); }
  if(Array.isArray(d.categoryManual) && typeof categoryManual !== 'undefined'){ categoryManual = d.categoryManual.filter(x => typeof x === 'string' && x.trim()); await saveCategoryManual(); }
}

// 商品匯入:Excel 的「Report Category」欄位——名稱(忽略大小寫/空白)對應到現有分類;沒有的就新增進清單
async function rcImportNormalize(items){
  let added = false;
  (items || []).forEach(it => {
    const raw = (it.reportCategory || '').trim(); if(!raw){ it.reportCategory = null; return; }
    const hit = reportCategories.find(c => c.trim().toLowerCase() === raw.toLowerCase());
    if(hit){ it.reportCategory = hit; } else { reportCategories.push(raw); it.reportCategory = raw; added = true; }
  });
  if(added) await rcSave();
}
