// ============================================================
// 交易對象管理——出貨方(訂貨頁面的客戶對象,shippingParties)跟
// 進貨方(登記進出貨→進貨選的供應商,purchaseSuppliers)兩份名單,
// 概念上都是「管理一份交易對象」的簡單 CRUD 後台,合併放在一起。
// 另外也放了「倉庫後台管理→進貨預估」(Purchase Forecast)——這個
// 純粹試算用的功能,邏輯上跟出貨方的平均用量算法緊密相關,一併
// 放這裡。
//
// 出貨方管理:新增/編輯/刪除、每個出貨方可訂購商品的個別設定
// (隱藏特定商品、批次設定)。
// 進貨方管理:新增/編輯/刪除。
// ============================================================

// ===== 出貨方(供應商)管理 =====

function populatePartySelect(){
  const sel = document.getElementById('orderParty');
  if(sel){
    const prev = sel.value;
    const restrictedIds = (currentUser && Array.isArray(currentUser.assignedPartyIds)) ? currentUser.assignedPartyIds : [];
    if(restrictedIds.length > 0){
      // 這個帳號被限定只能訂特定一或多個廠商:下拉只給那幾個選項。
      const allowedParties = shippingParties.filter(sp => restrictedIds.includes(sp.id));
      sel.innerHTML = allowedParties.length
        ? allowedParties.map(sp => `<option value="${sp.id}">${sp.name.replace(/"/g,'&quot;')}</option>`).join('')
        : `<option value="">${t('optUnspecified')}</option>`;
      if(allowedParties.some(sp => sp.id === prev)){
        sel.value = prev;
      } else if(allowedParties.length > 0){
        sel.value = allowedParties[0].id;
      }
      // 只限定一家廠商時直接鎖住不能改;限定多家時讓使用者在這幾家裡面挑。
      sel.disabled = allowedParties.length === 1;
    } else {
      sel.disabled = false;
      sel.innerHTML = `<option value="">${t('optUnspecified')}</option>` +
        shippingParties.map(sp => `<option value="${sp.id}">${partyOptionLabel(sp).replace(/"/g,'&quot;')}</option>`).join('');
      if(shippingParties.some(sp => sp.id === prev)) sel.value = prev;
    }
    // 「幫既有訂單新增商品」模式中,不管上面跑哪個分支,出貨方一律鎖定成那張訂單本身的出貨方,
    // 不能被使用者、也不能被背景自動同步(silentBackgroundRefresh 也會呼叫到這裡)悄悄解鎖掉。
    if(addingItemsToOrderId){
      const targetOrder = orders.find(o => o.id === addingItemsToOrderId);
      if(targetOrder){
        sel.value = targetOrder.partyId || '';
        sel.disabled = true;
      }
    }
  }
  populateTxPartySelect();
  populateCompletedOrderPartyFilter();
  populatePendingOrderPartyFilter();
}

// ----- 編號(ID):出貨方 C001…、進貨方 S001…;建立後固定不變,名稱可以重複(用編號區分)-----
function nextEntityCode(prefix, list){
  let max = 0;
  const re = new RegExp('^' + prefix + '(\\d+)$');
  (list || []).forEach(x => { const m = re.exec(x.code || ''); if(m) max = Math.max(max, parseInt(m[1], 10)); });
  return prefix + String(max + 1).padStart(3, '0');
}
// 給還沒有編號的出貨方補編號(依名稱排序);有補回傳 true(呼叫端要存檔)
function ensurePartyCodes(){
  const todo = shippingParties.filter(sp => !sp.code).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  todo.forEach(sp => { sp.code = nextEntityCode('C', shippingParties); });
  return todo.length > 0;
}
// 給還沒有編號的進貨方補編號;回傳被補了編號的那幾筆(呼叫端要存檔)
function ensureSupplierCodes(){
  const todo = purchaseSuppliers.filter(s => !s.code).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  todo.forEach(s => { s.code = nextEntityCode('S', purchaseSuppliers); });
  return todo;
}
// 下拉選單的選項文字:名稱重複的才加上編號,不重複的維持原本只有名稱
function entityOptionLabel(entity, list){
  const name = entity.name || '';
  const dup = (list || []).some(x => x.id !== entity.id && (x.name || '').trim().toLowerCase() === name.trim().toLowerCase());
  return dup && entity.code ? `${name} (${entity.code})` : name;
}
function partyOptionLabel(sp){ return entityOptionLabel(sp, shippingParties); }
function supplierOptionLabel(s){ return entityOptionLabel(s, purchaseSuppliers); }

// ----- 出貨方:搜尋 + 獨立編輯視窗 -----
let partySearchQuery = '';
function onPartySearchInput(v){ partySearchQuery = v || ''; renderPartiesTable(); }

