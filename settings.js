// ============================================================
// 系統設置——自動備份(排程/執行/選資料夾/從資料夾還原)、完整
// 資料備份/還原(匯出/匯入 JSON 備份檔,原本在主程式,併過來跟
// 自動備份放一起,備份相關的東西不再分散兩處)、清除全部資料/
// 重置後台紀錄跟訂單編號、會計 Email 清單、Stock Location 模式/
// 列印設定、商品排序、已完成訂單匯出格式、multipack 相關開關等
// 系統設置分頁裡的各種讀取/存檔/切換函式。
// ============================================================

// 資料異動時,等待短暫靜止期後自動備份一次,
// 避免連續操作(例如連續增減庫存)時每次都觸發。
function scheduleAutoBackup(){
  if(!autoBackupEnabled) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(runAutoBackup, 2500);
}

function todayBackupFilename(){
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return `stock_ledger_backup_${dateStr}.json`;
}

async function runAutoBackup(){
  const filename = todayBackupFilename();
  const backup = {
    exportedAt: new Date().toISOString(),
    version: 4,
    products,
    transactions,
    orders,
    shippingParties,
    categoryOrder
  };
  const content = JSON.stringify(backup, null, 2);

  if(backupDirHandle){
    try{
      // 已授權資料夾:同一天的檔名一樣,每次會直接覆蓋,不會跳出任何視窗。
      const fileHandle = await backupDirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      lastAutoBackupAt = new Date();
      lastAutoBackupMode = 'folder';
      updateAutoBackupStatus();
      return;
    } catch(e){
      console.error('寫入備份資料夾失敗,改用下載模式', e);
      // 授權可能過期或被撤銷,清掉 handle 讓使用者重新選擇
      backupDirHandle = null;
    }
  }

  // 備援:沒有(或失去)資料夾授權時,退回瀏覽器下載。
  // 注意:同一天內多次下載,瀏覽器通常會自動加上 (1)(2) 等尾碼,無法真正覆蓋同一份檔案。
  try{
    downloadFile(filename, content, 'application/json');
    lastAutoBackupAt = new Date();
    lastAutoBackupMode = 'download';
  } catch(e){ console.error('自動備份下載失敗', e); }
  updateAutoBackupStatus();
}

async function chooseBackupFolder(){
  if(!window.showDirectoryPicker){
    backupDirHandle = null;
    lastAutoBackupMode = 'unsupported';
    updateAutoBackupStatus();
    alert('這個瀏覽器(或目前的執行環境)不支援直接選擇資料夾寫入,將維持一般下載模式。建議改用電腦版 Chrome 或 Edge 試試看。');
    return;
  }
  try{
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    backupDirHandle = handle;
    lastAutoBackupMode = 'folder';
    updateAutoBackupStatus();
  } catch(e){
    // 使用者取消選擇,或環境(例如沙盒 iframe)直接擋掉這個功能
    console.error('選擇備份資料夾失敗', e);
    if(e && e.name !== 'AbortError'){
      alert('無法取得資料夾存取權限(目前的瀏覽環境可能限制此功能),將維持一般下載模式作為備援。');
    }
  }
}

// 從一個資料夾控制代碼裡,找出檔名符合 stock_ledger_backup_YYYY-MM-DD.json 格式、日期最新的一份。
async function findLatestBackupInFolder(dirHandle){
  const pattern = /^stock_ledger_backup_(\d{4}-\d{2}-\d{2})\.json$/;
  let latestName = null;
  let latestDate = null;
  for await (const [name, handle] of dirHandle.entries()){
    if(handle.kind !== 'file') continue;
    const m = name.match(pattern);
    if(!m) continue;
    if(!latestDate || m[1] > latestDate){
      latestDate = m[1];
      latestName = name;
    }
  }
  if(!latestName) return null;
  const fileHandle = await dirHandle.getFileHandle(latestName);
  const file = await fileHandle.getFile();
  const text = await file.text();
  return { filename: latestName, text };
}

