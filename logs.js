// ============================================================
// 歷史紀錄——進出貨紀錄(Stock In/Out Log)、Delivery Note 紀錄、
// 後台紀錄(Inventory Log,系統裡每個操作的稽核軌跡),三個子分頁
// 各自的篩選/渲染/清除篩選,以及交易紀錄補充備註的功能。
// ============================================================
function clearLogFilters(){
  document.getElementById('logFilter').value = '';
  document.getElementById('logTypeFilter').value = '';
  document.getElementById('logPartyFilter').value = '';
  document.getElementById('logDateFrom').value = '';
  document.getElementById('logDateTo').value = '';
  document.getElementById('logShowAllCatalog').checked = false;
  renderLog();
}

// 分類篩選改變時,先清掉目前選的商品(不同分類下商品清單會不一樣,舊的選擇不一定還有效),
// 再重新渲染整個進出貨紀錄。
function onLogCategoryFilterChange(){
  document.getElementById('logFilter').value = '';
  renderLog();
}

function renderLog(){
  const container = document.getElementById('logTable');
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));

  // 依分類篩選商品:先把分類下拉選單填好,再依選取的分類縮小「商品」下拉選單的範圍。
  syncCategoryOrder();
  const catSel = document.getElementById('logCategoryFilter');
  const prevCat = catSel.value;
  const usedCats = categoryOrder.filter(c => products.some(p => (p.category || '未分類') === c));
  catSel.innerHTML = `<option value="">${t('catFilterAll')}</option>` +
    usedCats.map(c => `<option value="${c.replace(/"/g,'&quot;')}">${catLabel(c)}</option>`).join('');
  if(usedCats.includes(prevCat)) catSel.value = prevCat;
  const catFilterVal = catSel.value;

  const logFilterSel = document.getElementById('logFilter');
  const prevProduct = logFilterSel.value;
  const showAllCatalog = document.getElementById('logShowAllCatalog').checked;
  let productsForLog = catFilterVal ? products.filter(p => (p.category || '未分類') === catFilterVal) : products;
  if(!showAllCatalog) productsForLog = productsForLog.filter(p => !p.hidden);
  logFilterSel.innerHTML = `<option value="">${t('logFilterAll')}</option>` +
    productsForLog.map(p => `<option value="${p.id}">${p.parentId ? '⧉ ' : ''}${p.name}</option>`).join('');
  if(productsForLog.some(p => p.id === prevProduct)) logFilterSel.value = prevProduct;
  makeSelectSearchable('logFilter');

  const filterId = logFilterSel.value;
  const typeFilter = document.getElementById('logTypeFilter').value;
  const partyFilter = document.getElementById('logPartyFilter').value;
  const dateFrom = document.getElementById('logDateFrom').value;
  const dateTo = document.getElementById('logDateTo').value;

  const partySel = document.getElementById('logPartyFilter');
  const prevParty = partySel.value;
  const outParties = [...new Set(transactions.filter(t => t.type === 'out' && t.party).map(t => t.party))].sort();
  const inParties = [...new Set(transactions.filter(t => t.type === 'in' && t.party).map(t => t.party))].sort();
  const restockParties = [...new Set(transactions.filter(t => t.type === 'restock' && t.party).map(t => t.party))].sort();
  const optHtml = p => `<option value="${p.replace(/"/g,'&quot;')}">${p}</option>`;
  partySel.innerHTML = `<option value="">${t('logPartyAll')}</option>` +
    (outParties.length ? `<optgroup label="${t('typeOut')}">${outParties.map(optHtml).join('')}</optgroup>` : '') +
    (inParties.length ? `<optgroup label="${t('typeIn')}">${inParties.map(optHtml).join('')}</optgroup>` : '') +
    (restockParties.length ? `<optgroup label="${t('typeRestock')}">${restockParties.map(optHtml).join('')}</optgroup>` : '');
  const distinctParties = [...new Set([...outParties, ...inParties, ...restockParties])];
  if(distinctParties.includes(prevParty)) partySel.value = prevParty;

  const showSystem = document.getElementById('showSystemTx') && document.getElementById('showSystemTx').checked;
  let rows = transactions.filter(t => !filterId || t.productId === filterId);
  if(catFilterVal && !filterId){
    // 只選了分類、還沒選特定商品:整個分類底下的紀錄都顯示
    rows = rows.filter(t => {
      const p = productMap[t.productId];
      return p && (p.category || '未分類') === catFilterVal;
    });
  }
  if(!showSystem) rows = rows.filter(t => !t.system || t.orderId);
  if(typeFilter) rows = rows.filter(t => t.type === typeFilter);
  if(partyFilter) rows = rows.filter(t => t.party === partyFilter);
  if(dateFrom) rows = rows.filter(t => t.date >= dateFrom);
  if(dateTo) rows = rows.filter(t => t.date <= dateTo);
  // 同一天的紀錄,依照真正輸入系統的先後順序排(id 裡帶有建立時間戳),而不是單靠 date 這個
  // (可被使用者調整的)業務日期本身去判斷順序,避免像「已完成訂單後來又調整數量」這種同一天內
  // 產生的多筆紀錄,重新整理頁面後排列順序跑掉。
  rows = rows.slice().sort((a,b) => {
    const dateDiff = new Date(b.date) - new Date(a.date);
    if(dateDiff !== 0) return dateDiff;
    return (b.id || '').localeCompare(a.id || '');
  });

  const hiddenCount = transactions.filter(t => t.system && !t.orderId && (!filterId || t.productId === filterId)).length;

  if(rows.length === 0){
    container.innerHTML = `<div class="empty-note">沒有符合篩選條件的紀錄${hiddenCount > 0 && !showSystem ? `(另有 ${hiddenCount} 筆系統匯入紀錄被隱藏)` : ''}</div>`;
    return;
  }

  container.innerHTML = `
    <table class="log tx-log-table">
      <thead><tr>
        <th style="width:92px;">${t('colDate')}</th><th>${t('colProduct')}</th><th>${t('colType')}</th><th>${t('colQty')}</th><th>${t('colParty')}</th><th>${t('colNote')}</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(tx => {
          const p = productMap[tx.productId];
          if(appendingNoteTxId === tx.id){
            return `<tr class="editing-row">
              <td class="col-date">${tx.date}</td>
              <td class="col-product">${p ? p.name : '(已刪除商品)'}</td>
              <td class="col-type"><span class="type-pill ${tx.type}">${tx.type === 'in' ? t('typeIn') : (tx.type === 'restock' ? t('typeRestock') : t('typeOut'))}</span></td>
              <td class="col-qty">${tx.qty}${p ? ' ' + p.unit : ''}</td>
              <td class="col-party">${tx.party || '—'}</td>
              <td colspan="2">
                ${tx.invoiceNo ? `<div style="color:var(--ink-soft);font-size:11.5px;">${tf('invoiceNoInline', {no: tx.invoiceNo.replace(/</g,'&lt;')})}</div>` : ''}
                ${tx.note ? `<div style="color:var(--ink-soft);font-size:11.5px;white-space:pre-wrap;margin-bottom:4px;">${tx.note.replace(/</g,'&lt;')}</div>` : ''}
                <input type="text" id="appendNoteInput" placeholder="${t('appendNotePlaceholder')}" style="width:100%;" />
                <span class="del-link" onclick="saveAppendNoteToTx('${tx.id}')" style="color:var(--safe);margin-right:8px;">${t('btnSave')}</span>
                <span class="del-link" onclick="cancelAppendNoteToTx()">${t('btnCancel')}</span>
              </td>
            </tr>`;
          }
          const createdAt = idCreatedTime(tx.id);
          const timeHtml = createdAt ? `<div class="tx-time">${formatHHMM(createdAt)}</div>` : '';
          return `<tr>
            <td class="col-date">${tx.date}${timeHtml}</td>
            <td class="col-product">${p ? p.name : '(已刪除商品)'}</td>
            <td class="col-type"><span class="type-pill ${tx.type}">${tx.type === 'in' ? t('typeIn') : (tx.type === 'restock' ? t('typeRestock') : t('typeOut'))}</span></td>
            <td class="col-qty">${tx.qty}${p ? ' ' + p.unit : ''}</td>
            <td class="col-party">${tx.party || '—'}</td>
            <td class="col-note">${tx.invoiceNo ? `<span style="color:var(--ink-soft);">${tf('invoiceNoInline', {no: tx.invoiceNo.replace(/</g,'&lt;')})}</span>${tx.note ? ' ' : ''}` : ''}${tx.note
              ? `<span class="tx-note-text" onclick="toggleTxNoteDisplay(this)" title="${t('btnViewNoteTitle')}">${tx.note.replace(/</g,'&lt;')}</span>`
              : (tx.invoiceNo ? '' : '—')}</td>
            <td class="col-actions" style="white-space:nowrap;">
              <span class="del-link action-text-edit" onclick="startAppendNoteToTx('${tx.id}')">${t('btnAddNote')}</span>
              <span class="del-link action-icon-edit" onclick="startAppendNoteToTx('${tx.id}')" title="${t('btnAddNote')}">➕</span>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// action_type(存在 inventory_log 資料表裡的英文代碼)→ 顯示用翻譯 key 的對照表。
