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
        shippingParties.map(sp => `<option value="${sp.id}">${sp.name.replace(/"/g,'&quot;')}</option>`).join('');
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

async function addParty(){
  if(!hasCapability('cap-manage-parties')) return;
  const nameEl = document.getElementById('newPartyName');
  const contactEl = document.getElementById('newPartyContact');
  const noteEl = document.getElementById('newPartyNote');
  const msg = document.getElementById('partyMsg');
  const name = nameEl.value.trim();
  const contact = contactEl.value.trim();
  const note = noteEl.value.trim();

  if(!name){ msg.className = 'msg error'; msg.textContent = '請輸入出貨方名稱'; return; }
  if(shippingParties.some(sp => sp.name === name)){ msg.className = 'msg error'; msg.textContent = '這個出貨方名稱已經存在'; return; }

  shippingParties.push({ id: genId(), name, contact, note, hiddenProductIds: [] });
  await saveShippingParties();
  nameEl.value = ''; contactEl.value = ''; noteEl.value = '';
  msg.className = 'msg ok'; msg.textContent = `✓ 已新增出貨方「${name}」`;
  renderPartiesTable();
  populatePartySelect();
}

function startEditParty(id){
  if(!hasCapability('cap-manage-parties')) return;
  editingPartyId = id;
  renderPartiesTable();
}

function cancelEditParty(){
  editingPartyId = null;
  renderPartiesTable();
}

