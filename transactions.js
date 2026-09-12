// ============================================================
// 登記進出貨(Inbound & Outbound Hub)——這是最後也最複雜的一塊,
// 涵蓋:切換進貨/出貨/入庫類型、出貨的各種子流程(新訂單/載入
// 待處理訂單/載入已完成訂單/庫存調整)、品項清單管理、
// Excel 匯入(登記進出貨專用,不是商品主檔匯入)、送出時依
// 子流程分派到對應的送出邏輯、Delivery Note 產生。
//
// 商品主檔 Excel 匯入(importFromExcel/parseMasterExcelFile)是
// 不同的功能,故意沒有一起搬;todayISO()/computeStock() 這些被
// 其他好幾個模組共用的核心工具函式也故意留在主程式。
// ============================================================
function setTxType(type){
  currentTxType = type;
  // 切換類型時,把上一個類型送出後留下的訊息(不管是成功的綠字、還是失敗的紅字)一起清掉——
  // 不然切到新的類型,畫面上還留著「已提交 xxx」這種跟目前畫面對不上的殘留訊息,容易誤導使用者
  // 以為剛剛這個類型也送出過了。
  const txMsgEl = document.getElementById('txMsg');
  if(txMsgEl){ txMsgEl.className = 'msg'; txMsgEl.textContent = ''; }
  const sel = document.getElementById('txTypeSelect');
  if(sel && sel.value !== type) sel.value = type;
  const partyLabel = document.getElementById('txPartyLabel');
  const partyInput = document.getElementById('txParty');
  const partySelect = document.getElementById('txPartySelect');
  const partyHistorySelect = document.getElementById('txPartyHistorySelect');
  const outFlowRow = document.getElementById('txOutFlowTypeRow');
  const deliveryFlowRow = document.getElementById('txDeliveryFlowTypeRow');
  const invoiceFieldWrap = document.getElementById('txInvoiceFieldWrap');
  const mainGridEl = document.getElementById('txMainFormGrid');
  const deliveryViewSection = document.getElementById('txDeliveryViewSection');
  // Invoice 號碼欄位只有「進貨」才需要——其他類型先統一藏起來、版面維持標準三欄,
  // 'in' 分支下面會再改成顯示 + 四欄。「觀看紀錄」的清單畫面同理,只有 Delivery Note 類型
  // 底下選了「觀看紀錄」才會顯示(見 setTxDeliveryFlowType),切到其他類型一律先藏起來,
  // 不然選過一次之後切別的類型,這塊清單會一直卡著不消失。
  if(invoiceFieldWrap) invoiceFieldWrap.style.display = 'none';
  if(mainGridEl) mainGridEl.style.gridTemplateColumns = '1fr 1fr 1.4fr';
  if(deliveryViewSection) deliveryViewSection.style.display = 'none';
  const receiptWrap = document.getElementById('purchaseReceiptWrap');
  if(receiptWrap && type !== 'in') receiptWrap.style.display = 'none';
  if(type !== 'in') removePurchaseReceipt(); // 切走「進貨」類型的話,暫存的收據附件狀態一併清掉,避免殘留到下次填別種類型的表單
  if(type !== 'in'){
    const emailToggle = document.getElementById('purchaseEmailToggle');
    if(emailToggle){ emailToggle.checked = false; togglePurchaseEmailFieldVisibility(emailToggle); }
    const emailInput = document.getElementById('purchaseEmailAddress');
    if(emailInput) emailInput.value = '';
  }
  if(type === 'in'){
    partyLabel.textContent = t('partyLabelIn');
    partyInput.placeholder = t('partyPlaceholderIn');
    partyInput.style.display = 'none';
    partySelect.style.display = 'none';
    if(outFlowRow) outFlowRow.style.display = 'none';
    if(deliveryFlowRow) deliveryFlowRow.style.display = 'none';
    resetRegisterOutFlow();
    // resetRegisterOutFlow() 會把版面重設回標準三欄,所以 Invoice 欄位的顯示/四欄版面要在
    // 它之後才套用,不然會被蓋掉。
    if(invoiceFieldWrap) invoiceFieldWrap.style.display = '';
    if(mainGridEl) mainGridEl.style.gridTemplateColumns = '1fr 1fr 1fr 1.2fr';
    if(receiptWrap) receiptWrap.style.display = '';
    // 進貨方改成下拉選單,列出之前進貨單裡出現過的供應商,選了直接帶入;選「+ 新增供應商」
    // 才會出現文字輸入框讓你打新名稱——不用每次都重新手動輸入同一個常用供應商的名字。
    if(partyHistorySelect){
      partyHistorySelect.style.display = '';
      populateTxPartyHistorySelect();
    }
    showTxMainFormArea(true);
  } else if(type === 'out'){
    if(partyHistorySelect) partyHistorySelect.style.display = 'none';
    partyLabel.textContent = t('partyLabelOut');
    populateTxPartySelect();
    partyInput.style.display = 'none';
    partySelect.style.display = '';
    if(deliveryFlowRow) deliveryFlowRow.style.display = 'none';
    // 出貨、Delivery Note 都需要出貨方欄位、標準三欄版面——如果是從「庫存調整」切過來的
    // (那邊會把這兩個藏起來/改成兩欄),這裡要復原回來。
    const partyFieldWrap = document.getElementById('txPartyFieldWrap');
    const mainGrid = document.getElementById('txMainFormGrid');
    if(partyFieldWrap) partyFieldWrap.style.display = '';
    if(mainGrid) mainGrid.style.gridTemplateColumns = '1fr 1fr 1.4fr';
    // 如果是從 Delivery Note 切過來的,要把 Delivery Note 那邊的暫存狀態清掉,不然待會切回
    // Delivery Note 時,會看到上一次的殘留狀態(例如還停在「載入」某一張舊 Note 的畫面)。
    registerDeliveryFlowType = '';
    registerLoadedDeliveryNoteId = null;
    txBatchItems = [];
    // 出貨一定要先選「出貨類型」,選了之後(如果是新增訂單就直接展開;如果是載入
    // 現有訂單,還要再選出是哪一張)下面的主表單區塊才會出現——避免使用者還沒決定清楚要做
    // 哪一種操作,就先動手填日期/加商品,結果選了類型才發現整個表單邏輯不一樣要重填。
    if(outFlowRow) outFlowRow.style.display = '';
    setTxOutFlowType(registerOutFlowType || '');
  } else if(type === 'delivery'){
    if(partyHistorySelect) partyHistorySelect.style.display = 'none';
    partyLabel.textContent = t('partyLabelOut');
    populateTxPartySelect();
    partyInput.style.display = 'none';
    partySelect.style.display = '';
    if(outFlowRow) outFlowRow.style.display = 'none';
    const partyFieldWrap = document.getElementById('txPartyFieldWrap');
    const mainGrid = document.getElementById('txMainFormGrid');
    if(partyFieldWrap) partyFieldWrap.style.display = '';
    if(mainGrid) mainGrid.style.gridTemplateColumns = '1fr 1fr 1.4fr';
    // 反過來,如果是從「出貨」切過來的,也要把出貨那邊的暫存狀態清掉,同樣的道理。
    registerOutFlowType = '';
    registerLoadedOrderId = null;
    registerPendingItemChanges = {};
    txBatchItems = [];
    // Delivery Note 也要先選「新增」還是「載入」,邏輯跟出貨類型一樣——選了才展開下面的表單。
    if(deliveryFlowRow) deliveryFlowRow.style.display = '';
    setTxDeliveryFlowType(registerDeliveryFlowType || '');
  } else if(type === 'adjustment'){
    if(partyHistorySelect) partyHistorySelect.style.display = 'none';
    // 庫存調整不需要出貨方(這個異動不是要出給誰,單純是庫存數字校正),把出貨方欄位整個藏起來,
    // 表單格線也跟著從三欄變兩欄,不會留一塊空白;備註改成必填(校正原因寫在這裡)。原本是
    // 「登記進出貨→出貨→庫存調整」底下的其中一種出貨類型,現在獨立成頂層類型自己的分頁,
    // 選了就直接展開表單,不需要再多選一層。
    if(outFlowRow) outFlowRow.style.display = 'none';
    if(deliveryFlowRow) deliveryFlowRow.style.display = 'none';
    const partyFieldWrap = document.getElementById('txPartyFieldWrap');
    const mainGrid = document.getElementById('txMainFormGrid');
    const noteLabel = document.getElementById('txNoteLabel');
    const existingSection = document.getElementById('txExistingItemsSection');
    const postVerifySection = document.getElementById('txPostVerifyChangesSection');
    if(partyFieldWrap) partyFieldWrap.style.display = 'none';
    if(mainGrid) mainGrid.style.gridTemplateColumns = '1fr 1.4fr';
    if(noteLabel) noteLabel.textContent = t('txNoteRequiredLabel');
    if(existingSection) existingSection.style.display = 'none';
    if(postVerifySection) postVerifySection.style.display = 'none';
    registerOutFlowType = '';
    registerLoadedOrderId = null;
    registerPendingItemChanges = {};
    registerDeliveryFlowType = '';
    registerLoadedDeliveryNoteId = null;
    txBatchItems = [];
    showTxMainFormArea(true);
    renderTxSubmitArea();
    renderTxBatchList();
    renderProductSelect();
  } else {
    if(partyHistorySelect) partyHistorySelect.style.display = 'none';
    partyLabel.textContent = t('partyLabelRestock');
    partyInput.placeholder = t('partyPlaceholderRestock');
    if(!partyInput.value.trim()) partyInput.value = 'Opulent Imports';
    partyInput.style.display = '';
    partySelect.style.display = 'none';
    if(outFlowRow) outFlowRow.style.display = 'none';
    if(deliveryFlowRow) deliveryFlowRow.style.display = 'none';
    resetRegisterOutFlow();
    showTxMainFormArea(true);
  }
  // 不管上面走的是哪個分支,最後都統一在這裡刷新一次送出按鈕區、還有下面的「待送出商品清單」——
  // 道理跟上面同一個註解講的一樣:好幾個分支只呼叫了 resetRegisterOutFlow()(裡面會把
  // txBatchItems 重設成空陣列)重設狀態,卻沒有跟著刷新這兩個畫面區塊,導致切換類型時,
  // 上一個類型加到清單裡的商品會照舊卡著顯示在下面,要等到之後某個別的動作剛好順便觸發到
  // 這兩個函式才會消失,造成使用者以為畫面卡住、要等一段時間才會更新。
  renderTxSubmitArea();
  renderTxBatchList();
}

function showTxMainFormArea(visible){
  const area = document.getElementById('txMainFormArea');
  if(area) area.style.display = visible ? '' : 'none';
}

