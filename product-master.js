// ============================================================
// 商品主檔管理(System Admin → Product Master)——手動新增單一
// 商品、從 Excel 匯入/更新商品主檔(品名/單位/庫存量/平均使用量/
// 分類/安全庫存)、匯入後只重套分類等中繼資料不動庫存量。跟
// 登記進出貨自己的 Excel 匯入(parseTxExcel,在 transactions.js)
// 是兩個完全不同的功能,欄位格式、用途都不一樣。
//
// fileKey() 這個小工具兩邊都會用到(這裡的 addMasterFiles、
// transactions.js 的 addTxFiles),放這裡,transactions.js 那邊
// 一樣共用同一份全域作用域抓得到。
// ============================================================
async function addProduct(){
  const skuEl = document.getElementById('newProductSku');
  const nameEl = document.getElementById('newProductName');
  const unitEl = document.getElementById('newProductUnit');
  const avgEl = document.getElementById('newProductAvg');
  const catEl = document.getElementById('newProductCategory');
  const safetyEl = document.getElementById('newProductSafety');
  const noteEl = document.getElementById('newProductNote');
  const orderPageRemarkEl = document.getElementById('newProductOrderPageRemark');
  const msg = document.getElementById('productMsg');
  const sku = skuEl.value.trim();
  const name = nameEl.value.trim();
  const unit = unitEl.value.trim() || '個';
  const category = catEl.value || '未分類';
  const avgVal = avgEl.value.trim() === '' ? null : parseFloat(avgEl.value);
  const safetyVal = safetyEl.value.trim() === '' ? null : parseFloat(safetyEl.value);
  const note = noteEl.value.trim();
  const orderPageRemark = orderPageRemarkEl ? orderPageRemarkEl.value.trim() : '';

  if(!name){ msg.className='msg error'; msg.textContent='請輸入商品名稱'; return; }
  if(products.some(p => p.name === name)){ msg.className='msg error'; msg.textContent='這個商品名稱已經存在'; return; }

  products.push({
    id: genId(), sku, name, unit, category,
    manualAvg: (avgVal !== null && !isNaN(avgVal)) ? avgVal : null,
    safetyStock: (safetyVal !== null && !isNaN(safetyVal)) ? safetyVal : null,
    note, orderPageRemark: orderPageRemark || undefined, orderable: false, parentId: null, childWeight: null
  });
  await saveProducts();
  skuEl.value = ''; nameEl.value = ''; unitEl.value = ''; avgEl.value = ''; safetyEl.value = ''; noteEl.value = '';
  if(orderPageRemarkEl) orderPageRemarkEl.value = '';
  msg.className='msg ok'; msg.textContent = `✓ 已新增「${name}」`;
  renderAll();
}

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