async function saveEditParty(id){
  if(!hasCapability('cap-manage-parties')) return;
  const sp = shippingParties.find(x => x.id === id);
  if(!sp) return;
  const name = document.getElementById('editPartyName').value.trim();
  const contact = document.getElementById('editPartyContact').value.trim();
  const note = document.getElementById('editPartyNote').value.trim();
  const orderFrequencyEl = document.getElementById('editPartyOrderFrequency');
  const orderFrequency = orderFrequencyEl ? orderFrequencyEl.value : (sp.orderFrequency || 'weekly');
  if(!name){ showInfoModal('出貨方名稱不能空白'); return; }
  if(shippingParties.some(x => x.id !== id && x.name === name)){ showInfoModal('已經有另一個出貨方叫這個名字了'); return; }

  sp.name = name; sp.contact = contact; sp.note = note; sp.orderFrequency = orderFrequency;
  editingPartyId = null;
  await saveShippingParties();
  renderPartiesTable();
  populatePartySelect();
  renderOrders(); // 已建立的訂單卡片上顯示的出貨方名稱也一併更新
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
  const rows = shippingParties.map(sp => {
    if(editingPartyId === sp.id){
      return `
        <tr class="editing-row">
          <td>
            <span class="mini-label">${t('fieldPartyName')}</span>
            <input type="text" id="editPartyName" value="${sp.name.replace(/"/g,'&quot;')}" style="width:100%;" />
          </td>
          <td>
            <span class="mini-label">${t('colPartyContact')}</span>
            <input type="text" id="editPartyContact" value="${sp.contact ? sp.contact.replace(/"/g,'&quot;') : ''}" style="width:100%;" />
          </td>
          <td>
            <span class="mini-label">${t('colNote')}</span>
            <input type="text" id="editPartyNote" value="${sp.note ? sp.note.replace(/"/g,'&quot;') : ''}" style="width:100%;" />
          </td>
          <td>
            <span class="mini-label">${t('colOrderFrequency')}</span>
            <select id="editPartyOrderFrequency" style="width:100%;">
              <option value="weekly" ${(!sp.orderFrequency || sp.orderFrequency === 'weekly') ? 'selected' : ''}>${t('freqWeekly')}</option>
              <option value="fortnight" ${sp.orderFrequency === 'fortnight' ? 'selected' : ''}>${t('freqFortnight')}</option>
              <option value="monthly" ${sp.orderFrequency === 'monthly' ? 'selected' : ''}>${t('freqMonthly')}</option>
            </select>
          </td>
          <td style="white-space:nowrap;">
            <span class="del-link" onclick="saveEditParty('${sp.id}')" style="color:var(--safe);margin-right:8px;">${t('btnSave')}</span>
            <span class="del-link" onclick="cancelEditParty()">${t('btnCancel')}</span>
          </td>
        </tr>
      `;
    }
    return `
      <tr>
        <td class="row-name">${sp.name}</td>
        <td>${sp.contact || '—'}</td>
        <td class="row-note">${sp.note || '—'}</td>
        <td>${t(sp.orderFrequency === 'fortnight' ? 'freqFortnight' : (sp.orderFrequency === 'monthly' ? 'freqMonthly' : 'freqWeekly'))}</td>
        <td class="row-action" style="white-space:nowrap;">
          <span class="del-link" onclick="startEditParty('${sp.id}')" style="margin-right:6px;">${t('btnEdit')}</span>
          <span class="del-link" onclick="togglePartyProductPanel('${sp.id}')" style="margin-right:6px;">${openPartyProductPanelId === sp.id ? t('btnCollapseProductList') : t('btnSetOrderableProducts')}</span>
          <button onclick="deleteParty('${sp.id}')" title="${t('deletePartyTitle')}">✕</button>
        </td>
      </tr>
      ${openPartyProductPanelId === sp.id ? `<tr><td colspan="5">${renderPartyProductPanelHtml(sp)}</td></tr>` : ''}
    `;
  }).join('');
  container.innerHTML = `
    <table class="stock-table">
      <thead><tr><th>${t('fieldPartyName')}</th><th>${t('colPartyContact')}</th><th>${t('colNote')}</th><th>${t('colOrderFrequency')}</th><th></th></tr></thead>
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
    <thead><tr><th>${t('fieldSupplierName')}</th><th>${t('fieldSupplierPhone')}</th><th>${t('fieldSupplierAddress')}</th><th>${t('fieldSupplierNote')}</th><th></th></tr></thead>
    <tbody>
      ${sorted.map(s => `
        <tr>
          <td>${escapeHtmlForPrint(s.name)}</td>
          <td>${escapeHtmlForPrint(s.phone || '')}</td>
          <td>${escapeHtmlForPrint(s.address || '')}</td>
          <td>${escapeHtmlForPrint(s.note || '')}</td>
          <td style="white-space:nowrap;">
            <span class="del-link" onclick="openSupplierEditModal('${s.id}')">${t('btnEdit')}</span>
            &nbsp;·&nbsp;
            <span class="del-link" onclick="deleteSupplier('${s.id}')">${t('btnDelete')}</span>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table>`;
}

let editingSupplierId = null;
function openSupplierEditModal(supplierId){
  editingSupplierId = supplierId;
  const s = supplierId ? purchaseSuppliers.find(x => x.id === supplierId) : null;
  document.getElementById('supplierEditModalTitle').textContent = s ? t('modalEditSupplierTitle') : t('modalAddSupplierTitle');
  document.getElementById('supplierNameInput').value = s ? s.name : '';
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
  const phone = document.getElementById('supplierPhoneInput').value.trim();
  const address = document.getElementById('supplierAddressInput').value.trim();
  const note = document.getElementById('supplierNoteInput').value.trim();
  if(!name){ msgEl.className = 'msg error'; msgEl.textContent = t('errEnterSupplierName'); return; }
  // 名稱不能跟其他供應商重複(資料庫本身也有唯一索引擋著,這裡先在前端擋一次,錯誤訊息比較
  // 好懂,不用等資料庫回傳一串技術性的錯誤)——編輯自己的話,名稱沒變不算重複。
  const dup = purchaseSuppliers.find(s => s.id !== editingSupplierId && s.name.toLowerCase() === name.toLowerCase());
  if(dup){ msgEl.className = 'msg error'; msgEl.textContent = t('errSupplierNameDuplicate'); return; }

  msgEl.className = 'msg'; msgEl.textContent = t('savingMsg');
  const s = editingSupplierId ? purchaseSuppliers.find(x => x.id === editingSupplierId) : { id: genId() };
  const oldName = s.name;
  s.name = name; s.phone = phone; s.address = address; s.note = note;
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
let forecastQtyDraft = {}; // productId -> 使用者輸入的預計進貨數量(字串,留著畫面切換/重畫時不會歸零)
let forecastVolumeUnit = 'cm3'; // 'cm3'(材積,預設) 或 'm3'(cubic meter)

// 商品箱子體積(cm³):要長寬高三個都有填才算得出來,缺一個就回傳 null(表示這個商品目前
// 沒辦法算體積,畫面上顯示「-」)。體積是看 basis(畫面上實際顯示的代表商品)自己填的尺寸,
// 跟名稱/單位一樣的判斷方式。
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

function renderForecastTable(){
  const container = document.getElementById('forecastTableContainer');
  if(!container) return;
  populateForecastPartyFilter();
  populateForecastCategoryFilter();
  const partyFilter = document.getElementById('forecastPartyFilter') ? document.getElementById('forecastPartyFilter').value : '';
  const catFilter = document.getElementById('forecastCategoryFilter') ? document.getElementById('forecastCategoryFilter').value : '';
  const now = new Date();

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
  // 再依分類篩選(兩個篩選條件是「且」的關係,都有選的話兩個條件都要符合)。
  if(catFilter) items = items.filter(p => (p.category || '未分類') === catFilter);

  items = items.slice().sort(compareProductsBySortMode);

  // 篩選列右邊的「總箱數」「總體積」:交給共用的 updateForecastSummary() 算,避免這裡重複一份邏輯。
  updateForecastSummary();

  if(items.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noProductsToShow')}</div>`;
    return;
  }

  container.innerHTML = `
    <table class="stock-table forecast-table">
      <colgroup>
        <col class="fc-col-name"><col class="fc-col-current"><col class="fc-col-qty"><col class="fc-col-after">
      </colgroup>
      <thead>
        <tr>
          <th>${t('fieldName')}</th>
          <th class="num">${t('colCurrentRemain')}</th>
          <th class="qty-col-header">${t('colForecastQty')}</th>
          <th class="num">${t('colAfterRemain')}</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(p => forecastRowHtml(p, now)).join('')}
      </tbody>
    </table>
  `;
}