// 進貨方下拉選單:列出「進貨方管理」清單裡的供應商(依名稱排序),最下面固定加一個
// 「+ 新增供應商」選項。選了既有的供應商,直接把值帶進 txParty(其他程式碼都還是讀 txParty
// 的值,不用另外改);選「+ 新增」才會顯示 txParty 這個文字輸入框讓你打新名字——新輸入的
// 名字這裡不會自動存進「進貨方管理」清單,要去系統管理那邊正式新增,才會留住電話/住址/
// 附註這些額外資料,單純這裡打字送出去的話下次不會出現在下拉選單裡。
function populateTxPartyHistorySelect(){
  const sel = document.getElementById('txPartyHistorySelect');
  if(!sel) return;
  const sortedNames = purchaseSuppliers.map(s => s.name).sort((a,b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">${t('optSelectSupplier')}</option>` +
    sortedNames.map(p => `<option value="${p.replace(/"/g,'&quot;')}">${escapeHtmlForPrint(p)}</option>`).join('') +
    `<option value="__new__">${t('optAddNewSupplier')}</option>`;
  sel.value = '';
  document.getElementById('txParty').style.display = 'none';
}
function onTxPartyHistorySelectChange(value){
  const partyInput = document.getElementById('txParty');
  if(value === '__new__'){
    partyInput.style.display = '';
    partyInput.value = '';
    partyInput.focus();
  } else {
    partyInput.style.display = 'none';
    partyInput.value = value;
  }
}

function resetRegisterOutFlow(){
  registerOutFlowType = '';
  registerLoadedOrderId = null;
  txBatchItems = [];
  registerPendingItemChanges = {};
  registerDeliveryFlowType = '';
  registerLoadedDeliveryNoteId = null;
  const deliveryFlowSel = document.getElementById('txDeliveryFlowType');
  if(deliveryFlowSel) deliveryFlowSel.value = '';
  const flowSel = document.getElementById('txOutFlowType');
  if(flowSel) flowSel.value = '';
  const orderWrap = document.getElementById('txOutFlowOrderSelectWrap');
  if(orderWrap) orderWrap.style.display = 'none';
  const existingSection = document.getElementById('txExistingItemsSection');
  if(existingSection) existingSection.style.display = 'none';
  const postVerifySection = document.getElementById('txPostVerifyChangesSection');
  if(postVerifySection) postVerifySection.style.display = 'none';
  const noteLabel = document.getElementById('txNoteLabel');
  if(noteLabel) noteLabel.textContent = t('txNoteSharedLabel');
  const partySelect = document.getElementById('txPartySelect');
  if(partySelect) partySelect.disabled = false;
  const partyFieldWrap = document.getElementById('txPartyFieldWrap');
  if(partyFieldWrap) partyFieldWrap.style.display = '';
  const mainGrid = document.getElementById('txMainFormGrid');
  if(mainGrid) mainGrid.style.gridTemplateColumns = '1fr 1fr 1.4fr';
  const dateInput = document.getElementById('txDate');
  if(dateInput) dateInput.disabled = false;
}

// 「出貨類型」下拉選單改變時呼叫。三種類型的表單長相差異很大,這個函式負責決定當下要顯示
// 哪些區塊:'new-order' 選了就直接展開主表單;'load-pending'/'load-completed'
// 還要再選出實際是哪一張訂單,選出來之前主表單保持隱藏。
function setTxOutFlowType(flowType){
  registerOutFlowType = flowType;
  registerLoadedOrderId = null;
  txBatchItems = [];
  const orderWrap = document.getElementById('txOutFlowOrderSelectWrap');
  const orderSelectLabel = document.getElementById('txOutFlowOrderSelectLabel');
  const orderSelect = document.getElementById('txOutFlowOrderSelect');
  const existingSection = document.getElementById('txExistingItemsSection');
  const postVerifySection = document.getElementById('txPostVerifyChangesSection');
  const partySelect = document.getElementById('txPartySelect');
  const partyFieldWrap = document.getElementById('txPartyFieldWrap');
  const mainGrid = document.getElementById('txMainFormGrid');
  const dateInput = document.getElementById('txDate');
  const noteLabel = document.getElementById('txNoteLabel');

  if(existingSection) existingSection.style.display = 'none';
  if(postVerifySection) postVerifySection.style.display = 'none';
  if(partySelect) partySelect.disabled = false;
  if(dateInput) dateInput.disabled = false;
  if(noteLabel) noteLabel.textContent = t('txNoteSharedLabel');
  // 出貨的三種流程(新增訂單/載入待處理/載入已完成)都需要出貨方,固定顯示、固定三欄——庫存
  // 調整已經搬到「登記進出貨」的頂層類型自己處理,這裡不用再判斷了。
  if(partyFieldWrap) partyFieldWrap.style.display = '';
  if(mainGrid) mainGrid.style.gridTemplateColumns = '1fr 1fr 1.4fr';

  if(flowType === 'load-pending' || flowType === 'load-completed'){
    if(orderWrap) orderWrap.style.display = '';
    if(orderSelectLabel) orderSelectLabel.textContent = flowType === 'load-pending' ? t('fieldSelectPendingOrder') : t('fieldSelectCompletedOrder');
    if(orderSelect){
      const eligible = orders.filter(o => !o.deleted && !o.signedAt && orderStatus(o) === (flowType === 'load-pending' ? 'pending' : 'confirmed'));
      orderSelect.innerHTML = `<option value="">${t('optSelectPendingOrder')}</option>` +
        eligible.map(o => `<option value="${o.id}">${o.orderNo || ''} · ${o.date}${o.partyName ? ' · ' + o.partyName : ''}</option>`).join('');
    }
    showTxMainFormArea(false);
  } else if(flowType === 'new-order'){
    if(orderWrap) orderWrap.style.display = 'none';
    showTxMainFormArea(true);
  } else {
    if(orderWrap) orderWrap.style.display = 'none';
    showTxMainFormArea(false);
  }
  renderTxSubmitArea();
  renderTxBatchList();
  renderProductSelect();
}

// Delivery Note 的「新增」/「載入」切換,邏輯比照 setTxOutFlowType:「新增」直接展開空白表單;
// 「載入」要先選出是哪一張 Delivery Note,選出來之前主表單保持隱藏。備註在這裡是必填
// (相關已完成訂單號要寫在這裡),所以標籤文字改用「必填」版本。
function setTxDeliveryFlowType(flowType){
  registerDeliveryFlowType = flowType;
  registerLoadedDeliveryNoteId = null;
  txBatchItems = [];
  const noteSelectWrap = document.getElementById('txDeliveryNoteSelectWrap');
  const noteSelect = document.getElementById('txDeliveryNoteSelect');
  const existingSection = document.getElementById('txExistingItemsSection');
  const viewSection = document.getElementById('txDeliveryViewSection');
  const partySelect = document.getElementById('txPartySelect');
  const dateInput = document.getElementById('txDate');
  const noteLabel = document.getElementById('txNoteLabel');

  if(existingSection) existingSection.style.display = 'none';
  if(partySelect) partySelect.disabled = false;
  if(dateInput) dateInput.disabled = false;
  if(noteLabel) noteLabel.textContent = t('txNoteRequiredDeliveryLabel');

  if(flowType === 'load'){
    if(viewSection) viewSection.style.display = 'none';
    if(noteSelectWrap) noteSelectWrap.style.display = '';
    if(noteSelect){
      // 「載入」只列出還沒列印過(status 不是 'completed')的 Note——已經列印完成的表示這筆
      // 送貨已經處理完了,不應該再被找出來繼續編輯,它的歷史紀錄改到「觀看紀錄」那邊查看。
      const sorted = deliveryNotes.filter(n => n.status !== 'completed').slice().sort((a,b) => (b.date || '').localeCompare(a.date || ''));
      noteSelect.innerHTML = `<option value="">${t('optSelectDeliveryNote')}</option>` +
        sorted.map(n => `<option value="${n.id}">${n.date || ''}${n.note ? ` (${n.note.replace(/"/g,'&quot;')})` : ''}</option>`).join('');
    }
    showTxMainFormArea(false);
  } else if(flowType === 'new'){
    if(viewSection) viewSection.style.display = 'none';
    if(noteSelectWrap) noteSelectWrap.style.display = 'none';
    showTxMainFormArea(true);
  } else if(flowType === 'view'){
    // 「觀看紀錄」原本是「歷史紀錄」底下獨立一個子分頁,後來考慮到 Delivery Note 很少被回頭
    // 查看,不值得佔用一整個子分頁,改成併進這裡的「操作」下拉選單——選了直接在原本表單的
    // 位置顯示清單,不需要主表單(日期/出貨方/備註/商品清單)那一整套欄位。
    if(noteSelectWrap) noteSelectWrap.style.display = 'none';
    showTxMainFormArea(false);
    if(viewSection) viewSection.style.display = '';
    renderDeliveryNoteLog();
  } else {
    if(viewSection) viewSection.style.display = 'none';
    if(noteSelectWrap) noteSelectWrap.style.display = 'none';
    showTxMainFormArea(false);
  }
  renderTxSubmitArea();
  renderTxBatchList();
  renderProductSelect();
}

// 依目前的類型/出貨類型,決定下面要顯示哪些提交按鈕:
// - 進貨/入庫(非出貨):維持原本單一「提交」按鈕。
// - 出貨→新增訂單:三個按鈕,各自對應不同的送出行為。
// - 出貨→載入待處理訂單:儲存/載入訂單核對/直接核對。
// - 出貨→載入已完成訂單:只有儲存。
// - 出貨→庫存調整:單一「提交」,送出前會跳警示視窗確認。
function renderTxSubmitArea(){
  const area = document.getElementById('txSubmitArea');
  if(!area) return;
  if(currentTxType === 'delivery'){
    // Delivery Note 不管是「新增」還是「載入」,下面都是同一組「儲存」/「列印」——載入模式下
    // txBatchItems 裡通常已經有品項(從原本的 Note 帶過來的),但兩種模式共用同一套送出邏輯,
    // 不需要另外分流。
    if(registerDeliveryFlowType === 'new' || registerDeliveryFlowType === 'load'){
      area.innerHTML = `
        <button class="btn" onclick="saveDeliveryNote()">${t('btnSave')}</button>
        <button class="btn ghost" onclick="printDeliveryNote()">${t('btnPrint')}</button>
      `;
    } else {
      area.innerHTML = '';
    }
    return;
  }
  if(currentTxType !== 'out'){
    area.innerHTML = `<button class="btn" onclick="submitTxBatch()">${t('btnRegister')}</button>`;
    return;
  }
  if(registerOutFlowType === 'new-order'){
    area.innerHTML = `
      <button class="btn" onclick="submitTxBatch('pending')">${t('btnMergeToPending')}</button>
      <button class="btn" onclick="submitTxBatch('completed')">${t('btnMergeToCompleted')}</button>
      <button class="btn ghost" onclick="submitTxBatch('direct')">${t('btnDirectShip')}</button>
    `;
  } else if(registerOutFlowType === 'load-pending'){
    const disabled = registerLoadedOrderId ? '' : 'disabled';
    area.innerHTML = `
      <button class="btn" onclick="submitTxBatch('save-pending')" ${disabled}>${t('btnSave')}</button>
      <button class="btn ghost" onclick="submitTxBatch('load-verify')" ${disabled}>${t('btnLoadIntoVerifyPage')}</button>
    `;
  } else if(registerOutFlowType === 'load-completed'){
    const disabled = registerLoadedOrderId ? '' : 'disabled';
    area.innerHTML = `<button class="btn" onclick="submitTxBatch('save-completed')" ${disabled}>${t('btnSave')}</button>`;
  } else {
    area.innerHTML = '';
  }
}

// load-pending/load-completed 模式下,顯示這張訂單目前已經有的品項,每項都有「改數量」「刪除」——
// 跟已完成訂單原本那套 orderItemRowHtml 是不同的簡化版本,因為這裡的異動要等按下「儲存」才會
// 真的處理(load-completed 模式甚至要另外分流進「核對後變更」清單),不能像原本那樣即時送出。
function renderTxExistingItems(){
  const section = document.getElementById('txExistingItemsSection');
  const list = document.getElementById('txExistingItemsList');
  if(!section || !list) return;
  if(!registerLoadedOrderId || (registerOutFlowType !== 'load-pending' && registerOutFlowType !== 'load-completed')){
    section.style.display = 'none';
    return;
  }
  const order = orders.find(o => o.id === registerLoadedOrderId);
  if(!order){ section.style.display = 'none'; return; }
  section.style.display = '';
  const activeItems = order.items.filter(it => !it.deleted);
  if(activeItems.length === 0){
    list.innerHTML = `<div class="empty-note">${t('orderHistoryNoItemsLeft')}</div>`;
    return;
  }
  list.innerHTML = activeItems.map(it => {
    const isEditing = registerExistingItemEditKey === it.productId;
    const pending = registerPendingItemChanges[it.productId];

    if(isEditing){
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);">
          <span style="flex:1;">${it.name}${it.sku ? ` (${it.sku})` : ''}</span>
          <input type="number" id="txExistingItemQtyInput_${it.productId}" value="${pending && pending.type === 'qty' ? pending.newQty : it.qty}" step="1" style="width:80px;font-family:inherit;font-size:inherit;" />
          <span class="row-unit">${it.unit}</span>
          <span class="del-link" onclick="saveTxExistingItemQty('${it.productId}')">${t('btnSave')}</span>
          <span class="del-link" onclick="registerExistingItemEditKey=null;renderTxExistingItems();">${t('btnCancel')}</span>
        </div>
      `;
    }

    // 標記為「待確認刪除」的品項:整行變灰、數量劃刪除線,還是留在清單裡看得到,不會直接消失——
    // 要按最後的「儲存」並在確認視窗裡按下確定,才會真的變成軟刪除。這裡提供「復原」可以在存檔
    // 之前反悔、取消這個暫存的刪除動作。
    if(pending && pending.type === 'delete'){
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);opacity:0.55;">
          <span style="flex:1;text-decoration:line-through;">${it.name}${it.sku ? ` (${it.sku})` : ''}</span>
          <span style="text-decoration:line-through;">${it.qty} ${it.unit}</span>
          <span style="color:var(--crit);font-size:11px;">${t('pendingDeleteLabel')}</span>
          <span class="del-link" onclick="undoPendingItemChange('${it.productId}')">${t('btnUndo')}</span>
        </div>
      `;
    }

    // 有暫存改數量:舊數量劃刪除線、旁邊顯示新數量,還沒真的存檔,一樣可以「復原」取消。
    if(pending && pending.type === 'qty'){
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);">
          <span style="flex:1;">${it.name}${it.sku ? ` (${it.sku})` : ''}</span>
          <span><span style="text-decoration:line-through;color:var(--ink-soft);">${it.qty}</span> → <span style="color:var(--warn-dark);font-weight:600;">${pending.newQty}</span> ${it.unit}</span>
          <span class="del-link" onclick="registerExistingItemEditKey='${it.productId}';renderTxExistingItems();">${t('btnEditQty')}</span>
          <span class="del-link" onclick="undoPendingItemChange('${it.productId}')">${t('btnUndo')}</span>
        </div>
      `;
    }

    return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);">
        <span style="flex:1;">${it.name}${it.sku ? ` (${it.sku})` : ''}</span>
        <span>${it.qty} ${it.unit}${it.qty < 0 ? ` <span style="color:var(--safe);font-weight:600;font-size:11px;">(${t('stockedInLabel')})</span>` : ''}</span>
        <span class="del-link" onclick="registerExistingItemEditKey='${it.productId}';renderTxExistingItems();">${t('btnEditQty')}</span>
        <span class="del-link" style="color:var(--crit);" onclick="deleteTxExistingItem('${it.productId}')">${t('btnDelete')}</span>
      </div>
    `;
  }).join('');
}

// load-completed 模式專用:核對後變更清單(新增/刪除/改數量都算,跟原本核對前的異動分開顯示)。
// 這份清單存在訂單自己身上(order.postVerifyChanges),不是暫存在網頁記憶體裡的變數——
// 這樣重新整理頁面、或下次再打開同一張訂單,之前記錄的變更才不會憑空消失。
// 「核對後變更」清單的格式化,拆成共用函式——訂單核對後變更不是只有「登記進出貨→載入現有已完成
// 訂單」那個畫面要顯示,已完成訂單清單裡展開訂單明細時也要顯示同一份內容,兩邊共用同一套格式,
// 不要各自維護一份容易兜不起來。
function formatPostVerifyChangesHtml(changes){
  return changes.map(c => {
    const label = c.kind === 'added' ? t('postVerifyAdded')
      : c.kind === 'deleted' ? t('postVerifyDeleted')
      : t('postVerifyQtyChanged');
    const detail = c.kind === 'qty' ? `${c.from} → ${c.to} ${c.unit}` : `${c.qty} ${c.unit}`;
    const timePrefix = c.at ? `<span style="color:var(--ink-soft);font-family:'IBM Plex Mono',monospace;">${formatOrderDateTime(c.at)}</span> ` : '';
    return `<div style="font-size:12px;color:var(--warn-dark);padding:3px 0;">${timePrefix}${c.name}${c.sku ? ` (${c.sku})` : ''} — ${label}(${detail})</div>`;
  }).join('');
}

function renderTxPostVerifyChanges(){
  const section = document.getElementById('txPostVerifyChangesSection');
  const list = document.getElementById('txPostVerifyChangesList');
  if(!section || !list) return;
  const order = registerLoadedOrderId ? orders.find(o => o.id === registerLoadedOrderId) : null;
  const changes = (order && order.postVerifyChanges) || [];
  if(registerOutFlowType !== 'load-completed' || changes.length === 0){
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = formatPostVerifyChangesHtml(changes);
}

// 登記進出貨做「出貨」時,出貨方直接從現有客戶(shippingParties,跟訂貨頁面共用同一份名單)下拉選,
// 不再讓使用者手打文字,避免同一個客戶名稱前後打法不一致,對帳跟篩選才對得起來。
function populateTxPartySelect(){
  const partySelect = document.getElementById('txPartySelect');
  if(!partySelect) return;
  const prev = partySelect.value;
  partySelect.innerHTML = `<option value="">${t('optUnspecified')}</option>` +
    (shippingParties || []).map(sp => `<option value="${sp.id}">${sp.name.replace(/</g,'&lt;')}</option>`).join('');
  if([...partySelect.options].some(o => o.value === prev)) partySelect.value = prev;
}

// 「出貨類型」選了「載入現有待處理訂單」或「載入現有已完成訂單」之後,再選了實際是哪一張訂單,
// 呼叫這裡:把日期(可改)/出貨方(鎖住)/備註 帶進表單,顯示這張訂單目前已有的品項,清空這次
// 要新增的品項清單跟核對後變更紀錄(每次重新選訂單都是新的一輪)。
// Delivery Note「載入」:直接把這張 Note 原本的品項放進 txBatchItems(跟「新增商品」共用同一個
// 清單),因為 txBatchItems 本來就支援改數量、刪除(見 updateTxBatchItemQty/removeTxBatchItem),
// 不需要另外做一套「既有品項」的編輯介面——載入之後可以直接在同一個清單上加新商品、改數量、
// 刪除,存檔時整份 txBatchItems 就是這張 Note 最新的完整品項清單。
function loadDeliveryNoteIntoRegisterFlow(noteId){
  if(!noteId){
    registerLoadedDeliveryNoteId = null;
    txBatchItems = [];
    renderTxBatchList();
    renderTxSubmitArea();
    renderProductSelect();
    return;
  }
  const note = deliveryNotes.find(n => n.id === noteId);
  if(!note) return;
  registerLoadedDeliveryNoteId = noteId;
  txBatchItems = note.items.map(it => ({ ...it }));

  const dateInput = document.getElementById('txDate');
  if(dateInput) dateInput.value = note.date || todayISO();
  const partySelect = document.getElementById('txPartySelect');
  if(partySelect){
    populateTxPartySelect();
    partySelect.value = note.partyId || '';
  }
  const noteInput = document.getElementById('txNote');
  if(noteInput) noteInput.value = note.note || '';

  showTxMainFormArea(true);
  renderTxSubmitArea();
  renderTxBatchList();
  renderProductSelect();
}

function loadOrderIntoRegisterFlow(orderId){
  if(!orderId){
    registerLoadedOrderId = null;
    registerPendingItemChanges = {};
    renderTxExistingItems();
    renderTxPostVerifyChanges();
    renderTxSubmitArea();
    renderProductSelect();
    return;
  }
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  registerLoadedOrderId = orderId;
  registerExistingItemEditKey = null;
  registerPendingItemChanges = {}; // 換一張訂單就清空,不要把上一張訂單的暫存改動帶到這一張來
  if(!order.postVerifyChanges) order.postVerifyChanges = []; // 每張訂單自己的核對後變更記錄,重新載入不會清掉之前存過的
  txBatchItems = [];

  const dateInput = document.getElementById('txDate');
  if(dateInput) dateInput.value = order.date || todayISO();
  const partySelect = document.getElementById('txPartySelect');
  if(partySelect){
    populateTxPartySelect();
    partySelect.value = order.partyId || '';
    partySelect.disabled = true;
  }
  const noteInput = document.getElementById('txNote');
  if(noteInput) noteInput.value = order.note || '';
  const browseAllEl = document.getElementById('txBrowseAllProducts');
  if(browseAllEl) browseAllEl.checked = false; // 每次重新載入訂單,「瀏覽所有商品」重設回預設(不勾選)

  showTxMainFormArea(true);
  renderTxExistingItems();
  renderTxPostVerifyChanges();
  renderTxSubmitArea();
  renderTxBatchList();
  renderProductSelect();
}

function startTxExistingItemEdit(productId){
  registerExistingItemEditKey = productId;
  renderTxExistingItems();
}

// 儲存既有品項的數量修改——立即套用(不等最後的「儲存」按鈕),邏輯依 load-pending/load-completed
// 而不同:待處理訂單不影響庫存,只留修改紀錄;已完成訂單要真的調整庫存(用既有的
// saveOrderItemQty 那套 RPC 機制),而且這筆異動要記錄進「核對後變更」清單。
// 改數量現在不會馬上存檔——只是把新數量寫進 registerPendingItemChanges 這個暫存區,畫面上
// 會用刪除線劃掉舊數量、標出新數量(見 renderTxExistingItems),真正套用要等最後按「儲存」、
// 在總結確認視窗裡按下確定才會發生。
function saveTxExistingItemQty(productId){
  const order = orders.find(o => o.id === registerLoadedOrderId);
  if(!order) return;
  const item = order.items.find(it => it.productId === productId && !it.deleted);
  if(!item) return;
  const input = document.getElementById(`txExistingItemQtyInput_${productId}`);
  if(!input) return;
  const newQty = parseFloat(input.value);
  if(isNaN(newQty)){ showInfoModal(t('errEnterValidQty')); return; }
  if(!Number.isInteger(newQty)){ showInfoModal(t('errQtyMustBeInteger')); return; }

  if(newQty === item.qty){
    delete registerPendingItemChanges[productId]; // 改回原本的數字,等於取消這個暫存變更
  } else if(newQty === 0){
    registerPendingItemChanges[productId] = { type: 'delete' };
  } else {
    registerPendingItemChanges[productId] = { type: 'qty', newQty };
  }
  registerExistingItemEditKey = null;
  renderTxExistingItems();
}

// 刪除既有品項——一樣改成先標記成「待確認刪除」暫存在 registerPendingItemChanges,不會馬上
// 消失、也不會馬上動庫存,整行會用灰階+刪除線顯示,還留在清單裡看得到,可以按「復原」反悔。
// 真正的軟刪除(待處理訂單)或退回庫存(已完成訂單)要等最後按「儲存」才會發生。
function deleteTxExistingItem(productId){
  const order = orders.find(o => o.id === registerLoadedOrderId);
  if(!order) return;
  const item = order.items.find(it => it.productId === productId && !it.deleted);
  if(!item) return;
  registerPendingItemChanges[productId] = { type: 'delete' };
  renderTxExistingItems();
}

// 取消一個暫存的改數量/待刪除標記,回到原本存檔的狀態。
function undoPendingItemChange(productId){
  delete registerPendingItemChanges[productId];
  renderTxExistingItems();
}

// ===== 登記進出貨:多商品批次加入清單 =====
// 共用同一組 類型/日期/對象/備註,每個加進清單的商品各自登記成一筆獨立的進出貨紀錄。
let txBatchItems = []; // { productId, name, unit, qty }
let registerOutFlowType = ''; // ''(還沒選) | 'new-order' | 'load-pending' | 'load-completed' | 'adjustment'
let registerDeliveryFlowType = ''; // ''(還沒選) | 'new' | 'load'
let registerLoadedDeliveryNoteId = null; // 「載入」模式下,目前載入的是哪一張 Delivery Note
let registerLoadedOrderId = null; // load-pending/load-completed 模式下,目前載入的那張訂單 id
let registerExistingItemEditKey = null; // 目前正在編輯數量的既有品項 productId(null 表示沒有在編輯)
// 既有品項的改數量/刪除,不再按下去就馬上存檔——先暫存在這裡,畫面上照樣看得到那一列(改數量的
// 用刪除線劃掉舊數量、刪除的整行變灰並標「待確認刪除」),等按最後的「儲存」才會一次套用,並且
// 在確認視窗的總結裡列出來。key 是 productId,value 是 { type:'qty', newQty } 或 { type:'delete' }。
let registerPendingItemChanges = {};

function addToTxBatch(){
  const productSel = document.getElementById('txProduct');
  const productId = productSel.value;
  const qtyInput = document.getElementById('txQty');
  const qty = parseFloat(qtyInput.value);
  const msg = document.getElementById('txMsg');
  if(!productId){ msg.className='msg error'; msg.textContent='請先新增並選擇商品'; return; }
  if(!qty || isNaN(qty)){ msg.className='msg error'; msg.textContent=t('errAddItemQtyNonZero'); return; }
  if(!Number.isInteger(qty)){ msg.className='msg error'; msg.textContent=t('errQtyMustBeInteger'); return; }
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const existing = txBatchItems.find(it => it.productId === productId);
  if(existing) existing.qty += qty;
  else txBatchItems.push({ productId, sku: p.sku || '', name: p.name, unit: p.unit, qty });
  qtyInput.value = '';
  resetSearchableSelect('txProduct');
  msg.className = 'msg'; msg.textContent = '';
  renderTxBatchList();
}

function removeTxBatchItem(productId){
  txBatchItems = txBatchItems.filter(it => it.productId !== productId);
  renderTxBatchList();
}

function updateTxBatchItemQty(productId, value){
  const it = txBatchItems.find(x => x.productId === productId);
  if(!it) return;
  const qty = parseFloat(value);
  it.qty = (!isNaN(qty) && qty !== 0 && Number.isInteger(qty)) ? qty : it.qty;
  renderTxBatchList();
}

function renderTxBatchList(){
  const container = document.getElementById('txBatchList');
  if(!container) return;
  if(txBatchItems.length === 0){
    container.innerHTML = `<div class="empty-note" style="padding:8px 0;" data-i18n="txBatchEmpty">${t('txBatchEmpty')}</div>`;
    return;
  }
  container.innerHTML = `
    <table class="stock-table">
      <thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th><th></th></tr></thead>
      <tbody>
        ${txBatchItems.map(it => `
          <tr>
            <td class="row-name">${it.name}${it.qty < 0 ? ` <span style="color:var(--safe);font-weight:600;font-size:11px;">(${t('stockedInLabel')})</span>` : ''}</td>
            <td class="row-num">
              <input type="number" class="order-qty-input" step="1" value="${it.qty}"
                onchange="updateTxBatchItemQty('${it.productId}', this.value)" /><span class="row-unit">${it.unit}</span>
            </td>
            <td class="row-action">
              <button onclick="openConversionFromTxBatch('${it.productId}')" title="${t('btnConvertBatchItem')}">🔄</button>
              <button onclick="removeTxBatchItem('${it.productId}')" title="${t('btnDelete')}">✕</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// 從「登記進出貨」的待送出清單裡按「切換」:直接沿用庫存總覽同一套切換視窗(批量商品↔主商品)。
// 只有商品本身有主商品/批量商品關係才能切換;切換成功後,這個品項會從待送出清單移除(因為已經
// 用切換的方式處理掉了,不需要再登記成一般的進出貨紀錄)。
function openConversionFromTxBatch(productId){
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const item = txBatchItems.find(it => it.productId === productId);
  conversionDefaultQty = item ? item.qty : 1;
  if(p.parentId){
    conversionSourceBatchProductId = productId;
    openConversionModal(productId);
  } else if(getChildProducts(productId).length > 0){
    conversionSourceBatchProductId = productId;
    openParentToChildConversionModal(productId);
  } else {
    showInfoModal(t('errNoConversionRelation'));
  }
}

// 從「訂單核對→新增商品(實際點貨)」清單裡按「切換」:邏輯跟登記進出貨那邊的切換完全一樣,
// 只是切換成功後要清掉的是 verifyPageRightItems 裡的那個品項,不是 txBatchItems。用途是:
// 點貨的時候實際上是整箱批量商品出貨(例如拿了一箱「Grape x 20 bottle」),但訂單核對比對的
// 是主商品(「Grape」)的數量,所以要先把點到的批量商品切換成主商品的量,才能正確比對訂單。
function openConversionFromVerifyPage(productId){
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const item = verifyPageRightItems.find(it => it.productId === productId);
  conversionDefaultQty = item ? item.qty : 1;
  if(p.parentId){
    conversionSourceVerifyProductId = productId;
    openConversionModal(productId);
  } else if(getChildProducts(productId).length > 0){
    conversionSourceVerifyProductId = productId;
    openParentToChildConversionModal(productId);
  } else {
    showInfoModal(t('errNoConversionRelation'));
  }
}

let importTxType = 'in';
let pendingTxMatches = [];

function excelDateToISO(value){
  function fromLocalDateObj(d){
    // use local calendar fields (not toISOString, which converts to UTC and can shift
    // the date back a day in positive-offset timezones like Australia)
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  if(value instanceof Date && !isNaN(value)) return fromLocalDateObj(value);

  if(typeof value === 'number'){
    // Excel serial date -> calendar date, computed directly in UTC to avoid any local-timezone drift
    const utcMs = Date.UTC(1899, 11, 30) + Math.round(value) * 86400000;
    const d = new Date(utcMs);
    if(isNaN(d)) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth()+1).padStart(2,'0');
    const day = String(d.getUTCDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  if(typeof value === 'string'){
    const trimmed = value.trim();
    // Y-M-D (ISO-ish)
    let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    // D/M/Y or D-M-Y (the format used in these templates, e.g. 01/08/2026 = 1 Aug 2026)
    m = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if(m){
      const day = parseInt(m[1],10), month = parseInt(m[2],10), year = m[3];
      return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    const d = new Date(trimmed);
    if(!isNaN(d)) return fromLocalDateObj(d);
  }
  return null;
}

function detectFileKind(filename){
  const name = filename.toLowerCase().replace(/[_\-]/g, ' ');
  const hasIn = /\bstock\s*in\b/.test(name);
  const hasOut = /\bstock\s*out\b/.test(name);
  if(hasIn && !hasOut) return 'in';
  if(hasOut && !hasIn) return 'out';
  return null; // ambiguous or looks like a master file (e.g. plain "stock.xlsx")
}

function parseTxExcel(){
  const msg = document.getElementById('txImportMsg');
  const files = pendingTxFiles;

  if(files.length === 0){ msg.className='msg error'; msg.textContent='請先選擇至少一個 Excel 檔案'; return; }
  if(typeof XLSX === 'undefined'){ msg.className='msg error'; msg.textContent='Excel 解析套件載入失敗,請重新整理頁面再試一次'; return; }

  // reject any file whose name doesn't clearly indicate stock-in or stock-out
  const badFiles = files.filter(f => detectFileKind(f.name) === null);
  if(badFiles.length > 0){
    msg.className = 'msg error';
    msg.textContent = `⚠ 這些檔名看起來不像每日進出貨紀錄表(檔名需包含「stock in」或「stock out」):${badFiles.map(f=>f.name).join(', ')}。如果是庫存主檔,請改用區塊0的「從 Excel 匯入」。`;
    document.getElementById('txImportPreview').innerHTML = '';
    return;
  }

  msg.className = 'msg'; msg.textContent = `解析中(共 ${files.length} 個檔案)…`;

  const allMatches = [];
  const allUnmatched = [];
  let filesDone = 0;
  let firstDetectedDate = null;
  let firstDetectedParty = null;

  files.forEach(file => {
    const fileKind = detectFileKind(file.name);
    const reader = new FileReader();
    reader.onerror = () => {
      allUnmatched.push({ rawText: `[${file.name}] 讀取檔案失敗`, qty: 0, sourceFile: file.name });
      filesDone++;
      if(filesDone === files.length) finishTxParse();
    };
    reader.onload = (e) => {
      try{
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

        // try to detect a date and supplier near the top of this sheet
        let detectedDate = null;
        let detectedParty = null;
        for(let r = 0; r < Math.min(rows.length, 10); r++){
          const row = rows[r] || [];
          for(let c = 0; c < row.length; c++){
            const cell = row[c];
            if(typeof cell !== 'string') continue;
            const label = cell.replace(':','').trim().toLowerCase();
            if(label === 'date' && !detectedDate){
              for(let c2 = c+1; c2 < row.length; c2++){
                if(row[c2] !== null && row[c2] !== ''){ detectedDate = excelDateToISO(row[c2]); break; }
              }
            }
            if((label === 'supplier' || label === 'store/reason' || label === 'shop') && !detectedParty){
              for(let c2 = c+1; c2 < row.length; c2++){
                if(row[c2] !== null && row[c2] !== '' && typeof row[c2] === 'string'){ detectedParty = row[c2].trim(); break; }
              }
            }
          }
        }
        if(!firstDetectedDate && detectedDate) firstDetectedDate = detectedDate;
        if(!firstDetectedParty && detectedParty) firstDetectedParty = detectedParty;

        const QTY_HEADER_ALIASES = ['qty', '數量', 'quantity'];
        const ITEM_HEADER_ALIASES = ['item', '品名', '商品', '商品名稱', 'name'];
        const NOTE_HEADER_ALIASES = ['note', 'notes', '備註', 'remark'];
        const PARTY_HEADER_ALIASES = ['supplier', 'customer', 'party', '對象', '客戶', '廠商', '供應商'];
        const DATE_HEADER_ALIASES = ['date', '日期'];
        let headerRowIndex = -1, colQty = -1, colItem = -1, colNote = -1, colParty = -1, colDate = -1;

        const firstRow = rows[0] || [];
        const qIdx = firstRow.findIndex(c => typeof c === 'string' && QTY_HEADER_ALIASES.includes(c.trim().toLowerCase()));
        if(qIdx !== -1){
          headerRowIndex = 0;
          colQty = qIdx;
          const iIdx = firstRow.findIndex(c => typeof c === 'string' && ITEM_HEADER_ALIASES.includes(c.trim().toLowerCase()));
          if(iIdx !== -1) colItem = iIdx;
          const nIdx = firstRow.findIndex(c => typeof c === 'string' && NOTE_HEADER_ALIASES.includes(c.trim().toLowerCase()));
          if(nIdx !== -1) colNote = nIdx;
          const pIdx = firstRow.findIndex(c => typeof c === 'string' && PARTY_HEADER_ALIASES.includes(c.trim().toLowerCase()));
          if(pIdx !== -1) colParty = pIdx;
          const dIdx = firstRow.findIndex(c => typeof c === 'string' && DATE_HEADER_ALIASES.includes(c.trim().toLowerCase()));
          if(dIdx !== -1) colDate = dIdx;
        }

        const dataRows = headerRowIndex !== -1 ? rows.slice(headerRowIndex + 1) : rows;

        dataRows.forEach(row => {
          if(!row) return;
          let rawQty = null;

          if(colQty !== -1){
            const cell = row[colQty];
            if(typeof cell === 'number' && cell !== 0) rawQty = cell;
          } else {
            row.forEach(cell => {
              if(typeof cell === 'number' && cell !== 0 && rawQty === null) rawQty = cell;
            });
          }
          if(rawQty === null) return;

          let matchedProduct = null;
          let rawText = null;
          const rowNote = colNote !== -1 && row[colNote] ? String(row[colNote]).trim() : '';

          if(colItem !== -1){
            // strict mode: an Item header was found in row 1, so ONLY trust that column —
            // never scan other cells, since they may coincidentally contain matching text
            if(typeof row[colItem] === 'string' && row[colItem].trim() !== ''){
              rawText = row[colItem];
              const p = findMatchingProduct(row[colItem]);
              if(p) matchedProduct = p;
            }
          } else {
            // fallback mode: no Item header was found anywhere in row 1, so scan the whole row
            row.forEach(cell => {
              if(matchedProduct) return;
              if(typeof cell === 'string' && cell.trim() !== ''){
                const lower = cell.trim().toLowerCase();
                if(['item','unit','qty','date','date:','supplier','invoice number','type','item code','name','unit/ctn','note','notes','備註'].includes(lower)) return;
                const p = findMatchingProduct(cell);
                if(p){ matchedProduct = p; rawText = cell; }
                else if(!rawText || cell.trim().length > rawText.trim().length) rawText = cell;
              }
            });
          }

          const isNegative = rawQty < 0;
          const qty = Math.abs(rawQty);
          // negative qty flips direction: on a stock-in sheet it's treated as a return to supplier (out);
          // on a stock-out sheet it's treated as a restock/return-to-inventory (its own type, not a purchase)
          const effectiveType = isNegative ? (fileKind === 'in' ? 'out' : 'restock') : fileKind;
          const rowParty = colParty !== -1 && row[colParty] ? String(row[colParty]).trim() : '';
          const rowDate = colDate !== -1 && row[colDate] !== null && row[colDate] !== undefined && row[colDate] !== ''
            ? excelDateToISO(row[colDate]) : null;

          if(matchedProduct){
            allMatches.push({
              productId: matchedProduct.id, name: matchedProduct.name, unit: matchedProduct.unit,
              qty, rawText, type: effectiveType, flipped: isNegative,
              date: rowDate || detectedDate, party: rowParty || detectedParty, sourceFile: file.name, rowNote
            });
          } else if(rawText){
            allUnmatched.push({ rawText, qty, sourceFile: file.name });
          }
        });
      } catch(err){
        allUnmatched.push({ rawText: `[${file.name}] 解析失敗:${err.message}`, qty: 0, sourceFile: file.name });
      } finally {
        filesDone++;
        if(filesDone === files.length) finishTxParse();
      }
    };
    reader.readAsArrayBuffer(file);
  });

  function finishTxParse(){
    const dateInput = document.getElementById('txImportDate');
    if(firstDetectedDate){ dateInput.value = firstDetectedDate; }
    else if(!dateInput.value){ dateInput.value = todayISO(); }

    const partyInput = document.getElementById('txImportParty');
    if(firstDetectedParty && !partyInput.value){ partyInput.value = firstDetectedParty; }

    pendingTxMatches = allMatches;
    renderTxPreview(allMatches, allUnmatched);
    const flippedCount = allMatches.filter(m => m.flipped).length;
    if(allMatches.length === 0){
      msg.className = 'msg error';
      msg.textContent = `⚠ 沒有解析到任何可匯入的品項(共 ${files.length} 個檔案)。${allUnmatched.length > 0 ? '請看下方無法比對清單。' : '請確認檔案格式跟商品名稱是否對得上。'}`;
    } else {
      msg.className = 'msg ok';
      msg.textContent = `✓ 解析完成(共 ${files.length} 個檔案):找到 ${allMatches.length} 筆可比對的品項${flippedCount > 0 ? `(其中 ${flippedCount} 筆是負數,已自動轉向)` : ''}${allUnmatched.length > 0 ? `,${allUnmatched.length} 筆無法比對` : ''}`;
    }
  }
}

function renderTxPreview(matches, unmatched){
  const container = document.getElementById('txImportPreview');
  if(matches.length === 0 && unmatched.length === 0){
    container.innerHTML = '';
    return;
  }

  const multiFile = new Set(matches.map(m => m.sourceFile)).size > 1
    || new Set(matches.map(m => m.date)).size > 1;

  let html = '';
  if(matches.length > 0){
    const inCount = matches.filter(m => m.type === 'in').length;
    const outCount = matches.filter(m => m.type === 'out').length;
    const restockCount = matches.filter(m => m.type === 'restock').length;
    html += `
      <div class="preview-actions preview-actions-top">
        ${outCount > 0 ? `<div style="margin-bottom:8px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;">
            <input type="checkbox" id="txImportAddToCompletedOrder" checked />
            <span>併入待處理訂單(勾選才會賦予訂單編號,並顯示在「訂貨後台管理 → 待處理訂單」,核對後才會正式扣庫存;不勾選則只是單純登記出貨紀錄、直接異動庫存。只影響類型為「出貨」的品項,同一對象+同一日期會合併成一張訂單)</span>
          </label>
        </div>
        <div class="field" style="max-width:340px;margin-bottom:10px;">
          <label style="font-size:11px;color:var(--ink-soft);display:block;margin-bottom:4px;">指定出貨方(建立的訂單要正式歸到哪一個出貨方,強烈建議選填)</label>
          <select id="txImportOrderParty">
            <option value="" data-i18n="partyAutoMatchOptionLabel">— 依匯入的對象名稱自動比對,比對不到就沒有出貨方 —</option>
            ${shippingParties.map(sp => `<option value="${sp.id}">${sp.name.replace(/"/g,'&quot;')}</option>`).join('')}
          </select>
        </div>` : ''}
        <button class="btn" onclick="confirmTxImport()">確認匯入 ${matches.length} 筆紀錄(進貨 ${inCount} / 出貨 ${outCount}${restockCount > 0 ? ` / 入庫 ${restockCount}` : ''})</button>
      </div>
      <table class="preview-table">
        <thead><tr><th>商品</th>${multiFile ? '<th>日期</th><th>來源檔案</th>' : ''}<th>類型</th><th>數量</th><th></th></tr></thead>
        <tbody>
          ${matches.map((m, i) => `<tr>
            <td>${m.name}(${m.unit})<span style="color:var(--ink-soft);font-size:10.5px;display:block;">原始文字:${m.rawText}${m.flipped ? `(負數,已自動轉為${m.type === 'restock' ? '入庫' : (m.type === 'out' ? '出貨' : '進貨')})` : ''}${m.rowNote ? ` · 備註:${m.rowNote}` : ''}</span></td>
            ${multiFile ? `<td style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;">${m.date || '(用下方日期)'}</td><td style="font-size:11px;color:var(--ink-soft);">${m.sourceFile}</td>` : ''}
            <td>
              <select onchange="updatePreviewType(${i}, this.value)">
                <option value="in" ${m.type === 'in' ? 'selected' : ''}>進貨</option>
                <option value="out" ${m.type === 'out' ? 'selected' : ''}>出貨</option>
                <option value="restock" ${m.type === 'restock' ? 'selected' : ''}>入庫</option>
              </select>
            </td>
            <td><input type="number" min="0" step="1" value="${m.qty}" onchange="updatePreviewQty(${i}, this.value)" /></td>
            <td><span class="del-link" onclick="removeTxPreviewRow(${i})">移除</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="preview-actions">
        <button class="btn" onclick="confirmTxImport()">確認匯入 ${matches.length} 筆紀錄(進貨 ${inCount} / 出貨 ${outCount}${restockCount > 0 ? ` / 入庫 ${restockCount}` : ''})</button>
      </div>
    `;
  }
  if(unmatched.length > 0){
    html += `<div class="preview-unmatched">
      <strong>有 ${unmatched.length} 列找不到對應商品(未匯入),請確認商品是否已新增,或名稱是否差太多:</strong>
      ${unmatched.map(u => `「${u.rawText}」(數量 ${u.qty}${u.sourceFile ? ', ' + u.sourceFile : ''})`).join('、')}
    </div>`;
  }
  container.innerHTML = html;
}

function removeTxPreviewRow(index){
  pendingTxMatches.splice(index, 1);
  renderTxPreview(pendingTxMatches, []);
}

function updatePreviewQty(index, value){
  pendingTxMatches[index].qty = parseFloat(value) || 0;
}

function updatePreviewType(index, value){
  pendingTxMatches[index].type = value;
}

async function confirmTxImport(){
  const fallbackDate = document.getElementById('txImportDate').value || todayISO();
  const fallbackParty = document.getElementById('txImportParty').value.trim();
  const msg = document.getElementById('txImportMsg');

  const addToOrderCheckbox = document.getElementById('txImportAddToCompletedOrder');
  const addToOrder = !addToOrderCheckbox || addToOrderCheckbox.checked;
  // 如果使用者有在下拉選單明確指定出貨方,這次匯入建立的所有訂單都直接掛那個出貨方的 partyId,
  // 不用再去猜「對象」欄位打的文字對不對得上——這是最可靠的做法,建議每次匯入都選填這個。
  // 沒有指定的話,才退回用「對象」文字自動比對現有出貨方名稱(打的字要完全對得上,大小寫、
  // 前後空白不計較,但抓的名稱本身如果不一致還是會比對不到)。
  const orderPartySelectEl = document.getElementById('txImportOrderParty');
  const explicitOrderPartyId = orderPartySelectEl ? orderPartySelectEl.value : '';
  const explicitOrderParty = explicitOrderPartyId ? shippingParties.find(sp => sp.id === explicitOrderPartyId) : null;

  // 出貨的匯入品項,如果有勾選「併入待處理訂單」,要先依「對象+日期」分組,同一對象、同一天的
  // 出貨合併成一張訂單(模擬一張出貨單就是一張訂單),再各自跟資料庫要一個訂單號,
  // 邏輯跟「登記進出貨→併入已完成訂單」還有購物車送出訂貨共用同一個序列(next_order_no RPC),
  // 確保訂單號不會跟系統其他地方重複。這裡建立的訂單一律是 'pending'(待處理),不會馬上扣庫存,
  // 跟「登記進出貨」那邊(直接視為已完成訂單)不一樣——因為 Excel 匯入的出貨單通常還需要人工核對。
  const orderGroups = new Map(); // key: party||date -> { date, party, items: [...], txRefs: [...] }
  if(addToOrder){
    pendingTxMatches.forEach(m => {
      if(m.type !== 'out' || !(m.qty > 0)) return;
      const date = m.date || fallbackDate;
      const party = m.party || fallbackParty;
      const key = `${party}||${date}`;
      if(!orderGroups.has(key)) orderGroups.set(key, { date, party, matches: [] });
      orderGroups.get(key).matches.push(m);
    });
  }

  const newOrders = [];
  if(orderGroups.size > 0){
    try{
      for(const group of orderGroups.values()){
        const orderId = genId();
        const orderNo = await getSafeNextOrderNo();
        group.orderId = orderId;
        group.orderNo = orderNo;
        // 優先用使用者明確選的出貨方;沒選的話,依「對象」的名稱比對現有的出貨方,找得到就把
        // 訂單正式掛上那個出貨方的 partyId(不只是存一段文字而已),這樣「有這家出貨方權限的
        // 帳號」才看得到這張訂單、才能在「訂購記錄」裡簽收——不管訂單是誰匯入/下的都一樣。
        const matchedParty = explicitOrderParty || shippingParties.find(sp => sp.name.trim().toLowerCase() === group.party.trim().toLowerCase());
        newOrders.push({
          id: orderId,
          date: group.date,
          note: '',
          partyId: matchedParty ? matchedParty.id : null,
          partyName: matchedParty ? matchedParty.name : group.party,
          items: group.matches.map(m => ({ productId: m.productId, sku: '', name: m.name, unit: m.unit, qty: m.qty })),
          status: 'pending',
          createdAt: new Date().toISOString(),
          orderNo
        });
      }
    } catch(e){
      msg.className = 'msg error';
      msg.textContent = '⚠ 取得訂單編號失敗,請重新整理頁面再試一次。';
      return;
    }
  }

  // 出貨的匯入品項,如果被併進上面的訂單(orderGroups),現在不會馬上寫入出貨紀錄、也不會扣庫存 ——
  // 這些訂單先以「待處理」狀態建立,要等「訂貨後台管理 → 待處理訂單」或「倉庫作業台 → 訂單核對」
  // 核對過才會真的扣庫存、寫入出貨紀錄(邏輯跟購物車送出訂貨一致)。沒有被併進訂單的出貨(勾選
  // 「併入已完成訂單」被取消,或本來就不是出貨)則維持原樣,照登記當下直接寫入紀錄、立即異動庫存。

  // 這些「沒有併入訂單」的異動會直接動庫存,送出前先算出每個商品的累計異動量(同一個商品可能
  // 同時有好幾筆進貨/出貨/入庫紀錄要一起匯入),檢查最終結果會不會變成負數——不能只看單筆,
  // 要看這一批全部套用完之後的最終庫存。有任何一個商品會變負數,整批都不匯入,清楚列出是
  // 哪個商品、現在庫存多少、這批套用完會變成多少,讓使用者能對照 Excel 原始檔案修正。
  const stockImpact = {}; // productId -> 這批匯入對這個商品的累計異動量(正值加庫存,負值扣庫存)
  pendingTxMatches.forEach(m => {
    if(!(m.qty > 0)) return;
    if(m.type === 'out'){
      const key = `${m.party || fallbackParty}||${m.date || fallbackDate}`;
      if(orderGroups.has(key)) return; // 併入待處理訂單的,核對時才會扣庫存,不算在這裡
      stockImpact[m.productId] = (stockImpact[m.productId] || 0) - m.qty;
    } else {
      stockImpact[m.productId] = (stockImpact[m.productId] || 0) + m.qty;
    }
  });
  const negativeResults = Object.keys(stockImpact)
    .map(productId => ({ productId, delta: stockImpact[productId], currentStock: computeStock(productId) }))
    .filter(r => r.currentStock + r.delta < 0);
  if(negativeResults.length > 0){
    const lines = negativeResults.map(r => {
      const p = products.find(pp => pp.id === r.productId);
      return tf('importTxNegativeStockLine', { name: p ? p.name : r.productId, current: r.currentStock, result: r.currentStock + r.delta });
    });
    msg.className = 'msg error';
    showInfoModal(`${t('importNegativeStockIntro')}\n${lines.join('\n')}`);
    return;
  }

  let inCount = 0, outCount = 0, restockCount = 0, pendingOutCount = 0;
  const newTxs = [];
  pendingTxMatches.forEach(m => {
    if(!(m.qty > 0)) return;

    if(m.type === 'out'){
      const key = `${m.party || fallbackParty}||${m.date || fallbackDate}`;
      const group = orderGroups.get(key);
      if(group){
        pendingOutCount++;
        return; // 併進待處理訂單了,不在這裡建立出貨紀錄
      }
    }

    // 備註是登記當下就寫死存進資料庫的文字,不會隨語言切換即時翻譯,所以固定用英文寫入,
    // 不呼叫 t() 讀取當前介面語言,以免同一筆紀錄的備註因登記當下語言不同而長得不一樣。
    const autoLabel = `Excel Import${m.sourceFile ? `(${m.sourceFile})` : ''}${m.flipped ? ' · Auto-flipped from negative' : ''}`;
    const tx = {
      id: genId(),
      productId: m.productId,
      type: m.type,
      qty: m.qty,
      date: m.date || fallbackDate,
      party: m.party || fallbackParty,
      note: m.rowNote ? m.rowNote : autoLabel
    };
    transactions.push(tx);
    newTxs.push(tx);
    if(m.type === 'in') inCount++;
    else if(m.type === 'restock') restockCount++;
    else outCount++;
  });

  try{
    await insertTransactions(newTxs);
    if(newOrders.length > 0){ await upsertOrders(newOrders); await saveOrderCounter(); }
  }
  catch(e){
    newTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i >= 0) transactions.splice(i, 1); });
    msg.className = 'msg error';
    msg.textContent = '⚠ 匯入失敗,請重新整理頁面再試一次。';
    return;
  }
  if(newOrders.length > 0){
    orders.push(...newOrders);
    recomputeOrderCounterFromOrders();
    newOrders.forEach(o => {
      logInventoryAction('order_place', `Created pending order ${o.orderNo} via Excel import (${o.partyName || 'No recipient specified'}, ${o.items.length} item(s)), stock not yet deducted`, o.orderNo);
    });
  }
  // 直接寫入的異動紀錄(沒有併入待處理訂單的進貨/出貨/入庫)之前完全沒有記錄進後台紀錄——
  // 只有併入訂單的那部分有記(上面那段)。這裡補上,列出匯入了哪個/哪些檔案。
  if(newTxs.length > 0){
    const sourceFiles = [...new Set(pendingTxMatches.map(m => m.sourceFile).filter(Boolean))];
    const fileListForLog = sourceFiles.length > 0 ? sourceFiles.join(', ') : 'unknown source';
    logInventoryAction('import', `Imported transactions from: ${fileListForLog} — in ${inCount}, out ${outCount}${restockCount > 0 ? `, restock ${restockCount}` : ''}`, null);
  }
  msg.className = 'msg ok';
  const unlinkedOrders = newOrders.filter(o => !o.partyId);
  let orderNote = '';
  if(newOrders.length > 0){
    orderNote = `,已建立 ${newOrders.length} 張待處理訂單(${newOrders.map(o => o.orderNo).join('、')}),核對後才會扣庫存`;
    if(unlinkedOrders.length > 0){
      orderNote += `。⚠ 其中 ${unlinkedOrders.length} 張(${unlinkedOrders.map(o => o.orderNo).join('、')})沒有比對到現有出貨方,只有不限出貨方權限的帳號(例如管理者)看得到,建議到「訂貨後台管理→待處理訂單」手動確認,或下次匯入時在上面直接指定出貨方`;
    }
  }
  msg.textContent = `✓ 已匯入 ${inCount + outCount + restockCount} 筆紀錄(進貨 ${inCount} / 出貨 ${outCount}${restockCount > 0 ? ` / 入庫 ${restockCount}` : ''})${pendingOutCount > 0 ? `,另有 ${pendingOutCount} 筆出貨併入待處理訂單` : ''}${orderNote}`;
  document.getElementById('txImportPreview').innerHTML = '';
  pendingTxMatches = [];
  pendingTxFiles = [];
  renderTxFileList();
  renderAll();
}

// 商品主檔匯入的核心邏輯——dryRun=true 時只計算「如果真的套用會有什麼異動」,完全不寫入資料庫、
// 不呼叫 logInventoryAction、也不去動畫面上的 msg/renderAll(),回傳算出來的預覽文字讓外層的
// importStockItems 拿去給使用者看、按確認之後才真的套用;dryRun=false 才是原本「真的執行」的
// 那條路徑。呼叫這個函式時,products/transactions 應該已經先被外層換成「拷貝出來的版本」
// (dry run 用)或「真正的全域陣列」(真的執行時)——這個函式本身不知道、也不需要知道現在是
// 對著哪一份資料在跑,邏輯完全一樣,才能保證預覽看到的內容,跟真的按下去之後實際發生的完全一致。
// 商品主檔匯入的對外入口:先在拷貝出來的 products/transactions 上跑一次同樣的匯入邏輯(dry
// run),算出「如果真的匯入,會新增/更新/略過哪些商品、批量設定套用不了的又是哪些」,完全不會
// 動到真正的資料、也不會讓畫面上任何地方看起來有變化。算完之後跳出確認視窗把這些內容列出來,
// 使用者按「確認」才會用同一套邏輯、對著真正的資料再跑一次,真的套用這些異動;按「取消」則
// 什麼都不會發生,商品資料維持原樣。
// 這裡刻意用「暫時把全域的 products/transactions 換成拷貝版本、跑完 dry run 立刻換回來」的
// 做法,而不是把 runStockImportCore 整個函式改寫成不直接讀寫全域變數——後者要動的地方太多、
// 風險較高,前者只要 dry run 那段過程中完全沒有 await(已經確認過:dry run 不會呼叫
// saveProducts/insertTransactions/logInventoryAction 這些非同步操作),就不會有其他程式
// 在中途插進來看到「一半拷貝、一半真實」的資料,可以放心切換再換回來。
async function importStockItems(items, skippedRows, clearBlanksMode){
  const realProducts = products;
  const realTransactions = transactions;
  products = JSON.parse(JSON.stringify(realProducts));
  transactions = JSON.parse(JSON.stringify(realTransactions));

  let dryRunResult;
  try{
    dryRunResult = await runStockImportCore(items, skippedRows, clearBlanksMode, true);
  } finally {
    // 不管 dry run 過程有沒有出錯,都一定要把真正的資料換回來,不能让複製版本卡在全域變數上。
    products = realProducts;
    transactions = realTransactions;
  }

  if(dryRunResult.blocked) return; // 負庫存這類直接擋下的情況,dry run 階段已經跳出錯誤視窗說明了,這裡不用再多做什麼

  showConfirmModal(`${t('importConfirmIntro')}\n${dryRunResult.previewText}`, async () => {
    await runStockImportCore(items, skippedRows, clearBlanksMode, false);
  });
}

async function runStockImportCore(items, skippedRows, clearBlanksMode, dryRun){
  skippedRows = skippedRows || [];
  clearBlanksMode = !!clearBlanksMode;
  const msg = document.getElementById('importMsg');

  // 匯入前先檢查有沒有任何一列的庫存量是負的——這種資料一套用進去,商品的庫存就會直接變成
  // 負數,通常是打錯字或表格抓錯欄位造成的。只要有一項不符合,整批都不匯入,清楚列出是哪個
  // 檔案、哪一列、哪個商品造成的,讓使用者能對照 Excel 原始檔案修正後再重新匯入。
  const negativeStockItems = items.filter(item => item.qty !== null && item.qty !== undefined && item.qty < 0);
  if(negativeStockItems.length > 0){
    const lines = negativeStockItems.map(item =>
      tf('importNegativeStockLine', { file: item._sourceFile || t('importInitialSeedSource'), row: item._sourceRow || '—', name: item.name, sku: item.sku, qty: item.qty })
    );
    showInfoModal(`${t('importNegativeStockIntro')}\n${lines.join('\n')}`);
    return { blocked: true };
  }

  const today = todayISO();
  let added = 0, updated = 0, unchanged = 0, skippedNoSku = 0;
  const updateDetails = []; // { sku, name, fields } — 逐項記錄哪個商品被更新、具體改了哪些欄位
  const newTxs = [];

  items.forEach(item => {
    if(!item.sku){ skippedNoSku++; return; }

    const existing = products.find(p => p.sku === item.sku);

    if(!existing){
      const id = genId();
      products.push({
        id,
        sku: item.sku,
        name: item.name,
        unit: item.unit || '個',
        category: item.category || '未分類',
        manualAvg: (item.avg !== null && item.avg !== undefined) ? item.avg : null,
        safetyStock: (item.safetyStock !== null && item.safetyStock !== undefined) ? item.safetyStock : null,
        note: item.note || '',
        orderable: false,
        parentId: null,
        childWeight: null,
        boxLengthCm: (item.boxLengthCm !== null && item.boxLengthCm !== undefined && !isNaN(item.boxLengthCm)) ? item.boxLengthCm : undefined,
        boxWidthCm: (item.boxWidthCm !== null && item.boxWidthCm !== undefined && !isNaN(item.boxWidthCm)) ? item.boxWidthCm : undefined,
        boxHeightCm: (item.boxHeightCm !== null && item.boxHeightCm !== undefined && !isNaN(item.boxHeightCm)) ? item.boxHeightCm : undefined,
        hidden: item.hidden === true,
        orderPageRemark: item.orderPageRemark || undefined,
        barcode: item.barcode || undefined
      });
      if(item.qty > 0){
        const tx = {
          id: genId(),
          productId: id,
          type: 'in',
          qty: item.qty,
          date: today,
          note: 'Excel Import - Initial Stock',
          system: true,
          masterImportAdjustment: true
        };
        transactions.push(tx);
        newTxs.push(tx);
      }
      added++;
      return;
    }

    // 已存在的商品:以 SKU 為準判定是同一項商品。商品名稱一律維持庫存總覽現有的名稱,
    // 不會被匯入的表格覆蓋(即使表格上寫的名稱不一樣)。單位/分類/平均值/安全庫存/備註仍會更新,並依表格數量調整庫存。
    // clearBlanksMode(使用者有勾選「空白就清空」才會是 true):選填欄位如果表格上是空白,且這個
    // 商品現在確實有值,就清空回「跟新增商品時同樣的空白預設值」;沒勾選的話維持原本的安全行為,
    // 空白欄位完全不動現有的值。
    let changed = false;
    const changedFields = []; // 逐項記錄這個商品「哪個欄位」從什麼值變成什麼值,供最後的詳細清單使用
    if(item.unit && existing.unit !== item.unit){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldUnit'), from: existing.unit, to: item.unit})); existing.unit = item.unit; changed = true; }
    else if(clearBlanksMode && !item.unit && existing.unit !== '個'){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldUnit'), from: existing.unit, to: '個'})); existing.unit = '個'; changed = true; }
    if(item.category && existing.category !== item.category){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldCategory'), from: existing.category, to: item.category})); existing.category = item.category; changed = true; }
    else if(clearBlanksMode && !item.category && existing.category !== '未分類'){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldCategory'), from: existing.category, to: '未分類'})); existing.category = '未分類'; changed = true; }
    if(item.avg !== null && item.avg !== undefined && existing.manualAvg !== item.avg){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldAvg'), from: existing.manualAvg, to: item.avg})); existing.manualAvg = item.avg; changed = true; }
    else if(typeof existing.manualAvg === 'number' && isNaN(existing.manualAvg)){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldAvg'), from: 'NaN', to: '(空白)'})); existing.manualAvg = null; changed = true; }
    else if(clearBlanksMode && (item.avg === null || item.avg === undefined) && existing.manualAvg !== null && existing.manualAvg !== undefined){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldAvg'), from: existing.manualAvg, to: '(空白)'})); existing.manualAvg = null; changed = true; }
    if(item.safetyStock !== null && item.safetyStock !== undefined && existing.safetyStock !== item.safetyStock){ changedFields.push(tf('importFieldChangeLine', {field: t('colSafety'), from: existing.safetyStock, to: item.safetyStock})); existing.safetyStock = item.safetyStock; changed = true; }
    else if(clearBlanksMode && (item.safetyStock === null || item.safetyStock === undefined) && existing.safetyStock !== null && existing.safetyStock !== undefined){ changedFields.push(tf('importFieldChangeLine', {field: t('colSafety'), from: existing.safetyStock, to: '(空白)'})); existing.safetyStock = null; changed = true; }
    if(item.note && existing.note !== item.note){ changedFields.push(tf('importFieldChangeLine', {field: t('colNote'), from: existing.note, to: item.note})); existing.note = item.note; changed = true; }
    else if(clearBlanksMode && !item.note && existing.note){ changedFields.push(tf('importFieldChangeLine', {field: t('colNote'), from: existing.note, to: '(空白)'})); existing.note = ''; changed = true; }
    if(item.boxLengthCm !== null && item.boxLengthCm !== undefined && !isNaN(item.boxLengthCm) && existing.boxLengthCm !== item.boxLengthCm){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBoxLength'), from: existing.boxLengthCm, to: item.boxLengthCm})); existing.boxLengthCm = item.boxLengthCm; changed = true; }
    else if(clearBlanksMode && (item.boxLengthCm === null || item.boxLengthCm === undefined) && existing.boxLengthCm !== null && existing.boxLengthCm !== undefined){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBoxLength'), from: existing.boxLengthCm, to: '(空白)'})); existing.boxLengthCm = undefined; changed = true; }
    if(item.boxWidthCm !== null && item.boxWidthCm !== undefined && !isNaN(item.boxWidthCm) && existing.boxWidthCm !== item.boxWidthCm){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBoxWidth'), from: existing.boxWidthCm, to: item.boxWidthCm})); existing.boxWidthCm = item.boxWidthCm; changed = true; }
    else if(clearBlanksMode && (item.boxWidthCm === null || item.boxWidthCm === undefined) && existing.boxWidthCm !== null && existing.boxWidthCm !== undefined){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBoxWidth'), from: existing.boxWidthCm, to: '(空白)'})); existing.boxWidthCm = undefined; changed = true; }
    if(item.boxHeightCm !== null && item.boxHeightCm !== undefined && !isNaN(item.boxHeightCm) && existing.boxHeightCm !== item.boxHeightCm){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBoxHeight'), from: existing.boxHeightCm, to: item.boxHeightCm})); existing.boxHeightCm = item.boxHeightCm; changed = true; }
    else if(clearBlanksMode && (item.boxHeightCm === null || item.boxHeightCm === undefined) && existing.boxHeightCm !== null && existing.boxHeightCm !== undefined){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBoxHeight'), from: existing.boxHeightCm, to: '(空白)'})); existing.boxHeightCm = undefined; changed = true; }
    if(item.hidden !== null && item.hidden !== undefined && existing.hidden !== item.hidden){ changedFields.push(tf('importFieldChangeLine', {field: t('hideAction'), from: existing.hidden, to: item.hidden})); existing.hidden = item.hidden; changed = true; }
    if(item.autoConvertOnStockIn !== null && item.autoConvertOnStockIn !== undefined && existing.autoConvertOnStockIn !== item.autoConvertOnStockIn){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldAutoConvertStockIn'), from: existing.autoConvertOnStockIn, to: item.autoConvertOnStockIn})); existing.autoConvertOnStockIn = item.autoConvertOnStockIn; changed = true; }
    if(item.orderPageRemark !== null && item.orderPageRemark !== undefined && existing.orderPageRemark !== item.orderPageRemark){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldOrderPageRemark'), from: existing.orderPageRemark || '(空白)', to: item.orderPageRemark})); existing.orderPageRemark = item.orderPageRemark; changed = true; }
    else if(clearBlanksMode && (item.orderPageRemark === null || item.orderPageRemark === undefined) && existing.orderPageRemark){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldOrderPageRemark'), from: existing.orderPageRemark, to: '(空白)'})); existing.orderPageRemark = undefined; changed = true; }
    if(item.barcode !== null && item.barcode !== undefined && existing.barcode !== item.barcode){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBarcode'), from: existing.barcode || '(空白)', to: item.barcode})); existing.barcode = item.barcode; changed = true; }
    else if(clearBlanksMode && (item.barcode === null || item.barcode === undefined) && existing.barcode){ changedFields.push(tf('importFieldChangeLine', {field: t('fieldBarcode'), from: existing.barcode, to: '(空白)'})); existing.barcode = undefined; changed = true; }

    // 庫存量欄位是選填:表格上這一列如果沒填庫存量(item.qty 是 null),完全不去比對/調整這個
    // 商品的庫存,只更新其他有填的欄位——這樣才能支援「只更新商品資料、不重新盤點庫存」的匯入,
    // 不會因為沒填庫存量就順便把庫存改掉或跳過整列。
    if(item.qty !== null && item.qty !== undefined){
      const currentStock = computeStock(existing.id);
      const diff = item.qty - currentStock;
      if(Math.abs(diff) >= 0.01){
        changedFields.push(tf('importStockChangeLine', {from: currentStock, to: item.qty, unit: existing.unit}));
        const tx = {
          id: genId(),
          productId: existing.id,
          type: diff > 0 ? 'in' : 'out',
          qty: Math.abs(diff),
          date: today,
          note: `Excel Import - Stock Adjusted (sheet updated to ${item.qty}${existing.unit})`,
          system: true,
          masterImportAdjustment: true
        };
        transactions.push(tx);
        newTxs.push(tx);
        changed = true;
      }
    }
    if(changed) updateDetails.push({ sku: item.sku, name: existing.name, fields: changedFields });

    if(changed) updated++; else unchanged++;
  });

  // 第二輪:處理批量商品(multi-pack)的主/子關係。要等所有列的商品都先建立/更新完成,
  // 才能確保 ParentSKU 指到的主商品(不管是這次匯入新增的,還是本來就存在的)一定找得到。
  // 只有表格上有填 ParentSKU 的列才會處理,沒有填就完全不動這個商品原本的批量設定
  // (不會因為重新匯入就把已經設定好的批量關係清掉)。
  let linked = 0, linkSkipped = 0;
  const linkSkipDetails = []; // { sku, reason } — 逐項記錄哪個 SKU 的批量設定套用不了、為什麼
  items.forEach(item => {
    if(!item.sku || !item.parentSku) return;
    const child = products.find(p => p.sku === item.sku);
    if(!child) return;
    if(item.parentSku === item.sku){ linkSkipped++; linkSkipDetails.push({ sku: item.sku, reason: t('importLinkSkipReasonSelfRef') }); return; } // 自己指自己,略過
    const parent = products.find(p => p.sku === item.parentSku);
    if(!parent){ linkSkipped++; linkSkipDetails.push({ sku: item.sku, reason: tf('importLinkSkipReasonParentNotFound', {parentSku: item.parentSku}) }); return; } // 表格裡跟系統裡都找不到這個 ParentSKU,略過批量設定
    if(parent.parentId){ linkSkipped++; linkSkipDetails.push({ sku: item.sku, reason: tf('importLinkSkipReasonNestedParent', {parentSku: item.parentSku}) }); return; } // 主商品本身也是別人的批量商品,不支援兩層巢巢,略過
    child.parentId = parent.id;
    if(item.childWeight !== null && item.childWeight !== undefined && !isNaN(item.childWeight)){
      child.childWeight = item.childWeight;
    } else if(child.childWeight === null || child.childWeight === undefined){
      child.childWeight = 1; // 沒填加權數,又還沒設定過,先預設 1(等於直接用庫存量加總)
    }
    if(item.autoConvertOnStockIn !== null && item.autoConvertOnStockIn !== undefined){
      child.autoConvertOnStockIn = item.autoConvertOnStockIn;
    }
    child.orderable = false; // 批量商品不能單獨被訂貨(比照「新增批量商品」介面的預設)
    linked++;
  });

  if(!dryRun){
    await saveProducts();
    try{ await insertTransactions(newTxs); }
    catch(e){
      msg.className = 'msg error';
      msg.textContent = '⚠ 商品主檔已更新,但庫存調整寫入失敗,請重新整理頁面確認庫存量再試一次。';
      renderAll();
      return { blocked: true };
    }

    // 匯入這個動作之前完全沒有寫進後台紀錄——只有畫面上一段暫時性的結果訊息,離開頁面就看不到
    // 了。這裡補上,列出匯入了哪個/哪些檔案,以及新增/更新/略過的統計數字。dry run 階段不會真的
    // 異動任何資料,不需要留下這筆紀錄。
    const sourceFiles = [...new Set(items.map(it => it._sourceFile).filter(Boolean))];
    const fileListForLog = sourceFiles.length > 0 ? sourceFiles.join(', ') : t('importInitialSeedSource');
    logInventoryAction('import', `Imported master data from: ${fileListForLog} — added ${added}, updated ${updated}, unchanged ${unchanged}${skippedNoSku > 0 ? `, skipped ${skippedNoSku}` : ''}`, null);
  }

  // summaryText 的算法不管是不是 dry run 都完全一樣——這樣預覽視窗看到的內容,才會跟真的按下去
  // 之後最終顯示的結果訊息一致,不會有「預覽說會怎樣,結果實際跑出來的不一樣」這種落差。
  const parts = [];
  if(added > 0) parts.push(`新增 ${added} 項商品`);
  if(updated > 0) parts.push(`更新 ${updated} 項現有商品(庫存量/分類/平均值/安全庫存/備註/訂貨頁面附註…等,商品名稱維持不變;庫存量欄位空白的話不會動庫存)`);
  if(unchanged > 0) parts.push(`${unchanged} 項沒有變化`);
  if(linked > 0) parts.push(`設定 ${linked} 項為批量商品(已連結主商品/加權數)`);
  if(skippedNoSku > 0) parts.push(`略過 ${skippedNoSku} 項沒有 SKU 的資料列`);
  let summaryText = (dryRun ? '' : '✓ ') + (parts.length > 0 ? parts.join(',') : '沒有可匯入的資料');

  // 詳細列出「哪一項商品」被更新、具體改了哪個欄位——不是只給一個籠統的數字,方便判斷是真的
  // 表格內容跟系統不一樣,還是庫存在兩次匯入之間被其他操作(下單、登記進出貨…)動過造成的落差。
  if(updateDetails.length > 0){
    summaryText += `\n✎ ${tf('importUpdateDetailIntro', {n: updateDetails.length})}`;
    updateDetails.forEach(d => {
      summaryText += `\n  · ${d.name}(SKU「${d.sku}」):${d.fields.join('; ')}`;
    });
  }

  // 詳細列出「哪一項」批量設定套用不了、為什麼——不是只給一個籠統的數字,方便對照 Excel
  // 原始檔案逐項排除問題(例如 ParentSKU 打錯字、或指到的那個商品其實也是別人的批量商品)。
  if(linkSkipDetails.length > 0){
    summaryText += `\n⚠ ${tf('importLinkSkipIntro', {n: linkSkipDetails.length})}`;
    linkSkipDetails.forEach(d => {
      summaryText += `\n  · SKU「${d.sku}」:${d.reason}`;
    });
  }

  // 詳細列出「哪一列」被整列略過、為什麼——包含解析階段就被排除的(缺品名/庫存量/SKU),
  // 不用再去猜是不是自己漏填了什麼。
  if(skippedRows.length > 0){
    summaryText += `\n⚠ ${tf('importSkippedRowsHeader', {n: skippedRows.length})}`;
    skippedRows.forEach(s => {
      summaryText += `\n  · ${tf('importSkippedRowLine', {file: s.file, row: s.row, identifier: s.identifier || '—', reason: s.reason})}`;
    });
  }

  if(dryRun){
    return { blocked: false, previewText: summaryText };
  }

  msg.className = 'msg ok';
  msg.textContent = summaryText;
  renderAll();
  return { blocked: false };
}

async function submitTxBatch(action){
  const msg = document.getElementById('txMsg');
  const date = document.getElementById('txDate').value;

  if(currentTxType === 'adjustment'){
    return submitAdjustmentFlow(date, msg);
  }

  if(currentTxType !== 'out'){
    return submitTxBatchSimple(date, msg);
  }

  if(!registerOutFlowType){
    msg.className = 'msg error'; msg.textContent = t('errSelectOutFlowTypeFirst');
    return;
  }
  if(!date){ msg.className = 'msg error'; msg.textContent = '請選擇日期'; return; }

  if(registerOutFlowType === 'new-order') return submitNewOrderFlow(action, date, msg);
  if(registerOutFlowType === 'load-pending') return submitLoadPendingFlow(action, msg);
  if(registerOutFlowType === 'load-completed') return submitLoadCompletedFlow(date, msg);
}

// 進貨/入庫維持原本邏輯,不受出貨這次改版影響:一批共用同一個類型/日期/對象/備註,
// 沒有訂單概念,單純各自登記成一筆進出貨紀錄。
// Delivery Note 共用的表單讀取/驗證:日期、備註(相關已完成訂單號寫在這裡)都必填,商品清單
// 至少要有一項——「儲存」「列印」都要先通過這個驗證才能繼續。回傳 { ok:true, data } 或
// { ok:false, error }。
function buildDeliveryNoteDraftFromForm(){
  const date = document.getElementById('txDate').value;
  const partyId = document.getElementById('txPartySelect').value || null;
  const partyObj = partyId ? shippingParties.find(sp => sp.id === partyId) : null;
  const note = document.getElementById('txNote').value.trim();

  if(!date) return { ok: false, error: '請選擇 Delivery 日期' };
  if(!note) return { ok: false, error: t('errDeliveryNoteRequired') };
  if(txBatchItems.length === 0) return { ok: false, error: '請先把至少一項商品加入清單' };

  return {
    ok: true,
    data: {
      date, partyId, partyName: partyObj ? partyObj.name : '', note,
      items: txBatchItems.map(it => ({ productId: it.productId, sku: it.sku || '', name: it.name, unit: it.unit, qty: it.qty }))
    }
  };
}

// Delivery Note「儲存」:存進 delivery_notes 資料庫,供之後用「載入」找回來繼續編輯。完全不會
// 建立任何 transactions 紀錄、也不會動到任何商品的庫存數字——這只是單純的文件記錄。
async function saveDeliveryNote(){
  const msg = document.getElementById('txMsg');
  const draft = buildDeliveryNoteDraftFromForm();
  if(!draft.ok){ msg.className = 'msg error'; msg.textContent = `⚠ ${draft.error}`; return; }

  const isUpdate = !!registerLoadedDeliveryNoteId;
  const note = isUpdate
    ? Object.assign(deliveryNotes.find(n => n.id === registerLoadedDeliveryNoteId), draft.data)
    : { id: genId(), createdAt: new Date().toISOString(), status: 'pending', ...draft.data };

  try{
    await upsertDeliveryNotes([note]);
  } catch(e){
    msg.className = 'msg error'; msg.textContent = '⚠ 儲存失敗,請重新整理頁面再試一次。';
    return;
  }

  if(!isUpdate) deliveryNotes.push(note);
  logInventoryAction('delivery_note', `${isUpdate ? 'Updated' : 'Created'} Delivery Note (${note.date}, ${note.note}) - ${note.items.length} item(s), no stock impact`, null);

  registerDeliveryFlowType = '';
  registerLoadedDeliveryNoteId = null;
  txBatchItems = [];
  const flowSel = document.getElementById('txDeliveryFlowType');
  if(flowSel) flowSel.value = '';
  setTxDeliveryFlowType('');
  msg.className = 'msg ok';
  msg.textContent = `✓ Delivery Note 已儲存(${note.date})`;
}

// Delivery Note「列印」:直接開列印視窗,不會存進資料庫——跟「儲存」是兩條分開的路徑,列印過
// 不代表這張 Note 就被記錄下來了,兩者互不影響。
async function printDeliveryNote(){
  const msg = document.getElementById('txMsg');
  const draft = buildDeliveryNoteDraftFromForm();
  if(!draft.ok){ msg.className = 'msg error'; msg.textContent = `⚠ ${draft.error}`; return; }
  const data = draft.data;

  const rowsHtml = data.items.map(it => `
    <tr>
      <td class="sku-col">${escapeHtmlForPrint(it.sku)}</td>
      <td>${escapeHtmlForPrint(it.name)}</td>
      <td style="text-align:right;">${it.qty}</td>
      <td>${escapeHtmlForPrint(it.unit)}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Delivery Note</title>
<style>
  body{ font-family:'Microsoft JhengHei', Arial, sans-serif; padding:24px; color:#111; }
  h1{ font-size:18px; margin:0 0 4px; }
  h2{ font-size:12.5px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#B23B2E; margin:0 0 14px; }
  .meta{ font-size:13px; color:#333; margin-bottom:3px; }
  table{ border-collapse:collapse; width:100%; margin-top:14px; }
  th, td{ padding:7px 10px; border:1px solid #999; font-size:13px; text-align:left; }
  th{ background:#eee; }
  .sku-col{ width:1%; white-space:nowrap; }
</style>
</head>
<body>
  <h2>Delivery Note</h2>
  <h1>${escapeHtmlForPrint(data.partyName || 'Unspecified')}</h1>
  <div class="meta">${escapeHtmlForPrint('Date')}: ${data.date}</div>
  <div class="meta">${escapeHtmlForPrint('Note')}: ${escapeHtmlForPrint(data.note)}</div>
  <table>
    <thead><tr><th class="sku-col">${escapeHtmlForPrint('SKU')}</th><th>${escapeHtmlForPrint('Product Name')}</th><th>${escapeHtmlForPrint('Qty')}</th><th>${escapeHtmlForPrint('Unit')}</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
  const printWindow = window.open('', '_blank');
  if(!printWindow){
    showInfoModal(t('errPrintPopupBlocked'));
    return;
  }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.onload = () => {
    printWindow.focus();
    printWindow.print();
  };

  // 「載入」模式下列印,代表這張 Delivery Note 已經真的送出去、完成任務了——之前是直接從資料庫
  // 刪除,現在改成標記 status:'completed' 並保留下來,這樣「歷史紀錄 → Delivery Note紀錄」才能
  // 顯示這筆的完整歷史(已完成/待處理)。「載入」的下拉選單只會列出還沒完成的 Note(見
  // setTxDeliveryFlowType),所以這裡標記完成後不會再被找出來繼續編輯。「新增」模式下列印
  // 本來就沒有存進資料庫過,這裡的判斷式(registerLoadedDeliveryNoteId 有值)天然就只會在
  // 「載入」模式下觸發,「新增」模式列印維持原樣、完全不會留下任何紀錄。
  if(registerLoadedDeliveryNoteId){
    const noteId = registerLoadedDeliveryNoteId;
    const existingNote = deliveryNotes.find(n => n.id === noteId);
    const prevSnapshot = existingNote ? { ...existingNote } : null;
    try{
      if(existingNote){
        Object.assign(existingNote, data); // 存進去的是實際列印出來的最新內容,不是載入當下的舊資料
        existingNote.status = 'completed';
        existingNote.completedAt = new Date().toISOString();
        await upsertDeliveryNotes([existingNote]);
      }
      logInventoryAction('delivery_note', `Printed Delivery Note (${data.date}, ${data.note}) - marked as completed`, null);
    } catch(e){
      console.error('標記 Delivery Note 完成失敗', e);
      if(existingNote && prevSnapshot) Object.assign(existingNote, prevSnapshot); // 存失敗就整份退回原本的樣子
      showInfoModal(t('errDeliveryNotePrintedButNotRemoved'));
    }
    registerDeliveryFlowType = '';
    registerLoadedDeliveryNoteId = null;
    txBatchItems = [];
    const flowSel = document.getElementById('txDeliveryFlowType');
    if(flowSel) flowSel.value = '';
    setTxDeliveryFlowType('');
  }
}

async function submitTxBatchSimple(date, msg){
  const party = document.getElementById('txParty').value.trim();
  const note = document.getElementById('txNote').value.trim();
  const invoiceNo = currentTxType === 'in' ? document.getElementById('txInvoiceNo').value.trim() : '';

  if(txBatchItems.length === 0){ msg.className='msg error'; msg.textContent='請先把至少一項商品加入清單'; return; }
  if(!date){ msg.className='msg error'; msg.textContent='請選擇日期'; return; }

  // 進貨(type='in')的時候,如果這個品項是批量商品、而且開了「自動切換」,不直接加進這個批量
  // 商品自己的庫存,而是依加權數換算成主商品的數量,直接加進主商品的庫存——省掉「先進貨到批量
  // 商品、之後再手動切換」這個中間步驟。換算結果如果不是整數就整批擋下來,不送出任何一筆,
  // 避免主商品庫存出現小數。
  if(currentTxType === 'in'){
    const nonIntegerConversions = txBatchItems
      .map(it => ({ it, p: products.find(pp => pp.id === it.productId) }))
      .filter(({ p }) => p && p.parentId && p.autoConvertOnStockIn)
      .map(({ it, p }) => ({ it, p, parent: products.find(pp => pp.id === p.parentId), weight: p.childWeight || 1, convertedQty: it.qty * (p.childWeight || 1) }))
      .filter(x => !Number.isInteger(x.convertedQty));
    if(nonIntegerConversions.length > 0){
      msg.className = 'msg error';
      msg.textContent = `⚠ ${nonIntegerConversions.map(x => `${x.p.name}: ${tf('errConversionResultNotInteger', { result: x.convertedQty.toLocaleString(undefined, {maximumFractionDigits: 4}), unit: x.parent ? x.parent.unit : '' })}`).join('; ')}`;
      return;
    }
  }

  const purchaseId = currentTxType === 'in' ? genId() : null; // 一整批進貨(不管品項有幾個)共用同一個進貨單 ID

  // 「直接出貨」(currentTxType === 'out')的話,扣庫存之前先問清楚每個商品要從哪個位置扣——
  // 只有商品分布在多個位置(含未分布)時才會真的跳出視窗問,邏輯跟訂單核對、Picking Slip 共用
  // 同一套機制。中途按取消的話直接中止,不會建立任何紀錄。
  let outLocationChoices = null;
  if(currentTxType === 'out'){
    try{
      outLocationChoices = await resolveLocationChoicesForItems(txBatchItems.map(it => ({ productId: it.productId, qty: it.qty })));
    } catch(e){
      return; // 使用者取消了位置選擇,整個提交中止
    }
  }

  const newTxs = txBatchItems.map(it => {
    const p = products.find(pp => pp.id === it.productId);
    if(currentTxType === 'in' && p && p.parentId && p.autoConvertOnStockIn){
      const parent = products.find(pp => pp.id === p.parentId);
      const weight = p.childWeight || 1;
      return {
        id: genId(), productId: p.parentId, type: 'in', qty: it.qty * weight, date, party, invoiceNo, purchaseId,
        note: note ? `${tf('autoConvertStockInNote', { name: p.name, qty: it.qty, unit: p.unit })}${note ? '、' + note : ''}` : tf('autoConvertStockInNote', { name: p.name, qty: it.qty, unit: p.unit })
      };
    }
    return { id: genId(), productId: it.productId, type: currentTxType, qty: it.qty, date, party, note, invoiceNo, purchaseId };
  });
  transactions.push(...newTxs);

  try{
    await insertTransactions(newTxs);
  } catch(e){
    newTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i >= 0) transactions.splice(i, 1); });
    msg.className='msg error'; msg.textContent = '⚠ 提交失敗,請重新整理頁面再試一次。';
    return;
  }

  // 交易確定成功之後才處理位置扣除,避免庫存扣了/位置卻沒對應更新的不一致。
  if(currentTxType === 'out' && outLocationChoices){
    await applyLocationDeductions(outLocationChoices);
  }

  // 進貨(type='in')的話,除了上面照常產生的 transactions(維持庫存計算邏輯不變),同時建立一張
  // 進貨單(purchases)——把這批品項、收據附件包成一份正式文件。原則上還是不強制記單價/金額,
  // 但如果是透過「掃描收據自動帶入」辨識出來的品項,金額(amount 是這個品項在收據上的總金額,
  // 不是單價——auto convert 換算單位時,總花費不會變,單價才會因為單位不同而不同,所以這裡
  // 記的是總額,匯出報表要換算成單價的話用「金額 ÷ 數量」現算即可)會一併記下來、一起匯出。
  //
  // 如果這個品項是批量商品、開了「自動切換」,進貨單裡記的要是換算後的主商品(品名、數量、
  // 單位)——這裡要跟上面 newTxs 那段用一模一樣的換算邏輯,不然匯出的進貨單會顯示批量商品的
  // 數量,跟系統實際入庫的主商品數量對不起來。金額(這批貨總共花多少錢)不會因為換算單位而
  // 改變,原封不動照抄過去就好,匯出報表的單價會自動用「金額 ÷ 換算後數量」現算出正確的值。
  if(currentTxType === 'in'){
    const purchase = {
      id: purchaseId,
      date, partyId: party, partyName: party, invoiceNo, note,
      items: txBatchItems.map(it => {
        const p = products.find(pp => pp.id === it.productId);
        if(p && p.parentId && p.autoConvertOnStockIn){
          const parent = products.find(pp => pp.id === p.parentId);
          const weight = p.childWeight || 1;
          const item = {
            productId: p.parentId, sku: (parent && parent.sku) || '', name: (parent && parent.name) || p.name,
            unit: (parent && parent.unit) || p.unit, qty: it.qty * weight
          };
          if(it.amount) item.amount = it.amount;
          return item;
        }
        const item = { productId: it.productId, sku: it.sku || '', name: it.name, unit: it.unit, qty: it.qty };
        if(it.amount) item.amount = it.amount;
        return item;
      }),
      receiptFiles: pendingPurchaseReceiptFiles.slice(),
      createdAt: new Date().toISOString()
    };
    try{ await upsertPurchase(purchase); purchases.push(purchase); }
    catch(e){ console.error('儲存進貨單失敗', e); }
    removePurchaseReceipt();
    // 這筆用的供應商名稱,如果「進貨方管理」清單裡還沒有(例如是透過「+ 新增供應商」臨時打的
    // 名字),先幫忙建一筆空白的(電話/住址/附註都空著)進去,下次登記進出貨的下拉選單才會
    // 看得到,不用還要特地跑去系統管理那邊補建一次。使用者之後可以再去系統管理補上電話/住址
    // 這些細節資料。
    if(party && !purchaseSuppliers.some(s => s.name.toLowerCase() === party.toLowerCase())){
      const newSupplier = { id: genId(), name: party, phone: '', address: '', note: '' };
      purchaseSuppliers.push(newSupplier);
      try{ await upsertPurchaseSupplier(newSupplier); }
      catch(e){ console.error('自動建立進貨方失敗', e); }
    }
    populateTxPartyHistorySelect(); // 剛剛這筆用的供應商,馬上就會出現在下拉選單裡,不用重新整理頁面

    // 有勾選「寄送給會計」才會寄——寄信失敗不影響這張進貨單本身已經建立成功這件事,只是在畫面上
    // 另外提示寄信失敗,讓使用者知道要去歷史紀錄手動補寄,不會讓人誤以為整張進貨單都沒送出去。
    const emailToggleEl = document.getElementById('purchaseEmailToggle');
    if(emailToggleEl && emailToggleEl.checked){
      const emailAddr = (document.getElementById('purchaseEmailAddress').value || '').trim();
      const ccEl = document.getElementById('purchaseEmailCc');
      const ccAddr = ccEl ? (ccEl.value || '').trim() : (getAccountingEmailToAndCc().cc || '');
      try{
        await sendPurchaseEmail(purchase.id, emailAddr, ccAddr, msg);
      } catch(e){
        console.error('寄送進貨單 email 失敗', e);
        msg.className = 'msg error';
        msg.textContent = `⚠ ${t('errPurchaseSavedButEmailFailed')}`;
      }
      const emailToggleReset = document.getElementById('purchaseEmailToggle');
      if(emailToggleReset){ emailToggleReset.checked = false; togglePurchaseEmailFieldVisibility(emailToggleReset); }
    }
  }

  const count = txBatchItems.length;
  const logActionType = currentTxType === 'in' ? 'tx_in' : 'tx_restock';
  // DETAILS 欄位是登記當下就寫死存進資料庫的文字,不會隨語言切換即時翻譯,所以這裡固定用英文組字串,
  // 不透過 inventoryLogActionLabel()/t() 讀取當前介面語言。
  const LOG_ACTION_EN_LABEL = { tx_in: 'Stock In', tx_restock: 'Restock' };
  const logDesc = `Logged ${LOG_ACTION_EN_LABEL[logActionType] || logActionType}: ${count} item(s)${party ? ', party ' + party : ''}`;
  logInventoryAction(logActionType, logDesc, null);
  txBatchItems = [];
  renderTxBatchList();
  if(currentTxType === 'restock'){ document.getElementById('txParty').value = 'Opulent Imports'; }
  else { document.getElementById('txParty').value = ''; }
  document.getElementById('txNote').value = '';
  document.getElementById('txInvoiceNo').value = '';
  msg.className='msg ok';
  msg.textContent = `✓ 已提交 ${count} 項商品`;
  renderAll();
}

// 出貨→新增訂單:三個按鈕分別對應「併入待處理訂單」(action='pending',不扣庫存)、
// 「併入已完成訂單」(action='completed',直接扣庫存)、「直接出貨」(action='direct',
// 純粹登記一筆出貨,不建立訂單,但備註必填)。前兩者都要跟資料庫序列拿新的訂單編號。
async function submitNewOrderFlow(action, date, msg){
  if(txBatchItems.length === 0){ msg.className='msg error'; msg.textContent=t('errAddAtLeastOneItem'); return; }
  const outPartyId = document.getElementById('txPartySelect').value || null;
  const partyObj = shippingParties.find(sp => sp.id === outPartyId);
  const party = partyObj ? partyObj.name : '';
  const note = document.getElementById('txNote').value.trim();

  if(action === 'direct' && !note){
    showInfoModal(t('errNoteRequiredForDirectShip')); return;
  }

  if(action !== 'pending'){
    // 併入已完成訂單/直接出貨,都是當下就真的扣庫存,先檢查總庫存量夠不夠(批量商品可以拆箱
    // 切換成主商品出貨,所以看總量)。併入待處理訂單不扣庫存,不需要檢查。
    const insufficient = txBatchItems
      .filter(it => it.qty > 0)
      .map(it => ({ ...it, available: computeTotalStock(it.productId) - computePendingReserved(it.productId) }))
      .filter(it => it.qty > it.available);
    if(insufficient.length > 0){
      msg.className = 'msg error';
      msg.textContent = `⚠ ${insufficient.map(it => `「${it.name}」需要 ${it.qty} ${it.unit},庫存剩 ${it.available} ${it.unit}`).join('; ')}`;
      return;
    }
  }

  if(action === 'pending'){
    let orderNo;
    try{ orderNo = await getSafeNextOrderNo(); }
    catch(e){ msg.className='msg error'; msg.textContent='⚠ 取得訂單編號失敗,請重新整理頁面再試一次。'; return; }
    const newOrder = {
      id: genId(), date, note, partyId: outPartyId, partyName: party,
      items: txBatchItems.map(it => ({ productId: it.productId, sku: it.sku||'', name: it.name, unit: it.unit, qty: it.qty })),
      status: 'pending', createdAt: new Date().toISOString(), orderNo
    };
    orders.push(newOrder);
    try{ await upsertOrders([newOrder]); await saveOrderCounter(); }
    catch(e){ orders.pop(); msg.className='msg error'; msg.textContent='⚠ 建立訂單失敗,請重新整理頁面再試一次。'; return; }
    logInventoryAction('order_place', `Created pending order ${orderNo} (${party || 'No recipient specified'}, ${txBatchItems.length} item(s)), stock not yet deducted${note ? `, note: "${note}"` : ''}`, orderNo);
    finishNewOrderSubmit('pending', newOrder.id, txBatchItems.length, orderNo, msg);
    return;
  }

  if(action === 'completed'){
    let orderNo;
    try{ orderNo = await getSafeNextOrderNo(); }
    catch(e){ msg.className='msg error'; msg.textContent='⚠ 取得訂單編號失敗,請重新整理頁面再試一次。'; return; }
    const orderId = genId();
    const newOrder = {
      id: orderId, date, note, partyId: outPartyId, partyName: party,
      items: txBatchItems.map(it => ({ productId: it.productId, sku: it.sku||'', name: it.name, unit: it.unit, qty: it.qty })),
      status: 'confirmed', createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), orderNo
    };
    const newTxs = txBatchItems.map(it => ({
      id: genId(), productId: it.productId, type: it.qty > 0 ? 'out' : 'restock', qty: Math.abs(it.qty), date, party,
      note: orderNo, system: true, orderId
    }));
    transactions.push(...newTxs);
    orders.push(newOrder);
    txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId]||0) - it.qty; });
    try{
      await insertTransactions(newTxs);
      await upsertOrders([newOrder]);
      await saveOrderCounter();
    } catch(e){
      newTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i>=0) transactions.splice(i,1); });
      orders.pop();
      txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId]||0) + it.qty; });
      msg.className='msg error'; msg.textContent='⚠ 建立訂單失敗,請重新整理頁面再試一次。'; return;
    }
    logInventoryAction('order_place', `Created completed order ${orderNo} (${party || 'No recipient specified'}, ${txBatchItems.length} item(s)), stock deducted${note ? `, note: "${note}"` : ''}`, orderNo);
    finishNewOrderSubmit('completed', orderId, txBatchItems.length, orderNo, msg);
    return;
  }

  if(action === 'direct'){
    const newTxs = txBatchItems.map(it => ({
      id: genId(), productId: it.productId, type: it.qty > 0 ? 'out' : 'restock', qty: Math.abs(it.qty), date, party, note
    }));
    transactions.push(...newTxs);
    txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId]||0) - it.qty; });
    try{ await insertTransactions(newTxs); }
    catch(e){
      newTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i>=0) transactions.splice(i,1); });
      txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId]||0) + it.qty; });
      msg.className='msg error'; msg.textContent='⚠ 提交失敗,請重新整理頁面再試一次。'; return;
    }
    logInventoryAction('tx_out', `Logged direct shipment: ${txBatchItems.length} item(s), party ${party || 'unspecified'}, note: "${note}"`, null);
    const count = txBatchItems.length;
    txBatchItems = [];
    resetRegisterOutFlow();
    setTxOutFlowType('');
    document.getElementById('txPartySelect').value = '';
    document.getElementById('txNote').value = '';
    msg.className='msg ok'; msg.textContent = `✓ 已直接出貨 ${count} 項商品`;
    renderAll();
  }
}