function partyDiscountOf(sp){
  const n = sp ? Number(sp.discount) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function openPartyEditModal(id){
  if(!hasCapability('cap-manage-parties')) return;
  const sp = id ? shippingParties.find(x => x.id === id) : null;
  if(id && !sp) return;
  editingPartyId = id || '__new__';
  document.getElementById('partyEditModalTitle').textContent = sp ? t('modalEditPartyTitle') : t('modalAddPartyTitle');
  document.getElementById('partyCodeText').textContent = sp ? (sp.code || '') : t('codeAutoAssigned');
  document.getElementById('partyNameInput').value = sp ? sp.name : '';
  document.getElementById('partyContactPersonInput').value = sp ? (sp.contactPerson || '') : '';
  // 舊資料的「聯絡方式」是一格自由文字(電話 / Line / Email),第一次開啟編輯時帶進「聯繫電話」,存檔後就改用新欄位
  document.getElementById('partyPhoneInput').value = sp ? (sp.phone !== undefined ? sp.phone : (sp.contact || '')) : '';
  document.getElementById('partyAddressInput').value = sp ? (sp.address || '') : '';
  document.getElementById('partyNoteInput').value = sp ? (sp.note || '') : '';
  document.getElementById('partyFrequencySelect').value = (sp && sp.orderFrequency) ? sp.orderFrequency : 'weekly';
  const d = partyDiscountOf(sp);
  document.getElementById('partyDiscountInput').value = d ? String(d) : '';
  document.getElementById('partyEditModalMsg').textContent = '';
  document.getElementById('partyEditModalMsg').className = 'msg';
  document.getElementById('partyEditModalOverlay').style.display = 'flex';
}
function closePartyEditModal(){
  editingPartyId = null;
  document.getElementById('partyEditModalOverlay').style.display = 'none';
}
async function savePartyEdit(){
  if(!hasCapability('cap-manage-parties')) return;
  const msg = document.getElementById('partyEditModalMsg');
  const isNew = editingPartyId === '__new__';
  const sp = isNew ? { id: genId(), hiddenProductIds: [] } : shippingParties.find(x => x.id === editingPartyId);
  if(!sp) return;
  const name = document.getElementById('partyNameInput').value.trim();
  if(!name){ msg.className = 'msg error'; msg.textContent = t('errPartyNameEmpty'); return; }
  const discRaw = document.getElementById('partyDiscountInput').value.trim();
  let discount = 0;
  if(discRaw !== ''){
    discount = Number(discRaw);
    if(!Number.isFinite(discount) || discount < 0 || discount > 100){ msg.className = 'msg error'; msg.textContent = t('errPartyDiscountInvalid'); return; }
  }
  const oldName = sp.name;
  sp.name = name;
  sp.contactPerson = document.getElementById('partyContactPersonInput').value.trim();
  sp.phone = document.getElementById('partyPhoneInput').value.trim();
  sp.address = document.getElementById('partyAddressInput').value.trim();
  sp.note = document.getElementById('partyNoteInput').value.trim();
  sp.orderFrequency = document.getElementById('partyFrequencySelect').value || 'weekly';
  sp.discount = discount;
  delete sp.contact;   // 舊的「聯絡方式」欄位已拆成 聯繫人 / 聯繫電話,內容在上面已帶進 phone
  if(isNew){ sp.code = nextEntityCode('C', shippingParties); shippingParties.push(sp); }
  editingPartyId = null;
  document.getElementById('partyEditModalOverlay').style.display = 'none';
  await saveShippingParties();
  renderPartiesTable();
  populatePartySelect();
  renderOrders(); // 已建立的訂單卡片上顯示的出貨方名稱也一併更新
  try{ if(typeof renderPendingOrders === 'function') renderPendingOrders(); }catch(e){}
  try{ if(typeof renderTxExistingItems === 'function') renderTxExistingItems(); if(typeof renderTxBatchList === 'function') renderTxBatchList(); }catch(e){}   // 折扣改了,登記進出貨頁的售價也立即更新
  const pm = document.getElementById('partyMsg');
  if(pm){ pm.className = 'msg ok'; pm.textContent = isNew ? tf('partyAddedMsg', { name }) : ''; }
}

// ----- 出貨方 → 其他畫面的捷徑 -----
function partyTabAllowed(tabId){
  const allowed = (typeof getCurrentUserTabPermissions === 'function') ? getCurrentUserTabPermissions() : [];
  if(allowed.includes(tabId)) return true;
  showInfoModal(t('errNoTabPermission'));
  return false;
}
// 「新增訂單」:跳到 倉庫作業台 → 登記進出貨 → 出貨 → 新增訂單,出貨方自動選好
function partyGoNewOrder(partyId){
  if(!partyTabAllowed('tab-warehouse-ops')) return;
  switchTab('tab-warehouse-ops');
  switchWarehouseOpsSubTab('subtab-tx-register');
  setTxType('out');
  const ps = document.getElementById('txPartySelect');
  if(ps) ps.value = partyId;
  const ft = document.getElementById('txOutFlowType');
  if(ft) ft.value = 'new-order';
  setTxOutFlowType('new-order');
  if(ps) ps.value = partyId;
}
// 「訂購紀錄」:跳到 歷史紀錄 → 已完成訂單,自動篩選這個出貨方
function partyGoOrderHistory(partyId){
  if(!partyTabAllowed('tab-log')) return;
  switchTab('tab-log');
  switchLogSubTab('subtab-log-completed');
  const f = document.getElementById('completedOrderPartyFilter');
  if(f) f.value = partyId;
  const from = document.getElementById('completedOrderDateFrom'), to = document.getElementById('completedOrderDateTo');
  if(from) from.value = ''; if(to) to.value = '';
  renderOrders();
}

function deleteParty(id){
  if(!hasCapability('cap-manage-parties')) return;
  const sp = shippingParties.find(x => x.id === id);
  if(!sp) return;
  const inUse = orders.some(o => o.partyId === id);
  const warnText = inUse
    ? `「${sp.name}」已經被用在某些訂單裡,刪除後那些訂單仍會保留原本記錄的出貨方名稱文字,但不會再連動。確定要刪除嗎?`
    : `確定要刪除出貨方「${sp.name}」嗎?`;
  showConfirmModal(warnText, async () => {
    shippingParties = shippingParties.filter(x => x.id !== id);
    await saveShippingParties();
    renderPartiesTable();
    populatePartySelect();
  });
}

function renderPartiesTable(){
  const container = document.getElementById('partiesTable');
  if(!container) return;
  if(shippingParties.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noPartiesYet')}</div>`;
    return;
  }
  const q = partySearchQuery.trim().toLowerCase();
  const list = q ? shippingParties.filter(sp => (sp.name || '').toLowerCase().includes(q) || (sp.code || '').toLowerCase().includes(q)) : shippingParties;
  if(list.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noPartiesMatchSearch')}</div>`;
    return;
  }
  const esc = escapeHtmlForPrint;
  const rows = list.map(sp => {
    return `
      <tr>
        <td class="row-code" style="white-space:nowrap;color:var(--ink-soft);font-family:'IBM Plex Mono',monospace;font-size:12px;">${esc(sp.code || '')}</td>
        <td class="row-name">${esc(sp.name)}</td>
        <td><span class="mini-label">${t('fieldPartyPhone')}</span>${esc(sp.phone !== undefined ? sp.phone : (sp.contact || '')) || '—'}</td>
        <td class="row-note"><span class="mini-label">${t('colNote')}</span>${esc(sp.note || '') || '—'}</td>
        <td><span class="mini-label">${t('colOrderFrequency')}</span>${t(sp.orderFrequency === 'fortnight' ? 'freqFortnight' : (sp.orderFrequency === 'monthly' ? 'freqMonthly' : 'freqWeekly'))}</td>
        <td class="row-action" style="white-space:nowrap;text-align:right;">
          <span class="del-link" onclick="partyGoNewOrder('${sp.id}')" style="margin-right:6px;">${t('btnPartyNewOrder')}</span>
          <span class="del-link" onclick="partyGoOrderHistory('${sp.id}')" style="margin-right:6px;">${t('btnPartyOrderHistory')}</span>
          <span class="del-link" onclick="openPartyEditModal('${sp.id}')" style="margin-right:6px;">${t('btnEdit')}</span>
          <span class="del-link" onclick="togglePartyProductPanel('${sp.id}')" style="margin-right:6px;">${openPartyProductPanelId === sp.id ? t('btnCollapseProductList') : t('btnSetOrderableProducts')}</span>
          <button onclick="deleteParty('${sp.id}')" title="${t('deletePartyTitle')}">✕</button>
        </td>
      </tr>
      ${openPartyProductPanelId === sp.id ? `<tr><td colspan="6">${renderPartyProductPanelHtml(sp)}</td></tr>` : ''}
    `;
  }).join('');
  container.innerHTML = `
    <table class="stock-table">
      <thead><tr><th>${t('colCode')}</th><th>${t('fieldPartyName')}</th><th>${t('fieldPartyPhone')}</th><th>${t('colNote')}</th><th>${t('colOrderFrequency')}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  if(openPartyProductPanelId){ filterPartyProductRows(openPartyProductPanelId); }
}

// 這個出貨方在「訂貨」分頁預設可以看到所有標記為可訂貨、且沒被全域隱藏的商品;
// 這裡讓你針對這個出貨方再個別隱藏特定商品(例如某些品項只給特定對象訂購)。
function renderPartyProductPanelHtml(party){
  const candidates = products.filter(p => p.orderable && !p.hidden).sort(compareProductsBySortMode);
  if(candidates.length === 0){
    return `<div class="empty-note" style="margin:10px 0;">${t('noOrderableProductsForPanel')}</div>`;
  }
  const hiddenSet = new Set(Array.isArray(party.hiddenProductIds) ? party.hiddenProductIds : []);
  const usedCats = categoryOrder.filter(c => candidates.some(p => (p.category || '未分類') === c));

  const rows = candidates.map(p => {
    const isHiddenForParty = hiddenSet.has(p.id);
    const cat = p.category || '未分類';
    const searchKey = `${p.name} ${p.sku || ''}`.toLowerCase().replace(/"/g,'&quot;');
    return `
      <tr class="party-product-row ${isHiddenForParty ? 'hidden-product-row' : ''}" data-search="${searchKey}" data-category="${cat.replace(/"/g,'&quot;')}">
        <td style="width:30px;"><input type="checkbox" onchange="togglePartyProductBulkSelect('${p.id}', this.checked)" ${partyProductBulkSelected.has(p.id) ? 'checked' : ''} /></td>
        <td class="row-name">${p.sku ? `<span class="sku-badge">${p.sku}</span>` : ''}${p.name}${isHiddenForParty ? `<span class="hidden-badge">${t('hiddenForPartyBadge')}</span>` : ''}</td>
        <td>${catLabel(cat)}</td>
        <td class="row-action" style="white-space:nowrap;"><span class="del-link" onclick="togglePartyProductHidden('${party.id}','${p.id}')">${isHiddenForParty ? t('unhideAction') : t('hideForPartyLink')}</span></td>
      </tr>
    `;
  }).join('');
  return `
    <div style="background:var(--bg);border:1px solid var(--line);padding:12px;margin:6px 0 10px;">
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">
        ${tf('partyProductPanelDesc', {name: party.name})}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
        <input type="text" id="partyProductSearch_${party.id}" placeholder="${t('searchProductPlaceholder')}"
          value="${partyProductSearchTerm.replace(/"/g,'&quot;')}"
          oninput="onPartyProductSearchInput('${party.id}', this.value)"
          style="flex:1;min-width:180px;font-family:'IBM Plex Mono',monospace;font-size:12.5px;border:1px solid var(--line);border-radius:2px;padding:6px 8px;background:#fff;" />
        <select id="partyProductCategoryFilter_${party.id}" onchange="onPartyProductCategoryFilterChange('${party.id}', this.value)"
          style="font-size:12.5px;border:1px solid var(--line);border-radius:2px;padding:6px 8px;background:#fff;">
          <option value="">${t('catFilterAll')}</option>
          ${usedCats.map(c => `<option value="${c.replace(/"/g,'&quot;')}" ${partyProductCategoryFilter === c ? 'selected' : ''}>${catLabel(c)}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <button class="btn ghost" onclick="partyProductBulkSetHidden('${party.id}', true)">${t('btnHideSelected')}</button>
        <button class="btn ghost" onclick="partyProductBulkSetHidden('${party.id}', false)">${t('btnUnhideSelected')}</button>
      </div>
      <table class="stock-table">
        <thead><tr><th></th><th>${t('colProduct')}</th><th>${t('fieldCategory')}</th><th></th></tr></thead>
        <tbody id="partyProductRows_${party.id}">${rows}</tbody>
      </table>
      <div id="partyProductNoMatch_${party.id}" class="empty-note" style="display:none;margin-top:8px;">${t('noMatchingProducts')}</div>
    </div>
  `;
}

function onPartyProductSearchInput(partyId, value){
  partyProductSearchTerm = value;
  filterPartyProductRows(partyId);
}

function onPartyProductCategoryFilterChange(partyId, value){
  partyProductCategoryFilter = value;
  filterPartyProductRows(partyId);
}

// 直接切換列的顯示/隱藏,不重新產生整個面板,這樣搜尋框打字時才不會一直失去焦點。
function filterPartyProductRows(partyId){
  const tbody = document.getElementById(`partyProductRows_${partyId}`);
  if(!tbody) return;
  const term = partyProductSearchTerm.trim().toLowerCase();
  const cat = partyProductCategoryFilter;
  let visibleCount = 0;
  tbody.querySelectorAll('tr.party-product-row').forEach(tr => {
    const matchesSearch = !term || (tr.getAttribute('data-search') || '').includes(term);
    const matchesCat = !cat || tr.getAttribute('data-category') === cat;
    const show = matchesSearch && matchesCat;
    tr.style.display = show ? '' : 'none';
    if(show) visibleCount++;
  });
  const noMatchEl = document.getElementById(`partyProductNoMatch_${partyId}`);
  if(noMatchEl) noMatchEl.style.display = visibleCount === 0 ? 'block' : 'none';
}

function togglePartyProductPanel(partyId){
  openPartyProductPanelId = (openPartyProductPanelId === partyId) ? null : partyId;
  partyProductBulkSelected = new Set();
  partyProductSearchTerm = '';
  partyProductCategoryFilter = '';
  renderPartiesTable();
}

function togglePartyProductBulkSelect(productId, checked){
  if(checked) partyProductBulkSelected.add(productId);
  else partyProductBulkSelected.delete(productId);
}

async function togglePartyProductHidden(partyId, productId){
  const party = shippingParties.find(sp => sp.id === partyId);
  if(!party) return;
  if(!Array.isArray(party.hiddenProductIds)) party.hiddenProductIds = [];
  const idx = party.hiddenProductIds.indexOf(productId);
  if(idx >= 0) party.hiddenProductIds.splice(idx, 1);
  else party.hiddenProductIds.push(productId);
  await saveShippingParties();
  renderPartiesTable();
  renderOrderItemsTable();
}

async function partyProductBulkSetHidden(partyId, hidden){
  const party = shippingParties.find(sp => sp.id === partyId);
  if(!party || partyProductBulkSelected.size === 0) return;
  if(!Array.isArray(party.hiddenProductIds)) party.hiddenProductIds = [];
  const hiddenSet = new Set(party.hiddenProductIds);
  partyProductBulkSelected.forEach(pid => {
    if(hidden) hiddenSet.add(pid); else hiddenSet.delete(pid);
  });
  party.hiddenProductIds = [...hiddenSet];
  await saveShippingParties();
  renderPartiesTable();
  renderOrderItemsTable();
}

// ===== 進貨方管理 =====
function renderSupplierManagementTable(){
  const container = document.getElementById('supplierManagementTable');
  if(!container) return;
  if(purchaseSuppliers.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noSuppliersYet')}</div>`;
    return;
  }
  const sorted = purchaseSuppliers.slice().sort((a, b) => a.name.localeCompare(b.name));
  container.innerHTML = `<table class="stock-table">
    <thead><tr><th>${t('colCode')}</th><th>${t('fieldSupplierName')}</th><th>${t('fieldSupplierContact')}</th><th>${t('fieldSupplierPhone')}</th><th>${t('fieldSupplierAddress')}</th><th>${t('fieldSupplierNote')}</th><th></th></tr></thead>
    <tbody>
      ${sorted.map(s => `
        <tr>
          <td style="white-space:nowrap;color:var(--ink-soft);font-family:'IBM Plex Mono',monospace;font-size:12px;">${escapeHtmlForPrint(s.code || '')}</td>
          <td>${escapeHtmlForPrint(s.name)}</td>
          <td>${escapeHtmlForPrint(s.contact || '')}</td>
          <td>${escapeHtmlForPrint(s.phone || '')}</td>
          <td>${escapeHtmlForPrint(s.address || '')}</td>
          <td>${escapeHtmlForPrint(s.note || '')}</td>
          <td style="white-space:nowrap;text-align:right;">
            <span class="del-link" onclick="supplierGoPurchaseHistory('${s.id}')">${t('btnSupplierPurchaseHistory')}</span>
            &nbsp;·&nbsp;
            <span class="del-link" onclick="openSupplierEditModal('${s.id}')">${t('btnEdit')}</span>
            &nbsp;·&nbsp;
            <span class="del-link" onclick="deleteSupplier('${s.id}')">${t('btnDelete')}</span>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table>`;
}

// 「進貨紀錄」:跳到 歷史紀錄 → 進貨單,自動篩選這個進貨方
function supplierGoPurchaseHistory(supplierId){
  const sup = purchaseSuppliers.find(x => x.id === supplierId);
  if(!sup) return;
  if(!partyTabAllowed('tab-log')) return;
  switchTab('tab-log');
  switchLogSubTab('subtab-log-purchases');
  const from = document.getElementById('purchaseLogDateFrom'), to = document.getElementById('purchaseLogDateTo');
  if(from) from.value = ''; if(to) to.value = '';
  const sel = document.getElementById('purchaseLogPartyFilter');
  if(sel){
    // 篩選值用編號對應的 id('id:<supplierId>');這個進貨方還沒有任何進貨單時,選項清單裡不會有它,先補一個
    const key = 'id:' + sup.id;
    if(![...sel.options].some(o => o.value === key)){
      const opt = document.createElement('option'); opt.value = key; opt.textContent = supplierOptionLabel(sup); sel.appendChild(opt);
    }
    sel.value = key;
  }
  renderPurchaseLog();
}

// 登記進貨時用了「進貨方管理」清單裡還沒有的進貨方 → 問要不要加入;要的話開出跟進貨方管理一樣的編輯視窗(名稱已帶入)
function askAddSupplierToManagement(name){
  if(!name) return;
  if(purchaseSuppliers.some(x => (x.name || '').toLowerCase() === name.toLowerCase())) return;
  showConfirmModal(tf('confirmAddSupplierToMgmt', { name }), () => { openSupplierEditModal(null, name); });
}
// 把「進貨單紀錄裡出現過、但進貨方管理清單裡還沒有」的進貨方一次補進清單(只建名稱,電話/住址之後再編輯)
async function importSuppliersFromPurchases(){
  try{ if(typeof ensurePurchasesLoaded === 'function') await ensurePurchasesLoaded(); }catch(e){}
  const known = new Set(purchaseSuppliers.map(x => (x.name || '').toLowerCase()));
  const names = [...new Set((purchases || []).map(p => (p.partyName || '').trim()).filter(Boolean))]
    .filter(n => !known.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b));
  if(names.length === 0){ showInfoModal(t('importSuppliersNone')); return; }
  const shown = names.slice(0, 15).join('、') + (names.length > 15 ? '…' : '');
  showConfirmModal(tf('importSuppliersConfirm', { n: names.length, names: shown }), async () => {
    let failed = 0;
    for(const n of names){
      const sup = { id: genId(), name: n, contact: '', phone: '', address: '', note: '' };
      try{ await upsertPurchaseSupplier(sup); purchaseSuppliers.push(sup); }
      catch(e){ failed++; console.error('匯入進貨方失敗', n, e); }
    }
    renderSupplierManagementTable();
    populateTxPartyHistorySelect();
    showInfoModal(failed ? tf('importSuppliersPartial', { ok: names.length - failed, failed }) : tf('importSuppliersDone', { n: names.length }));
  });
}

let editingSupplierId = null;
function openSupplierEditModal(supplierId, prefillName){
  editingSupplierId = supplierId;
  const s = supplierId ? purchaseSuppliers.find(x => x.id === supplierId) : null;
  document.getElementById('supplierEditModalTitle').textContent = s ? t('modalEditSupplierTitle') : t('modalAddSupplierTitle');
  document.getElementById('supplierCodeText').textContent = s ? (s.code || '') : t('codeAutoAssigned');
  document.getElementById('supplierNameInput').value = s ? s.name : (prefillName || '');
  document.getElementById('supplierContactInput').value = s ? s.contact || '' : '';
  document.getElementById('supplierPhoneInput').value = s ? s.phone || '' : '';
  document.getElementById('supplierAddressInput').value = s ? s.address || '' : '';
  document.getElementById('supplierNoteInput').value = s ? s.note || '' : '';
  document.getElementById('supplierEditModalMsg').textContent = '';
  document.getElementById('supplierEditModalOverlay').style.display = 'flex';
}
function closeSupplierEditModal(){
  editingSupplierId = null;
  document.getElementById('supplierEditModalOverlay').style.display = 'none';
}
async function saveSupplierEdit(){
  const msgEl = document.getElementById('supplierEditModalMsg');
  const name = document.getElementById('supplierNameInput').value.trim();
  const contact = document.getElementById('supplierContactInput').value.trim();
  const phone = document.getElementById('supplierPhoneInput').value.trim();
  const address = document.getElementById('supplierAddressInput').value.trim();
  const note = document.getElementById('supplierNoteInput').value.trim();
  if(!name){ msgEl.className = 'msg error'; msgEl.textContent = t('errEnterSupplierName'); return; }
  // 名稱不能跟其他供應商重複(資料庫本身也有唯一索引擋著,這裡先在前端擋一次,錯誤訊息比較
  // 好懂,不用等資料庫回傳一串技術性的錯誤)——編輯自己的話,名稱沒變不算重複。

  msgEl.className = 'msg'; msgEl.textContent = t('savingMsg');
  const s = editingSupplierId ? purchaseSuppliers.find(x => x.id === editingSupplierId) : { id: genId(), code: nextEntityCode('S', purchaseSuppliers) };
  const oldName = s.name;
  s.name = name; s.contact = contact; s.phone = phone; s.address = address; s.note = note;
  try{
    await upsertPurchaseSupplier(s);
    if(!editingSupplierId) purchaseSuppliers.push(s);
    // 改了名稱的話,之前收據辨識記憶對照表裡用舊名稱記錄的那些筆,一併同步改成新名稱,
    // 不然改名之後那些記憶會變成對照不到任何供應商、之後掃描還是會重新問一次。
    if(oldName && oldName !== name){
      const affected = receiptLineMappings.filter(m => m.partyId === oldName);
      for(const m of affected){
        m.partyId = name;
        try{ await sb.from('receipt_line_mappings').upsert(receiptMappingToRow(m)); }
        catch(e){ console.error('同步更新收據記憶的供應商名稱失敗', e); }
      }
    }
    renderSupplierManagementTable();
    populateTxPartyHistorySelect();
    closeSupplierEditModal();
  } catch(e){
    console.error('儲存供應商失敗', e);
    msgEl.className = 'msg error';
    msgEl.textContent = '⚠ 儲存失敗,請重新整理頁面再試一次。';
  }
}
function deleteSupplier(supplierId){
  const s = purchaseSuppliers.find(x => x.id === supplierId);
  if(!s) return;
  showConfirmModal(tf('confirmDeleteSupplier', { name: s.name }), async () => {
    try{
      await deletePurchaseSupplierRow(supplierId);
      purchaseSuppliers = purchaseSuppliers.filter(x => x.id !== supplierId);
      renderSupplierManagementTable();
      populateTxPartyHistorySelect();
    } catch(e){
      console.error('刪除供應商失敗', e);
      showInfoModal('⚠ 刪除失敗,請重新整理頁面再試一次。');
    }
  });
}

// ===== 倉庫後台管理 → 進貨預估 =====
// 純粹試算用的畫面,不會真的異動庫存或建立任何紀錄:目前庫存可撐直接沿用庫存總覽同一套算法
// (computeTotalStock + getEffectiveAvg + daysRemaining),填了「預計進貨數量」之後即時算出
// (預計進貨數量 + 目前庫存量)÷ 平均用量,估計進貨之後大概還能撐多久。
//
// 每一列代表一個商品家族(主商品 + 底下的 multipack 商品),進貨數量用「這一列目前選的進貨單位」
// 填——單位按列尾的 ⇄ 圖示切換,選的是家族裡哪一個商品,就用那個商品的單位、名稱、箱子體積。
// 選擇會存起來,下次打開還是同一個,直到使用者再改。(以前是「庫存總覽顯示哪個代表商品,這裡就跟著用
// 哪個單位」,現在這個對應關係取消了,完全以這裡選的為主。)
let forecastQtyDraft = {}; // anchorId -> 使用者輸入的預計進貨數量(字串,留著畫面切換/重畫時不會歸零)
let forecastVolumeUnit = 'cm3'; // 'cm3'(材積,預設) 或 'm3'(cubic meter)
let forecastUnitChoice = {};    // anchorId -> 進貨單位對應的商品 id(會存進資料庫)
let forecastBoxBasis = {};      // anchorId -> 換算「總箱數」要用哪一個商品當一箱(會存進資料庫)
let forecastRemovedIds = new Set(); // 使用者在目前篩選結果裡手動刪掉的商品(只管目前這次篩選)
let forecastAddedIds = new Set();   // 使用者在目前篩選結果之外額外手動加進來的商品
let forecastOrderPlaced = false;     // 「已訂貨」勾選:存進記錄後狀態會是 Order Placed,沒勾就是 Draft
let forecastNote = '';              // 預估表附註(會存進預估表記錄、匯出 Excel)
let forecastLoadedRecordId = null;  // 目前畫面是從哪一筆預估表記錄載入的(儲存時會取代那一筆)

function toggleForecastDesc(){
  const el = document.getElementById('forecastDescText');
  if(el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function loadForecastPrefs(){
  try{
    const r = await dbGet('forecastPrefs');
    if(r && r.value){
      const s = JSON.parse(r.value);
      forecastUnitChoice = (s && s.unitChoice) || {};
      forecastBoxBasis = (s && s.boxBasis) || {};
    }
  } catch(e){ /* 還沒存過,維持預設 */ }
}

async function saveForecastPrefs(){
  try{ await dbSet('forecastPrefs', JSON.stringify({ unitChoice: forecastUnitChoice, boxBasis: forecastBoxBasis })); }
  catch(e){ console.error('儲存進貨預估單位選擇失敗', e); }
}

// 商品箱子體積(cm³):要長寬高三個都有填才算得出來,缺一個就回傳 null(表示這個商品目前
// 沒辦法算體積,畫面上顯示「-」)。體積是看「進貨單位對應的那個商品」自己填的尺寸。
function computeBoxVolumeCm3(basis){
  if(basis.boxLengthCm == null || basis.boxWidthCm == null || basis.boxHeightCm == null) return null;
  if(isNaN(basis.boxLengthCm) || isNaN(basis.boxWidthCm) || isNaN(basis.boxHeightCm)) return null;
  return basis.boxLengthCm * basis.boxWidthCm * basis.boxHeightCm;
}

function formatForecastVolume(cm3){
  if(cm3 === null) return '-';
  if(forecastVolumeUnit === 'm3') return `${(cm3 / 1000000).toLocaleString(undefined, {minimumFractionDigits:3, maximumFractionDigits:3})} m³`;
  return `${cm3.toLocaleString(undefined, {maximumFractionDigits:0})} cm³`;
}

// ----- 進貨單位 / 換算箱數 -----
function forecastFamilyMembers(anchor){
  return [anchor].concat(getChildProducts(anchor.id));
}

// 這一列目前選的進貨單位對應的商品;沒選過(或選的那個商品已被刪除)就用主商品自己。
function getForecastUnitProduct(anchor){
  const chosenId = forecastUnitChoice[anchor.id];
  if(chosenId && chosenId !== anchor.id){
    const chosen = getChildProducts(anchor.id).find(c => c.id === chosenId);
    if(chosen) return chosen;
  }
  return anchor;
}

function isCartonUnit(unit){
  return /^(ctn|ctns|carton|cartons|box|boxes|箱)$/i.test((unit || '').trim());
}

function hasValidChildWeight(c){
  return c.childWeight !== null && c.childWeight !== undefined && !isNaN(c.childWeight) && c.childWeight > 0;
}

// 「一箱」可以用家族裡哪些商品來當:優先找單位本身就是 CTN(箱)的成員(主商品或 multipack 都算);
// 家族裡沒有任何成員的單位是 CTN 的話,才退而求其次用 multipack 商品(有填加權數的子商品)。
function getForecastBoxCandidates(anchor){
  const members = forecastFamilyMembers(anchor).filter(m => m.id === anchor.id || hasValidChildWeight(m));
  const cartonMembers = members.filter(m => isCartonUnit(m.unit));
  if(cartonMembers.length > 0) return cartonMembers;
  return getChildProducts(anchor.id).filter(hasValidChildWeight);
}

// 決定換算總箱數要用哪一個商品當一箱;只有一個選項直接用,有多個選項又還沒選過就回傳 null(要請使用者選)。
function resolveForecastBoxProduct(anchor){
  const candidates = getForecastBoxCandidates(anchor);
  if(candidates.length === 0) return null;
  const stored = forecastBoxBasis[anchor.id];
  if(stored){
    const found = candidates.find(c => c.id === stored);
    if(found) return found;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function forecastNeedsBoxChoice(anchor){
  return getForecastBoxCandidates(anchor).length > 1 && !resolveForecastBoxProduct(anchor);
}

// 把使用者填的數量(用這一列選的進貨單位)換算成「箱數」。回傳 { boxes: 數字或 null, needsChoice, noBasis }:
//  - 進貨單位本身就是 CTN → 填多少就是多少箱,不用換算。
//  - 不是 CTN → 先乘上這個商品的加權數換回主商品單位,再除以「一箱」商品的加權數(= 一箱裡有多少主商品單位)。
//  - 找不到可以當一箱的商品(沒有 multipack)→ boxes 為 null、noBasis 為 true,不計入總箱數。
//  - 有多個 multipack 又還沒選要用哪一個 → boxes 為 null、needsChoice 為 true。
function computeForecastBoxes(anchor, qty){
  const unitProd = getForecastUnitProduct(anchor);
  if(isCartonUnit(unitProd.unit)) return { boxes: qty, needsChoice: false, noBasis: false };
  const boxProd = resolveForecastBoxProduct(anchor);
  if(!boxProd){
    // 單位是 Can(罐)而且沒有任何可以當一箱的 multipack 商品(例如椰果):一罐就當一箱直接算進總箱數;
    // 如果有 multipack 可以換算(候選 > 0),還是照 multipack 的換算走,不會直接把罐數當箱數。
    if(getForecastBoxCandidates(anchor).length === 0 && /^(can|cans|罐)$/i.test((unitProd.unit || '').trim())){
      return { boxes: qty, needsChoice: false, noBasis: false };
    }
    return { boxes: null, needsChoice: getForecastBoxCandidates(anchor).length > 1, noBasis: getForecastBoxCandidates(anchor).length === 0 };
  }
  const anchorQty = qty * getBasisWeight(unitProd, anchor);
  return { boxes: anchorQty / getBasisWeight(boxProd, anchor), needsChoice: false, noBasis: false };
}

// ----- 篩選 / 顯示哪些商品 -----
function populateForecastPartyFilter(){
  const sel = document.getElementById('forecastPartyFilter');
  if(!sel) return;
  // 「進貨對象」不是出貨方那種固定清單,是從「進貨(type='in')」紀錄裡實際出現過的對象文字整理出來的
  // (登記進出貨時,類型選「進貨」填的那個「進貨方(供應商)」欄位)。
  const partySet = new Set();
  transactions.forEach(tItem => {
    if(tItem.type === 'in' && tItem.party && tItem.party.trim()) partySet.add(tItem.party.trim());
  });
  const parties = Array.from(partySet).sort((a,b) => a.localeCompare(b));
  const prev = sel.value;
  sel.innerHTML = `<option value="">${t('logPartyAll')}</option>` +
    parties.map(p => `<option value="${p.replace(/"/g,'&quot;')}">${p}</option>`).join('');
  if(parties.includes(prev)) sel.value = prev;
}

