// ============================================================
// 商品編輯——刪除/編輯商品、新增批量商品(子商品)、編輯視窗
// 內容渲染與存檔、商品照片上傳、批量商品↔主商品數量切換
// (轉換視窗跟確認邏輯)。收據掃描/進貨收據上傳是登記進出貨
// 流程的一部分,不算這裡,留在主程式。
// ============================================================
// 刪除商品現在只會從「編輯商品」畫面裡呼叫(庫存總覽清單本身不再放刪除按鈕,省空間),
// 所以一律先跳確認視窗,成功之後順便關掉編輯視窗。
function deleteProduct(id){
  if(!hasCapability('cap-edit-overview')) return;
  const children = getChildProducts(id);
  const idsToDelete = [id, ...children.map(c => c.id)];
  const hasTx = transactions.some(t => idsToDelete.includes(t.productId));
  const warnMsg = children.length > 0
    ? `這個商品有 ${children.length} 個批量商品,刪除主商品會一併刪除所有批量商品${hasTx ? '及相關進出貨紀錄' : ''}。確定要刪除嗎?`
    : (hasTx ? '這個商品已有進出貨紀錄,刪除商品會一併刪除所有相關紀錄。確定要刪除嗎?' : t('confirmDeleteProductSimple'));
  showConfirmModal(warnMsg, async () => {
    const removed = transactions.filter(t => idsToDelete.includes(t.productId));
    transactions = transactions.filter(t => !idsToDelete.includes(t.productId));
    if(removed.length > 0) await deleteTransactions(removed);
    idsToDelete.forEach(pid => { delete productStockMap[pid]; });
    products = products.filter(p => !idsToDelete.includes(p.id));
    await saveProducts();
    closeProductEditModal();
    renderAll();
  });
}

function startEditProduct(id){
  if(!hasCapability('cap-edit-overview')) return;
  openProductEditModal(id);
}

function openProductEditModal(id){
  const p = products.find(x => x.id === id);
  if(!p) return;
  editingProductId = id;
  editingProductPhotoUrl = p.photoUrl || null;
  addingChildParentId = null;
  pendingTotalStockBasisChoice = null;
  document.getElementById('productEditModalTitle').textContent = `${t('btnEdit')} — ${p.name}`;
  document.getElementById('productEditModalBody').innerHTML = renderProductEditModalBody(p);
  document.getElementById('productEditModalMsg').textContent = '';
  document.getElementById('productEditModalOverlay').style.display = 'flex';
}

// 新增批量商品:掛在某個主商品底下(例如百香果汁 → 百香果汁x20瓶)。
function openAddChildModal(parentId){
  if(!hasCapability('cap-edit-overview')) return;
  const parent = products.find(x => x.id === parentId);
  if(!parent) return;
  editingProductId = null;
  editingProductPhotoUrl = null;
  addingChildParentId = parentId;
  const draft = { sku: parent.sku ? guessNextChildSku(parent) : '', name: '', unit: parent.unit || '', category: parent.category, manualAvg: null, safetyStock: null, note: '', childWeight: null, parentId };
  document.getElementById('productEditModalTitle').textContent = `新增批量商品 — ${parent.name}`;
  document.getElementById('productEditModalBody').innerHTML = renderProductEditModalBody(draft, { isChild: true, parent, isNew: true });
  document.getElementById('productEditModalMsg').textContent = '';
  document.getElementById('productEditModalOverlay').style.display = 'flex';
}

// 猜測批量商品 SKU:主商品 SKU 後面接下一個還沒用過的英文字母(SKU005 → SKU005A、SKU005B...)。
function guessNextChildSku(parent){
  const existing = getChildProducts(parent.id).map(c => (c.sku||'').toUpperCase());
  for(let i = 0; i < 26; i++){
    const letter = String.fromCharCode(65 + i);
    const candidate = parent.sku + letter;
    if(!existing.includes(candidate.toUpperCase())) return candidate;
  }
  return parent.sku + 'X';
}