function finishNewOrderSubmit(kind, orderId, count, orderNo, msg){
  txBatchItems = [];
  resetRegisterOutFlow();
  setTxOutFlowType('');
  switchTab('tab-order-admin');
  switchOrderAdminSubTab(kind === 'pending' ? 'subtab-order-pending' : 'subtab-order-completed');
  expandedOrderIds.add(orderId);
  renderAll();
  showInfoModal(tf('addToOrderSuccessMsg', { orderNo: orderNo || orderId, n: count }));
}

// 出貨→載入現有待處理訂單。備註是訂單本身的欄位,直接更新;新增的品項(如果有)透過既有的
// mergeItemsIntoOrderCore 併入草稿,不扣庫存。三個按鈕:儲存(存完跳回清單)、載入訂單核對
// (導去訂單核對頁面,沿用原本邏輯)、直接核對(不經過比對畫面,直接用訂單自己的品項核對,
// 也是沿用原本 verifyOrder() 的邏輯)。
// 確認視窗裡「新增商品」的明細:把每一項要新增的商品名稱、數量都列出來,不是只顯示一個籠統的
// 項目數(例如「新增 3 項商品」),讓使用者存檔前能明確看到到底加了什麼、加了多少。
function formatNewItemsSummary(items){
  const lines = items.map(it => `  ${it.name}: ${it.qty} ${it.unit}`);
  return t('changeSummaryNewItemsHeader') + '\n' + lines.join('\n');
}

