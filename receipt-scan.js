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
  mappings = mappings.slice().sort((a, b) => {
    const pa = productMap[a.productId], pb = productMap[b.productId];
    return (pa ? pa.name : '').localeCompare(pb ? pb.name : '');
  });

  if(mappings.length === 0){
    container.innerHTML = `<div class="empty-note">${t('ocrDbNoMappingsHint')}</div>`;
    return;
  }
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
  renderOcrDbMappingListWithSelection(checked);
}
function renderOcrDbMappingListWithSelection(checkAll){
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

async function handlePurchaseReceiptUpload(inputEl){
  const files = inputEl.files ? Array.from(inputEl.files) : [];
  if(files.length === 0) return;
  const msgEl = document.getElementById('purchaseReceiptUploadMsg');
  const maxBytes = 10 * 1024 * 1024;
  let successCount = 0;
  let failCount = 0;
  let lastFailReason = '';

  for(const file of files){
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
    const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_');
    const path = `${genId()}/${safeName}`;
    try{
      const arrayBuffer = await file.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: file.type || (looksLikePdfByExt ? 'application/pdf' : 'image/jpeg') });
      let uploadError = null;
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
  wrap.innerHTML = pendingPurchaseReceiptFiles.map((f, i) => `
    <div style="display:flex;align-items:center;gap:10px;">
      <a href="${f.url}" target="_blank" style="font-size:12.5px;">📎 ${escapeHtmlForPrint(f.filename)}</a>
      <span class="del-link" onclick="removePurchaseReceiptFile(${i})">${t('btnRemoveFile')}</span>
    </div>
  `).join('');
  const hasScannableFile = pendingPurchaseReceiptFiles.some(f => /\.(jpe?g|png|gif|bmp|webp|pdf)$/i.test(f.filename || f.url));
  if(scanWrap) scanWrap.style.display = (hasScannableFile && hasFeature('receiptScanModule')) ? 'block' : 'none';
}

function removePurchaseReceiptFile(index){
  pendingPurchaseReceiptFiles.splice(index, 1);
  renderPurchaseReceiptPreviewList();
}

let receiptOcrPartyId = null;
let currentReceiptScanId = null;
let receiptOcrConfirmedLinesForCorrection = [];

async function renderAllPdfPagesAsImageDataUrls(pdfUrl){
  if(typeof pdfjsLib === 'undefined') throw new Error('pdfjs not loaded');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
  const scale = 2;
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

async function callReceiptScanService(dataUrl, pageIndex){
  const blob = await (await fetch(dataUrl)).blob();
  const formData = new FormData();
  formData.append('file', blob, `receipt-page-${pageIndex + 1}.jpg`);

  let knownSuppliers = [];
  try{
    if(typeof purchaseSuppliers !== 'undefined' && Array.isArray(purchaseSuppliers)){
      knownSuppliers = purchaseSuppliers.map(s => (s.name || '').trim()).filter(Boolean);
    }
  } catch(e){
    console.error('收集既有供應商清單失敗(不影響掃描本身)', e);
  }
  formData.append('known_suppliers', JSON.stringify(knownSuppliers));

  // 使用者掃描前如果已經在「進貨方」選好供應商了,直接把這個名字當提示傳給後端——
  // 這比後端自己從OCR文字裡猜準確得多(是使用者確定選的,不是猜的),後端收到這個
  // 會直接跳過猜測,直接採用這個供應商過去學到的欄位/解析法設定,省掉「猜錯又要
  // 跳確認視窗」這一步。使用者沒有預先選的話(receiptOcrPartyId是空的),就傳空
  // 字串,後端會照原本的方式自己從OCR文字猜。
  formData.append('supplier_hint', receiptOcrPartyId || '');

  const resp = await fetch(`${RECEIPT_SCAN_SERVICE_URL}/v1/scan`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RECEIPT_SCAN_SERVICE_API_KEY}` },
    body: formData
  });
  if(!resp.ok) throw new Error(`收據掃描服務回傳錯誤 HTTP ${resp.status}`);
  const initial = await resp.json();
  if(initial.status === 'done') return initial;
  return await pollReceiptScanStatus(initial.scan_id);
}

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

function promptSupplierGuessConfirmation(guessedName){
  const guessedNorm = normalizeReceiptLineText(guessedName);
  const exactMatch = purchaseSuppliers.find(s => normalizeReceiptLineText(s.name) === guessedNorm);
  const partyHistorySelect = document.getElementById('txPartyHistorySelect');
  if(exactMatch){
    if(partyHistorySelect){ partyHistorySelect.value = exactMatch.name; }
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
        if(partyHistorySelect){ partyHistorySelect.value = best.name; }
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
  const file = pendingPurchaseReceiptFiles.find(f => /\.(jpe?g|png|gif|bmp|webp|pdf)$/i.test(f.filename || f.url));
  if(!file){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errReceiptScanNoImage');
    return;
  }
  if(!RECEIPT_SCAN_SERVICE_URL || !RECEIPT_SCAN_SERVICE_API_KEY){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errReceiptScanNotConfigured');
    return;
  }
  const isPdf = /\.pdf$/i.test(file.filename || file.url);
  const partyInput = document.getElementById('txParty');
  receiptOcrPartyId = partyInput ? partyInput.value.trim() : null;
  receiptOcrSessionNewMappingIds = [];
  currentReceiptScanId = null;
  receiptOcrConfirmedLinesForCorrection = [];

  const btn = document.getElementById('btnScanReceipt');
  btn.disabled = true;
  msgEl.style.color = 'var(--ink-soft)';
  msgEl.textContent = isPdf ? t('convertingPdfMsg') : t('scanningReceiptMsg');
  try{
    const ocrSources = isPdf ? await renderAllPdfPagesAsImageDataUrls(file.url) : [file.url];
    let allLines = [];
    let supplierGuess = null;
    for(let i = 0; i < ocrSources.length; i++){
      if(isPdf && ocrSources.length > 1){
        msgEl.textContent = tf('scanningPdfPageMsg', { current: i + 1, total: ocrSources.length });
      } else {
        msgEl.textContent = t('scanningReceiptMsg');
      }
      const data = await callReceiptScanService(ocrSources[i], i);
      if(i === 0){
        currentReceiptScanId = data.scan_id;
        supplierGuess = (data.supplier_guess || '').trim() || null;
      }
      const pageLines = (data.lines || []).map(l => ({
        description: l.name,
        qty: (l.qty && l.qty > 0) ? l.qty : 1,
        amount: (l.amount && l.amount > 0) ? l.amount : null
      }));
      allLines = allLines.concat(pageLines);
    }

    if(allLines.length === 0){
      msgEl.style.color = 'var(--crit)';
      msgEl.textContent = t('errReceiptScanNoLines');
      return;
    }
    pendingReceiptOcrLines = allLines;
    msgEl.style.color = 'var(--safe)';
    msgEl.textContent = tf('receiptScanFoundLinesMsg', { n: allLines.length });
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

function addOcrLineToTxBatch(productId, qty, amount){
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const existing = txBatchItems.find(it => it.productId === productId);
  if(existing){
    existing.qty += qty;
    if(amount) existing.amount = (existing.amount || 0) + amount;
  } else {
    const item = { productId, sku: p.sku || '', name: p.name, unit: p.unit, qty };
    if(amount) item.amount = amount;
    txBatchItems.push(item);
  }
  renderTxBatchList();
}

function processNextReceiptOcrLine(){
  if(pendingReceiptOcrLines.length === 0){
    renderTxBatchList();
    reportReceiptScanCorrections();
    return;
  }
  const line = pendingReceiptOcrLines[0];
  const memory = findReceiptLineMapping(receiptOcrPartyId, line.description);
  if(memory && memory.type === 'skip'){
    pendingReceiptOcrLines.shift();
    processNextReceiptOcrLine();
    return;
  }
  if(memory && memory.type === 'product'){
    addOcrLineToTxBatch(memory.product.id, line.qty, line.amount);
    pendingReceiptOcrLines.shift();
    processNextReceiptOcrLine();
    return;
  }
  openReceiptOcrConfirmModal(line);
}

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
  const numbersDisplay = document.getElementById('receiptOcrRawNumbersDisplay');
  if(numbersDisplay) numbersDisplay.textContent = '';
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
  resetSearchableSelect('receiptOcrProductSelect');
}

function selectReceiptOcrSuggestedProduct(productId){
  const catSel = document.getElementById('receiptOcrCategoryFilter');
  if(catSel) catSel.value = '';
  renderReceiptOcrProductOptions();
  document.getElementById('receiptOcrProductSelect').value = productId;
}

async function reportReceiptScanCorrections(){
  if(!currentReceiptScanId || receiptOcrConfirmedLinesForCorrection.length === 0){
    currentReceiptScanId = null;
    receiptOcrConfirmedLinesForCorrection = [];
    return;
  }
  const scanId = currentReceiptScanId;
  const lines = receiptOcrConfirmedLinesForCorrection.slice();
  currentReceiptScanId = null;
  receiptOcrConfirmedLinesForCorrection = [];
  try{
    await fetch(`${RECEIPT_SCAN_SERVICE_URL}/v1/scan/${scanId}/correct`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RECEIPT_SCAN_SERVICE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ supplier_name: receiptOcrPartyId || '', lines })
    });
  } catch(e){
    console.error('回報收據掃描修正結果失敗(不影響本次進貨,只影響未來辨識準確度)', e);
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
  addOcrLineToTxBatch(productId, qty, finalAmount);
  await rememberReceiptLineMapping(receiptOcrPartyId, normalizeReceiptLineText(line.description), productId);
  receiptOcrConfirmedLinesForCorrection.push({ name: line.description, qty, amount: finalAmount });
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  processNextReceiptOcrLine();
}

function skipReceiptOcrLine(){
  const line = pendingReceiptOcrLines.shift();
  if(line) rememberReceiptLineMapping(receiptOcrPartyId, normalizeReceiptLineText(line.description), RECEIPT_SKIP_SENTINEL);
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  processNextReceiptOcrLine();
}

async function cancelReceiptOcrSequence(){
  pendingReceiptOcrLines = [];
  document.getElementById('receiptOcrConfirmModalOverlay').style.display = 'none';
  const idsToRevert = receiptOcrSessionNewMappingIds.slice();
  receiptOcrSessionNewMappingIds = [];
  for(const id of idsToRevert){
    try{
      await sb.from('receipt_line_mappings').delete().eq('id', id);
      receiptLineMappings = receiptLineMappings.filter(m => m.id !== id);
    } catch(e){ console.error('復原取消的收據辨識記憶失敗', e); }
  }
  currentReceiptScanId = null;
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
