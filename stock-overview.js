// ============================================================
// 庫存總覽(Stock Overview)核心——商品卡片渲染(含批量商品/主商品
// 家族展開收合)、排序、批次操作(改分類、隱藏/顯示、可訂貨/
// 不可訂貨、批次刪除)。
// ============================================================
function renderStockCards(){
  const container = document.getElementById('stockCards');
  if(products.length === 0){
    container.innerHTML = `<div class="empty-note">${t('thNoData')}</div>`;
    return;
  }
  syncCategoryOrder();
  const now = new Date();
  const catFilter = document.getElementById('categoryFilter').value;

  function rowHtml(p, opts){
    opts = opts || {};
    const isSubRow = !!opts.isSubRow;
    const basisParent = opts.basisFor || null; // 這一列如果是代表某個家族的主列,這裡是那個家族真正的主商品
    const trueParent = opts.trueParent || null; // 這一列如果是子列,這裡是那個家族真正的主商品
    const familyParent = basisParent || trueParent; // 不管這一列是代表列還是子列,只要屬於某個商品家族,這裡都會是真正的主商品
    const stock = computeStock(p.id);

    let totalStock = null, totalStockDisplay = '—';
    let gaugeStock = stock, safetyStockRaw = p.safetyStock;

    if(!isSubRow && basisParent){
      // 代表列:「總庫存量」永遠用真正主商品的家族總量計算(在主商品自己的單位下),
      // 如果代表的是某個 multipack 子商品,才把這個數字跟安全庫存一起除以它的加權數換算顯示。
      totalStock = computeTotalStock(basisParent.id);
      safetyStockRaw = basisParent.safetyStock;
      gaugeStock = totalStock; // 燈號/天數估算一律用未換算的原始庫存量判斷,不受顯示換算影響
    }

    // 平均出貨:不管這一列是代表列還是展開後的子列,一律用「真正主商品」的家族合計序列去算
    // (已經把所有 multipack 子商品的加權出貨量併進去了),再用這一列自己的加權數換算回它自己
    // 的單位顯示——這樣不管使用者把哪個成員設成代表、或展開哪個子列,看到的都是「這個商品家族
    // 整體」的消耗速度,只是分別用各自的單位表示,彼此換算後數字會一致,不會有子列只看得到自己
    // 片面資料、數字對不起來的問題。
    const weight = familyParent ? getBasisWeight(p, familyParent) : 1;
    const avgSourceProduct = familyParent || p;
    if(!isSubRow && basisParent){
      totalStockDisplay = weight === 1 ? String(totalStock) : formatMultipackQty(totalStock / weight);
    }

    const effAvg = getEffectiveAvg(avgSourceProduct, now);
    const { avg, source } = effAvg;
    const avgDisplayValue = weight === 1 ? avg : avg / weight;
    // 代表列的 gaugeStock(家族總量)本來就是跟 avg 同一個「真正主商品」的單位基準,兩者直接算
    // 天數沒問題(換算成任何單位結果都一樣,分子分母同除以加權數不影響天數)。子列的 gaugeStock
    // 是這一列自己的庫存(自己的單位),但 avg 現在是家族合計、單位基準是真正主商品的,兩者單位
    // 對不起來——子列要改用已經換算回自己單位的 avgDisplayValue,才能跟自己的庫存量一起算天數。
    const avgForGauge = isSubRow ? avgDisplayValue : avg;
    const remain = daysRemaining(gaugeStock, avgForGauge);
    const gauge = gaugeInfo(remain);

    let avgLabel, avgTitle = '';
    const avgBaseSuffix = t('avgSuffixMonth');
    if(source === 'log'){
      avgLabel = `${avgDisplayValue.toFixed(weight === 1 ? 1 : 2)} ${p.unit}${avgBaseSuffix}`;
    } else if(source === 'blended'){
      avgLabel = `${avgDisplayValue.toFixed(weight === 1 ? 1 : 2)} ${p.unit}${avgBaseSuffix}`;
      avgTitle = tn('avgTitleTransition', effAvg.monthsWithRecords.toFixed(1));
    } else if(source === 'manual'){
      avgLabel = `${avgDisplayValue.toFixed(weight === 1 ? 1 : 2)} ${p.unit}${avgBaseSuffix}`;
      avgTitle = t('avgTitleEstOnly');
    } else {
      avgLabel = '—';
    }

    const belowSafety = (safetyStockRaw !== null && safetyStockRaw !== undefined && !isNaN(safetyStockRaw) && gaugeStock < safetyStockRaw * avgForGauge);
    const safetyStockQty = (safetyStockRaw !== null && safetyStockRaw !== undefined && !isNaN(safetyStockRaw))
      ? safetyStockRaw * avgForGauge
      : null;
    const safetyDisplayValue = (safetyStockQty !== null)
      ? (isSubRow || weight === 1 ? safetyStockQty : safetyStockQty / weight)
      : null;
    const safetyText = safetyDisplayValue !== null
      ? (weight === 1 ? safetyDisplayValue.toFixed(1) : formatMultipackQty(safetyDisplayValue))
      : '—';
    const safetyTitle = (safetyStockRaw !== null && safetyStockRaw !== undefined && !isNaN(safetyStockRaw))
      ? tf('safetyStockMonthsTitle', { months: safetyStockRaw.toFixed(2).replace(/\.?0+$/, '') })
      : '';

    const hasSub = !isSubRow && basisParent && (opts.subCount || 0) > 0;
    const expandArrow = hasSub
      ? `<span class="del-link" onclick="toggleParentExpand('${basisParent.id}')" style="margin-left:6px;cursor:pointer;font-size:15px;font-weight:700;color:var(--ink);">${expandedParentIds.has(basisParent.id) ? '▾' : '▸'}</span>`
      : '';

    // 編輯 / 加入訂貨(🛒)兩個連結移到跟「總庫存量」同一格顯示;「切換」(批量商品⇄主商品數量)
    // 因為只有部分商品才有,獨立放在自己的小連結,不跟編輯/🛒 擠在一起。
    const editCartLinks = hasCapability('cap-edit-overview') ? `
      <span class="del-link" onclick="startEditProduct('${p.id}')">${t('btnEdit')}</span>
      <span class="del-link" onclick="toggleOrderable('${p.id}')" title="${p.orderable ? t('removeFromOrderAction') : t('addToOrderAction')}">${p.orderable ? '🛒−' : '🛒+'}</span>
    ` : '';
    const switchLink = hasCapability('cap-edit-overview')
      ? (p.parentId
          ? `<span class="del-link" onclick="openConversionModal('${p.id}')" title="${t('titleConvertToParent')}">${t('btnSwitchQty')}</span>`
          : (getChildProducts(p.id).length > 0 ? `<span class="del-link" onclick="openParentToChildConversionModal('${p.id}')" title="${t('titleConvertToChild')}">${t('btnSwitchQty')}</span>` : ''))
      : '';

    return `
      <tr id="stockRow_${p.id}" class="stock-row row-${gauge.cls} ${selectedProductIds.has(p.id) ? 'selected-row' : ''} ${p.hidden ? 'hidden-product-row' : ''}">
        <td class="row-check"><input type="checkbox" ${selectedProductIds.has(p.id) ? 'checked' : ''} onchange="toggleSelectProduct('${p.id}', this.checked)" /></td>
        <td class="row-indicator"><span class="dot dot-${gauge.cls}" title="${gauge.label}"></span></td>
        <td class="row-name" style="${isSubRow ? 'padding-left:26px;' : ''}">${p.sku ? `<span class="sku-tooltip-trigger" data-sku="${p.sku.replace(/"/g,'&quot;')}">${p.name}</span>` : p.name}${p.photoUrl ? `<span class="del-link" title="${t('btnViewPhoto')}" onclick="openProductPhotoModal('${p.id}')" style="margin-left:4px;">📷</span>` : ''}${expandArrow}<span class="row-unit">${p.unit}</span>${p.barcode ? `<span title="${tf('barcodeValueTitle', {barcode: p.barcode})}" style="margin-left:4px;">🏷️</span>` : ''}${p.hidden ? `<span class="hidden-badge">${t('hiddenBadge')}</span>` : ''}${p.orderable ? `<span class="orderable-badge">${t('orderableBadge')}</span>` : ''}</td>
        <td class="row-num row-stock-own"><span class="td-mobile-label">${t('colStock')}</span>${stock}</td>
        <td class="row-num row-stock-total"><span class="td-mobile-label">${t('colTotalStock')}</span><span class="row-value-line">${isSubRow ? '—' : totalStockDisplay}<span class="row-edit-cart">${editCartLinks}</span></span></td>
        <td class="row-num row-avg" ${avgTitle ? `title="${avgTitle}"` : ''}><span class="td-mobile-label">${t('colAvgOut')}</span>${avgLabel}</td>
        <td class="row-num row-safety ${belowSafety ? 'row-below-safety' : ''}" ${safetyTitle ? `title="${safetyTitle}"` : ''}><span class="td-mobile-label">${t('colSafety')}</span><span class="row-value-line">${safetyText}${belowSafety ? ' ⚠' : ''}<span class="row-remain-inline ${!isSubRow ? `row-${gauge.cls}` : ''}">${isSubRow ? '' : gauge.label}</span></span></td>
        <td class="row-remain ${!isSubRow ? `row-${gauge.cls}` : ''}"><span class="td-mobile-label">${t('colRemain')}</span>${isSubRow ? '—' : gauge.label}</td>
        <td class="row-action ${switchLink ? '' : 'row-action-switch-empty'}">
          ${hasCapability('cap-edit-overview') ? `
            <div class="row-action-inner">
              ${switchLink}
              <span class="action-editcart-dup">${editCartLinks}</span>
            </div>
          ` : '—'}
        </td>
      </tr>
    `;
  }

  const categoriesToShow = catFilter ? [catFilter] : categoryOrder;
  const statusFilter = document.getElementById('statusFilter').value;
  const showHidden = document.getElementById('showHiddenProducts') && document.getElementById('showHiddenProducts').checked;
  let bodyHtml = '';
  let anyItems = false;
  const visibleProductIds = new Set();
  categoriesToShow.forEach(cat => {
    // 只列出「主商品」(沒有 parentId 的商品),批量商品會依展開狀態顯示在主商品下面
    let items = products.filter(p => (p.category || '未分類') === cat && !p.parentId);
    if(!showHidden) items = items.filter(p => !p.hidden);
    if(statusFilter){
      items = items.filter(p => {
        const gaugeStock = computeTotalStock(p.id);
        const { avg } = getEffectiveAvg(p, now);
        const remain = daysRemaining(gaugeStock, avg);
        return gaugeInfo(remain).cls === statusFilter;
      });
    }
    if(items.length === 0) return;
    anyItems = true;
    items = sortStockItems(items, now);
    bodyHtml += `<tr class="cat-row"><td colspan="9">${catLabel(cat)}<span class="cat-count">${items.length}</span></td></tr>`;
    items.forEach(p => {
      // 這個家族(主商品 + 底下所有 multipack 子商品)在畫面上「代表列」要顯示成哪一個商品的身份:
      // 預設是主商品自己;如果有勾選過「顯示於總庫存量」,就是那一個(可能是主商品,也可能是某個
      // multipack 子商品)。沒被選中代表的其他成員(包含主商品自己,如果它不是代表的話)都會變成
      // 展開之後才看得到的子列。
      const basis = getTotalStockBasisProduct(p);
      const subMembers = [];
      if(basis.id !== p.id) subMembers.push(p);
      getChildProducts(p.id).forEach(c => { if(c.id !== basis.id) subMembers.push(c); });

      visibleProductIds.add(basis.id);
      bodyHtml += rowHtml(basis, { basisFor: p, subCount: subMembers.length });

      if(subMembers.length > 0){
        // 「全選」在語意上是「選取符合目前篩選條件的全部商品」,不是「選取畫面上目前看得到的
        // 那些列」——所以子商品(multipack 成員)不管這個主商品的下拉列目前有沒有展開,只要
        // 不是隱藏商品(或有勾選「顯示隱藏商品」),都要能被全選選到。真正的列渲染(bodyHtml)
        // 還是只有展開的時候才畫出來,只有「可不可以被選取」這件事不受展開狀態影響。
        let visibleSub = showHidden ? subMembers : subMembers.filter(c => !c.hidden);
        visibleSub.forEach(c => visibleProductIds.add(c.id));
        if(expandedParentIds.has(p.id)){
          visibleSub.slice().sort(compareProductsBySortMode).forEach(c => {
            bodyHtml += rowHtml(c, { isSubRow: true, trueParent: p });
          });
        }
      }
    });
  });

  if(!anyItems){
    container.innerHTML = `<div class="empty-note">${statusFilter ? '沒有符合這個燈號篩選條件的商品。' : '這個分類目前沒有商品。'}</div>`;
    return;
  }

  // keep only selections that are still visible under the current category filter
  selectedProductIds = new Set([...selectedProductIds].filter(id => visibleProductIds.has(id)));
  const allSelected = visibleProductIds.size > 0 && [...visibleProductIds].every(id => selectedProductIds.has(id));

  container.innerHTML = `
    ${selectedProductIds.size > 0 ? `
      <div class="selection-bar">
        <span>${tn('selectedProducts', selectedProductIds.size)}</span>
        <select id="bulkCategorySelect">${categoryOrder.map(c => `<option value="${c}">${catLabel(c)}</option>`).join('')}</select>
        <button class="btn ghost" onclick="bulkChangeCategory()">${t('btnApplyCatToSelected')}</button>
        <button class="btn ghost" onclick="bulkSetHidden(true)">${t('btnHideSelected')}</button>
        <button class="btn ghost" onclick="bulkSetHidden(false)">${t('btnUnhideSelected')}</button>
        <button class="btn ghost" onclick="bulkSetOrderable(true)">${t('btnAddToOrderSelected')}</button>
        <button class="btn ghost" onclick="bulkSetOrderable(false)">${t('btnRemoveFromOrderSelected')}</button>
        <button class="btn ghost" onclick="bulkDeleteProducts()">${t('btnDeleteSelectedProducts')}</button>
        <button class="btn ghost" onclick="clearProductSelection()">${t('btnClearSelection')}</button>
      </div>
    ` : ''}
    <div class="mobile-select-all-bar">
      <input type="checkbox" id="mobileSelectAllCheckbox" ${allSelected ? 'checked' : ''} onchange="toggleSelectAllProducts(this.checked)" />
      <label for="mobileSelectAllCheckbox">${t('selectAllLabel')}</label>
    </div>
    <table class="stock-table stock-overview-table">
      <colgroup>
        <col style="width:3%">
        <col style="width:3%">
        <col style="width:32%">
        <col style="width:7%">
        <col style="width:8%">
        <col style="width:14%">
        <col style="width:11%">
        <col style="width:10%">
        <col style="width:12%">
      </colgroup>
      <thead>
        <tr>
          <th><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="toggleSelectAllProducts(this.checked)" /></th>
          <th></th>
          <th class="sortable-th">
            <span onclick="event.stopPropagation();setStockSort('sku')" style="cursor:pointer;" title="${t('sortCycleHint')}">SKU${sortArrow('sku')}</span>
            <span style="color:var(--line);margin:0 3px;">/</span>
            <span onclick="event.stopPropagation();setStockSort('name')" style="cursor:pointer;" title="${t('sortCycleHint')}">${t('colProduct')}${sortArrow('name')}</span>
          </th>
          <th class="sortable-th num" onclick="setStockSort('stock')" title="${t('sortCycleHint')}">${t('colStock')}${sortArrow('stock')}</th>
          <th class="sortable-th num" onclick="setStockSort('totalStock')" title="主商品自己的庫存量 + Σ(批量商品庫存量 × 加權數)。${t('sortCycleHint')}">${t('colTotalStock')}${sortArrow('totalStock')}</th>
          <th class="sortable-th num" onclick="setStockSort('avg')" title="${t('sortCycleHint')}">${t('colAvgOut')}${sortArrow('avg')}</th>
          <th class="sortable-th num" onclick="setStockSort('safety')" title="${t('sortCycleHint')}">${t('colSafety')}${sortArrow('safety')}</th>
          <th class="sortable-th num" onclick="setStockSort('remain')" title="${t('sortCycleHint')}">${t('colRemain')}${sortArrow('remain')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  `;
}

function toggleParentExpand(parentId){
  if(expandedParentIds.has(parentId)) expandedParentIds.delete(parentId);
  else expandedParentIds.add(parentId);
  renderStockCards();
}

// 手機版進出貨紀錄裡的「備註」預設是單行省略號截斷(在 CSS 裡處理),點一下直接展開成完整多行
// 文字(把卡片往下撐開,不是浮出一個小視窗蓋住其他東西)。桌面版這個 class 完全不影響顯示,
// 備註文字本來就是一律直接顯示完整內容。
function toggleTxNoteDisplay(el){
  el.classList.toggle('tx-note-expanded');
}

function sortStockItems(items, now){
  if(!stockSortField){
    // 沒有手動點欄位排序時,依照系統設置的「商品排序」決定順序,跟訂貨頁面用同一套邏輯,
    // 確保兩邊預設順序一致。
    return items.slice().sort(compareProductsBySortMode);
  }
  const dir = stockSortDir === 'desc' ? -1 : 1;
  const valueFor = (p) => {
    if(stockSortField === 'name') return p.name || '';
    if(stockSortField === 'sku') return p.sku || '';
    const stock = computeStock(p.id);
    if(stockSortField === 'stock') return stock;
    if(stockSortField === 'totalStock') return computeTotalStock(p.id);
    const { avg } = getEffectiveAvg(p, now);
    if(stockSortField === 'avg') return avg === null || avg === undefined ? -Infinity : avg;
    if(stockSortField === 'safety'){
      if(p.safetyStock === null || p.safetyStock === undefined || isNaN(p.safetyStock)) return -Infinity;
      return p.safetyStock * (avg || 0);
    }
    if(stockSortField === 'remain'){
      const remain = daysRemaining(stock, avg);
      return remain === null || remain === undefined ? -Infinity : remain;
    }
    return 0;
  };
  return items.slice().sort((a, b) => {
    const va = valueFor(a), vb = valueFor(b);
    if(typeof va === 'string' || typeof vb === 'string'){
      return String(va).localeCompare(String(vb)) * dir;
    }
    return (va - vb) * dir;
  });
}

function sortArrow(field){
  if(stockSortField !== field) return '';
  return stockSortDir === 'asc' ? ' ▲' : ' ▼';
}

function setStockSort(field){
  if(stockSortField === field){
    if(stockSortDir === 'asc'){
      stockSortDir = 'desc';
    } else {
      // 已經是遞減了,再點一次不是繼續切換,而是還原成預設排序(分類順序 + 商品排序設置那個
      // 原始順序)——不然點過遞增/遞減之後,沒有辦法回到原本的排序,只能在這兩個之間切換。
      stockSortField = null;
      stockSortDir = 'asc';
    }
  } else {
    stockSortField = field;
    stockSortDir = 'asc';
  }
  renderStockCards();
}

function toggleSelectProduct(id, checked){
  if(checked) selectedProductIds.add(id);
  else selectedProductIds.delete(id);
  renderStockCards();
}

function toggleSelectAllProducts(checked){
  const catFilter = document.getElementById('categoryFilter').value;
  const statusFilter = document.getElementById('statusFilter').value;
  const categoriesToShow = catFilter ? [catFilter] : categoryOrder;
  const now = new Date();
  const showHidden = document.getElementById('showHiddenProducts') && document.getElementById('showHiddenProducts').checked;
  let visible = products.filter(p => categoriesToShow.includes(p.category || '未分類'));
  if(!showHidden) visible = visible.filter(p => !p.hidden);
  if(statusFilter){
    visible = visible.filter(p => {
      const stock = computeStock(p.id);
      const { avg } = getEffectiveAvg(p, now);
      const remain = daysRemaining(stock, avg);
      return gaugeInfo(remain).cls === statusFilter;
    });
  }
  if(checked) visible.forEach(p => selectedProductIds.add(p.id));
  else visible.forEach(p => selectedProductIds.delete(p.id));
  renderStockCards();
}

function clearProductSelection(){
  selectedProductIds.clear();
  renderStockCards();
}

async function bulkChangeCategory(){
  const newCat = document.getElementById('bulkCategorySelect').value;
  if(selectedProductIds.size === 0) return;
  products.forEach(p => {
    if(selectedProductIds.has(p.id)) p.category = newCat;
  });
  await saveProducts();
  renderAll();
}

async function bulkSetHidden(hidden){
  if(selectedProductIds.size === 0) return;
  products.forEach(p => {
    if(selectedProductIds.has(p.id)) p.hidden = hidden;
  });
  await saveProducts();
  renderAll();
}

async function bulkSetOrderable(orderable){
  if(selectedProductIds.size === 0) return;
  products.forEach(p => {
    if(selectedProductIds.has(p.id)) p.orderable = orderable;
  });
  await saveProducts();
  renderAll();
}

function bulkDeleteProducts(){
  const count = selectedProductIds.size;
  if(count === 0) return;
  // 連同被選中主商品底下的批量商品一起刪除,避免留下沒有主商品的孤兒批量商品。
  const idsToDelete = new Set(selectedProductIds);
  products.forEach(p => { if(p.parentId && idsToDelete.has(p.parentId)) idsToDelete.add(p.id); });
  const anyHasTx = products.some(p => idsToDelete.has(p.id) && transactions.some(t => t.productId === p.id));
  const warnText = anyHasTx
    ? tn('confirmDeleteProductsWithTx', count)
    : tn('confirmDeleteProducts', count);
  showConfirmModal(warnText, async () => {
    const removed = transactions.filter(t => idsToDelete.has(t.productId));
    transactions = transactions.filter(t => !idsToDelete.has(t.productId));
    products = products.filter(p => !idsToDelete.has(p.id));
    selectedProductIds.clear();
    await saveProducts();
    await deleteTransactions(removed);
    idsToDelete.forEach(pid => { delete productStockMap[pid]; });
    renderAll();
  });
}