// 確認視窗裡「改數量」的明細:每一項都明確列出商品名稱、從多少改成多少。
function formatQtyChangesSummary(pendingQtyChanges){
  const lines = pendingQtyChanges.map(({item, newQty}) => `  ${item.name}: ${item.qty} → ${newQty} ${item.unit}`);
  return t('changeSummaryQtyChangesHeader') + '\n' + lines.join('\n');
}

// 確認視窗裡「刪除商品」的明細:每一項都明確列出商品名稱跟數量。
function formatDeletesSummary(pendingDeletes){
  const lines = pendingDeletes.map(item => `  ${item.name}: ${item.qty} ${item.unit}`);
  return t('changeSummaryDeletesHeader') + '\n' + lines.join('\n');
}

// 把 registerPendingItemChanges 這個暫存區,對照訂單目前的品項,整理成兩份清單:
// 要改數量的(帶著原本的 item 物件參照跟新數量)、要刪除的(帶著原本的 item 物件參照)。
// 暫存區裡如果有指向「已經不在訂單裡」的 productId(理論上不該發生,防呆用)會直接忽略。
function collectPendingItemChanges(order){
  const pendingQtyChanges = [];
  const pendingDeletes = [];
  Object.keys(registerPendingItemChanges).forEach(productId => {
    const change = registerPendingItemChanges[productId];
    const item = order.items.find(it => it.productId === productId && !it.deleted);
    if(!item) return;
    if(change.type === 'delete') pendingDeletes.push(item);
    else if(change.type === 'qty') pendingQtyChanges.push({ item, newQty: change.newQty });
  });
  return { pendingQtyChanges, pendingDeletes };
}

