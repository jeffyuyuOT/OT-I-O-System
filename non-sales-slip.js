// ============================================================
// 非銷售出庫單 (Non-Sales Outbound Slip)
// 出貨 → 先選「一般訂單」或「非銷售出庫單」。非銷售出庫單 = 拿貨但不是賣給客戶(樣品、員工內部使用、
// 捐贈…),跟庫存調整一樣一定要寫原因,確認後扣庫存、列印領貨單,並留一份紀錄在「歷史紀錄 → 非銷售出庫單」。
// * 庫存異動仍然是 type:'out' + adjReason(跟庫存調整相同),所以會計報表的耗損/樣品/內部使用歸類不用改。
// * 單據本身存在 non_sales_slips 表(id, payload jsonb),編號由 next_nso_no() RPC 發(NSO-0001…)。
// 需要先執行 sql/non_sales_slips.sql。
// ============================================================
let nonSalesSlips = [];
let nonSalesSlipsLoaded = false;
let nonSalesSlipsLoading = null;
let registerOutKind = 'order';   // 'order'(一般訂單) | 'nonsales'(非銷售出庫單)

async function loadNonSalesSlips(){
  try{
    const { data, error } = await sb.from('non_sales_slips').select('payload');
    if(error) throw error;
    nonSalesSlips = (data || []).map(r => r.payload);
    nonSalesSlipsLoaded = true;
  } catch(e){ console.error('讀取非銷售出庫單失敗', e); nonSalesSlips = []; }
}
function ensureNonSalesSlipsLoaded(){
  if(nonSalesSlipsLoaded) return Promise.resolve();
  if(!nonSalesSlipsLoading) nonSalesSlipsLoading = loadNonSalesSlips().finally(() => { nonSalesSlipsLoading = null; });
  return nonSalesSlipsLoading;
}
async function upsertNonSalesSlips(list){
  if(!list || list.length === 0) return;
  const rows = list.map(s => ({ id: s.id, payload: s, updated_at: new Date().toISOString() }));
  const { error } = await sb.from('non_sales_slips').upsert(rows);
  if(error){ console.error('儲存非銷售出庫單失敗', error); throw error; }
  scheduleAutoBackup();
}
async function clearAllNonSalesSlips(){
  const { error } = await sb.from('non_sales_slips').delete().not('id', 'is', null);
  if(error){ console.error('清空非銷售出庫單失敗', error); throw error; }
  nonSalesSlips = [];
}
async function nsNextNo(){
  const { data, error } = await sb.rpc('next_nso_no');
  if(error){ console.error('取得非銷售出庫單編號失敗', error); throw error; }
  return 'NSO-' + String(data).padStart(4, '0');
}

// ---- 登記進出貨 → 出貨 → 一般訂單 / 非銷售出庫單 ----
function nsIsSlipMode(){ return currentTxType === 'out' && registerOutKind === 'nonsales'; }

function nsApplyLayout(){
  const flowField = document.getElementById('txOutFlowTypeField');
  const orderWrap = document.getElementById('txOutFlowOrderSelectWrap');
  const recWrap = document.getElementById('txNsRecipientWrap');
  const adjWrap = document.getElementById('txAdjReasonWrap');
  const partyWrap = document.getElementById('txPartyFieldWrap');
  const noteLabel = document.getElementById('txNoteLabel');
  const kindSel = document.getElementById('txOutKind');
  if(kindSel) kindSel.value = registerOutKind;
  if(flowField) flowField.style.display = registerOutKind === 'nonsales' ? 'none' : '';
  if(registerOutKind === 'nonsales'){
    if(orderWrap) orderWrap.style.display = 'none';
    if(partyWrap) partyWrap.style.display = 'none';
    if(recWrap) recWrap.style.display = '';
    if(adjWrap) adjWrap.style.display = '';
    if(noteLabel) noteLabel.textContent = t('adjNoteOptionalLabel');
    renderAdjReasonSelect();
    showTxMainFormArea(true);
  } else {
    if(recWrap) recWrap.style.display = 'none';
    if(adjWrap && currentTxType !== 'adjustment') adjWrap.style.display = 'none';
  }
}

