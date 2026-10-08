// ============================================================
// 快捷清單(Quick List)——一份「特定商品」的清單(例如「每週要盤的商品」),
// 在倉庫後台管理 → 快捷清單管理 建立/編輯/刪除,然後在庫存總覽、進貨預估、
// 資料維護(匯出特定商品資料)三個地方都可以拿來篩選/匯入。
//
// 資料存在資料庫的 key-value 表(key = 'quickLists'),格式:
//   [{ id, name, productIds: [商品家族「主商品」的 id, ...] }, ...]
// 清單裡只存「主商品」的 id(一個主商品代表它整個 multipack 家族),跟庫存總覽、進貨預估
// 一次只列主商品的邏輯一致。讀取時一律用 normalizeToAnchorId() 把 id 對回主商品,
// 就算某個商品後來被改成別人的 multipack、或被刪除,清單也不會壞掉。
//
// 這個檔案同時放了三個地方共用的「商品挑選器」(分類篩選 + 商品名稱搜尋 + 一鍵加入),
// 見 mountProductPicker()。
// ============================================================
let quickLists = [];

async function loadQuickLists(){
  try{
    const r = await dbGet('quickLists');
    if(r && r.value){
      const stored = JSON.parse(r.value);
      if(Array.isArray(stored)) quickLists = stored.filter(q => q && q.id && typeof q.name === 'string')
        .map(q => ({ id: q.id, name: q.name, productIds: Array.isArray(q.productIds) ? q.productIds : [],
          pickingNoteEnabled: !!q.pickingNoteEnabled, pickingNoteText: typeof q.pickingNoteText === 'string' ? q.pickingNoteText : '' }));
    }
  } catch(e){ /* 還沒存過清單,維持空的 */ }
}

async function saveQuickLists(){
  await dbSet('quickLists', JSON.stringify(quickLists));
}

function getQuickListById(id){
  return quickLists.find(q => q.id === id) || null;
}

// 把任何商品 id 對回它所屬家族的「主商品」id;找不到這個商品(已被刪除)回傳 null。
function normalizeToAnchorId(productId){
  const p = products.find(x => x.id === productId);
  if(!p) return null;
  return p.parentId || p.id;
}

// 某份清單實際有效的主商品 id 集合(已經刪除的商品自動略過、重複的自動合併)。
function getQuickListAnchorIds(quickListId){
  const ql = getQuickListById(quickListId);
  const set = new Set();
  if(!ql) return set;
  ql.productIds.forEach(pid => { const a = normalizeToAnchorId(pid); if(a) set.add(a); });
  return set;
}

// 填「快捷清單」下拉選單(庫存總覽、進貨預估、匯出特定商品資料共用)。保留使用者原本選的值,
// 如果那份清單已經被刪除就退回「全部」。
function populateQuickListSelect(selectId, allLabelKey){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  const prev = sel.value;
  const sorted = quickLists.slice().sort((a,b) => a.name.localeCompare(b.name));
  sel.innerHTML = `<option value="">${t(allLabelKey)}</option>` +
    sorted.map(q => `<option value="${escapeAttr(q.id)}">${escapeHtmlText(q.name)}</option>`).join('');
  if(sorted.some(q => q.id === prev)) sel.value = prev;
}

function populateAllQuickListSelects(){
  populateQuickListSelect('quickListFilter', 'quickListFilterAll');
  populateQuickListSelect('forecastQuickListFilter', 'quickListFilterAll');
  populateQuickListSelect('exportQuickListSelect', 'optSelectQuickList');
}