async function submitLoadPendingFlow(action, msg){
  if(!registerLoadedOrderId){ msg.className='msg error'; msg.textContent=t('errSelectOrderFirst'); return; }
  const orderId = registerLoadedOrderId;
  const order = orders.find(o => o.id === orderId);
  if(!order){ msg.className='msg error'; msg.textContent=`⚠ ${t('errOrderNoLongerEditable')}`; return; }

  const dateInput = document.getElementById('txDate');
  const newDate = dateInput ? dateInput.value : order.date;
  const noteInput = document.getElementById('txNote');
  const newNote = noteInput ? noteInput.value.trim() : (order.note || '');
  const { pendingQtyChanges, pendingDeletes } = collectPendingItemChanges(order);

  const changes = [];
  if(newDate && newDate !== order.date) changes.push(tf('changeSummaryDate', { old: order.date || '', new: newDate }));
  if(newNote !== (order.note || '')) changes.push(t('changeSummaryNote'));
  if(pendingQtyChanges.length > 0) changes.push(formatQtyChangesSummary(pendingQtyChanges));
  if(pendingDeletes.length > 0) changes.push(formatDeletesSummary(pendingDeletes));
  if(txBatchItems.length > 0) changes.push(formatNewItemsSummary(txBatchItems));

  const doSave = async () => {
    const dateChanged = newDate && newDate !== order.date;
    const noteChanged = newNote !== (order.note || '');
    const oldDateForLog = order.date;
    const oldNoteForLog = order.note || '';
    if(dateChanged){
      if(order.originalDate === undefined || order.originalDate === null) order.originalDate = order.date;
      order.date = newDate;
    }
    order.note = newNote;
    // 日期/備註的異動之前沒有寫進後台紀錄——改數量、刪除品項都有記,但改日期/備註卻沒有,
    // 這裡補上,確保訂單只要有異動都查得到。
    if(dateChanged || noteChanged){
      const parts = [];
      if(dateChanged) parts.push(`date ${oldDateForLog || ''}→${newDate}`);
      if(noteChanged) parts.push(`note: "${oldNoteForLog}" → "${newNote}"`);
      logInventoryAction('order_edit', `Pending order ${order.orderNo || order.id} - ${parts.join(', ')}`, order.orderNo);
    }

    // 套用暫存的改數量(待處理訂單不影響庫存,單純改 order.items 上的數字跟異動紀錄)。
    // 訂單如果已經是「處理中」(picking slip 印過了),這些異動也要記進「核對後變更」,
    // 跟直接在待處理訂單清單上改是同一套邏輯(見 savePendingOrderItemQty)。
    const isProcessing = orderStatus(order) === 'processing';
    pendingQtyChanges.forEach(({ item, newQty }) => {
      const oldQty = item.qty;
      item.qty = newQty;
      if(!item.qtyHistory) item.qtyHistory = [];
      const changeAt = new Date().toISOString();
      item.qtyHistory.push({ from: oldQty, to: newQty, at: changeAt });
      if(isProcessing){
        if(!order.postVerifyChanges) order.postVerifyChanges = [];
        order.postVerifyChanges.push({ kind: 'qty', productId: item.productId, name: item.name, sku: item.sku, unit: item.unit, from: oldQty, to: newQty, at: changeAt });
      }
      logInventoryAction('order_edit', `Pending order ${order.orderNo || order.id} - quantity adjusted: ${item.name} ${oldQty}→${newQty} ${item.unit} (not yet stocked out)`, order.orderNo);
    });
    // 套用暫存的刪除(軟刪除,一樣不影響庫存)。
    const now = new Date().toISOString();
    pendingDeletes.forEach(item => {
      item.deleted = true;
      item.deletedAt = now;
      if(isProcessing){
        if(!order.postVerifyChanges) order.postVerifyChanges = [];
        order.postVerifyChanges.push({ kind: 'deleted', productId: item.productId, name: item.name, sku: item.sku, unit: item.unit, qty: item.qty, at: now });
      }
      logInventoryAction('order_edit', `Pending order ${order.orderNo || order.id} - removed item: ${item.name} ${item.qty} ${item.unit}`, order.orderNo);
    });
    if(order.items.length > 0 && order.items.every(it => it.deleted)){
      order.deleted = true;
      order.deletedAt = now;
    }
    registerPendingItemChanges = {};

    if(txBatchItems.length > 0){
      const newItems = txBatchItems.map(it => ({ productId: it.productId, sku: it.sku||'', name: it.name, unit: it.unit, qty: it.qty }));
      const result = await mergeItemsIntoOrderCore(orderId, newItems);
      if(!result.ok){
        msg.className='msg error';
        msg.textContent = result.reason === 'not_editable' ? `⚠ ${t('errOrderNoLongerEditable')}` : '⚠ 新增商品失敗,請重新整理頁面再試一次。';
        return;
      }
    } else {
      try{ await upsertOrders([order]); } catch(e){ console.error('儲存備註/日期/品項失敗', e); }
    }

    if(action === 'save-pending'){
      resetRegisterOutFlow();
      setTxOutFlowType('');
      switchTab('tab-order-admin');
      switchOrderAdminSubTab('subtab-order-pending');
      expandedOrderIds.add(orderId);
      renderAll();
      msg.className='msg ok'; msg.textContent='✓ 已儲存';
      return;
    }
    if(action === 'load-verify'){
      resetRegisterOutFlow();
      setTxOutFlowType('');
      openOrderInVerifyPage(orderId);
      return;
    }
  };

  // 有任何異動(日期/備註/改數量/刪除/新增商品)才跳確認視窗,列出具體改了哪些地方;完全沒改的話
  // 直接照原本動作繼續(例如單純按「載入訂單核對頁面」查看,不用為了「沒有異動」還跳一次確認)。
  if(changes.length > 0){
    showConfirmModal(tf('confirmSaveOrderChangesMsg', { changes: changes.join('\n\n') }), doSave);
  } else {
    await doSave();
  }
}