function setTxOutKind(kind){
  kind = kind === 'nonsales' ? 'nonsales' : 'order';
  resetRegisterOutFlow();            // 會順便把 registerOutKind 重設成 'order'、版面還原
  registerOutKind = kind;
  adjReasonReset();
  const rec = document.getElementById('txNsRecipient'); if(rec) rec.value = '';
  const note = document.getElementById('txNote'); if(note) note.value = '';
  const msg = document.getElementById('txMsg'); if(msg){ msg.className = 'msg'; msg.textContent = ''; }
  if(kind === 'nonsales') nsApplyLayout();
  else { nsApplyLayout(); setTxOutFlowType(''); }
  renderTxSubmitArea();
  renderTxBatchList();
  renderProductSelect();
}

// resetRegisterOutFlow() 會呼叫:回到「一般訂單」預設狀態
function nsResetKindUi(){
  registerOutKind = 'order';
  const kindSel = document.getElementById('txOutKind'); if(kindSel) kindSel.value = 'order';
  const flowField = document.getElementById('txOutFlowTypeField'); if(flowField) flowField.style.display = '';
  const recWrap = document.getElementById('txNsRecipientWrap'); if(recWrap) recWrap.style.display = 'none';
  const adjWrap = document.getElementById('txAdjReasonWrap'); if(adjWrap && currentTxType !== 'adjustment') adjWrap.style.display = 'none';
}

// ---- 送出:確認 → 扣庫存 → 存單據 → 列印領貨單 ----
async function submitNonSalesSlip(date, msg){
  await ensureNonSalesSlipsLoaded();
  if(!date){ msg.className = 'msg error'; msg.textContent = '請選擇日期'; return; }
  if(!((document.getElementById('txNsRecipient') || {}).value || '').trim()){ msg.className = 'msg error'; msg.textContent = t('errNsRecipientRequired'); return; }
  if(txBatchItems.length === 0){ msg.className = 'msg error'; msg.textContent = t('errAddAtLeastOneItem'); return; }
  const reasonCode = (document.getElementById('txAdjReason') || {}).value || '';
  const reasonInfo = adjReasonInfo(reasonCode);
  if(!reasonInfo){ msg.className = 'msg error'; msg.textContent = t('errAdjReasonRequired'); return; }
  const reasonOther = ((document.getElementById('txAdjReasonOther') || {}).value || '').trim();
  if(reasonCode === 'other' && !reasonOther){ msg.className = 'msg error'; msg.textContent = t('errAdjReasonOtherRequired'); return; }
  if(txBatchItems.some(it => !(it.qty > 0))){ msg.className = 'msg error'; msg.textContent = t('errNsQtyPositive'); return; }
  const extraNote = (document.getElementById('txNote').value || '').trim();
  const recipient = ((document.getElementById('txNsRecipient') || {}).value || '').trim();
  const reasonText = reasonCode === 'other' ? `${adjReasonLabel('other').replace(/[((].*$/, '').trim()} - ${reasonOther}` : adjReasonLabel(reasonCode);

  showConfirmModal(t('confirmNsSlip'), async () => {
    // 列印視窗要在使用者按下確認的當下同步開啟,才不會被瀏覽器當成彈出視窗擋掉
    const pw = window.open('', '_blank');
    const closeWin = () => { try{ if(pw) pw.close(); }catch(e){} };
    let no;
    try{ no = await nsNextNo(); }
    catch(e){ closeWin(); msg.className = 'msg error'; msg.textContent = `⚠ ${t('errNsNeedSql')}`; return; }

    let locChoices = null;
    try{
      locChoices = await resolveLocationChoicesForItems(txBatchItems.map(it => ({ productId: it.productId, qty: it.qty, batchPicks: it.batchPicks })));
    } catch(e){ closeWin(); return; }   // 使用者取消位置選擇

    const noteText = `${t('nsNotePrefix')}${no} · ${reasonText}${recipient ? ' · ' + recipient : ''}${extraNote ? ' - ' + extraNote : ''}`;
    const newTxs = txBatchItems.map(it => ({
      id: genId(), productId: it.productId, type: 'out', qty: it.qty, date, party: '', note: noteText, adjReason: reasonCode
    }));
    transactions.push(...newTxs);
    txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId] || 0) - it.qty; });
    try{ await insertTransactions(newTxs); }
    catch(e){
      newTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i >= 0) transactions.splice(i, 1); });
      txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId] || 0) + it.qty; });
      closeWin();
      msg.className = 'msg error';
      msg.textContent = /adj_reason/.test(String((e && (e.message || e.details)) || '')) ? `⚠ ${t('errAdjNeedSql')}` : '⚠ 提交失敗,請重新整理頁面再試一次。';
      return;
    }
    if(locChoices) await applyLocationDeductions(locChoices);

    const saved = await nsSaveAndPrintSlip({ no, date, reasonCode, reasonText, reasonOther, extraNote, recipient,
      items: txBatchItems, txIds: newTxs.map(x => x.id), pw });
    const count = txBatchItems.length;
    txBatchItems = [];
    document.getElementById('txNote').value = '';
    const rec = document.getElementById('txNsRecipient'); if(rec) rec.value = '';
    adjReasonReset();
    msg.className = saved ? 'msg ok' : 'msg error';
    msg.textContent = saved ? `✓ ${t('nsSubmitted')} ${no}(${count})` : `⚠ ${t('errNsSlipSaveFailed')} ${no}`;
    renderAll();
  });
}

