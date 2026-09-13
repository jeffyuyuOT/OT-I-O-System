// ============================================================
// 庫存分布(Stock Location)——商品目前分布在哪些位置的查詢/編輯,
// 涵蓋:商品下拉選單(依分類篩選)、單一商品detail/「列出所有
// 未指派商品」清單這兩種畫面互相切換、位置轉移(編輯位置視窗)、
// 位置指派選單(轉換視窗共用)、掃碼槍支援(掃到位置條碼自動
// 帶入欄位/反查某位置有哪些商品)、核對訂單/送出登記進出貨時
// 「要扣哪個位置」的選擇邏輯(resolveLocationChoicesForItems /
// applyLocationDeductions,orders.js、transactions.js 都會呼叫)。
//
// computeStock()/computeUnassignedQty() 這類被其他好幾個模組共用
// 的核心工具函式故意留在主程式,不算這裡。
// ============================================================
// 這個商品所有「有庫存的位置」,按數量由多到少排序——數量最多的那個是「主要位置」。
// 未分布不算是位置(這個 function 只回傳真正的位置資料,不含未分布),呼叫端如果要含未分布,
// 自己另外加在最後面(未分布規定永遠排最後,不能被當成主要位置)。
function getSortedLocationsForProduct(productId){
  return productLocations
    .filter(l => l.productId === productId && l.qty > 0)
    .sort((a, b) => b.qty - a.qty);
}
// 這個商品目前的「主要位置」:庫存最多的那個真正的位置。未分布不算數,就算未分布數量比任何
// 位置都多,也不會被當成主要位置——完全沒有任何真正的位置資料時回傳 null。
function getPrimaryLocation(productId){
  const sorted = getSortedLocationsForProduct(productId);
  return sorted.length > 0 ? sorted[0] : null;
}


// 庫存分布頁面:商品下拉選單(可依分類篩選、支援搜尋),選了商品之後畫出這個商品目前分布在
// 哪些位置、各自的數量,加上「未分布」那一列(用 computeUnassignedQty 即時算,不是存在資料庫
// 裡的一筆資料)。
function renderStockLocationProductSelect(){
  syncCategoryOrder();
  const catSel = document.getElementById('stockLocationCategoryFilter');
  const prevCat = catSel.value;
  const usedCats = categoryOrder.filter(c => products.some(p => (p.category || '未分類') === c));
  catSel.innerHTML = `<option value="">${t('catFilterAll')}</option>` +
    usedCats.map(c => `<option value="${c}">${catLabel(c)}</option>`).join('');
  if(usedCats.includes(prevCat)) catSel.value = prevCat;
  const catFilterVal = catSel.value;

  const sel = document.getElementById('stockLocationProductSelect');
  const prevVal = sel.value;
  const bulkCheckbox = document.getElementById('stockLocationShowAllUnassigned');
  const isBulkMode = bulkCheckbox && bulkCheckbox.checked;
  let filteredProducts = (catFilterVal ? products.filter(p => (p.category || '未分類') === catFilterVal) : products)
    .filter(p => !p.hidden);
  // 勾選「列出所有未指派商品」時,這個下拉選單也只列出真的還有未分布庫存的商品——不然選單裡
  // 明明列著一個已經全部指派完位置的商品,選了卻跟畫面上那份「未指派清單」對不起來,容易誤導。
  if(isBulkMode) filteredProducts = filteredProducts.filter(p => computeUnassignedQty(p.id) > 0);
  sel.innerHTML = '<option value=""></option>' + filteredProducts.slice().sort(compareProductsBySortMode).map(p => `<option value="${p.id}">${p.sku ? p.sku + ' — ' : ''}${p.parentId ? '⧉ ' : ''}${p.name}(${p.unit})</option>`).join('');
  if(filteredProducts.some(p => p.id === prevVal)) sel.value = prevVal;

  makeSelectSearchable('stockLocationProductSelect');
  refreshStockLocationView();
}

// 掃碼槍在庫存分布頁面掃到商品時呼叫:直接跳去顯示這個商品的位置分布,不用手動搜尋。
function jumpToProductInStockLocation(p){
  const catSel = document.getElementById('stockLocationCategoryFilter');
  if(catSel) catSel.value = '';
  renderStockLocationProductSelect();
  const sel = document.getElementById('stockLocationProductSelect');
  if(sel) sel.value = p.id;
  renderStockLocationDetail();
}

// 「列出所有未指派商品」:勾選後把單一商品的詳細畫面換成一份清單(依目前的分類篩選,列出
// 所有還有未分布庫存的商品),商品下拉選單這時候選哪個都沒意義,所以鎖住不能選,避免使用者
// 誤以為要先選商品才看得到清單。取消勾選就切回原本「選一項商品看詳細」的畫面。
function toggleStockLocationBulkView(checked){
  // 這裡不再整個鎖住商品選單不能選(disabled)——改成讓選單本身依照勾選狀態,只列出真的
  // 有未分布庫存的商品(見 renderStockLocationProductSelect),選單裡看得到的每一項都真的
  // 對應目前這份未指派清單,不會出現「選了卻跟清單對不起來」的商品。
  resetSearchableSelect('stockLocationProductSelect');
  renderStockLocationProductSelect();
}

// 位置轉移/照片上傳成功之後要重新畫面——但畫面現在是「單一商品詳細」還是「未指派清單」,
// 要看目前那個勾選框的狀態,不能一律都畫單一商品詳細(不然從清單畫面編輯完,畫面會突然
// 跳成單一商品畫面,很奇怪)。
function refreshStockLocationView(){
  const bulkCheckbox = document.getElementById('stockLocationShowAllUnassigned');
  const sel = document.getElementById('stockLocationProductSelect');
  // 勾了「列出所有未指派商品」不代表商品欄位就完全沒作用——選單本身還是可以選一個特定商品
  // (畫面上會過濾成只列出真的有未分布庫存的商品),選了就是要看那個商品的詳細分布,這時候
  // 應該顯示那個商品的詳細畫面,不是硬顯示整份清單。只有「勾選了、而且沒有選任何特定商品」
  // 才顯示整份未指派清單。
  if(bulkCheckbox && bulkCheckbox.checked && (!sel || !sel.value)) renderStockLocationBulkUnassignedList();
  else renderStockLocationDetail();
}

