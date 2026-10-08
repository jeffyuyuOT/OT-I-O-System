// ============================================================
// 商品主檔管理(System Admin → Product Master)——手動新增單一
// 商品、從 Excel 匯入/更新商品主檔(品名/單位/庫存量/平均使用量/
// 分類/安全庫存)、匯入後只重套分類等中繼資料不動庫存量。跟
// 登記進出貨自己的 Excel 匯入(parseTxExcel,在 transactions.js)
// 是兩個完全不同的功能,欄位格式、用途都不一樣。
//
// 另外也放了「倉庫後台管理→資料維護」的匯出功能(匯出貨/銷貨單、
// 匯出進貨紀錄)——跟商品主檔匯入不是同一件事,但都是「資料維護」
// 這個分頁底下的功能,放一起管理比較方便。
//
// fileKey() 這個小工具兩邊都會用到(這裡的 addMasterFiles、
// transactions.js 的 addTxFiles),放這裡,transactions.js 那邊
// 一樣共用同一份全域作用域抓得到。
// ============================================================
// 手動新增單一商品(依網址開的視窗):改用跟「編輯商品」同一套視窗跟表單(products.js 的
// openAddNewProductModal()/saveProductEditModal()),不再用這個分頁上一排小欄位——理由是
// 那個視窗的欄位齊全很多(照片、條碼、箱子尺寸等等都有),資訊填起來比較清楚,也不用維護
// 兩套「商品欄位長什麼樣子」的畫面。

async function reapplyCategories(){
  const msg = document.getElementById('importMsg');
  let updated = 0;

  IMPORTED_STOCK_DATA.forEach(item => {
    if(!item.sku) return;
    const existing = products.find(p => p.sku === item.sku);
    if(!existing) return;
    let changed = false;
    if(!existing.category || existing.category !== item.category){ existing.category = item.category; changed = true; }
    if(item.avg !== null && item.avg !== undefined && existing.manualAvg !== item.avg){ existing.manualAvg = item.avg; changed = true; }
    if(item.safetyStock !== null && item.safetyStock !== undefined && existing.safetyStock !== item.safetyStock){ existing.safetyStock = item.safetyStock; changed = true; }
    if(item.note && existing.note !== item.note){ existing.note = item.note; changed = true; }
    if(changed) updated++;
  });

  if(updated === 0){
    msg.className = 'msg';
    msg.textContent = '沒有需要更新的商品,分類/平均值/安全庫存/備註看起來已經是最新的了。';
    return;
  }

  await saveProducts();
  msg.className = 'msg ok';
  msg.textContent = `✓ 已幫 ${updated} 項現有商品更新分類/平均值/安全庫存`;
  renderAll();
}

function dismissImport(){
  document.getElementById('importSection').style.display = 'none';
}

function todayISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}


async function importFromExcel(){
  await importStockItems(IMPORTED_STOCK_DATA);
}

const MASTER_COLUMN_ALIASES = {
  sku: ['sku','item code','itemcode','編號','貨號'],
  name: ['name','品名','商品名稱','item','商品'],
  unit: ['unit','單位'],
  qty: ['stock','庫存量','庫存','qty','quantity','currentstock'],
  avg: ['avgmonthlysales','avg','平均使用量','平均出貨量','月均使用量','avgmonthlyusage'],
  category: ['categories','category','分類','類別'],
  safetyStock: ['safetystock','安全庫存','安全庫存(月數)','safetystockmonths','安全庫存月數'],
  note: ['note','notes','備註','remark'],
  parentSku: ['parentsku','mainproductsku','主商品sku','母商品sku','主商品編號','multipackparentsku'],
  childWeight: ['childweight','weight','加權數','庫存量加權數','weightnumber'],
  boxLength: ['boxlength','length','長','箱長','長度cm','lengthcm','長(cm)'],
  boxWidth: ['boxwidth','width','寬','箱寬','寬度cm','widthcm','寬(cm)'],
  boxHeight: ['boxheight','height','高','箱高','高度cm','heightcm','高(cm)'],
  hidden: ['hidden','隱藏','ishidden','是否隱藏'],
  autoConvertOnStockIn: ['autoconvert','autoconvertonstockin','自動切換','進貨自動切換'],
  orderPageRemark: ['orderpageremark','訂貨頁面附註','訂貨附註','orderremark'],
  barcode: ['barcode','條碼','商品條碼','barcodenumber']
};