const NS_ADJ_SLIP_REASONS = ['wastage_expired', 'wastage_damaged'];   // 庫存調整裡可以勾「需要領貨單」的原因

// 存單據 + 記後台紀錄 + 列印;回傳是否存檔成功(庫存已經扣了,存檔失敗要提醒)
async function nsSaveAndPrintSlip(o){
  const slip = {
    id: genId(), no: o.no, date: o.date, reason: o.reasonCode, reasonText: o.reasonText, reasonOther: o.reasonOther || '',
    note: o.extraNote || '', recipient: o.recipient || '',
    createdBy: (currentUser && currentUser.username) || '', createdAt: new Date().toISOString(),
    items: o.items.map(it => ({ productId: it.productId, sku: it.sku || '', name: it.name, unit: it.unit, qty: Math.abs(it.qty) })),
    txIds: o.txIds
  };
  let saved = true;
  try{ await upsertNonSalesSlips([slip]); }catch(e){ saved = false; }
  nonSalesSlips.push(slip);
  logInventoryAction('tx_out', `Non-sales outbound slip ${o.no}: ${slip.items.length} item(s) — ${o.reasonText}`, null);
  nsWriteSlipToWindow(slip, o.pw);
  return saved;
}

// 庫存調整:選到耗損(過期/損壞)時顯示「這批需要列印領貨單」,勾選後出現領貨人欄位
function nsUpdateAdjSlipUi(){
  const wrap = document.getElementById('txAdjSlipWrap');
  const chk = document.getElementById('txAdjSlip');
  const recWrap = document.getElementById('txNsRecipientWrap');
  if(currentTxType !== 'adjustment'){ if(wrap) wrap.style.display = 'none'; if(chk) chk.checked = false; return; }
  const sel = document.getElementById('txAdjReason');
  const ok = !!sel && NS_ADJ_SLIP_REASONS.includes(sel.value);
  if(wrap) wrap.style.display = ok ? '' : 'none';
  if(!ok && chk) chk.checked = false;
  if(recWrap) recWrap.style.display = (ok && chk && chk.checked) ? '' : 'none';
}