async function restoreFromBackupFolder(){
  const msg = document.getElementById('backupMsg');
  if(!window.showDirectoryPicker){
    msg.className = 'msg error';
    msg.textContent = '這個瀏覽器(或目前的執行環境)不支援直接讀取資料夾,請改用上面「選擇備份檔」手動選 .json 檔案還原。';
    return;
  }
  let dirHandle = backupDirHandle;
  try{
    // 如果本次還沒選過資料夾(例如剛重新整理頁面),請使用者重新授權一次。
    if(!dirHandle){
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    }
  } catch(e){
    if(e && e.name !== 'AbortError'){
      msg.className = 'msg error';
      msg.textContent = '無法取得資料夾存取權限(目前的瀏覽環境可能限制此功能)。';
    }
    return;
  }

  let found;
  try{
    found = await findLatestBackupInFolder(dirHandle);
  } catch(e){
    console.error('讀取資料夾內容失敗', e);
    msg.className = 'msg error';
    msg.textContent = '讀取資料夾內容失敗,請確認選的是有備份檔的那個資料夾。';
    return;
  }
  if(!found){
    msg.className = 'msg error';
    msg.textContent = '這個資料夾裡沒有找到 stock_ledger_backup_YYYY-MM-DD.json 格式的備份檔。';
    return;
  }

  let backup;
  try{
    backup = JSON.parse(found.text);
    if(!backup || typeof backup !== 'object' || !Array.isArray(backup.products) || !Array.isArray(backup.transactions)){
      throw new Error('格式不正確');
    }
  } catch(e){
    msg.className = 'msg error';
    msg.textContent = `檔案 ${found.filename} 不是有效的備份檔(${e.message})。`;
    return;
  }

  showConfirmModal(tf('confirmRestoreLatestBackup', { filename: found.filename, products: backup.products.length, transactions: backup.transactions.length }), async () => {
    products = backup.products;
    transactions = backup.transactions;
    orders = Array.isArray(backup.orders) ? backup.orders : [];
    shippingParties = Array.isArray(backup.shippingParties) ? backup.shippingParties : [];
    shippingParties.forEach(sp => { if(!Array.isArray(sp.hiddenProductIds)) sp.hiddenProductIds = []; });
    recomputeOrderCounterFromOrders();
    if(Array.isArray(backup.categoryOrder) && backup.categoryOrder.length > 0){
      categoryOrder = backup.categoryOrder;
    }
    await saveProducts();
    await replaceAllTransactions(transactions);
    await replaceAllOrders(orders);
    await saveShippingParties();
    await saveCategoryOrder();
    const seqSynced = await syncOrderNoSequenceAfterRestore(orders);
    // 這個資料夾既然能讀,順便記起來,之後自動備份也直接寫進同一個地方。
    backupDirHandle = dirHandle;
    lastAutoBackupMode = 'folder';
    updateAutoBackupStatus();
    msg.className = seqSynced ? 'msg ok' : 'msg error';
    msg.textContent = tf('restoredFromFileMsg', { filename: found.filename, products: products.length, transactions: transactions.length, orders: orders.length })
      + (seqSynced ? '' : ' ' + t('warnOrderNoSeqSyncFailed'));
    renderTabBar();
    renderAll();
  });
}

