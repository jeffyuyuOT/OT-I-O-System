// ============================================================
// 訂貨/訂單管理——這是目前拆出來最大的一塊,涵蓋:
// 平均訂貨量計算、購物車(加入/移除/確認送出)、待處理訂單、
// 已完成訂單列表/歷史/修改記錄、品項數量/備註編輯、訂單核對
// (Verify Page)、Picking Slip 列印、Excel 匯出。
// 「出貨方(供應商)管理」、「切換紀錄」是相鄰但不同的功能,
// 故意沒有一起搬,留在主程式。
// ============================================================

// 這個出貨方在「訂貨」分頁能看到的商品:全域標記可訂貨、沒有被全域隱藏、
// 也沒有被這個出貨方個別隱藏(在「管理出貨方」設定)。
function getOrderableProductsForParty(partyObj){
  const hiddenForParty = partyObj && Array.isArray(partyObj.hiddenProductIds) ? partyObj.hiddenProductIds : [];
  return products.filter(p => p.orderable && !p.hidden && !hiddenForParty.includes(p.id));
}

// 以「這個出貨方」最近 13 週(約三個月)的出貨紀錄,算「每次訂貨平均用量」:
// 1. 抓最近 13 週(91 天,固定的滑動區間)這個商品、這個出貨方的出貨紀錄。
// 2. 週平均 = 這段期間的出貨總量 ÷ 週數。週數預設是 13,但如果這個商品+這個出貨方最早的
//    出貨紀錄是在這 13 週「之內」才開始的(表示這個組合的歷史比 13 週短),改用「從那筆最早
//    紀錄到今天」實際經過的週數當分母——不然明明只有 5 週的資料,却硬要除以 13,平均會被
//    嚴重低估。「開始用」是指這個商品+這個出貨方各自最早的出貨紀錄日期,不是看整個系統/
//    資料庫最早的紀錄(不同商品、不同出貨方各自獨立計算)。
// 3. 出貨頻率(shippingParty.orderFrequency,預設 'weekly')決定最後怎麼從週平均換算成
//    「每次訂貨」該抓多少量:weekly 就是週平均本身;fortnight(兩週訂一次)是週平均 x2;
//    monthly(一個月訂一次)是週平均 x4。
// 出貨紀錄本身排除「切換」(子商品⇄主商品互轉,buildWeightedOutSeries 內建一定會排除)、還有
// 「Excel 匯入商品主檔」時自動產生的庫存調整紀錄(excludeMasterImportAdjustment)——這種調整紀錄
// 算庫存校正,不是一筆一筆出貨給客人,不該拿來算「每次訂貨平均用量」。訂單(不管是客人在「訂貨」
// 下的,還是 Excel 匯入出貨單併成待處理訂單、核對送出的)一經確認扣庫存,一律算數,不排除。
// 沒選出貨方,或該出貨方在這段期間沒有這項商品的紀錄時,退回用整體出貨紀錄計算,供參考
// (退回時一律當作 weekly 頻率,因為這時候已經不是針對特定出貨方的計算了)。
const RECENT_AVG_WINDOW_DAYS = 91; // 13 週 x 7 天
const RECENT_AVG_WINDOW_WEEKS = 13;
const ORDER_FREQUENCY_MULTIPLIER = { weekly: 1, fortnight: 2, monthly: 4 };

function weeklyAvgFromSeries(windowTx, allTx, now, windowStart){
  if(windowTx.length === 0) return 0;
  const totalQty = windowTx.reduce((s,t) => s + t.qty, 0);
  // 「這個組合開始使用的時間」要看全部歷史紀錄裡最早的一筆(allTx),不能只看 91 天窗口內
  // (windowTx)最早的一筆——不然窗口內剛好第一週沒出貨,會被誤判成「這個組合只有 12 週歷史」,
  // 即使它實際上已經出貨超過 13 週,只是那一週剛好沒訂單而已。真的是最近才開始出貨(allTx
  // 最早那筆也落在窗口內)的組合,才會用比較短的實際週數當分母。
  const earliestOverallTime = allTx.reduce((min, t) => Math.min(min, new Date(t.date).getTime()), now.getTime());
  const effectiveStartTime = Math.max(earliestOverallTime, windowStart.getTime());
  const weeksElapsed = Math.max(1, (now.getTime() - effectiveStartTime) / (7*24*60*60*1000));
  const weeks = Math.min(RECENT_AVG_WINDOW_WEEKS, weeksElapsed);
  // 退貨(restock)扣抵之後,極端情況下這段期間淨出貨量可能是負的(退的比出的還多)——
  // 平均用量不該顯示負數,顯示 0 比較不會誤導看的人。
  return Math.max(0, totalQty / weeks);
}

function computePerOrderAvgForParty(productId, partyObj, now){
  const windowStart = new Date(now.getTime() - RECENT_AVG_WINDOW_DAYS*24*60*60*1000);
  const partyName = partyObj ? partyObj.name : '';

  // 主商品的話,這份序列已經把批量商品的加權出貨量合併進來了(切換紀錄不算),
  // 同一天主商品+批量商品都有出貨會合併成一筆。
  if(partyName){
    const allTx = buildWeightedOutSeries(productId, { onlyParty: partyName, excludeMasterImportAdjustment: true });
    const tx = allTx.filter(t => new Date(t.date) >= windowStart && new Date(t.date) <= now);
    if(tx.length >= 1){
      const weeklyAvg = weeklyAvgFromSeries(tx, allTx, now, windowStart);
      const multiplier = ORDER_FREQUENCY_MULTIPLIER[partyObj.orderFrequency] || 1;
      return { avg: weeklyAvg * multiplier, isPartySpecific: true, hasData: true };
    }
    // 這個出貨方最近三個月完全沒訂過這項商品:不再退回顯示「整體平均」當參考值——那樣會讓沒訂過
    // 的店看起來跟唯一有在訂的店數字一模一樣,容易誤導。改成直接標示「沒有資料」,畫面上顯示「-」。
    return { avg: 0, isPartySpecific: true, hasData: false };
  }
  const allTx2 = buildWeightedOutSeries(productId, { excludeMasterImportAdjustment: true });
  const tx2 = allTx2.filter(t => new Date(t.date) >= windowStart && new Date(t.date) <= now);
  if(tx2.length === 0) return { avg: 0, isPartySpecific: false, hasData: false };
  return { avg: weeklyAvgFromSeries(tx2, allTx2, now, windowStart), isPartySpecific: false, hasData: true };
}


function toggleOrderParentExpand(parentId){
  if(orderExpandedParentIds.has(parentId)) orderExpandedParentIds.delete(parentId);
  else orderExpandedParentIds.add(parentId);
  renderOrderItemsTable();
}