// 出貨→載入現有已完成訂單。備註是訂單本身欄位直接更新;新增的品項(如果有)透過
// mergeItemsIntoCompletedOrderCore 併入,會真的扣/加庫存,而且每一項都會記進「核對後變更」清單。
// 只有一個「儲存」按鈕,存完跳回已完成訂單清單。
async function submitLoadCompletedFlow(date, msg){
  if(!registerLoadedOrderId){ msg.className='msg error'; msg.textContent=t('errSelectOrderFirst'); return; }
  const orderId = registerLoadedOrderId;
  const order = orders.find(o => o.id === orderId);
  if(!order){ msg.className='msg error'; msg.textContent=`⚠ ${t('errOrderNoLongerEditable')}`; return; }
  const outPartyId = document.getElementById('txPartySelect').value || null;
  const partyObj = shippingParties.find(sp => sp.id === outPartyId);
  const party = partyObj ? partyObj.name : (order.partyName || '');
  const noteInput = document.getElementById('txNote');
  const noteVal = noteInput ? noteInput.value.trim() : '';
  const { pendingQtyChanges, pendingDeletes } = collectPendingItemChanges(order);

  // 已完成訂單的「改數量」會真的動庫存,送出前先在前端檢查每一筆「增加數量」是否有足夠庫存——
  // 這樣才不會等到確認視窗按下確定、開始逐筆呼叫 RPC 之後才發現某一筆不夠,變成一半套用成功、
  // 一半失敗的尷尬狀態。減少數量/刪除不會有庫存不夠的問題,不用檢查。
  const insufficientQtyChanges = pendingQtyChanges
    .filter(({ item, newQty }) => newQty > item.qty)
    .map(({ item, newQty }) => ({ item, newQty, delta: newQty - item.qty, available: computeTotalStock(item.productId) - computePendingReserved(item.productId) }))
    .filter(x => x.delta > x.available);
  if(insufficientQtyChanges.length > 0){
    msg.className = 'msg error';
    msg.textContent = `⚠ ${insufficientQtyChanges.map(x => `「${x.item.name}」需要再增加 ${x.delta} ${x.item.unit},庫存剩 ${x.available} ${x.item.unit}`).join('; ')}`;
    return;
  }

  const changes = [];
  if(date && date !== order.date) changes.push(tf('changeSummaryDate', { old: order.date || '', new: date }));
  if(noteVal !== (order.note || '')) changes.push(t('changeSummaryNote'));
  if(pendingQtyChanges.length > 0) changes.push(formatQtyChangesSummary(pendingQtyChanges));
  if(pendingDeletes.length > 0) changes.push(formatDeletesSummary(pendingDeletes));
  if(txBatchItems.length > 0) changes.push(formatNewItemsSummary(txBatchItems));

  const doSave = async () => {
    const dateChanged = date && date !== order.date;
    const noteChanged = noteVal !== (order.note || '');
    const oldDateForLog = order.date;
    const oldNoteForLog = order.note || '';
    if(dateChanged){
      if(order.originalDate === undefined || order.originalDate === null) order.originalDate = order.date;
      order.date = date;
    }
    order.note = noteVal;
    // 日期/備註的異動之前沒有寫進後台紀錄——改數量、刪除品項都有記,但改日期/備註卻沒有,
    // 這裡補上,確保訂單只要有異動都查得到。
    if(dateChanged || noteChanged){
      const parts = [];
      if(dateChanged) parts.push(`date ${oldDateForLog || ''}→${date}`);
      if(noteChanged) parts.push(`note: "${oldNoteForLog}" → "${noteVal}"`);
      logInventoryAction('order_edit', `Order ${order.orderNo || order.id} - ${parts.join(', ')}`, order.orderNo);
    }

    // 依序套用每一筆暫存的改數量,呼叫跟原本「改數量」一樣的 adjust_order_item_qty RPC
    // (原子化、伺服器端會再驗證一次庫存)。前面已經先做過前端庫存檢查,這裡理論上不太會失敗,
    // 但還是要處理伺服器端拒絕的情況(例如同時間有其他人也在操作庫存)——一旦有一筆失敗就
    // 停下來,已經成功套用的部分維持不動(不嘗試整批復原,因為那些已經是真的寫進資料庫的操作)。
    // 這批「暫存的改數量」裡,凡是要增加數量(等於補出貨、要多扣庫存)的品項,商品分布在多個
    // 位置的話,送出前先一次問清楚每一筆各自要從哪裡扣——邏輯跟一般改數量、訂單核對共用同一套
    // 機制。減少數量不用問,退回的庫存一律先算未分布。中途取消的話這裡整個 doSave 直接中止,
    // 不會呼叫任何 RPC、也不會動任何位置或庫存資料。
    const increaseChanges = pendingQtyChanges.filter(({ item, newQty }) => newQty > item.qty);
    let qtyChangeAllocationsByProductId = {};
    if(increaseChanges.length > 0){
      try{
        const resolved = await resolveLocationChoicesForItems(increaseChanges.map(({ item, newQty }) => ({ productId: item.productId, qty: newQty - item.qty })));
        resolved.forEach(r => { qtyChangeAllocationsByProductId[r.productId] = r.allocations; });
      } catch(e){
        return; // 使用者取消了位置選擇,整個儲存動作中止
      }
    }

    for(const { item, newQty } of pendingQtyChanges){
      const oldQty = item.qty;
      const txId = genId();
      const noteText = tf('orderItemQtyChangedNote', { orderNo: order.orderNo || '', name: item.name, oldQty, newQty, unit: item.unit });
      const { error } = await sb.rpc('adjust_order_item_qty', {
        p_order_id: order.id, p_product_id: item.productId, p_new_qty: newQty,
        p_tx_id: txId, p_date: todayISO(), p_note: noteText
      });
      if(error){
        const failures = parseInsufficientStockError(error);
        msg.className = 'msg error';
        msg.textContent = failures && failures[0]
          ? tf('errAdjustQtyInsufficientStock', { name: item.name, available: failures[0].available, requested: failures[0].requested })
          : t('errAdjustQtyGeneric');
        registerPendingItemChanges = {};
        renderTxExistingItems();
        renderAll();
        return;
      }
      const qtyDelta = newQty - oldQty;
      const tx = { id: txId, productId: item.productId, type: qtyDelta > 0 ? 'out' : 'restock', qty: Math.abs(qtyDelta), date: todayISO(), party: order.partyName || '', note: noteText, system: true, orderId: order.id };
      transactions.push(tx);
      productStockMap[item.productId] = (productStockMap[item.productId] || 0) - qtyDelta;
      // 伺服器那邊已經確定扣庫存成功了,這裡才去動 product_locations,避免庫存扣了/位置卻沒
      // 對應更新的不一致。
      if(qtyChangeAllocationsByProductId[item.productId]){
        await applyLocationDeductions([{ productId: item.productId, qty: qtyDelta, allocations: qtyChangeAllocationsByProductId[item.productId] }]);
      }
      item.qty = newQty;
      if(!item.qtyHistory) item.qtyHistory = [];
      const qtyChangeAt = new Date().toISOString();
      item.qtyHistory.push({ from: oldQty, to: newQty, at: qtyChangeAt });
      if(!order.postVerifyChanges) order.postVerifyChanges = [];
      order.postVerifyChanges.push({ kind: 'qty', productId: item.productId, name: item.name, sku: item.sku, unit: item.unit, from: oldQty, to: newQty, at: qtyChangeAt });
      logInventoryAction('order_edit', `Order ${order.orderNo || order.id} - quantity adjusted after verification: ${item.name} ${oldQty}→${newQty} ${item.unit}`, order.orderNo);
    }

    // 依序套用每一筆暫存的刪除:退回庫存(補一筆 restock 交易紀錄),軟刪除品項。
    const now = new Date().toISOString();
    for(const item of pendingDeletes){
      try{
        const txId = genId();
        const isRestockItem = item.qty < 0;
        const noteText = tf('orderItemDeletedRestockNote', { orderNo: order.orderNo || order.id, name: item.name, qty: Math.abs(item.qty), unit: item.unit });
        const tx = { id: txId, productId: item.productId, type: isRestockItem ? 'out' : 'restock', qty: Math.abs(item.qty), date: todayISO(), party: order.partyName || '', note: noteText, system: true, orderId: order.id };
        transactions.push(tx);
        productStockMap[item.productId] = (productStockMap[item.productId] || 0) + item.qty;
        await insertTransactions([tx]);
      } catch(e){
        console.error('刪除品項失敗', e);
        // 剛剛的樂觀更新(push transaction、加回 productStockMap)因為實際寫入失敗,要回滾掉,
        // 不然畫面上的庫存數字會跟資料庫不一致。
        const idx = transactions.indexOf(tx);
        if(idx >= 0) transactions.splice(idx, 1);
        productStockMap[item.productId] = (productStockMap[item.productId] || 0) - item.qty;
        msg.className = 'msg error';
        msg.textContent = '⚠ 操作失敗,請重新整理頁面再試一次。';
        registerPendingItemChanges = {};
        renderTxExistingItems();
        renderAll();
        return;
      }
      if(!order.postVerifyChanges) order.postVerifyChanges = [];
      order.postVerifyChanges.push({ kind: 'deleted', productId: item.productId, name: item.name, sku: item.sku, unit: item.unit, qty: item.qty, at: new Date().toISOString() });
      item.deleted = true;
      item.deletedAt = now;
      item.deleteStockStatus = 'stocked_out';
      logInventoryAction('order_edit', `Order ${order.orderNo || order.id} - removed item after verification: ${item.name} ${item.qty} ${item.unit}`, order.orderNo);
    }
    if(order.items.length > 0 && order.items.every(it => it.deleted)){
      order.deleted = true;
      order.deletedAt = now;
    }
    registerPendingItemChanges = {};

    if(txBatchItems.length > 0){
      const insufficient = txBatchItems
        .filter(it => it.qty > 0)
        .map(it => ({ ...it, available: computeTotalStock(it.productId) - computePendingReserved(it.productId) }))
        .filter(it => it.qty > it.available);
      if(insufficient.length > 0){
        msg.className = 'msg error';
        msg.textContent = `⚠ ${insufficient.map(it => `「${it.name}」需要 ${it.qty} ${it.unit},庫存剩 ${it.available} ${it.unit}`).join('; ')}`;
        return;
      }
      const batchItems = txBatchItems.map(it => ({ productId: it.productId, sku: it.sku||'', name: it.name, unit: it.unit, qty: it.qty }));
      const result = await mergeItemsIntoCompletedOrderCore(orderId, batchItems, date, party);
      if(!result.ok){
        msg.className = 'msg error';
        msg.textContent = result.reason === 'not_editable' ? `⚠ ${t('errOrderNoLongerEditable')}`
          : result.reason === 'duplicate' ? `⚠ ${t('errProductAlreadyInOrder')}`
          : '⚠ 新增商品失敗,請重新整理頁面再試一次。';
        return;
      }
    } else {
      try{ await upsertOrders([order]); } catch(e){ console.error('儲存備註/日期/品項失敗', e); }
    }

    resetRegisterOutFlow();
    setTxOutFlowType('');
    switchTab('tab-order-admin');
    switchOrderAdminSubTab('subtab-order-completed');
    expandedOrderIds.add(orderId);
    renderAll();
    msg.className='msg ok'; msg.textContent='✓ 已儲存';
  };

  // 有任何異動(日期/備註/改數量/刪除/新增商品)才跳確認視窗,列出具體改了哪些地方;完全沒改的話
  // 直接存檔,不用為了「沒有異動」還跳一次確認。
  if(changes.length > 0){
    showConfirmModal(tf('confirmSaveOrderChangesMsg', { changes: changes.join('\n\n') }), doSave);
  } else {
    await doSave();
  }
}