// 把載入進來的「訂貨自動轉換 multipack」設定值,同步到系統設置畫面上的 checkbox(checkbox 本身是
// 靜態 HTML,不會因為資料載入完成就自動變勾選,要手動同步一次)。
function updateMultipackSettingsUI(){
  const box = document.getElementById('autoConvertMultipackToggle');
  if(box) box.checked = autoConvertMultipackEnabled;
  const ddvBox = document.getElementById('disableDirectVerifyToggle');
  if(ddvBox) ddvBox.checked = disableDirectVerifyEnabled;
  const psmSelect = document.getElementById('productSortModeSelect');
  if(psmSelect) psmSelect.value = productSortMode;
  const cefSelect = document.getElementById('completedExportFormatSelect');
  if(cefSelect) cefSelect.value = completedExportFormat;
  const hmiBox = document.getElementById('hideMultipackIconToggle');
  if(hmiBox) hmiBox.checked = hideMultipackIconOnOrderPage;
  renderAccountingEmailList();
  const slmSelect = document.getElementById('stockLocationModeSelect');
  if(slmSelect){
    slmSelect.value = stockLocationMode;
    onStockLocationModeSelectChange(stockLocationMode);
  }
  const fieldMap = { zone: 'stockLocationFieldZone', aisle: 'stockLocationFieldAisle', bay: 'stockLocationFieldBay', level: 'stockLocationFieldLevel', bin: 'stockLocationFieldBin' };
  Object.keys(fieldMap).forEach(k => {
    const el = document.getElementById(fieldMap[k]);
    if(el) el.checked = stockLocationEnabledFields[k] !== false;
  });
  const slpToggle = document.getElementById('stockLocationShowOnPickingSlipToggle');
  if(slpToggle) slpToggle.checked = stockLocationShowOnPickingSlip;
  // 客製化功能模組(ot-custom-features.js)沒帶的話,對應的設置選項直接隱藏不顯示——
  // 行為固定用預設值(見 loadData() 裡對應的 else 分支)。
  const slPrintSection = document.getElementById('stockLocationPrintSection');
  if(slPrintSection) slPrintSection.style.display = hasFeature('stockLocationPickingSlipPrint') ? '' : 'none';
  const cefCard = document.getElementById('completedExportFormatCard');
  if(cefCard) cefCard.style.display = hasFeature('completedExportFormatOption') ? '' : 'none';
}

// 會計 Email 清單管理:每一列一個地址+一個「設為主要」的選項(用單選鈕實作,同一時間只能有
// 一個主要)。標記主要的那個,寄信時會放在收件人(To);其他的放副本(CC)一起寄出。清單第一次
// 新增地址的話,自動把它設成主要(不然會出現「一個地址都不是主要」這種奇怪狀態)。
function renderAccountingEmailList(){
  const wrap = document.getElementById('accountingEmailList');
  if(!wrap) return;
  if(accountingEmails.length === 0){
    wrap.innerHTML = `<p style="font-size:12px;color:var(--ink-soft);margin:0;">${t('noAccountingEmailsYet')}</p>`;
    return;
  }
  wrap.innerHTML = accountingEmails.map((e, i) => `
    <div style="display:flex;align-items:center;gap:10px;">
      <input type="email" value="${(e.email || '').replace(/"/g,'&quot;')}" placeholder="accounting@example.com"
        onchange="updateAccountingEmailAddress(${i}, this.value)" style="flex:1;max-width:280px;" />
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--ink-soft);cursor:pointer;white-space:nowrap;">
        <input type="radio" name="accountingEmailPrimary" ${e.isPrimary ? 'checked' : ''} onchange="setAccountingEmailPrimary(${i})" />
        <span data-i18n="lblPrimary">主要(To)</span>
      </label>
      <span class="del-link" onclick="removeAccountingEmailRow(${i})">${t('btnRemoveFile')}</span>
    </div>
  `).join('');
}
function addAccountingEmailRow(){
  accountingEmails.push({ email: '', isPrimary: accountingEmails.length === 0 });
  renderAccountingEmailList();
}
async function updateAccountingEmailAddress(index, value){
  if(!accountingEmails[index]) return;
  accountingEmails[index].email = (value || '').trim();
  await saveAccountingEmails();
}
async function setAccountingEmailPrimary(index){
  accountingEmails.forEach((e, i) => { e.isPrimary = (i === index); });
  renderAccountingEmailList();
  await saveAccountingEmails();
}
async function removeAccountingEmailRow(index){
  const wasPrimary = accountingEmails[index] && accountingEmails[index].isPrimary;
  accountingEmails.splice(index, 1);
  // 刪掉的剛好是主要地址的話,清單裡如果還有其他地址,自動把第一個設成主要,不留下「沒有
  // 主要地址」的狀態。
  if(wasPrimary && accountingEmails.length > 0) accountingEmails[0].isPrimary = true;
  renderAccountingEmailList();
  await saveAccountingEmails();
}
async function saveAccountingEmails(){
  try{ await dbSet('accountingEmails', JSON.stringify(accountingEmails)); }
  catch(e){ console.error('儲存會計 Email 清單失敗', e); }
}
// 給寄信流程用:回傳 { to, cc } ——主要地址當 to,其他地址合併成 cc(逗號分隔字串,沒有的話
// 是空字串)。清單是空的、或完全沒有標記主要的(理論上不該發生,防呆用)的話,to 也會是空字串,
// 呼叫端原本處理「沒有預設地址」的邏輯不用改。
function getAccountingEmailToAndCc(){
  const primary = accountingEmails.find(e => e.isPrimary && e.email);
  const others = accountingEmails.filter(e => !e.isPrimary && e.email).map(e => e.email);
  return { to: primary ? primary.email : '', cc: others.join(', ') };
}