// 訂貨頁面商品清單最下面的「To the top」:滑到清單最下面選分類或按購物車,不用整頁往上滑,
// 直接捲回篩選分類/購物車按鈕那一列。用平滑捲動,體感比直接跳過去好一點。
function scrollToOrderToolbar(){
  const el = document.getElementById('orderToolbarRow');
  if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderOrderItemsTable(){
  const container = document.getElementById('orderItemsTable');
  if(!container) return;
  const partySel = document.getElementById('orderParty');
  const partyId = partySel ? partySel.value : '';
  const partyObj = shippingParties.find(sp => sp.id === partyId);
  let orderable = getOrderableProductsForParty(partyObj);

  // 分類篩選下拉選單:只列出目前這批可訂購商品實際用到的分類
  const catSel = document.getElementById('orderCategoryFilter');
  if(catSel){
    const usedCats = categoryOrder.filter(c => orderable.some(p => (p.category || '未分類') === c));
    const prevCat = catSel.value;
    catSel.innerHTML = `<option value="">${t('catFilterAll')}</option>` +
      usedCats.map(c => `<option value="${c.replace(/"/g,'&quot;')}">${catLabel(c)}</option>`).join('');
    if(usedCats.includes(prevCat)) catSel.value = prevCat;
    if(catSel.value) orderable = orderable.filter(p => (p.category || '未分類') === catSel.value);
  }

  if(orderable.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noFilteredOrderableProducts')}</div>`;
    return;
  }
  const now = new Date();
  const orderableIds = new Set(orderable.map(p => p.id));

  // 商品排序:依照系統設置的「商品排序」決定,跟庫存總覽用同一套邏輯,確保兩邊順序一致。

  // 只有「主商品的批量商品也在這份可訂購清單裡」時,才需要下拉展開;
  // 批量商品被隱藏或沒被加入訂貨的話,主商品就是一般列,不需要下拉。
  function rowHtml(p, opts){
    opts = opts || {};
    const isNested = !!opts.isNested; // 巢狀顯示在展開的主商品底下(要縮排);主商品不在清單裡、
    // 退回當一般列顯示的批量商品則不算巢狀,跟其他商品一樣對齊、不縮排。
    const isChildProduct = !!p.parentId; // 這個商品本身是不是 multipack 商品(不管有沒有縮排都要標 ⧉)
    const stock = Math.max(0, computeAvailableForOrder(p.id));
    const outOfStock = stock <= 0;
    const w = computePerOrderAvgForParty(p.id, partyObj, now);
    const avgTitle = partyObj
      ? (w.isPartySpecific ? tf('avgTitlePartySpecific', {name: partyObj.name}) : tf('avgTitlePartyFallback', {name: partyObj.name}))
      : t('avgTitleNoParty');
    const children = (!isChildProduct ? orderable.filter(c => c.parentId === p.id) : []).sort(compareProductsBySortMode);
    const hasChildren = children.length > 0;
    // 下拉箭頭放在名字後面(不是前面),這樣不管這一列有沒有箭頭,SKU/⧉/商品名稱都從同樣的位置
    // 開始,不會因為有沒有下拉箭頭而讓商品名稱對不齊。
    const expandArrow = hasChildren
      ? `<span class="del-link" onclick="toggleOrderParentExpand('${p.id}')" style="margin-left:6px;cursor:pointer;font-size:15px;font-weight:700;color:var(--ink);">${orderExpandedParentIds.has(p.id) ? '▾' : '▸'}</span>`
      : '';
    const row = `
      <tr class="${outOfStock ? 'oos-row' : ''}">
        <td class="row-name" style="${isNested ? 'padding-left:26px;' : ''}">${(isChildProduct && !hideMultipackIconOnOrderPage) ? '⧉ ' : ''}${p.sku ? `<span class="sku-tooltip-trigger" data-sku="${p.sku.replace(/"/g,'&quot;')}">${p.name}</span>` : p.name}${p.photoUrl ? `<span class="del-link" title="${t('btnViewPhoto')}" onclick="openProductPhotoModal('${p.id}')" style="margin-left:4px;">📷</span>` : ''}${p.orderPageRemark ? `<span style="font-style:italic;font-size:11.5px;color:var(--ink-soft);"> ${p.orderPageRemark.replace(/</g,'&lt;')}</span>` : ''}${expandArrow}${outOfStock ? `<span class="oos-badge">${t('oosLabel')}</span>` : ''}</td>
        <td class="row-note-cell">
          ${orderItemNoteDraft[p.id]
            ? `<span class="del-link" style="font-style:italic;" onclick="openOrderItemNoteModal('${p.id}')">${t('noteLabelPrefix')}${orderItemNoteDraft[p.id].replace(/</g,'&lt;')}</span>`
            : `<span class="del-link" onclick="openOrderItemNoteModal('${p.id}')">${t('btnAddItemNote')}</span>`}
          <span class="show-mobile-only avg-usage-mobile" title="${avgTitle}">${t('avgUsageMobileLabel')}${isChildProduct ? ' —' : (w.hasData ? ` ${w.avg.toFixed(1)} ${p.unit}` : ' —')}</span>
        </td>
        <td class="row-num hide-mobile" ${isChildProduct ? '' : `title="${avgTitle}"`}>${isChildProduct ? '—' : (w.hasData ? `${w.avg.toFixed(1)} ${p.unit}` : '—')}</td>
        <td class="row-num row-qty qty-col-data">
          <span class="td-mobile-label">${t('colOrderQty')}</span>
          <div class="qty-cell-inner">
            <input type="number" class="order-qty-input" id="orderQty_${p.id}" min="0" step="1"
              max="${stock}" placeholder="0" value="${orderQtyDraft[p.id] != null ? orderQtyDraft[p.id] : ''}" ${outOfStock ? 'disabled' : ''}
              oninput="validateOrderQtyInput('${p.id}')" /><span class="qty-unit-label">${p.unit}</span>
          </div>
        </td>
      </tr>
    `;
    const childRows = (hasChildren && orderExpandedParentIds.has(p.id))
      ? children.map(c => rowHtml(c, { isNested: true })).join('')
      : '';
    return row + childRows;
  }

  // 頂層列:沒有 parentId 的商品,或是批量商品的主商品本身不在這份可訂購清單裡(退回當一般列
  // 顯示,依自己的 SKU 跟其他商品排序、對齊,不縮排、不特別排到後面)。一律照 SKU 排序,
  // 有主商品在清單裡的批量商品會巢狀跟在主商品底下(展開才看得到),不會出現在這份頂層清單裡。
  const topLevel = orderable.filter(p => !p.parentId || !orderableIds.has(p.parentId)).sort(compareProductsBySortMode);

  // 分類篩選選「全部分類」時,商品清單依照庫存總覽同一套分類順序分組顯示(每個分類一個標題列),
  // 不是所有商品混在一起單純照 SKU 排;選了特定分類的話,反正只剩那一個分類的商品,維持原本
  // 單純一份清單就好,不需要再多一層分類標題。
  let rows;
  if(!catSel || !catSel.value){
    const byCat = {};
    topLevel.forEach(p => {
      const cat = p.category || '未分類';
      (byCat[cat] = byCat[cat] || []).push(p);
    });
    const orderedCats = categoryOrder.filter(c => byCat[c]);
    rows = orderedCats.map(cat => {
      const items = byCat[cat];
      const header = `<tr class="cat-row"><td colspan="4">${catLabel(cat)}<span class="cat-count">${items.length}</span></td></tr>`;
      return header + items.map(p => rowHtml(p, {})).join('');
    }).join('');
  } else {
    rows = topLevel.map(p => rowHtml(p, {})).join('');
  }
  container.innerHTML = `
    <table class="stock-table order-items-table">
      <thead>
        <tr><th>${t('colProduct')}</th><th>${t('colItemNote')}</th><th class="num hide-mobile">${t('colWeeklyAvg')}</th><th class="qty-col-header">${t('colOrderQty')}</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function validateOrderQtyInput(productId){
  const input = document.getElementById(`orderQty_${productId}`);
  if(!input) return;
  orderQtyDraft[productId] = input.value;
  const max = parseFloat(input.getAttribute('max')) || 0;
  const val = parseFloat(input.value);
  if(!isNaN(val) && val > max){ input.classList.add('qty-invalid'); }
  else { input.classList.remove('qty-invalid'); }
}

// 用草稿物件讀取數量(不是只看目前畫面上顯示的列),這樣切換分類篩選不會弄丟已經填的數量。
// 共用給「開啟購物車」(不扣庫存,只是預覽)跟「送出訂貨」(實際扣庫存)。
function collectOrderItems(){
  const dateVal = document.getElementById('orderDate').value;
  const noteVal = document.getElementById('orderNote').value.trim();
  const partyId = document.getElementById('orderParty').value;
  const partyObj = shippingParties.find(sp => sp.id === partyId);
  const partyName = partyObj ? partyObj.name : '';

  if(!dateVal){
    return { dateVal, noteVal, partyId, partyObj, partyName, items: [], errors: [t('errSelectOrderDate')] };
  }
  if(currentUser && Array.isArray(currentUser.assignedPartyIds) && currentUser.assignedPartyIds.length > 0 && !currentUser.assignedPartyIds.includes(partyId)){
    return { dateVal, noteVal, partyId, partyObj, partyName, items: [], errors: [t('errAccountRestrictedToParty')] };
  }

  const orderable = getOrderableProductsForParty(partyObj);
  const items = [];
  const errors = [];

  orderable.forEach(p => {
    const qty = parseFloat(orderQtyDraft[p.id]);
    if(!qty || qty <= 0) return;

    const stock = Math.max(0, computeAvailableForOrder(p.id));
    if(stock <= 0){
      errors.push(tf('errProductOutOfStockOrder', { name: p.name }));
      return;
    }
    if(qty > stock){
      errors.push(tf('errQtyExceedsAvailableOrder', { name: p.name, qty, stock }));
      return;
    }

    const itemNote = (orderItemNoteDraft[p.id] || '').trim();

    // 訂貨數量達到 multipack 加權數自動轉換(如果開關有開,而且這個商品有可以用的基準 multipack 商品):
    // 例如加權數是 20,訂了 45 瓶,就轉換成 2 箱(multipack)+ 5 瓶(還是主商品),
    // 轉換出來的 multipack 數量還要另外檢查那個 multipack 商品自己的庫存夠不夠,
    // 不夠的話能轉多少算多少,剩下的還是留在主商品這邊下單。備註是使用者對這個商品行下的
    // 說明,不管有沒有被拆成兩筆,兩邊都要帶著同一份備註。
    if(autoConvertMultipackEnabled && !p.parentId){
      const basisChild = getBasisMultipackChild(p);
      if(basisChild){
        const desiredMultipackQty = Math.floor(qty / basisChild.childWeight);
        if(desiredMultipackQty > 0){
          const childAvailable = Math.max(0, computeAvailableForOrder(basisChild.id));
          const actualMultipackQty = Math.min(desiredMultipackQty, Math.floor(childAvailable));
          if(actualMultipackQty > 0){
            const consumedAsParent = actualMultipackQty * basisChild.childWeight;
            const remainder = qty - consumedAsParent;
            items.push({ productId: basisChild.id, sku: basisChild.sku || '', name: basisChild.name, unit: basisChild.unit, qty: actualMultipackQty, note: itemNote });
            if(remainder > 0){
              items.push({ productId: p.id, sku: p.sku || '', name: p.name, unit: p.unit, qty: remainder, note: itemNote });
            }
            return;
          }
        }
      }
    }

    items.push({ productId: p.id, sku: p.sku || '', name: p.name, unit: p.unit, qty, note: itemNote });
  });

  if(items.length === 0 && errors.length === 0){
    errors.push(t('errNoItemsSelectedOrder'));
  }

  return { dateVal, noteVal, partyId, partyObj, partyName, items, errors };
}

// 按「購物車」:只檢查/預覽數量,不扣庫存、不寫入任何紀錄,只是把訂貨頁面切到購物車畫面。
function openCart(){
  const msg = document.getElementById('orderMsg');
  const { items, errors } = collectOrderItems();

  if(errors.length > 0){
    showInfoModal(`⚠ ${errors.join('; ')}`);
    return;
  }

  msg.className = 'msg';
  msg.textContent = '';
  renderCartTable(items);
  document.getElementById('orderFormSection').style.display = 'none';
  document.getElementById('orderCartSection').style.display = '';
  document.getElementById('cartMsg').textContent = '';
  // 主表單那個備註欄位這時候被藏起來了(orderFormSection 隱藏),購物車裡另外放一個備註欄位,
  // 開啟購物車的時候先把目前的值帶過去,兩邊維持同步(見輸入框上的 oninput,反向同步回主表單)。
  document.getElementById('cartOrderNote').value = document.getElementById('orderNote').value;
}

// 按購物車裡的「Order more / 繼續訂貨」:回到訂貨頁面繼續調整數量,草稿(orderQtyDraft)保留不變。
function closeCart(){
  document.getElementById('orderCartSection').style.display = 'none';
  document.getElementById('orderFormSection').style.display = '';
  renderOrderItemsTable();
}

function renderCartTable(items){
  const container = document.getElementById('cartItemsTable');
  if(!container) return;
  if(items.length === 0){
    container.innerHTML = `<div class="empty-note">${t('cartEmptyNote')}</div>`;
    return;
  }
  const rows = items.map(it => {
    const stock = computeStock(it.productId);
    const product = products.find(p => p.id === it.productId);
    const isMultipack = !!(product && product.parentId);
    return `
    <tr>
      <td class="row-name">${(isMultipack && !hideMultipackIconOnOrderPage) ? '⧉ ' : ''}${it.sku ? `<span class="sku-tooltip-trigger" data-sku="${it.sku.replace(/"/g,'&quot;')}">${it.name}</span>` : it.name}${it.note ? `<div style="font-size:11px;color:var(--ink-soft);font-style:italic;font-weight:400;">${t('noteLabelPrefix')}${it.note.replace(/</g,'&lt;')}</div>` : ''}</td>
      <td class="row-num row-qty">
        <span class="td-mobile-label">${t('colOrderQty')}</span>
        <input type="number" class="order-qty-input" id="cartQty_${it.productId}" min="0" step="1"
          max="${stock}" value="${it.qty}"
          oninput="validateCartQtyInput('${it.productId}')" onchange="updateCartQty('${it.productId}')" /><span class="row-unit">${it.unit}</span>
      </td>
      <td class="row-action"><button onclick="removeCartItem('${it.productId}')" title="${t('deleteProductTitle')}">✕</button></td>
    </tr>
  `;
  }).join('');
  container.innerHTML = `
    <table class="stock-table cart-items-table">
      <thead>
        <tr><th>${t('colProduct')}</th><th class="num">${t('colOrderQty')}</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// 購物車裡編輯數量:oninput 只即時標記是否超過庫存(不重繪,避免打斷輸入),
// onchange(失去焦點或按 Enter)才真正把草稿寫回 orderQtyDraft 並重繪(順便清掉數量變 0 的列)。
function validateCartQtyInput(productId){
  const input = document.getElementById(`cartQty_${productId}`);
  if(!input) return;
  const max = parseFloat(input.getAttribute('max')) || 0;
  const val = parseFloat(input.value);
  if(!isNaN(val) && val > max){ input.classList.add('qty-invalid'); }
  else { input.classList.remove('qty-invalid'); }
}

function updateCartQty(productId){
  const input = document.getElementById(`cartQty_${productId}`);
  if(input) orderQtyDraft[productId] = input.value;
  const { items } = collectOrderItems();
  renderCartTable(items);
  const msg = document.getElementById('cartMsg');
  if(msg){ msg.className = 'msg'; msg.textContent = ''; }
}

// 購物車裡刪除商品:直接清空草稿數量,重新計算購物車內容(該商品因數量為 0 會自動從清單消失)。
function removeCartItem(productId){
  orderQtyDraft[productId] = '';
  const { items } = collectOrderItems();
  renderCartTable(items);
  const msg = document.getElementById('cartMsg');
  if(msg){ msg.className = 'msg'; msg.textContent = ''; }
}

// 購物車裡按「Confirm the order / 送出訂貨」:現在不會馬上扣庫存了 —— 送出後訂單先進
// 「訂貨後台管理 → 待處理訂單」(status='pending'),不寫入任何進出貨紀錄、不動實際庫存,
// 只是先佔用「可訂數量」的額度(見 computeAvailableForOrder),避免下一個訂貨的人也訂到同一批貨。
// 真正扣庫存是等員工在「待處理訂單」按下「核對」的時候才發生(見 verifyOrder,走 verify_order RPC,
// 一樣是 atomic 檢查+扣除)。訂單編號還是跟其他來源(登記進出貨併入已完成訂單…等)共用同一個
// 資料庫序列(next_order_no RPC),不會撞號。
// 解析 verify_order / adjust_order_item_qty 這類 RPC 拋出的 'insufficient_stock:[...]' 錯誤訊息,
// 回傳 [{productId, requested, available}, ...],解析不出來就回傳 null(表示不是庫存不足的錯誤)。
function parseInsufficientStockError(error){
  const m = /^insufficient_stock:(.*)$/s.exec((error && error.message) || '');
  if(!m) return null;
  try{ return JSON.parse(m[1]); } catch(e){ return null; }
}

async function confirmOrderFromCart(){
  const msg = document.getElementById('cartMsg');

  // 送出前一定要先強制重新抓一次最新的訂單/交易/庫存資料,不能只看記憶體裡現有的——背景自動
  // 同步平常每 10 秒跑一次,但只要使用者正在任何輸入框打字(填訂貨數量整個過程幾乎都是這個
  // 狀態),就會被跳過(見 isUserActivelyEditing),導致這裡看到的 orders 可能是好幾分鐘前的
  // 舊資料。如果不在這裡強制刷新,即使 computeAvailableForOrder/computePendingReserved 本身
  // 邏輯正確,也會因為拿到的是舊資料而算出錯的可用庫存,造成不同人可以訂到同一批貨——這正是
  // 之前庫存超賣問題的根本原因。
  msg.className = 'msg';
  msg.textContent = t('checkingLatestStockMsg');
  try{
    await Promise.all([loadTransactions(), loadProductStock(), loadOrders()]);
  } catch(e){
    console.error('送出訂單前重新整理資料失敗', e);
    msg.className = 'msg error';
    msg.textContent = t('errRefreshBeforeSubmitFailed');
    return;
  }
  msg.textContent = '';
  renderOrderItemsTable(); // 剛剛抓到的最新庫存,順便讓畫面上顯示的可訂數量也跟著更新

  const { dateVal, noteVal, partyId, partyObj, partyName, items, errors } = collectOrderItems();

  if(errors.length > 0){
    showInfoModal(`⚠ ${t('errOrderSubmitFailedPrefix')}${errors.join('; ')}`);
    return;
  }

  // 最後一道防線,跟上面 collectOrderItems() 的本地檢查分開、一定會執行:即使上面沒抓到問題,
  // 本地端 orders 陣列仍然可能因為「限定出貨方權限」的帳號看不到其他出貨方的預訂量而是不完整
  // 的(見 fetchGlobalReservedQty 的說明)。這裡改用跨出貨方、權威性的全系統預訂總量重新驗證
  // 一次每個品項的數量,不管購物車頁面當下有沒有因為庫存不夠擋下來,送出前都會再檢查這一次。
  msg.className = 'msg';
  msg.textContent = t('checkingLatestStockMsg');
  let globalReserved;
  try{
    globalReserved = await fetchGlobalReservedQty();
  } catch(e){
    console.error('送出訂單前的全系統庫存檢查失敗', e);
    msg.className = 'msg error';
    msg.textContent = t('errRefreshBeforeSubmitFailed');
    return;
  }
  msg.textContent = '';

  const qtyByProduct = {};
  items.forEach(it => { qtyByProduct[it.productId] = (qtyByProduct[it.productId] || 0) + it.qty; });
  const oversellErrors = [];
  Object.keys(qtyByProduct).forEach(productId => {
    const p = products.find(pp => pp.id === productId);
    if(!p) return;
    const trueAvailable = Math.max(0, computeTotalStock(productId) - (globalReserved[productId] || 0));
    if(qtyByProduct[productId] > trueAvailable){
      oversellErrors.push(tf('errQtyExceedsAvailableOrder', { name: p.name, qty: qtyByProduct[productId], stock: trueAvailable }));
    }
  });
  if(oversellErrors.length > 0){
    showInfoModal(`⚠ ${t('errOrderSubmitFailedPrefix')}${oversellErrors.join('; ')}`);
    renderOrderItemsTable();
    return;
  }

  // 送出前先跳出確認視窗,把送貨日期跟出貨方明確列出來,避免手滑選錯日期/出貨方沒發現就送出去了。
  const partyLabel = partyName || t('partyUnspecified');
  const confirmMsg = tf('confirmSubmitOrderMsg', { date: dateVal, party: partyLabel });
  showConfirmModal(confirmMsg, () => doConfirmOrderFromCart(dateVal, noteVal, partyId, partyName, items));
}

async function doConfirmOrderFromCart(dateVal, noteVal, partyId, partyName, items){
  const msg = document.getElementById('cartMsg');

  if(addingItemsToOrderId){
    await mergeItemsIntoExistingOrder(addingItemsToOrderId, items);
    return;
  }

  const orderId = genId();
  let orderNo = '';
  try{
    orderNo = await getSafeNextOrderNo();
  } catch(e){
    showInfoModal('⚠ 取得訂單編號失敗,請重新整理頁面再試一次。');
    return;
  }
  const orderPayload = {
    id: orderId,
    date: dateVal,
    note: noteVal,
    partyId: partyId || null,
    partyName,
    items,
    status: 'pending',
    createdAt: new Date().toISOString(),
    orderNo
  };

  try{
    await upsertOrders([orderPayload]);
  } catch(e){
    console.error('建立待處理訂單失敗', e);
    showInfoModal('⚠ 訂貨失敗,請重新整理頁面再試一次或聯絡管理者。');
    return;
  }

  orders.push(orderPayload);
  recomputeOrderCounterFromOrders();
  await saveOrderCounter();
  logInventoryAction('order_place', `Created pending order ${orderNo} (${partyName || 'No recipient specified'}, ${items.length} item(s)), stock not yet deducted${noteVal ? `, note: "${noteVal}"` : ''}`, orderNo);

  document.getElementById('orderNote').value = '';
  orderQtyDraft = {};
  orderItemNoteDraft = {};
  document.getElementById('orderCartSection').style.display = 'none';
  document.getElementById('orderFormSection').style.display = '';
  const formMsg = document.getElementById('orderMsg');
  formMsg.className = 'msg ok';
  formMsg.textContent = `✓ 訂貨單 ${orderNo} 已送出,共 ${items.length} 項商品,已記錄到「訂貨後台管理 → 待處理訂單」,等待核對後才會正式扣除庫存。`;
  renderAll();
}

// 把購物車裡選好的品項併進一張既有的待處理訂單(從「訂購記錄 → 修改 → 新增商品」進來的流程),
// 不建立新訂單、不佔新的訂單號。同一個商品如果訂單裡已經有了,直接把數量加上去;沒有的話當
// 新品項加進去。存檔前重新檢查一次這張訂單還是待處理、沒被取消/簽收、也沒有正在被載入到
// 「訂單核對」頁面——這段時間內狀態有可能被別的裝置動過,不能只信任進入這個流程當下的檢查。
// 共用的核心合併邏輯:把 newItems 併進 orderId 這張「待處理」訂單,不含任何特定畫面的清理動作
// (取消模式、跳轉分頁、彈出成功訊息…那些留給呼叫端自己依畫面情境處理)。「訂貨」分頁的新增商品
// 跟「登記進出貨」分頁的新增商品(併入待處理訂單草稿)都共用這個核心。
async function mergeItemsIntoOrderCore(orderId, newItems){
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted || !isPreVerificationStatus(order) || order.signedAt){
    return { ok: false, reason: 'not_editable' };
  }
  if(verifyPageOrderId === orderId){
    return { ok: false, reason: 'being_processed' };
  }

  const prevItems = order.items;
  const mergedItems = prevItems.map(it => ({ ...it }));
  const isProcessing = orderStatus(order) === 'processing';
  const postVerifyAdditions = [];
  newItems.forEach(newIt => {
    const existing = mergedItems.find(it => it.productId === newIt.productId && !it.deleted);
    if(existing){
      const oldQty = existing.qty;
      existing.qty += newIt.qty;
      if(!existing.qtyHistory) existing.qtyHistory = [];
      const changeAt = new Date().toISOString();
      existing.qtyHistory.push({ from: oldQty, to: existing.qty, at: changeAt });
      if(isProcessing) postVerifyAdditions.push({ kind: 'qty', productId: existing.productId, name: existing.name, sku: existing.sku, unit: existing.unit, from: oldQty, to: existing.qty, at: changeAt });
    } else {
      const addedAt = new Date().toISOString();
      mergedItems.push({ ...newIt, qtyHistory: [{ added: true, at: addedAt, qty: newIt.qty }] });
      if(isProcessing) postVerifyAdditions.push({ kind: 'added', productId: newIt.productId, name: newIt.name, sku: newIt.sku, unit: newIt.unit, qty: newIt.qty, at: addedAt });
    }
  });
  order.items = mergedItems;
  if(postVerifyAdditions.length > 0){
    if(!order.postVerifyChanges) order.postVerifyChanges = [];
    order.postVerifyChanges.push(...postVerifyAdditions);
  }

  try{
    await upsertOrders([order]);
  } catch(e){
    order.items = prevItems;
    if(postVerifyAdditions.length > 0) order.postVerifyChanges.splice(order.postVerifyChanges.length - postVerifyAdditions.length, postVerifyAdditions.length);
    console.error('新增商品到既有訂單失敗', e);
    return { ok: false, reason: 'save_failed' };
  }

  logInventoryAction('order_edit', `Order ${order.orderNo || orderId} - added: ${newItems.map(it => `${it.name} ${it.qty} ${it.unit}`).join(', ')}`, order.orderNo);
  return { ok: true, order };
}

async function mergeItemsIntoExistingOrder(orderId, newItems){
  if(warnIfOrderBeingProcessed(orderId)){
    cancelAddItemsToOrder();
    return;
  }
  const result = await mergeItemsIntoOrderCore(orderId, newItems);
  if(!result.ok){
    showInfoModal(result.reason === 'not_editable' ? `⚠ ${t('errOrderNoLongerEditable')}` : '⚠ 新增商品失敗,請重新整理頁面再試一次。');
    cancelAddItemsToOrder();
    return;
  }

  cancelAddItemsToOrder();
  document.getElementById('orderCartSection').style.display = 'none';
  document.getElementById('orderFormSection').style.display = '';
  switchOrderSubTab('subtab-order-history');
  expandedOrderIds.add(orderId);
  renderAll();
  showInfoModal(tf('addToOrderSuccessMsg', { orderNo: result.order.orderNo || orderId, n: newItems.length }));
}

// 訂單狀態統一從這裡讀取:沒有 status 欄位的舊資料視為 'confirmed'(已完成),跟 confirm_order/
// 登記進出貨併入已完成訂單這些既有流程的既有行為一致;只有新的「送出訂貨」流程會建立 'pending'
// (待處理,尚未核對、尚未扣庫存)的訂單。
function orderStatus(o){ return o.status || 'confirmed'; }
// 訂單還沒核對過(不管是單純待處理,還是倉庫已經列印過 picking slip、進入「處理中」)都算「還在
// 核對前」的階段——倉庫端(登記進出貨、訂單核對)在這整個階段都可以編輯/核對這張訂單。只有
// 訂購記錄(顧客自助修改)不一樣,一旦變成 'processing' 就不能再改了,見 renderOrderHistory
// 的 editable 判斷(那裡刻意只比對 === 'pending',不用這個函式,才能正確排除 'processing')。
function isPreVerificationStatus(order){
  const s = orderStatus(order);
  return s === 'pending' || s === 'processing';
}

function populateCompletedOrderPartyFilter(){
  const sel = document.getElementById('completedOrderPartyFilter');
  if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${t('optAllParties')}</option>` +
    shippingParties.map(sp => `<option value="${sp.id}">${sp.name.replace(/"/g,'&quot;')}</option>`).join('');
  if(shippingParties.some(sp => sp.id === prev)) sel.value = prev;
}

function populatePendingOrderPartyFilter(){
  const sel = document.getElementById('pendingOrderPartyFilter');
  if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${t('optAllParties')}</option>` +
    shippingParties.map(sp => `<option value="${sp.id}">${sp.name.replace(/"/g,'&quot;')}</option>`).join('');
  if(shippingParties.some(sp => sp.id === prev)) sel.value = prev;
}

// 四份訂單清單(待處理/已完成/訂購記錄/訂單核對頁面的左欄)共用同一組 expandedOrderIds /
// editingOrderItemKey / editingOrderRemarkId 全域狀態,改動其中一筆之後全部都要重畫,不然其他地方
// 舊的展開/編輯狀態不會消失。
function refreshOrderLists(){
  renderOrders();
  renderPendingOrders();
  renderOrderHistory();
  renderVerifyPage();
}

// 訂單卡片裡單一品項那一列的 HTML,「待處理訂單」跟「已完成訂單」共用:isPending=true 時用
// 待處理專用的刪除/改數量流程(不動進出貨紀錄,因為都還沒扣庫存),isPending=false 時維持原本
// 「未出庫/已出庫」那套(因為已經扣過庫存、有真的出貨紀錄要處理)。
function orderItemRowHtml(o, it, isPending, readOnly, context){
  context = context || 'default';
  if(it.deleted){
    const label = isPending ? t('itemDeletedLabelPending') : (it.deleteStockStatus === 'stocked_out' ? t('itemDeletedLabelStockedOut') : t('itemDeletedLabel'));
    return `
      <div>
        <span style="text-decoration:line-through;color:var(--ink-soft);">${it.sku ? `<span class="sku-tooltip-trigger" data-sku="${it.sku.replace(/"/g,'&quot;')}">${it.name}</span>` : it.name}</span>
        <span style="color:var(--ink-soft);">${it.qty} ${it.unit} · <span style="color:var(--crit);">${label}</span></span>
        ${it.note ? `<div style="font-size:11px;color:var(--ink-soft);font-style:italic;">${t('noteLabelPrefix')}${it.note.replace(/</g,'&lt;')}</div>` : ''}
      </div>
    `;
  }
  // 已簽收的訂單完全鎖住,不能改數量、也不能刪除品項——簽收後這張訂單所有相關紀錄都不能再更動,
  // 只能疊加新增附註(見 orderRemark 那組函式),不能修改或刪除既有內容。
  const canEdit = !o.deleted && !readOnly;
  // editingOrderItemKey、輸入框的 id 都要帶上 context(是哪個畫面在渲染這一列),不能只用
  // 訂單 id + 商品 id——因為同一張訂單有可能同時出現在好幾個地方(例如待處理訂單清單、又剛好
  // 被載入在訂單核對頁面),如果 id 沒有區分畫面,document.getElementById 會抓到「第一個找到的
  // 那個」,可能不是使用者實際在改的那一個,導致改數量看起來像沒有生效。
  const isEditingQty = canEdit && editingOrderItemKey === `${context}::${o.id}::${it.productId}`;
  const saveFn = isPending ? 'savePendingOrderItemQty' : 'saveOrderItemQty';
  const deleteFn = isPending ? 'deletePendingOrderItem' : 'deleteOrderItem';
  if(isEditingQty){
    return `
      <div>
        <span>${it.sku ? `<span class="sku-tooltip-trigger" data-sku="${it.sku.replace(/"/g,'&quot;')}">${it.name}</span>` : it.name}</span>
        <span>
          <input type="number" id="orderItemQtyInput_${context}_${o.id}_${it.productId}" value="${it.qty}" ${isPending ? 'min="0"' : ''} step="1"
            style="width:70px;font-family:inherit;font-size:inherit;" />
          <span class="row-unit">${it.unit}</span>
          <span class="del-link" style="margin-left:8px;" onclick="${saveFn}('${context}','${o.id}','${it.productId}')">${t('btnSave')}</span>
          <span class="del-link" style="margin-left:8px;" onclick="cancelEditOrderItemQty()">${t('btnCancel')}</span>
        </span>
      </div>
    `;
  }
  // 核對之後(訂單狀態不再是「待處理」)就不再顯示「待處理訂單階段」改數量留下的異動紀錄
  // (例如 "(20→25)" 這種)——這個紀錄本來是給核對之前參考用的,核對之後只需要看「現在確實是
  // 多少數量」,加上下面獨立的「核對後變更」區塊(核對之後的異動有另外記錄在那裡),不需要再
  // 混著看這個。qtyHistory 陣列本身還是保留原始資料沒有刪除,只是核對後不在這裡顯示出來而已。
  const qtyHistoryStr = (isPreVerificationStatus(o) && it.qtyHistory && it.qtyHistory.length > 0)
    ? `(${it.qtyHistory.map(h => h.added ? t('newlyAddedLabel') : `${h.from}→${h.to}`).join(',')}) `
    : '';
  const isRestockDisplay = it.qty < 0;
  const qtyLabel = `${it.qty} ${it.unit}${isRestockDisplay ? ` <span style="color:var(--safe);font-weight:600;">(${t('stockedInLabel')})</span>` : ''}`;
  const qtyDisplay = qtyHistoryStr
    ? `<span style="color:var(--crit);">${qtyHistoryStr}</span>${qtyLabel}`
    : qtyLabel;
  return `
    <div>
      <span>${it.sku ? `<span class="sku-tooltip-trigger" data-sku="${it.sku.replace(/"/g,'&quot;')}">${it.name}</span>` : it.name}</span>
      <span>${qtyDisplay}
        ${canEdit ? `<span class="del-link" style="margin-left:8px;" onclick="startEditOrderItemQty('${context}','${o.id}','${it.productId}')">${t('btnEditQty')}</span>` : ''}
        ${canEdit ? `<span class="del-link" style="margin-left:8px;color:var(--crit);" onclick="${deleteFn}('${o.id}','${it.productId}')">${t('btnDelete')}</span>` : ''}
      </span>
      ${it.note ? `<div style="font-size:11px;color:var(--ink-soft);font-style:italic;">${t('noteLabelPrefix')}${it.note.replace(/</g,'&lt;')}</div>` : ''}
    </div>
  `;
}

function renderOrders(){
  const container = document.getElementById('completedOrdersList');
  if(!container) return;

  const partyFilter = document.getElementById('completedOrderPartyFilter') ? document.getElementById('completedOrderPartyFilter').value : '';
  const dateFrom = document.getElementById('completedOrderDateFrom') ? document.getElementById('completedOrderDateFrom').value : '';
  const dateTo = document.getElementById('completedOrderDateTo') ? document.getElementById('completedOrderDateTo').value : '';

  // 已完成訂單清單只顯示真的核對過、已經扣庫存的訂單(狀態 'confirmed');'pending'(待處理,尚未
  // 核對)的訂單改到「待處理訂單」子分頁顯示,'cancelled' 是舊版本可能留下的測試資料,直接排除。
  let list = orders.filter(o => orderStatus(o) === 'confirmed');
  if(partyFilter) list = list.filter(o => o.partyId === partyFilter);
  if(dateFrom) list = list.filter(o => o.date >= dateFrom);
  if(dateTo) list = list.filter(o => o.date <= dateTo);
  list = list.sort((a,b) => (a.date === b.date ? String(b.id).localeCompare(String(a.id)) : (a.date < b.date ? 1 : -1)));

  if(list.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noCompletedOrders')}</div>`;
    return;
  }

  container.innerHTML = list.map(o => {
    const isExpanded = expandedOrderIds.has(o.id);
    // 訂單本身沒有被整筆刪除,但裡面有品項被改過數量或個別刪除,才算「後來被修改過」
    // (整筆刪除已經有「已刪除」狀態標籤,不需要再重複標註)。
    const wasModified = !o.deleted && o.items.some(it => (it.qtyHistory && it.qtyHistory.length > 0) || it.deleted);
    // 已完成訂單在還沒簽收前,這裡(訂貨後台管理)還是能改;一旦簽收過(o.signedAt),不管哪一邊
    // 都不能再改了,這裡也要跟著鎖住(readOnly=!!o.signedAt),之前沒有這個檢查,簽收後其實還是
    // 能被改掉,這次一併修正。
    const itemsHtml = o.items.filter(it => !it.deleted).map(it => orderItemRowHtml(o, it, false, true, 'completed')).join('');
    // 這張訂單有沒有東西可以在「觀看修改紀錄」小視窗裡看——一般修改紀錄(改數量/新增/刪除)
    // 或核對後變更,只要有一個就顯示這個按鈕,完全沒異動過的訂單就不用顯示了。
    const hasHistory = wasModified || (o.postVerifyChanges && o.postVerifyChanges.length > 0);
    const isEditingRemark = editingOrderRemarkId === o.id;
    const remarkHtml = isEditingRemark ? `
      <div style="margin:8px 0;">
        <textarea id="orderRemarkInput_${o.id}" rows="2" style="width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;" placeholder="${t('orderRemarkPlaceholder')}">${(o.note || '').replace(/</g,'&lt;')}</textarea>
        <div style="margin-top:4px;display:flex;gap:8px;">
          <button class="btn" onclick="saveOrderRemark('${o.id}')">${t('btnSave')}</button>
          <button class="btn ghost" onclick="cancelEditOrderRemark()">${t('btnCancel')}</button>
        </div>
      </div>
    ` : `
      <div style="margin:8px 0;font-size:12px;color:var(--ink-soft);">
        ${o.note ? `${t('orderRemarkLabelPrefix')}${o.note.replace(/</g,'&lt;')}` : `<span style="font-style:italic;">${t('orderRemarkEmptyLabel')}</span>`}
        <span class="del-link" style="margin-left:8px;" onclick="startEditOrderRemark('${o.id}')">${t('btnEditRemark')}</span>
      </div>
    `;
    return `
      <div class="order-card ${o.deleted ? 'order-card-deleted' : ''}">
        <div class="order-card-head" style="cursor:pointer;" onclick="toggleOrderExpand('${o.id}')">
          <span class="order-card-date">
            <span style="display:inline-block;width:14px;">${isExpanded ? '▾' : '▸'}</span>
            ${o.orderNo ? `<span style="color:var(--ink-soft);font-weight:400;">${o.orderNo}</span> · ` : ''}${o.date}${o.partyName ? ` <span style="font-weight:400;color:var(--ink-soft);">· ${tf('orderCardPartyLabel', {name: o.partyName})}</span>` : ''}
            ${o.remark ? `<span title="${t('orderHasRemarkTitle')}" style="margin-left:6px;color:var(--yellow-dark);">📝</span>` : ''}
            ${wasModified ? `<span title="${t('orderWasModifiedTitle')}" style="margin-left:6px;color:var(--warn);">✎</span>` : ''}
          </span>
          <span class="order-status-pill ${o.deleted ? 'deleted' : 'confirmed'}">${o.deleted ? t('statusOrderDeleted') : t('statusCompleted')}</span>${o.signedAt ? `<span title="${tf('orderSignedAtTitle', {datetime: formatOrderDateTime(o.signedAt)})}" style="margin-left:6px;color:var(--safe);">✔ ${t('statusSigned')}</span>` : ''}
        </div>
        ${isExpanded ? `
          <div class="order-items">${itemsHtml}</div>
          ${remarkHtml}
          ${o.signedAt && o.signInfo ? `
          <div class="section-title" style="font-size:13px;margin-top:10px;" data-i18n="secSignInfo">簽收資訊</div>
          <div style="font-size:12.5px;color:var(--ink);">
            ${o.signInfo.type === 'warehouse'
              ? `${tf('signedByNameLabel', { name: o.signInfo.signerName || '' })}<br/>
                 <img src="${o.signInfo.signatureUrl}" onclick="openSignatureViewModal('${o.signInfo.signatureUrl}')" style="max-width:160px;max-height:80px;border:1px solid var(--line);border-radius:4px;background:#fff;margin-top:4px;cursor:pointer;" />`
              : tf('signedByUsernameLabel', { name: o.signInfo.username || '' })}
          </div>
          ` : ''}
          <div class="order-card-actions">
            ${(o.deleted || o.signedAt) ? '' : `<button class="btn ghost" onclick="editOrderViaRegister('${o.id}', 'completed')">${t('btnEdit')}</button>`}
            ${(o.deleted || o.signedAt) ? '' : `<button class="btn ghost" onclick="openWarehouseSignModal('${o.id}')">${t('btnWarehouseSign')}</button>`}
            ${hasHistory ? `<button class="btn ghost" onclick="openOrderHistoryModal('${o.id}')">${t('btnViewHistory')}</button>` : ''}
            <span style="display:inline-flex;align-items:center;gap:6px;">
              <label style="font-size:11px;color:var(--ink-soft);font-weight:700;text-transform:uppercase;" data-i18n="lblAction">Action</label>
              <select id="orderActionSelect_${o.id}" style="width:auto;">
                <option value="export">${t('actionExport')}</option>
                <option value="print">${t('actionPrint')}</option>
                ${o.signedAt ? `<option value="email">${t('actionEmail')}</option>` : ''}
              </select>
              <button class="btn ghost" onclick="runOrderAction('${o.id}')">${t('btnRunAction')}</button>
            </span>
            ${o.emailedAt ? `<span style="margin-left:2px;color:var(--safe);font-size:12px;" title="${tf('emailedToTitle', { email: o.emailedTo || '', when: o.emailedAt })}">${t('alreadyEmailedBadge')}</span><span style="margin-left:4px;color:var(--ink-soft);font-size:10.5px;">${formatEmailedTimeShort(o.emailedAt)}</span>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// 收集一張訂單所有品項的「一般修改紀錄」(核對前的改數量/新增/軟刪除),依時間排序(新到舊)。
// 「核對後變更」(order.postVerifyChanges)是分開處理的,不算在這份清單裡——在畫面上獨立成
// 另一個區塊,不要混在一起顯示。
function collectOrderModificationHistory(order){
  const entries = [];
  order.items.forEach(it => {
    (it.qtyHistory || []).forEach(h => {
      if(h.added){
        entries.push({ at: h.at, text: tf('historyItemAdded', { name: it.name, qty: h.qty, unit: it.unit }) });
      } else {
        entries.push({ at: h.at, text: tf('historyQtyChanged', { name: it.name, from: h.from, to: h.to, unit: it.unit }) });
      }
    });
    if(it.deleted && it.deletedAt){
      entries.push({ at: it.deletedAt, text: tf('historyItemDeleted', { name: it.name, qty: it.qty, unit: it.unit }) });
    }
  });
  entries.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return entries;
}

// 已完成訂單卡片裡「觀看修改紀錄」:跳出獨立小視窗,上面是一般修改紀錄(每一項都帶時間,精確到
// 分鐘),下面另外獨立一個區塊顯示核對後變更(如果有的話)。關閉視窗就回到原本清單頁面
// (視窗本身蓋在清單上面,關掉就看得到清單,不需要另外導覽)。
function openOrderHistoryModal(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  document.getElementById('orderHistoryModalTitle').textContent = tf('orderHistoryModalTitle', { orderNo: order.orderNo || '' });

  const generalHistory = collectOrderModificationHistory(order);
  const generalList = document.getElementById('orderHistoryModalGeneralList');
  generalList.innerHTML = generalHistory.length > 0
    ? generalHistory.map(e => `<div style="font-size:12px;padding:3px 0;"><span style="color:var(--ink-soft);font-family:'IBM Plex Mono',monospace;">${formatOrderDateTime(e.at)}</span> ${e.text}</div>`).join('')
    : `<div class="empty-note" style="padding:8px 0;">${t('noModificationHistory')}</div>`;

  const postVerifyChanges = order.postVerifyChanges || [];
  const postVerifySection = document.getElementById('orderHistoryModalPostVerifySection');
  const postVerifyList = document.getElementById('orderHistoryModalPostVerifyList');
  if(postVerifyChanges.length > 0){
    postVerifySection.style.display = '';
    postVerifyList.innerHTML = formatPostVerifyChangesHtml(postVerifyChanges);
  } else {
    postVerifySection.style.display = 'none';
  }

  document.getElementById('orderHistoryModalOverlay').style.display = 'flex';
}

function closeOrderHistoryModal(){
  document.getElementById('orderHistoryModalOverlay').style.display = 'none';
}

function toggleOrderExpand(orderId){
  if(expandedOrderIds.has(orderId)) expandedOrderIds.delete(orderId);
  else expandedOrderIds.add(orderId);
  refreshOrderLists();
}

// 刪除整筆訂單採「軟刪除」:退回庫存、把訂單裡的商品跟訂單本身都標註為已刪除,
// 但訂單紀錄仍保留在「已完成訂單」清單裡(顯示並標註已刪除),不會從紀錄裡清除。
// 已簽收的訂單完全鎖住,整張訂單也不能刪除——簽收後不能再更動任何內容,只能疊加新增附註。
function deleteCompletedOrder(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  if(order.signedAt){
    showInfoModal(t('errOrderAlreadySigned'));
    return;
  }
  const activeItems = order.items.filter(it => !it.deleted);
  showConfirmModal(tf('confirmDeleteOrder', {n: activeItems.length}), async () => {
    const removed = transactions.filter(t => t.orderId === orderId);
    transactions = transactions.filter(t => t.orderId !== orderId);
    const now = new Date().toISOString();
    order.items.forEach(it => {
      if(!it.deleted){ it.deleted = true; it.deletedAt = now; }
    });
    order.deleted = true;
    order.deletedAt = now;
    expandedOrderIds.delete(orderId);
    await deleteTransactions(removed);
    await upsertOrders([order]);
    logInventoryAction('order_delete', `Deleted order ${order.orderNo || orderId} (${order.partyName || 'No recipient specified'}, stock returned)`, order.orderNo);
    renderAll();
  });
}

// 只刪除訂單裡的其中一項商品(這張訂單已經核對過、真的扣過庫存了):原本那筆出貨紀錄保留不動
// (對帳才看得出來曾經出過貨),另外在進出貨紀錄裡新增一筆「入庫」紀錄把庫存加回來。商品本身還
// 留在訂單明細裡,標註「已刪除」;如果訂單裡的商品全部都被刪除了,訂單本身也標註為已刪除
// (軟刪除),但仍保留在紀錄裡。
// 已簽收的訂單完全鎖住,不能刪除品項、也不能改數量——簽收後這張訂單的所有內容都不能再更動,
// 只能疊加新增附註,不能修改或刪除既有內容。
function deleteOrderItem(orderId, productId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  if(order.signedAt){
    showInfoModal(t('errOrderAlreadySigned'));
    return;
  }
  const item = order.items.find(it => it.productId === productId && !it.deleted);
  if(!item) return;
  showConfirmModal(tf('confirmDeleteOrderItem', {name: item.name, qty: Math.abs(item.qty), unit: item.unit}), async () => {
    const now = new Date().toISOString();
    try{
      const txId = genId();
      // item.qty 有可能是負的(這一項當初是用「新增商品」以負數新增、代表入庫/退貨的品項)——
      // 這種情況下刪除要做相反的事:當初新增的時候是「入庫」(restock),刪除要把那筆入庫的量
      // 「扣」回去,所以是 out;反過來,一般正數品項(當初出貨)刪除時是把出貨的量加回去,是 restock。
      const isRestockItem = item.qty < 0;
      const noteText = tf('orderItemDeletedRestockNote', { orderNo: order.orderNo || '', name: item.name, qty: Math.abs(item.qty), unit: item.unit });
      const tx = { id: txId, productId, type: isRestockItem ? 'out' : 'restock', qty: Math.abs(item.qty), date: todayISO(), party: order.partyName || '', note: noteText, system: true, orderId };
      transactions.push(tx);
      // 刪除是把 item.qty 這個異動「反過來」:item.qty 本身帶正負號,直接加回去就對了——
      // 原本是正數(出貨)的話,加回去等於補回庫存;原本是負數(入庫)的話,加回去(等於加一個
      // 負數,也就是減少)會正確把當初多加的庫存扣掉。之前這裡漏了更新這個本機快取,畫面上的
      // 庫存要等下一次背景同步才會更新回來,這次一併補上,操作完馬上就是正確的數字。
      productStockMap[productId] = (productStockMap[productId] || 0) + item.qty;
      await insertTransactions([tx]);
    } catch(e){
      console.error('刪除訂單商品失敗', e);
      showInfoModal('⚠ 操作失敗,請重新整理頁面再試一次。');
      return;
    }

    item.deleted = true;
    item.deletedAt = now;
    item.deleteStockStatus = 'stocked_out';
    if(order.items.every(it => it.deleted)){
      order.deleted = true;
      order.deletedAt = now;
      expandedOrderIds.delete(orderId);
    }
    await upsertOrders([order]);
    logInventoryAction('order_edit', `Order ${order.orderNo || orderId} - removed item: ${item.name} ${item.qty} ${item.unit} (restock entry added)`, order.orderNo);
    renderAll();
  });
}

function startEditOrderItemQty(context, orderId, productId){
  editingOrderItemKey = `${context}::${orderId}::${productId}`;
  refreshOrderLists();
}

function cancelEditOrderItemQty(){
  editingOrderItemKey = null;
  refreshOrderLists();
}

// 已完成訂單裡改品項數量:改多了要再扣庫存(等於補出貨),改少了要把差額退回庫存(入庫)。這兩種
// 都會另外「新增」一筆進出貨紀錄(備註標註訂單號跟新舊數量),不會動到原本那筆出貨紀錄,方便之後
// 對帳看得出這張訂單前後改過什麼。扣庫存的部分一樣走 RPC 做 atomic 檢查+扣除,庫存不夠會直接拒絕。
async function saveOrderItemQty(context, orderId, productId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  if(order.signedAt){
    showInfoModal(t('errOrderAlreadySigned'));
    editingOrderItemKey = null;
    refreshOrderLists();
    return;
  }
  const item = order.items.find(it => it.productId === productId && !it.deleted);
  if(!item) return;
  const input = document.getElementById(`orderItemQtyInput_${context}_${orderId}_${productId}`);
  if(!input) return;
  const newQty = parseFloat(input.value);
  if(isNaN(newQty)){
    showInfoModal(t('errEnterValidQty'));
    return;
  }
  if(!Number.isInteger(newQty)){
    showInfoModal(t('errQtyMustBeInteger'));
    return;
  }
  if(newQty === item.qty){
    editingOrderItemKey = null;
    refreshOrderLists();
    return;
  }
  if(newQty === 0){
    editingOrderItemKey = null;
    showConfirmModal(t('confirmZeroQtyIsDelete'), () => deleteOrderItem(orderId, productId));
    return;
  }

  const oldQty = item.qty;

  // 數量改多代表要多扣庫存(補出貨)——商品分布在多個位置的話,先問清楚要從哪裡扣,邏輯跟訂單
  // 核對、直接出貨共用同一套機制。數量改少(退庫存)不用問,退回的庫存一律先算未分布。
  let qtyChangeAllocations = null;
  if(newQty > oldQty){
    try{
      qtyChangeAllocations = await resolveLocationAllocationsForItem(productId, newQty - oldQty);
    } catch(e){
      return; // 使用者取消了位置選擇,整個數量調整中止
    }
  }

  const txId = genId();
  const noteText = tf('orderItemQtyChangedNote', { orderNo: order.orderNo || '', name: item.name, oldQty, newQty, unit: item.unit });

  const { error } = await sb.rpc('adjust_order_item_qty', {
    p_order_id: orderId,
    p_product_id: productId,
    p_new_qty: newQty,
    p_tx_id: txId,
    p_date: todayISO(),
    p_note: noteText
  });

  if(error){
    const failures = parseInsufficientStockError(error);
    if(failures && failures[0]){
      showInfoModal(tf('errAdjustQtyInsufficientStock', { name: item.name, available: failures[0].available, requested: failures[0].requested }));
    } else {
      console.error('adjust_order_item_qty failed', error);
      showInfoModal(t('errAdjustQtyGeneric'));
    }
    return;
  }

  const qtyDelta = newQty - oldQty;
  // 數量改多了 = 補出貨(out);數量改少了代表要把差額退回庫存,算「入庫」(restock),不是一般進貨(in)。
  const tx = {
    id: txId, productId, type: qtyDelta > 0 ? 'out' : 'restock', qty: Math.abs(qtyDelta),
    date: todayISO(), party: order.partyName || '', note: noteText, system: true, orderId
  };
  transactions.push(tx);
  productStockMap[productId] = (productStockMap[productId] || 0) - qtyDelta;

  // 伺服器那邊(adjust_order_item_qty RPC)已經確定扣庫存成功了,這裡才去動 product_locations,
  // 避免庫存扣了/位置卻沒對應更新的不一致。
  if(qtyChangeAllocations){
    await applyLocationDeductions([{ productId, qty: newQty - oldQty, allocations: qtyChangeAllocations }]);
  }

  item.qty = newQty;
  if(!item.qtyHistory) item.qtyHistory = [];
  item.qtyHistory.push({ from: oldQty, to: newQty, at: new Date().toISOString() });
  editingOrderItemKey = null;
  try{ await upsertOrders([order]); }
  catch(e){ console.error('儲存數量調整紀錄失敗', e); }
  logInventoryAction('order_edit', `Order ${order.orderNo || orderId} - quantity adjusted: ${item.name} ${oldQty}→${newQty} ${item.unit}`, order.orderNo);
  renderAll();
}

function startEditOrderRemark(orderId){
  editingOrderRemarkId = orderId;
  refreshOrderLists();
}

function cancelEditOrderRemark(){
  editingOrderRemarkId = null;
  refreshOrderLists();
}

// 訂單附註是給「訂單確認之後」隨時想補記點什麼用的,跟訂貨當下填的那個備註(o.note)是分開的
// 欄位,已刪除的訂單一樣可以編輯(那張訂單卡片還在畫面上,只是狀態顯示已刪除);待處理訂單也
// 能編輯備註,共用同一個函式。
async function saveOrderRemark(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const input = document.getElementById(`orderRemarkInput_${orderId}`);
  const value = input ? input.value.trim() : '';
  const oldNote = order.note || '';
  if(value === oldNote){ editingOrderRemarkId = null; refreshOrderLists(); return; } // 沒改就不用存、也不用留紀錄
  order.note = value;
  editingOrderRemarkId = null;
  try{ await upsertOrders([order]); }
  catch(e){
    order.note = oldNote;
    showInfoModal(t('errSaveRemarkGeneric'));
    refreshOrderLists();
    return;
  }
  // 跟登記進出貨那邊改備註一樣,記錄要看得出「從什麼改成什麼」,不是只寫「備註被改過」。
  logInventoryAction('order_remark', `Order ${order.orderNo || orderId} - note: "${oldNote}" → "${value}"`, order.orderNo);
  refreshOrderLists();
}

// 待處理訂單清單:狀態是 'pending' 的訂單,也就是已經送出但還沒被「核對」過的訂單 —— 這些訂單
// 完全不會影響庫存總覽的數字(還沒扣庫存),只會在計算「可訂數量」(computeAvailableForOrder)時
// 被扣掉,避免別人也訂到同一批貨。核對通過之後訂單會變成 'confirmed',移到「已完成訂單」清單。
// 待處理訂單分頁按鈕右上角的數字提示——樣式參照手機 App 桌面圖示的未讀數字提示。算的是
// 全部符合條件的筆數(不管使用者在待處理訂單清單裡有沒有另外套用出貨方/日期篩選,這個數字
// 都是總數,概念上比較接近「有幾筆事情等你處理」,不是「目前篩選結果有幾筆」)。已取消的訂單
// 不算,因為不需要再處理。
function updatePendingOrderCountBadge(){
  const badge = document.getElementById('pendingOrderCountBadge');
  if(!badge) return;
  const count = orders.filter(o => isPreVerificationStatus(o) && !o.deleted).length;
  if(count > 0){
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function renderPendingOrders(){
  const container = document.getElementById('pendingOrdersList');
  if(!container) return;

  const partyFilter = document.getElementById('pendingOrderPartyFilter') ? document.getElementById('pendingOrderPartyFilter').value : '';
  const dateFrom = document.getElementById('pendingOrderDateFrom') ? document.getElementById('pendingOrderDateFrom').value : '';
  const dateTo = document.getElementById('pendingOrderDateTo') ? document.getElementById('pendingOrderDateTo').value : '';

  let list = orders.filter(o => isPreVerificationStatus(o));
  if(partyFilter) list = list.filter(o => o.partyId === partyFilter);
  if(dateFrom) list = list.filter(o => o.date >= dateFrom);
  if(dateTo) list = list.filter(o => o.date <= dateTo);
  list = list.sort((a,b) => (a.date === b.date ? String(b.id).localeCompare(String(a.id)) : (a.date < b.date ? 1 : -1)));

  if(list.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noPendingOrders')}</div>`;
    return;
  }

  container.innerHTML = list.map(o => {
    const isExpanded = expandedOrderIds.has(o.id);
    const wasModified = !o.deleted && o.items.some(it => (it.qtyHistory && it.qtyHistory.length > 0) || it.deleted);
    // 「處理中」狀態下倉庫方的異動會記進 postVerifyChanges(見 savePendingOrderItemQty 等),這裡
    // 一併判斷要不要顯示「觀看修改紀錄」按鈕,跟已完成訂單那邊是同一顆按鈕、同一個小視窗。
    const hasHistory = wasModified || (o.postVerifyChanges && o.postVerifyChanges.length > 0);
    const itemsHtml = o.items.map(it => orderItemRowHtml(o, it, true, true, 'pending')).join('');
    const isEditingRemark = editingOrderRemarkId === o.id;
    const remarkHtml = isEditingRemark ? `
      <div style="margin:8px 0;">
        <textarea id="orderRemarkInput_${o.id}" rows="2" style="width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;" placeholder="${t('orderRemarkPlaceholder')}">${(o.note || '').replace(/</g,'&lt;')}</textarea>
        <div style="margin-top:4px;display:flex;gap:8px;">
          <button class="btn" onclick="saveOrderRemark('${o.id}')">${t('btnSave')}</button>
          <button class="btn ghost" onclick="cancelEditOrderRemark()">${t('btnCancel')}</button>
        </div>
      </div>
    ` : `
      <div style="margin:8px 0;font-size:12px;color:var(--ink-soft);">
        ${o.note ? `${t('orderRemarkLabelPrefix')}${o.note.replace(/</g,'&lt;')}` : `<span style="font-style:italic;">${t('orderRemarkEmptyLabel')}</span>`}
        <span class="del-link" style="margin-left:8px;" onclick="startEditOrderRemark('${o.id}')">${t('btnEditRemark')}</span>
      </div>
    `;
    const isEditingParty = editingOrderPartyId === o.id;
    const partyEditHtml = isEditingParty ? `
      <div style="margin:8px 0;">
        <select id="orderPartyInput_${o.id}" style="width:100%;max-width:320px;">
          <option value="">${t('optUnspecified')}</option>
          ${shippingParties.map(sp => `<option value="${sp.id}" ${sp.id === o.partyId ? 'selected' : ''}>${sp.name.replace(/"/g,'&quot;')}</option>`).join('')}
        </select>
        <div style="margin-top:4px;display:flex;gap:8px;">
          <button class="btn" onclick="saveOrderParty('${o.id}')">${t('btnSave')}</button>
          <button class="btn ghost" onclick="cancelEditOrderParty()">${t('btnCancel')}</button>
        </div>
      </div>
    ` : `
      <div style="margin:8px 0;font-size:12px;color:var(--ink-soft);">
        ${o.partyId ? tf('orderCardPartyLabel', {name: o.partyName || ''}) : `<span style="color:var(--crit);">${t('orderNoPartyLinkedWarning')}</span>`}
        <span class="del-link" style="margin-left:8px;" onclick="startEditOrderParty('${o.id}')">${t('btnEditOrderParty')}</span>
      </div>
    `;
    const activeItemCount = o.items.filter(it => !it.deleted).length;
    return `
      <div class="order-card ${o.deleted ? 'order-card-deleted' : ''}">
        <div class="order-card-head" style="cursor:pointer;" onclick="toggleOrderExpand('${o.id}')">
          <span class="order-card-date">
            <span style="display:inline-block;width:14px;">${isExpanded ? '▾' : '▸'}</span>
            ${o.orderNo ? `<span style="color:var(--ink-soft);font-weight:400;">${o.orderNo}</span> · ` : ''}${o.date}${(o.originalDate && o.originalDate !== o.date) ? ` <span title="${t('dateWasChangedTitle')}" style="font-weight:400;color:var(--warn-dark);">(${tf('originalDateLabel', {date: o.originalDate})})</span>` : ''}${o.partyName ? ` <span style="font-weight:400;color:var(--ink-soft);">· ${tf('orderCardPartyLabel', {name: o.partyName})}</span>` : ''}
            ${o.remark ? `<span title="${t('orderHasRemarkTitle')}" style="margin-left:6px;color:var(--yellow-dark);">📝</span>` : ''}
            ${wasModified ? `<span title="${t('orderWasModifiedTitle')}" style="margin-left:6px;color:var(--warn);">✎</span>` : ''}
            ${!o.deleted && !o.partyId ? `<span title="${t('orderNoPartyLinkedWarning')}" style="margin-left:6px;color:var(--crit);">⚠</span>` : ''}
          </span>
          <span class="order-status-pill ${o.deleted ? 'deleted' : (o.status === 'processing' ? 'processing' : 'pending')}">${o.deleted ? t('statusOrderCancelled') : (o.status === 'processing' ? t('statusProcessing') : t('statusPending'))}</span>
        </div>
        ${isExpanded ? `
          <div class="order-items">${itemsHtml}</div>
          ${remarkHtml}
          ${o.deleted ? '' : partyEditHtml}
          <div class="order-card-actions">
            ${o.deleted ? '' : `<button class="btn ghost" onclick="editOrderViaRegister('${o.id}', 'pending')">${t('btnEdit')}</button>`}
            ${o.deleted ? '' : `<button class="btn ghost" onclick="openOrderInVerifyPage('${o.id}')" ${activeItemCount === 0 ? 'disabled' : ''}>${t('btnLoadIntoVerifyPage')}</button>`}
            ${o.deleted ? '' : `<button class="btn ghost" onclick="cancelPendingOrder('${o.id}')">${t('btnCancelWholeOrder')}</button>`}
            ${hasHistory ? `<button class="btn ghost" onclick="openOrderHistoryModal('${o.id}')">${t('btnViewHistory')}</button>` : ''}
            <button class="btn ghost" onclick="printPendingOrder('${o.id}')">${t('btnPrintPickingSlip')}</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// 待處理訂單的「匯出」「列印」:兩個都只看目前有效的品項、用目前的最終數量,不顯示 qtyHistory
// 那些異動紀錄(那是給管理畫面自己看的,匯出/列印給外部用的單子只要看結果就好)。
function escapeHtmlForPrint(str){
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// 待處理訂單、已完成訂單的「匯出」「列印」共用:一律只看目前有效的品項、用目前的最終數量,
// 不顯示 qtyHistory 那些異動紀錄(那是給管理畫面自己看的,匯出/列印給外部用的單子只要看結果就好)。
function buildOrderExportRows(order){
  return order.items.filter(it => !it.deleted).map(it => ({ sku: it.sku || '', name: it.name, qty: it.qty, unit: it.unit, productId: it.productId, note: it.note || '' }));
}

// 列印(待處理訂單、已完成訂單共用):opts.includeCheckColumn 待處理訂單才會有(給撿貨的人拿筆
// 現場勾選用,匯出的 Excel 不需要這欄);opts.headerLabel 是列印檔案最上面的英文標示。
async function printOrderDocument(orderId, opts){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const items = buildOrderExportRows(order);
  const includeCheck = !!opts.includeCheckColumn;
  const includeSku = opts.includeSkuColumn !== false; // 預設顯示,已完成訂單那邊會特別關掉

  // Picking Slip 如果有開「顯示 Stock Location」,列印之前先把每個品項要印哪個位置問清楚——
  // 只有商品分布在多個位置(含未分布)時才會真的跳出視窗問,只有一個來源的話直接用那個,
  // 不會無端打斷列印流程。中途按取消的話,這裡直接不印(跟訂單核對按取消的行為一致)。
  //
  // 這裡選的位置會記到訂單自己身上(order.pickedLocationAllocations),之後核對這張訂單、真的要
  // 扣庫存的時候(verifyOrder)會直接沿用,不會重複問一次——不然撿貨單上印的是這裡選的位置,
  // 核對時卻可能選到不一樣的位置,會變成「單子上寫的」跟「系統實際扣的」對不起來。
  //
  // 同一張訂單如果之前已經列印過一次、問過位置了,這次再印(例如倉庫改了訂單裡其他商品,
  // 但沒動到這個商品)——沒被改到的商品直接沿用上次選的答案,不用重新問;只有真的被改過
  // (數量變了、或位置資料本身變得不夠用了)的商品才會重新跳出來問。
  let locationLabelByProductId = {};
  let locationAllocationsByProductId = {};
  if(includeCheck && stockLocationShowOnPickingSlip){
    try{
      const resolvedItems = await resolveLocationChoicesForItemsWithPreset(
        items.map(it => ({ productId: it.productId, qty: it.qty })),
        order.pickedLocationAllocations
      );
      resolvedItems.forEach(r => {
        locationAllocationsByProductId[r.productId] = r.allocations || [];
        locationLabelByProductId[r.productId] = (r.allocations || []).map(a => a.label).join(', ');
      });
      order.pickedLocationAllocations = resolvedItems.reduce((map, r) => {
        map[r.productId] = r.allocations;
        return map;
      }, {});
      try{ await upsertOrders([order]); }
      catch(e){ console.error('記錄撿貨單選的位置失敗', e); }
    } catch(e){
      return; // 使用者取消了位置選擇,整個列印動作中止
    }
  }
  function locationLabelFor(it){
    if(!includeCheck || !stockLocationShowOnPickingSlip) return '';
    return escapeHtmlForPrint(locationLabelByProductId[it.productId] || '');
  }

  // 「訂貨頁面附註」「箱數參考」這兩欄只有 picking slip(includeCheck)才會出現,印在 check 欄
  // 右邊——都不需要框框、也不需要欄位標題,單純是給撿貨的人看的補充資訊,不是正式表格資料,
  // 所以刻意跟其他有框線的欄位做出視覺區隔。
  //
  // 「箱數參考」只有主商品(不是批量商品本身)才會計算:找這個主商品名下「當作庫存總量基準」
  // 的那個批量商品(getBasisMultipackChild,跟「訂貨數量達到加權數自動轉換」用的是同一個判斷
  // 依據),如果這次訂貨數量到達一整箱的加權數,就換算成「幾箱 + 剩餘幾瓶」;數量不夠一整箱的話
  // 這欄就留空,不特別顯示「0 箱」這種沒意義的資訊。箱子固定顯示「CTN」(不管那個批量商品自己
  // 填的單位是什麼);剩餘數量的散裝單位改用字首縮寫(例如 Bottle→B、Box→B、PCS→P),不寫全名,
  // 讓這欄可以再窄一點,把版面讓給商品名跟 SKU 欄。
  function unitInitial(unit){
    const u = (unit || '').trim();
    return u ? u.charAt(0).toUpperCase() : '';
  }
  function cartonRefFor(it){
    if(!includeCheck || !hasFeature('pickingSlipQtyReference') || !it.productId) return '';
    const p = products.find(x => x.id === it.productId);
    const child = p ? getBasisMultipackChild(p) : null;
    if(!child || !(it.qty >= child.childWeight)) return '';
    const cartons = Math.floor(it.qty / child.childWeight);
    const remainder = it.qty - cartons * child.childWeight;
    const cartonPart = `${cartons} CTN`;
    return remainder > 0 ? `${cartonPart} & ${remainder}${unitInitial(it.unit)}` : cartonPart;
  }
  function remarkFor(it){
    if(!includeCheck || !it.productId) return '';
    const p = products.find(x => x.id === it.productId);
    return (p && p.orderPageRemark) ? escapeHtmlForPrint(p.orderPageRemark) : '';
  }
  // 對個別商品的備註(訂貨時「新增附註」加的那個,不是商品主檔的「訂貨頁面附註」):picking slip
  // 用原本印「訂貨頁面附註」的那個欄位來印(訂貨頁面附註現在改印在商品名稱欄後面的小字括號裡,
  // 空出這一欄);已完成訂單本來沒有這種備註欄,加在最右邊。兩邊都是「整張單子完全沒有任何一項
  // 商品有備註」才整欄隱藏,不是逐列判斷──某一列沒有備註,那一列的儲存格照樣印出來(空白),
  // 只是整欄的表頭/欄位在沒人填的時候才不出現。
  function itemNoteFor(it){
    return it.note ? escapeHtmlForPrint(it.note) : '';
  }
  const hasAnyNote = items.some(it => itemNoteFor(it));

  // 印一列的共用函式:qtyOverride/locationLabelOverride 給「一個商品拆成好幾個位置、好幾列」
  // 的情況用——同一個商品拆成多列時,每一列各自顯示自己那個位置、自己那部分的數量,SKU/商品名/
  // 單位這些照樣重複顯示在每一列(讓每一列自己看就懂,不用回頭對照上一列),不會擠在同一欄
  // 位裡反而壓縮到商品名稱欄的空間。
  function buildPrintRow(it, qtyOverride, locationLabelOverride){
    const remark = remarkFor(it);
    const nameCell = `${escapeHtmlForPrint(it.name)}${remark ? ` <span style="font-size:11px;color:#666;">(${remark})</span>` : ''}`;
    const pickingNoteTd = (includeCheck && hasAnyNote) ? `<td class="borderless-col">${itemNoteFor(it)}</td>` : '';
    const completedNoteTd = (!includeCheck && hasAnyNote) ? `<td class="fit-col">${itemNoteFor(it)}</td>` : '';
    const displayQty = qtyOverride !== undefined ? qtyOverride : it.qty;
    const locationCell = locationLabelOverride !== undefined ? escapeHtmlForPrint(locationLabelOverride) : locationLabelFor(it);
    return `
    <tr>
      ${includeSku ? `<td class="sku-col">${escapeHtmlForPrint(it.sku)}</td>` : ''}
      <td>${nameCell}</td>
      ${(includeCheck && stockLocationShowOnPickingSlip) ? `<td class="location-col">${locationCell}</td>` : ''}
      <td class="qty-col" style="text-align:right;">${displayQty}</td>
      <td class="unit-col">${escapeHtmlForPrint(it.unit)}</td>
      ${includeCheck ? `<td class="check-col"></td>` : ''}
      ${pickingNoteTd}
      ${(includeCheck && hasFeature('pickingSlipQtyReference')) ? `<td class="borderless-col">${cartonRefFor(it)}</td>` : ''}
      ${completedNoteTd}
    </tr>
  `;
  }

  const rowsHtml = items.map(it => {
    const allocations = (includeCheck && stockLocationShowOnPickingSlip) ? (locationAllocationsByProductId[it.productId] || []) : [];
    if(allocations.length > 1){
      // 湊了好幾個位置才夠這個商品的數量:每個位置各自獨立一列,不要擠在同一列裡。
      return allocations.map(a => buildPrintRow(it, a.qty, a.label)).join('');
    }
    return buildPrintRow(it);
  }).join('');
  const checkTh = includeCheck ? `<th class="check-col">${escapeHtmlForPrint('Check')}</th>` : '';
  const skuTh = includeSku ? `<th class="sku-col">${escapeHtmlForPrint('SKU')}</th>` : '';
  const locationTh = (includeCheck && stockLocationShowOnPickingSlip) ? `<th class="location-col">${escapeHtmlForPrint(t('colStockLocation'))}</th>` : '';
  const pickingNoteTh = (includeCheck && hasAnyNote) ? `<th class="borderless-col">${escapeHtmlForPrint('Note')}</th>` : '';
  const cartonTh = (includeCheck && hasFeature('pickingSlipQtyReference')) ? `<th class="borderless-col"></th>` : '';
  const completedNoteTh = (!includeCheck && hasAnyNote) ? `<th class="fit-col">${escapeHtmlForPrint('Note')}</th>` : '';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtmlForPrint(order.orderNo || orderId)}</title>
<style>
  @page{ margin:0.1in; }
  body{ font-family:'Microsoft JhengHei', Arial, sans-serif; padding:24px 0.1in; color:#111; }
  h1{ font-size:18px; margin:0 0 4px; }
  h2{ font-size:12.5px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#B23B2E; margin:0 0 14px; }
  .meta{ font-size:13px; color:#333; margin-bottom:3px; }
  .note-after-table{ font-size:16px; font-weight:600; color:#111; margin-top:16px; }
  table{ border-collapse:collapse; width:100%; margin-top:14px; }
  th, td{ padding:7px 10px; border:1px solid #999; font-size:13px; text-align:left; }
  th{ background:#eee; }
  .sku-col{ width:1%; white-space:nowrap; }
  .qty-col{ width:1%; white-space:nowrap; }
  .unit-col{ width:1%; white-space:nowrap; }
  .check-col{ width:44px; text-align:center; }
  .borderless-col{ border:none; font-size:12px; color:#555; width:1%; white-space:nowrap; }
  .location-col{ width:1%; white-space:nowrap; }
  .fit-col{ width:1%; white-space:nowrap; }
</style>
</head>
<body>
  <h2>${escapeHtmlForPrint(opts.headerLabel)}</h2>
  <h1>${escapeHtmlForPrint('Order #')} ${escapeHtmlForPrint(order.orderNo || orderId)}</h1>
  <div class="meta">${escapeHtmlForPrint('Date')}: ${order.date || ''}</div>
  <div class="meta">${escapeHtmlForPrint('Customer')}: ${escapeHtmlForPrint(order.partyName)}</div>
  ${(order.note && !includeCheck) ? `<div class="meta">${escapeHtmlForPrint('Note')}: ${escapeHtmlForPrint(order.note)}</div>` : ''}
  <table>
    <thead><tr>${skuTh}<th>${escapeHtmlForPrint('Product Name')}</th>${locationTh}<th class="qty-col">${escapeHtmlForPrint('Qty')}</th><th class="unit-col">${escapeHtmlForPrint('Unit')}</th>${checkTh}${pickingNoteTh}${cartonTh}${completedNoteTh}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  ${(order.note && includeCheck) ? `<div class="note-after-table">${escapeHtmlForPrint('Note')}: ${escapeHtmlForPrint(order.note)}</div>` : ''}
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
}

// 待處理訂單列印 picking slip:第一次列印(訂單還是「待處理」)會把狀態改成「處理中」並存檔、
// 記錄進後台紀錄——這個狀態轉換讓訂購記錄那邊知道要收回顧客自己改訂單的權限(editable 判斷
// 只比對 === 'pending',變成 'processing' 之後自然就不能改了)。已經是「處理中」的訂單再列印
// 一次不會重複轉換、也不會重複記錄。
async function printPendingOrder(orderId){
  const order = orders.find(o => o.id === orderId);
  if(order && orderStatus(order) === 'pending'){
    const oldStatus = order.status;
    order.status = 'processing';
    try{
      await upsertOrders([order]);
    } catch(e){
      console.error('更新訂單狀態失敗', e);
      order.status = oldStatus;
      showInfoModal('⚠ 更新訂單狀態失敗,請重新整理頁面再試一次。');
      return;
    }
    logInventoryAction('order_edit', `Order ${order.orderNo || orderId} - status changed to Processing (picking slip printed)`, order.orderNo);
    renderAll();
  }
  printOrderDocument(orderId, { includeCheckColumn: true, headerLabel: 'Picking Slip' });
}

function printCompletedOrder(orderId){
  printOrderDocument(orderId, { includeCheckColumn: false, includeSkuColumn: false, headerLabel: 'Completed Order' });
}

// 已完成訂單卡片上的「Action」下拉選單:選好動作、按確認執行才會真的觸發——匯出/列印是既有的
// 函式直接呼叫,email 是跳出跟進貨單共用的那個寄送確認視窗(只有已簽收的訂單才會有這個選項,
// 下拉選單本身在畫面上就已經依簽收狀態決定要不要顯示 email 這個選項了)。
function runOrderAction(orderId){
  const sel = document.getElementById(`orderActionSelect_${orderId}`);
  if(!sel) return;
  const action = sel.value;
  if(action === 'export') exportSingleOrderSheet(orderId);
  else if(action === 'print') printCompletedOrder(orderId);
  else if(action === 'email') openSendOrderEmailModal(orderId);
}

// 待處理訂單裡刪除單一品項:訂單根本還沒核對、還沒扣庫存,沒有任何進出貨紀錄要處理,
// 純粹只是取消這項預訂,直接把品項標成已刪除、存回訂單即可。
function deletePendingOrderItem(orderId, productId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const item = order.items.find(it => it.productId === productId && !it.deleted);
  if(!item) return;
  showConfirmModal(tf('confirmDeleteOrderItem', {name: item.name, qty: item.qty, unit: item.unit}), async () => {
    const now = new Date().toISOString();
    item.deleted = true;
    item.deletedAt = now;
    // 列印過 picking slip(狀態 'processing')之後倉庫方才做的改動,一樣算進「核對後變更」——
    // 即使還沒真的核對,只要 picking slip 已經印出去了,對倉庫來說訂單內容就已經算是「進行中」,
    // 之後的異動都要留痕跡讓核對的人看得到。
    if(orderStatus(order) === 'processing'){
      if(!order.postVerifyChanges) order.postVerifyChanges = [];
      order.postVerifyChanges.push({ kind: 'deleted', productId: item.productId, name: item.name, sku: item.sku, unit: item.unit, qty: item.qty, at: now });
    }
    if(order.items.every(it => it.deleted)){
      order.deleted = true;
      order.deletedAt = now;
      expandedOrderIds.delete(orderId);
    }
    try{ await upsertOrders([order]); }
    catch(e){
      item.deleted = false;
      delete item.deletedAt;
      order.deleted = false;
      delete order.deletedAt;
      showInfoModal('⚠ 操作失敗,請重新整理頁面再試一次。');
      return;
    }
    logInventoryAction('order_edit', `Pending order ${order.orderNo || orderId} - removed item: ${item.name} ${item.qty} ${item.unit} (not yet stocked out, no stock impact)`, order.orderNo);
    renderAll();
  });
}

// 取消整張待處理訂單(軟刪除):一樣沒有庫存或進出貨紀錄要處理,只是把訂單跟裡面所有品項都標成
// 已刪除,訂單卡片還留在「待處理訂單」清單裡(顯示已取消),方便之後追查。
function cancelPendingOrder(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const activeItems = order.items.filter(it => !it.deleted);
  showConfirmModal(tf('confirmCancelPendingOrder', {orderNo: order.orderNo || orderId, n: activeItems.length}), async () => {
    const now = new Date().toISOString();
    order.items.forEach(it => { if(!it.deleted){ it.deleted = true; it.deletedAt = now; } });
    order.deleted = true;
    order.deletedAt = now;
    expandedOrderIds.delete(orderId);
    try{ await upsertOrders([order]); }
    catch(e){
      order.items.forEach(it => { if(it.deletedAt === now){ it.deleted = false; delete it.deletedAt; } });
      order.deleted = false;
      delete order.deletedAt;
      showInfoModal('⚠ 操作失敗,請重新整理頁面再試一次。');
      return;
    }
    logInventoryAction('order_delete', `Cancelled pending order ${order.orderNo || orderId} (${order.partyName || 'No recipient specified'}), no stock was deducted`, order.orderNo);
    renderAll();
  });
}

// 指定/修改待處理訂單的出貨方:主要是用來補救「已經匯入、但沒正確掛上出貨方」的訂單(例如
// Excel 匯入時對象文字對不上現有出貨方名稱)——選對出貨方之後,那家出貨方的帳號才看得到、
// 才能簽收這張訂單,不用整張刪掉重新匯入。
function startEditOrderParty(orderId){
  editingOrderPartyId = orderId;
  refreshOrderLists();
}

function cancelEditOrderParty(){
  editingOrderPartyId = null;
  refreshOrderLists();
}

async function saveOrderParty(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const input = document.getElementById(`orderPartyInput_${orderId}`);
  const newPartyId = input ? input.value : '';
  const newParty = newPartyId ? shippingParties.find(sp => sp.id === newPartyId) : null;
  const prevPartyId = order.partyId;
  const prevPartyName = order.partyName;
  order.partyId = newParty ? newParty.id : null;
  order.partyName = newParty ? newParty.name : (newPartyId ? prevPartyName : '');
  editingOrderPartyId = null;
  try{ await upsertOrders([order]); }
  catch(e){
    order.partyId = prevPartyId;
    order.partyName = prevPartyName;
    showInfoModal('⚠ 操作失敗,請重新整理頁面再試一次。');
    refreshOrderLists();
    return;
  }
  logInventoryAction('order_edit', `Order ${order.orderNo || orderId} - shipping party set to ${order.partyName || 'unspecified'}`, order.orderNo);
  renderAll();
}

// 待處理訂單裡改品項數量:訂單還沒核對、還沒扣庫存,不需要走 RPC 做庫存檢查,單純更新這個品項
// 要訂的數量、存回訂單即可(下一次計算可訂數量時就會用新的數字)。按「儲存」後會先跳確認視窗,
// 確認過才真的套用(訂單核對頁面、訂貨後台管理的待處理訂單清單都共用這個函式)。
async function savePendingOrderItemQty(context, orderId, productId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const item = order.items.find(it => it.productId === productId && !it.deleted);
  if(!item) return;
  const input = document.getElementById(`orderItemQtyInput_${context}_${orderId}_${productId}`);
  if(!input) return;
  const newQty = parseFloat(input.value);
  if(isNaN(newQty) || newQty < 0){
    showInfoModal(t('errEnterNonNegativeQty'));
    return;
  }
  if(newQty === item.qty){
    editingOrderItemKey = null;
    refreshOrderLists();
    return;
  }
  if(newQty === 0){
    editingOrderItemKey = null;
    showConfirmModal(t('confirmZeroQtyIsDelete'), () => deletePendingOrderItem(orderId, productId));
    return;
  }

  // 改多了要檢查庫存夠不夠:這個品項目前「還能訂到的上限」= 可訂數量(已經扣掉其他人尚未核對的
  // 訂單佔用量)再加回這張訂單原本自己就佔用的量(不然會被自己原本訂的量重複排擠掉)。
  if(newQty > item.qty){
    const maxAllowed = computeAvailableForOrder(productId) + item.qty;
    if(newQty > maxAllowed){
      showInfoModal(tf('errHistoryQtyExceedsAvailable', { name: item.name, available: maxAllowed }));
      return;
    }
  }

  showConfirmModal(tf('confirmChangeOrderItemQty', { name: item.name, from: item.qty, to: newQty, unit: item.unit }), async () => {
    const oldQty = item.qty;
    item.qty = newQty;
    if(!item.qtyHistory) item.qtyHistory = [];
    const changeAt = new Date().toISOString();
    item.qtyHistory.push({ from: oldQty, to: newQty, at: changeAt });
    if(orderStatus(order) === 'processing'){
      if(!order.postVerifyChanges) order.postVerifyChanges = [];
      order.postVerifyChanges.push({ kind: 'qty', productId: item.productId, name: item.name, sku: item.sku, unit: item.unit, from: oldQty, to: newQty, at: changeAt });
    }
    editingOrderItemKey = null;
    try{ await upsertOrders([order]); }
    catch(e){
      item.qty = oldQty;
      item.qtyHistory.pop();
      if(orderStatus(order) === 'processing' && order.postVerifyChanges) order.postVerifyChanges.pop();
      console.error('儲存待處理訂單數量失敗', e);
      showInfoModal('⚠ 操作失敗,請重新整理頁面再試一次。');
      refreshOrderLists();
      return;
    }
    logInventoryAction('order_edit', `Pending order ${order.orderNo || orderId} - quantity adjusted: ${item.name} ${oldQty}→${newQty} ${item.unit} (not yet stocked out)`, order.orderNo);
    renderAll();
  });
}

// 「核對」:待處理訂單真正變成已完成訂單的唯一入口。走 verify_order 這個 Postgres function
// (SECURITY DEFINER,一次 DB transaction 內完成,見 verify_order_migration.sql):針對這張訂單
// 裡每個還沒被刪除的品項,先「鎖住該商品的庫存快取列 → 檢查夠不夠 → 扣除」,只要其中一項不夠,
// 整個核對動作全部回滾、不會扣到一半;全部都夠的話才真的扣庫存,並幫每個品項各寫入一筆出貨紀錄,
// 同時把訂單狀態改成 'confirmed'。之後這張訂單就會從「待處理訂單」移到「已完成訂單」清單。
// 核對要檢查/比對什麼(例如跟店家確認實際還有沒有貨)這類更細的業務邏輯,之後可以再擴充。
async function verifyOrder(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order || !isPreVerificationStatus(order) || order.deleted) return;
  const activeItems = order.items.filter(it => !it.deleted);
  if(activeItems.length === 0){
    showInfoModal(t('errVerifyNoActiveItems'));
    return;
  }
  showConfirmModal(tf('confirmVerifyOrder', {orderNo: order.orderNo || orderId, n: activeItems.length}), async () => {
    // 扣庫存之前,先問清楚每個商品要從哪個位置扣——如果列印撿貨單的時候已經問過(order.pickedLocationAllocations)
    // 而且那個答案現在還有效,直接沿用不用再問一次;只有沒問過、或答案已經失效(例如位置被轉走了)
    // 的商品才會真的跳出視窗問。中途按取消的話這裡會 throw,整個核對直接中止,不會扣庫存、
    // 也不會動任何位置資料。
    let locationChoices;
    try{
      locationChoices = await resolveLocationChoicesForItemsWithPreset(
        activeItems.map(it => ({ productId: it.productId, qty: it.qty })),
        order.pickedLocationAllocations
      );
    } catch(e){
      return; // 使用者在選位置的過程中按了取消,整個核對中止
    }

    const rpcItems = activeItems.map(it => ({ productId: it.productId, qty: it.qty, txId: genId() }));
    const noteText = `${order.orderNo || ''}${order.note ? '、' + order.note : ''}`;
    const confirmedAt = new Date().toISOString();
    const updatedPayload = { ...order, status: 'confirmed', confirmedAt };

    const { error } = await sb.rpc('verify_order', {
      p_order_id: orderId,
      p_items: rpcItems,
      p_order_payload: updatedPayload,
      p_date: order.date,
      p_party_name: order.partyName,
      p_note: noteText
    });

    if(error){
      const failures = parseInsufficientStockError(error);
      if(failures){
        const lines = failures.map(f => {
          const p = products.find(x => x.id === f.productId);
          const name = p ? p.name : f.productId;
          return tf('orderStockChangedLine', { name, requested: f.requested, available: f.available });
        });
        showInfoModal(`⚠ ${t('orderStockChangedIntro')} ${lines.join('; ')}`);
      } else {
        console.error('verify_order failed', error);
        showInfoModal('⚠ 核對失敗,伺服器拒絕了這個動作(可能是資料庫還沒建立 verify_order 這個 function,或帳號權限限制),請確認 verify_order_migration.sql 已經在 Supabase 執行過,或重新整理頁面再試一次。');
      }
      return;
    }

    rpcItems.forEach(it => {
      const tx = { id: it.txId, productId: it.productId, type: 'out', qty: it.qty, date: order.date, party: order.partyName, note: noteText, system: true, orderId };
      transactions.push(tx);
      productStockMap[it.productId] = (productStockMap[it.productId] || 0) - it.qty;
    });
    order.status = 'confirmed';
    order.confirmedAt = confirmedAt;
    expandedOrderIds.delete(orderId);
    // 伺服器那邊的總庫存已經確定扣成功了,這裡才去動 product_locations——如果先扣位置、
    // RPC 才失敗,位置資料會跟實際庫存對不起來。
    await applyLocationDeductions(locationChoices);
    logInventoryAction('order_verify', `Verified order ${order.orderNo || orderId} (${order.partyName || 'No recipient specified'}, ${activeItems.length} item(s)), stock deducted`, order.orderNo);
    renderAll();
  });
}

// ===== 「倉庫作業台 → 訂單核對」頁面 =====
// 左欄是目前載入的那張待處理訂單(跟「訂貨後台管理 → 待處理訂單」共用同一套品項顯示/修改/刪除
// 邏輯 orderItemRowHtml + savePendingOrderItemQty + deletePendingOrderItem,異動會直接寫回那張
// 訂單本身)。右欄是使用者自己在這個頁面上另外登記的「實際點貨」清單(只存在畫面上,按「核對」
// 之前不會動到任何資料)。按「核對」時比對兩邊的品項/數量是否完全一致,一致才會呼叫既有的
// verifyOrder()(atomic 扣庫存 + 核對通過)。
let verifyPageOrderId = null;
let verifyPageRightItems = []; // [{ productId, sku, name, unit, qty }]

// 把載入進來的訂單狀態同步到「選擇待處理訂單」下拉選單。
function populateVerifyPageOrderSelect(){
  const sel = document.getElementById('verifyPageOrderSelect');
  if(!sel) return;
  const pending = orders.filter(o => isPreVerificationStatus(o) && !o.deleted)
    .sort((a,b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));
  sel.innerHTML = `<option value="">${t('optSelectPendingOrder')}</option>` +
    pending.map(o => `<option value="${o.id}">${(o.orderNo || o.id).replace(/"/g,'&quot;')}${o.partyName ? ' · ' + o.partyName.replace(/"/g,'&quot;') : ''}</option>`).join('');
  if(verifyPageOrderId && pending.some(o => o.id === verifyPageOrderId)) sel.value = verifyPageOrderId;
  else sel.value = '';
}

// 下拉選單自己選一張待處理訂單(跟從「待處理訂單」清單點「載入訂單核對頁面」進來是同一個效果)。
function loadOrderIntoVerifyPage(orderId){
  verifyPageOrderId = orderId || null;
  verifyPageRightItems = [];
  const msg = document.getElementById('verifyPageMsg');
  if(msg){ msg.className = 'msg'; msg.textContent = ''; }
  const browseAllEl = document.getElementById('verifyPageBrowseAllProducts');
  if(browseAllEl) browseAllEl.checked = false; // 每次重新選訂單,「瀏覽所有商品」重設回預設(不勾選)
  renderVerifyPage();
  renderVerifyPageProductSelect();
}

// 從「訂貨後台管理 → 待處理訂單」點「載入訂單核對頁面」進來的入口:切到庫存管理分頁的
// 「訂單核對」子分頁,並直接載入這張訂單。
function openOrderInVerifyPage(orderId){
  verifyPageOrderId = orderId;
  verifyPageRightItems = [];
  const browseAllEl = document.getElementById('verifyPageBrowseAllProducts');
  if(browseAllEl) browseAllEl.checked = false;
  switchTab('tab-warehouse-ops');
  switchWarehouseOpsSubTab('subtab-tx-verify');
}

function renderVerifyPage(){
  populateVerifyPageOrderSelect();
  const directVerifyBtn = document.getElementById('btnDirectVerifyOnVerifyPage');
  if(directVerifyBtn) directVerifyBtn.style.display = disableDirectVerifyEnabled ? 'none' : '';
  const infoEl = document.getElementById('verifyPageOrderInfo');
  const itemsEl = document.getElementById('verifyPageOrderItems');
  if(!infoEl || !itemsEl) return;

  // 載入的訂單如果已經不是「待處理」了(例如核對成功、變成已完成訂單),表示這頁的任務已經結束,
  // 自動清空狀態、回到「請選擇訂單」的畫面,不繼續顯示一張已經核對過的舊訂單。
  const order = verifyPageOrderId ? orders.find(o => o.id === verifyPageOrderId) : null;
  if(order && (!isPreVerificationStatus(order) || order.deleted)){
    verifyPageOrderId = null;
    verifyPageRightItems = [];
  }
  const activeOrder = verifyPageOrderId ? orders.find(o => o.id === verifyPageOrderId) : null;

  if(!activeOrder){
    infoEl.innerHTML = '';
    itemsEl.innerHTML = `<div class="empty-note">${t('noOrderLoadedForVerify')}</div>`;
  } else {
    infoEl.innerHTML = `${activeOrder.orderNo ? `<b>${activeOrder.orderNo}</b> · ` : ''}${activeOrder.date}${activeOrder.partyName ? ` · ${tf('orderCardPartyLabel', {name: activeOrder.partyName})}` : ''}${activeOrder.note ? `<br/>${t('noteLabelPrefix')}${activeOrder.note}` : ''}`;
    itemsEl.innerHTML = activeOrder.items.map(it => orderItemRowHtml(activeOrder, it, true, false, 'verify')).join('') || `<div class="empty-note">${t('orderHistoryNoItemsLeft')}</div>`;
  }

  renderVerifyPageRightItems();
}

function renderVerifyPageRightItems(){
  const container = document.getElementById('verifyPageRightItems');
  if(!container) return;
  if(verifyPageRightItems.length === 0){
    container.innerHTML = `<div class="empty-note">${t('verifyPageNoItemsAdded')}</div>`;
    return;
  }
  container.innerHTML = verifyPageRightItems.map((it, idx) => `
    <div>
      <span>${it.sku ? `<span class="sku-badge">${it.sku}</span>` : ''}${it.name}</span>
      <span>${it.qty} ${it.unit}
        <span class="del-link" style="margin-left:8px;" onclick="openConversionFromVerifyPage('${it.productId}')" title="${t('btnConvertBatchItem')}">🔄</span>
        <span class="del-link" style="margin-left:8px;color:var(--crit);" onclick="removeVerifyPageItem(${idx})">${t('btnDelete')}</span>
      </span>
    </div>
  `).join('');
}

// 右欄「新增商品」的分類/商品下拉選單,照 SKU 排序(跟訂貨頁面一致),方便點貨時照 SKU 順序找。
function renderVerifyPageProductSelect(){
  const catSel = document.getElementById('verifyPageCategoryFilter');
  const sel = document.getElementById('verifyPageProductSelect');
  if(!catSel || !sel) return;
  syncCategoryOrder();
  const usedCats = categoryOrder.filter(c => products.some(p => (p.category || '未分類') === c));
  const prevCat = catSel.value;
  catSel.innerHTML = `<option value="">${t('catFilterAll')}</option>` +
    usedCats.map(c => `<option value="${c.replace(/"/g,'&quot;')}">${catLabel(c)}</option>`).join('');
  if(usedCats.includes(prevCat)) catSel.value = prevCat;
  const catFilterVal = catSel.value;

  const prevProd = sel.value;
  let filtered = catFilterVal ? products.filter(p => (p.category || '未分類') === catFilterVal) : products;

  // 跟登記進出貨的「載入現有訂單」新增商品同一套邏輯:預設只顯示這張訂單的出貨方訂貨時
  // 實際看得到的商品,勾選「瀏覽所有商品」才放寬成庫存總覽裡的全部商品(全域隱藏的還是不顯示)。
  const browseAllEl = document.getElementById('verifyPageBrowseAllProducts');
  const browseAll = !!(browseAllEl && browseAllEl.checked);
  if(browseAll){
    filtered = filtered.filter(p => !p.hidden);
  } else {
    const order = verifyPageOrderId ? orders.find(o => o.id === verifyPageOrderId) : null;
    const partyObj = order ? shippingParties.find(sp => sp.id === order.partyId) : null;
    const hiddenForParty = partyObj && Array.isArray(partyObj.hiddenProductIds) ? partyObj.hiddenProductIds : [];
    filtered = filtered.filter(p => p.orderable && !p.hidden && !hiddenForParty.includes(p.id));
  }

  filtered = filtered.slice().sort(compareProductsBySortMode);
  sel.innerHTML = '<option value=""></option>' + filtered.map(p => `<option value="${p.id}">${p.sku ? p.sku + ' — ' : ''}${p.parentId ? '⧉ ' : ''}${p.name}(${p.unit})</option>`).join('');
  if(filtered.some(p => p.id === prevProd)) sel.value = prevProd;
  makeSelectSearchable('verifyPageProductSelect');
}

function addVerifyPageItem(){
  const sel = document.getElementById('verifyPageProductSelect');
  const qtyInput = document.getElementById('verifyPageQtyInput');
  const msg = document.getElementById('verifyPageMsg');
  if(!sel || !sel.value){ msg.className = 'msg error'; msg.textContent = t('errSelectProductFirst'); return; }
  const qty = parseFloat(qtyInput.value);
  if(isNaN(qty) || qty <= 0){ msg.className = 'msg error'; msg.textContent = t('errEnterPositiveQty'); return; }
  const p = products.find(x => x.id === sel.value);
  if(!p) return;
  const existing = verifyPageRightItems.find(it => it.productId === p.id);
  if(existing) existing.qty += qty;
  else verifyPageRightItems.push({ productId: p.id, sku: p.sku || '', name: p.name, unit: p.unit, qty });
  qtyInput.value = '';
  resetSearchableSelect('verifyPageProductSelect');
  msg.className = 'msg'; msg.textContent = '';
  renderVerifyPageRightItems();
}

function removeVerifyPageItem(idx){
  verifyPageRightItems.splice(idx, 1);
  renderVerifyPageRightItems();
}

// 核對:比對左欄(待處理訂單裡目前還有效的品項)跟右欄(手動登記的實際點貨清單)品項/數量是否
// 完全一致。一致才會呼叫既有的 verifyOrder()(atomic 扣庫存);不一致的話列出所有對不上的品項,
// 不會扣庫存,讓使用者回去修正其中一邊再核對一次。
// 訂單核對頁面的「直接核對」:不用比對左右兩邊的品項,直接用訂單自己現有的品項核對確認扣庫存
// (沿用 verifyOrder() 既有邏輯)。如果啟用了「取消直接核對功能」這個系統設置,這裡也要擋下來。
async function directVerifyFromVerifyPage(){
  const msg = document.getElementById('verifyPageMsg');
  if(disableDirectVerifyEnabled){
    msg.className = 'msg error';
    msg.textContent = t('errDirectVerifyDisabled');
    return;
  }
  const order = verifyPageOrderId ? orders.find(o => o.id === verifyPageOrderId) : null;
  if(!order || !isPreVerificationStatus(order) || order.deleted){
    msg.className = 'msg error';
    msg.textContent = t('errSelectPendingOrderFirst');
    return;
  }
  await verifyOrder(order.id);
}

function runOrderVerification(){
  const msg = document.getElementById('verifyPageMsg');
  const order = verifyPageOrderId ? orders.find(o => o.id === verifyPageOrderId) : null;
  if(!order || !isPreVerificationStatus(order) || order.deleted){
    msg.className = 'msg error';
    msg.textContent = t('errSelectPendingOrderFirst');
    return;
  }

  const leftItems = order.items.filter(it => !it.deleted);
  if(leftItems.length === 0){
    msg.className = 'msg error';
    msg.textContent = t('errVerifyNoActiveItems');
    return;
  }
  const leftMap = new Map(leftItems.map(it => [it.productId, it.qty]));
  const rightMap = new Map(verifyPageRightItems.map(it => [it.productId, it.qty]));

  const mismatches = [];
  leftMap.forEach((qty, pid) => {
    const p = products.find(x => x.id === pid);
    const name = p ? p.name : pid;
    if(!rightMap.has(pid)){
      mismatches.push(tf('verifyMismatchMissingOnRight', { name, qty }));
    } else if(Math.abs(rightMap.get(pid) - qty) > 0.001){
      mismatches.push(tf('verifyMismatchQtyDiffers', { name, orderQty: qty, addedQty: rightMap.get(pid) }));
    }
  });
  rightMap.forEach((qty, pid) => {
    if(!leftMap.has(pid)){
      const p = products.find(x => x.id === pid);
      const name = p ? p.name : pid;
      mismatches.push(tf('verifyMismatchExtraOnRight', { name, qty }));
    }
  });

  if(mismatches.length > 0){
    msg.className = 'msg error';
    msg.textContent = `⚠ ${t('verifyMismatchIntro')} ${mismatches.join('; ')}`;
    return;
  }

  msg.className = 'msg';
  msg.textContent = '';
  verifyOrder(order.id);
}


// 把 ISO 時間字串格式化成「YYYY-MM-DD HH:mm」,「訂購記錄」清單日期要精確到分鐘,
// 用 createdAt(送出訂貨的當下)而不是 date(訂貨單上填的日期,可能是任選的日期,不含時間)。
function formatOrderDateTime(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 「訂貨」分頁底下「訂購記錄」子分頁:品項的修改/刪除現在直接共用「訂貨後台管理 → 待處理訂單」
// 那套 orderItemRowHtml + savePendingOrderItemQty/deletePendingOrderItem(isPending=true),
// 會寫 qtyHistory、軟刪除品項,不再需要自己另外一套整批草稿編輯狀態——這樣同一張訂單不管在
// 訂購記錄還是待處理訂單改,兩邊都會馬上看到彼此的異動紀錄。
// 「訂購記錄」正在幫某張待處理訂單「新增商品」時,暫存要新增進去的是哪一張訂單(orderId)。
// 設定這個之後,使用者會被導去「訂貨」頁面正常挑商品、進購物車確認,但按下「提交訂單」時
// 不會建立一張新訂單,而是把選好的品項併進這張訂單裡(見 confirmOrderFromCart 裡的分流)。
let addingItemsToOrderId = null;

// 這張訂單目前是不是正被載入在「倉庫作業台 → 訂單核對」頁面(verifyPageOrderId)——如果是,
// 「訂購記錄」這邊不管是舊的「修改」(改數量/移除品項)還是新的「新增商品」都不能再動這張訂單,
// 避免使用者這邊改到一半,跟正在核對的內容對不起來。跳出警示、不執行任何動作。
function warnIfOrderBeingProcessed(orderId){
  if(verifyPageOrderId === orderId){
    showInfoModal(t('errOrderBeingProcessed'));
    return true;
  }
  return false;
}

// 這個帳號能在「訂購記錄」看到哪些訂單:如果帳號有限定出貨方(assignedPartyIds 非空),
// 只顯示那幾家出貨方的訂單(不管訂單是誰下的、誰匯入的都算——因為可能是店裡的另一個人下單,
// 但要換這個人來簽收,只要同屬一家出貨方,訂單就該看得到);沒有限定的話(例如管理者)顯示全部。
// 有些訂單(例如 Excel 匯入出貨單、比對不到現有出貨方名稱時)partyId 可能是 null,只存了
// partyName 文字,這種情況改用出貨方「名稱」比對,一樣算進看得到的範圍,不用等資料庫補資料。
function ordersVisibleToCurrentUser(){
  const restrictedIds = (currentUser && Array.isArray(currentUser.assignedPartyIds) && currentUser.assignedPartyIds.length > 0)
    ? currentUser.assignedPartyIds : null;
  if(!restrictedIds) return orders.slice();
  const restrictedNames = restrictedIds
    .map(id => { const sp = shippingParties.find(x => x.id === id); return sp ? sp.name.trim().toLowerCase() : null; })
    .filter(Boolean);
  return orders.filter(o => {
    if(o.partyId) return restrictedIds.includes(o.partyId);
    if(o.partyName) return restrictedNames.includes(o.partyName.trim().toLowerCase());
    return false;
  });
}

function renderOrderHistory(){
  const container = document.getElementById('orderHistoryList');
  if(!container) return;

  const list = ordersVisibleToCurrentUser()
    .sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));

  if(list.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noOrderHistory')}</div>`;
    return;
  }

  container.innerHTML = list.map(o => {
    const isExpanded = expandedOrderIds.has(o.id);
    const status = orderStatus(o);
    // 可以修改的條件:訂單還是「待處理」(還沒核對、還沒進已完成訂單)、訂單本身沒被取消、也還沒
    // 簽收、而且沒有正被載入到「倉庫作業台 → 訂單核對」頁面——這個「正在核對中不能改」的限制只套用
    // 在訂購記錄這邊(顧客自助修改),訂貨後台管理那邊不受這個限制,員工在待處理訂單清單一樣可以
    // 隨時改(不管有沒有人正在核對頁面看這張訂單)。
    const editable = !o.deleted && status === 'pending' && !o.signedAt && verifyPageOrderId !== o.id;
    // 可以簽收的條件:訂單已經核對過、真的出貨了(狀態 'confirmed'),還沒被刪除、也還沒簽收過。
    // 還沒核對的訂單理論上貨都還沒出,簽收沒有意義,所以待處理訂單先不給簽收。
    const signable = !o.deleted && status === 'confirmed' && !o.signedAt;

    // 品項的顯示/修改/刪除跟「訂貨後台管理 → 待處理訂單」共用同一個 orderItemRowHtml,直接呼叫
    // savePendingOrderItemQty/deletePendingOrderItem——這樣訂單還是「待處理」的時候,不管在訂購
    // 記錄還是待處理訂單改,數量變更紀錄(qtyHistory)跟軟刪除標記都是寫在同一份 order.items 上,
    // 兩邊都會立刻看到彼此的異動。但訂購記錄這邊只有訂單還是「待處理」時才能改——一旦核對變成
    // 「已完成」,就只能在「訂貨後台管理 → 已完成訂單」那邊改(簽收前),訂購記錄這裡改成唯讀
    // (readOnly=!editable),避免顧客自己把已經出貨、已經扣過庫存的訂單內容改掉。
    const itemsHtml = o.items.map(it => orderItemRowHtml(o, it, status === 'pending', !editable, 'history')).join('')
      || `<div class="empty-note">${t('orderHistoryNoItemsLeft')}</div>`;
    const addProductLinkHtml = (editable && isExpanded)
      ? `<div style="margin-top:8px;"><span class="del-link" onclick="goAddProductsToOrder('${o.id}')">${t('btnAddProductToOrder')}</span></div>`
      : '';

    const statusLabel = o.deleted
      ? t('statusOrderCancelled')
      : (status === 'confirmed' ? t('statusCompleted') : (status === 'processing' ? t('statusProcessing') : t('statusPending')));
    const statusClass = o.deleted ? 'deleted' : (status === 'confirmed' ? 'confirmed' : (status === 'processing' ? 'processing' : 'pending'));
    const signedBadge = o.signedAt ? `<span title="${tf('orderSignedAtTitle', {datetime: formatOrderDateTime(o.signedAt)})}" style="margin-left:6px;color:var(--safe);">✔ ${t('statusSigned')}</span>` : '';

    return `
      <div class="order-card ${o.deleted ? 'order-card-deleted' : ''}">
        <div class="order-card-head" style="cursor:pointer;" onclick="toggleOrderExpand('${o.id}')">
          <span class="order-card-date">
            <span style="display:inline-block;width:14px;">${isExpanded ? '▾' : '▸'}</span>
            ${o.orderNo ? `<span style="color:var(--ink-soft);font-weight:400;">${o.orderNo}</span> · ` : ''}${formatOrderDateTime(o.createdAt) || o.date}${o.partyName ? ` <span style="font-weight:400;color:var(--ink-soft);">· ${tf('orderCardPartyLabel', {name: o.partyName})}</span>` : ''}
          </span>
          <span>
            <span class="order-status-pill ${statusClass}">${statusLabel}</span>${signedBadge}
          </span>
        </div>
        ${isExpanded ? `
          ${o.note ? `<div style="font-size:12px;color:var(--ink-soft);margin:8px 0 6px;">${t('noteLabelPrefix')}${o.note}</div>` : ''}
          <div style="font-size:12px;color:var(--ink-soft);margin:0 0 6px;">
            ${t('deliveryDateLabel')}
            ${editable
              ? `<input type="date" value="${o.date || ''}" onchange="confirmUpdateOrderDeliveryDate('${o.id}', this)" style="margin-left:6px;" />`
              : `<span style="color:var(--ink);">${o.date || ''}</span>`}
          </div>
          <div class="order-items">${itemsHtml}</div>
          ${addProductLinkHtml}
          ${signable ? `<div class="order-card-actions"><button class="btn" onclick="signOrderHistory('${o.id}')">${t('btnSignReceipt')}</button></div>` : ''}
        ` : ''}
      </div>
    `;
  }).join('');
}

// 「訂購記錄」編輯畫面裡的「新增商品」:離開這個編輯畫面,改導去「訂貨」頁面讓使用者正常挑
// 商品、進購物車確認——但按下「提交訂單」時不會另外建一張新訂單,而是把選的品項併進這張
// 既有的待處理訂單裡(見 confirmOrderFromCart 裡的分流,還有底下 mergeItemsIntoExistingOrder)。
// 出貨方直接鎖定成這張訂單原本的出貨方,不能在這裡改,避免併回去的時候對象兜不起來。
// 訂購記錄裡改送貨日期:只有訂單還可以改的時候(editable,見 renderOrderHistory 的判斷條件)
// 才會顯示這個輸入框。改了之後先跳出確認視窗,列出原本日期跟新日期,按確定才會真的存;
// 按取消的話,把輸入框的值改回原本的日期,不留下「畫面上看起來已經改了,但其實沒存」的狀態。
function confirmUpdateOrderDeliveryDate(orderId, inputEl){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const oldDate = order.date;
  const newDate = inputEl.value;
  if(!newDate || newDate === oldDate) return;
  const msg = tf('confirmChangeDeliveryDateMsg', { old: oldDate, new: newDate });
  showConfirmModal(
    msg,
    () => updateOrderDeliveryDate(orderId, newDate),
    () => { inputEl.value = oldDate; }
  );
}

async function updateOrderDeliveryDate(orderId, newDate){
  if(!newDate) return;
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  const oldDate = order.date;
  if(oldDate === newDate) return;
  // 只在「第一次」改日期的時候記下最原始的日期,之後不管再改幾次,originalDate 都維持指向
  // 最初訂單建立時的那個日期——這樣待處理訂單那邊才能一直清楚顯示「這張單原本訂的是哪一天」,
  // 不會因為改第二次、第三次就把上一次記錄的原始日期覆蓋掉。
  if(order.originalDate === undefined || order.originalDate === null){
    order.originalDate = oldDate;
  }
  order.date = newDate;
  try{
    await upsertOrders([order]);
    logInventoryAction('order_edit', `Order ${order.orderNo || order.id} delivery date changed: ${oldDate} → ${newDate}`, order.orderNo);
  } catch(e){
    console.error('更新送貨日期失敗', e);
    order.date = oldDate; // 存失敗就退回原本的日期,不留下跟資料庫不一致的畫面
    showInfoModal('⚠ 更新送貨日期失敗,請重新整理頁面再試一次。');
    return;
  }
  renderOrderHistory();
  renderPendingOrders();
}

function goAddProductsToOrder(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted || !isPreVerificationStatus(order) || order.signedAt) return;
  if(warnIfOrderBeingProcessed(orderId)) return;

  addingItemsToOrderId = orderId;
  orderQtyDraft = {};
  orderItemNoteDraft = {};

  switchTab('tab-order');
  switchOrderSubTab('subtab-order-place');

  const partySelect = document.getElementById('orderParty');
  if(partySelect){
    partySelect.value = order.partyId || '';
    partySelect.disabled = true;
  }
  const banner = document.getElementById('addToOrderBanner');
  if(banner){
    banner.style.display = '';
    const label = document.getElementById('addToOrderBannerLabel');
    if(label) label.textContent = tf('addToOrderBannerText', { orderNo: order.orderNo || orderId });
  }
  renderOrderItemsTable();
}

// 離開「幫既有訂單新增商品」模式(取消,或流程結束後):把出貨方選單解鎖、隱藏提示橫幅、
// 清掉暫存狀態跟這次挑的草稿數量,恢復成一般的訂貨頁面。
function cancelAddItemsToOrder(){
  addingItemsToOrderId = null;
  orderQtyDraft = {};
  orderItemNoteDraft = {};
  const partySelect = document.getElementById('orderParty');
  if(partySelect) partySelect.disabled = false;
  const banner = document.getElementById('addToOrderBanner');
  if(banner) banner.style.display = 'none';
  renderOrderItemsTable();
}

// 「訂貨後台管理」的「新增商品」統一走這裡,改導去「倉庫作業台 → 登記進出貨」,不再導去「訂貨」
// 分頁——因為倉庫管理員這個身分預設就沒有「訂貨」分頁的權限(那是給下單的客人/內勤用的),但
// 「登記進出貨」他們本來就熟悉,也支援掃碼槍找商品,對倉庫管理員來說更順手。
// mode='pending':併進待處理訂單的草稿,不會扣庫存(等訂單之後核對才會真的扣)。
// mode='completed':併進已完成訂單,送出當下就會真的扣/加庫存(用登記進出貨原本的「出貨/入庫」
// 類型選擇決定方向,不需要額外的正負號規則)。已簽收的訂單兩種模式都不能用。
// 訂貨後台管理清單上的「編輯」統一走這裡:直接跳去「登記進出貨」,自動選好「出貨」類型跟
// 對應的出貨類型(待處理訂單→load-pending,已完成訂單→load-completed),並直接把這張訂單
// 載入進去(不用使用者自己再從下拉選單選一次)。已簽收的訂單不能編輯。
function editOrderViaRegister(orderId, mode){
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted || order.signedAt) return;
  if(mode === 'pending'){
    if(!isPreVerificationStatus(order)) return;
    if(warnIfOrderBeingProcessed(orderId)) return;
  } else if(mode === 'completed'){
    if(orderStatus(order) !== 'confirmed') return;
  } else {
    return;
  }

  switchTab('tab-warehouse-ops');
  switchWarehouseOpsSubTab('subtab-tx-register');
  setTxType('out');
  const flowSel = document.getElementById('txOutFlowType');
  if(flowSel) flowSel.value = mode === 'pending' ? 'load-pending' : 'load-completed';
  setTxOutFlowType(mode === 'pending' ? 'load-pending' : 'load-completed');
  const orderSel = document.getElementById('txOutFlowOrderSelect');
  if(orderSel) orderSel.value = orderId;
  loadOrderIntoRegisterFlow(orderId);
}

// 簽收:確認貨已經實際收到了。只有已經核對過、真的出貨的訂單(status='confirmed')才能簽收——
// 還沒核對的訂單理論上貨還沒出,簽收沒有意義。簽收之後這張訂單就不能再修改(見 editable 判斷)。
function signOrderHistory(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted || orderStatus(order) !== 'confirmed' || order.signedAt) return;
  showConfirmModal(tf('confirmSignOrder', { orderNo: order.orderNo || orderId }), async () => {
    const prevSignedAt = order.signedAt;
    const prevSignInfo = order.signInfo;
    order.signedAt = new Date().toISOString();
    order.signInfo = { type: 'customer', username: (currentUser && currentUser.username) || '' };
    try{
      await upsertOrders([order]);
    } catch(e){
      order.signedAt = prevSignedAt;
      order.signInfo = prevSignInfo;
      showInfoModal('⚠ 簽收失敗,請重新整理頁面再試一次。');
      return;
    }
    logInventoryAction('order_edit', `Order ${order.orderNo || orderId} - signed for receipt`, order.orderNo);
    renderAll();
  });
}


// 把一批訂單彙總成「依分類分組」的資料,供匯出訂貨單使用(共用給批次匯出跟單筆訂單匯出)。
function buildOrderAggregation(list){
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));
  // 「整個家族商品都不顯示」模式的主商品:把自己跟底下所有 multipack 子商品的 id 都收集起來,
  // 不管是主商品自己被訂、還是子商品被訂(不管有沒有經過切換),整個家族在匯出檔案裡完全不出現。
  const wholeFamilyHiddenIds = new Set();
  products.forEach(p => {
    if(!p.parentId && p.hideFromCompletedOrderExport && p.hideFromCompletedOrderExportMode === 'wholeFamily'){
      wholeFamilyHiddenIds.add(p.id);
      getChildProducts(p.id).forEach(c => wholeFamilyHiddenIds.add(c.id));
    }
  });
  const groups = {};
  function addToGroup(productId, qty, unit, name){
    if(!groups[productId]) groups[productId] = { productId, qty: 0, unit, name };
    groups[productId].qty += qty;
  }
  list.forEach(o => {
    o.items.filter(it => !it.deleted).forEach(it => {
      const p = productMap[it.productId];
      if(wholeFamilyHiddenIds.has(it.productId)) return; // 整個家族都不顯示:這個品項完全跳過
      // 這個商品如果設定了「已完成訂單匯出不顯示」(預設模式/「僅顯示切換的批量商品數量」),
      // 主商品本身完全不會出現在匯出裡——但如果在訂單核對時有把批量商品切換成這個主商品
      // (fulfilledViaSwitch),切換用掉的那些批量商品數量,改成算在批量商品自己的行裡顯示,
      // 不會整個消失看不到到底是怎麼出貨的。切換之外、這個品項本身沒被切換掉的剩餘數量,則完全
      // 不顯示(既不算在主商品身上、也沒有對應的批量商品可以歸類)。這個「借用切換數量」的行為
      // 只適用於主商品自己(子商品即使個別被設定不顯示,也不會有 fulfilledViaSwitch 這種東西)。
      if(p && p.hideFromCompletedOrderExport){
        if(!p.parentId){
          (it.fulfilledViaSwitch || []).forEach(sw => {
            if(wholeFamilyHiddenIds.has(sw.childId)) return;
            addToGroup(sw.childId, sw.childQty, sw.childUnit, sw.childName);
          });
        }
        return;
      }
      addToGroup(it.productId, it.qty, it.unit, it.name);
    });
  });
  const aggregated = Object.values(groups);

  const byCategory = {};
  aggregated.forEach(g => {
    const p = productMap[g.productId];
    const cat = p ? (p.category || '未分類') : '未分類';
    if(!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(g);
  });
  const catList = categoryOrder.filter(c => byCategory[c]);
  Object.keys(byCategory).forEach(c => { if(!catList.includes(c)) catList.push(c); });

  return { aggregated, byCategory, catList };
}

// 產生訂貨單的試算表內容:Customer/Period 放最上面,SKU 這次改成要顯示出來(不像出貨單模板那樣
// 隱藏)。清單放庫存總覽裡「全部」的商品(不是只放可訂貨、沒被全域隱藏的),包含沒有標記可訂貨
// (根本不會出現在訂貨頁面)、被全域隱藏的商品都算進來——這樣不同訂單匯出的檔案結構、商品順序
// 都會一致。這張訂單沒有數量的商品那一列用 Excel 的隱藏列處理掉,資料還在,只是預設不顯示、
// 也不會被印出來。
function buildOrderSheetAoa(list, partyLabel, dateLabel){
  const { aggregated, byCategory: orderByCategory } = buildOrderAggregation(list);
  const qtyByProductId = {};
  aggregated.forEach(g => { qtyByProductId[g.productId] = g; });

  const recordsOnly = completedExportFormat === 'recordsOnly';
  // recordsOnly:只放「真的有出貨紀錄」的商品,沒紀錄的完全不放進 aoa(連隱藏列都沒有)。
  // fullCatalog(預設,原本就有的行為):放庫存總覽全部可訂貨商品,沒紀錄的用隱藏列處理,
  // 順序照庫存總覽/商品排序設置排列。
  const allMain = recordsOnly
    ? products.filter(p => qtyByProductId[p.id])
    : products.slice();

  const byCat = {};
  allMain.forEach(p => {
    const cat = p.category || '未分類';
    (byCat[cat] = byCat[cat] || []).push(p);
  });
  const catList = categoryOrder.filter(c => byCat[c]);
  Object.keys(byCat).forEach(c => { if(!catList.includes(c)) catList.push(c); });

  const aoa = [];
  const hiddenRows = new Set(); // 0-based row indices into `aoa` that should be hidden in the final sheet
  const orderNos = list.map(o => o.orderNo).filter(Boolean);
  aoa.push(['Customer:', partyLabel, 'Orders:', orderNos.join(', ')]);
  aoa.push(['Period:', dateLabel]);
  aoa.push([]);
  aoa.push(['SKU','Product Name','Qty','Unit','Remarks']);

  let isFirstGroup = true;
  catList.forEach((cat) => {
    const items = byCat[cat];
    if(!items || items.length === 0) return;
    const groupAllHidden = items.every(p => !qtyByProductId[p.id]);

    // 分類跟分類之間的空白隔開列,跟著它後面緊接著的這個分類一起隱藏/一起顯示——這個分類如果
    // 整組都被隱藏,前面那條分隔空白列也要跟著隱藏,不然即使商品列都正確隱藏了,畫面上還是會看到
    // 一整排「只剩分隔空白列冒出來」的空行,看起來像是隔了一大段空白。用 isFirstGroup(不是
    // catList 的 index)判斷是不是第一組,因為 recordsOnly 模式下有些分類可能整組都被篩掉,
    // 用 index 會誤判「這不是第一個出現的分類」。
    if(!isFirstGroup){
      const sepRowIdx = aoa.length;
      aoa.push([]);
      if(groupAllHidden) hiddenRows.add(sepRowIdx);
    }
    isFirstGroup = false;

    const headerRowIdx = aoa.length;
    aoa.push([`-- ${catLabelEN(cat)} --`]);
    if(groupAllHidden) hiddenRows.add(headerRowIdx);

    items
      .sort(compareProductsBySortMode)
      .forEach(p => {
        const g = qtyByProductId[p.id];
        const rowIdx = aoa.length;
        aoa.push([p.sku || '', p.name, g ? g.qty : '', p.unit, '']);
        if(!g) hiddenRows.add(rowIdx);
      });
  });

  return { aoa, aggregated, hiddenRows };
}

function buildOrderSheetWorkbook(aoa, hiddenRows){
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{wch:14},{wch:28},{wch:8},{wch:8},{wch:16}];
  if(hiddenRows && hiddenRows.size > 0){
    const rowMeta = [];
    aoa.forEach((_, i) => { rowMeta[i] = hiddenRows.has(i) ? { hidden: true } : {}; });
    ws['!rows'] = rowMeta;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Order Sheet');
  return wb;
}
function downloadOrderSheetXlsx(aoa, filename, hiddenRows){
  const wb = buildOrderSheetWorkbook(aoa, hiddenRows);
  XLSX.writeFile(wb, filename);
}

function exportOrdersSheet(){
  const msg = document.getElementById('orderExportMsg');
  if(typeof XLSX === 'undefined'){ msg.className = 'msg error'; msg.textContent = 'Excel 套件載入失敗,請重新整理頁面再試一次'; return; }

  const partyFilter = document.getElementById('completedOrderPartyFilter').value;
  const dateFrom = document.getElementById('completedOrderDateFrom').value;
  const dateTo = document.getElementById('completedOrderDateTo').value;

  let list = orders.filter(o => orderStatus(o) === 'confirmed' && !o.deleted);
  if(partyFilter) list = list.filter(o => o.partyId === partyFilter);
  if(dateFrom) list = list.filter(o => o.date >= dateFrom);
  if(dateTo) list = list.filter(o => o.date <= dateTo);

  if(list.length === 0){
    msg.className = 'msg error';
    msg.textContent = '沒有符合目前篩選條件的訂單可以匯出';
    return;
  }

  const partyObj = partyFilter ? shippingParties.find(sp => sp.id === partyFilter) : null;
  const partyLabel = partyObj ? partyObj.name : 'All Customers';
  const dateLabel = dateFrom && dateTo
    ? (dateFrom === dateTo ? dateFrom : `${dateFrom} ~ ${dateTo}`)
    : (dateFrom ? `After ${dateFrom}` : (dateTo ? `Before ${dateTo}` : 'All dates'));

  const { aoa, aggregated, hiddenRows } = buildOrderSheetAoa(list, partyLabel, dateLabel);

  const label = partyObj ? (partyObj.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '') || 'Party') : 'AllParties';
  const rangeLabel = (dateFrom || dateTo) ? `_${dateFrom || 'start'}_${dateTo || 'end'}` : '';
  const filename = `order_sheet_${label}${rangeLabel}.xlsx`;
  downloadOrderSheetXlsx(aoa, filename, hiddenRows);

  msg.className = 'msg ok';
  msg.textContent = `✓ 已匯出 ${aggregated.length} 項彙總商品(來自 ${list.length} 張訂單):${filename}`;
}

// 匯出「單一一筆」訂單:Period 直接就是這張訂單自己的日期,不會混到其他訂單的日期範圍。
function exportSingleOrderSheet(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  if(typeof XLSX === 'undefined'){ showInfoModal('Excel 套件載入失敗,請重新整理頁面再試一次'); return; }

  const partyLabel = order.partyName || 'Unspecified';
  const dateLabel = order.date;
  const { aoa, hiddenRows } = buildOrderSheetAoa([order], partyLabel, dateLabel);

  const safeParty = (order.partyName || 'Order').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '') || 'Order';
  const noPart = order.orderNo ? `${order.orderNo.replace('#','')}_` : '';
  const filename = `order_sheet_${noPart}${safeParty}_${order.date}.xlsx`;
  downloadOrderSheetXlsx(aoa, filename, hiddenRows);
}