// Excel 儲存格裡的「是否隱藏」欄位,可能是真的布林值(true/false)、文字(TRUE/FALSE、Y/N、是/否),
// 或數字(1/0),這裡統一轉換成布林值。無法辨識的內容一律當作「不隱藏」(false),避免打錯字反而
// 把商品意外隱藏起來。
function parseBoolLikeCell(val){
  if(typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === '是' || s === '隱藏';
}

// Excel 儲存格裡數字欄位(平均使用量、安全庫存、加權數、箱子尺寸…)統一走這裡解析,不要各自
// 直接用 parseFloat。這裡會先把值轉成字串、去除頭尾空白——這樣即使儲存格裡只有一個半形或全形
// 空格(不是真的空白儲存格,trim 前不等於空字串,原本的「!== ''」判斷會漏接這種情況),也會被
// 正確視為「沒有值」,回傳 null,而不是讓 parseFloat(' ') 算出 NaN 這種壞掉的數字被存進資料庫。
// 真的解析不出數字的內容(例如打了文字)也一律回傳 null,不會讓 NaN 混進商品資料。
function parseNumericCell(val){
  if(val === null || val === undefined) return null;
  const s = String(val).trim();
  if(s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// 欄名比對前先正規化:轉小寫、去掉空白/底線/連字號/斜線,也去掉括號整段內容(含括號本身,
// 半形圓括號跟全形圓括號都算)——例如「長(cm)」正規化後會變成「長」,直接對得上別名清單裡的
// 「長」,不需要每次遇到欄名後面帶單位/補充說明的括號,就得手動把整個帶括號的完整字串另外加進
// 別名清單。之前「安全庫存(月數)」「長(cm)」欄位對不到別名,就是卡在括號沒被拿掉這件事上。
function normalizeHeader(h){
  return String(h).toLowerCase()
    .replace(/[\(（][^\)）]*[\)）]/g, '')
    .replace(/[\s_\-/]/g, '');
}

function findColumnIndex(headerRow, aliases){
  const normalized = headerRow.map(h => h ? normalizeHeader(h) : '');
  for(const alias of aliases){
    const idx = normalized.indexOf(normalizeHeader(alias));
    if(idx !== -1) return idx;
  }
  return -1;
}

let pendingMasterFiles = [];
let pendingTxFiles = [];

function fileKey(file){ return file.name + '|' + file.size + '|' + file.lastModified; }

function addMasterFiles(fileList){
  const newFiles = Array.from(fileList);
  const existingKeys = new Set(pendingMasterFiles.map(fileKey));
  newFiles.forEach(f => {
    if(!existingKeys.has(fileKey(f))) pendingMasterFiles.push(f);
  });
  document.getElementById('masterImportFile').value = '';
  renderMasterFileList();
}

function removeMasterFile(index){
  pendingMasterFiles.splice(index, 1);
  renderMasterFileList();
}

function renderMasterFileList(){
  const container = document.getElementById('masterFileList');
  if(pendingMasterFiles.length === 0){ container.innerHTML = ''; return; }
  container.innerHTML = pendingMasterFiles.map((f, i) => `
    <span class="file-chip">${f.name}<button onclick="removeMasterFile(${i})" title="移除">✕</button></span>
  `).join('');
}


function parseMasterExcelFile(){
  const msg = document.getElementById('importMsg');
  const files = pendingMasterFiles;
  const clearBlanksEl = document.getElementById('clearBlanksOnImport');
  const clearBlanksMode = !!(clearBlanksEl && clearBlanksEl.checked);

  if(files.length === 0){ msg.className='msg error'; msg.textContent='請先選擇至少一個 Excel 檔案'; return; }
  if(typeof XLSX === 'undefined'){ msg.className='msg error'; msg.textContent='Excel 解析套件載入失敗,請重新整理頁面再試一次'; return; }

  msg.className = 'msg'; msg.textContent = `解析中(共 ${files.length} 個檔案)…`;

  const allItems = [];
  const fileErrors = [];
  const skippedRows = []; // { file, row, reason } — 逐列記錄哪一列被略過、為什麼,方便使用者對照 Excel 原檔案找出問題
  let filesDone = 0;

  files.forEach(file => {
    const reader = new FileReader();
    reader.onerror = () => {
      fileErrors.push(`${file.name}:讀取檔案失敗`);
      filesDone++;
      if(filesDone === files.length) finishMasterImport();
    };
    reader.onload = (e) => {
      try{
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

        if(rows.length === 0){ fileErrors.push(`${file.name}:檔案是空的`); return; }

        const headerRow = rows[0];
        const colSku = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.sku);
        const colName = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.name);
        const colUnit = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.unit);
        const colQty = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.qty);
        const colAvg = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.avg);
        const colCategory = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.category);
        const colSafety = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.safetyStock);
        const colNote = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.note);
        const colParentSku = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.parentSku);
        const colChildWeight = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.childWeight);
        const colBoxLength = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.boxLength);
        const colBoxWidth = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.boxWidth);
        const colBoxHeight = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.boxHeight);
        const colHidden = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.hidden);
        const colAutoConvert = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.autoConvertOnStockIn);
        const colOrderPageRemark = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.orderPageRemark);
        const colBarcode = findColumnIndex(headerRow, MASTER_COLUMN_ALIASES.barcode);

        if(colName === -1 || colQty === -1){
          fileErrors.push(`${file.name}:找不到「Name/品名」或「Stock/庫存量」欄位`);
          return;
        }
        if(colSku === -1){
          fileErrors.push(`${file.name}:找不到「SKU」欄位`);
          return;
        }

        for(let r = 1; r < rows.length; r++){
          const row = rows[r];
          if(!row) continue;
          const excelRowNo = r + 1; // Excel 檔案裡實際的列號(標題佔第 1 列,資料從第 2 列開始,陣列索引 r 對應到 r+1 列)
          const rowNameVal = row[colName];
          const rowSkuVal = row[colSku];
          const rowIdentifier = (rowSkuVal !== null && rowSkuVal !== undefined && String(rowSkuVal).trim() !== '') ? String(rowSkuVal).trim()
            : (rowNameVal !== null && rowNameVal !== undefined && String(rowNameVal).trim() !== '') ? String(rowNameVal).trim()
            : null;
          if(rowNameVal === null || rowNameVal === undefined || String(rowNameVal).trim() === ''){
            skippedRows.push({ file: file.name, row: excelRowNo, identifier: rowIdentifier, reason: t('importSkipReasonNoName') });
            continue;
          }
          const skuVal = row[colSku];
          if(skuVal === null || skuVal === undefined || String(skuVal).trim() === ''){
            skippedRows.push({ file: file.name, row: excelRowNo, identifier: String(rowNameVal).trim(), reason: t('importSkipReasonNoSku') });
            continue;
          }
          // 庫存量欄位改成選填:有填才會拿來對照、調整庫存(跟原本行為一樣);空白的話這一整列
          // 不再被整個跳過——只是「不動庫存」,其他欄位(分類、平均值、安全庫存、備註、訂貨頁面
          // 附註、箱子尺寸…)照常比對更新。這是為了支援「只更新商品資料、不重新盤點庫存」這種
          // 匯入情境,之前的邏輯只要庫存量空白就整列略過,會連帶讓其他欄位的更新也一起不見。
          const qtyVal = row[colQty];
          const parsedQty = parseNumericCell(qtyVal);

          allItems.push({
            sku: String(skuVal).trim(),
            name: String(row[colName]).trim(),
            unit: colUnit !== -1 && row[colUnit] ? String(row[colUnit]).trim() : null,
            qty: parsedQty, // null 代表這一列沒填庫存量,匯入時完全不動這個商品的庫存
            avg: colAvg !== -1 ? parseNumericCell(row[colAvg]) : null,
            category: colCategory !== -1 && row[colCategory] ? String(row[colCategory]).trim() : null,
            safetyStock: colSafety !== -1 ? parseNumericCell(row[colSafety]) : null,
            note: colNote !== -1 && row[colNote] ? String(row[colNote]).trim() : null,
            parentSku: colParentSku !== -1 && row[colParentSku] !== null && row[colParentSku] !== '' ? String(row[colParentSku]).trim() : null,
            childWeight: colChildWeight !== -1 ? parseNumericCell(row[colChildWeight]) : null,
            boxLengthCm: colBoxLength !== -1 ? parseNumericCell(row[colBoxLength]) : null,
            boxWidthCm: colBoxWidth !== -1 ? parseNumericCell(row[colBoxWidth]) : null,
            boxHeightCm: colBoxHeight !== -1 ? parseNumericCell(row[colBoxHeight]) : null,
            hidden: colHidden !== -1 && row[colHidden] !== null && row[colHidden] !== undefined && row[colHidden] !== '' ? parseBoolLikeCell(row[colHidden]) : null,
            autoConvertOnStockIn: colAutoConvert !== -1 && row[colAutoConvert] !== null && row[colAutoConvert] !== undefined && row[colAutoConvert] !== '' ? parseBoolLikeCell(row[colAutoConvert]) : null,
            orderPageRemark: colOrderPageRemark !== -1 && row[colOrderPageRemark] !== null && row[colOrderPageRemark] !== undefined && String(row[colOrderPageRemark]).trim() !== '' ? String(row[colOrderPageRemark]).trim() : null,
            barcode: colBarcode !== -1 && row[colBarcode] !== null && row[colBarcode] !== undefined && String(row[colBarcode]).trim() !== '' ? String(row[colBarcode]).trim() : null,
            _sourceFile: file.name, _sourceRow: excelRowNo
          });
        }
      } catch(err){
        fileErrors.push(`${file.name}:解析失敗(${err.message})`);
      } finally {
        filesDone++;
        if(filesDone === files.length) finishMasterImport();
      }
    };
    reader.readAsArrayBuffer(file);
  });

  function finishMasterImport(){
    if(allItems.length === 0){
      msg.className = 'msg error';
      const skipDetail = skippedRows.length > 0 ? ` ${t('importSkippedRowsIntro')}${skippedRows.map(s => tf('importSkippedRowLine', {file: s.file, row: s.row, identifier: s.identifier || '—', reason: s.reason})).join('; ')}` : '';
      msg.textContent = `沒有解析到任何商品資料列。${fileErrors.length > 0 ? '錯誤:' + fileErrors.join('; ') : '請確認檔案內容'}${skipDetail}`;
      return;
    }
    importStockItems(allItems, skippedRows, clearBlanksMode);
    if(fileErrors.length > 0){
      const prevMsg = document.getElementById('importMsg');
      setTimeout(() => {
        prevMsg.textContent += `(其中 ${fileErrors.length} 個檔案有問題:${fileErrors.join('; ')})`;
      }, 50);
    }
    pendingMasterFiles = [];
    renderMasterFileList();
  }
}

