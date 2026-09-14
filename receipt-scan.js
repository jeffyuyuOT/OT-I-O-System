// ============================================================
// 收據掃描模組(選配,合一檔案)
// 這個檔案本身就是「開關 + 實際功能」合在一起:有帶這個檔案 = 收據掃描功能開啟,
// 不用再另外帶一個開關檔案。部署時如果不需要收據掃描,直接不要帶這個檔案就好
// (index.html 裡引用它的那行 <script src="receipt-scan.js"></script> 留著沒關係,
// 瀏覽器抓不到檔案只會在 console 顯示一個 404,不影響其他功能運作)。
//
// 沒有這個檔案的話:
//   - 登記進出貨→進貨上傳收據時,不會出現「掃描收據自動帶入商品」按鈕(附件上傳本身不受影響,
//     那幾個函式在 transactions.js 裡,不算這個選配模組的一部分)
//   - 倉庫後台管理裡不會有「收據掃描數據庫」這個子分頁
//
// 內容:呼叫獨立的 receipt-scan-service 做文字辨識、辨識結果逐行確認/選商品/記憶對照表,
// 以及倉庫後台管理裡的「收據掃描數據庫」子分頁(瀏覽/刪除記憶對照表)。進貨收據/發票附件的
// 上傳/預覽/移除是基本功能,搬到 transactions.js 了(見那邊的說明)。
// ============================================================
window.FEATURES = window.FEATURES || {};
Object.assign(window.FEATURES, {
  // 登記進出貨→進貨的「掃描收據自動帶入商品」按鈕,以及倉庫後台管理裡的「收據掃描數據庫」
  // 子分頁(收據文字對商品的記憶對照表)
  receiptScanModule: true
});

// ===== 掃描收據數據庫 =====
function renderOcrDbProductSelect(){
  if(!hasFeature('receiptScanModule')) return;
  syncCategoryOrder();
  const catSel = document.getElementById('ocrDbCategoryFilter');
  const prevCat = catSel.value;
  const usedCats = categoryOrder.filter(c => products.some(p => (p.category || '未分類') === c));
  catSel.innerHTML = `<option value="">${t('catFilterAll')}</option>` + usedCats.map(c => `<option value="${c}">${catLabel(c)}</option>`).join('');
  if(usedCats.includes(prevCat)) catSel.value = prevCat;
  const catFilterVal = catSel.value;

  // 供應商篩選:只列出記憶對照表裡實際有記錄的供應商名稱——不管那個供應商現在還在不在
  // 「進貨方管理」的清單裡,只要有辨識紀錄就會出現;完全沒有任何辨識紀錄的供應商(不管是還在
  // 管理清單裡、還是已經被刪除的舊供應商)不會列進來,避免下拉選單塞滿一堆選了也篩不出東西
  // 的供應商,反而不好找。
  const supSel = document.getElementById('ocrDbSupplierFilter');
  const prevSup = supSel.value;
  const allSupplierNames = [...new Set(receiptLineMappings.map(m => m.partyId).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  supSel.innerHTML = `<option value="">${t('ocrDbAnySupplierLabel')}</option>` + allSupplierNames.map(n => `<option value="${n.replace(/"/g,'&quot;')}">${escapeHtmlForPrint(n)}</option>`).join('');
  if(allSupplierNames.includes(prevSup)) supSel.value = prevSup;

  const sel = document.getElementById('ocrDbProductSelect');
  const prevVal = sel.value;
  const candidateProducts = (catFilterVal ? products.filter(p => (p.category || '未分類') === catFilterVal) : products);
  sel.innerHTML = '<option value=""></option>' + candidateProducts.slice().sort(compareProductsBySortMode)
    .map(p => `<option value="${p.id}">${p.sku ? p.sku + ' — ' : ''}${p.parentId ? '⧉ ' : ''}${p.name}(${p.unit})</option>`).join('');
  if(candidateProducts.some(p => p.id === prevVal)) sel.value = prevVal;
  makeSelectSearchable('ocrDbProductSelect');
  renderOcrDbMappingList();
}
function renderOcrDbMappingList(){
  const container = document.getElementById('ocrDbMappingList');
  if(!container) return;
  const sel = document.getElementById('ocrDbProductSelect');
  const productId = sel ? sel.value : '';
  const catFilterVal = document.getElementById('ocrDbCategoryFilter').value;
  const supplierFilterVal = document.getElementById('ocrDbSupplierFilter').value;
  const includeSkipped = document.getElementById('ocrDbIncludeSkippedToggle').checked;

  // 預設(沒勾「包含略過的資訊」)只列出真的對應到某個商品的記憶,不含「略過,不是商品資訊」
  // 那些(公司資訊、地址這類雜訊)——勾選了才會連這些也一起列出來。
  // 商品篩選邏輯不變:沒選商品就列出全部(依分類篩選縮小範圍),選了商品才縮小到只看那一個。
  // 供應商篩選是額外一層,跟商品/分類篩選同時套用(選了供應商,只看那個供應商記錄的那幾筆)。
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));
  let mappings = receiptLineMappings.filter(m => includeSkipped || m.productId !== RECEIPT_SKIP_SENTINEL);
  if(supplierFilterVal) mappings = mappings.filter(m => (m.partyId || '') === supplierFilterVal);
  mappings = productId
    ? mappings.filter(m => m.productId === productId)
    : mappings.filter(m => {
        if(m.productId === RECEIPT_SKIP_SENTINEL) return !catFilterVal; // 略過的資訊沒有商品、沒有分類可比對,只有「全部分類」時才顯示
        const p = productMap[m.productId];
        return catFilterVal ? (p && (p.category || '未分類') === catFilterVal) : true;
      });
  mappings = mappings.slice().sort((a, b) => {
    const pa = productMap[a.productId], pb = productMap[b.productId];
    return (pa ? pa.name : '').localeCompare(pb ? pb.name : '');
  });

  if(mappings.length === 0){
    container.innerHTML = `<div class="empty-note">${t('ocrDbNoMappingsHint')}</div>`;
    return;
  }
  // 篩選條件變了、清單裡的項目跟著換了一批,之前勾選的裡面如果有已經不在這次清單裡的,先清掉
  // (不然可能誤刪到畫面上根本沒看到的其他記憶),只留下這次清單裡還存在的勾選狀態。
  const visibleIds = new Set(mappings.map(m => m.id));
  ocrDbSelectedMappingIds = new Set([...ocrDbSelectedMappingIds].filter(id => visibleIds.has(id)));

  const showProductCol = !productId;
  const allSelected = mappings.length > 0 && mappings.every(m => ocrDbSelectedMappingIds.has(m.id));
  const bulkBarHtml = ocrDbSelectedMappingIds.size > 0 ? `
    <div style="display:flex;align-items:center;gap:10px;margin:10px 0;">
      <span style="font-size:12.5px;color:var(--ink-soft);">${tf('ocrDbSelectedCountLabel', { n: ocrDbSelectedMappingIds.size })}</span>
      <button class="btn ghost" onclick="deleteSelectedOcrMappings()" style="color:var(--crit);">${t('btnDeleteSelected')}</button>
    </div>` : '';
  container.innerHTML = bulkBarHtml + `<table class="stock-table" style="margin-top:${bulkBarHtml ? '0' : '12px'};">
    <thead><tr>
      <th style="width:32px;"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="toggleAllOcrDbSelection(this.checked)" style="cursor:pointer;" /></th>
      ${showProductCol ? `<th>${t('lblProduct')}</th>` : ''}<th>${t('colSupplier')}</th><th>${t('fieldReceiptOcrRawText')}</th><th></th>
    </tr></thead>
    <tbody>
      ${mappings.map(m => {
        const isSkip = m.productId === RECEIPT_SKIP_SENTINEL;
        const p = isSkip ? null : productMap[m.productId];
        return `
        <tr>
          <td><input type="checkbox" ${ocrDbSelectedMappingIds.has(m.id) ? 'checked' : ''} onchange="toggleOcrDbSelection('${m.id}', this.checked)" style="cursor:pointer;" /></td>
          ${showProductCol ? `<td>${isSkip ? `<span style="color:var(--ink-soft);font-style:italic;">${t('ocrDbSkippedLabel')}</span>` : (p ? escapeHtmlForPrint(p.name) : t('deletedProductLabel'))}</td>` : ''}
          <td>${escapeHtmlForPrint(m.partyId || t('ocrDbAnySupplierLabel'))}</td>
          <td>${escapeHtmlForPrint(m.normalizedText)}</td>
          <td><span class="del-link" onclick="deleteOcrMapping('${m.id}')">${t('btnDelete')}</span></td>
        </tr>
      `;
      }).join('')}
    </tbody>
  </table>`;
}