function renderProductEditModalBody(p, opts){
  opts = opts || {};
  const isChild = !!(opts.isChild || p.parentId);
  const parent = opts.parent || (p.parentId ? products.find(x => x.id === p.parentId) : null);
  const catOptions = categoryOrder.map(c => `<option value="${c}" ${c === (p.category||'未分類') ? 'selected' : ''}>${catLabel(c)}</option>`).join('');
  // 「顯示於總庫存量」勾選框:只有在這個商品家族(主商品+底下的 multipack 子商品)確實有兩個以上
  // 成員可以選的情況下才顯示(自己是子商品,或自己是有 multipack 子商品的主商品),而且要儲存過的
  // 商品才有得選(新增中的商品還沒有 id,沒東西可以指定)。
  const familyParent = isChild ? parent : p;
  const showBasisToggle = !opts.isNew && !!familyParent && (isChild || getChildProducts(p.id).length > 0);
  const currentBasisId = familyParent ? (familyParent.totalStockBasisId || familyParent.id) : null;
  // 「已完成訂單匯出不顯示」勾選框:現在所有商品(不管主商品、子商品、有沒有 multipack 家族)
  // 都可以個別設定,預設不勾。如果是「有 multipack 子商品的主商品」,勾選之後還會多一個下拉選單,
  // 選擇整個家族都不顯示、還是維持原本「僅顯示切換的批量商品數量」的行為。
  const showHideFromExportToggle = !opts.isNew && hasFeature('hideFromCompletedExport');
  const hasChildrenForExportMode = !isChild && getChildProducts(p.id).length > 0;
  // 子商品自己的「已完成訂單匯出不顯示」勾選框,要不要鎖住/強制勾選,看主商品目前的設定:
  // ·主商品是「整個家族都不顯示」模式 → 子商品自己這裡強制勾選、鎖住不能改(整個家族一起隱藏,
  //   子商品沒有自己單獨顯示/不顯示的空間)
  // ·主商品是「僅顯示切換的批量商品數量」模式(或主商品根本沒勾隱藏)→ 子商品這裡鎖住不能勾選,
  //   因為這個模式本來就是要靠子商品自己顯示、去接主商品切換過來的數量,子商品如果自己也被
  //   個別隱藏掉,切換的數量會完全消失看不到,所以不開放個別勾選
  // ·主商品完全沒有勾選隱藏 → 子商品自己這裡完全自由,跟家族設定無關,正常勾選/取消
  let childExportCheckboxForceChecked = false;
  let childExportCheckboxLocked = false;
  if(isChild && parent && parent.hideFromCompletedOrderExport){
    if(parent.hideFromCompletedOrderExportMode === 'wholeFamily'){
      childExportCheckboxForceChecked = true;
      childExportCheckboxLocked = true;
    } else {
      childExportCheckboxLocked = true;
    }
  }
  return `
    ${isChild && parent ? `
    <div class="field-block">
      <label>上層商品(主商品)</label>
      <input type="text" value="${parent.name.replace(/"/g,'&quot;')}" disabled style="width:100%;background:var(--bg);" />
    </div>
    ` : ''}
    <div class="field-block">
      <label>SKU</label>
      <input type="text" id="editProdSku" value="${p.sku ? p.sku.replace(/"/g,'&quot;') : ''}" placeholder="SKU" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('fieldName')}</label>
      <input type="text" id="editProdName" value="${(p.name||'').replace(/"/g,'&quot;')}" style="width:100%;" placeholder="${isChild ? t('fieldChildProductNamePlaceholderExample') : ''}" />
    </div>
    <div class="field-block">
      <label>${t('fieldUnit')}</label>
      <input type="text" id="editProdUnit" value="${p.unit||''}" placeholder="單位" data-i18n-placeholder="fieldUnit" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('fieldProductPhoto')}</label>
      <div id="editProdPhotoPreviewWrap" style="margin-bottom:8px;${editingProductPhotoUrl ? '' : 'display:none;'}">
        <img id="editProdPhotoPreview" src="${editingProductPhotoUrl || ''}" style="max-width:120px;max-height:120px;border-radius:4px;border:1px solid var(--line);display:block;" />
        <span class="del-link" onclick="removeProductPhoto()" style="display:inline-block;margin-top:4px;">${t('btnRemovePhoto')}</span>
      </div>
      <input type="file" id="editProdPhotoInput" accept="image/*" onchange="handleProductPhotoUpload(this)" />
      <div id="editProdPhotoUploadMsg" style="font-size:11.5px;margin-top:4px;"></div>
    </div>
    ${isChild ? `
    <div class="field-block">
      <label>庫存量加權數<span style="color:var(--ink-soft);font-weight:400;"> — 計算主商品庫存總量時,批量商品數量會先乘以這個數字</span></label>
      <input type="number" id="editProdWeight" min="0" step="0.01" value="${p.childWeight !== null && p.childWeight !== undefined ? p.childWeight : ''}" placeholder="例如:20" data-i18n-placeholder="fieldChildWeightPlaceholderExample" style="width:100%;" />
    </div>
    ${!opts.isNew ? `
    <div class="field-block">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:400;">
        <input type="checkbox" id="editProdAutoConvertStockIn" ${p.autoConvertOnStockIn ? 'checked' : ''} />
        <span>${t('fieldAutoConvertStockIn')}<span style="color:var(--ink-soft);font-weight:400;"> ${t('fieldAutoConvertStockInHint')}</span></span>
      </label>
    </div>
    ` : ''}
    ` : `
    <div class="field-block">
      <label>${t('fieldCategory')}</label>
      <select id="editProdCategory" style="width:100%;padding:8px;">${catOptions}</select>
    </div>
    `}
    <div class="field-block">
      <label>${t('colAvgOut')} / ${t('fieldAvg')}</label>
      <input type="number" id="editProdAvg" min="0" step="0.1" value="${p.manualAvg !== null && p.manualAvg !== undefined ? p.manualAvg : ''}" placeholder="月均使用量" data-i18n-placeholder="fieldAvgMonthlyPlaceholder" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('fieldSafetyStockMonths')}</label>
      <input type="number" id="editProdSafety" min="0" step="0.01" value="${p.safetyStock !== null && p.safetyStock !== undefined ? p.safetyStock : ''}" placeholder="${t('fieldSafetyStockMonthsPlaceholder')}" style="width:100%;" />
      <div class="field-hint">${t('safetyStockMonthsHint')}</div>
    </div>
    <div class="field-block">
      <label>${t('colNote')}</label>
      <input type="text" id="editProdNote" value="${p.note ? p.note.replace(/"/g,'&quot;') : ''}" placeholder="備註" data-i18n-placeholder="colNote" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('fieldOrderPageRemark')}</label>
      <input type="text" id="editProdOrderPageRemark" value="${p.orderPageRemark ? p.orderPageRemark.replace(/"/g,'&quot;') : ''}" placeholder="${t('fieldOrderPageRemarkPlaceholder')}" style="width:100%;" />
      <div class="field-hint">${t('orderPageRemarkHint')}</div>
    </div>
    <div class="field-block">
      <label>${t('fieldBarcode')}</label>
      <input type="text" id="editProdBarcode" value="${(p.barcode || '').replace(/"/g,'&quot;')}" placeholder="${t('barcodeInputPlaceholder')}" style="width:100%;" />
      <div class="field-hint">${t('barcodeInputHint')}</div>
    </div>
    <div class="field-block">
      <label>${t('fieldBoxDimensions')}</label>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <input type="number" id="editProdBoxL" min="0" step="0.1" value="${p.boxLengthCm !== null && p.boxLengthCm !== undefined ? p.boxLengthCm : ''}" placeholder="${t('fieldBoxLength')}" />
        <input type="number" id="editProdBoxW" min="0" step="0.1" value="${p.boxWidthCm !== null && p.boxWidthCm !== undefined ? p.boxWidthCm : ''}" placeholder="${t('fieldBoxWidth')}" />
        <input type="number" id="editProdBoxH" min="0" step="0.1" value="${p.boxHeightCm !== null && p.boxHeightCm !== undefined ? p.boxHeightCm : ''}" placeholder="${t('fieldBoxHeight')}" />
      </div>
      <div class="field-hint">${t('boxDimensionsHint')}</div>
    </div>
    ${!opts.isNew ? `
    <div class="field-block">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:400;">
        <input type="checkbox" id="editProdHidden" ${p.hidden ? 'checked' : ''} />
        <span>${t('fieldHiddenToggle')}<span style="color:var(--ink-soft);font-weight:400;"> ${t('fieldHiddenToggleHint')}</span></span>
      </label>
    </div>
    ` : ''}
    ${showBasisToggle ? `
    <div class="field-block">
      <label style="display:flex;align-items:center;gap:6px;cursor:${p.hidden ? 'not-allowed' : 'pointer'};font-weight:400;">
        <input type="checkbox" id="editProdShowInTotal" ${currentBasisId === p.id ? 'checked' : ''} ${p.hidden ? 'disabled' : ''}
          onchange="handleShowInTotalToggle(this, '${p.id}')" />
        <span>${t('fieldShowInTotalStock')}<span style="color:var(--ink-soft);font-weight:400;"> ${p.hidden ? t('fieldShowInTotalStockHiddenHint') : t('fieldShowInTotalStockHint')}</span></span>
      </label>
    </div>
    ` : ''}
    ${showHideFromExportToggle ? `
    <div class="field-block">
      <label style="display:flex;align-items:center;gap:6px;cursor:${childExportCheckboxLocked ? 'not-allowed' : 'pointer'};font-weight:400;">
        <input type="checkbox" id="editProdHideFromExport" ${(p.hideFromCompletedOrderExport || childExportCheckboxForceChecked) ? 'checked' : ''} ${childExportCheckboxLocked ? 'disabled' : ''} onchange="toggleHideFromExportModeVisibility(this)" />
        <span>${t('fieldHideFromCompletedExport')}</span>
      </label>
      ${childExportCheckboxLocked ? `<p style="font-size:11.5px;color:var(--ink-soft);margin:4px 0 0 22px;">${childExportCheckboxForceChecked ? t('hideExportChildForcedHint') : t('hideExportChildLockedHint')}</p>` : ''}
      ${hasChildrenForExportMode ? `
      <div id="hideFromExportModeWrap" style="display:${p.hideFromCompletedOrderExport ? 'block' : 'none'};margin:8px 0 0 22px;">
        <select id="editProdHideFromExportMode" onchange="toggleHideFromExportHintVisibility(this)">
          <option value="switchOnly" ${(!p.hideFromCompletedOrderExportMode || p.hideFromCompletedOrderExportMode === 'switchOnly') ? 'selected' : ''}>${t('hideExportModeSwitchOnly')}</option>
          <option value="wholeFamily" ${p.hideFromCompletedOrderExportMode === 'wholeFamily' ? 'selected' : ''}>${t('hideExportModeWholeFamily')}</option>
        </select>
        <p id="hideFromExportHint" style="display:${(!p.hideFromCompletedOrderExportMode || p.hideFromCompletedOrderExportMode === 'switchOnly') ? 'block' : 'none'};font-size:11.5px;color:var(--ink-soft);margin:6px 0 0;">${t('fieldHideFromCompletedExportHint')}</p>
      </div>
      ` : ''}
    </div>
    ` : ''}
    ${!isChild && !opts.isNew ? `
    <div class="field-block" style="display:flex;gap:16px;flex-wrap:wrap;">
      <span class="del-link" onclick="closeProductEditModal(); openAddChildModal('${p.id}');">${t('btnAddChild')}</span>
    </div>
    ` : ''}
    ${!opts.isNew ? `
    <div class="field-block">
      <span class="del-link" style="color:var(--crit);" onclick="deleteProduct('${p.id}')">${t('btnDeleteProduct')}</span>
    </div>
    ` : ''}
  `;
}