const INVENTORY_LOG_ACTION_LABEL_KEY = {
  order_place: 'logActionOrderPlace',
  tx_in: 'logActionTxIn',
  tx_out: 'logActionTxOut',
  tx_restock: 'logActionTxRestock',
  order_edit: 'logActionOrderEdit',
  order_delete: 'logActionOrderDelete',
  order_remark: 'logActionOrderRemark',
  order_verify: 'logActionOrderVerify',
  tx_note_append: 'logActionTxNoteAppend',
  conversion_undo: 'logActionConversionUndo'
};
function inventoryLogActionLabel(actionType){
  const key = INVENTORY_LOG_ACTION_LABEL_KEY[actionType];
  return key ? t(key) : actionType;
}

function clearInventoryLogFilters(){
  document.getElementById('invLogDateFrom').value = '';
  document.getElementById('invLogDateTo').value = '';
  document.getElementById('invLogSearchFilter').value = '';
  renderInventoryLog();
}

async function refreshInventoryLog(){
  await loadInventoryLog();
  renderInventoryLog();
}

function clearDeliveryLogFilters(){
  document.getElementById('deliveryLogDateFrom').value = '';
  document.getElementById('deliveryLogDateTo').value = '';
  document.getElementById('deliveryLogPartyFilter').value = '';
  renderDeliveryNoteLog();
}