// ===== 倉庫後台管理 → 資料維護:匯出功能 =====
// 每種類型對應的 i18n 標籤 key、對象欄位標籤 key、匯出檔名前綴跟 Excel 分頁名稱(分頁名稱維持中文,不受語言切換影響)
const EXPORT_TYPE_META = {
  out:     { labelKey: 'exportTypeOut', partyLabelKey: 'exportPartyLabelOut', partyCol: 'Customer', filePrefix: 'stock_out',     sheetName: 'Stock Out' },
  in:      { labelKey: 'exportTypeIn', partyLabelKey: 'exportPartyLabelIn', partyCol: 'Supplier', filePrefix: 'stock_in',      sheetName: 'Stock In' },
  restock: { labelKey: 'exportTypeRestock', partyLabelKey: 'exportPartyLabelRestock',   partyCol: 'Source',   filePrefix: 'stock_restock', sheetName: 'Restock' },
  // 待處理訂單出貨:還沒實際出貨的訂單(狀態是待處理/處理中,未完成、未取消)裡各商品訂的數量
  pending: { labelKey: 'exportTypePending', partyLabelKey: 'exportPartyLabelOut', partyCol: 'Customer', filePrefix: 'pending_orders', sheetName: 'Pending Orders' }
};

// 把「待處理訂單」攤平成跟交易紀錄同樣格式的列(party/productId/qty/date/orderId),讓匯出流程可以共用。
// 只算還沒實際出貨的訂單(status 不是 confirmed、沒被取消),被刪掉的品項跟負數(入庫/退貨)品項不算。
function getPendingOrderExportRows(){
  const out = [];
  (orders || []).forEach(o => {
    if(o.deleted || o.status === 'confirmed' || o.signedAt) return;
    (o.items || []).forEach(it => {
      if(it.deleted || !(it.qty > 0)) return;
      out.push({ type: 'pending', productId: it.productId, qty: it.qty, date: o.date || '', party: o.partyName || '', orderId: o.id });
    });
  });
  return out;
}