function populateForecastCategoryFilter(){
  const sel = document.getElementById('forecastCategoryFilter');
  if(!sel) return;
  syncCategoryOrder();
  const usedCats = categoryOrder.filter(c => products.some(p => (p.category || '未分類') === c && !p.parentId));
  const prev = sel.value;
  sel.innerHTML = `<option value="">${t('catFilterAll')}</option>` +
    usedCats.map(c => `<option value="${c.replace(/"/g,'&quot;')}">${catLabel(c)}</option>`).join('');
  if(usedCats.includes(prev)) sel.value = prev;
}

// 依三個篩選條件(進貨對象、快捷清單、分類,是「且」的關係)算出的商品清單,還沒套用使用者手動刪除/新增。
function getForecastBaseItems(){
  // 「篩選對象」下拉選了「依進貨對象」或「依快捷清單」,才會套用對應的那一個下拉;沒選就是全部商品。
  const modeEl = document.getElementById('forecastFilterMode');
  const mode = modeEl ? modeEl.value : '';
  const partyFilter = (mode === 'party' && document.getElementById('forecastPartyFilter')) ? document.getElementById('forecastPartyFilter').value : '';
  const catFilter = document.getElementById('forecastCategoryFilter') ? document.getElementById('forecastCategoryFilter').value : '';
  const quickListId = (mode === 'quicklist' && document.getElementById('forecastQuickListFilter')) ? document.getElementById('forecastQuickListFilter').value : '';

  // 顯示的商品跟庫存總覽預設看到的一樣:只看主商品(批量商品的量已經併進主商品的
  // computeTotalStock 裡,不用重複列出),而且不含被勾選「隱藏」的商品(庫存總覽預設也是這樣,
  // 「顯示隱藏商品」沒特別打開的話不會看到)。
  let items = products.filter(p => !p.parentId && !p.hidden);

  // 先依「進貨對象」篩選:只要這個商品有任何一筆「進貨(type='in')」紀錄的對象是選定的這個,
  // 不管商品現在是什麼分類都會顯示。
  if(partyFilter){
    const productIdsFromParty = new Set(
      transactions.filter(tItem => tItem.type === 'in' && (tItem.party || '').trim() === partyFilter).map(tItem => tItem.productId)
    );
    items = items.filter(p => productIdsFromParty.has(p.id));
  }
  if(quickListId){
    const qlSet = getQuickListAnchorIds(quickListId);
    items = items.filter(p => qlSet.has(p.id));
  }
  if(catFilter) items = items.filter(p => (p.category || '未分類') === catFilter);
  return items;
}