function closeProductEditModal(){
  editingProductId = null;
  addingChildParentId = null;
  pendingTotalStockBasisChoice = null;
  document.getElementById('productEditModalOverlay').style.display = 'none';
}

// 商品照片上傳:選好檔案就立刻上傳到 Supabase Storage(product-photos bucket),不用等按整個
// 表單的「儲存」——這樣上傳成功/失敗當下就有回饋,不用等儲存整張表單才知道結果。上傳完拿到的
// 公開網址先存在 editingProductPhotoUrl 這個暫存變數裡,真正寫進商品資料要等按「儲存」時才會
// 套用(見 saveProductEditModal)。
async function handleProductPhotoUpload(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  const msgEl = document.getElementById('editProdPhotoUploadMsg');
  if(!file.type.startsWith('image/')){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errPhotoMustBeImage');
    inputEl.value = '';
    return;
  }
  const maxBytes = 5 * 1024 * 1024; // 5MB——單純避免有人選到超大原始檔拖慢上傳/日後載入速度
  if(file.size > maxBytes){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errPhotoTooLarge');
    inputEl.value = '';
    return;
  }
  msgEl.style.color = 'var(--ink-soft)';
  msgEl.textContent = t('uploadingPhotoMsg');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${genId()}.${ext}`;
  try{
    const { error } = await sb.storage.from('product-photos').upload(path, file, { upsert: true });
    if(error) throw error;
    const { data } = sb.storage.from('product-photos').getPublicUrl(path);
    editingProductPhotoUrl = data.publicUrl;
    document.getElementById('editProdPhotoPreview').src = editingProductPhotoUrl;
    document.getElementById('editProdPhotoPreviewWrap').style.display = '';
    msgEl.style.color = 'var(--safe)';
    msgEl.textContent = t('photoUploadedMsg');
  } catch(e){
    console.error('上傳商品照片失敗', e);
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errPhotoUploadFailed');
  }
  inputEl.value = '';
}

// 移除照片:只是把暫存的網址清掉、預覽藏起來,實際上不會去刪 Storage 裡的檔案(留著也無妨,
// 不影響任何功能,避免「不小心點到移除又要重新上傳一次」的麻煩,也不用處理刪除失敗的情況)。
// 真正生效(這個商品不再有照片)一樣要等按「儲存」。
function removeProductPhoto(){
  editingProductPhotoUrl = null;
  const wrap = document.getElementById('editProdPhotoPreviewWrap');
  if(wrap) wrap.style.display = 'none';
  const msgEl = document.getElementById('editProdPhotoUploadMsg');
  if(msgEl) msgEl.textContent = '';
}

async function saveProductEditModal(){
  const id = editingProductId;
  const isNewChild = !!addingChildParentId;
  const p = isNewChild ? null : products.find(x => x.id === id);
  const msg = document.getElementById('productEditModalMsg');
  if(!isNewChild && !p) return;
  const isChild = isNewChild || !!(p && p.parentId);

  const sku = document.getElementById('editProdSku').value.trim();
  const name = document.getElementById('editProdName').value.trim();
  const unit = document.getElementById('editProdUnit').value.trim() || '個';
  const avgRaw = document.getElementById('editProdAvg').value.trim();
  const safetyRaw = document.getElementById('editProdSafety').value.trim();
  const note = document.getElementById('editProdNote').value.trim();
  const orderPageRemarkEl = document.getElementById('editProdOrderPageRemark');
  const orderPageRemark = orderPageRemarkEl ? orderPageRemarkEl.value.trim() : '';
  const barcodeEl = document.getElementById('editProdBarcode');
  const barcode = barcodeEl ? barcodeEl.value.trim() : '';
  const boxLRaw = document.getElementById('editProdBoxL') ? document.getElementById('editProdBoxL').value.trim() : '';
  const boxWRaw = document.getElementById('editProdBoxW') ? document.getElementById('editProdBoxW').value.trim() : '';
  const boxHRaw = document.getElementById('editProdBoxH') ? document.getElementById('editProdBoxH').value.trim() : '';
  const boxLengthCm = boxLRaw ? parseFloat(boxLRaw) : null;
  const boxWidthCm = boxWRaw ? parseFloat(boxWRaw) : null;
  const boxHeightCm = boxHRaw ? parseFloat(boxHRaw) : null;

  if(!name){ msg.className = 'msg error'; msg.textContent = '商品名稱不能空白'; return; }
  if(products.some(x => x.id !== id && x.name === name)){ msg.className = 'msg error'; msg.textContent = '已經有另一個商品叫這個名字了'; return; }

  let weightVal = null;
  if(isChild){
    const weightRaw = document.getElementById('editProdWeight').value.trim();
    if(weightRaw === '' || isNaN(parseFloat(weightRaw)) || parseFloat(weightRaw) <= 0){
      msg.className = 'msg error'; msg.textContent = '請輸入批量商品的庫存量加權數(大於 0 的數字)'; return;
    }
    weightVal = parseFloat(weightRaw);
  }

  if(isNewChild){
    const parent = products.find(x => x.id === addingChildParentId);
    if(!parent){ msg.className = 'msg error'; msg.textContent = '找不到上層商品'; return; }
    products.push({
      id: genId(), sku, name, unit, category: parent.category || '未分類',
      manualAvg: avgRaw === '' ? null : parseFloat(avgRaw),
      safetyStock: safetyRaw === '' ? null : parseFloat(safetyRaw),
      note, orderable: false, parentId: parent.id, childWeight: weightVal,
      orderPageRemark: orderPageRemark || undefined,
      barcode: barcode || undefined,
      photoUrl: editingProductPhotoUrl || undefined,
      boxLengthCm: boxLengthCm !== null && !isNaN(boxLengthCm) ? boxLengthCm : undefined,
      boxWidthCm: boxWidthCm !== null && !isNaN(boxWidthCm) ? boxWidthCm : undefined,
      boxHeightCm: boxHeightCm !== null && !isNaN(boxHeightCm) ? boxHeightCm : undefined
    });
  } else {
    p.sku = sku;
    p.name = name;
    p.unit = unit;
    if(!isChild){
      p.category = document.getElementById('editProdCategory').value;
    } else {
      p.childWeight = weightVal;
      const autoConvertEl = document.getElementById('editProdAutoConvertStockIn');
      if(autoConvertEl) p.autoConvertOnStockIn = autoConvertEl.checked;
    }
    p.manualAvg = avgRaw === '' ? null : parseFloat(avgRaw);
    p.safetyStock = safetyRaw === '' ? null : parseFloat(safetyRaw);
    p.note = note;
    p.orderPageRemark = orderPageRemark || undefined;
    p.barcode = barcode || undefined;
    p.photoUrl = editingProductPhotoUrl || undefined;
    p.boxLengthCm = boxLengthCm !== null && !isNaN(boxLengthCm) ? boxLengthCm : undefined;
    p.boxWidthCm = boxWidthCm !== null && !isNaN(boxWidthCm) ? boxWidthCm : undefined;
    p.boxHeightCm = boxHeightCm !== null && !isNaN(boxHeightCm) ? boxHeightCm : undefined;
    const hiddenEl = document.getElementById('editProdHidden');
    if(hiddenEl) p.hidden = hiddenEl.checked;
    const showInTotalEl = document.getElementById('editProdShowInTotal');
    if(showInTotalEl) applyTotalStockBasisChoice(p, showInTotalEl.checked);
    const hideFromExportEl = document.getElementById('editProdHideFromExport');
    if(hideFromExportEl){
      p.hideFromCompletedOrderExport = hideFromExportEl.checked;
      const modeEl = document.getElementById('editProdHideFromExportMode');
      if(modeEl) p.hideFromCompletedOrderExportMode = modeEl.value;
      // 主商品選了「整個家族都不顯示」的話,底下所有子商品自己的隱藏設定要跟著強制打勾——
      // 子商品自己的編輯畫面那個勾選框會被鎖住不能改,存檔的時候也要確保資料本身是一致的,
      // 不能出現「畫面上鎖住勾選,但資料庫裡其實沒存成勾選」這種不一致。
      if(!p.parentId && p.hideFromCompletedOrderExport && p.hideFromCompletedOrderExportMode === 'wholeFamily'){
        getChildProducts(p.id).forEach(c => { c.hideFromCompletedOrderExport = true; });
      }
    }
  }

  await saveProducts();
  closeProductEditModal();
  renderAll();
}

// ===== 批量商品 ↔ 主商品 數量切換 =====
// 切換是指:把批量商品的數量,依加權數換算成主商品的數量,批量商品扣、主商品加。
// 這個變化不算是一般的出貨/進貨,不會影響平均出貨量的計算(computeAvgMonthlyOut / computePerOrderAvgForParty 都會排除 conversion 紀錄)。
function openConversionModal(childId){
  const child = products.find(x => x.id === childId);
  if(!child || !child.parentId) return;
  const parent = products.find(x => x.id === child.parentId);
  if(!parent) return;
  conversionMode = 'toParent';
  pendingConversionChildId = childId;
  conversionParentId = null;
  const childStock = computeStock(childId);
  const defaultQty = Math.min(conversionDefaultQty, childStock) || 1;
  document.getElementById('conversionModalTitle').textContent = `${t('btnConvertToParent')} —「${child.name}」→「${parent.name}」`;
  document.getElementById('conversionModalBody').innerHTML = `
    <p style="font-size:12.5px;color:var(--ink-soft);margin:0 0 12px;">
      ${tf('convertToParentDesc', { name: child.name, stock: childStock, unit: child.unit, weight: child.childWeight || 1 })}
    </p>
    <div class="field-block">
      <label>${t('fieldConvertQtyToParent')}(${child.unit})</label>
      <input type="number" id="conversionQty" min="0" max="${childStock}" step="1" value="${defaultQty}" oninput="updateConversionPreview()" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('fieldConvertResultToParent')}(${parent.unit})</label>
      <div id="conversionPreview" style="font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:600;">0 ${parent.unit}</div>
    </div>
    ${buildLocationPickerHtml('conversionLoc', 'fieldAssignLocation')}
  `;
  document.getElementById('conversionModalMsg').textContent = '';
  document.getElementById('conversionModalOverlay').style.display = 'flex';
  updateConversionPreview();
  populateLocationPicker('conversionLoc', parent.id);
}

// 主商品 → 批量商品(組裝多入裝):跟原本的「切換」方向相反,把主商品的數量拆成批量商品的數量。
function openParentToChildConversionModal(parentId){
  const parent = products.find(x => x.id === parentId);
  if(!parent) return;
  const children = getChildProducts(parentId);
  if(children.length === 0) return;
  conversionMode = 'toChild';
  conversionParentId = parentId;
  pendingConversionChildId = children[0].id;
  renderParentToChildConversionBody();
  document.getElementById('conversionModalMsg').textContent = '';
  document.getElementById('conversionModalOverlay').style.display = 'flex';
}

function renderParentToChildConversionBody(){
  const parent = products.find(x => x.id === conversionParentId);
  if(!parent) return;
  const children = getChildProducts(conversionParentId);
  const selectedChild = children.find(c => c.id === pendingConversionChildId) || children[0];
  pendingConversionChildId = selectedChild.id;
  const parentStock = computeStock(parent.id);
  const defaultQty = Math.min(conversionDefaultQty, parentStock) || 1;
  document.getElementById('conversionModalTitle').textContent = `${t('btnConvertToChild')} —「${parent.name}」→「${selectedChild.name}」`;
  document.getElementById('conversionModalBody').innerHTML = `
    <p style="font-size:12.5px;color:var(--ink-soft);margin:0 0 12px;">
      ${tf('convertToChildDesc', { name: parent.name, stock: parentStock, unit: parent.unit })}
    </p>
    ${children.length > 1 ? `
    <div class="field-block">
      <label>${t('fieldTargetChild')}</label>
      <select id="conversionTargetChild" onchange="changeConversionTargetChild(this.value)" style="width:100%;padding:8px;">
        ${children.map(c => `<option value="${c.id}" ${c.id === selectedChild.id ? 'selected' : ''}>${c.name}(×${c.childWeight || 1})</option>`).join('')}
      </select>
    </div>
    ` : ''}
    <div class="field-block">
      <label>${t('fieldConvertQtyToChild')}(${parent.unit})</label>
      <input type="number" id="conversionQty" min="0" max="${parentStock}" step="1" value="${defaultQty}" oninput="updateConversionPreview()" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('fieldConvertResultToChild')}(${selectedChild.unit})</label>
      <div id="conversionPreview" style="font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:600;">0 ${selectedChild.unit}</div>
    </div>
    ${buildLocationPickerHtml('conversionLoc', 'fieldAssignLocation')}
  `;
  updateConversionPreview();
  populateLocationPicker('conversionLoc', selectedChild.id);
}

function changeConversionTargetChild(childId){
  pendingConversionChildId = childId;
  renderParentToChildConversionBody();
}

function updateConversionPreview(){
  const qtyEl = document.getElementById('conversionQty');
  const qty = parseFloat(qtyEl.value);
  const preview = document.getElementById('conversionPreview');
  if(conversionMode === 'toChild'){
    const child = products.find(x => x.id === pendingConversionChildId);
    const weight = child ? (child.childWeight || 1) : 1;
    if(!isNaN(qty) && qty > 0){
      preview.textContent = `${(qty / weight).toLocaleString(undefined, {maximumFractionDigits: 2})} ${child ? child.unit : ''}`;
    } else {
      preview.textContent = `0 ${child ? child.unit : ''}`;
    }
    return;
  }
  const childId = pendingConversionChildId;
  const child = products.find(x => x.id === childId);
  if(!child) return;
  const parent = products.find(x => x.id === child.parentId);
  const weight = child.childWeight || 1;
  if(!isNaN(qty) && qty > 0){
    preview.textContent = `${(qty * weight).toLocaleString(undefined, {maximumFractionDigits: 2})} ${parent ? parent.unit : ''}`;
  } else {
    preview.textContent = `0 ${parent ? parent.unit : ''}`;
  }
}

function closeConversionModal(){
  pendingConversionChildId = null;
  conversionMode = null;
  conversionParentId = null;
  conversionSourceBatchProductId = null;
  conversionSourceVerifyProductId = null;
  conversionDefaultQty = 1;
  document.getElementById('conversionModalOverlay').style.display = 'none';
}

async function confirmConversion(){
  const msg = document.getElementById('conversionModalMsg');

  if(conversionMode === 'toChild'){
    const parent = products.find(x => x.id === conversionParentId);
    const child = products.find(x => x.id === pendingConversionChildId);
    if(!parent || !child){ closeConversionModal(); return; }
    const qty = parseFloat(document.getElementById('conversionQty').value);
    if(isNaN(qty) || qty <= 0){ msg.className = 'msg error'; msg.textContent = t('errEnterPositiveQty'); return; }
    if(!Number.isInteger(qty)){ msg.className = 'msg error'; msg.textContent = t('errConversionMustBeInteger'); return; }
    const parentStock = computeStock(parent.id);
    if(qty > parentStock){ msg.className = 'msg error'; msg.textContent = tn('errExceedParentStock', parentStock); return; }

    const weight = child.childWeight || 1;
    const convertedQty = qty / weight;
    if(!Number.isInteger(convertedQty)){
      msg.className = 'msg error';
      msg.textContent = tf('errConversionResultNotInteger', { result: convertedQty.toLocaleString(undefined, {maximumFractionDigits: 4}), unit: child.unit });
      return;
    }
    // 新增出來的批量商品如果要指派到「新增位置」,標準模式下要先檢查有沒有填完整,理由跟庫存
    // 分布頁面的「編輯位置」一樣:漏填會接出一個殘缺的位置代碼,事後看不出來哪裡漏填了。
    const destSelForChild = document.getElementById('conversionLocSelect');
    if(destSelForChild && (destSelForChild.value === 'new' || destSelForChild.value === 'lastPrimary')){
      const missingFields = getMissingStandardLocationFields('conversionLoc', '');
      if(missingFields.length > 0){
        msg.className = 'msg error';
        msg.textContent = tf('errMissingLocationFields', { fields: missingFields.join(', ') });
        return;
      }
    }
    // 扣庫存之前,先問清楚主商品要從哪個位置扣——理由跟核對訂單、列印撿貨單時一樣:要是先扣了
    // 庫存,選位置的過程中使用者卻按了取消,庫存分布資料就會跟實際庫存對不起來。這裡修正的正是
    // 之前的漏洞:切換只有幫「多出來的批量商品」指派位置,卻從來沒有從主商品原本的位置扣過,
    // 導致庫存分布頁面的數字跟主商品實際庫存對不起來。
    let sourceLocationChoices;
    try{
      sourceLocationChoices = await resolveLocationChoicesForItems([{ productId: parent.id, qty }]);
    } catch(e){ return; } // 使用者在選位置的過程中按了取消,整個轉換中止

    const dateVal = todayISO();
    const nowIso = new Date().toISOString();
    const conversionId = genId();
    const txA = {
      id: genId(), productId: parent.id, type: 'out', qty, date: dateVal, createdAt: nowIso,
      party: '', note: `轉換為批量商品「${child.name}」`, system: true, conversion: true, conversionId
    };
    const txB = {
      id: genId(), productId: child.id, type: 'in', qty: convertedQty, date: dateVal, createdAt: nowIso,
      party: '', note: `由主商品「${parent.name}」轉換而來`, system: true, conversion: true, conversionId
    };
    transactions.push(txA, txB);
    try{ await insertTransactions([txA, txB]); }
    catch(e){
      transactions = transactions.filter(t => t.id !== txA.id && t.id !== txB.id);
      msg.className = 'msg error';
      msg.textContent = '⚠ 轉換失敗,請重新整理頁面再試一次。';
      return;
    }
    // 交易確定成功之後才處理位置變動,避免庫存扣了/位置卻沒對應更新的不一致:先把主商品
    // 原本的位置庫存扣掉,再幫轉換出來的批量商品指派位置。
    await applyLocationDeductions(sourceLocationChoices);
    await applyConversionLocationAssignment('conversionLoc', child.id, convertedQty);
    const batchProductId = conversionSourceBatchProductId;
    const verifyProductId = conversionSourceVerifyProductId;
    closeConversionModal();
    if(batchProductId) txBatchItems = txBatchItems.filter(it => it.productId !== batchProductId);
    if(verifyProductId) verifyPageRightItems = verifyPageRightItems.filter(it => it.productId !== verifyProductId);
    renderAll();
    renderVerifyPageRightItems();
    return;
  }

  const childId = pendingConversionChildId;
  const child = products.find(x => x.id === childId);
  if(!child){ closeConversionModal(); return; }
  const parent = products.find(x => x.id === child.parentId);
  if(!parent){ msg.className = 'msg error'; msg.textContent = '找不到主商品'; return; }

  const qty = parseFloat(document.getElementById('conversionQty').value);
  if(isNaN(qty) || qty <= 0){ msg.className = 'msg error'; msg.textContent = '請輸入大於 0 的數量'; return; }
  if(!Number.isInteger(qty)){ msg.className = 'msg error'; msg.textContent = t('errConversionMustBeInteger'); return; }
  const childStock = computeStock(childId);
  if(qty > childStock){ msg.className = 'msg error'; msg.textContent = `切換數量不能超過目前批量商品庫存量(${childStock})`; return; }

  const weight = child.childWeight || 1;
  const convertedQty = qty * weight;
  if(!Number.isInteger(convertedQty)){
    msg.className = 'msg error';
    msg.textContent = tf('errConversionResultNotInteger', { result: convertedQty.toLocaleString(undefined, {maximumFractionDigits: 4}), unit: parent.unit });
    return;
  }
  // 新增出來的主商品如果要指派到「新增位置」,標準模式下一樣要先檢查有沒有填完整(同上)。
  const destSelForParent = document.getElementById('conversionLocSelect');
  if(destSelForParent && (destSelForParent.value === 'new' || destSelForParent.value === 'lastPrimary')){
    const missingFields = getMissingStandardLocationFields('conversionLoc', '');
    if(missingFields.length > 0){
      msg.className = 'msg error';
      msg.textContent = tf('errMissingLocationFields', { fields: missingFields.join(', ') });
      return;
    }
  }
  // 扣庫存之前,先問清楚批量商品要從哪個位置扣(同上,避免庫存分布跟實際庫存對不起來)。
  let sourceLocationChoices;
  try{
    sourceLocationChoices = await resolveLocationChoicesForItems([{ productId: child.id, qty }]);
  } catch(e){ return; } // 使用者在選位置的過程中按了取消,整個切換中止

  const dateVal = todayISO();
  const nowIso = new Date().toISOString();
  const conversionId = genId();
  const txA = {
    id: genId(), productId: child.id, type: 'out', qty, date: dateVal, createdAt: nowIso,
    party: '', note: `切換為主商品「${parent.name}」`, system: true, conversion: true, conversionId
  };
  const txB = {
    id: genId(), productId: parent.id, type: 'in', qty: convertedQty, date: dateVal, createdAt: nowIso,
    party: '', note: `由批量商品「${child.name}」切換而來`, system: true, conversion: true, conversionId
  };
  transactions.push(txA, txB);
  try{ await insertTransactions([txA, txB]); }
  catch(e){
    transactions = transactions.filter(t => t.id !== txA.id && t.id !== txB.id);
    msg.className = 'msg error';
    msg.textContent = '⚠ 切換失敗,請重新整理頁面再試一次。';
    return;
  }
  // 交易確定成功之後才處理位置變動:先扣掉批量商品原本的位置庫存,再幫轉換出來的主商品
  // 指派位置。
  await applyLocationDeductions(sourceLocationChoices);
  await applyConversionLocationAssignment('conversionLoc', parent.id, convertedQty);
  const batchProductId = conversionSourceBatchProductId;
  const verifyProductId = conversionSourceVerifyProductId;
  // 如果這次切換是從「訂單核對」開的(verifyProductId 有值),把這次切換記在這張訂單、這個主商品
  // 品項上——這樣「已完成訂單匯出不顯示」的主商品,匯出時才能改顯示這裡記錄的批量商品/數量,
  // 而不是完全消失看不到到底是怎麼出貨的。訂單如果因為某些原因找不到(理論上不該發生),
  // 就只是沒記到這筆,不影響切換本身已經成功完成。
  if(verifyProductId && verifyPageOrderId){
    const verifyOrder = orders.find(o => o.id === verifyPageOrderId);
    const orderItem = verifyOrder ? verifyOrder.items.find(it => it.productId === parent.id && !it.deleted) : null;
    if(orderItem){
      if(!orderItem.fulfilledViaSwitch) orderItem.fulfilledViaSwitch = [];
      orderItem.fulfilledViaSwitch.push({
        childId: child.id, childSku: child.sku || '', childName: child.name, childUnit: child.unit,
        childQty: qty, convertedQty, at: nowIso
      });
      try{ await upsertOrders([verifyOrder]); }
      catch(e){ console.error('記錄訂單切換資訊失敗', e); }
    }
  }
  closeConversionModal();
  if(batchProductId) txBatchItems = txBatchItems.filter(it => it.productId !== batchProductId);
  if(verifyProductId) verifyPageRightItems = verifyPageRightItems.filter(it => it.productId !== verifyProductId);
  renderAll();
  renderVerifyPageRightItems();
}