// 出貨→庫存調整:不建立訂單、不需要出貨方,單純是庫存數字校正。備註必填,送出前跳警示視窗
// 再次確認(因為會直接扣/加庫存,沒有訂單流程當中間的緩衝)。
async function submitAdjustmentFlow(date, msg){
  if(txBatchItems.length === 0){ msg.className='msg error'; msg.textContent=t('errAddAtLeastOneItem'); return; }
  const note = document.getElementById('txNote').value.trim();
  if(!note){ msg.className='msg error'; msg.textContent=t('errNoteRequiredForAdjustment'); return; }

  showConfirmModal(t('confirmStockAdjustment'), async () => {
    // 庫存調整裡「減少」的品項(qty > 0,實際是 type='out')扣庫存之前,一樣先問清楚要從哪個
    // 位置扣——「增加」的品項(qty < 0,type='restock')不用問,新增的庫存一律先算未分布。
    const decreaseItems = txBatchItems.filter(it => it.qty > 0);
    let adjustmentLocationChoices = null;
    if(decreaseItems.length > 0){
      try{
        adjustmentLocationChoices = await resolveLocationChoicesForItems(decreaseItems.map(it => ({ productId: it.productId, qty: it.qty })));
      } catch(e){
        return; // 使用者取消了位置選擇,整個提交中止
      }
    }

    const newTxs = txBatchItems.map(it => ({
      id: genId(), productId: it.productId, type: it.qty > 0 ? 'out' : 'restock', qty: Math.abs(it.qty), date, party: '', note: `${t('adjustmentNotePrefix')}${note}`
    }));
    transactions.push(...newTxs);
    txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId]||0) - it.qty; });
    try{ await insertTransactions(newTxs); }
    catch(e){
      newTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i>=0) transactions.splice(i,1); });
      txBatchItems.forEach(it => { productStockMap[it.productId] = (productStockMap[it.productId]||0) + it.qty; });
      msg.className='msg error'; msg.textContent='⚠ 提交失敗,請重新整理頁面再試一次。'; return;
    }
    // 交易確定成功之後才處理位置扣除,避免庫存扣了/位置卻沒對應更新的不一致。
    if(adjustmentLocationChoices){
      await applyLocationDeductions(adjustmentLocationChoices);
    }
    logInventoryAction('tx_out', `Logged stock adjustment: ${txBatchItems.length} item(s) — ${note}`, null);
    const count = txBatchItems.length;
    // 提交完之後留在「庫存調整」這個頂層類型上,方便連續登記好幾筆調整——只清空這次的品項清單
    // 跟備註,不去動出貨方欄位隱藏/兩欄版面這些跟「庫存調整」綁在一起的畫面設定(那些是
    // setTxType('adjustment') 負責的,不需要在這裡重複呼叫或退回舊的出貨流程邏輯)。renderAll()
    // 本身就會重新渲染 txSubmitArea/txBatchList/productSelect,不用在這裡另外呼叫。
    txBatchItems = [];
    document.getElementById('txNote').value = '';
    msg.className='msg ok'; msg.textContent = `✓ 已提交庫存調整,共 ${count} 項商品`;
    renderAll();
  });
}