function onStockLocationModeSelectChange(value){
  const wrap = document.getElementById('stockLocationFieldsEditWrap');
  if(wrap) wrap.style.display = value === 'standard' ? 'block' : 'none';
}

// 標準模式的「編輯格式」欄位勾選+模式一起存,按一次「儲存」兩個都存。自訂模式不用管欄位勾選,
// 選了自訂就直接存,不用等按儲存(跟原本切成自訂模式時的行為一致,只有標準模式下的欄位細節
// 才需要額外按儲存確認)。
async function saveStockLocationSettings(){
  const msgEl = document.getElementById('stockLocationSettingsMsg');
  const mode = document.getElementById('stockLocationModeSelect').value;
  stockLocationMode = mode;
  stockLocationEnabledFields = {
    zone: document.getElementById('stockLocationFieldZone').checked,
    aisle: document.getElementById('stockLocationFieldAisle').checked,
    bay: document.getElementById('stockLocationFieldBay').checked,
    level: document.getElementById('stockLocationFieldLevel').checked,
    bin: document.getElementById('stockLocationFieldBin').checked
  };
  try{
    await dbSet('stockLocationMode', mode);
    await dbSet('stockLocationEnabledFields', JSON.stringify(stockLocationEnabledFields));
    msgEl.className = 'msg ok';
    msgEl.textContent = t('settingsSavedMsg');
  } catch(e){
    console.error('儲存 Stock Location 設定失敗', e);
    msgEl.className = 'msg error';
    msgEl.textContent = '⚠ 儲存失敗,請重新整理頁面再試一次。';
  }
}

async function saveStockLocationShowOnPickingSlip(checked){
  stockLocationShowOnPickingSlip = checked;
  try{ await dbSet('stockLocationShowOnPickingSlip', checked ? 'true' : 'false'); }
  catch(e){ console.error('儲存 Stock Location 列印設定失敗', e); }
}

async function toggleAutoConvertMultipack(checked){
  autoConvertMultipackEnabled = checked;
  try{ await dbSet('autoConvertMultipack', checked ? 'true' : 'false'); }
  catch(e){ console.error('儲存訂貨自動轉換設定失敗', e); }
}

// 取消直接核對功能:勾選後,「登記進出貨→出貨→載入現有待處理訂單」下面的「直接核對」選項要隱藏,
// 逼迫使用者一定要走「載入訂單核對頁面」比對實際點貨內容才能核對確認,避免有人為了方便直接核對
// 而跳過比對這個步驟。
async function toggleDisableDirectVerify(checked){
  disableDirectVerifyEnabled = checked;
  try{ await dbSet('disableDirectVerify', checked ? 'true' : 'false'); }
  catch(e){ console.error('儲存取消直接核對設定失敗', e); }
  renderTxSubmitArea();
  const directVerifyBtn = document.getElementById('btnDirectVerifyOnVerifyPage');
  if(directVerifyBtn) directVerifyBtn.style.display = disableDirectVerifyEnabled ? 'none' : '';
}

// 商品排序設置改變:存起來,並且重新畫庫存總覽(如果目前正顯示的話)、訂貨頁面,讓新的排序方式
// 立刻生效,不用等使用者自己切分頁才看到變化。
async function changeProductSortMode(mode){
  if(!['import','name','sku'].includes(mode)) return;
  productSortMode = mode;
  try{ await dbSet('productSortMode', mode); }
  catch(e){ console.error('儲存商品排序設定失敗', e); }
  if(document.getElementById('stockCards')) renderStockCards();
  if(document.getElementById('orderItemsTable')) renderOrderItemsTable();
}

async function changeCompletedExportFormat(mode){
  if(!['recordsOnly','fullCatalog'].includes(mode)) return;
  completedExportFormat = mode;
  try{ await dbSet('completedExportFormat', mode); }
  catch(e){ console.error('儲存已完成訂單匯出格式設定失敗', e); }
}