const EXPORT_MULTI_STORE_VALUE = '__multi__'; // 「對象」下拉選單裡「Multiple store」這個選項的值

function populateExportPartySelect(){
  const typeSel = document.getElementById('exportTypeSelect');
  const type = typeSel ? typeSel.value : 'out';
  const meta = EXPORT_TYPE_META[type] || EXPORT_TYPE_META.out;
  const partyLabelEl = document.getElementById('exportPartyLabel');
  if(partyLabelEl) partyLabelEl.textContent = t(meta.partyLabelKey);

  const sel = document.getElementById('exportPartySelect');
  const prevVal = sel.value;
  const parties = getExportPartyNames(type);
  // 第一項「全部對象」、第二項「Multiple store」(勾選要匯出哪幾個對象),後面才是各個對象。
  sel.innerHTML = `<option value="">${t('logPartyAll')}</option>` +
    `<option value="${EXPORT_MULTI_STORE_VALUE}">${t('exportPartyMultiple')}</option>` +
    parties.map(p => `<option value="${p.replace(/"/g,'&quot;')}">${p}</option>`).join('');
  if(prevVal === EXPORT_MULTI_STORE_VALUE || parties.includes(prevVal)) sel.value = prevVal;
  renderExportMultiStoreChecklist();
}

function getExportPartyNames(type){
  const src = type === 'pending' ? getPendingOrderExportRows() : transactions.filter(t => t.type === type);
  return [...new Set(src.filter(t => t.party).map(t => t.party))].sort();
}

// 選了「Multiple store」才顯示的勾選清單;重畫時保留原本已經勾選的對象。
function renderExportMultiStoreChecklist(){
  const wrap = document.getElementById('exportMultiStoreWrap');
  const sel = document.getElementById('exportPartySelect');
  if(!wrap || !sel) return;
  if(sel.value !== EXPORT_MULTI_STORE_VALUE){ wrap.style.display = 'none'; return; }
  const type = document.getElementById('exportTypeSelect').value;
  const prevChecked = new Set(getExportCheckedStores());
  const parties = getExportPartyNames(type);
  wrap.style.display = 'block';
  wrap.innerHTML = parties.length === 0
    ? `<div style="font-size:12px;color:var(--ink-soft);">${t('noExportPartiesYet')}</div>`
    : `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
        <span style="font-size:12px;font-weight:700;color:var(--ink);">${t('exportPickStoresLabel')}</span>
        <span class="del-link" onclick="setAllExportStoresChecked(true)">${t('btnSelectAll')}</span>
        <span class="del-link" onclick="setAllExportStoresChecked(false)">${t('btnClearAll')}</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 18px;">
        ${parties.map(p => `
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;">
            <input type="checkbox" class="exportStoreCheckbox" value="${escapeAttr(p)}" ${prevChecked.has(p) ? 'checked' : ''} />
            <span>${escapeHtmlText(p)}</span>
          </label>`).join('')}
      </div>`;
}