// Delivery Note紀錄:列出所有 Delivery Note(不分狀態),依日期排序(最新在最上面)。
// 已經列印過(status:'completed')的顯示「已完成」,還沒列印的顯示「待處理」——沿用訂單那邊
// 現成的狀態小標籤樣式(order-status-pill),不用另外做一套。支援日期區間跟出貨方篩選。
function renderDeliveryNoteLog(){
  const container = document.getElementById('deliveryNoteLogTable');
  if(!container) return;

  // 出貨方下拉選單:從目前所有 Delivery Note 實際出現過的出貨方名稱整理出來,選項會隨著
  // 資料變動;重新整理選項的時候保留使用者原本選的值(如果那個值還在新的選項清單裡)。
  const partySelect = document.getElementById('deliveryLogPartyFilter');
  if(partySelect){
    const prevVal = partySelect.value;
    const parties = [...new Set(deliveryNotes.map(n => n.partyName).filter(Boolean))].sort();
    partySelect.innerHTML = `<option value="">${t('logPartyAll')}</option>` +
      parties.map(p => `<option value="${p.replace(/"/g,'&quot;')}">${p.replace(/</g,'&lt;')}</option>`).join('');
    if(parties.includes(prevVal)) partySelect.value = prevVal;
  }

  const dateFrom = document.getElementById('deliveryLogDateFrom') ? document.getElementById('deliveryLogDateFrom').value : '';
  const dateTo = document.getElementById('deliveryLogDateTo') ? document.getElementById('deliveryLogDateTo').value : '';
  const partyFilter = partySelect ? partySelect.value : '';

  let list = deliveryNotes.slice();
  if(dateFrom) list = list.filter(n => n.date >= dateFrom);
  if(dateTo) list = list.filter(n => n.date <= dateTo);
  if(partyFilter) list = list.filter(n => n.partyName === partyFilter);

  if(list.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noRecordsYet')}</div>`;
    return;
  }
  const sorted = list.sort((a,b) => (b.date || '').localeCompare(a.date || ''));
  container.innerHTML = `<table class="stock-table">
      <thead><tr>
        <th>${t('colDate')}</th>
        <th>${t('lblPartyGeneric')}</th>
        <th>${t('colItemNote')}</th>
        <th>${t('lblProduct')}</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${sorted.map(n => {
          const isCompleted = n.status === 'completed';
          const itemsSummary = (n.items || []).map(it => `${it.name} ${it.qty} ${it.unit}`).join(', ');
          return `
          <tr>
            <td style="white-space:nowrap;">${n.date || ''}</td>
            <td>${n.partyName ? n.partyName.replace(/</g,'&lt;') : t('partyUnspecified')}</td>
            <td>${(n.note || '').replace(/</g,'&lt;')}</td>
            <td>${itemsSummary.replace(/</g,'&lt;')}</td>
            <td><span class="order-status-pill ${isCompleted ? 'confirmed' : 'pending'}">${isCompleted ? t('statusCompleted') : t('statusPending')}</span></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderInventoryLog(){
  const container = document.getElementById('inventoryLogTable');
  const dateFrom = document.getElementById('invLogDateFrom').value;
  const dateTo = document.getElementById('invLogDateTo').value;
  const searchFilter = (document.getElementById('invLogSearchFilter').value || '').trim().toLowerCase();

  // created_at 存的是 UTC 時間戳,但畫面上顯示的日期(toLocaleDateString)是轉成瀏覽器本地時區
  // 之後的日期——這兩個如果不一致就會出現「篩選 8/22,畫面卻跑出 8/23」的狀況(對本地時區比
  // UTC 早的地區來說,本地時間已經是隔天,但 UTC 日期字串還停在前一天,反過來也會有同樣的錯位)。
  // 篩選比對一定要用轉換過的本地日期,不能直接切 ISO 字串前 10 碼(那是 UTC 日期)。
  function toLocalDateStr(iso){
    const d = new Date(iso);
    if(isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  let rows = inventoryLogs.slice();
  if(dateFrom) rows = rows.filter(r => r.created_at && toLocalDateStr(r.created_at) >= dateFrom);
  if(dateTo) rows = rows.filter(r => r.created_at && toLocalDateStr(r.created_at) <= dateTo);
  if(searchFilter) rows = rows.filter(r =>
    (r.actor || '').toLowerCase().includes(searchFilter) ||
    (r.description || '').toLowerCase().includes(searchFilter) ||
    (r.order_no || '').toLowerCase().includes(searchFilter)
  );
  // 已經照 created_at 由資料庫端 desc 排序載入,這裡再排一次以防篩選/重新整理後順序跑掉。
  rows = rows.slice().sort((a,b) => (b.created_at || '').localeCompare(a.created_at || ''));

  if(rows.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noInventoryLogs')}</div>`;
    return;
  }

  container.innerHTML = `
    <table class="log">
      <thead><tr>
        <th style="width:130px;">${t('colLogTime')}</th>
        <th style="width:100px;">${t('colLogAction')}</th>
        <th style="width:120px;">${t('colLogUser')}</th>
        <th>${t('colLogDesc')}</th>
        <th style="width:100px;">${t('colLogOrderNo')}</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const d = r.created_at ? new Date(r.created_at) : null;
          const dateStr = d ? d.toLocaleDateString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit' }) : '—';
          const timeStr = d ? formatHHMM(d) : '';
          return `<tr>
            <td class="col-date">${dateStr}${timeStr ? `<div class="tx-time">${timeStr}</div>` : ''}</td>
            <td><span class="type-pill">${inventoryLogActionLabel(r.action_type)}</span></td>
            <td><span class="td-mobile-label">${t('colLogUser')}</span>${r.actor || t('unknownUser')}</td>
            <td>${r.description || ''}</td>
            <td>${r.order_no ? `<span class="td-mobile-label">${t('colLogOrderNo')}</span>${r.order_no}` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// 已簽收訂單相關的進出貨紀錄:內容鎖住不能改,只能疊加新增附註(不會覆蓋掉原本的備註內容,
// 是接在後面),讓使用者還是有地方可以補充說明,但改不動原始紀錄本身。這是「進出貨紀錄」
// 現在唯一的編輯入口——整個紀錄表已經不能整列編輯或刪除了。
function startAppendNoteToTx(id){
  appendingNoteTxId = id;
  renderLog();
}

function cancelAppendNoteToTx(){
  appendingNoteTxId = null;
  renderLog();
}

async function saveAppendNoteToTx(id){
  const tx = transactions.find(t => t.id === id);
  if(!tx) return;
  const input = document.getElementById('appendNoteInput');
  const addition = input ? input.value.trim() : '';
  if(!addition) return;
  const oldTx = { ...tx };
  const stamp = formatOrderDateTime(new Date().toISOString());
  tx.note = tx.note ? `${tx.note}\n[${stamp}] ${addition}` : `[${stamp}] ${addition}`;
  try{ await updateTransaction(oldTx, tx); }
  catch(e){
    Object.assign(tx, oldTx);
    showInfoModal('新增附註失敗,請重新整理頁面再試一次。');
    return;
  }
  const p = products.find(x => x.id === tx.productId);
  const linkedOrder = tx.orderId ? orders.find(o => o.id === tx.orderId) : null;
  logInventoryAction('tx_note_append', `Appended note to ${p ? p.name : tx.productId} record (${tx.date}): "${addition}"`, linkedOrder ? linkedOrder.orderNo : null);
  appendingNoteTxId = null;
  renderAll();
}