async function toggleHideMultipackIcon(checked){
  hideMultipackIconOnOrderPage = checked;
  try{ await dbSet('hideMultipackIconOnOrderPage', checked ? 'true' : 'false'); }
  catch(e){ console.error('儲存訂貨頁面隱藏Multipack圖示設定失敗', e); }
  if(document.getElementById('orderItemsTable')) renderOrderItemsTable();
  const cartSection = document.getElementById('orderCartSection');
  if(cartSection && cartSection.style.display !== 'none'){
    const { items } = collectOrderItems();
    renderCartTable(items);
  }
}

function updateAutoBackupStatus(){
  const el = document.getElementById('autoBackupStatus');
  const box = document.getElementById('autoBackupToggle');
  if(box) box.checked = autoBackupEnabled;
  if(!el) return;
  if(!autoBackupEnabled){
    el.textContent = t('autoBackupOffStatus');
    return;
  }
  const filename = todayBackupFilename();
  if(backupDirHandle){
    el.textContent = lastAutoBackupAt
      ? tf('autoBackupFolderStatusWithTime', { time: lastAutoBackupAt.toLocaleString('zh-TW'), filename })
      : tf('autoBackupFolderStatusNoTime', { filename });
  } else if(lastAutoBackupMode === 'download'){
    el.textContent = tf('autoBackupDownloadModeStatus', { time: lastAutoBackupAt ? lastAutoBackupAt.toLocaleString('zh-TW') : '' });
  } else {
    el.textContent = t('autoBackupNoFolderStatus');
  }
}

async function toggleAutoBackup(checked){
  autoBackupEnabled = checked;
  try{ await dbSet('autoBackupEnabled', String(checked)); }
  catch(e){ console.error('儲存自動備份設定失敗', e); }
  updateAutoBackupStatus();
}

// ===== 完整資料備份/還原(匯出/匯入 JSON) =====
function openRestoreDefaultModal(){
  document.getElementById('restoreDefaultModalOverlay').style.display = 'flex';
}
function closeRestoreDefaultModal(){
  document.getElementById('restoreDefaultModalOverlay').style.display = 'none';
}

function confirmClearAllData(){
  closeRestoreDefaultModal();
  const msg = tf('confirmClearAllDataWarning', {
    products: products.length,
    transactions: transactions.length,
    orders: orders.length,
    logs: inventoryLogs.length,
    parties: shippingParties.length,
    suppliers: purchaseSuppliers.length,
    emails: accountingEmails.length
  });
  showConfirmModal(msg, async () => { await clearAllData(); });
}

function confirmClearLogsResetOrders(){
  closeRestoreDefaultModal();
  const msg = tf('confirmClearLogsResetOrdersWarning', {
    orders: orders.length,
    logs: inventoryLogs.length
  });
  showConfirmModal(msg, async () => { await clearInventoryLogsAndResetOrders(); });
}