function getExportCheckedStores(){
  return Array.from(document.querySelectorAll('.exportStoreCheckbox:checked')).map(el => el.value);
}

function setAllExportStoresChecked(checked){
  document.querySelectorAll('.exportStoreCheckbox').forEach(el => { el.checked = checked; });
}

// ===== 匯出特定商品資料 =====
// 跟上面「匯出報表」共用同一組「類型 / 對象 / 日期區間」設定,差別只在多了一份「商品清單」:清單是空的就匯出全部
// 商品(預設);清單裡有商品的話,只匯出清單裡這些商品(以家族為單位,主商品跟它底下的 multipack 都算)的資料。
// 商品可以一個一個「新增商品」(有分類篩選跟名稱搜尋),也可以直接「Import quick list」把一份快捷清單整個帶進來。
let exportProductIds = []; // 家族主商品 id

function renderExportProductList(){
  const listEl = document.getElementById('exportProductList');
  if(!listEl) return;
  exportProductIds = exportProductIds.filter(id => products.some(p => p.id === id && !p.parentId));
  populateQuickListSelect('exportQuickListSelect', 'optSelectQuickList');
  if(exportProductIds.length === 0){
    listEl.innerHTML = `<div class="empty-note" style="padding:10px 0;">${t('exportNoProductsHint')}</div>`;
    return;
  }
  listEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
      <span style="font-size:12px;font-weight:700;">${tn('lblSelectedProductsCount', exportProductIds.length)}</span>
      <span class="del-link" onclick="clearExportProducts()">${t('btnClearAll')}</span>
    </div>
    <div class="pp-list" style="margin-bottom:10px;">
      ${exportProductIds.map(id => anchorDisplayRowHtml(id, `removeExportProduct('${id}')`)).join('')}
    </div>`;
}

function toggleExportProductPicker(){
  const mount = document.getElementById('exportProductPickerMount');
  if(!mount) return;
  if(mount.style.display === 'none'){
    mount.style.display = 'block';
    mountProductPicker('exportProductPickerMount', 'ex', {
      includeHidden: true,
      getExcludedIds: () => exportProductIds,
      onAdd: (id) => { if(!exportProductIds.includes(id)) exportProductIds.push(id); renderExportProductList(); }
    });
  } else {
    mount.style.display = 'none';
    mount.innerHTML = '';
  }
}

function removeExportProduct(id){
  exportProductIds = exportProductIds.filter(x => x !== id);
  renderExportProductList();
  if(document.getElementById('exportProductPickerMount').style.display !== 'none') refreshProductPicker('ex');
}

function clearExportProducts(){
  exportProductIds = [];
  renderExportProductList();
  if(document.getElementById('exportProductPickerMount').style.display !== 'none') refreshProductPicker('ex');
}

function importQuickListToExport(){
  const msg = document.getElementById('exportShipmentMsg');
  const sel = document.getElementById('exportQuickListSelect');
  if(!sel || !sel.value){ msg.className = 'msg error'; msg.textContent = t('errPickQuickListFirst'); return; }
  const ql = getQuickListById(sel.value);
  if(!ql) return;
  let added = 0;
  getQuickListAnchorIds(ql.id).forEach(id => { if(!exportProductIds.includes(id)){ exportProductIds.push(id); added++; } });
  renderExportProductList();
  if(document.getElementById('exportProductPickerMount').style.display !== 'none') refreshProductPicker('ex');
  msg.className = 'msg ok';
  msg.textContent = tf('msgQuickListImported', { name: ql.name, n: added });
}

// ===== 匯出報表 =====
// 只有一個匯出按鈕:「匯出特定商品資料」的商品清單是空的 = 匯出全部商品;清單有商品 = 只匯出清單裡的商品。
//
// 對象的三種情況:
//  - 選了某一個對象:單一個分頁(跟以前一樣)。
//  - 選「全部對象」或「Multiple store」:第一個分頁是彙總(All Store / All Selected Store,同一個商品跨店加總),
//    後面每一個對象各一個分頁,只放那個對象自己的資料。
function exportShipmentSheet(opts){
  opts = opts || {};
  const msg = document.getElementById('exportShipmentMsg');
  if(typeof XLSX === 'undefined'){ msg.className='msg error'; msg.textContent='Excel 套件載入失敗,請重新整理頁面再試一次'; return; }

  const type = document.getElementById('exportTypeSelect').value;
  const meta = EXPORT_TYPE_META[type] || EXPORT_TYPE_META.out;
  const party = document.getElementById('exportPartySelect').value;
  const isMulti = party === EXPORT_MULTI_STORE_VALUE;
  const selectedStores = isMulti ? getExportCheckedStores() : [];
  const dateFrom = document.getElementById('exportDateFrom').value;
  const dateTo = document.getElementById('exportDateTo').value;
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));

  if(isMulti && selectedStores.length === 0){
    msg.className = 'msg error';
    msg.textContent = t('errPickAtLeastOneStore');
    return;
  }

  // 報表要把跟訂單/實際進出貨有關的紀錄都算進去(包含從訂貨頁面送出的訂單、登記進出貨時
  // 有勾選「併入已完成訂單」的出貨,這兩種都會標記 system=true 且帶 orderId)。只排除跟訂單無關的
  // 系統紀錄,例如 Excel 匯入的初始庫存調整、批量/主商品轉換紀錄(system=true 但沒有 orderId)。
  let rows = type === 'pending'
    ? getPendingOrderExportRows()
    : transactions.filter(t => t.type === type && (!t.system || t.orderId));
  if(isMulti) rows = rows.filter(t => selectedStores.includes(t.party));
  else if(party) rows = rows.filter(t => t.party === party);
  if(dateFrom) rows = rows.filter(t => t.date >= dateFrom);
  if(dateTo) rows = rows.filter(t => t.date <= dateTo);

  // 匯出特定商品資料:商品清單有東西才篩選(以家族為單位,主商品+底下全部 multipack);清單是空的 = 匯出全部商品。
  let familyFilterApplied = false;
  if(exportProductIds.length > 0){
    const allowed = new Set();
    exportProductIds.forEach(id => {
      if(!productMap[id]) return;
      allowed.add(id);
      getChildProducts(id).forEach(c => allowed.add(c.id));
    });
    rows = rows.filter(t => allowed.has(t.productId));
    familyFilterApplied = true;
  }

  if(rows.length === 0){
    msg.className = 'msg error';
    msg.textContent = tf('noMatchingRecordsToExport', { type: t(meta.labelKey) });
    return;
  }

  const splitByParty = !party || isMulti; // 全部對象 / Multiple store → 彙總分頁 + 每個對象各一個分頁
  const sheetEntries = []; // { name, ws }
  const usedSheetNames = new Set();
  function uniqueSheetName(raw){
    let base = (raw || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, '-').trim().slice(0, 31) || 'Sheet';
    let name = base, n = 2;
    while(usedSheetNames.has(name.toLowerCase())){
      const suffix = ` (${n++})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    usedSheetNames.add(name.toLowerCase());
    return name;
  }
  const partiesInRows = [...new Set(rows.map(t => t.party || ''))].sort((a, b) => a.localeCompare(b));
  const NO_PARTY_LABEL = '(no name)';

  let summaryText = '';
  if(type === 'in'){
    // 進貨:每一筆各自一列、不彙總(原因見 buildStockInSheet)。有多個對象的話,第一個分頁放全部,後面各供應商各一個分頁。
    if(splitByParty){
      sheetEntries.push({ name: uniqueSheetName(isMulti ? 'All Selected Store' : 'All Store'), ws: buildStockInSheet(rows, productMap) });
      partiesInRows.forEach(p => {
        sheetEntries.push({ name: uniqueSheetName(p || NO_PARTY_LABEL), ws: buildStockInSheet(rows.filter(t => (t.party || '') === p), productMap) });
      });
    } else {
      sheetEntries.push({ name: uniqueSheetName(meta.sheetName), ws: buildStockInSheet(rows, productMap) });
    }
    summaryText = `${rows.length}`;
  } else {
    const dateLabel = dateFrom && dateTo
      ? (dateFrom === dateTo ? dateFrom : `${dateFrom} ~ ${dateTo}`)
      : (dateFrom ? `After ${dateFrom}` : (dateTo ? `Before ${dateTo}` : 'All Dates'));
    const partyLabelEN = type === 'restock' ? 'Source/Party' : 'Store/Party';
    const ctx = { type, meta, productMap, dateLabel };
    if(splitByParty){
      const allLabel = isMulti ? `All Selected ${partyLabelEN}: ${selectedStores.join(', ')}` : `All ${partyLabelEN}`;
      const all = buildShipmentSheet(rows, allLabel, true, ctx);
      sheetEntries.push({ name: uniqueSheetName(isMulti ? 'All Selected Store' : 'All Store'), ws: all.ws });
      partiesInRows.forEach(p => {
        const sub = buildShipmentSheet(rows.filter(t => (t.party || '') === p), p || NO_PARTY_LABEL, false, ctx);
        sheetEntries.push({ name: uniqueSheetName(p || NO_PARTY_LABEL), ws: sub.ws });
      });
      summaryText = `${all.groupCount}`;
    } else {
      const one = buildShipmentSheet(rows, party, false, ctx);
      sheetEntries.push({ name: uniqueSheetName(meta.sheetName), ws: one.ws });
      summaryText = `${one.groupCount}`;
    }
  }

  const wb = XLSX.utils.book_new();
  sheetEntries.forEach(s => XLSX.utils.book_append_sheet(wb, s.ws, s.name));

  let filename;
  if(type === 'in'){
    // 檔名格式:「Opulent - Stock in 日期」,單日只顯示那一天,區間就寫成 "date1 to date2";
    // 兩個日期篩選都沒填(匯出全部進貨紀錄)的話,用資料裡實際最早/最晚的日期組成區間,
    // 確保檔名還是能反映實際涵蓋的期間,不會什麼日期資訊都沒有。
    let dateForFilename;
    if(dateFrom && dateTo){
      dateForFilename = dateFrom === dateTo ? dateFrom : `${dateFrom} to ${dateTo}`;
    } else if(dateFrom || dateTo){
      dateForFilename = dateFrom || dateTo;
    } else {
      const allDates = rows.map(t => t.date).filter(Boolean).sort();
      const earliest = allDates[0], latest = allDates[allDates.length - 1];
      dateForFilename = (earliest && latest) ? (earliest === latest ? earliest : `${earliest} to ${latest}`) : todayISO();
    }
    filename = `Opulent - Stock in ${dateForFilename}${familyFilterApplied ? ' (selected products)' : ''}.xlsx`;
  } else {
    const label = isMulti ? 'Selected' : (party ? (party.replace(/[^a-zA-Z0-9]/g, '') || 'Party') : 'All');
    const rangeLabel = (dateFrom || dateTo) ? `_${dateFrom || 'start'}_${dateTo || 'end'}` : '';
    filename = `${meta.filePrefix}_${label || 'export'}${rangeLabel}${familyFilterApplied ? '_selected-products' : ''}.xlsx`;
  }

  XLSX.writeFile(wb, filename);
  msg.className = 'msg ok';
  msg.textContent = type === 'in'
    ? `✓ 已匯出 ${rows.length} 筆進貨紀錄(${sheetEntries.length} 個分頁):${filename}`
    : `✓ 已匯出 ${summaryText} 筆彙總品項(來自 ${rows.length} 筆原始紀錄,${sheetEntries.length} 個分頁):${filename}`;
}