// 掃碼槍支援(情境二):在庫存分布頁面(不是在編輯視窗裡)掃到一個對不到任何商品條碼/SKU 的碼,
// 當成「位置條碼」反查——列出這個位置代碼目前實際登記了哪些商品、各自多少數量。用途是站在
// 貨架前掃一下,就知道這個位置照系統紀錄「應該」放什麼,拿來核對現場實際擺放的東西有沒有放錯。
// 這個位置目前完全沒有任何商品登記(可能是條碼掃錯、或這個位置本來就還沒指派過任何東西),
// 一樣會顯示出來,清楚告訴使用者「查過了,沒有任何商品登記在這裡」,不是掃描失敗。
function showProductsAtLocation(code){
  const bulkCheckbox = document.getElementById('stockLocationShowAllUnassigned');
  if(bulkCheckbox) bulkCheckbox.checked = false;
  const sel = document.getElementById('stockLocationProductSelect');
  if(sel) sel.value = '';
  const container = document.getElementById('stockLocationDetail');
  if(!container) return;

  const rows = productLocations
    .filter(l => l.locationCode === code)
    .map(l => ({ p: products.find(x => x.id === l.productId), loc: l }))
    .filter(r => r.p)
    .sort((a, b) => a.p.name.localeCompare(b.p.name));

  container.innerHTML = `
    <div style="margin-top:14px;">
      <div style="font-weight:700;margin-bottom:8px;">${tf('locationLookupTitle', { code: escapeHtmlForPrint(code) })}</div>
      ${rows.length === 0 ? `<div class="empty-note">${t('locationLookupEmptyHint')}</div>` : `
      <table class="stock-table">
        <thead><tr><th>SKU</th><th>${t('lblProduct')}</th><th class="num">${t('colQty')}</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><td>${escapeHtmlForPrint(r.p.sku || '—')}</td><td>${escapeHtmlForPrint(r.p.name)}</td><td class="num">${r.loc.qty} ${escapeHtmlForPrint(r.p.unit)}</td></tr>`).join('')}
        </tbody>
      </table>
      `}
    </div>
  `;
}

function renderStockLocationBulkUnassignedList(){
  const container = document.getElementById('stockLocationDetail');
  if(!container) return;
  const catFilterVal = document.getElementById('stockLocationCategoryFilter').value;
  const candidateProducts = (catFilterVal ? products.filter(p => (p.category || '未分類') === catFilterVal) : products)
    .filter(p => !p.hidden);
  const rows = candidateProducts
    .map(p => ({ p, unassigned: computeUnassignedQty(p.id) }))
    .filter(r => r.unassigned > 0)
    .sort((a, b) => a.p.name.localeCompare(b.p.name));

  if(rows.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noUnassignedProductsHint')}</div>`;
    return;
  }
  container.innerHTML = `
    <table class="stock-table" style="margin-top:14px;">
      <thead><tr><th>SKU</th><th>${t('lblProduct')}</th><th class="num">${t('unassignedLocationLabel')}</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtmlForPrint(r.p.sku || '—')}</td>
            <td>${escapeHtmlForPrint(r.p.name)}</td>
            <td class="num">${r.unassigned} ${escapeHtmlForPrint(r.p.unit)}</td>
            <td><span class="del-link" onclick="openLocationEditModal(null, '${r.p.id}')">${t('btnEdit')}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderStockLocationDetail(){
  const container = document.getElementById('stockLocationDetail');
  if(!container) return;
  const sel = document.getElementById('stockLocationProductSelect');
  const productId = sel ? sel.value : '';
  if(!productId){
    container.innerHTML = `<div class="empty-note">${t('stockLocationSelectProductHint')}</div>`;
    return;
  }
  const p = products.find(x => x.id === productId);
  if(!p){ container.innerHTML = ''; return; }

  const totalStock = computeStock(productId);
  const locs = getSortedLocationsForProduct(productId);
  const primaryId = locs.length > 0 ? locs[0].id : null;
  const unassigned = computeUnassignedQty(productId);

  const rowsHtml = locs.map(l => `
    <tr>
      <td ${l.photoUrl ? `style="cursor:pointer;color:var(--ink);" onclick="viewLocationPhoto('${l.id}')" title="${t('clickToViewPhoto')}"` : ''}>${l.photoUrl ? '📷 ' : ''}${escapeHtmlForPrint(l.locationCode)}${l.id === primaryId ? ` <span style="font-size:10.5px;color:var(--ink-soft);text-transform:uppercase;font-weight:700;">${t('primaryLocationBadge')}</span>` : ''}</td>
      <td class="num">${l.qty} ${escapeHtmlForPrint(p.unit)}</td>
      <td><span class="del-link" onclick="openLocationEditModal('${l.id}')">${t('btnEdit')}</span></td>
    </tr>
  `).join('');
  const unassignedRow = `
    <tr>
      <td style="color:var(--ink-soft);font-style:italic;">${t('unassignedLocationLabel')}</td>
      <td class="num">${unassigned} ${escapeHtmlForPrint(p.unit)}</td>
      <td><span class="del-link" onclick="openLocationEditModal(null, '${productId}')">${t('btnEdit')}</span></td>
    </tr>
  `;

  container.innerHTML = `
    <div class="section" style="margin-top:14px;padding:16px 20px;">
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:14px;">
        <div><span style="font-size:11px;color:var(--ink-soft);text-transform:uppercase;font-weight:700;">SKU</span><br>${escapeHtmlForPrint(p.sku || '—')}</div>
        <div><span style="font-size:11px;color:var(--ink-soft);text-transform:uppercase;font-weight:700;">${t('lblProduct')}</span><br>${escapeHtmlForPrint(p.name)}</div>
        <div><span style="font-size:11px;color:var(--ink-soft);text-transform:uppercase;font-weight:700;">${t('colStock')}</span><br>${totalStock} ${escapeHtmlForPrint(p.unit)}</div>
      </div>
      <table class="stock-table">
        <thead><tr><th>${t('colLocation')}</th><th class="num">${t('colQty')}</th><th></th></tr></thead>
        <tbody>${rowsHtml}${unassignedRow}</tbody>
      </table>
    </div>
  `;
}

// 位置的「編輯」視窗:同一個視窗處理兩種情境——(1) 編輯一個已經存在的位置(locationId 有值):
// 可以看目前的位置/數量、可以上傳這個位置的照片、也可以把這個位置的部分或全部數量轉移到別的
// 位置。(2) 從「未分布」指派到某個位置(locationId 是 null、只給 productId):未分布不是真的一筆
// 資料,沒有照片可以傳,直接問要轉移(指派)多少數量到哪個新位置。
let locationEditTargetId = null;
let locationEditProductId = null;
let pendingLocationPhotoUrl = null;

// 轉移目的地下拉選單的選項:這個商品現有的位置(照數量由多到少排序,主要位置有標記)放最前面、
// 「未指派」固定放中間、「+ 新增位置」固定放最後。source(如果是編輯一個已存在的位置)自己
// 不會出現在選項裡——不能轉移到自己身上。
function buildLocationTargetOptions(productId, excludeLocationId){
  const locs = getSortedLocationsForProduct(productId).filter(l => l.id !== excludeLocationId);
  const options = locs.map(l => ({ value: 'loc:' + l.id, label: `${l.locationCode}${l === locs[0] ? ` (${t('primaryLocationBadge')})` : ''} — ${l.qty}` }));
  options.push({ value: 'unassigned', label: t('unassignedLocationLabel') });
  options.push({ value: 'new', label: t('optAddNewLocation') });
  // 這個商品目前完全沒有真正的位置資料(全部未分布)的話,如果之前記錄過「最後一次的主要
  // 位置」,在最下面提示一個選項,選了直接把新增位置的欄位都帶入那組舊的位置資訊。
  const p = products.find(x => x.id === productId);
  if(locs.length === 0 && p && p.lastPrimaryLocation && p.lastPrimaryLocation.locationCode){
    options.push({ value: 'lastPrimary', label: `${p.lastPrimaryLocation.locationCode} (${t('lastPrimaryBadge')})` });
  }
  return options;
}
function populateLocationTargetSelect(productId, excludeLocationId, defaultValue){
  const sel = document.getElementById('locationTargetSelect');
  const options = buildLocationTargetOptions(productId, excludeLocationId);
  sel.innerHTML = options.map(o => `<option value="${o.value}">${escapeHtmlForPrint(o.label)}</option>`).join('');
  sel.value = defaultValue;
  onLocationTargetSelectChange();
}
// 標準模式下,依系統設置勾選的欄位,把沒勾的那幾個 Zone/Aisle/Bay/Level/Bin 欄位藏起來——
// 「編輯位置」視窗跟切換商品的「指派位置」共用這支,idPrefix 分別是 'location' 跟 'conversionLoc'。
function applyStockLocationFieldVisibility(idPrefix){
  const fieldIds = { zone: 'Zone', aisle: 'Aisle', bay: 'Bay', level: 'Level', bin: 'Bin' };
  Object.keys(fieldIds).forEach(k => {
    const wrap = document.getElementById(idPrefix + fieldIds[k] + 'Wrap');
    if(wrap) wrap.style.display = (stockLocationEnabledFields[k] !== false) ? '' : 'none';
  });
}

// 標準模式下,系統設置裡有勾選(啟用)的欄位一律必填——只要有一格空白,就回傳缺了哪幾個欄位
// (固定用英文欄位名 Zone/Aisle/Bay/Level/Bin,兩個語言都看得懂,不用另外翻譯),外面負責顯示
// 紅字並擋掉儲存。理由:以前空白欄位會被直接跳過、接下去的欄位照樣接成一個「看起來正常」的
// 位置代碼(例如少了 Bay 就變成 Zone-Aisle-Level-Bin),事後完全看不出來漏填了哪一格,也不知道
// 這個位置實際上對不對得上真實的貨架。自訂模式沒有這個限制(回傳空陣列,永遠不擋)。
// idPrefix/suffix:這幾個欄位輸入框的 id 命名在兩個地方不太一樣——庫存分布頁面的「編輯位置」
// 視窗固定是 location + 欄位名 + Input(例如 locationZoneInput),呼叫時不用傳參數(用預設值);
// 切換批量商品數量視窗裡的位置指派是 idPrefix + 欄位名、沒有 Input 後綴(例如 conversionLocZone),
// 呼叫時傳 idPrefix='conversionLoc', suffix=''。
function getMissingStandardLocationFields(idPrefix, suffix){
  if(stockLocationMode === 'custom') return [];
  idPrefix = idPrefix || 'location';
  suffix = suffix === undefined ? 'Input' : suffix;
  const fieldNames = { zone: 'Zone', aisle: 'Aisle', bay: 'Bay', level: 'Level', bin: 'Bin' };
  const missing = [];
  Object.keys(fieldNames).forEach(k => {
    if(stockLocationEnabledFields[k] === false) return; // 這個欄位沒啟用,不用填
    const el = document.getElementById(idPrefix + fieldNames[k] + suffix);
    if(el && !el.value.trim()) missing.push(fieldNames[k]);
  });
  return missing;
}

// 掃碼槍支援(情境一):貨架位置上如果貼的條碼就是印這組 Zone-Aisle-Bay-Level-Bin 代碼本身
// (跟 buildLocationCode() 存的格式一樣,用「-」接起來),掃到之後直接把對應欄位自動填好,
// 不用一格一格手動打、也不會打錯。段數必須剛好對上系統設置裡目前有啟用的欄位數量才會生效——
// 系統設置可以選擇只啟用其中幾個欄位(例如只開 Zone/Bay/Bin,不開 Aisle/Level),所以欄位
// 的「順序」固定是 Zone→Aisle→Bay→Level→Bin,但實際會用到的「數量」要看系統設置,不能寫死
// 一定是 5 段,不然自訂啟用較少欄位的倉庫,掃描永遠對不上格式。
// 回傳 true 代表成功帶入,false 代表段數對不上(不是合法的位置代碼格式,呼叫端要自己決定怎麼
// 提示使用者)。
function parseLocationCodeIntoFields(code, idPrefix, suffix){
  if(stockLocationMode === 'custom') return false;
  idPrefix = idPrefix || 'location';
  suffix = suffix === undefined ? 'Input' : suffix;
  const fieldNames = { zone: 'Zone', aisle: 'Aisle', bay: 'Bay', level: 'Level', bin: 'Bin' };
  const enabledKeys = Object.keys(fieldNames).filter(k => stockLocationEnabledFields[k] !== false);
  const parts = code.split('-').map(s => s.trim()).filter(Boolean);
  if(parts.length !== enabledKeys.length || parts.length === 0) return false;
  enabledKeys.forEach((k, i) => {
    const el = document.getElementById(idPrefix + fieldNames[k] + suffix);
    if(el) el.value = parts[i];
  });
  return true;
}

function onLocationTargetSelectChange(){
  const sel = document.getElementById('locationTargetSelect');
  const isLastPrimary = sel.value === 'lastPrimary';
  const isNew = sel.value === 'new' || isLastPrimary;
  const standardWrap = document.getElementById('locationStandardFieldsWrap');
  const customWrap = document.getElementById('locationCustomFieldWrap');
  standardWrap.style.display = (isNew && stockLocationMode !== 'custom') ? 'grid' : 'none';
  customWrap.style.display = (isNew && stockLocationMode === 'custom') ? 'block' : 'none';
  if(isNew && stockLocationMode !== 'custom') applyStockLocationFieldVisibility('location');
  if(isLastPrimary){
    const p = products.find(x => x.id === locationEditProductId);
    const last = p && p.lastPrimaryLocation;
    if(last){
      document.getElementById('locationZoneInput').value = last.zone || '';
      document.getElementById('locationAisleInput').value = last.aisle || '';
      document.getElementById('locationBayInput').value = last.bay || '';
      document.getElementById('locationLevelInput').value = last.level || '';
      document.getElementById('locationBinInput').value = last.bin || '';
      document.getElementById('locationCustomCodeInput').value = last.locationCode || '';
    }
  }
}

// 通用版的位置選擇器,給「編輯位置」以外的地方用(目前是切換商品的「指派位置」)——一樣是
// 下拉選單(現有位置+未指派+新增位置),用 idPrefix 分開各自的 DOM id,避免跟編輯位置視窗的
// id 撞在一起。這裡故意不含「轉移數量」欄位,因為切換是「憑空生出新庫存」,不是「從某個地方
// 搬到另一個地方」,選了位置只是說這批新庫存要放哪,不需要輸入要「拿走多少」。
function buildLocationPickerHtml(idPrefix, labelKey){
  return `
    <div class="field-block">
      <label>${t(labelKey)}</label>
      <select id="${idPrefix}Select" onchange="onLocationPickerTargetChange('${idPrefix}')" style="width:100%;"></select>
    </div>
    <div id="${idPrefix}StandardWrap" class="form-grid" style="display:none;grid-template-columns:1fr 1fr 1fr 1fr 1fr;margin-bottom:0;">
      <div class="field" id="${idPrefix}ZoneWrap"><label>Zone</label><input type="text" id="${idPrefix}Zone" style="width:100%;" /></div>
      <div class="field" id="${idPrefix}AisleWrap"><label>Aisle</label><input type="text" id="${idPrefix}Aisle" style="width:100%;" /></div>
      <div class="field" id="${idPrefix}BayWrap"><label>Bay</label><input type="text" id="${idPrefix}Bay" style="width:100%;" /></div>
      <div class="field" id="${idPrefix}LevelWrap"><label>Level</label><input type="text" id="${idPrefix}Level" style="width:100%;" /></div>
      <div class="field" id="${idPrefix}BinWrap"><label>Bin</label><input type="text" id="${idPrefix}Bin" style="width:100%;" /></div>
    </div>
    <div id="${idPrefix}CustomWrap" class="field-block" style="display:none;">
      <label>${t('fieldLocationCode')}</label>
      <input type="text" id="${idPrefix}CustomCode" style="width:100%;" />
    </div>
  `;
}
function populateLocationPicker(idPrefix, productId){
  const sel = document.getElementById(idPrefix + 'Select');
  if(!sel) return;
  sel.dataset.productId = productId;
  const options = buildLocationTargetOptions(productId, null);
  sel.innerHTML = options.map(o => `<option value="${o.value}">${escapeHtmlForPrint(o.label)}</option>`).join('');
  const primary = getPrimaryLocation(productId);
  sel.value = primary ? 'loc:' + primary.id : 'new';
  onLocationPickerTargetChange(idPrefix);
}
function onLocationPickerTargetChange(idPrefix){
  const sel = document.getElementById(idPrefix + 'Select');
  const isLastPrimary = sel.value === 'lastPrimary';
  const isNew = sel.value === 'new' || isLastPrimary;
  document.getElementById(idPrefix + 'StandardWrap').style.display = (isNew && stockLocationMode !== 'custom') ? 'grid' : 'none';
  document.getElementById(idPrefix + 'CustomWrap').style.display = (isNew && stockLocationMode === 'custom') ? 'block' : 'none';
  if(isNew && stockLocationMode !== 'custom') applyStockLocationFieldVisibility(idPrefix);
  if(isLastPrimary){
    const p = products.find(x => x.id === sel.dataset.productId);
    const last = p && p.lastPrimaryLocation;
    if(last){
      document.getElementById(idPrefix + 'Zone').value = last.zone || '';
      document.getElementById(idPrefix + 'Aisle').value = last.aisle || '';
      document.getElementById(idPrefix + 'Bay').value = last.bay || '';
      document.getElementById(idPrefix + 'Level').value = last.level || '';
      document.getElementById(idPrefix + 'Bin').value = last.bin || '';
      document.getElementById(idPrefix + 'CustomCode').value = last.locationCode || '';
    }
  }
}
function buildLocationCodeFromPicker(idPrefix){
  if(stockLocationMode === 'custom') return document.getElementById(idPrefix + 'CustomCode').value.trim();
  const zone = document.getElementById(idPrefix + 'Zone').value.trim();
  const aisle = document.getElementById(idPrefix + 'Aisle').value.trim();
  const bay = document.getElementById(idPrefix + 'Bay').value.trim();
  const level = document.getElementById(idPrefix + 'Level').value.trim();
  const bin = document.getElementById(idPrefix + 'Bin').value.trim();
  return [zone, aisle, bay, level, bin].filter(Boolean).join('-');
}
// 切換確認之後呼叫:把這批新增出來的庫存(convertedQty)加到使用者選的位置上——選「未指派」
// 什麼都不用做(新庫存本來就會自動算成未分布)。選「新增位置」的話,要先檢查有沒有填完整,
// 沒填的話視為沒選位置,一樣什麼都不做(新庫存留在未分布,使用者之後可以自己去庫存分布頁面
// 指派)。
async function applyConversionLocationAssignment(idPrefix, productId, qty){
  const sel = document.getElementById(idPrefix + 'Select');
  if(!sel) return;
  const targetVal = sel.value;
  if(targetVal === 'unassigned') return;
  let destLoc = null;
  let newCode = null;
  if(targetVal.startsWith('loc:')){
    destLoc = productLocations.find(l => l.id === targetVal.slice(4));
  } else if(targetVal === 'new' || targetVal === 'lastPrimary'){
    newCode = buildLocationCodeFromPicker(idPrefix);
    if(!newCode) return; // 沒填完整位置資訊,當作沒選,新庫存留在未分布
    destLoc = productLocations.find(l => l.productId === productId && l.locationCode === newCode);
  }
  try{
    if(destLoc){
      destLoc.qty += qty;
      await upsertProductLocation(destLoc);
    } else if(newCode){
      const zone = document.getElementById(idPrefix + 'Zone') ? document.getElementById(idPrefix + 'Zone').value.trim() : '';
      const aisle = document.getElementById(idPrefix + 'Aisle') ? document.getElementById(idPrefix + 'Aisle').value.trim() : '';
      const bay = document.getElementById(idPrefix + 'Bay') ? document.getElementById(idPrefix + 'Bay').value.trim() : '';
      const level = document.getElementById(idPrefix + 'Level') ? document.getElementById(idPrefix + 'Level').value.trim() : '';
      const bin = document.getElementById(idPrefix + 'Bin') ? document.getElementById(idPrefix + 'Bin').value.trim() : '';
      const newLoc = { id: genId(), productId, zone, aisle, bay, level, bin, locationCode: newCode, qty, photoUrl: null };
      productLocations.push(newLoc);
      await upsertProductLocation(newLoc);
    }
  } catch(e){ console.error('切換後指派位置失敗', e); }
}

function buildLocationCode(){
  if(stockLocationMode === 'custom'){
    return document.getElementById('locationCustomCodeInput').value.trim();
  }
  const zone = document.getElementById('locationZoneInput').value.trim();
  const aisle = document.getElementById('locationAisleInput').value.trim();
  const bay = document.getElementById('locationBayInput').value.trim();
  const level = document.getElementById('locationLevelInput').value.trim();
  const bin = document.getElementById('locationBinInput').value.trim();
  return [zone, aisle, bay, level, bin].filter(Boolean).join('-');
}

function openLocationEditModal(locationId, productIdIfNew){
  locationEditTargetId = locationId || null;
  locationEditProductId = locationId ? (productLocations.find(l => l.id === locationId) || {}).productId : productIdIfNew;
  pendingLocationPhotoUrl = null;

  const photoSection = document.getElementById('locationEditPhotoSection');
  const photoPreviewWrap = document.getElementById('locationEditPhotoPreviewWrap');
  const photoMsg = document.getElementById('locationEditPhotoMsg');
  photoMsg.textContent = '';
  document.getElementById('locationEditModalMsg').textContent = '';
  document.getElementById('locationTransferQtyInput').value = '';
  ['locationZoneInput','locationAisleInput','locationBayInput','locationLevelInput','locationBinInput','locationCustomCodeInput'].forEach(id => {
    document.getElementById(id).value = '';
  });

  // 預設選項一律是「主要位置」(除非主要位置剛好就是正在編輯的來源本身,那樣就沒得選了,
  // 改預設成「+ 新增位置」);完全沒有任何位置資料的商品,直接預設「+ 新增位置」。
  const primary = getPrimaryLocation(locationEditProductId);
  let defaultTarget = 'new';
  if(primary && primary.id !== locationId) defaultTarget = 'loc:' + primary.id;
  populateLocationTargetSelect(locationEditProductId, locationId, defaultTarget);

  if(locationId){
    const loc = productLocations.find(l => l.id === locationId);
    const p = products.find(x => x.id === loc.productId);
    document.getElementById('locationEditCurrentInfo').textContent = tf('locationEditCurrentInfoText', { code: loc.locationCode, qty: loc.qty, unit: p ? p.unit : '' });
    document.getElementById('locationTransferQtyInput').value = loc.qty; // 預設整批轉移,使用者要部分轉移的話自己改小
    photoSection.style.display = 'block';
    if(loc.photoUrl){
      pendingLocationPhotoUrl = loc.photoUrl;
      photoPreviewWrap.innerHTML = `<a href="${loc.photoUrl}" target="_blank" style="font-size:12.5px;">📎 ${t('linkViewUploadedReceipt')}</a>`;
      photoPreviewWrap.style.display = 'block';
    } else {
      photoPreviewWrap.style.display = 'none';
      photoPreviewWrap.innerHTML = '';
    }
  } else {
    const unassigned = computeUnassignedQty(productIdIfNew);
    const p = products.find(x => x.id === productIdIfNew);
    document.getElementById('locationEditCurrentInfo').textContent = tf('locationAssignFromUnassignedText', { qty: unassigned, unit: p ? p.unit : '' });
    document.getElementById('locationTransferQtyInput').value = unassigned; // 預設把未分布的全部數量都指派出去
    // 未分布不是真的一筆位置資料,還沒有位置可以掛照片——這裡上傳的照片先暫存,等按下「確認轉移」
    // 真的建立/更新目的地位置的時候,才會把這張照片存到那個位置上(見 confirmLocationTransfer)。
    photoSection.style.display = 'block';
    photoPreviewWrap.style.display = 'none';
    photoPreviewWrap.innerHTML = '';
  }

  document.getElementById('locationEditModalOverlay').style.display = 'flex';
}

function closeLocationEditModal(){
  locationEditTargetId = null;
  locationEditProductId = null;
  pendingLocationPhotoUrl = null;
  document.getElementById('locationEditModalOverlay').style.display = 'none';
}

async function handleLocationPhotoUpload(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  const msgEl = document.getElementById('locationEditPhotoMsg');
  if(!file.type.startsWith('image/')){
    msgEl.style.color = 'var(--crit)'; msgEl.textContent = t('errPhotoMustBeImage'); inputEl.value = ''; return;
  }
  if(file.size > 5 * 1024 * 1024){
    msgEl.style.color = 'var(--crit)'; msgEl.textContent = t('errPhotoTooLarge'); inputEl.value = ''; return;
  }
  msgEl.style.color = 'var(--ink-soft)'; msgEl.textContent = t('uploadingPhotoMsg');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  // 未分布(locationEditTargetId 是 null)還沒有位置可以掛,先存到一個以商品 id 開頭的暫存路徑,
  // 等按下「確認轉移」真的建立/更新目的地位置的時候,才會把這張照片指定的網址存進那個位置。
  const path = `${locationEditTargetId || 'unassigned_' + locationEditProductId}/${genId()}.${ext}`;
  try{
    const { error } = await sb.storage.from('location-photos').upload(path, file, { upsert: true });
    if(error) throw error;
    const { data } = sb.storage.from('location-photos').getPublicUrl(path);
    pendingLocationPhotoUrl = data.publicUrl;
    if(locationEditTargetId){
      const loc = productLocations.find(l => l.id === locationEditTargetId);
      if(loc){ loc.photoUrl = pendingLocationPhotoUrl; await upsertProductLocation(loc); }
      refreshStockLocationView();
    }
    document.getElementById('locationEditPhotoPreviewWrap').innerHTML = `<a href="${pendingLocationPhotoUrl}" target="_blank" style="font-size:12.5px;">📎 ${t('linkViewUploadedReceipt')}</a>`;
    document.getElementById('locationEditPhotoPreviewWrap').style.display = 'block';
    msgEl.style.color = 'var(--safe)'; msgEl.textContent = t('receiptUploadedMsg');
  } catch(e){
    console.error('上傳位置照片失敗', e);
    msgEl.style.color = 'var(--crit)'; msgEl.textContent = t('errReceiptUploadFailed');
  }
  inputEl.value = '';
}

function viewLocationPhoto(locationId){
  const loc = productLocations.find(l => l.id === locationId);
  if(!loc || !loc.photoUrl) return;
  document.getElementById('locationPhotoViewImg').src = loc.photoUrl;
  document.getElementById('locationPhotoViewModalOverlay').style.display = 'flex';
}
function closeLocationPhotoViewModal(){
  document.getElementById('locationPhotoViewModalOverlay').style.display = 'none';
  document.getElementById('locationPhotoViewImg').src = '';
}

// ===== 訂單核對扣庫存時,問「從哪個位置扣」的邏輯 =====
// 「直接核對」「訂單核對頁面的左右比對確認」兩條路徑最後都會呼叫同一個 verifyOrder(),用的
// 都是訂單自己的品項(order.items),所以只要在 verifyOrder() 裡插這一段,兩條路徑就都涵蓋到了,
// 不用在兩個地方各寫一次。
//
// 支援「湊數量」:如果選的來源不夠這次要扣的量,會把那個來源全部用完,剩下還缺的量自動繼續
// 問(從清單裡排除掉已經用完的來源),直到湊滿為止,不用使用者自己算好每個位置各拿多少。
let locationChoiceResolver = null;
let locationChoiceRejecter = null;
let locationChoiceCurrentOptions = [];

// 這個商品「目前」有庫存的來源清單(位置+未分布),可以用 virtualQtyOverrides 蓋掉某幾個來源的
// 即時數量——同一次「湊數量」的過程裡,選過的來源要扣掉已經拿走的量再問下一輪,不然同一個
// 來源可能被重複算到超過它實際能提供的量。
function getLiveLocationChoicesForProduct(productId, virtualQtyOverrides){
  const overrides = virtualQtyOverrides || {};
  const choices = productLocations
    .filter(l => l.productId === productId)
    .map(l => ({ type: 'location', id: l.id, label: l.locationCode, qty: (overrides[l.id] !== undefined ? overrides[l.id] : l.qty) }))
    .filter(c => c.qty > 0);
  const unassignedQty = overrides.unassigned !== undefined ? overrides.unassigned : computeUnassignedQty(productId);
  if(unassignedQty > 0){
    choices.push({ type: 'unassigned', id: null, label: t('unassignedLocationLabel'), qty: unassignedQty });
  }
  return choices;
}

function promptLocationChoice(product, remainingQty, choices){
  return new Promise((resolve, reject) => {
    locationChoiceResolver = resolve;
    locationChoiceRejecter = reject;
    locationChoiceCurrentOptions = choices;
    document.getElementById('locationChoiceProductInfo').textContent = tf('locationChoiceProductInfoText', { name: product ? product.name : '', qty: remainingQty, unit: product ? product.unit : '' });
    document.getElementById('locationChoiceOptionsWrap').innerHTML = choices.map((c, i) =>
      `<button class="btn ghost" style="text-align:left;" onclick="chooseLocationOption(${i})">${escapeHtmlForPrint(c.label)} (${c.qty} ${product ? escapeHtmlForPrint(product.unit) : ''})</button>`
    ).join('');
    document.getElementById('locationChoiceModalOverlay').style.display = 'flex';
  });
}
function chooseLocationOption(index){
  const choice = locationChoiceCurrentOptions[index];
  document.getElementById('locationChoiceModalOverlay').style.display = 'none';
  const resolve = locationChoiceResolver;
  locationChoiceResolver = null; locationChoiceRejecter = null; locationChoiceCurrentOptions = [];
  if(resolve) resolve(choice);
}
function cancelLocationChoiceSequence(){
  document.getElementById('locationChoiceModalOverlay').style.display = 'none';
  const reject = locationChoiceRejecter;
  locationChoiceResolver = null; locationChoiceRejecter = null; locationChoiceCurrentOptions = [];
  if(reject) reject(new Error('cancelled'));
}

// 湊出一個商品這次要扣的數量,回傳分配清單(通常只有一筆,湊數量的情況會有好幾筆):
// [{type, id, label, qty}, ...],加總起來一定等於 neededQty。
// ·目前只剩一個來源可以選 → 不用問,直接整批(或剩下的部分)用那個來源
// ·有兩個以上來源 → 跳出視窗問,選了哪個來源不夠這次剩下要扣的量,就把它整個用完,
//   剩下還缺的量自動繼續問(排除掉這個已經用完的來源),直到湊滿為止
async function resolveLocationAllocationsForItem(productId, neededQty){
  const product = products.find(x => x.id === productId);
  const virtualQty = {};
  let remaining = neededQty;
  const allocations = [];

  while(remaining > 0){
    const liveChoices = getLiveLocationChoicesForProduct(productId, virtualQty);
    if(liveChoices.length === 0) break; // 理論上不該發生:代表位置資料的總和跟總庫存本身就對不起來

    const picked = liveChoices.length === 1
      ? liveChoices[0]
      : await promptLocationChoice(product, remaining, liveChoices);

    const take = Math.min(picked.qty, remaining);
    allocations.push({ type: picked.type, id: picked.id, label: picked.label, qty: take });
    const key = picked.id || 'unassigned';
    virtualQty[key] = picked.qty - take;
    remaining -= take;
  }
  return allocations;
}

// 一次處理一整批品項的位置分配,一個一個問(前一個湊完/確定了,才會問下一個),回傳
// [{productId, qty, allocations}, ...]。中途按了取消,這個 function 會 throw,呼叫端要接住、
// 不要繼續往下扣庫存。
async function resolveLocationChoicesForItems(items){
  const results = [];
  for(const it of items){
    const allocations = await resolveLocationAllocationsForItem(it.productId, it.qty);
    results.push({ productId: it.productId, qty: it.qty, allocations });
  }
  return results;
}

// 核對訂單時用:如果這張訂單在列印撿貨單的時候已經問過、記錄下每個商品要從哪些位置扣
// (order.pickedLocationAllocations),這裡優先沿用那個答案,不用重新問一次——避免撿貨單上印的
// 位置跟核對時系統實際扣的位置對不起來。但沿用之前要先確認裡面「每一筆」分配現在都還有效
// (選的是某個真實位置的話,那個位置要還存在、庫存也要還夠那一筆分配的量;選未分布的話一定
// 有效,因為未分布是即時算的):只要其中任何一筆已經失效,就整個放棄這組舊答案、當作沒問過,
// 重新走一次完整的湊數量流程,不會勉強拼湊一半新一半舊的答案。
async function resolveLocationChoicesForItemsWithPreset(items, presetMap){
  const results = [];
  for(const it of items){
    const preset = presetMap ? presetMap[it.productId] : null;
    let presetStillValid = false;
    if(Array.isArray(preset) && preset.length > 0){
      const sumQty = preset.reduce((s, a) => s + a.qty, 0);
      presetStillValid = sumQty === it.qty && preset.every(a => {
        if(a.type === 'unassigned') return true;
        if(a.type === 'location'){
          const loc = productLocations.find(l => l.id === a.id);
          return !!loc && loc.qty >= a.qty;
        }
        return false;
      });
    }
    const allocations = presetStillValid ? preset : await resolveLocationAllocationsForItem(it.productId, it.qty);
    results.push({ productId: it.productId, qty: it.qty, allocations });
  }
  return results;
}

// 核對通過、伺服器那邊的庫存已經真的扣完之後,才去動 product_locations 這幾筆資料——每一筆
// 分配各自扣各自的位置(扣到 0 就整筆刪掉);未分布不用做任何事,因為未分布本來就是用
// 「總庫存 - 各位置總和」算出來的,伺服器那邊扣完總庫存,未分布數字自然就跟著變了。
async function applyLocationDeductions(resolvedItems){
  for(const { allocations } of resolvedItems){
    if(!Array.isArray(allocations)) continue;
    for(const alloc of allocations){
      if(!alloc || alloc.type !== 'location') continue;
      const loc = productLocations.find(l => l.id === alloc.id);
      if(!loc) continue;
      if(alloc.qty > loc.qty){
        console.error(`位置 ${loc.locationCode} 數量不足(現有 ${loc.qty},要扣 ${alloc.qty}),扣到 0 為止,請去庫存分布頁面確認這個商品的位置資料是否需要人工核對。`);
      }
      const wasPrimaryBeforeDeduction = getPrimaryLocation(loc.productId) === loc;
      loc.qty = Math.max(0, loc.qty - alloc.qty);
      try{
        if(loc.qty <= 0){
          await deleteProductLocationRow(loc.id);
          productLocations = productLocations.filter(l => l.id !== loc.id);
          await rememberLastPrimaryLocationIfNowEmpty(loc, wasPrimaryBeforeDeduction);
        } else {
          await upsertProductLocation(loc);
        }
      } catch(e){ console.error('核對扣庫存後同步位置數量失敗', e); }
    }
  }
}

// 轉移(或從未分布指派)的核心邏輯:來源如果是「已存在的位置」,轉移掉的數量要從那個位置扣掉
// (扣到 0 就直接把那筆位置紀錄刪掉,不留 qty=0 的空位置紀錄);來源如果是「未分布」,因為那不是
// 真的一筆資料,轉移出去之後不用扣什麼、也不用刪什麼,少掉的量會自動反映在下次算未分布數量
// (computeUnassignedQty)的時候。目的地位置如果原本就存在同樣的位置代碼,直接把數量加上去,
// 不會產生兩筆同樣位置的紀錄。
async function confirmLocationTransfer(){
  const msgEl = document.getElementById('locationEditModalMsg');
  const productId = locationEditProductId;
  const qty = parseFloat(document.getElementById('locationTransferQtyInput').value);
  const targetVal = document.getElementById('locationTargetSelect').value;

  if(isNaN(qty) || qty <= 0){ msgEl.className = 'msg error'; msgEl.textContent = t('errEnterPositiveQty'); return; }

  let sourceLoc = null;
  let availableQty;
  if(locationEditTargetId){
    sourceLoc = productLocations.find(l => l.id === locationEditTargetId);
    if(!sourceLoc){ msgEl.className = 'msg error'; msgEl.textContent = '找不到這個位置紀錄,請重新整理頁面再試一次。'; return; }
    availableQty = sourceLoc.qty;
  } else {
    availableQty = computeUnassignedQty(productId);
  }
  if(qty > availableQty){ msgEl.className = 'msg error'; msgEl.textContent = tf('errTransferQtyExceeds', { available: availableQty }); return; }

  // 目的地是「未指派」的話,沒有真正的位置紀錄要建立/更新——只需要處理來源那邊扣掉的部分,
  // 未分布數量會自動反映(因為未分布本來就是算出來的)。
  let newCode = null;
  let existingDestLoc = null;
  if(targetVal === 'unassigned'){
    // 不用做任何目的地相關的事
  } else if(targetVal === 'new' || targetVal === 'lastPrimary'){
    // lastPrimary 選項被選到的時候,欄位已經在 onLocationTargetSelectChange 裡自動帶入
    // 之前記錄的位置資訊了,這裡直接當「新增位置」處理即可,不用另外寫一套邏輯。
    const missingFields = getMissingStandardLocationFields();
    if(missingFields.length > 0){
      msgEl.className = 'msg error';
      msgEl.textContent = tf('errMissingLocationFields', { fields: missingFields.join(', ') });
      return;
    }
    newCode = buildLocationCode();
    if(!newCode){ msgEl.className = 'msg error'; msgEl.textContent = t('errEnterLocationCode'); return; }
    existingDestLoc = productLocations.find(l => l.productId === productId && l.locationCode === newCode);
  } else if(targetVal.startsWith('loc:')){
    existingDestLoc = productLocations.find(l => l.id === targetVal.slice(4));
    if(!existingDestLoc){ msgEl.className = 'msg error'; msgEl.textContent = '找不到這個位置紀錄,請重新整理頁面再試一次。'; return; }
    newCode = existingDestLoc.locationCode;
  }
  if(sourceLoc && newCode && sourceLoc.locationCode === newCode){ msgEl.className = 'msg error'; msgEl.textContent = t('errTransferSameLocation'); return; }

  msgEl.className = 'msg'; msgEl.textContent = t('savingMsg');
  try{
    // 先處理目的地:同一個商品、同一個位置代碼已經有紀錄的話,直接加上去;沒有的話新增一筆;
    // 目的地是「未指派」的話完全不用處理這一段。如果是從「未分布」轉移過來(沒有 sourceLoc),
    // 而且剛才有先上傳照片(存在 pendingLocationPhotoUrl 裡、還沒真的掛在任何位置上),這裡
    // 順便把那張照片指定給目的地位置。
    if(targetVal !== 'unassigned'){
      if(existingDestLoc){
        existingDestLoc.qty += qty;
        if(!sourceLoc && pendingLocationPhotoUrl) existingDestLoc.photoUrl = pendingLocationPhotoUrl;
        await upsertProductLocation(existingDestLoc);
      } else {
        const zone = document.getElementById('locationZoneInput').value.trim();
        const aisle = document.getElementById('locationAisleInput').value.trim();
        const bay = document.getElementById('locationBayInput').value.trim();
        const level = document.getElementById('locationLevelInput').value.trim();
        const bin = document.getElementById('locationBinInput').value.trim();
        const destPhotoUrl = (!sourceLoc && pendingLocationPhotoUrl) ? pendingLocationPhotoUrl : null;
        const newLoc = { id: genId(), productId, zone, aisle, bay, level, bin, locationCode: newCode, qty, photoUrl: destPhotoUrl };
        productLocations.push(newLoc);
        await upsertProductLocation(newLoc);
      }
    }

    // 再處理來源:已存在的位置要扣掉轉移走的量,扣到 0 就整筆刪掉;未分布不用做任何事。
    if(sourceLoc){
      const wasPrimaryBeforeDeduction = getPrimaryLocation(sourceLoc.productId) === sourceLoc;
      sourceLoc.qty -= qty;
      if(sourceLoc.qty <= 0){
        await deleteProductLocationRow(sourceLoc.id);
        productLocations = productLocations.filter(l => l.id !== sourceLoc.id);
        await rememberLastPrimaryLocationIfNowEmpty(sourceLoc, wasPrimaryBeforeDeduction);
      } else {
        await upsertProductLocation(sourceLoc);
      }
    }

    refreshStockLocationView();
    closeLocationEditModal();
  } catch(e){
    console.error('轉移位置失敗', e);
    msgEl.className = 'msg error';
    msgEl.textContent = '⚠ 儲存失敗,請重新整理頁面再試一次。';
  }
}