// Clear All Data:商品主檔、進出貨紀錄、後台紀錄、訂單全部清空,訂單編號重設回 1。
// 使用者管理、出貨方名單、分類順序、分頁順序等系統設定不受影響。
async function clearAllData(){
  try{
    // 先確認 clear_inventory_log 這個 RPC 真的能執行成功,再動 transactions/orders/products,
    // 避免「清到一半失敗」導致部分資料表已清空、部分還留著的不一致狀態。
    await clearInventoryLogTable();        // 透過 RPC 清空 inventory_log(繞過 RLS 限制)

    await replaceAllTransactions([]);      // 清空 transactions 表 + 重建庫存快取為空
    await replaceAllOrders([]);            // 清空 orders 表
    await clearAllDeliveryNotes();         // 清空 delivery_notes 表(訂單都清空了,留著也是孤兒資料)
    await clearAllPurchases();             // 清空 purchases 表(進出貨紀錄都清空了,留著也是孤兒資料)
    // 「Clear All Data」既然是全部重置,倉庫後台管理那幾份資料(出貨方、進貨方、庫存分布、
    // 收據掃描記憶對照表)也要一起清掉,不然商品/交易紀錄都清空了,這些指著已經不存在的商品的
    // 孤兒資料卻還留著,一來沒有意義,二來使用者會誤以為「清除全部資料」沒有真的清乾淨。
    await clearAllPurchaseSuppliers();     // 清空 purchase_suppliers 表(進貨方管理)
    await clearAllProductLocations();      // 清空 product_locations 表(庫存分布)
    await clearAllReceiptLineMappings();   // 清空 receipt_line_mappings 表(收據掃描數據庫)

    products = [];
    await saveProducts();

    shippingParties = [];
    await saveShippingParties();           // 出貨方管理整批存成一份 JSON,直接蓋成空陣列即可

    accountingEmails = [];
    await saveAccountingEmails();          // 會計 Email 清單也是整批存成一份 JSON,同樣直接蓋成空陣列

    orderCounter = 0;
    await saveOrderCounter();
    try{ await resetOrderNoSequence(); }
    catch(e){ /* RPC 可能還沒建立,已在 console 記錄錯誤,不擋住其他清除動作 */ }

    transactions = [];
    orders = [];
    deliveryNotes = [];
    purchases = [];
    purchaseSuppliers = [];
    productLocations = [];
    receiptLineMappings = [];
    productStockMap = {};

    await loadInventoryLog();  // 重新從資料庫讀一次,確認真的清空了(而不是只清本地變數自欺欺人)
    renderAll();
    renderInventoryLog();
    renderDeliveryNoteLog();
    renderSupplierManagementTable();
    renderAccountingEmailList();
    if(hasFeature('receiptScanModule')) renderOcrDbProductSelect();
    showInfoModal(t('restoreDefaultSuccessAll'));
  } catch(e){
    console.error('Clear All Data 失敗', e);
    showInfoModal(t('restoreDefaultError'));
  }
}

// Clear Inventory Logs & Reset Order # to 1:只清空後台紀錄跟訂單資料,商品主檔跟進出貨紀錄不受影響。
async function clearInventoryLogsAndResetOrders(){
  try{
    // 一樣先確認 RPC 能成功執行,再動 orders 表,避免清到一半失敗留下不一致狀態。
    await clearInventoryLogTable();        // 透過 RPC 清空 inventory_log(繞過 RLS 限制)
    await replaceAllOrders([]);            // 清空 orders 表
    await clearAllDeliveryNotes();         // 清空 delivery_notes 表(同上,訂單都清空了會變孤兒資料)

    orderCounter = 0;
    await saveOrderCounter();
    try{ await resetOrderNoSequence(); }
    catch(e){ /* RPC 可能還沒建立,已在 console 記錄錯誤,不擋住其他清除動作 */ }

    orders = [];
    deliveryNotes = [];

    await loadInventoryLog();  // 重新從資料庫讀一次,確認真的清空了(而不是只清本地變數自欺欺人)
    renderAll();
    renderInventoryLog();
    renderDeliveryNoteLog();
    showInfoModal(t('restoreDefaultSuccessLogsOrders'));
  } catch(e){
    console.error('Clear Inventory Logs & Reset Order # 失敗', e);
    showInfoModal(t('restoreDefaultError'));
  }
}

async function exportFullBackup(){
  const backup = {
    exportedAt: new Date().toISOString(),
    version: 6,
    products,
    transactions,
    orders,
    shippingParties,
    categoryOrder,
    inventoryLogs,
    deliveryNotes,
    purchases
  };
  const filename = `stock_ledger_backup_${todayISO()}.json`;
  const content = JSON.stringify(backup, null, 2);
  const msg = document.getElementById('backupMsg');

  if(window.showSaveFilePicker){
    try{
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JSON 備份檔', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      msg.className = 'msg ok';
      msg.textContent = tf('exportedBackupToLocationMsg', { filename: handle.name, products: products.length, transactions: transactions.length });
      return;
    } catch(e){
      if(e && e.name === 'AbortError') return; // 使用者自己取消,不用當成錯誤
      console.error('選擇儲存位置失敗,改用一般下載', e);
      // 往下走一般下載當備援
    }
  }

  downloadFile(filename, content, 'application/json');
  msg.className = 'msg ok';
  msg.textContent = tf('exportedBackupMsg', { filename, products: products.length, transactions: transactions.length });
}