function escapeAttr(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
function escapeHtmlText(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===== 共用商品挑選器 =====
// 畫出「分類篩選 + 商品名稱搜尋 + 符合條件的商品清單(每列一個 ＋ 加入按鈕)」。清單裡只列「主商品」
// (家族代表),而且不列已經被加進去的、也不列被隱藏的。名稱顯示跟庫存總覽一樣看這個家族目前的
// 代表商品(getTotalStockBasisProduct),搜尋時家族裡任何一個成員的名稱/SKU 命中都算。
// cfg = { getExcludedIds: () => 要排除的主商品 id(Set 或陣列), onAdd: (anchorId) => void }
const productPickerRegistry = {};

function mountProductPicker(containerId, prefix, cfg){
  const container = document.getElementById(containerId);
  if(!container) return;
  productPickerRegistry[prefix] = cfg;
  container.innerHTML = `
    <div class="product-picker">
      <div class="filter-row">
        <div class="field">
          <label>${t('fieldFilterByCategory')}</label>
          <select id="${prefix}PickerCat" onchange="refreshProductPicker('${prefix}')"></select>
        </div>
        <div class="field" style="min-width:220px;">
          <label>${t('fieldSearchProductName')}</label>
          <input type="text" id="${prefix}PickerSearch" oninput="refreshProductPicker('${prefix}')" placeholder="${escapeAttr(t('placeholderSearchProduct'))}" autocomplete="off" />
        </div>
        <div class="field" style="justify-content:flex-end;">
          <button type="button" class="btn ghost" id="${prefix}PickerAddAllBtn" onclick="productPickerAddAll('${prefix}')"></button>
        </div>
      </div>
      <div id="${prefix}PickerResults" class="pp-results"></div>
    </div>
  `;
  populateProductPickerCategories(prefix);
  refreshProductPicker(prefix);
}

function populateProductPickerCategories(prefix){
  const sel = document.getElementById(`${prefix}PickerCat`);
  if(!sel) return;
  syncCategoryOrder();
  const usedCats = categoryOrder.filter(c => products.some(p => !p.parentId && (p.category || '未分類') === c));
  const prev = sel.value;
  sel.innerHTML = `<option value="">${t('catFilterAll')}</option>` +
    usedCats.map(c => `<option value="${escapeAttr(c)}">${catLabel(c)}</option>`).join('');
  if(usedCats.includes(prev)) sel.value = prev;
}

function getProductPickerCandidates(prefix){
  const cfg = productPickerRegistry[prefix];
  if(!cfg) return [];
  const catEl = document.getElementById(`${prefix}PickerCat`);
  const searchEl = document.getElementById(`${prefix}PickerSearch`);
  const cat = catEl ? catEl.value : '';
  const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const excluded = new Set(cfg.getExcludedIds ? Array.from(cfg.getExcludedIds()) : []);

  let items = products.filter(p => !p.parentId && !p.hidden && !excluded.has(p.id));
  if(cat) items = items.filter(p => (p.category || '未分類') === cat);
  if(q){
    items = items.filter(p => {
      const family = [p].concat(getChildProducts(p.id));
      return family.some(m => (m.name || '').toLowerCase().includes(q) || (m.sku || '').toLowerCase().includes(q));
    });
  }
  const catIdx = c => { const i = categoryOrder.indexOf(c); return i === -1 ? 9999 : i; };
  return items.slice().sort((a, b) => {
    const d = catIdx(a.category || '未分類') - catIdx(b.category || '未分類');
    return d !== 0 ? d : compareProductsBySortMode(a, b);
  });
}

function refreshProductPicker(prefix){
  const resultsEl = document.getElementById(`${prefix}PickerResults`);
  if(!resultsEl) return;
  const items = getProductPickerCandidates(prefix);
  const addAllBtn = document.getElementById(`${prefix}PickerAddAllBtn`);
  if(addAllBtn){
    addAllBtn.textContent = tn('btnAddAllShown', items.length);
    addAllBtn.disabled = items.length === 0;
    addAllBtn.style.opacity = items.length === 0 ? '0.4' : '';
  }
  if(items.length === 0){
    resultsEl.innerHTML = `<div class="empty-note" style="padding:12px;">${t('pickerNoProducts')}</div>`;
    return;
  }
  resultsEl.innerHTML = items.map(p => {
    const basis = getTotalStockBasisProduct(p);
    return `
      <div class="pp-row">
        <span class="pp-name">${basis.sku ? `<span class="sku-badge">${escapeHtmlText(basis.sku)}</span>` : ''}${escapeHtmlText(basis.name)}<span class="pp-unit">${escapeHtmlText(basis.unit || '')}</span></span>
        <span class="pp-cat">${escapeHtmlText(catLabel(p.category || '未分類'))}</span>
        <button type="button" class="pp-add-btn" onclick="productPickerAdd('${prefix}','${p.id}')">＋ ${t('btnAddShort')}</button>
      </div>`;
  }).join('');
}

function productPickerAdd(prefix, anchorId){
  const cfg = productPickerRegistry[prefix];
  if(!cfg) return;
  cfg.onAdd(anchorId);
  refreshProductPicker(prefix);
}

function productPickerAddAll(prefix){
  const cfg = productPickerRegistry[prefix];
  if(!cfg) return;
  const items = getProductPickerCandidates(prefix);
  items.forEach(p => cfg.onAdd(p.id, true));
  if(cfg.onAddBatchDone) cfg.onAddBatchDone();
  refreshProductPicker(prefix);
}

// 一個主商品在清單裡顯示的一列(已選商品清單用)
function anchorDisplayRowHtml(anchorId, removeOnclick){
  const p = products.find(x => x.id === anchorId);
  if(!p) return '';
  const basis = getTotalStockBasisProduct(p);
  return `
    <div class="pp-row pp-selected-row">
      <span class="pp-name">${basis.sku ? `<span class="sku-badge">${escapeHtmlText(basis.sku)}</span>` : ''}${escapeHtmlText(basis.name)}<span class="pp-unit">${escapeHtmlText(basis.unit || '')}</span></span>
      <span class="pp-cat">${escapeHtmlText(catLabel(p.category || '未分類'))}</span>
      <button type="button" class="pp-remove-btn" title="${escapeAttr(t('btnRemoveShort'))}" onclick="${removeOnclick}">✕</button>
    </div>`;
}

// ===== 倉庫後台管理 → 快捷清單管理 =====
let qlMgmtView = 'menu';       // 'menu' | 'new' | 'list' | 'edit'
let qlEditor = { id: null, name: '', productIds: [], pickingNoteEnabled: false, pickingNoteText: '' };

function renderQuickListMgmt(){
  const root = document.getElementById('quickListMgmtRoot');
  if(!root) return;
  const isNew = qlMgmtView === 'new';
  const isListOrEdit = qlMgmtView === 'list' || qlMgmtView === 'edit';
  root.innerHTML = `
    <div class="ql-mode-bar">
      <button class="btn ${isNew ? '' : 'ghost'}" onclick="openQuickListEditor(null)">＋ ${t('btnNewQuickList')}</button>
      <button class="btn ${isListOrEdit ? '' : 'ghost'}" onclick="showExistingQuickLists()">✎ ${t('btnEditExistingQuickList')}</button>
    </div>
    <div id="quickListMgmtMsg" class="msg"></div>
    <div id="quickListMgmtBody"></div>
  `;
  if(qlMgmtView === 'new' || qlMgmtView === 'edit') renderQuickListEditor();
  else if(qlMgmtView === 'list') renderExistingQuickListsTable();
  else document.getElementById('quickListMgmtBody').innerHTML = `<div class="empty-note">${t('quickListMgmtPickHint')}</div>`;
}

function setQuickListMgmtMsg(text, isError){
  const el = document.getElementById('quickListMgmtMsg');
  if(!el) return;
  el.className = 'msg ' + (isError ? 'error' : 'ok');
  el.textContent = text || '';
}

function showExistingQuickLists(){
  qlMgmtView = 'list';
  renderQuickListMgmt();
}

// id 為 null → 新增清單;有 id → 編輯那一份(畫面上的名稱、商品都先帶入現有內容)。
function openQuickListEditor(id){
  if(id){
    const ql = getQuickListById(id);
    if(!ql) return;
    qlEditor = { id: ql.id, name: ql.name, productIds: Array.from(getQuickListAnchorIds(ql.id)), pickingNoteEnabled: !!ql.pickingNoteEnabled, pickingNoteText: ql.pickingNoteText || '' };
    qlMgmtView = 'edit';
  } else {
    qlEditor = { id: null, name: '', productIds: [], pickingNoteEnabled: false, pickingNoteText: '' };
    qlMgmtView = 'new';
  }
  renderQuickListMgmt();
}

function renderQuickListEditor(){
  const body = document.getElementById('quickListMgmtBody');
  if(!body) return;
  body.innerHTML = `
    <div class="field" style="max-width:360px;margin-bottom:14px;">
      <label>${t('fieldQuickListName')}</label>
      <input type="text" id="qlNameInput" value="${escapeAttr(qlEditor.name)}" oninput="qlEditor.name=this.value" placeholder="${escapeAttr(t('placeholderQuickListName'))}" maxlength="60" />
    </div>
    ${hasFeature('quickListPickingSlipNote') ? `
    <div style="max-width:360px;margin-bottom:14px;">
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;cursor:pointer;">
        <input type="checkbox" id="qlPickingNoteToggle" ${qlEditor.pickingNoteEnabled ? 'checked' : ''} onchange="onQlPickingNoteToggle(this.checked)" />
        <span>${t('chkQuickListPickingNote')}</span>
      </label>
      <input type="text" id="qlPickingNoteInput" value="${escapeAttr(qlEditor.pickingNoteText)}" oninput="qlEditor.pickingNoteText=this.value"
        placeholder="${escapeAttr(t('placeholderQuickListPickingNote'))}" maxlength="100" style="width:100%;margin-top:6px;${qlEditor.pickingNoteEnabled ? '' : 'display:none;'}" />
    </div>` : ''}
    <div class="section-title" style="font-size:12px;margin:0 0 6px;"><span id="qlSelectedTitle"></span></div>
    <div id="qlSelectedList" class="pp-list"></div>
    <div class="section-title" style="font-size:12px;margin:16px 0 6px;">${t('secAddProductsToList')}</div>
    <div id="qlPickerMount"></div>
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">
      <button class="btn" onclick="saveQuickListEditor()">${t('btnSaveQuickList')}</button>
      <button class="btn ghost" onclick="cancelQuickListEditor()">${t('btnCancel')}</button>
    </div>
  `;
  renderQuickListSelected();
  mountProductPicker('qlPickerMount', 'ql', {
    getExcludedIds: () => qlEditor.productIds,
    onAdd: (id) => { if(!qlEditor.productIds.includes(id)) qlEditor.productIds.push(id); renderQuickListSelected(); }
  });
}

function onQlPickingNoteToggle(checked){
  qlEditor.pickingNoteEnabled = checked;
  const input = document.getElementById('qlPickingNoteInput');
  if(input){ input.style.display = checked ? '' : 'none'; if(checked) input.focus(); }
}

// Picking Slip 附註:這個商品(以家族為單位)所在的所有「有勾選顯示附註」的快捷清單,各自輸入的內容用逗號接起來;
// 相同的內容只出現一次。沒有任何符合的清單就回傳空字串。
function getQuickListPickingNoteForProduct(productId){
  if(!hasFeature('quickListPickingSlipNote')) return '';
  const anchor = normalizeToAnchorId(productId);
  if(!anchor) return '';
  const texts = [];
  quickLists.forEach(ql => {
    const txt = (ql.pickingNoteText || '').trim();
    if(!ql.pickingNoteEnabled || !txt) return;
    if(!getQuickListAnchorIds(ql.id).has(anchor)) return;
    if(!texts.includes(txt)) texts.push(txt);
  });
  return texts.join(', ');
}

function renderQuickListSelected(){
  const listEl = document.getElementById('qlSelectedList');
  const titleEl = document.getElementById('qlSelectedTitle');
  if(!listEl) return;
  const ids = qlEditor.productIds.filter(id => products.some(p => p.id === id));
  if(titleEl) titleEl.textContent = tn('lblSelectedProductsCount', ids.length);
  if(ids.length === 0){
    listEl.innerHTML = `<div class="empty-note" style="padding:12px;">${t('quickListNoProductsYet')}</div>`;
    return;
  }
  listEl.innerHTML = ids.map(id => anchorDisplayRowHtml(id, `removeProductFromQuickListEditor('${id}')`)).join('');
}

function removeProductFromQuickListEditor(id){
  qlEditor.productIds = qlEditor.productIds.filter(x => x !== id);
  renderQuickListSelected();
  refreshProductPicker('ql'); // 被移除的商品要重新出現在下面「可加入」清單裡
}

function cancelQuickListEditor(){
  qlMgmtView = qlEditor.id ? 'list' : 'menu';
  qlEditor = { id: null, name: '', productIds: [], pickingNoteEnabled: false, pickingNoteText: '' };
  renderQuickListMgmt();
}

async function saveQuickListEditor(){
  const name = (qlEditor.name || '').trim();
  if(!name){ setQuickListMgmtMsg(t('errQuickListNameRequired'), true); return; }
  const dup = quickLists.find(q => q.id !== qlEditor.id && q.name.trim().toLowerCase() === name.toLowerCase());
  if(dup){ setQuickListMgmtMsg(t('errQuickListNameDuplicate'), true); return; }
  const ids = qlEditor.productIds.filter(id => products.some(p => p.id === id));
  if(ids.length === 0){ setQuickListMgmtMsg(t('errQuickListNoProducts'), true); return; }

  if(hasFeature('quickListPickingSlipNote') && qlEditor.pickingNoteEnabled && !(qlEditor.pickingNoteText || '').trim()){ setQuickListMgmtMsg(t('errQuickListPickingNoteEmpty'), true); return; }

  const prevSnapshot = JSON.stringify(quickLists);
  if(qlEditor.id){
    const ql = getQuickListById(qlEditor.id);
    if(ql){ ql.name = name; ql.productIds = ids; ql.pickingNoteEnabled = !!qlEditor.pickingNoteEnabled; ql.pickingNoteText = (qlEditor.pickingNoteText || '').trim(); }
  } else {
    quickLists.push({ id: 'ql_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, productIds: ids, pickingNoteEnabled: !!qlEditor.pickingNoteEnabled, pickingNoteText: (qlEditor.pickingNoteText || '').trim() });
  }
  try{
    await saveQuickLists();
  } catch(e){
    console.error('儲存快捷清單失敗', e);
    quickLists = JSON.parse(prevSnapshot);
    setQuickListMgmtMsg(t('errQuickListSaveFailed'), true);
    return;
  }
  const wasEdit = !!qlEditor.id;
  qlEditor = { id: null, name: '', productIds: [], pickingNoteEnabled: false, pickingNoteText: '' };
  qlMgmtView = 'list';
  populateAllQuickListSelects();
  renderQuickListMgmt();
  setQuickListMgmtMsg(tf(wasEdit ? 'msgQuickListUpdated' : 'msgQuickListCreated', { name }), false);
}

function renderExistingQuickListsTable(){
  const body = document.getElementById('quickListMgmtBody');
  if(!body) return;
  if(quickLists.length === 0){
    body.innerHTML = `<div class="empty-note">${t('noQuickListsYet')}</div>`;
    return;
  }
  const sorted = quickLists.slice().sort((a,b) => a.name.localeCompare(b.name));
  body.innerHTML = `
    <table class="stock-table">
      <thead><tr><th>${t('fieldQuickListName')}</th><th class="num">${t('colQuickListProductCount')}</th><th></th></tr></thead>
      <tbody>
        ${sorted.map(q => `
          <tr>
            <td class="row-name">${escapeHtmlText(q.name)}</td>
            <td class="num">${getQuickListAnchorIds(q.id).size}</td>
            <td class="row-action">
              <span class="del-link" onclick="openQuickListEditor('${q.id}')">${t('btnEdit')}</span>
              <span class="del-link" style="margin-left:12px;" onclick="deleteQuickList('${q.id}')">${t('btnDelete')}</span>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function deleteQuickList(id){
  const ql = getQuickListById(id);
  if(!ql) return;
  showConfirmModal(tf('confirmDeleteQuickList', { name: ql.name }), async () => {
    const prevSnapshot = JSON.stringify(quickLists);
    quickLists = quickLists.filter(q => q.id !== id);
    try{
      await saveQuickLists();
    } catch(e){
      console.error('刪除快捷清單失敗', e);
      quickLists = JSON.parse(prevSnapshot);
      setQuickListMgmtMsg(t('errQuickListSaveFailed'), true);
      return;
    }
    populateAllQuickListSelects();
    // 庫存總覽/進貨預估正選著這份清單的話,下拉選單會自動退回「全部」,畫面也要跟著重畫
    renderStockCards();
    renderForecastTable();
    renderQuickListMgmt();
    setQuickListMgmtMsg(tf('msgQuickListDeleted', { name: ql.name }), false);
  });
}