function toggleOcrDbSelection(mappingId, checked){
  if(checked) ocrDbSelectedMappingIds.add(mappingId);
  else ocrDbSelectedMappingIds.delete(mappingId);
  renderOcrDbMappingList();
}
function toggleAllOcrDbSelection(checked){
  // 只勾/取消目前篩選條件下畫面上實際會顯示的那些列,不會動到篩選範圍外、畫面上看不到的
  // 其他記憶。
  renderOcrDbMappingListWithSelection(checked);
}
function renderOcrDbMappingListWithSelection(checkAll){
  // toggleAllOcrDbSelection 呼叫這個:先算出目前篩選條件下畫面上會顯示的那些 id,再整批加入
  // 或整批移出勾選集合,最後照常重畫一次。
  const sel = document.getElementById('ocrDbProductSelect');
  const productId = sel ? sel.value : '';
  const catFilterVal = document.getElementById('ocrDbCategoryFilter').value;
  const supplierFilterVal = document.getElementById('ocrDbSupplierFilter').value;
  const includeSkipped = document.getElementById('ocrDbIncludeSkippedToggle').checked;
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));
  let mappings = receiptLineMappings.filter(m => includeSkipped || m.productId !== RECEIPT_SKIP_SENTINEL);
  if(supplierFilterVal) mappings = mappings.filter(m => (m.partyId || '') === supplierFilterVal);
  mappings = productId
    ? mappings.filter(m => m.productId === productId)
    : mappings.filter(m => {
        if(m.productId === RECEIPT_SKIP_SENTINEL) return !catFilterVal;
        const p = productMap[m.productId];
        return catFilterVal ? (p && (p.category || '未分類') === catFilterVal) : true;
      });
  if(checkAll) mappings.forEach(m => ocrDbSelectedMappingIds.add(m.id));
  else mappings.forEach(m => ocrDbSelectedMappingIds.delete(m.id));
  renderOcrDbMappingList();
}
async function deleteSelectedOcrMappings(){
  const ids = [...ocrDbSelectedMappingIds];
  if(ids.length === 0) return;
  showConfirmModal(tf('confirmDeleteSelectedOcrMappings', { n: ids.length }), async () => {
    try{
      await sb.from('receipt_line_mappings').delete().in('id', ids);
      const idSet = new Set(ids);
      receiptLineMappings = receiptLineMappings.filter(m => !idSet.has(m.id));
      ocrDbSelectedMappingIds = new Set();
      renderOcrDbMappingList();
    } catch(e){
      console.error('批次刪除收據記憶失敗', e);
      showInfoModal('⚠ 刪除失敗,請重新整理頁面再試一次。');
    }
  });
}

function deleteOcrMapping(mappingId){
  showConfirmModal(t('confirmDeleteOcrMapping'), async () => {
    try{
      await sb.from('receipt_line_mappings').delete().eq('id', mappingId);
      receiptLineMappings = receiptLineMappings.filter(m => m.id !== mappingId);
      renderOcrDbMappingList();
    } catch(e){
      console.error('刪除收據記憶失敗', e);
      showInfoModal('⚠ 刪除失敗,請重新整理頁面再試一次。');
    }
  });
}



// ===== 收據掃描:呼叫獨立的收據掃描服務(receipt-scan-service)、拆成品項、跟記憶對照表比對、不確定的才問 =====
//
// 辨識本身不在瀏覽器裡跑——圖片會上傳到獨立部署的 receipt-scan-service(用 Docling 做表格結構
// 辨識,不是逐字猜座標),回傳已經拆好「品名/數量/金額」的結構化清單。這個服務是完全獨立的
// 專案(有自己的 Supabase、自己的部署),多個倉庫系統可以共用同一個服務,同一個供應商的收據
// 格式只要有任何一個倉庫教過,其他倉庫掃到一樣的供應商也會受益——欄位對應的學習邏輯全部在
// 服務那邊處理,這裡不用再自己猜「數量在倒數第幾個數字」。
//
// 對照流程維持不變:每一行的「描述」文字,先去記憶對照表(receiptLineMappings)查「這個供應商
// 之前有沒有確認過這串文字對應到哪個商品」——有記憶的話不用問,直接照掃描服務回傳的數量/
// 金額加入清單;沒有記憶的話才跳出視窗,讓使用者手動選商品、確認數量金額,選完會記住。
let receiptOcrPartyId = null;
// receiptOcrPartyId 只用在一個地方:掃描開始那一刻,把「當時」選的供應商當 supplier_hint 傳給
// 後端(callReceiptScanService)——這個本來就該是「掃描前」的快照,不該隨掃描過程中使用者
// 改選供應商而變動,所以維持是一個在掃描開始時賦值一次、之後不再更新的變數沒有問題。
//
// 但凡是「記住這筆對照關係要記在哪個供應商底下」的地方(rememberReceiptLineMapping、
// findReceiptLineMapping、回報修正結果),都不該用這個快照值——之前試過在
// promptSupplierGuessConfirmation() confirm 之後手動同步這個變數,但漏算了一種情況:使用者
// 不是透過系統猜的供應商去確認,而是直接手動去改「進貨方」下拉選單本身(onTxPartyHistorySelectChange
// 這個下拉選單自己的 onchange,根本不知道 receiptOcrPartyId 這個變數存在,不會幫忙同步)——
// 這種情況下 receiptOcrPartyId 一樣會是舊的。與其在每個「可能改變供應商」的地方各自手動同步
// (容易漏,這已經是第二次抓到漏同步的地方了),不如每次要用的時候直接讀畫面上「進貨方」欄位
// 當下真正的值,一定跟畫面顯示的一致,不會再有「跟畫面看到的不一樣」這種問題。
function getLiveReceiptPartyValue(){
  const el = document.getElementById('txParty');
  return el ? el.value.trim() : (receiptOcrPartyId || '');
}
// 這次掃描過程中,實際加進登記進出貨清單(txBatchItems)的那幾筆的 batchItemId——「取消全部」
// 的時候要用這個把這次掃描加的商品也一併移除,不是只清掉還沒確認的品項跟記憶對照表。
let receiptOcrSessionBatchItemIds = [];
// 目前確認視窗顯示的這一行,收據上讀到的描述文字——「顯示隱藏商品」勾選框改變時要重新算一次
// 建議商品(renderReceiptOcrSuggestions),那個時間點沒有 line 這個參數可用,所以存起來備用。
let currentReceiptOcrLineDescription = '';
// 這次批次一次掃了好幾個檔案(發票+Credit Note之類)的話,每個檔案在掃描服務那邊各自有自己的
// scan_id——這裡記錄這次批次總共用到哪些 scan_id(key 是 scan_id,value 固定 true,單純
// 當一個集合用),確認完所有行之後,要照每個品項各自記錄的 scanId 分別回報給對應的那個掃描,
// 讓掃描服務持續學習、越用越準。
let receiptOcrScanIdsForCorrection = {};
// 這次掃描,使用者實際確認過(選了商品、填了數量金額)的品項,先收集在這裡,等這次掃描的
// 品項全部處理完(不管是逐一確認完,還是還沒確認完但使用者提早離開這個流程)才一次性回報,
// 不用每確認一行就打一次 API。每一項自己帶著 scanId,標明是從哪個檔案的哪次掃描來的。
let receiptOcrConfirmedLinesForCorrection = [];