// 畫面上實際列出的商品 = 篩選結果,扣掉使用者手動刪掉的,再加上使用者手動新增的。
function getForecastDisplayItems(){
  const base = getForecastBaseItems();
  const baseIds = new Set(base.map(p => p.id));
  const items = base.filter(p => !forecastRemovedIds.has(p.id));
  forecastAddedIds.forEach(id => {
    if(baseIds.has(id)) return;
    const p = products.find(x => x.id === id && !x.parentId && !x.hidden);
    if(p) items.push(p);
  });
  return items.slice().sort(compareProductsBySortMode);
}

// 切換「篩選對象」(依進貨對象 / 依快捷清單):顯示對應的下拉選單,收起另一個(並清掉它的選擇),然後當作換了篩選條件。
function onForecastFilterModeChange(){
  const mode = document.getElementById('forecastFilterMode').value;
  const partySel = document.getElementById('forecastPartyFilter');
  const qlSel = document.getElementById('forecastQuickListFilter');
  partySel.style.display = mode === 'party' ? '' : 'none';
  qlSel.style.display = mode === 'quicklist' ? '' : 'none';
  if(mode !== 'party') partySel.value = '';
  if(mode !== 'quicklist') qlSel.value = '';
  onForecastFilterChange();
}

// 匯出進貨預估:依目前畫面列出的商品,把有填「預計進貨數量」的商品匯出成 Excel(商品名、進貨量、單位)。
function exportForecastSheet(){
  const msg = document.getElementById('forecastMsg');
  if(typeof XLSX === 'undefined'){ msg.className = 'msg error'; msg.textContent = 'Excel 套件載入失敗,請重新整理頁面再試一次'; return; }
  const rows = [];
  getForecastDisplayItems().forEach(p => {
    const qty = parseFloat(forecastQtyDraft[p.id]);
    if(isNaN(qty) || qty <= 0) return;
    const unitProd = getForecastUnitProduct(p);
    rows.push([unitProd.name, qty, unitProd.unit || '']);
  });
  if(rows.length === 0){ msg.className = 'msg error'; msg.textContent = t('errForecastNothingToExport'); return; }
  const aoa = [[t('colProductName'), t('colForecastQtyExport'), t('colUnit')], ...rows];
  if((forecastNote || '').trim()){ aoa.push([]); aoa.push([t('fieldForecastNote'), forecastNote.trim()]); }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 40 }, { wch: 12 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock In Forecast');
  const filename = `stock_in_forecast_${todayISO()}.xlsx`;
  XLSX.writeFile(wb, filename);
  msg.className = 'msg ok';
  msg.textContent = tf('msgForecastExported', { n: rows.length, file: filename });
}

