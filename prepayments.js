// ============================================================
// 供應商預付款(貨還沒到先付的錢)
//  · 會計 →「預付款」子分頁:登記 / 修改 / 刪除預付款(可連結一份進貨預估紀錄),看已抵扣與餘額
//  · 進貨單的付款記錄視窗:可用同一個供應商的預付款抵扣(會同時新增一筆付款,方式 Prepayment)
//  · 會計報表:資產負債表項目「Prepayments」= 截至某日還沒抵扣的預付款
// 預付款不算進貨、不算費用、不影響應付帳款;抵扣進貨單之後才變成那張進貨單的付款。GST 依進貨單日期計算,預付款本身不計 GST。
// 資料表:sql/supplier_prepayments.sql。只有 admin / accountant 讀得到;倉管員看不到任何預付款資訊。
// ============================================================
Object.assign(I18N.zh, {
  subtabAccPrepay: '預付款', ppTitle: '供應商預付款', ppAdd: '＋ 登記預付款', ppEmpty: '還沒有預付款紀錄。',
  ppSumBalance: '未抵扣餘額', ppSumPaid: '預付總額', ppSumApplied: '已抵扣',
  ppColDate: '付款日期', ppColSupplier: '進貨方', ppColForecast: '預估紀錄', ppColAmount: '金額', ppColApplied: '已抵扣', ppColBalance: '餘額', ppColNote: '方式 / 備註',
  ppFormAdd: '登記預付款', ppFormEdit: '修改預付款', ppFSupplier: '進貨方', ppFForecast: '連結進貨預估紀錄(選填)', ppFNone: '不連結', ppFDate: '付款日期', ppFAmount: '金額', ppFMethod: '付款方式', ppFNote: '備註',
  ppFRefund: '這是供應商退回預付款(取消訂單)', ppFPickSupplier: '請選擇進貨方', ppFBadAmount: '金額必須大於 0', ppFBadDate: '請填付款日期',
  ppRefundTag: '退回', ppAppliedTo: '抵扣', ppViewForecast: '查看預估紀錄', ppForecastGone: '預估紀錄已不存在(名稱:{n})',
  ppDeleteConfirm: '確定刪除這筆預付款?', ppErrInUse: '這筆預付款已經抵扣過進貨單,不能刪除或把金額改得比已抵扣的少。請先到進貨單的付款記錄刪除抵扣的那一筆。',
  ppErrExceeds: '退回金額超過這個進貨方目前的預付款餘額。', ppNeedSql: '請先在 Supabase 執行 sql/supplier_prepayments.sql 才能使用預付款。', ppSaveFailed: '儲存失敗,請再試一次。',
  ppApplyTitle: '用預付款抵扣', ppApplyPick: '選擇預付款', ppApplyAmount: '抵扣金額', ppApplyBtn: '抵扣', ppApplyBad: '抵扣金額必須大於 0,不能超過預付款餘額,也不能超過這張進貨單的未付金額。',
  ppApplyLinked: '(連結這張進貨單的預估紀錄)', ppApplyAvail: '可用餘額', ppApplyRemain: '餘額',
  ppBtnRegister: '預付款', ppPaidTag: '已預付 {a}', ppForecastPaid: '預付款',
  arpStBalPrepay: 'Prepayments 供應商預付款(尚未抵扣)'
});
Object.assign(I18N.en, {
  subtabAccPrepay: 'Prepayments', ppTitle: 'Supplier prepayments', ppAdd: '＋ Add prepayment', ppEmpty: 'No prepayments yet.',
  ppSumBalance: 'Unapplied balance', ppSumPaid: 'Total prepaid', ppSumApplied: 'Applied',
  ppColDate: 'Paid on', ppColSupplier: 'Supplier', ppColForecast: 'Forecast record', ppColAmount: 'Amount', ppColApplied: 'Applied', ppColBalance: 'Balance', ppColNote: 'Method / note',
  ppFormAdd: 'Add prepayment', ppFormEdit: 'Edit prepayment', ppFSupplier: 'Supplier', ppFForecast: 'Linked purchase forecast record (optional)', ppFNone: 'None', ppFDate: 'Paid on', ppFAmount: 'Amount', ppFMethod: 'Method', ppFNote: 'Note',
  ppFRefund: 'Supplier refunded a prepayment (order cancelled)', ppFPickSupplier: 'Please choose a supplier', ppFBadAmount: 'Amount must be above 0', ppFBadDate: 'Please enter the payment date',
  ppRefundTag: 'Refund', ppAppliedTo: 'Applied to', ppViewForecast: 'View forecast record', ppForecastGone: 'Forecast record no longer exists (name: {n})',
  ppDeleteConfirm: 'Delete this prepayment?', ppErrInUse: 'This prepayment has already been applied to a purchase, so it cannot be deleted or reduced below the applied amount. Delete the applied payment on the purchase first.',
  ppErrExceeds: 'The refund is more than this supplier\'s current prepayment balance.', ppNeedSql: 'Run sql/supplier_prepayments.sql in Supabase first to use prepayments.', ppSaveFailed: 'Save failed, please try again.',
  ppApplyTitle: 'Apply a prepayment', ppApplyPick: 'Prepayment', ppApplyAmount: 'Amount to apply', ppApplyBtn: 'Apply', ppApplyBad: 'The amount must be above 0, not more than the prepayment balance, and not more than this purchase\'s unpaid amount.',
  ppApplyLinked: '(forecast record linked to this purchase)', ppApplyAvail: 'available', ppApplyRemain: 'balance',
  ppBtnRegister: 'Prepayment', ppPaidTag: 'Prepaid {a}', ppForecastPaid: 'Prepayments',
  arpStBalPrepay: 'Prepayments to suppliers (not yet applied)'
});