// ---- 領貨單列印 ----
function nsSlipHtml(slip){
  const esc = escapeHtmlForPrint;
  const rows = (slip.items || []).map(it => `
    <tr><td class="sku-col">${esc(it.sku)}</td><td>${esc(it.name)}</td><td style="text-align:right;">${it.qty}</td><td>${esc(it.unit)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(slip.no)}</title>
<style>
  body{ font-family:'Microsoft JhengHei', Arial, sans-serif; padding:24px; color:#111; }
  h1{ font-size:20px; margin:0 0 4px; }
  h2{ font-size:12.5px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#B23B2E; margin:0 0 14px; }
  .meta{ font-size:13px; color:#333; margin-bottom:3px; }
  table{ border-collapse:collapse; width:100%; margin-top:14px; }
  th, td{ padding:7px 10px; border:1px solid #999; font-size:13px; text-align:left; }
  th{ background:#eee; }
  .sku-col{ width:1%; white-space:nowrap; }
  .sign{ margin-top:48px; display:flex; gap:48px; font-size:13px; }
  .sign div{ flex:1; border-top:1px solid #333; padding-top:6px; }
</style></head><body>
  <h2>Non-Sales Outbound Slip</h2>
  <h1>${esc(slip.no)}</h1>
  <div class="meta">Date: ${esc(slip.date)}</div>
  <div class="meta">Reason: ${esc(slip.reasonText)}</div>
  ${slip.recipient ? `<div class="meta">Recipient: ${esc(slip.recipient)}</div>` : ''}
  ${slip.note ? `<div class="meta">Note: ${esc(slip.note)}</div>` : ''}
  ${slip.createdBy ? `<div class="meta">Issued by: ${esc(slip.createdBy)}</div>` : ''}
  <table>
    <thead><tr><th class="sku-col">SKU</th><th>Product Name</th><th>Qty</th><th>Unit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="sign"><div>Picked by / Signature</div><div>Approved by</div></div>
</body></html>`;
}
function nsWriteSlipToWindow(slip, pw){
  if(!pw){ showInfoModal(t('errPrintPopupBlocked')); return; }
  pw.document.write(nsSlipHtml(slip));
  pw.document.close();
  pw.onload = () => { pw.focus(); pw.print(); };
}
function nsReprintSlip(id){
  const slip = nonSalesSlips.find(s => s.id === id);
  if(!slip) return;
  const pw = window.open('', '_blank');
  nsWriteSlipToWindow(slip, pw);
}

// ---- 歷史紀錄 → 非銷售出庫單 ----
function nsClearLogFilters(){
  ['nsLogDateFrom', 'nsLogDateTo', 'nsLogReasonFilter', 'nsLogSearch'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  renderNonSalesSlipLog();
}
function renderNonSalesSlipLog(){
  const container = document.getElementById('nonSalesSlipLogTable');
  if(!container) return;
  if(!nonSalesSlipsLoaded){ ensureNonSalesSlipsLoaded().then(renderNonSalesSlipLog); return; }
  const esc = escapeHtmlForPrint;
  const reasonSel = document.getElementById('nsLogReasonFilter');
  if(reasonSel){
    const prev = reasonSel.value;
    const codes = [...new Set(nonSalesSlips.map(s => s.reason).filter(Boolean))];
    reasonSel.innerHTML = `<option value="">${t('logPartyAll')}</option>` + codes.map(c => `<option value="${c}">${esc(adjReasonLabel(c))}</option>`).join('');
    if(codes.includes(prev)) reasonSel.value = prev;
  }
  const from = (document.getElementById('nsLogDateFrom') || {}).value || '';
  const to = (document.getElementById('nsLogDateTo') || {}).value || '';
  const reason = reasonSel ? reasonSel.value : '';
  const q = (((document.getElementById('nsLogSearch') || {}).value) || '').trim().toLowerCase();
  let list = nonSalesSlips.slice();
  if(from) list = list.filter(s => (s.date || '') >= from);
  if(to) list = list.filter(s => (s.date || '') <= to);
  if(reason) list = list.filter(s => s.reason === reason);
  if(q) list = list.filter(s => [s.no, s.recipient, s.note, s.createdBy, ...(s.items || []).map(i => i.name + ' ' + i.sku)].join(' ').toLowerCase().includes(q));
  if(list.length === 0){ container.innerHTML = `<div class="empty-note">${t('noRecordsYet')}</div>`; return; }
  list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.no || '').localeCompare(a.no || ''));
  container.innerHTML = `<table class="stock-table">
    <thead><tr><th>${t('colDate')}</th><th>${t('nsColNo')}</th><th>${t('adjReasonLabel').replace(/[((].*$/, '')}</th><th>${t('nsRecipientLabel').replace(/[((].*$/, '')}</th><th>${t('lblProduct')}</th><th></th></tr></thead>
    <tbody>${list.map(s => {
      const items = (s.items || []).map(it => `${esc(it.name)} ${it.qty} ${esc(it.unit)}`).join(', ');
      return `<tr>
        <td style="white-space:nowrap;">${esc(s.date)}</td>
        <td style="white-space:nowrap;">${esc(s.no)}</td>
        <td>${esc(s.reasonText)}${s.note ? `<div style="font-size:11.5px;color:var(--ink-soft);">${esc(s.note)}</div>` : ''}</td>
        <td>${esc(s.recipient)}</td>
        <td>${items}</td>
        <td style="white-space:nowrap;"><button class="btn ghost" style="padding:4px 10px;" onclick="nsReprintSlip('${s.id}')">${t('btnPrint')}</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

// ============================================================
// Delivery Note 的「關聯單據」(必填):已完成訂單 或 非銷售出庫單。大量出貨分批拿貨時,
// 每張 Delivery Note 都要對應到它是為哪張單據拿的貨。輸入單號關鍵字,從資料庫(全部訂單 + 全部
// 非銷售出庫單)找出相似單號供挑選,一定要從清單挑,不能自己亂打。
// ============================================================
let dnRefSelected = null;   // { type:'order'|'nonsales', id, no }
let dnRefCandidates = [];
let dnRefSeq = 0;

function dnRefReset(){
  dnRefSelected = null;
  const inp = document.getElementById('txDnRef'); if(inp) inp.value = '';
  const list = document.getElementById('txDnRefList'); if(list) list.style.display = 'none';
}
function dnRefSet(ref){
  dnRefSelected = ref && ref.no ? { type: ref.type, id: ref.id, no: ref.no } : null;
  const inp = document.getElementById('txDnRef');
  if(inp) inp.value = dnRefSelected ? dnRefSelected.no : '';
}
function dnRefTypeLabel(type){ return type === 'nonsales' ? t('dnRefTypeNs') : t('dnRefTypeOrder'); }

async function dnRefSearch(){
  const inp = document.getElementById('txDnRef');
  const list = document.getElementById('txDnRefList');
  if(!inp || !list) return;
  // 一改字就視為還沒選定,要重新從清單挑
  if(dnRefSelected && inp.value.trim() !== dnRefSelected.no) dnRefSelected = null;
  const seq = ++dnRefSeq;
  await Promise.all([ensureOrdersLoadedFrom(''), ensureNonSalesSlipsLoaded()]);
  if(seq !== dnRefSeq) return;
  const q = inp.value.trim().toLowerCase();
  const esc = escapeHtmlForPrint;
  const all = [
    ...orders.filter(o => !o.deleted && o.orderNo && (o.status || 'pending') === 'confirmed')
      .map(o => ({ type: 'order', id: o.id, no: String(o.orderNo), sub: o.partyName || o.customerName || '', date: o.date || '' })),
    ...nonSalesSlips.map(s => ({ type: 'nonsales', id: s.id, no: s.no, sub: s.reasonText || '', date: s.date || '' }))
  ];
  dnRefCandidates = all.filter(c => !q || c.no.toLowerCase().includes(q)).sort((a, b) => b.no.localeCompare(a.no)).slice(0, 30);
  if(dnRefCandidates.length === 0){
    list.innerHTML = `<div style="padding:8px 10px;font-size:12.5px;color:var(--ink-soft);">${t('dnRefNoMatch')}</div>`;
  } else {
    list.innerHTML = dnRefCandidates.map((c, i) => `<div onmousedown="dnRefPick(${i})" style="padding:7px 10px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--line);">
      <b>${esc(c.no)}</b> <span style="font-size:11.5px;color:var(--ink-soft);">· ${dnRefTypeLabel(c.type)}${c.sub ? ' · ' + esc(c.sub) : ''}${c.date ? ' · ' + esc(c.date) : ''}</span></div>`).join('');
  }
  list.style.display = '';
}
function dnRefPick(i){
  const c = dnRefCandidates[i]; if(!c) return;
  dnRefSet(c);
  const list = document.getElementById('txDnRefList'); if(list) list.style.display = 'none';
}
document.addEventListener('click', e => {
  const list = document.getElementById('txDnRefList'); const inp = document.getElementById('txDnRef');
  if(list && e.target !== inp && !list.contains(e.target)) list.style.display = 'none';
});
