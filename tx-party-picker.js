// ============================================================
// 登記進出貨 → 出貨 → 新增訂單:「出貨方」改成搜尋式選擇(跟 Create Invoice / Credit Note 一樣)。
// 還沒選:搜尋框 + 下拉結果;選定後:顯示出貨方名稱(點名稱開編輯頁面,需要「管理出貨方」權限)+ 旁邊「更換」。
// 實際的值仍然存在原本隱藏的 <select id="txPartySelect"> 裡,所以其他程式碼(讀 .value)完全不用改。
// ============================================================
function txPartyPickerActive(){
  return (currentTxType === 'out' && registerOutKind === 'order' && registerOutFlowType === 'new-order') || currentTxType === 'delivery';
}
// 依目前狀態切換「搜尋式選擇」或原本的下拉選單
function txPartyPickerApply(){
  txSupplierPickerApply();
  const sel = document.getElementById('txPartySelect');
  const box = document.getElementById('txPartyPicker');
  if(!sel || !box) return;
  if(txPartyPickerActive()){
    sel.style.display = 'none';
    box.style.display = '';
    txPartyPickerRender();
  } else {
    box.style.display = 'none';
    // 其他情況維持原本規則:只有出貨/Delivery Note 才顯示下拉選單(進貨類型的 setTxType 會自己把它藏起來)
    if(currentTxType === 'out' || currentTxType === 'delivery') sel.style.display = '';
  }
}
function txPartyPickerRender(searchText){
  const sel = document.getElementById('txPartySelect');
  const box = document.getElementById('txPartyPicker');
  if(!sel || !box || box.style.display === 'none') return;
  const esc = escapeHtmlForPrint;
  const sp = sel.value ? (shippingParties || []).find(x => x.id === sel.value) : null;
  if(sp){
    const label = icPartyLabel(sp);
    box.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:34px;">
      ${hasCapability('cap-manage-parties') ? `<b class="batch-link" style="cursor:pointer;" title="${esc(t('icEditPartyTip'))}" onclick="openPartyEditModal('${esc(sp.id)}')">${esc(label)}</b>` : `<b>${esc(label)}</b>`}
      <span class="del-link" onclick="txPartyPickerClear()">${t('icChangeParty')}</span>${typeof partyDiscountBadgeHtml === 'function' ? partyDiscountBadgeHtml(sp) : ''}</div>`;
  } else {
    box.innerHTML = `<div style="position:relative;"><input id="txSupplierSearch" type="text" autocomplete="off" placeholder="${esc(t('txSupplierSearchPh'))}" value="${esc(searchText || '')}" oninput="txSupplierPickerSearch(this.value)" onfocus="txSupplierPickerSearch(this.value)" style="width:100%;box-sizing:border-box;" />
      <div id="txSupplierSearchList" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:30;background:var(--bg,#fff);border:1px solid var(--line);max-height:220px;overflow:auto;box-shadow:0 4px 12px rgba(0,0,0,.12);"></div></div>
      <div style="margin-top:4px;font-size:12px;"><span class="del-link" onclick="txSupplierPickerNew()">＋ ${t('txSupplierAdd')}</span></div>`;
  }
}
function txSupplierPickerSearch(v){
  const list = document.getElementById('txSupplierSearchList'); if(!list) return;
  const esc = escapeHtmlForPrint;
  const q = (v || '').trim().toLowerCase();
  const m = (purchaseSuppliers || []).filter(s => !s.deleted && (!q || [s.name, s.code, s.contact].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 12);
  list.innerHTML = m.length
    ? m.map(s => `<div onmousedown="txSupplierPickerPick('${esc(s.id)}')" style="padding:7px 10px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--line);">${esc(supplierOptionLabel(s))}</div>`).join('')
    : `<div style="padding:8px 10px;font-size:12.5px;color:var(--ink-soft);">${t('icNoParty')}</div>`;
  list.style.display = '';
}
function txSupplierPickerPick(id){
  const hs = document.getElementById('txPartyHistorySelect'); if(!hs) return;
  hs.value = id; onTxPartyHistorySelectChange(id);
}
function txSupplierPickerNew(){
  // 開啟「新增進貨方」編輯視窗(可填聯絡人、付款天數等),存好後自動選取這個新進貨方
  const q = ((document.getElementById('txSupplierSearch') || {}).value || '').trim();
  if(typeof openSupplierEditModal === 'function'){
    openSupplierEditModal(null, q);
    supplierEditOnSaved = sup => { if(sup && sup.id) txSupplierPickerPick(sup.id); };
    return;
  }
  const hs = document.getElementById('txPartyHistorySelect'); if(!hs) return;
  hs.value = '__new__'; onTxPartyHistorySelectChange('__new__');
}
function txSupplierPickerClear(){
  const hs = document.getElementById('txPartyHistorySelect'); if(!hs) return;
  hs.value = ''; onTxPartyHistorySelectChange('');
  const s = document.getElementById('txSupplierSearch'); if(s) s.focus();
}
document.addEventListener('click', e => {
  const list = document.getElementById('txSupplierSearchList'); const inp = document.getElementById('txSupplierSearch');
  if(list && e.target !== inp && !list.contains(e.target)) list.style.display = 'none';
});