// 換了任何一個篩選條件,視為重新開始看一份新的清單:之前手動刪掉/新增的調整只對「上一份」篩選結果有意義,清掉。
function onForecastFilterChange(){
  forecastRemovedIds = new Set();
  forecastAddedIds = new Set();
  renderForecastTable();
  if(document.getElementById('forecastAddPanel').style.display !== 'none') refreshProductPicker('fc');
}

function removeForecastRow(anchorId){
  forecastAddedIds.delete(anchorId);
  forecastRemovedIds.add(anchorId);
  renderForecastTable();
  if(document.getElementById('forecastAddPanel').style.display !== 'none') refreshProductPicker('fc');
}

function toggleForecastAddPanel(){
  const panel = document.getElementById('forecastAddPanel');
  if(!panel) return;
  if(panel.style.display === 'none'){
    panel.style.display = 'block';
    mountProductPicker('forecastAddPanel', 'fc', {
      getExcludedIds: () => getForecastDisplayItems().map(p => p.id),
      onAdd: (id, batch) => {
        forecastRemovedIds.delete(id);
        forecastAddedIds.add(id);
        if(!batch) renderForecastTable();
      },
      onAddBatchDone: () => renderForecastTable()
    });
  } else {
    panel.style.display = 'none';
    panel.innerHTML = '';
  }
}

function renderForecastTable(){
  const container = document.getElementById('forecastTableContainer');
  if(!container) return;
  populateForecastPartyFilter();
  populateForecastCategoryFilter();
  populateQuickListSelect('forecastQuickListFilter', 'quickListFilterAll');
  const now = new Date();

  const items = getForecastDisplayItems();

  // 篩選列右邊的「總箱數」「總體積」:交給共用的 updateForecastSummary() 算,避免這裡重複一份邏輯。
  updateForecastSummary();

  if(items.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noProductsToShow')}</div>`;
    return;
  }

  container.innerHTML = `
    <table class="stock-table forecast-table">
      <colgroup>
        <col class="fc-col-name"><col class="fc-col-current"><col class="fc-col-qty"><col class="fc-col-after"><col class="fc-col-del">
      </colgroup>
      <thead>
        <tr>
          <th>${t('fieldName')}</th>
          <th class="num">${t('colCurrentRemain')}</th>
          <th class="qty-col-header">${t('colForecastQty')}</th>
          <th class="num">${t('colAfterRemain')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items.map(p => forecastRowHtml(p, now)).join('')}
      </tbody>
    </table>
  `;
}

// 「庫存可撐」小視窗的內容:目前(或進貨後)總數、月平均銷量,單位跟著這一列選的進貨單位走。
function forecastTipText(unitProd, weight, rawStockForTip, rawAvg, totalLabelKey){
  const unit = unitProd.unit || '';
  const totalText = `${formatMultipackQty(rawStockForTip / weight)} ${unit}`;
  const avgText = rawAvg > 0 ? `${formatMultipackQty(rawAvg / weight)} ${unit}${t('avgSuffixMonth')}` : '—';
  return `${t(totalLabelKey)}${totalText}\n${t('tipAvgMonthlySales')}${avgText}`;
}

// p 一律是「主商品」(family 的錨點,用來算加總庫存/平均出貨);這一列顯示的名稱/SKU/單位是使用者
// 選的進貨單位對應的商品(getForecastUnitProduct)。draft 數量用主商品的 id 存(family 的 key),
// 不會因為換了進貨單位就不見。
function forecastRowHtml(p, now){
  const unitProd = getForecastUnitProduct(p);
  const weight = getBasisWeight(unitProd, p);
  const rawStock = computeTotalStock(p.id);
  const { avg: rawAvg } = getEffectiveAvg(p, now);
  const currentGauge = gaugeInfo(daysRemaining(rawStock, rawAvg));
  const draftVal = forecastQtyDraft[p.id] != null ? forecastQtyDraft[p.id] : '';
  const enteredQty = parseFloat(draftVal);
  // 使用者填的「預計進貨數量」是用這一列選的進貨單位填的(例如選了 x20 的箱子就是填箱數),
  // 要先乘上加權數換算回主商品自己的單位,才能跟原始庫存量、平均出貨量放在一起算天數。
  const rawAddition = isNaN(enteredQty) ? 0 : enteredQty * weight;
  const afterGauge = gaugeInfo(daysRemaining(rawStock + rawAddition, rawAvg));
  const hasFamily = getChildProducts(p.id).length > 0;
  return `
    <tr id="forecastRow_${p.id}">
      <td class="row-name">${unitProd.sku ? `<span class="sku-badge">${escapeHtmlText(unitProd.sku)}</span>` : ''}${escapeHtmlText(unitProd.name)}</td>
      <td class="num fc-remain-tip" data-tip="${escapeAttr(forecastTipText(unitProd, weight, rawStock, rawAvg, 'tipTotalNow'))}"><span class="dot dot-${currentGauge.cls}" style="margin-right:5px;"></span>${currentGauge.label}</td>
      <td class="qty-col-data">
        <div class="fc-qty-cell-inner">
          <input type="number" min="0" step="any" value="${draftVal}" class="fc-qty-input" id="forecastQtyInput_${p.id}"
            oninput="updateForecastRow('${p.id}')" onchange="onForecastQtyCommit('${p.id}')" /><span class="fc-unit-label" title="${escapeAttr(unitProd.unit || '')}">${escapeHtmlText(unitProd.unit || '')}</span>${hasFamily ? `<span class="fc-unit-switch" onclick="openForecastUnitMenu(event,'${p.id}')" title="${escapeAttr(t('titleSwitchForecastUnit'))}">⇄</span>` : ''}
        </div>
      </td>
      <td class="num fc-remain-tip" id="forecastAfterCell_${p.id}" data-tip="${escapeAttr(forecastTipText(unitProd, weight, rawStock + rawAddition, rawAvg, 'tipTotalAfter'))}"><span class="dot dot-${afterGauge.cls}" style="margin-right:5px;"></span>${afterGauge.label}</td>
      <td><span class="fc-row-del" onclick="removeForecastRow('${p.id}')" title="${escapeAttr(t('titleRemoveForecastRow'))}">✕</span></td>
    </tr>
  `;
}

// 只更新「這一列」的預計進貨數量、體積、右邊的試算結果,不整個表格重畫——不然使用者打字打到一半,
// 表格被背景自動同步之類的機制重畫,輸入框會被打斷、游標位置也會跳掉。但因為總箱數/總體積這個
// 加總數字牽涉到「所有列」,單一列改動還是得重算一次加總,所以這裡額外呼叫 updateForecastSummary()
// 只重畫上面那條加總小字,不動整個表格。
function updateForecastRow(productId){
  const input = document.getElementById(`forecastQtyInput_${productId}`);
  if(!input) return;
  forecastQtyDraft[productId] = input.value;
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const unitProd = getForecastUnitProduct(p);
  const weight = getBasisWeight(unitProd, p);
  const rawStock = computeTotalStock(p.id);
  const { avg: rawAvg } = getEffectiveAvg(p, new Date());
  const qty = parseFloat(input.value);
  const rawAddition = isNaN(qty) ? 0 : qty * weight;
  const afterGauge = gaugeInfo(daysRemaining(rawStock + rawAddition, rawAvg));
  const cell = document.getElementById(`forecastAfterCell_${productId}`);
  if(cell){
    cell.innerHTML = `<span class="dot dot-${afterGauge.cls}" style="margin-right:5px;"></span>${afterGauge.label}`;
    cell.setAttribute('data-tip', forecastTipText(unitProd, weight, rawStock + rawAddition, rawAvg, 'tipTotalAfter'));
  }

  updateForecastSummary();
}