// 把一批出貨/入庫紀錄(rows)整理成一個分頁。mergeParties=true(彙總分頁)時,同一個商品不分對象加總成一筆;
// false 時維持「同一對象 + 同一商品」加總成一筆。回傳 { ws, groupCount }。
function buildShipmentSheet(rows, shopLabel, mergeParties, ctx){
  const { type, meta, productMap, dateLabel } = ctx;

  // aggregate: same party + same product within the selected period gets summed into one line
  //
  // 商品如果勾選了「已完成訂單匯出不顯示」,這裡的行為要跟已完成訂單匯出一致——但只套用在
  // 「跟訂單有關」的紀錄上(t.orderId 有值),跟訂單無關的手動登記出貨(沒有 orderId)不受這個
  // 設定影響,因為那些本來就不是「已完成訂單」的出貨。
  //   ·「僅顯示切換的批量商品數量」(預設模式):這筆紀錄不算在主商品自己身上,改成去查對應
  //     訂單品項的 fulfilledViaSwitch,把切換用掉的批量商品數量算在批量商品自己身上——用
  //     processedSwitchKeys 記錄「這張訂單的這個商品」是否已經處理過,避免同一張訂單如果被拆成
  //     好幾筆交易紀錄(例如原始出貨+後續修改),同一筆切換紀錄被重複算好幾次。
  //   ·「整個家族商品都不顯示」:這筆紀錄整個跳過,不出現在報表裡任何地方。
  const wholeFamilyHiddenIdsForShipment = new Set();
  products.forEach(p => {
    if(!p.parentId && p.hideFromCompletedOrderExport && p.hideFromCompletedOrderExportMode === 'wholeFamily'){
      wholeFamilyHiddenIdsForShipment.add(p.id);
      getChildProducts(p.id).forEach(c => wholeFamilyHiddenIdsForShipment.add(c.id));
    }
  });
  const processedSwitchKeys = new Set();
  const groups = {};
  function addToShipmentGroup(partyVal, productId, qty){
    const effectiveParty = mergeParties ? '' : (partyVal || '');
    const key = effectiveParty + '||' + productId;
    if(!groups[key]) groups[key] = { party: effectiveParty, productId, qty: 0 };
    groups[key].qty += qty;
  }
  rows.forEach(t => {
    const p = productMap[t.productId];
    if(type !== 'pending' && wholeFamilyHiddenIdsForShipment.has(t.productId)) return; // 整個家族都不顯示(待處理訂單不套用「已完成訂單匯出不顯示」)

    if(type === 'out' && t.orderId && p && p.hideFromCompletedOrderExport && !p.parentId){
      const switchKey = t.orderId + '||' + t.productId;
      if(!processedSwitchKeys.has(switchKey)){
        processedSwitchKeys.add(switchKey);
        const order = orders.find(o => o.id === t.orderId);
        const orderItem = order ? order.items.find(it => it.productId === t.productId) : null;
        (orderItem && orderItem.fulfilledViaSwitch || []).forEach(sw => {
          if(wholeFamilyHiddenIdsForShipment.has(sw.childId)) return;
          addToShipmentGroup(t.party, sw.childId, sw.childQty);
        });
      }
      return; // 主商品自己完全不計入,不管切換紀錄有沒有找到
    }

    addToShipmentGroup(t.party, t.productId, t.qty);
  });
  const aggregated = Object.values(groups);

  // group aggregated lines by category (following the app's category order), matching the
  // uploaded template's structure of a QTY/Unit sub-header row before each category block
  const byCategory = {};
  aggregated.forEach(g => {
    const p = productMap[g.productId];
    const cat = p ? (p.category || '未分類') : '未分類';
    if(!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(g);
  });

  const catList = categoryOrder.filter(c => byCategory[c]);
  Object.keys(byCategory).forEach(c => { if(!catList.includes(c)) catList.push(c); });

  const aoa = [];
  aoa.push(['SKU','QTY','Unit','Name','Unit/CTN',meta.partyCol,'Date','Category','Note']);
  aoa.push(['Shop:', shopLabel, null, null, null, null, null, null, null]);
  aoa.push(['Date:', dateLabel, null, null, null, null, null, null, null]);
  aoa.push([null, null, null, null, null, null, null, null, null]);

  catList.forEach(cat => {
    const items = byCategory[cat];
    if(!items || items.length === 0) return;
    aoa.push([null,'QTY','Unit', null, null, null, null, null, null]);
    items
      .sort((a,b) => {
        const pa = productMap[a.productId], pb = productMap[b.productId];
        return (pa ? pa.name : '').localeCompare(pb ? pb.name : '');
      })
      .forEach(g => {
        const p = productMap[g.productId];
        aoa.push([
          p && p.sku ? p.sku : '',
          g.qty,
          p ? p.unit : '',
          p ? p.name : '(deleted product)',
          '',
          g.party,
          dateLabel,
          catLabelEN(cat),
          ''
        ]);
      });
    aoa.push([null, null, null, null, null, null, null, null, null]);
  });

  // 底下註明這份彙總報表實際包含哪幾張訂單(訂單編號),方便日後對帳時回頭查是哪幾張訂單
  // 貢獻了這些數字——只收集真的有帶 orderId、而且那張訂單目前還查得到的紀錄,系統自動產生、
  // 跟訂單無關的紀錄(不會出現在 rows 裡,前面已經篩掉了)不會被算進去。
  const orderNos = [...new Set(
    rows.map(t => t.orderId).filter(Boolean)
      .map(oid => { const o = orders.find(x => x.id === oid); return o ? o.orderNo : null; })
      .filter(Boolean)
  )].sort();
  if(orderNos.length > 0){
    // SKU 這欄現在已經是顯示出來的了(不再是隱藏欄),放在這裡(第 1 欄)才會靠左對齊,
    // 不用再刻意閃避去放到 Name 欄。orderNo 本身(formatOrderNo 產生的)就已經帶有 # 開頭了,
    // 這裡不能再加一次 #,不然會變成 ##000001 這種重複的雙井字號。
    aoa.push([`This file includes the following orders: ${orderNos.join(', ')}`]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    {wch:16},                // SKU
    {wch:8},                // QTY
    {wch:8},                // Unit
    {wch:32},               // Name
    {wch:14},               // Unit/CTN
    {wch:14, hidden:true},  // Customer/Supplier/Source
    {wch:12, hidden:true},  // Date
    {wch:20, hidden:true},  // Category
    {wch:16}                // Note
  ];
  ws['!rows'] = [{ hidden: true }]; // hide the column-header row (metadata rows below still show Shop/Date)
  return { ws, groupCount: aggregated.length };
}

// 進貨(type='in')專用的分頁——跟出貨/入庫共用的那套「Shop:/Date: 表頭 + 依商品彙總數量」邏輯
// 不一樣,原因是:(1) 進貨方本來就不是「Shop」,用同一套表頭措辭不準確;(2) 匯出一段時間的進貨
// 紀錄時,同一個商品在不同時間點可能是跟不同的供應商、不同的 Invoice 進的貨,彙總成一筆會把
// 這些細節混在一起、也沒辦法各自對應到一個 Invoice 號碼——所以這裡完全不彙總,每一筆進貨
// 交易紀錄各自佔一列,各自帶自己的進貨方/Invoice號/日期。
function buildStockInSheet(rows, productMap){
  const sorted = rows.slice().sort((a, b) => {
    if(a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
    const pa = productMap[a.productId], pb = productMap[b.productId];
    return (pa ? pa.name : '').localeCompare(pb ? pb.name : '');
  });

  const aoa = [];
  aoa.push(['SKU', 'Name', 'Qty', 'Unit', 'Supplier', 'Invoice No.', 'Date']);
  sorted.forEach(t => {
    const p = productMap[t.productId];
    aoa.push([
      p && p.sku ? p.sku : '',
      p ? p.name : '(deleted product)',
      t.qty,
      p ? p.unit : '',
      t.party || '',
      t.invoiceNo || '',
      t.date || ''
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    {wch:10}, // SKU
    {wch:32}, // Name
    {wch:8},  // Qty
    {wch:10}, // Unit
    {wch:18}, // Supplier
    {wch:16}, // Invoice No.
    {wch:12}  // Date
  ];
  return ws;
}
