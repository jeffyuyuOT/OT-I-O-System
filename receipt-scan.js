// ============================================================
// 收據掃描模組(選配,合一檔案)
// 這個檔案本身就是「開關 + 實際功能」合在一起:有帶這個檔案 = 收據掃描功能開啟,
// 不用再另外帶一個開關檔案。部署時如果不需要收據掃描,直接不要帶這個檔案就好
// (index.html 裡引用它的那行 <script src="receipt-scan.js"></script> 留著沒關係,
// 瀏覽器抓不到檔案只會在 console 顯示一個 404,不影響其他功能運作)。
//
// 沒有這個檔案的話:
//   - 登記進出貨→進貨上傳收據時,不會出現「掃描收據自動帶入商品」按鈕(附件上傳本身不受影響)
//   - 倉庫後台管理裡不會有「收據掃描數據庫」這個子分頁
//
// 內容:進貨收據/發票附件上傳、呼叫獨立的 receipt-scan-service 做文字辨識、辨識結果
// 逐行確認/選商品/記憶對照表,以及倉庫後台管理裡的「收據掃描數據庫」子分頁(瀏覽/刪除
// 記憶對照表)。
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


// 進貨單的收據/發票附件上傳:跟商品照片上傳同一套模式,差別是這裡接受圖片「或」PDF,
// 檔案大小上限放寬到 10MB(收據掃描檔常常比商品照片大),而且支援一次選取多個檔案——逐一
// 上傳、逐一加進 pendingPurchaseReceiptFiles 這個陣列,其中一個檔案上傳失敗不影響其他已經
// 上傳成功的檔案。真正送出進貨單(submitTxBatchSimple)時才會用到、寫進那張單。
async function handlePurchaseReceiptUpload(inputEl){
  const files = inputEl.files ? Array.from(inputEl.files) : [];
  if(files.length === 0) return;
  const msgEl = document.getElementById('purchaseReceiptUploadMsg');
  const maxBytes = 10 * 1024 * 1024;
  let successCount = 0;
  let failCount = 0;
  let lastFailReason = '';

  for(const file of files){
    // 手機拍照上傳(尤其是直接用相機拍、不是從相簿選)的檔案,file.type 常常是空字串——瀏覽器
    // 沒有正確帶入 MIME type,不是檔案真的有問題。原本這裡只看 file.type,遇到空字串一律當
    // 「格式不符」擋掉,手機拍照上傳才會一直失敗。這裡改成:file.type 有給的話正常判斷;
    // 沒給的話(常見於手機拍照),退回看副檔名判斷,不會因為瀏覽器沒帶 MIME type 就整個擋掉。
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const looksLikeImageByExt = /^(jpe?g|png|gif|bmp|webp|heic|heif)$/.test(ext);
    const looksLikePdfByExt = ext === 'pdf';
    const validType = file.type
      ? (file.type.startsWith('image/') || file.type === 'application/pdf')
      : (looksLikeImageByExt || looksLikePdfByExt);
    if(!validType){
      failCount++;
      lastFailReason = t('errReceiptFileTypeInvalid');
      continue;
    }
    if(file.size > maxBytes){
      failCount++;
      lastFailReason = t('errReceiptFileTooLarge');
      continue;
    }
    msgEl.style.color = 'var(--ink-soft)';
    msgEl.textContent = tf('uploadingReceiptMsgWithName', { name: file.name });
    // 檔名保留使用者上傳時的原始檔名(不是只留副檔名的亂數檔名),這樣點連結查看/下載附件時,
    // 瀏覽器顯示的檔名就是原本的檔名,不會是一串亂碼——前面加一個亂數資料夾當前綴,是為了避免
    // 不同收據剛好同名(例如都叫 IMG_1234.jpg)互相覆蓋掉,不影響顯示出來的檔名本身。
    const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_');
    const path = `${genId()}/${safeName}`;
    try{
      // 從 Google Drive 這類雲端硬碟選檔案時,瀏覽器拿到的 File 物件有時候不是「已經整個讀進
      // 記憶體」的檔案,而是要等到真的被讀取的那一刻才會去背景抓資料——直接把這個 File 物件
      // 原封不動丟給 upload(),遇到抓取還沒完成/網路不穩的情況,常常會直接報一個很籠統的
      // 「Failed to fetch」,看不出真正原因。這裡先明確用 file.arrayBuffer() 把整個檔案內容
      // 讀進記憶體,確保資料真的完整拿到手上了,再轉成 Blob 送出去上傳,比較不會遇到這種問題。
      const arrayBuffer = await file.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: file.type || (looksLikePdfByExt ? 'application/pdf' : 'image/jpeg') });
      let uploadError = null;
      // 網路不穩(尤其手機行動網路)偶爾會讓上傳這個網路請求本身失敗一次,不一定是檔案或格式
      // 的問題——失敗的話自動重試一次,大部分暫時性的網路問題重試就會成功,不用使用者自己
      // 手動再上傳一次。
      for(let attempt = 0; attempt < 2; attempt++){
        const { error } = await sb.storage.from('purchase-receipts').upload(path, blob, { upsert: true });
        uploadError = error;
        if(!error) break;
        if(attempt === 0) await new Promise(r => setTimeout(r, 800));
      }
      if(uploadError) throw uploadError;
      const { data } = sb.storage.from('purchase-receipts').getPublicUrl(path);
      pendingPurchaseReceiptFiles.push({ url: data.publicUrl, filename: file.name });
      successCount++;
    } catch(e){
      console.error('上傳進貨單收據失敗', e);
      failCount++;
      // 真正上傳失敗(不是前面型別/大小這種本機就能判斷的問題)的話,把 Supabase 回傳的錯誤
      // 訊息也一併記下來,顯示的時候比單純「上傳失敗」更容易看出是網路問題還是別的原因。
      lastFailReason = (e && e.message) ? e.message : t('errReceiptUploadFailed');
    }
  }

  renderPurchaseReceiptPreviewList();
  if(failCount === 0){
    msgEl.style.color = 'var(--safe)';
    msgEl.textContent = t('receiptUploadedMsg');
  } else if(successCount === 0){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = failCount === 1 ? `⚠ ${lastFailReason}` : t('errReceiptUploadFailed');
  } else {
    msgEl.style.color = 'var(--warn)';
    msgEl.textContent = tf('receiptUploadedPartialMsg', { success: successCount, fail: failCount });
  }
  inputEl.value = '';
}