// 數量輸入完成(離開欄位/按 Enter)才檢查要不要請使用者選「換算總箱數用哪個 multipack」——不在打字
// 當下就跳視窗,不然使用者連一個數字都還沒打完就被打斷。
function onForecastQtyCommit(productId){
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const qty = parseFloat(forecastQtyDraft[productId]);
  if(isNaN(qty) || qty <= 0) return;
  if(isCartonUnit(getForecastUnitProduct(p).unit)) return; // 單位本身就是 CTN,不用換算
  if(forecastNeedsBoxChoice(p)) openForecastBoxBasisModal(productId);
}

// 只重算、重畫上面那條「總箱數 / 總體積」的加總小字,不動整個表格(避免打字時整表重畫打斷輸入)。
function updateForecastSummary(){
  const summaryBar = document.getElementById('forecastSummaryBar');
  if(!summaryBar) return;
  const items = getForecastDisplayItems();

  let totalBoxes = 0, totalVolumeCm3 = 0, notConvertible = 0;
  const notConvertibleNames = [];
  items.forEach(p => {
    const qty = parseFloat(forecastQtyDraft[p.id]);
    if(isNaN(qty) || qty <= 0) return;
    const unitProd = getForecastUnitProduct(p);
    const boxVol = computeBoxVolumeCm3(unitProd);
    if(boxVol !== null) totalVolumeCm3 += boxVol * qty;
    const res = computeForecastBoxes(p, qty);
    if(res.boxes === null){ notConvertible++; notConvertibleNames.push(unitProd.name); }
    else totalBoxes += res.boxes;
  });

  summaryBar.innerHTML = `
    <span style="white-space:nowrap;">${t('lblTotalBoxes')}<strong>${totalBoxes ? (Math.round(totalBoxes * 100) / 100).toLocaleString() : '0'}</strong></span>
    <span style="margin-left:14px;white-space:nowrap;">${t('lblTotalVolume')}<strong>${formatForecastVolume(totalVolumeCm3 || 0)}</strong></span>
    <span style="margin-left:2px;white-space:nowrap;"><span class="del-link" style="margin-left:5px;color:var(--ink);cursor:pointer;" title="${t('titleSwitchVolumeUnit')}" onclick="openForecastVolumeUnitMenu(event)">⇄</span></span>
    ${notConvertible > 0 ? `<div style="font-size:11.5px;color:var(--warn);margin-top:4px;">${tn('noteBoxesNotConvertible', notConvertible)}<br>${notConvertibleNames.map(escapeHtmlText).join('、')}</div>` : ''}
  `;
}

function openForecastVolumeUnitMenu(ev){
  ev.stopPropagation();
  closeForecastUnitMenu();
  const menu = document.createElement('div');
  menu.id = 'forecastUnitMenu';
  menu.className = 'fc-unit-menu';
  menu.innerHTML = `
    <div class="fc-menu-title">${t('titleSwitchVolumeUnit')}</div>
    <div class="fc-menu-item ${forecastVolumeUnit === 'cm3' ? 'selected' : ''}" onclick="selectForecastVolumeUnit('cm3')"><span>${forecastVolumeUnit === 'cm3' ? '✓' : '&nbsp;&nbsp;'}</span><span>cm³ (${t('lblVolumeDefaultUnit')})</span></div>
    <div class="fc-menu-item ${forecastVolumeUnit === 'm3' ? 'selected' : ''}" onclick="selectForecastVolumeUnit('m3')"><span>${forecastVolumeUnit === 'm3' ? '✓' : '&nbsp;&nbsp;'}</span><span>m³ (cubic meter)</span></div>`;
  document.body.appendChild(menu);
  const rect = ev.currentTarget.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.left = Math.min(Math.max(8, rect.right - mw), window.innerWidth - mw - 8) + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  setTimeout(() => {
    function onOutside(e){
      if(menu.contains(e.target)) return;
      closeForecastUnitMenu();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('touchstart', onOutside, true);
    }
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('touchstart', onOutside, true);
  }, 0);
}
function selectForecastVolumeUnit(u){
  forecastVolumeUnit = u;
  closeForecastUnitMenu();
  renderForecastTable();
}

// ----- 切換進貨單位選單(+ 換算總箱數依據) -----
function closeForecastUnitMenu(){
  const old = document.getElementById('forecastUnitMenu');
  if(old) old.remove();
}