function importFullBackup(){
  const fileInput = document.getElementById('backupImportFile');
  const msg = document.getElementById('backupMsg');
  const file = fileInput.files[0];
  if(!file){ msg.className='msg error'; msg.textContent='請先選擇備份檔'; return; }

  showConfirmModal('還原備份會完全覆蓋目前 App 裡的商品跟進出貨紀錄,確定要繼續嗎?', () => {
    if(file.size === 0){
      msg.className = 'msg error';
      msg.textContent = '這個檔案是空的(0 bytes),請確認是不是正確的備份檔';
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      msg.className = 'msg error';
      msg.textContent = '讀取檔案失敗,瀏覽器無法存取這個檔案。請重新選擇檔案再試一次。';
    };
    reader.onload = async (e) => {
      try{
        const raw = e.target.result;
        if(!raw || typeof raw !== 'string' || raw.trim() === ''){
          throw new Error('檔案內容是空的');
        }
        let backup;
        try{
          backup = JSON.parse(raw);
        } catch(parseErr){
          throw new Error('不是有效的 JSON 檔案(' + parseErr.message + ')。開頭內容:' + raw.slice(0, 60));
        }
        if(!backup || typeof backup !== 'object'){
          throw new Error('這個檔案格式不正確,不是有效的備份檔');
        }
        if(!Array.isArray(backup.products) || !Array.isArray(backup.transactions)){
          throw new Error('這個檔案缺少 products 或 transactions 欄位,不是有效的備份檔');
        }
        products = backup.products;
        transactions = backup.transactions;
        orders = Array.isArray(backup.orders) ? backup.orders : [];
        shippingParties = Array.isArray(backup.shippingParties) ? backup.shippingParties : [];
    shippingParties.forEach(sp => { if(!Array.isArray(sp.hiddenProductIds)) sp.hiddenProductIds = []; });
    recomputeOrderCounterFromOrders();
        if(Array.isArray(backup.categoryOrder) && backup.categoryOrder.length > 0){
          categoryOrder = backup.categoryOrder;
        }
        await saveProducts();
        await replaceAllTransactions(transactions);
        await replaceAllOrders(orders);
        await saveShippingParties();
        await saveCategoryOrder();
        // inventory_log 是稽核用途的紀錄,故意不開放前端刪除(見 clearInventoryLogTable 旁邊的
        // 說明)——還原備份的時候也一樣不整批覆蓋,只把備份裡的紀錄用 upsert 補進去,已經存在的
        // (id 相同)就跳過不動,不會覆蓋掉還原當下資料庫裡已經有的紀錄。
        if(Array.isArray(backup.inventoryLogs) && backup.inventoryLogs.length > 0){
          try{
            const { error: logErr } = await sb.from('inventory_log').upsert(backup.inventoryLogs, { onConflict: 'id', ignoreDuplicates: true });
            if(logErr) throw logErr;
          } catch(e){ console.error('還原後台紀錄失敗', e); }
        }
        if(Array.isArray(backup.deliveryNotes) && backup.deliveryNotes.length > 0){
          try{ await upsertDeliveryNotes(backup.deliveryNotes); }
          catch(e){ console.error('還原 Delivery Note 失敗', e); }
        }
        if(Array.isArray(backup.purchases) && backup.purchases.length > 0){
          try{ for(const p of backup.purchases) await upsertPurchase(p); }
          catch(e){ console.error('還原進貨單失敗', e); }
        }
        await loadInventoryLog();
        await loadDeliveryNotes();
        await loadPurchases();
        const seqSynced = await syncOrderNoSequenceAfterRestore(orders);
        msg.className = seqSynced ? 'msg ok' : 'msg error';
        msg.textContent = tf('restoredBackupMsg', { products: products.length, transactions: transactions.length, orders: orders.length })
          + (seqSynced ? '' : ' ' + t('warnOrderNoSeqSyncFailed'));
        fileInput.value = '';
        renderTabBar();
        renderAll();
        renderDeliveryNoteLog();
      } catch(err){
        msg.className = 'msg error';
        msg.textContent = '還原失敗:' + err.message;
      }
    };
    reader.readAsText(file);
  });
}