function renderPurchaseReceiptPreviewList(){
  const wrap = document.getElementById('purchaseReceiptPreviewWrap');
  if(!wrap) return;
  const scanWrap = document.getElementById('purchaseReceiptScanWrap');
  if(pendingPurchaseReceiptFiles.length === 0){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    if(scanWrap) scanWrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';
  // docType 只有在有收據掃描模組時才需要標記/顯示——沒有掃描功能的話,附件單純就是附件,
  // 不需要區分是發票還是 Credit Note(反正也不會拿去自動加總)。預設一律當「發票」,使用者
  // 上傳退貨/折讓單的時候要自己手動改成「Credit Note」——不用檔名關鍵字去猜,猜錯的後果
  // 是金額方向整個算反,寧可讓使用者自己選,比較保險。
  const showDocTypeTag = hasFeature('receiptScanModule');
  wrap.innerHTML = pendingPurchaseReceiptFiles.map((f, i) => `
    <div style="display:flex;align-items:center;gap:10px;">
      <a href="${f.url}" target="_blank" style="font-size:12.5px;">📎 ${escapeHtmlForPrint(f.filename)}</a>
      ${showDocTypeTag ? `
        <select style="font-size:11.5px;padding:2px 4px;" onchange="setPurchaseReceiptFileDocType(${i}, this.value)">
          <option value="invoice" ${(f.docType || 'invoice') === 'invoice' ? 'selected' : ''}>${t('optDocTypeInvoice')}</option>
          <option value="credit_note" ${f.docType === 'credit_note' ? 'selected' : ''}>${t('optDocTypeCreditNote')}</option>
          <option value="others" ${f.docType === 'others' ? 'selected' : ''}>${t('optDocTypeOthers')}</option>
        </select>
      ` : ''}
      <span class="del-link" onclick="removePurchaseReceiptFile(${i})">${t('btnRemoveFile')}</span>
    </div>
  `).join('');
  // 掃描功能支援圖片跟 PDF——PDF 的話會先在瀏覽器裡用 PDF.js 把第一頁畫成圖片,再照跟圖片
  // 一樣的流程做文字辨識(見 scanReceiptForItems)。有上傳圖片或 PDF 檔案才顯示這個按鈕,
  // 只上傳其他格式(理論上不該發生,上傳欄位本身就限制只能選圖片/PDF)才不顯示。
  // Delivery Note 或其他跟這次進貨相關、但不是發票/Credit Note 的附件(標記「其他」的)不算
  // 「可以掃描」——掃描按鈕出不出現只看有沒有發票/Credit Note 這種真的要辨識金額/數量的附件。
  const hasScannableFile = pendingPurchaseReceiptFiles.some(f => f.docType !== 'others' && /\.(jpe?g|png|gif|bmp|webp|pdf)$/i.test(f.filename || f.url));
  if(scanWrap) scanWrap.style.display = (hasScannableFile && hasFeature('receiptScanModule')) ? 'block' : 'none';
}

function setPurchaseReceiptFileDocType(index, docType){
  const f = pendingPurchaseReceiptFiles[index];
  if(f) f.docType = docType;
}

function removePurchaseReceiptFile(index){
  pendingPurchaseReceiptFiles.splice(index, 1);
  renderPurchaseReceiptPreviewList();
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
async function callReceiptScanService(dataUrl, pageIndex){
  const blob = await (await fetch(dataUrl)).blob();
  const formData = new FormData();
  formData.append('file', blob, `receipt-page-${pageIndex + 1}.jpg`);

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

async function scanReceiptForItems(){
  if(!hasFeature('receiptScanModule')) return;
  const msgEl = document.getElementById('purchaseReceiptScanMsg');
  // 同一批進貨常常會一次上傳好幾個附件——原始發票、還有後續因為缺貨開的 Credit Note(退貨/
  // 折讓單)。以前這裡只抓第一個能掃描的檔案,現在改成每一個能掃描的附件都各自送去辨識,
  // 依照使用者在檔案清單那邊標記的文件類型(發票/Credit Note)決定這個檔案辨識出來的數量/
  // 金額最後要用加的還是用減的。
  // 標記「其他」的附件(Delivery Note 之類,跟這次進貨相關但不是發票/Credit Note)不掃——
  // 掃了也只是浪費一次呼叫掃描服務的額度,辨識出來的東西也不會是真的品項/金額。
  const scannableFiles = pendingPurchaseReceiptFiles.filter(f => f.docType !== 'others' && /\.(jpe?g|png|gif|bmp|webp|pdf)$/i.test(f.filename || f.url));
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
  receiptOcrScanIdsForCorrection = {};
  receiptOcrConfirmedLinesForCorrection = [];

  const btn = document.getElementById('btnScanReceipt');
  btn.disabled = true;
  msgEl.style.color = 'var(--ink-soft)';
  try{
    let allLines = [];
    let supplierGuess = null;
    for(let fileIdx = 0; fileIdx < scannableFiles.length; fileIdx++){
      const file = scannableFiles[fileIdx];
      const docType = file.docType || 'invoice';
      const isPdf = /\.pdf$/i.test(file.filename || file.url);
      msgEl.textContent = scannableFiles.length > 1
        ? tf('scanningFileMsg', { current: fileIdx + 1, total: scannableFiles.length, name: file.filename })
        : (isPdf ? t('convertingPdfMsg') : t('scanningReceiptMsg'));
      const ocrSources = isPdf ? await renderAllPdfPagesAsImageDataUrls(file.url) : [file.url];
      let fileScanId = null;
      for(let i = 0; i < ocrSources.length; i++){
        if(isPdf && ocrSources.length > 1){
          msgEl.textContent = tf('scanningPdfPageMsg', { current: i + 1, total: ocrSources.length });
        } else if(scannableFiles.length === 1){
          msgEl.textContent = t('scanningReceiptMsg');
        }
        const data = await callReceiptScanService(ocrSources[i], i);
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
          const rawQty = (l.qty && l.qty > 0) ? l.qty : 1;
          const rawAmount = (l.amount && l.amount > 0) ? l.amount : null;
          return {
            description: l.name,
            // 資料庫的 transactions 表規定 qty 一定要是正數,方向靠 type 欄位('in'/'out'/'restock')
            // 決定,不是靠正負號——這裡不管是不是 Credit Note,一律存正數,跟收據上印的數字一樣。
            // Credit Note 這筆最後要記成 type='out'(代表這批數量沒有真的留在庫存裡),這個轉換
            // 在真正送出登記進出貨(submitTxBatchSimple)那一步才做,不在這裡處理;畫面上顯示
            // 淨值、匯出報表加總,也是各自在顯示層另外處理正負號,不會讓「負的 qty」流進資料庫。
            qty: rawQty,
            amount: rawAmount,
            docType,
            sourceFilename: file.filename,
            scanId: fileScanId
          };
        });
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
function addOcrLineToTxBatch(productId, qty, amount, docType, sourceFilename){
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const existing = txBatchItems.find(it =>
    it.productId === productId && it.docType === docType && it.sourceFilename === sourceFilename
  );
  if(existing){
    existing.qty += qty;
    if(amount !== null && amount !== undefined) existing.amount = (existing.amount || 0) + amount;
  } else {
    const item = { batchItemId: genId(), productId, sku: p.sku || '', name: p.name, unit: p.unit, qty };
    if(amount !== null && amount !== undefined) item.amount = amount;
    if(docType) item.docType = docType;
    if(sourceFilename) item.sourceFilename = sourceFilename;
    txBatchItems.push(item);
  }
  renderTxBatchList();
}

function processNextReceiptOcrLine(){
  if(pendingReceiptOcrLines.length === 0){
    renderTxBatchList();
    reportReceiptScanCorrections(); // 這次掃描確認完的品項,一次性回報給掃描服務,累積學習資料用
    return;
  }
  const line = pendingReceiptOcrLines[0];
  const memory = findReceiptLineMapping(receiptOcrPartyId, line.description);
  if(memory && memory.type === 'skip'){
    // 之前確認過這行不是商品資訊(公司資訊、地址這類),不用再問,直接跳過。
    pendingReceiptOcrLines.shift();
    processNextReceiptOcrLine();
    return;
  }
  if(memory && memory.type === 'product'){
    // 已經有記憶對照過,不用問,照 OCR 讀到的數量/金額直接加入清單。
    addOcrLineToTxBatch(memory.product.id, line.qty, line.amount, line.docType, line.sourceFilename);
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
function findSimilarProducts(description){
  const descNormalized = normalizeReceiptLineText(description);
  const descWords = descNormalized.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length > 1);
  if(descWords.length === 0) return [];
  const scored = products.filter(p => !p.hidden).map(p => {
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
  // 先用商品名稱的文字相似度,找幾個可能符合的商品當快速選項——找得到的話,列在最上面,
  // 點一下就直接選定,不用再去下面那個完整清單裡搜尋;完全找不到符合的,這個區塊就不顯示,
  // 直接用下面的分類篩選+完整清單選就好。
  const suggestions = findSimilarProducts(line.description);
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
  syncCategoryOrder();
  const catSel = document.getElementById('receiptOcrCategoryFilter');
  const usedCats = categoryOrder.filter(c => products.some(p => (p.category || '未分類') === c));
  catSel.innerHTML = `<option value="">${t('catFilterAll')}</option>` + usedCats.map(c => `<option value="${c}">${catLabel(c)}</option>`).join('');
  catSel.value = '';
  renderReceiptOcrProductOptions();
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'flex';
}
function renderReceiptOcrProductOptions(){
  const catFilterVal = document.getElementById('receiptOcrCategoryFilter').value;
  const sel = document.getElementById('receiptOcrProductSelect');
  const candidateProducts = (catFilterVal ? products.filter(p => (p.category || '未分類') === catFilterVal) : products).filter(p => !p.hidden);
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
        body: JSON.stringify({ supplier_name: receiptOcrPartyId || '', lines: byScanId[scanId] })
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
  addOcrLineToTxBatch(productId, qty, finalAmount, line.docType, line.sourceFilename);
  await rememberReceiptLineMapping(receiptOcrPartyId, normalizeReceiptLineText(line.description), productId);
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

function skipReceiptOcrLine(){
  const line = pendingReceiptOcrLines.shift();
  // 記住「這個供應商 + 這行文字」不是商品資訊(公司資訊、地址這類常見的收據雜訊)——下次掃
  // 同一個供應商的收據,同樣的文字會直接自動跳過,不用每次都手動略過一次。
  if(line) rememberReceiptLineMapping(receiptOcrPartyId, normalizeReceiptLineText(line.description), RECEIPT_SKIP_SENTINEL);
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  processNextReceiptOcrLine();
}

async function cancelReceiptOcrSequence(){
  pendingReceiptOcrLines = [];
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  // 「取消全部」要是真的取消掉這整次掃描的所有影響,不只是清空還沒確認的品項——這次掃描過程中
  // 如果已經有幾筆新建的記憶(不管是「確認並加入」還是「略過這一行」建立的),一併復原刪除,
  // 不然下次同一張收據重新掃描,那幾筆被略過/確認的行會照舊記憶直接跳過,使用者會覺得「明明
  // 取消了,怎麼還是沒有跳出來問」,搞不清楚發生了什麼事。
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

function removePurchaseReceipt(){
  pendingPurchaseReceiptFiles = [];
  const wrap = document.getElementById('purchaseReceiptPreviewWrap');
  if(wrap){ wrap.style.display = 'none'; wrap.innerHTML = ''; }
  const msgEl = document.getElementById('purchaseReceiptUploadMsg');
  if(msgEl) msgEl.textContent = '';
}