// PDF 收據先在瀏覽器裡用 PDF.js 把每一頁都畫成一張圖片(轉成 data URL),再照跟一般圖片一樣的
// 流程,每一頁分別丟給掃描服務辨識——支援多頁,每一頁各自獨立辨識,辨識出來的品項清單最後
// 全部合併成一份。(多頁收據目前只用第一頁的 scan_id 回報修正結果,其餘頁的修正暫時不會回饋
// 給掃描服務學習——這是先求堪用的簡化,真的常遇到多頁收據的話,更好的做法是讓掃描服務直接
// 支援收多頁上傳,而不是前端逐頁轉圖再逐張打 API。)
async function renderAllPdfPagesAsImageDataUrls(pdfUrl){
  if(typeof pdfjsLib === 'undefined') throw new Error('pdfjs not loaded');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
  const scale = 2; // 放大一點畫,辨識準確度通常會比原始 PDF 預設解析度好
  const dataUrls = [];
  for(let pageNum = 1; pageNum <= pdf.numPages; pageNum++){
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    dataUrls.push(canvas.toDataURL('image/png'));
  }
  return dataUrls;
}

// 把一張圖片(data URL)送到掃描服務的 /v1/scan,回傳 { scan_id, supplier_guess, lines }。
// lines 裡每一項是 { name, qty, amount }——已經是掃描服務那邊用 Docling 表格結構辨識拆好的
// 結果,不用再自己猜欄位位置。
async function callReceiptScanService(dataUrl, pageIndex, filename){
  const blob = await (await fetch(dataUrl)).blob();
  const formData = new FormData();
  // 圖片/PDF 轉出來的每一頁,沿用原本 receipt-page-N.jpg 這個固定命名(內容本來就是圖片,
  // 檔名對辨識沒有影響)。Excel 這種非圖片格式,呼叫端會直接把原始檔名傳進來(見
  // scanReceiptForItems),要保留正確的副檔名,後端才能正確判斷這是 Excel 檔案去用
  // 對應的方式解析,不能一律當成圖片命名。
  formData.append('file', blob, filename || `receipt-page-${pageIndex + 1}.jpg`);

  // 把倉庫自己「進貨方管理」裡本來就有的供應商名字一起傳給掃描服務——這樣就算
  // 某個供應商從來沒有真的走過一次掃描+修正流程(掃描服務自己的學習資料裡完全
  // 沒有紀錄),只要倉庫本身早就認識這家供應商(purchaseSuppliers裡找得到),
  // 掃描服務也能拿去比對、猜出供應商,不用每個供應商都得先手動教過一次才猜得到。
  // 這裡只負責「猜出候選名字」,猜完之後是完全比對到直接帶入、還是相似度不夠要
  // 跳確認視窗,是 promptSupplierGuessConfirmation 那邊的事,兩段各司其職。
  let knownSuppliers = [];
  try{
    if(typeof purchaseSuppliers !== 'undefined' && Array.isArray(purchaseSuppliers)){
      knownSuppliers = purchaseSuppliers.map(s => (s.name || '').trim()).filter(Boolean);
    }
  } catch(e){
    console.error('收集既有供應商清單失敗(不影響掃描本身)', e);
  }
  formData.append('known_suppliers', JSON.stringify(knownSuppliers));

  // 掃描前如果「進貨方」已經選好了(receiptOcrPartyId 有值),直接把這個名字當成明確提示傳給
  // 後端——這是使用者自己確定選的,不是用猜的,準確度比後端自己從 OCR 文字裡猜高得多。後端收到
  // 這個提示,可以直接跳過供應商辨識、直接採用這個供應商過去學到的欄位/解析設定去讀,不用再走
  // 「猜出來、可能猜錯、還要跳確認視窗問」這一套。沒有預先選供應商的話(receiptOcrPartyId 是
  // null/空字串),就傳空字串,後端照舊自己從 OCR 文字猜(對應 promptSupplierGuessConfirmation
  // 那一段既有的「猜完再問」流程,不受影響)。
  formData.append('supplier_hint', receiptOcrPartyId || '');

  const resp = await fetch(`${RECEIPT_SCAN_SERVICE_URL}/v1/scan`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RECEIPT_SCAN_SERVICE_API_KEY}` },
    body: formData
  });
  if(!resp.ok) throw new Error(`收據掃描服務回傳錯誤 HTTP ${resp.status}`);
  const initial = await resp.json();
  if(initial.status === 'done') return initial; // 理論上不會馬上done,但保險起見還是處理一下
  return await pollReceiptScanStatus(initial.scan_id);
}

// 收據辨識(尤其版面複雜的收據)常常跑超過100秒,Cloudflare Tunnel/邊緣節點對單一HTTP
// 請求有預設逾時上限,硬扛著等一個request會被中途斷線,即使後端其實有算完也一樣。
// 改成「送出後端點立刻回應scan_id,再輪詢一個很快的『查狀態』端點」——輪詢的每一次
// 請求本身都很輕量、幾乎瞬間回應,不會被逾時規則擋住,不管背後Docling實際跑多久都
// 不受影響。maxWaitMs抓5分鐘上限,避免真的卡死時無限輪詢下去。
async function pollReceiptScanStatus(scanId, maxWaitMs = 5 * 60 * 1000, intervalMs = 2500){
  const startTime = Date.now();
  const msgEl = document.getElementById('purchaseReceiptScanMsg');
  while(Date.now() - startTime < maxWaitMs){
    await new Promise(r => setTimeout(r, intervalMs));
    const resp = await fetch(`${RECEIPT_SCAN_SERVICE_URL}/v1/scan/${scanId}`, {
      headers: { 'Authorization': `Bearer ${RECEIPT_SCAN_SERVICE_API_KEY}` }
    });
    if(!resp.ok) throw new Error(`查詢掃描狀態失敗 HTTP ${resp.status}`);
    const data = await resp.json();
    if(data.status === 'done') return data;
    if(data.status === 'failed') throw new Error('掃描服務辨識時發生錯誤');
    // 還是 "processing",順便更新一下畫面上的秒數,讓使用者知道還在跑、不是卡死
    if(msgEl){
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      msgEl.style.color = 'var(--ink-soft)';
      msgEl.textContent = (lang === 'en')
        ? `Scanning… this can take a minute or two for complex receipts (${elapsedSec}s elapsed)`
        : `辨識中,版面複雜的收據可能需要1-2分鐘,請耐心等候(已等待${elapsedSec}秒)`;
    }
  }
  throw new Error('掃描逾時,請稍後再試,或改用較清晰/較簡單版面的圖片');
}

function findSimilarSupplier(description){
  const descNormalized = normalizeReceiptLineText(description);
  const descWords = descNormalized.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length > 1);
  if(descWords.length === 0) return [];
  const scored = purchaseSuppliers.map(s => {
    const nameWords = normalizeReceiptLineText(s.name).split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length > 1);
    if(nameWords.length === 0) return { s, score: 0 };
    let matchCount = 0;
    for(const nw of nameWords){
      if(descWords.some(dw => dw.includes(nw) || nw.includes(dw))) matchCount++;
    }
    return { s, score: matchCount / nameWords.length };
  });
  return scored.filter(x => x.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.s);
}

// 掃描服務辨識出收據抬頭的公司名稱(data.supplier_guess)之後,先跟「進貨方管理」裡現有的供應商
// 名單比對:
// ·名字完全一樣(忽略大小寫、前後空白、標點這些無關緊要的差異)→ 直接帶入,不用另外問一次,
//   因為系統裡本來就有這個一模一樣的供應商,沒有「認錯」的疑慮。
// ·不是完全一樣、但字詞重疊程度夠高(邏輯跟 findSimilarProducts 比對品名一樣)→ 只是「相似」,
//   跳出確認視窗問要不要帶入,不會自己默默填上去——辨識萬一認錯,帶錯供應商會導致這張進貨單
//   記到別人頭上,不完全確定的情況一定要讓使用者自己確認過。
// ·完全比對不到任何現有供應商 → 一樣會問要不要用辨識出來的名字「新增供應商」,但也要確認,
//   不會自動新增。
// 不管走哪一條路、或使用者乾脆取消,最後都會接著往下跑品項逐行確認流程
// (processNextReceiptOcrLine),供應商這步只是先問一下,不會卡住後面的流程。
// 直接用 select.value = 某個字串,如果那個字串沒有剛好對到任何一個 <option> 的 value
// (哪怕只是前後多一個空白、或大小寫沒對上),瀏覽器會整個不理會這次賦值、安靜失敗,
// 畫面上選單還是停在原本沒選的狀態,而且不會有任何錯誤訊息——很難察覺。這裡改成自己動手
// 逐一比對每個 <option> 的文字(而且比對前先各自 trim,不要求空白也要一模一樣),對到的話
// 用 selectedIndex 直接選定,確保「明明資料裡有這個供應商,清單卻沒被選中」不會發生;
// 真的找不到才回傳 false,讓外面決定要怎麼處理(通常是照「新增供應商」的方式當備案)。
function selectPartyHistoryOptionByName(selectEl, name){
  if(!selectEl || !name) return false;
  const target = name.trim();
  for(let i = 0; i < selectEl.options.length; i++){
    if(selectEl.options[i].value.trim() === target){
      selectEl.selectedIndex = i;
      return true;
    }
  }
  console.warn('收據掃描:供應商名稱在下拉選單裡找不到對應的選項,改用新增供應商方式帶入', name);
  return false;
}

function promptSupplierGuessConfirmation(guessedName){
  const guessedNorm = normalizeReceiptLineText(guessedName);
  const exactMatch = purchaseSuppliers.find(s => normalizeReceiptLineText(s.name) === guessedNorm);
  const partyHistorySelect = document.getElementById('txPartyHistorySelect');
  if(exactMatch){
    if(!selectPartyHistoryOptionByName(partyHistorySelect, exactMatch.name)){
      // 選單裡對不到(理論上不該發生,但保險起見)——退回「新增供應商」模式,至少把辨識出來
      // 的名字帶進文字輸入框,不會讓使用者以為完全沒偵測到任何東西。
      if(partyHistorySelect){ partyHistorySelect.value = '__new__'; }
      onTxPartyHistorySelectChange('__new__');
      document.getElementById('txParty').value = exactMatch.name;
      processNextReceiptOcrLine();
      return;
    }
    onTxPartyHistorySelectChange(exactMatch.name);
    processNextReceiptOcrLine();
    return;
  }
  const matches = findSimilarSupplier(guessedName);
  if(matches.length > 0){
    const best = matches[0];
    showConfirmModal(
      tf('confirmSupplierGuessMatch', { guessed: guessedName, matched: best.name }),
      () => {
        selectPartyHistoryOptionByName(partyHistorySelect, best.name);
        onTxPartyHistorySelectChange(best.name);
        processNextReceiptOcrLine();
      },
      () => { processNextReceiptOcrLine(); }
    );
  } else {
    showConfirmModal(
      tf('confirmSupplierGuessNew', { guessed: guessedName }),
      () => {
        if(partyHistorySelect){ partyHistorySelect.value = '__new__'; }
        onTxPartyHistorySelectChange('__new__');
        document.getElementById('txParty').value = guessedName;
        processNextReceiptOcrLine();
      },
      () => { processNextReceiptOcrLine(); }
    );
  }
}

// 真正送出登記進出貨的時候(submitTxBatchSimple 呼叫)才做這個檢查——使用者掃描、確認品項
// 的當下,「進貨方」欄位是什麼,記憶對照表就記在那個供應商底下(見 confirmReceiptOcrLine /
// processNextReceiptOcrLine 呼叫 addOcrLineToTxBatch 那幾處);但確認完品項之後、真正按下
// 「提交」之前,使用者還是可能會再改一次「進貨方」欄位(例如發現剛剛猜錯了、或掃描時忘了先選)。
// 這種情況下,記憶對照表存的供應商就會跟這次「實際送出去、記進資料庫的進貨單」用的供應商
// 對不起來,需要校正。
//
// 但只能校正「這次掃描過程中剛剛新建立的」那幾筆記憶(receiptOcrSessionNewMappingIds 追蹤的),
// 不能去動任何「文字對得上、但供應商不一樣」的舊記憶——同一種東西完全可能是跟好幾個不同
// 供應商叫的(例如「紅糖」這個品項,Asian Gold 跟另一家供應商都有在賣),資料庫裡本來就該、
// 也預期會同時保留好幾個供應商各自的對照記錄,不是重複或衝突的資料,絕對不能因為這次送出的
// 供應商不一樣,就把屬於「不同一張進貨單」的舊記憶覆蓋或刪掉。
async function syncOcrMemoryToFinalParty(finalParty){
  const normalizedFinalParty = finalParty || null;
  const sessionMappingIds = new Set(receiptOcrSessionNewMappingIds);
  if(sessionMappingIds.size === 0) return; // 這次掃描根本沒有新建任何記憶,不用檢查
  const descriptionsToCheck = new Set();
  txBatchItems.forEach(it => { (it.ocrDescriptions || []).forEach(d => descriptionsToCheck.add(d)); });
  for(const desc of descriptionsToCheck){
    // 只挑「這次掃描新建立的」那幾筆裡,供應商跟最終送出去的不一樣的——不是這次新建的一律
    // 跳過,不管文字對不對得上、供應商是不是不一樣,都當成別的進貨單的合法既有記錄,不去動它。
    const wrongMappings = receiptLineMappings.filter(m =>
      m.normalizedText === desc && (m.partyId || null) !== normalizedFinalParty && sessionMappingIds.has(m.id)
    );
    if(wrongMappings.length === 0) continue;
    const alreadyCorrect = receiptLineMappings.find(m => m.normalizedText === desc && (m.partyId || null) === normalizedFinalParty);
    for(const wrong of wrongMappings){
      if(alreadyCorrect){
        try{
          await sb.from('receipt_line_mappings').delete().eq('id', wrong.id);
          receiptLineMappings = receiptLineMappings.filter(m => m.id !== wrong.id);
        } catch(e){ console.error('清除錯誤的收據記憶失敗', e); }
      } else {
        wrong.partyId = normalizedFinalParty;
        try{ await sb.from('receipt_line_mappings').upsert(receiptMappingToRow(wrong)); }
        catch(e){ console.error('修正收據記憶供應商失敗', e); }
      }
    }
  }
}

async function scanReceiptForItems(){
  if(!hasFeature('receiptScanModule')) return;
  const msgEl = document.getElementById('purchaseReceiptScanMsg');
  // 同一批進貨常常會一次上傳好幾個附件——原始發票、還有後續因為缺貨開的 Credit Note(退貨/
  // 折讓單)。以前這裡只抓第一個能掃描的檔案,現在改成每一個能掃描的附件都各自送去辨識,
  // 依照使用者在檔案清單那邊標記的文件類型(發票/Credit Note)決定這個檔案辨識出來的數量/
  // 金額最後要用加的還是用減的。
  // 標記「其他」的附件(Delivery Note 之類,跟這次進貨相關但不是發票/Credit Note)不掃——
  // 掃了也只是浪費一次呼叫掃描服務的額度,辨識出來的東西也不會是真的品項/金額。
  const scannableFiles = pendingPurchaseReceiptFiles.filter(f => f.docType !== 'others' && /\.(jpe?g|png|gif|bmp|webp|pdf|xlsx|xls)$/i.test(f.filename || f.url));
  if(scannableFiles.length === 0){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errReceiptScanNoImage');
    return;
  }
  if(!RECEIPT_SCAN_SERVICE_URL || !RECEIPT_SCAN_SERVICE_API_KEY){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errReceiptScanNotConfigured');
    return;
  }
  const partyInput = document.getElementById('txParty');
  receiptOcrPartyId = partyInput ? partyInput.value.trim() : null;
  receiptOcrSessionNewMappingIds = [];
  receiptOcrSessionBatchItemIds = [];
  receiptOcrScanIdsForCorrection = {};
  receiptOcrConfirmedLinesForCorrection = [];

  const btn = document.getElementById('btnScanReceipt');
  btn.disabled = true;
  msgEl.style.color = 'var(--ink-soft)';
  // 宣告在 try 外面——如果宣告在 try 裡面(尤其是迴圈裡的 const/let),進到 catch 的時候
  // 這個變數其實已經不在作用域內了,catch 裡面一用就會噴一個新的 ReferenceError,把原本
  // 真正的錯誤蓋掉,畫面上只會看到「isPdf is not defined」,完全看不出真正是哪裡失敗的。
  let isPdf = false;
  try{
    let allLines = [];
    let supplierGuess = null;
    for(let fileIdx = 0; fileIdx < scannableFiles.length; fileIdx++){
      const file = scannableFiles[fileIdx];
      const docType = file.docType || 'invoice';
      isPdf = /\.pdf$/i.test(file.filename || file.url);
      // Excel 格式的收據(掃描服務那邊已經支援直接解析 Excel 內容,不用先轉成圖片再辨識)——
      // 跟圖片/PDF 不一樣,不用先在瀏覽器裡轉檔,直接把原始檔案送過去,而且只有「一頁」
      // (Excel 檔案本身就是一份完整資料,沒有「逐頁轉圖」這個概念)。
      const isExcel = /\.(xlsx|xls)$/i.test(file.filename || file.url);
      msgEl.textContent = scannableFiles.length > 1
        ? tf('scanningFileMsg', { current: fileIdx + 1, total: scannableFiles.length, name: file.filename })
        : (isPdf ? t('convertingPdfMsg') : t('scanningReceiptMsg'));
      const ocrSources = isExcel ? [file.url] : (isPdf ? await renderAllPdfPagesAsImageDataUrls(file.url) : [file.url]);
      let fileScanId = null;
      for(let i = 0; i < ocrSources.length; i++){
        if(isPdf && ocrSources.length > 1){
          msgEl.textContent = tf('scanningPdfPageMsg', { current: i + 1, total: ocrSources.length });
        } else if(scannableFiles.length === 1){
          msgEl.textContent = t('scanningReceiptMsg');
        }
        // 送給掃描服務的檔名,三種來源分別處理,但共同原則是:能保留原始檔名就保留,後端
        // guess_supplier() 其中一層比對是看檔名(很多收據檔名本身就帶供應商名稱,例如
        // "2026_08_08_Asian_Gold_00041365.pdf"),固定成同一個檔名會讓這層比對永遠失效,
        // 逼得後端只能退回準確度較低的 OCR 文字內容比對,更容易猜錯供應商。
        // ·Excel:直接用原始檔名(file.filename)。
        // ·PDF 轉出來的頁面:保留原始 PDF 檔名(去掉副檔名的主體部分)+ 頁碼,例如
        // "2026_08_08_Asian_Gold_00041365-page-1.png"——多頁的話頁碼資訊也保留,副檔名
        // 用 .png(renderAllPdfPagesAsImageDataUrls 實際上是用 canvas.toDataURL('image/png')
        // 畫出來的,之前寫死的 .jpg 其實從一開始格式就標錯了,一併修正)。
        // ·純圖片:直接用原始檔名(file.filename),不需要另外組。
        const pdfBaseName = (file.filename || 'receipt').replace(/\.[^.]+$/, '');
        const pageFilename = isExcel
          ? file.filename
          : isPdf
            ? (ocrSources.length > 1 ? `${pdfBaseName}-page-${i + 1}.png` : `${pdfBaseName}.png`)
            : file.filename;
        const data = await callReceiptScanService(ocrSources[i], i, pageFilename);
        if(i === 0){
          fileScanId = data.scan_id; // 每個檔案自己一份 scan_id,多頁只用第一頁的,回報修正時看這個
          if(fileIdx === 0){
            // 供應商是整張收據層級的資訊(通常印在收據最上面的抬頭),只看第一個檔案第一頁回傳的
            // data.supplier_guess——掃描服務辨識出收據抬頭的公司名稱時才會有這個欄位,舊版掃描
            // 服務沒有回傳這個欄位的話就是 undefined,不影響原本的品項辨識流程。
            supplierGuess = (data.supplier_guess || '').trim() || null;
          }
        }
        const pageLines = (data.lines || []).map(l => {
          // 掃描服務回傳 qty 是 null/0(或乾脆沒有這個欄位)的話,代表那一格本來就是空白——
          // 尤其常見於 Excel 格式的收據/清單:整份表格列出所有商品,只有這次真的要訂的品項才會
          // 填數量,空白代表「這次不訂這項」,不是「讀不到、隨便猜一個」。以前這裡會把這種情況
          // 預設成數量 1,結果整份清單裡「本來沒有要訂」的商品也被當成「訂 1 個」一起加進去——
          // 改成直接跳過這一行(回傳 null,下面用 filter 篩掉),當作這次沒有要訂這個商品處理。
          // 對圖片/PDF 掃描來說一樣合理:真的完全讀不到數量的那一行,比較可能是表頭/小計列被
          // 誤判成品項,而不是使用者真的要訂 1 個——與其默默猜一個數字讓人沒注意到就送出去,
          // 跳過、不列進待確認清單反而更安全。
          if(!l.qty || l.qty <= 0) return null;
          const rawAmount = (l.amount && l.amount > 0) ? l.amount : null;
          return {
            description: l.name,
            // 資料庫的 transactions 表規定 qty 一定要是正數,方向靠 type 欄位('in'/'out'/'restock')
            // 決定,不是靠正負號——這裡不管是不是 Credit Note,一律存正數,跟收據上印的數字一樣。
            // Credit Note 這筆最後要記成 type='out'(代表這批數量沒有真的留在庫存裡),這個轉換
            // 在真正送出登記進出貨(submitTxBatchSimple)那一步才做,不在這裡處理;畫面上顯示
            // 淨值、匯出報表加總,也是各自在顯示層另外處理正負號,不會讓「負的 qty」流進資料庫。
            qty: l.qty,
            amount: rawAmount,
            docType,
            sourceFilename: file.filename,
            scanId: fileScanId
          };
        }).filter(Boolean);
        allLines = allLines.concat(pageLines);
      }
      if(fileScanId) receiptOcrScanIdsForCorrection[fileScanId] = true;
    }

    if(allLines.length === 0){
      msgEl.style.color = 'var(--crit)';
      msgEl.textContent = t('errReceiptScanNoLines');
      return;
    }
    pendingReceiptOcrLines = allLines;
    msgEl.style.color = 'var(--safe)';
    msgEl.textContent = tf('receiptScanFoundLinesMsg', { n: allLines.length });
    // 進貨方欄位使用者已經自己填了(不管是登記進出貨一開始就選好,還是掃描等待期間手動填的),
    // 就不要用猜的結果打擾/蓋掉——只有欄位還空著的時候才問。
    const currentPartyVal = (document.getElementById('txParty').value || '').trim();
    if(supplierGuess && !currentPartyVal){
      promptSupplierGuessConfirmation(supplierGuess);
    } else {
      processNextReceiptOcrLine();
    }
  } catch(e){
    console.error('收據掃描服務辨識失敗', e);
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = isPdf ? t('errPdfConvertFailed') : t('errReceiptScanFailed');
  } finally {
    btn.disabled = false;
  }
}

// 跟手動用「+ 加入清單」加商品(addToTxBatch,同一個商品一律直接把數量加總合併成一行)不一樣,
// 這裡的規則是:同一份文件(同一個 sourceFilename + 同一個 docType)裡,同一個商品出現好幾次
// (單純同一張收據把同商品拆成好幾行,沒有「不同來源」這回事)——直接加總合併成一行,不用堅持
// 逐筆,合併起來反而更清楚。但「不同文件」的同一個商品(最典型的情境:發票登記了5箱,另一個
// 檔案的 Credit Note 又退了1箱)——這個要保留分開,不合併:目的是保留完整稽核軌跡,之後要
// 追溯「這個商品最後為什麼是這個淨數量」,可以直接查到原始發票跟退貨各自的那一筆,不會因為
// 系統自動加總過,反而看不出計算依據。畫面上(renderTxBatchList)會在同一個商品有多筆「不同
// 文件來源」的時候,額外顯示一行「淨」的加總方便核對,但那只是顯示層面的呈現,底層資料還是
// 分開的。
function addOcrLineToTxBatch(productId, qty, amount, docType, sourceFilename, ocrDescription){
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const existing = txBatchItems.find(it =>
    it.productId === productId && it.docType === docType && it.sourceFilename === sourceFilename
  );
  let affectedBatchItemId;
  if(existing){
    existing.qty += qty;
    if(amount !== null && amount !== undefined) existing.amount = (existing.amount || 0) + amount;
    if(ocrDescription){
      existing.ocrDescriptions = existing.ocrDescriptions || [];
      if(!existing.ocrDescriptions.includes(ocrDescription)) existing.ocrDescriptions.push(ocrDescription);
    }
    affectedBatchItemId = existing.batchItemId;
  } else {
    const item = { batchItemId: genId(), productId, sku: p.sku || '', name: p.name, unit: p.unit, qty };
    if(amount !== null && amount !== undefined) item.amount = amount;
    if(docType) item.docType = docType;
    if(sourceFilename) item.sourceFilename = sourceFilename;
    // 記住這一行原本收據上讀到的描述文字(可能不只一個,同一個商品在同一份文件裡出現好幾次
    // 會合併成一行,但各自的描述文字都要記住)——之後真正送出登記進出貨時,要用這個回頭去
    // 更新記憶對照表(見 submitTxBatchSimple 裡的 syncOcrMemoryToFinalParty),確保記憶對照表
    // 存的供應商,是使用者最後真的送出去那個,不是掃描/確認品項當下畫面上剛好顯示的那個——
    // 使用者掃描完、確認完品項之後,送出之前還可能會再改一次「進貨方」欄位,那次修改也要
    // 反映回記憶對照表才對。
    if(ocrDescription) item.ocrDescriptions = [ocrDescription];
    txBatchItems.push(item);
    affectedBatchItemId = item.batchItemId;
  }
  // 記住這筆這次掃描有動到(不管是新增一行、還是加到這次掃描自己稍早已經加過的同一行)——
  // 「取消全部」的時候要靠這個知道哪些是這次掃描造成的,才能正確移除。
  if(!receiptOcrSessionBatchItemIds.includes(affectedBatchItemId)) receiptOcrSessionBatchItemIds.push(affectedBatchItemId);
  renderTxBatchList();
}

function processNextReceiptOcrLine(){
  if(pendingReceiptOcrLines.length === 0){
    renderTxBatchList();
    reportReceiptScanCorrections(); // 這次掃描確認完的品項,一次性回報給掃描服務,累積學習資料用
    return;
  }
  const line = pendingReceiptOcrLines[0];
  const memory = findReceiptLineMapping(getLiveReceiptPartyValue(), line.description);
  if(memory && memory.type === 'skip'){
    // 之前確認過這行不是商品資訊(公司資訊、地址這類),不用再問,直接跳過。
    pendingReceiptOcrLines.shift();
    processNextReceiptOcrLine();
    return;
  }
  if(memory && memory.type === 'product'){
    // 已經有記憶對照過,不用問,照 OCR 讀到的數量/金額直接加入清單。
    addOcrLineToTxBatch(memory.product.id, line.qty, line.amount, line.docType, line.sourceFilename, normalizeReceiptLineText(line.description));
    receiptOcrConfirmedLinesForCorrection.push({
      name: line.description,
      qty: line.qty,
      amount: line.amount || null,
      scanId: line.scanId
    });
    pendingReceiptOcrLines.shift();
    processNextReceiptOcrLine();
    return;
  }
  openReceiptOcrConfirmModal(line);
}

// 用 OCR 讀到的文字,去庫存商品清單裡找「看起來可能符合」的商品——不是要求整串文字一模一樣
// (畢竟 OCR 跟商品主檔的措辭本來就不會完全一樣),而是把兩邊都拆成一個一個的字/詞,看商品
// 名稱裡有多少比例的字有出現在 OCR 文字裡,比例越高排越前面。回傳最多 5 個候選,比例太低的
// (完全沾不上邊的)不列入,避免整排都是不相干的商品,反而干擾判斷。
function findSimilarProducts(description, includeHidden){
  const descNormalized = normalizeReceiptLineText(description);
  const descWords = descNormalized.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length > 1);
  if(descWords.length === 0) return [];
  const scored = products.filter(p => includeHidden || !p.hidden).map(p => {
    const nameWords = normalizeReceiptLineText(p.name).split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length > 1);
    if(nameWords.length === 0) return { p, score: 0 };
    let matchCount = 0;
    for(const nw of nameWords){
      if(descWords.some(dw => dw.includes(nw) || nw.includes(dw))) matchCount++;
    }
    return { p, score: matchCount / nameWords.length };
  });
  return scored.filter(s => s.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.p);
}

function openReceiptOcrConfirmModal(line){
  document.getElementById('receiptOcrRawTextDisplay').value = line.description;
  document.getElementById('receiptOcrQtyInput').value = line.qty;
  document.getElementById('receiptOcrAmountInput').value = line.amount || '';
  document.getElementById('receiptOcrConfirmMsg').textContent = '';
  document.getElementById('receiptOcrProgressInfo').textContent = tf('receiptOcrProgressText', { remaining: pendingReceiptOcrLines.length });
  // 掃描服務回傳的已經是拆好的品名/數量/金額,不會再附帶一整行「所有候選數字」讓使用者對照
  // (那是以前 Tesseract 逐字猜位置時代的產物),這個顯示區塊固定清空。
  const numbersDisplay = document.getElementById('receiptOcrRawNumbersDisplay');
  if(numbersDisplay) numbersDisplay.textContent = '';
  // 記著目前這一行的描述文字——「顯示隱藏商品」勾選框改變時要重新算一次建議商品,
  // 到時候不會再有 line 這個參數可以用,所以先存起來。
  currentReceiptOcrLineDescription = line.description;
  syncCategoryOrder();
  const catSel = document.getElementById('receiptOcrCategoryFilter');
  const usedCats = categoryOrder.filter(c => products.some(p => (p.category || '未分類') === c));
  catSel.innerHTML = `<option value="">${t('catFilterAll')}</option>` + usedCats.map(c => `<option value="${c}">${catLabel(c)}</option>`).join('');
  catSel.value = '';
  // 「顯示隱藏商品」預設不勾——每一行重新跳出確認視窗時都重設回不勾,理由跟分類篩選重設一樣:
  // 這是針對「這一行」的暫時性篩選調整,不該不小心延續到下一行,讓人誤以為隱藏商品一直都有
  // 顯示出來。
  const showHiddenCheckbox = document.getElementById('receiptOcrShowHiddenToggle');
  if(showHiddenCheckbox) showHiddenCheckbox.checked = false;
  renderReceiptOcrSuggestions();
  renderReceiptOcrProductOptions();
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'flex';
}

// 先用商品名稱的文字相似度,找幾個可能符合的商品當快速選項——找得到的話,列在最上面,點一下
// 就直接選定,不用再去下面那個完整清單裡搜尋;完全找不到符合的,這個區塊就不顯示,直接用
// 下面的分類篩選+完整清單選就好。是不是要把隱藏商品也考慮進去,跟下面完整清單同一個
// 「顯示隱藏商品」勾選框——勾選框改變時(見 HTML 上的 onchange)也會重新呼叫這個函式,
// 不是只有跳出新的一行才算一次。
function renderReceiptOcrSuggestions(){
  const showHiddenCheckbox = document.getElementById('receiptOcrShowHiddenToggle');
  const showHidden = showHiddenCheckbox && showHiddenCheckbox.checked;
  const suggestions = findSimilarProducts(currentReceiptOcrLineDescription, showHidden);
  const suggestWrap = document.getElementById('receiptOcrSuggestionsWrap');
  if(suggestions.length > 0){
    suggestWrap.style.display = 'block';
    document.getElementById('receiptOcrSuggestionsList').innerHTML = suggestions.map(p => `
      <button type="button" class="btn ghost" style="text-align:left;" onclick="selectReceiptOcrSuggestedProduct('${p.id}')">
        ${p.sku ? escapeHtmlForPrint(p.sku) + ' — ' : ''}${p.parentId ? '⧉ ' : ''}${escapeHtmlForPrint(p.name)}(${escapeHtmlForPrint(p.unit)})
      </button>
    `).join('');
  } else {
    suggestWrap.style.display = 'none';
    document.getElementById('receiptOcrSuggestionsList').innerHTML = '';
  }
}
function renderReceiptOcrProductOptions(){
  const catFilterVal = document.getElementById('receiptOcrCategoryFilter').value;
  const showHiddenCheckbox = document.getElementById('receiptOcrShowHiddenToggle');
  const showHidden = showHiddenCheckbox && showHiddenCheckbox.checked;
  const sel = document.getElementById('receiptOcrProductSelect');
  const candidateProducts = (catFilterVal ? products.filter(p => (p.category || '未分類') === catFilterVal) : products)
    .filter(p => showHidden || !p.hidden);
  sel.innerHTML = '<option value=""></option>' + candidateProducts.slice().sort(compareProductsBySortMode)
    .map(p => `<option value="${p.id}">${p.sku ? p.sku + ' — ' : ''}${p.parentId ? '⧉ ' : ''}${p.name}(${p.unit})</option>`).join('');
  makeSelectSearchable('receiptOcrProductSelect');
  // makeSelectSearchable() 第一次呼叫之後就不會再重新包裝(只在第一次真的把搜尋輸入框接上去),
  // 之後每次重畫選項(不管是換分類篩選,還是換到下一行要確認的品項),底層 select 的值雖然會
  // 因為重建 innerHTML 自動回到空白,但畫面上顯示的搜尋輸入框文字不會跟著自動清空(那個文字
  // 只有在使用者真的手動選了東西、或程式碼呼叫 resetSearchableSelect 明確指定清空時才會同步)。
  // 這裡明確呼叫一次,確保換行/換分類的時候搜尋框顯示也真的清空,不會卡在上一個選的商品名稱。
  resetSearchableSelect('receiptOcrProductSelect');
}

// 點了「可能符合的商品」快速選項:先把分類篩選重設成「全部分類」,確保這個商品一定會出現在
// 下面完整清單的選項裡(不然萬一它剛好不屬於目前選的分類,選了也選不到),重畫選項之後再把
// 值設定成這個商品——用 .value= 賦值,makeSelectSearchable 那邊包裝過的 setter 會自動同步
// 畫面上顯示的搜尋框文字,不用另外處理。
function selectReceiptOcrSuggestedProduct(productId){
  const catSel = document.getElementById('receiptOcrCategoryFilter');
  if(catSel) catSel.value = '';
  renderReceiptOcrProductOptions();
  document.getElementById('receiptOcrProductSelect').value = productId;
}

// 這次掃描使用者實際確認過(或修正過)的品項,一次性回報給獨立收據掃描服務——服務那邊會拿
// 這些資料當作這張收據的「正確答案」存起來,累積作為之後同一個供應商辨識更準的依據。純粹是
// 「盡力而為」的背景回報:失敗不影響倉庫這邊的進貨流程(進貨批次在上一步就已經正常加進去
// 了),所以這裡故意不擋 UI、不跳錯誤訊息,只在 console 留紀錄方便日後排查。
async function reportReceiptScanCorrections(){
  if(receiptOcrConfirmedLinesForCorrection.length === 0){
    receiptOcrScanIdsForCorrection = {};
    return;
  }
  const lines = receiptOcrConfirmedLinesForCorrection.slice();
  receiptOcrScanIdsForCorrection = {};
  receiptOcrConfirmedLinesForCorrection = [];
  // 每個檔案(發票、Credit Note...)各自有自己的 scan_id,回報修正結果時要照 scanId 分組,
  // 各自送回對應的那次掃描——不能全部混在一起送給隨便一個 scan_id,不然掃描服務那邊會把
  // 不相干的修正結果錯記到別的收據上。
  const byScanId = {};
  lines.forEach(l => {
    if(!l.scanId) return; // 理論上不該發生(每一行都是掃描出來的,一定帶著 scanId)
    (byScanId[l.scanId] = byScanId[l.scanId] || []).push({ name: l.name, qty: l.qty, amount: l.amount });
  });
  for(const scanId of Object.keys(byScanId)){
    try{
      await fetch(`${RECEIPT_SCAN_SERVICE_URL}/v1/scan/${scanId}/correct`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RECEIPT_SCAN_SERVICE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ supplier_name: getLiveReceiptPartyValue(), lines: byScanId[scanId] })
      });
    } catch(e){
      console.error('回報收據掃描修正結果失敗(不影響本次進貨,只影響未來辨識準確度)', e);
    }
  }
}

async function confirmReceiptOcrLine(){
  const msgEl = document.getElementById('receiptOcrConfirmMsg');
  const productId = document.getElementById('receiptOcrProductSelect').value;
  const qty = parseFloat(document.getElementById('receiptOcrQtyInput').value);
  const amountRaw = document.getElementById('receiptOcrAmountInput').value;
  const amount = amountRaw === '' ? null : parseFloat(amountRaw);
  if(!productId){ msgEl.className = 'msg error'; msgEl.textContent = t('errSelectProductFirst'); return; }
  if(isNaN(qty) || qty <= 0){ msgEl.className = 'msg error'; msgEl.textContent = t('errEnterPositiveQty'); return; }

  const line = pendingReceiptOcrLines.shift();
  const finalAmount = (amount && amount > 0) ? amount : null;
  addOcrLineToTxBatch(productId, qty, finalAmount, line.docType, line.sourceFilename, normalizeReceiptLineText(line.description));
  await rememberReceiptLineMapping(getLiveReceiptPartyValue(), normalizeReceiptLineText(line.description), productId);
  // 收集這行使用者實際確認的結果,等這次掃描全部處理完再一次回報給掃描服務(見
  // reportReceiptScanCorrections)——略過的行(公司資訊、地址之類)不算品項,不放進來。
  receiptOcrConfirmedLinesForCorrection.push({
    name: line.description,
    qty,
    amount: finalAmount,
    scanId: line.scanId
  });
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  processNextReceiptOcrLine();
}

// 跟「略過這一行」(skipReceiptOcrLine)不一樣:這個「跳過此商品」不會存進記憶對照表——
// 只是這次掃描不想加這個品項而已,不代表以後每次掃到同一個供應商、同樣的文字都要自動跳過。
// 「略過這一行」比較適合公司資訊、地址這種真的不是商品、以後也不會是商品的雜訊;這個「跳過
// 此商品」則適合「這次剛好不訂這個」但下次可能還是要問的情況,不會把這個判斷永久記住。
function skipReceiptOcrLineOnce(){
  pendingReceiptOcrLines.shift();
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  processNextReceiptOcrLine();
}

function skipReceiptOcrLine(){
  const line = pendingReceiptOcrLines.shift();
  // 記住「這個供應商 + 這行文字」不是商品資訊(公司資訊、地址這類常見的收據雜訊)——下次掃
  // 同一個供應商的收據,同樣的文字會直接自動跳過,不用每次都手動略過一次。
  if(line) rememberReceiptLineMapping(getLiveReceiptPartyValue(), normalizeReceiptLineText(line.description), RECEIPT_SKIP_SENTINEL);
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  processNextReceiptOcrLine();
}

async function cancelReceiptOcrSequence(){
  pendingReceiptOcrLines = [];
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  // 「取消全部」要是真的取消掉這整次掃描的所有影響——不只是清空還沒確認的品項,這次掃描過程中
  // 已經「確認並加入」到登記進出貨清單的品項,也要一併移除,不然使用者會看到清單裡多了幾筆
  // 明明按了取消卻還在的商品,搞不清楚發生了什麼事。
  const batchItemIdsToRemove = receiptOcrSessionBatchItemIds.slice();
  receiptOcrSessionBatchItemIds = [];
  if(batchItemIdsToRemove.length > 0){
    txBatchItems = txBatchItems.filter(it => !batchItemIdsToRemove.includes(it.batchItemId));
  }
  // 這次掃描過程中如果已經有幾筆新建的記憶(不管是「確認並加入」還是「略過這一行」建立的),
  // 一併復原刪除,不然下次同一張收據重新掃描,那幾筆被略過/確認的行會照舊記憶直接跳過,
  // 使用者會覺得「明明取消了,怎麼還是沒有跳出來問」,搞不清楚發生了什麼事。
  const idsToRevert = receiptOcrSessionNewMappingIds.slice();
  receiptOcrSessionNewMappingIds = [];
  for(const id of idsToRevert){
    try{
      await sb.from('receipt_line_mappings').delete().eq('id', id);
      receiptLineMappings = receiptLineMappings.filter(m => m.id !== id);
    } catch(e){ console.error('復原取消的收據辨識記憶失敗', e); }
  }
  // 取消掉的這次掃描,不回報任何修正結果給掃描服務——這幾個 scan_id 對應的收據本來就沒有
  // 走完確認流程,不該當作「使用者確認過的正確答案」回饋進去。
  receiptOcrScanIdsForCorrection = {};
  receiptOcrConfirmedLinesForCorrection = [];
  renderTxBatchList();
}