let ppRows = [], ppApps = [], ppErr = '', ppLoaded = false;
function ppOn(){ return typeof isInvoiceRole === 'function' && isInvoiceRole() && typeof paOn === 'function' && paOn(); }
function ppEsc(s){ return (typeof paEsc === 'function') ? paEsc(s) : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ppR2(n){ return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function ppM(n){ return ppR2(n).toFixed(2); }

async function ppLoad(){
  ppErr = '';
  if(!ppOn()){ ppRows = []; ppApps = []; return; }
  try{
    const a = await sb.from('supplier_prepayments').select('*').order('pay_date', { ascending: true }).order('created_at', { ascending: true }).limit(20000);
    if(a.error) throw a.error;
    const b = await sb.from('prepayment_applications').select('*').order('apply_date', { ascending: true }).limit(20000);
    if(b.error) throw b.error;
    ppRows = a.data || []; ppApps = b.data || []; ppLoaded = true;
  }catch(e){
    ppRows = []; ppApps = [];
    ppErr = (e && (e.code === '42P01' || /supplier_prepayments|prepayment_applications/.test(e.message || ''))) ? 'sql' : 'error';
    if(ppErr === 'error') console.error('讀取預付款失敗', e);
  }
}
function ppAppliedOf(id){ return ppR2(ppApps.filter(a => a.prepayment_id === id).reduce((s, a) => s + Number(a.amount), 0)); }
function ppBalanceOf(r){ return ppR2(Number(r.amount) - ppAppliedOf(r.id)); }
// 截至某日(含)還沒抵扣的預付款合計(付款日期 ≤ 該日的預付款 / 退回,減去抵扣日期 ≤ 該日的抵扣)
function ppBalanceAsOf(D){
  const paid = ppRows.filter(r => r.pay_date && r.pay_date <= D).reduce((s, r) => s + Number(r.amount), 0);
  const used = ppApps.filter(a => a.apply_date && a.apply_date <= D).reduce((s, a) => s + Number(a.amount), 0);
  return ppR2(paid - used);
}
function ppForRecord(forecastId){ return ppRows.filter(r => r.forecast_id === forecastId); }
function ppPaidForRecord(forecastId){ return ppR2(ppForRecord(forecastId).reduce((s, r) => s + Number(r.amount), 0)); }
function ppErrMsg(e){
  const m = (e && e.message) || '';
  if(/prepayment_in_use/.test(m)) return t('ppErrInUse');
  if(/prepayment_exceeds/.test(m)) return t('ppErrExceeds');
  if(e && (e.code === 'PGRST202' || /prepayment_(save|apply|delete)/.test(m) && /function/.test(m))) return t('ppNeedSql');
  return t('ppSaveFailed');
}

// ---- 子分頁 ----
let ppEdit = null;
async function ppOpenPage(){
  const root = document.getElementById('prepaymentRoot'); if(!root) return;
  if(!ppOn()){ root.innerHTML = ''; return; }
  root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  try{ if(typeof ensurePurchasesLoaded === 'function') await ensurePurchasesLoaded(); }catch(e){}
  try{ if(typeof loadForecastRecords === 'function') await loadForecastRecords(); }catch(e){}
  await ppLoad();
  ppRender();
}
function ppRender(){
  const root = document.getElementById('prepaymentRoot'); if(!root) return;
  if(ppErr === 'sql'){ root.innerHTML = `<div class="msg error">${t('ppNeedSql')}</div>`; return; }
  if(ppErr){ root.innerHTML = `<div class="msg error">${t('ppSaveFailed')}</div>`; return; }
  const paid = ppR2(ppRows.reduce((s, r) => s + Number(r.amount), 0)), applied = ppR2(ppApps.reduce((s, a) => s + Number(a.amount), 0));
  const box = (label, v) => `<div style="flex:1 1 140px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${label}</div><b>${v}</b></div>`;
  const purName = id => { const p = (typeof purchases !== 'undefined' ? purchases : []).find(x => x.id === id); return p ? [p.date, p.invoiceNo ? '#' + p.invoiceNo : ''].filter(Boolean).join(' ') : ''; };
  const rows = ppRows.slice().sort((a, b) => (b.pay_date || '').localeCompare(a.pay_date || '')).map(r => {
    const used = ppAppliedOf(r.id), bal = ppR2(Number(r.amount) - used), refund = Number(r.amount) < 0;
    const apps = ppApps.filter(a => a.prepayment_id === r.id).map(a => `${ppEsc(paDmy(a.apply_date))} ${ppEsc(purName(a.purchase_id))} ${ppM(a.amount)}`).join('<br>');
    const fr = r.forecast_id ? `<span class="del-link" style="color:var(--ink);" onclick="ppViewForecast('${ppEsc(r.forecast_id)}','${ppEsc(r.forecast_name || '')}')">${ppEsc(r.forecast_name || '–')}</span>` : '–';
    return `<tr>
      <td style="white-space:nowrap;">${ppEsc(paDmy(r.pay_date))}</td><td>${ppEsc(r.party_name)}${refund ? ` <span style="font-size:11px;color:#6b3fa0;font-weight:700;">${t('ppRefundTag')}</span>` : ''}</td><td>${fr}</td>
      <td class="num">${ppM(r.amount)}</td><td class="num">${refund ? '–' : ppM(used)}${apps ? `<div style="font-size:10.5px;color:var(--ink-soft);text-align:right;">${apps}</div>` : ''}</td><td class="num"><b>${refund ? '–' : ppM(bal)}</b></td>
      <td>${ppEsc(r.method || '')}${r.note ? ' · ' + ppEsc(r.note) : ''}<div style="font-size:10.5px;color:var(--ink-soft);">${ppEsc(r.created_by || '')}</div></td>
      <td style="white-space:nowrap;text-align:right;"><span class="del-link" onclick="ppOpenForm('${ppEsc(r.id)}')" style="margin-right:6px;">${t('btnEdit')}</span><span class="del-link" onclick="ppDelete('${ppEsc(r.id)}')">${t('btnDelete')}</span></td></tr>`;
  }).join('');
  root.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">${box(t('ppSumBalance'), ppM(paid - applied))}${box(t('ppSumPaid'), ppM(paid))}${box(t('ppSumApplied'), ppM(applied))}</div>
    ${ppRows.length === 0 ? `<div class="empty-note">${t('ppEmpty')}</div>` : `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('ppColDate')}</th><th>${t('ppColSupplier')}</th><th>${t('ppColForecast')}</th><th class="num">${t('ppColAmount')}</th><th class="num">${t('ppColApplied')}</th><th class="num">${t('ppColBalance')}</th><th>${t('ppColNote')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}`;
}

// ---- 預估紀錄明細(從預付款列表點進去) ----
function ppViewForecast(id, name){
  const r = (typeof forecastRecords !== 'undefined' ? forecastRecords : []).find(x => x.id === id);
  if(!r){ showInfoModal(tf('ppForecastGone', { n: name || '' })); return; }
  let ov = document.getElementById('ppForecastOverlay');
  if(!ov){ ov = document.createElement('div'); ov.id = 'ppForecastOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1260'; ov.onclick = e => { if(e.target === ov) ov.remove(); }; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="modal-box" style="max-width:min(560px,96vw);max-height:90vh;overflow:auto;"><div class="section-title" style="margin-top:0;">${ppEsc(r.name)}</div>${forecastRecordDetailHtml(r)}<div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('ppForecastOverlay').remove()">${t('btnClose')}</button></div></div>`;
}

// ---- 登記 / 修改 ----
async function ppOpenForm(id, forecastId){
  if(!ppOn()) return;
  if(!ppLoaded) await ppLoad();
  try{ if(typeof loadForecastRecords === 'function' && !(typeof forecastRecords !== 'undefined' && forecastRecords.length)) await loadForecastRecords(); }catch(e){}
  const ed = id ? ppRows.find(x => x.id === id) : null;
  ppEdit = { id: id || '', forecastId: ed ? (ed.forecast_id || '') : (forecastId || '') };
  const sups = (typeof purchaseSuppliers !== 'undefined' ? purchaseSuppliers : []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const recSup = rid => { const r = (typeof forecastRecords !== 'undefined' ? forecastRecords : []).find(x => x.id === rid); return r && r.supplierName ? r.supplierName : ''; };
  const supV = ed ? ed.party_name : (recSup(ppEdit.forecastId) || '');
  const recs = (typeof forecastRecords !== 'undefined' ? forecastRecords : []).filter(r => !r.converted || r.id === ppEdit.forecastId).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const refund = ed && Number(ed.amount) < 0;
  const methodV = ed ? (ed.method || 'Bank Transfer') : 'Bank Transfer';
  const methods = (typeof PA_METHODS !== 'undefined' ? PA_METHODS : ['Bank Transfer']).concat(methodV && !(typeof PA_METHODS !== 'undefined' ? PA_METHODS : []).includes(methodV) ? [methodV] : []);
  let ov = document.getElementById('ppFormOverlay');
  if(!ov){ ov = document.createElement('div'); ov.id = 'ppFormOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250'; ov.onclick = e => { if(e.target === ov) ppCloseForm(); }; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="modal-box" style="max-width:min(520px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${ed ? t('ppFormEdit') : t('ppFormAdd')}</div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;">
      <div class="field" style="grid-column:1/3;"><label>${t('ppFSupplier')}</label><select id="ppFSup" ${(!ed && recSup(ppEdit.forecastId)) ? 'disabled' : ''}><option value="">${t('ppFPickSupplier')}</option>${sups.map(s => `<option value="${ppEsc(s.name)}" data-id="${ppEsc(s.id)}" ${s.name === supV ? 'selected' : ''}>${ppEsc(s.name)}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:1/3;"><label>${t('ppFForecast')}</label><select id="ppFForecast" onchange="ppOnForecastPick(this.value)"><option value="">${t('ppFNone')}</option>${recs.map(r => `<option value="${ppEsc(r.id)}" ${r.id === ppEdit.forecastId ? 'selected' : ''}>${ppEsc(r.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${t('ppFDate')}</label><input type="date" id="ppFDate" value="${ppEsc(ed ? ed.pay_date : paToday())}" /></div>
      <div class="field"><label>${t('ppFAmount')}</label><input type="number" id="ppFAmount" step="0.01" min="0" value="${ed ? ppM(Math.abs(ed.amount)) : ''}" placeholder="0.00" /></div>
      <div class="field"><label>${t('ppFMethod')}</label><select id="ppFMethod">${methods.map(m => `<option value="${ppEsc(m)}" ${m === methodV ? 'selected' : ''}>${ppEsc(m)}</option>`).join('')}</select></div>
      <div class="field"><label>${t('ppFNote')}</label><input type="text" id="ppFNote" value="${ppEsc(ed ? (ed.note || '') : '')}" /></div>
      <label style="grid-column:1/3;display:flex;align-items:center;gap:6px;font-weight:400;"><input type="checkbox" id="ppFRefund" ${refund ? 'checked' : ''} /> ${t('ppFRefund')}</label>
    </div>
    <div id="ppFMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="ppCloseForm()">${t('btnCancel')}</button><button class="btn" onclick="ppSave()">${t('btnSave')}</button></div>
  </div>`;
}
// 選了預估紀錄:紀錄有指定進貨方就自動帶入並鎖住;沒有就保持可手動選
function ppOnForecastPick(rid){
  const sel = document.getElementById('ppFSup'); if(!sel) return;
  const r = (typeof forecastRecords !== 'undefined' ? forecastRecords : []).find(x => x.id === rid);
  if(r && r.supplierName){ sel.value = r.supplierName; sel.disabled = true; } else { sel.disabled = false; }
}
function ppCloseForm(){ const o = document.getElementById('ppFormOverlay'); if(o) o.remove(); ppEdit = null; }
async function ppSave(){
  if(!ppEdit) return;
  const msg = document.getElementById('ppFMsg');
  const fail = k => { msg.className = 'msg error'; msg.textContent = '⚠ ' + t(k); };
  const sel = document.getElementById('ppFSup'); const name = sel.value;
  if(!name){ fail('ppFPickSupplier'); return; }
  const partyId = (sel.options[sel.selectedIndex] || {}).getAttribute ? (sel.options[sel.selectedIndex].getAttribute('data-id') || '') : '';
  const date = document.getElementById('ppFDate').value; if(!date){ fail('ppFBadDate'); return; }
  let amt = ppR2(parseFloat(document.getElementById('ppFAmount').value));
  if(!Number.isFinite(amt) || amt <= 0){ fail('ppFBadAmount'); return; }
  if(document.getElementById('ppFRefund').checked) amt = -amt;
  const fid = document.getElementById('ppFForecast').value;
  const rec = fid ? (forecastRecords || []).find(r => r.id === fid) : null;
  const prev = ppEdit.id ? ppRows.find(x => x.id === ppEdit.id) : null;
  msg.className = 'msg'; msg.textContent = t('savingMsg');
  try{
    const { error } = await sb.rpc('prepayment_save', { p_id: ppEdit.id || null, p_party_id: partyId, p_party_name: name, p_date: date, p_amount: amt,
      p_method: document.getElementById('ppFMethod').value, p_note: document.getElementById('ppFNote').value.trim(),
      p_forecast_id: fid, p_forecast_name: rec ? rec.name : (prev && prev.forecast_id === fid ? (prev.forecast_name || '') : '') });
    if(error) throw error;
    ppCloseForm();
    await ppLoad(); ppRender();
    if(typeof renderForecastRecords === 'function') renderForecastRecords();
  }catch(e){ console.error('儲存預付款失敗', e); msg.className = 'msg error'; msg.textContent = '⚠ ' + ppErrMsg(e); }
}
function ppDelete(id){
  showConfirmModal(t('ppDeleteConfirm'), async () => {
    try{
      const { error } = await sb.rpc('prepayment_delete', { p_id: id });
      if(error) throw error;
      await ppLoad(); ppRender();
      if(typeof renderForecastRecords === 'function') renderForecastRecords();
    }catch(e){ console.error(e); showInfoModal(ppErrMsg(e)); }
  });
}

// ---- 進貨單付款視窗:用預付款抵扣 ----
// 同一個進貨方、還有餘額的預付款;連結這張進貨單的預估紀錄(紀錄匯入進貨時記下的 purchaseId)排前面
function ppCandidates(p){
  const sup = (typeof paSupplierOf === 'function' && paSupplierOf(p)) || null;
  const name = sup ? sup.name : (p.partyName || '');
  const recs = (typeof forecastRecords !== 'undefined' ? forecastRecords : []);
  const linked = r => !!r.forecast_id && recs.some(f => f.id === r.forecast_id && f.purchaseId === p.id);
  return ppRows.filter(r => Number(r.amount) > 0 && r.party_name === name && ppBalanceOf(r) > 0.004)
    .map(r => ({ r, bal: ppBalanceOf(r), linked: linked(r) }))
    .sort((a, b) => (b.linked ? 1 : 0) - (a.linked ? 1 : 0) || (a.r.pay_date || '').localeCompare(b.r.pay_date || ''));
}
function ppApplyHtml(p, tg){
  if(!ppOn() || ppErr || tg.exp || p._sa) return '';
  const c = ppCandidates(p); if(!c.length) return '';
  const first = c[0], def = Math.min(first.bal, Math.max(0, tg.info.balance));
  return `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">
    <div style="font-size:12.5px;font-weight:700;margin-bottom:6px;">${t('ppApplyTitle')}</div>
    <div class="form-grid" style="grid-template-columns:2fr 1fr 1fr auto;gap:8px;align-items:end;">
      <div class="field"><label>${t('ppApplyPick')}</label><select id="ppApplySel" onchange="ppApplySelChange()">${c.map(x => `<option value="${ppEsc(x.r.id)}" data-bal="${ppM(x.bal)}">${ppEsc(paDmy(x.r.pay_date))} · ${ppEsc(x.r.forecast_name || x.r.note || 'Prepayment')} · ${t('ppApplyRemain')} ${ppM(x.bal)}${x.linked ? ' ' + t('ppApplyLinked') : ''}</option>`).join('')}</select></div>
      <div class="field"><label>${t('paPayDate')}</label><input type="date" id="ppApplyDate" value="${ppEsc(paToday())}" /></div>
      <div class="field"><label>${t('ppApplyAmount')} <span id="ppApplyAvail" style="font-weight:400;color:var(--ink-soft);">(${t('ppApplyAvail')} ${ppM(first.bal)})</span></label><input type="number" id="ppApplyAmt" step="0.01" value="${def > 0 ? ppM(def) : ''}" /></div>
      <button class="btn" onclick="ppApply()">${t('ppApplyBtn')}</button>
    </div><div id="ppApplyMsg" class="msg"></div></div>`;
}
function ppApplySelChange(){
  const s = document.getElementById('ppApplySel'), a = document.getElementById('ppApplyAmt'); if(!s || !a || typeof paPay === 'undefined' || !paPay) return;
  const p = paPayPurchase(); if(!p) return;
  const bal = Number((s.options[s.selectedIndex] || {}).getAttribute('data-bal')) || 0;
  a.value = ppM(Math.min(bal, Math.max(0, paPayTarget(p).info.balance)));
  const av = document.getElementById('ppApplyAvail'); if(av) av.textContent = '(' + t('ppApplyAvail') + ' ' + ppM(bal) + ')';
}
async function ppApply(){
  if(typeof paPay === 'undefined' || !paPay) return;
  const p = paPayPurchase(); if(!p) return;
  const msg = document.getElementById('ppApplyMsg');
  const id = (document.getElementById('ppApplySel') || {}).value, date = (document.getElementById('ppApplyDate') || {}).value;
  const amt = ppR2(parseFloat((document.getElementById('ppApplyAmt') || {}).value));
  const row = ppRows.find(x => x.id === id), tg = paPayTarget(p);
  if(!row || !date || !Number.isFinite(amt) || amt <= 0 || amt > ppBalanceOf(row) + 0.004 || amt > tg.info.balance + 0.004){ msg.className = 'msg error'; msg.textContent = '⚠ ' + t('ppApplyBad'); return; }
  msg.className = 'msg'; msg.textContent = t('savingMsg');
  try{
    const { error } = await sb.rpc('prepayment_apply', { p_prepayment_id: id, p_purchase_id: tg.key, p_date: date, p_amount: amt });
    if(error) throw error;
    await paLoadPayments(); await ppLoad();
    paRenderPayments();
  }catch(e){ console.error('預付款抵扣失敗', e); msg.className = 'msg error'; msg.textContent = '⚠ ' + ppErrMsg(e); }
}