function openForecastUnitMenu(ev, anchorId){
  ev.stopPropagation();
  closeForecastUnitMenu();
  const p = products.find(x => x.id === anchorId);
  if(!p) return;
  const current = getForecastUnitProduct(p);
  const members = forecastFamilyMembers(p);
  const boxCandidates = getForecastBoxCandidates(p);
  const boxCurrent = resolveForecastBoxProduct(p);

  const menu = document.createElement('div');
  menu.id = 'forecastUnitMenu';
  menu.className = 'fc-unit-menu';
  menu.innerHTML = `
    <div class="fc-menu-title">${t('menuTitleForecastUnit')}</div>
    ${members.map(m => `
      <div class="fc-menu-item ${m.id === current.id ? 'selected' : ''}" onclick="selectForecastUnit('${anchorId}','${m.id}')">
        <span>${m.id === current.id ? '✓' : '&nbsp;&nbsp;'}</span>
        <span>${escapeHtmlText(m.name)} <span style="color:var(--ink-soft);">(${escapeHtmlText(m.unit || '')})</span></span>
      </div>`).join('')}
    ${boxCandidates.length > 1 ? `
      <div class="fc-menu-sep"></div>
      <div class="fc-menu-title">${t('menuTitleForecastBoxBasis')}</div>
      ${boxCandidates.map(m => `
        <div class="fc-menu-item ${boxCurrent && m.id === boxCurrent.id ? 'selected' : ''}" onclick="selectForecastBoxBasis('${anchorId}','${m.id}')">
          <span>${boxCurrent && m.id === boxCurrent.id ? '✓' : '&nbsp;&nbsp;'}</span>
          <span>${escapeHtmlText(m.name)} <span style="color:var(--ink-soft);">(${escapeHtmlText(m.unit || '')})</span></span>
        </div>`).join('')}` : ''}
  `;
  document.body.appendChild(menu);

  const rect = ev.currentTarget.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(Math.max(8, rect.right - mw), window.innerWidth - mw - 8);
  let top = rect.bottom + 4;
  if(top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  // 點選單以外的地方就收起來;延後一下才開始監聽,避免打開選單的這次點擊本身被當成「點了外面」。
  setTimeout(() => {
    function onOutside(e){
      if(menu.contains(e.target)) return;
      closeForecastUnitMenu();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('touchstart', onOutside, true);
    }
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('touchstart', onOutside, true);
  }, 0);
}

async function selectForecastUnit(anchorId, memberId){
  forecastUnitChoice[anchorId] = memberId;
  closeForecastUnitMenu();
  await saveForecastPrefs();
  renderForecastTable();
  onForecastQtyCommit(anchorId); // 切換後如果變成需要選「換算箱數依據」,馬上詢問
}

async function selectForecastBoxBasis(anchorId, memberId){
  forecastBoxBasis[anchorId] = memberId;
  closeForecastUnitMenu();
  await saveForecastPrefs();
  updateForecastSummary();
}

// 這個商品家族有多個可以當「一箱」的商品、又還沒選過用哪一個換算總箱數時,跳出視窗請使用者選一個。
function openForecastBoxBasisModal(anchorId){
  const p = products.find(x => x.id === anchorId);
  if(!p) return;
  const candidates = getForecastBoxCandidates(p);
  const unitProd = getForecastUnitProduct(p);
  const overlay = document.getElementById('forecastBoxBasisModalOverlay');
  document.getElementById('forecastBoxBasisModalDesc').textContent =
    tf('forecastBoxBasisModalDesc', { name: p.name, unit: unitProd.unit || '' });
  document.getElementById('forecastBoxBasisModalList').innerHTML = candidates.map(m => `
    <div class="fc-menu-item" style="border:1px solid var(--line);border-radius:3px;margin-bottom:8px;padding:10px 12px;" onclick="chooseForecastBoxBasisFromModal('${anchorId}','${m.id}')">
      ${escapeHtmlText(m.name)} <span style="color:var(--ink-soft);">(${escapeHtmlText(m.unit || '')})</span>
    </div>`).join('');
  overlay.style.display = 'flex';
}

function closeForecastBoxBasisModal(){
  document.getElementById('forecastBoxBasisModalOverlay').style.display = 'none';
}

async function chooseForecastBoxBasisFromModal(anchorId, memberId){
  forecastBoxBasis[anchorId] = memberId;
  closeForecastBoxBasisModal();
  await saveForecastPrefs();
  updateForecastSummary();
}

// 「庫存可撐」小視窗:桌面版滑鼠移過去就顯示、移開就收起來;手機版點一下顯示,之後只要做其他動作
// (滑動、點別的地方)就收起來。用事件代理綁在 document 上只需要綁一次,表格重畫幾次都繼續生效。
(function initForecastTip(){
  function getTip(){ return document.getElementById('forecastTip'); }
  function showTip(target){
    const tip = getTip();
    if(!tip || !target.dataset.tip) return;
    tip.textContent = target.dataset.tip;
    tip.style.display = 'block';
    const rect = target.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    let top = rect.top - th - 6;
    if(top < 4) top = rect.bottom + 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    target.classList.add('fc-tip-open');
  }
  function hideTip(){
    const tip = getTip();
    if(tip) tip.style.display = 'none';
    document.querySelectorAll('.fc-tip-open').forEach(el => el.classList.remove('fc-tip-open'));
  }
  const hoverCapable = window.matchMedia && window.matchMedia('(hover:hover)').matches;

  if(hoverCapable){
    document.addEventListener('mouseover', function(e){
      const el = e.target.closest && e.target.closest('.fc-remain-tip');
      if(el) showTip(el);
    });
    document.addEventListener('mouseout', function(e){
      const el = e.target.closest && e.target.closest('.fc-remain-tip');
      if(!el) return;
      const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.fc-remain-tip') : null;
      if(el !== related) hideTip();
    });
  } else {
    function armDismiss(){
      let dismissed = false;
      function dismissOnce(){
        if(dismissed) return;
        dismissed = true;
        hideTip();
        window.removeEventListener('scroll', dismissOnce, true);
        document.removeEventListener('touchstart', dismissOnce, true);
      }
      setTimeout(function(){
        window.addEventListener('scroll', dismissOnce, true);
        document.addEventListener('touchstart', dismissOnce, true);
      }, 250);
    }
    document.addEventListener('click', function(e){
      const el = e.target.closest && e.target.closest('.fc-remain-tip');
      if(!el) return;
      showTip(el);
      armDismiss();
    });
  }
})();


// ===== 進貨預估紀錄(儲存 / 載入 / 刪除) =====
// 一筆紀錄 = { id, name, savedAt, items: [{ anchorId, qty, unitId, boxBasisId }] }
// 存的是「當下畫面上列出的商品清單」跟每個商品的預計進貨數量(以及當時選的進貨單位)。
let forecastRecords = [];

async function loadForecastRecords(){
  try{
    const r = await dbGet('forecastRecords');
    if(r && r.value){
      const arr = JSON.parse(r.value);
      if(Array.isArray(arr)) forecastRecords = arr.filter(x => x && x.id && Array.isArray(x.items));
    }
  } catch(e){ /* 還沒存過 */ }
}

async function saveForecastRecords(){
  await dbSet('forecastRecords', JSON.stringify(forecastRecords));
}

function defaultForecastRecordName(){
  return `${t('subtabTxForecast')} ${formatOrderDateTime(new Date().toISOString())}`;
}

function openSaveForecastModal(){
  const msg = document.getElementById('forecastMsg');
  if(getForecastDisplayItems().length === 0){
    msg.className = 'msg error'; msg.textContent = t('errForecastNothingToSave'); return;
  }
  const loadedRec = forecastLoadedRecordId ? forecastRecords.find(r => r.id === forecastLoadedRecordId) : null;
  if(!loadedRec) forecastLoadedRecordId = null;
  document.getElementById('saveForecastNameInput').value = loadedRec ? loadedRec.name : defaultForecastRecordName();
  document.getElementById('saveForecastModalMsg').textContent = '';
  document.getElementById('saveForecastModalOverlay').style.display = 'flex';
  setTimeout(() => { const i = document.getElementById('saveForecastNameInput'); if(i){ i.focus(); i.select(); } }, 50);
}
function closeSaveForecastModal(){
  document.getElementById('saveForecastModalOverlay').style.display = 'none';
}

async function confirmSaveForecast(){
  const modalMsg = document.getElementById('saveForecastModalMsg');
  const name = (document.getElementById('saveForecastNameInput').value || '').trim();
  if(!name){ modalMsg.className = 'msg error'; modalMsg.textContent = t('errForecastRecordNameRequired'); return; }
  const items = getForecastDisplayItems().map(p => {
    const qtyRaw = forecastQtyDraft[p.id];
    const qty = parseFloat(qtyRaw);
    return {
      anchorId: p.id,
      qty: isNaN(qty) ? '' : qty,
      unitId: getForecastUnitProduct(p).id,
      boxBasisId: forecastBoxBasis[p.id] || null
    };
  });
  const prev = forecastRecords.slice();
  const wasLoadedId = forecastLoadedRecordId;
  // 同樣名稱的記錄只留最新一筆(取代舊的,已匯入進貨單的記錄不動);名稱不同才會多出一筆。
  // 載入的預估表預設帶原本的名稱(見 openSaveForecastModal),所以不改名直接儲存就是取代原本那筆。
  const sameNameCount = forecastRecords.filter(r => !r.converted && (r.name || '').trim() === name).length;
  forecastRecords = forecastRecords.filter(r => r.converted || (r.name || '').trim() !== name);
  forecastRecords.push({ id: 'fr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, savedAt: new Date().toISOString(), items, note: (forecastNote || '').trim(), orderPlaced: !!forecastOrderPlaced });
  try{ await saveForecastRecords(); }
  catch(e){
    console.error('儲存進貨預估紀錄失敗', e);
    forecastRecords = prev;
    modalMsg.className = 'msg error'; modalMsg.textContent = t('errSaveOrderFailed');
    return;
  }
  closeSaveForecastModal();
  const msg = document.getElementById('forecastMsg');
  if(wasLoadedId || sameNameCount > 0){
    // 載入的預估表(或取代了同名記錄)儲存後就離開那筆記錄:數量、附註清空,變成一份新的預估表。
    forecastLoadedRecordId = null;
    forecastQtyDraft = {};
    forecastNote = '';
    forecastOrderPlaced = false;
    const opChk1 = document.getElementById('forecastOrderPlacedChk'); if(opChk1) opChk1.checked = false;
    const noteEl = document.getElementById('forecastNoteInput'); if(noteEl) noteEl.value = '';
    renderForecastTable();
    if(document.getElementById('forecastRecordsPanel').style.display !== 'none') renderForecastRecords();
  }
  msg.className = 'msg ok';
  msg.textContent = tf('msgForecastSaved', { name });
}

// ----- Action(儲存預估表 / 預估表記錄 / 匯出預估表) -----
function openForecastActionModal(){
  const sel = document.getElementById('forecastActionSelect');
  sel.innerHTML = `
    <option value="save">${t('optForecastSave')}</option>
    <option value="records">${t('optForecastRecords')}</option>
    <option value="export">${t('optForecastExport')}</option>`;
  document.getElementById('forecastActionModalOverlay').style.display = 'flex';
}
function closeForecastActionModal(){
  document.getElementById('forecastActionModalOverlay').style.display = 'none';
}
function confirmForecastActionModal(){
  const v = document.getElementById('forecastActionSelect').value;
  closeForecastActionModal();
  if(v === 'save') openSaveForecastModal();
  else if(v === 'records') toggleForecastRecordsPanel(true);
  else if(v === 'export') exportForecastSheet();
}

// ----- 預估表記錄「載入」(預估表 / 進貨) -----
let forecastLoadModalRecordId = null;
function openForecastLoadModal(id){
  const rec = forecastRecords.find(r => r.id === id);
  if(!rec) return;
  forecastLoadModalRecordId = id;
  document.getElementById('forecastLoadModalTitle').textContent = rec.name;
  document.getElementById('forecastLoadSelect').innerHTML = `
    <option value="forecast">${t('optLoadAsForecast')}</option>
    <option value="purchase">${t('optLoadAsPurchase')}</option>`;
  document.getElementById('forecastLoadModalOverlay').style.display = 'flex';
}
function closeForecastLoadModal(){
  document.getElementById('forecastLoadModalOverlay').style.display = 'none';
}
function confirmForecastLoadModal(){
  const v = document.getElementById('forecastLoadSelect').value;
  const id = forecastLoadModalRecordId;
  closeForecastLoadModal();
  if(v === 'purchase') loadForecastRecordToPurchase(id);
  else loadForecastRecord(id);
}

function toggleForecastRecordsPanel(forceOpen){
  const panel = document.getElementById('forecastRecordsPanel');
  if(!panel) return;
  if(panel.style.display === 'none' || forceOpen === true){
    panel.style.display = 'block';
    loadForecastRecords().then(renderForecastRecords);
  } else {
    panel.style.display = 'none';
  }
}

// 預估表記錄狀態:converted(已匯入進貨單並提交)> ordered(已訂貨)> draft
function forecastRecordStatus(r){
  if(r.converted) return 'converted';
  return r.orderPlaced ? 'ordered' : 'draft';
}
function forecastStatusLabel(st){
  return st === 'converted' ? t('forecastStatusConverted') : (st === 'ordered' ? t('forecastStatusOrdered') : t('forecastStatusDraft'));
}
function showForecastRecordNote(id){
  const r = forecastRecords.find(x => x.id === id);
  if(r && r.note) showInfoModal(r.note);
}
// 預估表記錄清單的表格:預估表頁面(includeConverted=false,已匯入進貨單的不列)跟歷史紀錄(全部都列)共用。
// 點一列展開商品明細(數量、單位、附註,已匯入進貨單的還會顯示對應的進貨單)。
let forecastExpandedRecordIds = new Set();
function toggleForecastRecordExpand(id){
  if(forecastExpandedRecordIds.has(id)) forecastExpandedRecordIds.delete(id); else forecastExpandedRecordIds.add(id);
  if(forecastRecords.find(r => r.id === id && r.purchaseId) && typeof ensurePurchasesLoaded === 'function'){
    ensurePurchasesLoaded().then(renderForecastRecords);
  }
  renderForecastRecords();
}
function forecastRecordDetailHtml(r){
  const rows = (r.items || []).filter(it => Number(it.qty) > 0).map(it => {
    const prod = products.find(p => p.id === it.unitId) || products.find(p => p.id === it.anchorId);
    return `<tr><td class="row-name">${escapeHtmlText(prod ? prod.name : '?')}</td><td class="num">${Number(it.qty)}</td><td>${escapeHtmlText(prod ? (prod.unit || '') : '')}</td></tr>`;
  }).join('');
  let link = '';
  if(r.converted){
    const pur = r.purchaseId && typeof purchases !== 'undefined' ? purchases.find(p => p.id === r.purchaseId) : null;
    const parts = [];
    if(r.convertedAt) parts.push(formatOrderDateTime(r.convertedAt));
    if(pur){ parts.push(pur.date || ''); if(pur.partyName) parts.push(pur.partyName); if(pur.invoiceNo) parts.push('#' + pur.invoiceNo); }
    link = `<div style="margin:6px 0;font-size:12.5px;color:var(--safe);">${t('forecastLinkedPurchase')}: ${escapeHtmlText(parts.filter(Boolean).join(' · ') || (r.purchaseId ? t('forecastLinkedPurchaseUnknown') : '—'))}</div>`;
  }
  return `<div style="padding:6px 4px 10px;">
    ${link}
    ${r.note ? `<div style="margin:6px 0;font-size:12.5px;color:var(--ink-soft);">${t('fieldForecastNote')}: ${escapeHtmlText(r.note)}</div>` : ''}
    ${rows ? `<table class="stock-table"><thead><tr><th>${t('colProductName')}</th><th class="num">${t('colForecastQtyExport')}</th><th>${t('colUnit')}</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty-note">${t('forecastRecordNoQtyItems')}</div>`}
  </div>`;
}
function forecastRecordsTableHtml(includeConverted){
  const list = forecastRecords.filter(r => includeConverted || !r.converted);
  if(list.length === 0) return `<div class="empty-note">${t('noForecastRecordsYet')}</div>`;
  const sorted = list.slice().sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return `
    <table class="stock-table">
      <thead><tr>
        <th>${t('fieldForecastRecordName')}</th>
        <th>${t('colForecastRecordSavedAt')}</th>
        <th>${t('colForecastRecordItems')}</th>
        <th>${t('colForecastRecordStatus')}</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${sorted.map(r => {
          const withQty = r.items.filter(it => it.qty !== '' && it.qty != null && Number(it.qty) > 0).length;
          const st = forecastRecordStatus(r);
          const stColor = st === 'converted' ? 'var(--safe)' : (st === 'ordered' ? 'var(--warn)' : 'var(--ink-soft)');
          const open = forecastExpandedRecordIds.has(r.id);
          const acts = st === 'converted'
            ? `<span class="del-link" title="${t('btnDeleteRecord')}" onclick="deleteForecastRecord('${r.id}')">✕</span>`
            : `<span class="del-link" style="color:var(--ink);" onclick="loadForecastRecord('${r.id}')">${t('btnLoadForecastRecord')}</span>
               <span class="del-link" style="margin-left:10px;" title="${t('btnDeleteRecord')}" onclick="deleteForecastRecord('${r.id}')">✕</span>
               <span class="del-link" style="margin-left:10px;color:var(--ink);" onclick="loadForecastRecordToPurchase('${r.id}')">${t('btnLoadPurchaseRecord')}</span>`;
          return `<tr style="cursor:pointer;" onclick="toggleForecastRecordExpand('${r.id}')">
            <td class="row-name"><span style="display:inline-block;width:14px;">${open ? '▾' : '▸'}</span>${escapeHtmlText(r.name)}${r.note ? ` <span class="del-link" style="margin-left:4px;" title="${t('fieldForecastNote')}" onclick="event.stopPropagation();showForecastRecordNote('${r.id}')">📝</span>` : ''}</td>
            <td>${escapeHtmlText(formatOrderDateTime(r.savedAt))}</td>
            <td>${tf('forecastRecordItemsCount', { q: withQty })}</td>
            <td style="color:${stColor};font-weight:600;white-space:nowrap;">${forecastStatusLabel(st)}</td>
            <td style="white-space:nowrap;text-align:right;" onclick="event.stopPropagation()">${acts}</td>
          </tr>${open ? `<tr><td colspan="5" style="background:var(--bg,#faf7f0);">${forecastRecordDetailHtml(r)}</td></tr>` : ''}`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderForecastRecords(){
  const box = document.getElementById('forecastRecordsContainer');
  if(box) box.innerHTML = forecastRecordsTableHtml(false);
  renderLogForecastRecords();
}
function renderLogForecastRecords(){
  const box = document.getElementById('logForecastRecordsContainer');
  if(box) box.innerHTML = forecastRecordsTableHtml(true);
}
// 從歷史紀錄「匯入預估」:先跳到預估表頁面再載入。
function openForecastRecordFromHistory(id){
  switchTab('tab-warehouse-admin');
  switchWarehouseAdminSubTab('subtab-tx-forecast');
  loadForecastRecord(id);
}

// 載入:把進貨預估頁面換成這份紀錄的內容——篩選全部清掉、商品清單剛好是紀錄裡的商品(已經不存在的商品略過)、
// 預計進貨數量跟當時的進貨單位一起帶回來。
async function loadForecastRecord(id){
  const rec = forecastRecords.find(r => r.id === id);
  if(!rec) return;
  const fpage = document.getElementById('subtab-tx-forecast');
  if(fpage && fpage.offsetParent === null){ switchTab('tab-warehouse-admin'); switchWarehouseAdminSubTab('subtab-tx-forecast'); }
  const recMsg = null;
  forecastLoadedRecordId = rec.id;
  forecastNote = rec.note || '';
  forecastOrderPlaced = !!rec.orderPlaced;
  const opChk0 = document.getElementById('forecastOrderPlacedChk'); if(opChk0) opChk0.checked = forecastOrderPlaced;
  const noteEl0 = document.getElementById('forecastNoteInput'); if(noteEl0) noteEl0.value = forecastNote;
  const valid = rec.items.filter(it => products.some(p => p.id === it.anchorId && !p.parentId));
  const skipped = rec.items.length - valid.length;

  const modeEl = document.getElementById('forecastFilterMode');
  if(modeEl) modeEl.value = '';
  ['forecastPartyFilter', 'forecastQuickListFilter'].forEach(sid => { const el = document.getElementById(sid); if(el){ el.value = ''; el.style.display = 'none'; } });
  const catEl = document.getElementById('forecastCategoryFilter');
  if(catEl) catEl.value = '';

  const keep = new Set(valid.map(it => it.anchorId));
  forecastAddedIds = new Set(keep);
  // 沒有任何篩選時畫面預設列出的商品(不含隱藏),凡是不在這份紀錄裡的都標記成「已刪除」
  forecastRemovedIds = new Set(getForecastBaseItems().filter(p => !keep.has(p.id)).map(p => p.id));

  forecastQtyDraft = {};
  valid.forEach(it => {
    if(it.qty !== '' && it.qty != null) forecastQtyDraft[it.anchorId] = String(it.qty);
    if(it.unitId && products.some(p => p.id === it.unitId)) forecastUnitChoice[it.anchorId] = it.unitId;
    if(it.boxBasisId && products.some(p => p.id === it.boxBasisId)) forecastBoxBasis[it.anchorId] = it.boxBasisId;
  });
  await saveForecastPrefs();

  const recPanel = document.getElementById('forecastRecordsPanel');
  if(recPanel) recPanel.style.display = 'none';
  if(document.getElementById('forecastAddPanel').style.display !== 'none') refreshProductPicker('fc');
  renderForecastTable();
  const fmsg = document.getElementById('forecastMsg');
  if(fmsg){
    fmsg.className = 'msg ok';
    fmsg.textContent = tf('msgForecastLoaded', { name: rec.name }) + (skipped > 0 ? ' ' + tn('noteForecastRecordSkipped', skipped) : '');
  }
  if(recMsg) recMsg.textContent = '';
}

// 載入進貨:跳到「登記進出貨 → 進貨」,把預估表裡有填數量的商品跟數量帶進清單。
// 每個品項記住來源預估表 id(forecastRecordId),進貨提交成功之後會把那筆預估表記錄刪除;
// 之後掃描收據時,系統會拿掃到的內容跟這些載入的品項比對(見 receipt-scan.js reconcileForecastScan)。
function loadForecastRecordToPurchase(id){
  const rec = forecastRecords.find(r => r.id === id);
  if(!rec) return;
  const lines = [];
  rec.items.forEach(it => {
    const qty = Number(it.qty);
    if(!(qty > 0)) return;
    const prod = products.find(p => p.id === (it.unitId || it.anchorId)) || products.find(p => p.id === it.anchorId);
    if(!prod) return;
    lines.push({ prod, qty });
  });
  const msg = document.getElementById('forecastMsg');
  if(lines.length === 0){ msg.className = 'msg error'; msg.textContent = t('errForecastNoQtyToPurchase'); return; }
  const doLoad = () => {
    switchTab('tab-warehouse-ops');
    switchWarehouseOpsSubTab('subtab-tx-register');
    setTxType('in');
    txBatchItems = [];
    lines.forEach(({ prod, qty }) => {
      const ex = txBatchItems.find(x => x.productId === prod.id && !x.expiry);
      if(ex){ ex.qty += qty; return; }
      txBatchItems.push({ batchItemId: genId(), productId: prod.id, sku: prod.sku || '', name: prod.name, unit: prod.unit, qty, fromForecast: true, forecastRecordId: rec.id, forecastRecordName: rec.name });
    });
    renderTxBatchList();
    const tm = document.getElementById('txMsg');
    if(tm){ tm.className = 'msg ok'; tm.textContent = tf('msgForecastLoadedToPurchase', { name: rec.name, n: txBatchItems.length }); }
  };
  if(typeof txBatchItems !== 'undefined' && txBatchItems.length > 0){
    showConfirmModal(t('confirmReplaceBatchWithForecast'), doLoad);
  } else doLoad();
}

function deleteForecastRecord(id){
  const rec = forecastRecords.find(r => r.id === id);
  if(!rec) return;
  showConfirmModal(tf('confirmDeleteForecastRecord', { name: rec.name }), async () => {
    const prev = forecastRecords.slice();
    forecastRecords = forecastRecords.filter(r => r.id !== id);
    if(forecastLoadedRecordId === id) forecastLoadedRecordId = null;
    const recMsg = document.getElementById('forecastMsg');
    try{ await saveForecastRecords(); }
    catch(e){
      console.error('刪除進貨預估紀錄失敗', e);
      forecastRecords = prev;
      if(recMsg){ recMsg.className = 'msg error'; recMsg.textContent = t('errSaveOrderFailed'); }
      return;
    }
    renderForecastRecords();
    if(recMsg){ recMsg.className = 'msg ok'; recMsg.textContent = tf('msgForecastRecordDeleted', { name: rec.name }); }
  });
}


// 進貨提交成功後,把來源預估表記錄標記成「已匯入進貨單」(Converted to PO):預估表頁面不再列出,
// 庫存總覽的「包含進貨預估」也不再計入,但歷史紀錄的「進貨預估紀錄」會保留。
async function removeForecastRecordsAfterPurchase(ids, purchaseId){
  const set = new Set(ids.filter(Boolean));
  if(set.size === 0) return;
  await loadForecastRecords();
  const prev = forecastRecords.map(r => ({ ...r }));
  let changed = false;
  forecastRecords.forEach(r => { if(set.has(r.id) && !r.converted){ r.converted = true; r.convertedAt = new Date().toISOString(); if(purchaseId) r.purchaseId = purchaseId; changed = true; } });
  if(!changed) return;
  if(set.has(forecastLoadedRecordId)) forecastLoadedRecordId = null;
  try{ await saveForecastRecords(); }
  catch(e){ console.error('更新預估表記錄狀態失敗', e); forecastRecords = prev; return; }
  const panel = document.getElementById('forecastRecordsPanel');
  if(panel && panel.style.display !== 'none') renderForecastRecords();
}