// p 一律是「主商品」(family 的錨點,用來算加總庫存/平均出貨);畫面上實際顯示的名稱/SKU/單位,
// 跟庫存總覽一樣改成看「顯示於庫存總覽」目前選的是哪個代表商品(getTotalStockBasisProduct)——
// 如果庫存總覽那邊選的是某個 multipack 子商品當代表,這裡的商品名稱、單位也要跟著換,不能一直
// 顯示主商品自己的名字。draft 數量還是用主商品的 id 存(family 的 key),不會因為代表換了就不見。
function forecastRowHtml(p, now){
  const basis = getTotalStockBasisProduct(p);
  const weight = getBasisWeight(basis, p);
  const rawStock = computeTotalStock(p.id);
  const { avg: rawAvg } = getEffectiveAvg(p, now);
  const currentGauge = gaugeInfo(daysRemaining(rawStock, rawAvg));
  const draftVal = forecastQtyDraft[p.id] != null ? forecastQtyDraft[p.id] : '';
  const enteredQty = parseFloat(draftVal);
  // 使用者填的「預計進貨數量」是用代表商品的單位填的(例如選了 x20 的箱子就是填箱數),
  // 要先乘上加權數換算回主商品自己的單位,才能跟原始庫存量、平均出貨量放在一起算天數。
  const rawAddition = isNaN(enteredQty) ? 0 : enteredQty * weight;
  const afterGauge = gaugeInfo(daysRemaining(rawStock + rawAddition, rawAvg));
  return `
    <tr id="forecastRow_${p.id}">
      <td class="row-name">${basis.sku ? `<span class="sku-badge">${basis.sku}</span>` : ''}${basis.name}</td>
      <td class="num"><span class="dot dot-${currentGauge.cls}" style="margin-right:5px;"></span>${currentGauge.label}</td>
      <td class="qty-col-data">
        <div class="fc-qty-cell-inner">
          <input type="number" min="0" step="1" value="${draftVal}" class="fc-qty-input" id="forecastQtyInput_${p.id}"
            oninput="updateForecastRow('${p.id}')" /><span class="fc-unit-label">${basis.unit}</span>
        </div>
      </td>
      <td class="num" id="forecastAfterCell_${p.id}"><span class="dot dot-${afterGauge.cls}" style="margin-right:5px;"></span>${afterGauge.label}</td>
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
  const basis = getTotalStockBasisProduct(p);
  const weight = getBasisWeight(basis, p);
  const rawStock = computeTotalStock(p.id);
  const { avg: rawAvg } = getEffectiveAvg(p, new Date());
  const qty = parseFloat(input.value);
  const rawAddition = isNaN(qty) ? 0 : qty * weight;
  const afterGauge = gaugeInfo(daysRemaining(rawStock + rawAddition, rawAvg));
  const cell = document.getElementById(`forecastAfterCell_${productId}`);
  if(cell) cell.innerHTML = `<span class="dot dot-${afterGauge.cls}" style="margin-right:5px;"></span>${afterGauge.label}`;

  updateForecastSummary();
}

// 只重算、重畫上面那條「總箱數 / 總體積」的加總小字,不動整個表格(避免打字時整表重畫打斷輸入)。
function updateForecastSummary(){
  const summaryBar = document.getElementById('forecastSummaryBar');
  if(!summaryBar) return;
  const partyFilter = document.getElementById('forecastPartyFilter') ? document.getElementById('forecastPartyFilter').value : '';
  const catFilter = document.getElementById('forecastCategoryFilter') ? document.getElementById('forecastCategoryFilter').value : '';
  let items = products.filter(p => !p.parentId && !p.hidden);
  if(partyFilter){
    const productIdsFromParty = new Set(
      transactions.filter(tItem => tItem.type === 'in' && (tItem.party || '').trim() === partyFilter).map(tItem => tItem.productId)
    );
    items = items.filter(p => productIdsFromParty.has(p.id));
  }
  if(catFilter) items = items.filter(p => (p.category || '未分類') === catFilter);

  let totalBoxes = 0, totalVolumeCm3 = 0;
  items.forEach(p => {
    const basis = getTotalStockBasisProduct(p);
    const qty = parseFloat(forecastQtyDraft[p.id]);
    if(!isNaN(qty)){
      totalBoxes += qty;
      const boxVol = computeBoxVolumeCm3(basis);
      if(boxVol !== null) totalVolumeCm3 += boxVol * qty;
    }
  });

  summaryBar.innerHTML = `
    <span>${t('lblTotalBoxes')}<strong>${totalBoxes ? totalBoxes.toLocaleString() : '0'}</strong></span>
    <span style="margin-left:14px;">${t('lblTotalVolume')}<strong>${formatForecastVolume(totalVolumeCm3 || 0)}</strong></span>
    <select id="forecastVolumeUnitSelect" onchange="forecastVolumeUnit=this.value;renderForecastTable();" style="margin-left:8px;font-size:13.5px;padding:3px 5px;">
      <option value="cm3" ${forecastVolumeUnit === 'cm3' ? 'selected' : ''}>cm³ (${t('lblVolumeDefaultUnit')})</option>
      <option value="m3" ${forecastVolumeUnit === 'm3' ? 'selected' : ''}>m³ (cubic meter)</option>
    </select>
  `;
}