// 直接從「進出貨紀錄」刪除一筆紀錄時,如果這筆紀錄是某張已完成訂單的一部分(有 orderId),
// 這裡會統一把對應訂單裡的那個品項也標註為已刪除(跟「已完成訂單→刪除訂單商品→未出庫」是一樣的
// 結果:紀錄整筆消失、庫存退回),讓訂單清單跟進出貨紀錄保持同步。如果訂單裡的商品全部都被
// 標成已刪除,訂單本身也一併標註為已刪除(軟刪除),但仍保留在紀錄裡。
async function markOrderItemsDeletedFromTxRemoval(removedTxs){
  if(!removedTxs || removedTxs.length === 0) return;
  const now = new Date().toISOString();
  const affectedOrders = new Map();
  removedTxs.forEach(tx => {
    if(!tx.orderId) return;
    const order = orders.find(o => o.id === tx.orderId);
    if(!order) return;
    const item = order.items.find(it => it.productId === tx.productId && !it.deleted);
    if(item){
      item.deleted = true;
      item.deletedAt = now;
      item.deleteStockStatus = 'in_stock';
      affectedOrders.set(order.id, order);
    }
  });
  affectedOrders.forEach(order => {
    if(!order.deleted && order.items.every(it => it.deleted)){
      order.deleted = true;
      order.deletedAt = now;
      expandedOrderIds.delete(order.id);
    }
  });
  if(affectedOrders.size > 0){
    await upsertOrders([...affectedOrders.values()]);
  }
}

// 把一批要刪除的交易紀錄裡,跟已完成訂單有關的那幾筆抓出來,取得它們對應的訂單號(去重複)。
function orderNosForTxList(txList){
  const nos = new Set();
  txList.forEach(tx => {
    if(!tx.orderId) return;
    const order = orders.find(o => o.id === tx.orderId);
    nos.add(order && order.orderNo ? order.orderNo : tx.orderId);
  });
  return [...nos];
}

// 這筆進出貨紀錄是不是跟「已簽收」的訂單有關(靠 orderId 對回 orders 找那張訂單的簽收狀態)。
// 已簽收訂單的所有相關紀錄都要鎖住,不能編輯、也不能刪除,只能疊加新增附註。
// 進出貨紀錄的每一筆都是既成事實的異動紀錄,不能編輯、不能刪除,只能疊加新增附註
// (見 startAppendNoteToTx / saveAppendNoteToTx)——這個函式仍保留給其他地方參考「這筆紀錄
// 是不是跟已簽收訂單有關」,但編輯/刪除本身已經沒有任何 UI 入口會呼叫到了。
function isTxLinkedToSignedOrder(tx){
  if(!tx.orderId) return false;
  const order = orders.find(o => o.id === tx.orderId);
  return !!(order && order.signedAt);
}

// 併入「已完成訂單」相關(從登記進出貨→出貨→載入已完成訂單這個子流程呼叫,見
// submitLoadCompletedFlow)
// 併入「已完成訂單」(會真的扣/加庫存):針對這批品項各自建一筆進出貨紀錄(連結這張訂單的
// orderId),並把品項併進訂單的 items 清單。每一項各自依「自己的數量正負號」決定方向——正數是
// 出貨(扣庫存),負數是入庫/退貨(加庫存),不是整批共用同一個類型,因為現在同一批裡可以同時有
// 要出貨的商品跟要入庫的商品。item.qty 統一存成「正=出貨、負=入庫」的淨值,跟已完成訂單
// 「改數量」用的是同一套慣例。呼叫前應該已經檢查過出貨數量沒有超過庫存。
// 同一項商品如果已經在這張訂單裡,直接擋下來請使用者從這批清單移除,不嘗試自動合併,避免
// 複雜的加總邏輯藏著算錯的風險。
async function mergeItemsIntoCompletedOrderCore(orderId, batchItems, date, party){
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted || orderStatus(order) !== 'confirmed' || order.signedAt){
    return { ok: false, reason: 'not_editable' };
  }
  const dup = batchItems.find(bIt => order.items.some(it => it.productId === bIt.productId && !it.deleted));
  if(dup){
    return { ok: false, reason: 'duplicate', productName: dup.name };
  }

  const newTxs = batchItems.map(it => ({
    id: genId(), productId: it.productId, type: it.qty > 0 ? 'out' : 'restock', qty: Math.abs(it.qty), date, party,
    // 這張訂單本身有訂單號,交易記錄的備註只要放訂單號就能追溯回這張訂單、看到 order.note 裡的
    // 完整備註內容,不需要把使用者打的備註也重複塞進每一筆交易記錄裡。
    note: order.orderNo || orderId,
    system: true, orderId
  }));

  const prevItems = order.items;
  const newOrderItems = batchItems.map(it => ({
    productId: it.productId, sku: it.sku || '', name: it.name, unit: it.unit,
    qty: it.qty,
    qtyHistory: [{ added: true, at: new Date().toISOString(), qty: it.qty }]
  }));
  order.items = [...prevItems, ...newOrderItems];

  const prevPostVerifyChanges = order.postVerifyChanges ? [...order.postVerifyChanges] : [];
  if(!order.postVerifyChanges) order.postVerifyChanges = [];
  batchItems.forEach(it => {
    order.postVerifyChanges.push({ kind: 'added', productId: it.productId, name: it.name, sku: it.sku, unit: it.unit, qty: it.qty, at: new Date().toISOString() });
  });

  transactions.push(...newTxs);
  batchItems.forEach(it => {
    productStockMap[it.productId] = (productStockMap[it.productId] || 0) - it.qty;
  });

  try{
    await insertTransactions(newTxs);
    await upsertOrders([order]);
  } catch(e){
    newTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i >= 0) transactions.splice(i, 1); });
    order.items = prevItems;
    order.postVerifyChanges = prevPostVerifyChanges;
    batchItems.forEach(it => {
      productStockMap[it.productId] = (productStockMap[it.productId] || 0) + it.qty;
    });
    console.error('新增商品到已完成訂單失敗', e);
    return { ok: false, reason: 'save_failed' };
  }

  logInventoryAction('order_edit', `Order ${order.orderNo || orderId} - added after verification: ${batchItems.map(it => `${it.name} ${it.qty} ${it.unit}`).join(', ')}`, order.orderNo);
  return { ok: true, order };
}

// 登記進出貨的 Excel 匯入,可以一次選多個檔案——這幾個函式管理那份待匯入的檔案清單
// (fileKey() 這個小工具在 product-master.js,商品主檔匯入的 addMasterFiles 也共用同一份)
function addTxFiles(fileList){
  const newFiles = Array.from(fileList);
  const existingKeys = new Set(pendingTxFiles.map(fileKey));
  newFiles.forEach(f => {
    if(!existingKeys.has(fileKey(f))) pendingTxFiles.push(f);
  });
  document.getElementById('txImportFile').value = '';
  renderTxFileList();
}

function removeTxFile(index){
  pendingTxFiles.splice(index, 1);
  renderTxFileList();
}

function renderTxFileList(){
  const container = document.getElementById('txFileList');
  if(pendingTxFiles.length === 0){ container.innerHTML = ''; return; }
  container.innerHTML = pendingTxFiles.map((f, i) => `
    <span class="file-chip">${f.name}<button onclick="removeTxFile(${i})" title="移除">✕</button></span>
  `).join('');
}
