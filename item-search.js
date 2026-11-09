// ============================================================
// 商品查詢(Item search)— 快捷分頁裡的一張卡片,點進去是這個頁面。
//   · 搜尋商品名 / SKU / 條碼(掃碼槍掃一下就會直接選到那個商品)
//   · 選到商品後:圖片、庫存數量、目前定價、進出貨紀錄按鈕(定價要有「顯示價錢」權限、進出貨按鈕要有歷史紀錄權限)
//   · By location:每個位置 × 批次一行(位置、數量、有效期、成本),依有效期由舊到新(先到期的在上面)
//   · By batch:每個批次一行(總數量、有效期、單位成本、成本合計),底下列出這批在各位置的數量
//   · 成本欄位跟其他頁面一樣,沒有「顯示價錢」權限的人看不到(cost-col)
// 沒開批次追蹤時:只有 By location(只有位置和數量,沒有有效期與成本)。
// ============================================================
let isState = { q: '', pid: '', view: 'location' };

function isUnitOf(pid){ const p = products.find(x => x.id === pid); return p ? (p.unit || '') : ''; }
function isQty(n){ return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
function isMoney(n){ return (typeof batchFmtMoney === 'function') ? batchFmtMoney(n) : (n === null || n === undefined ? '–' : '$' + Number(n).toFixed(2)); }
function isHasBatch(){ return typeof batchActive === 'function' && batchActive(); }
function isFefo(a, b){ return (typeof batchFefoCompare === 'function') ? batchFefoCompare(a, b) : 0; }
function isLogAllowed(){ return typeof lookoutTabAllowed === 'function' && lookoutTabAllowed('tab-log'); }

function itemSearchOpen(){
  const root = document.getElementById('itemSearchRoot'), grid = document.getElementById('lookoutRoot'), desc = document.getElementById('lookoutDescP');
  if(!root) return;
  if(grid) grid.style.display = 'none';
  if(desc) desc.style.display = 'none';
  root.style.display = '';
  isState = { q: '', pid: '', view: 'location' };
  itemSearchRender();
  if(typeof ensureBatchDataLoaded === 'function'){
    // 重新讀一次批次資料,數量才是最新的(別人剛出貨 / 進貨的)
    Promise.resolve(ensureBatchDataLoaded(true)).then(() => { if(isState.pid) itemSearchRenderDetail(); }).catch(() => {});
  }
}
function itemSearchClose(){
  const root = document.getElementById('itemSearchRoot'), grid = document.getElementById('lookoutRoot'), desc = document.getElementById('lookoutDescP');
  if(root){ root.style.display = 'none'; root.innerHTML = ''; }
  if(grid) grid.style.display = '';
  if(desc) desc.style.display = '';
}
function itemSearchRender(){
  const root = document.getElementById('itemSearchRoot'); if(!root) return;
  root.innerHTML = `<div style="margin:0 0 12px;"><span class="batch-link" onclick="itemSearchClose()">← ${t('itemSearchBack')}</span></div>
    <div class="section-title" style="margin-top:0;">${t('itemSearchTitle')}</div>
    <div style="position:relative;max-width:520px;">
      <input type="search" id="itemSearchInput" autocomplete="off" placeholder="${esc(t('itemSearchPh'))}" value="${esc(isState.q)}"
        oninput="itemSearchOnInput(this.value)" onkeydown="itemSearchOnKey(event)" style="width:100%;box-sizing:border-box;" />
      <div id="itemSearchList" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:30;background:#fff;border:1px solid var(--line);max-height:320px;overflow:auto;box-shadow:0 4px 12px rgba(0,0,0,0.12);"></div>
    </div>
    <div id="itemSearchDetail" style="margin-top:14px;"></div>`;
  itemSearchRenderDetail();
  const inp = document.getElementById('itemSearchInput'); if(inp && !isState.pid) inp.focus();
}
// 符合搜尋字的商品(商品名 / SKU / 條碼);條碼或 SKU 完全一樣的排最前面
function itemSearchMatches(q){
  const k = String(q || '').trim().toLowerCase();
  if(!k) return [];
  const score = p => {
    const bc = String(p.barcode || '').toLowerCase(), sku = String(p.sku || '').toLowerCase(), nm = String(p.name || '').toLowerCase();
    if(bc && bc === k) return 0;
    if(sku && sku === k) return 1;
    if(nm.startsWith(k)) return 2;
    if(nm.includes(k) || sku.includes(k) || (bc && bc.includes(k))) return 3;
    return 9;
  };
  return products.filter(p => !p.hidden).map(p => ({ p, s: score(p) })).filter(x => x.s < 9)
    .sort((a, b) => a.s - b.s || String(a.p.name).localeCompare(String(b.p.name))).map(x => x.p);
}
function itemSearchOnInput(v){
  isState.q = v;
  const list = document.getElementById('itemSearchList'); if(!list) return;
  const ms = itemSearchMatches(v).slice(0, 30);
  if(!String(v).trim()){ list.style.display = 'none'; return; }
  list.style.display = '';
  list.innerHTML = ms.length ? ms.map(p => `<div style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--line);" onmousedown="itemSearchPick('${esc(p.id)}')">
      ${p.parentId ? '⧉ ' : ''}${esc(p.name)}${p.sku ? ` <span style="color:var(--ink-soft);font-size:11.5px;">${esc(p.sku)}</span>` : ''}</div>`).join('')
    : `<div style="padding:8px 10px;color:var(--ink-soft);">${t('searchNoMatch')}</div>`;
}
// Enter:掃碼槍掃完會送 Enter,條碼 / SKU 完全一樣就直接選;只有一個結果也直接選
function itemSearchOnKey(ev){
  if(ev.key !== 'Enter') return;
  ev.preventDefault();
  const ms = itemSearchMatches(ev.target.value);
  const k = String(ev.target.value || '').trim().toLowerCase();
  const exact = ms.find(p => String(p.barcode || '').toLowerCase() === k || String(p.sku || '').toLowerCase() === k);
  if(exact) return itemSearchPick(exact.id);
  if(ms.length === 1) return itemSearchPick(ms[0].id);
  if(ms.length === 0) showInfoModal(t('itemSearchNotFound'));
}
function itemSearchPick(pid){
  isState.pid = pid; isState.q = '';
  const p = products.find(x => x.id === pid);
  const inp = document.getElementById('itemSearchInput'); if(inp) inp.value = p ? p.name : '';
  const list = document.getElementById('itemSearchList'); if(list) list.style.display = 'none';
  itemSearchRenderDetail();
}
function itemSearchSetView(v){ isState.view = v; itemSearchRenderDetail(); }

// 目前定價:下一批會出的貨(先到期先出)的售價;依 Price Setting 計價時就是設定的售價。沒有「顯示價錢」權限不顯示。
function itemSearchPriceText(pid){
  try{
    if(typeof spPriceCalc !== 'function' || typeof spPriceable !== 'function' || !spPriceable(pid)) return '–';
    const c = spPriceCalc(pid, 1, null, 0);
    return c && c.base !== null ? spMoney(c.base) : '–';
  }catch(e){ return '–'; }
}
function itemSearchRenderDetail(){
  const box = document.getElementById('itemSearchDetail'); if(!box) return;
  const p = products.find(x => x.id === isState.pid);
  if(!p){ box.innerHTML = ''; return; }
  const unit = esc(p.unit || '');
  let stock = 0; try{ stock = computeStock(p.id); }catch(e){}
  const canPrice = typeof canViewPrice === 'function' && canViewPrice();
  const batchOn = isHasBatch();
  if(!batchOn && isState.view === 'batch') isState.view = 'location';
  box.innerHTML = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
      ${p.photoUrl ? `<img src="${esc(p.photoUrl)}" alt="" style="width:140px;height:140px;object-fit:cover;border:1px solid var(--line);border-radius:6px;cursor:pointer;" onclick="openProductPhotoModal('${esc(p.id)}')" />` : ''}
      <div style="flex:1;min-width:220px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px;">${esc(p.name)}</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:10px;">${p.sku ? 'SKU ' + esc(p.sku) : ''}${p.sku && p.barcode ? ' · ' : ''}${p.barcode ? t('fieldBarcode') + ' ' + esc(p.barcode) : ''}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <div style="border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:120px;"><div style="font-size:11px;color:var(--ink-soft);">${t('itemSearchStock')}</div><div style="font-size:18px;font-weight:700;">${isQty(stock)} ${unit}</div></div>
          ${canPrice ? `<div style="border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:120px;"><div style="font-size:11px;color:var(--ink-soft);">${t('itemSearchPrice')}</div><div style="font-size:18px;font-weight:700;">${itemSearchPriceText(p.id)}</div></div>` : ''}
        </div>
        ${isLogAllowed() ? `<div style="margin-top:10px;"><button class="btn ghost" onclick="itemSearchGoLog('${esc(p.id)}')">${t('itemSearchTxLog')}</button></div>` : ''}
      </div>
    </div>
    <div style="margin:16px 0 8px;" class="batch-seg">
      <button type="button" class="${isState.view === 'location' ? 'active' : ''}" onclick="itemSearchSetView('location')">${t('itemSearchByLocation')}</button>
      ${batchOn ? `<button type="button" class="${isState.view === 'batch' ? 'active' : ''}" onclick="itemSearchSetView('batch')">${t('itemSearchByBatch')}</button>` : ''}
    </div>
    <div id="itemSearchTable">${isState.view === 'batch' ? itemSearchBatchHtml(p) : itemSearchLocationHtml(p)}</div>`;
}

// 這個商品有庫存的批次(先到期先出排序),以及它們在各位置的剩餘量
function itemSearchBatchRows(pid){
  const items = batchItemsOfProduct(pid, false).slice().sort(isFefo);
  return items.map(i => {
    const locs = (batchItemLocRem[i.id] || []).filter(l => l.rem > 1e-9).slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const placed = locs.reduce((s, l) => s + l.rem, 0);
    const noLoc = Math.max(0, i.remaining - placed);
    const unitCost = (typeof spTotalUnit === 'function') ? spTotalUnit(i) : null;
    return { i, locs, noLoc, unitCost };
  });
}
function itemSearchLocationHtml(p){
  const unit = esc(p.unit || '');
  if(!isHasBatch()){
    const locs = productLocations.filter(l => l.productId === p.id && Number(l.qty) > 0).sort((a, b) => String(a.locationCode).localeCompare(String(b.locationCode)));
    if(!locs.length) return `<div class="empty-note">${t('itemSearchNoStock')}</div>`;
    return `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('itemSearchColLocation')}</th><th class="num">${t('itemSearchColQty')}</th></tr></thead><tbody>
      ${locs.map(l => `<tr><td>${esc(l.locationCode)}</td><td class="num">${isQty(l.qty)} ${unit}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const rows = [];
  itemSearchBatchRows(p.id).forEach(r => {
    r.locs.forEach(l => rows.push({ code: l.code, qty: l.rem, i: r.i, unitCost: r.unitCost }));
    if(r.noLoc > 1e-9) rows.push({ code: '', qty: r.noLoc, i: r.i, unitCost: r.unitCost });
  });
  if(!rows.length) return `<div class="empty-note">${t('itemSearchNoStock')}</div>`;
  const totQty = rows.reduce((s, r) => s + r.qty, 0);
  let totVal = 0, missing = 0; rows.forEach(r => { if(r.unitCost === null) missing++; else totVal += r.unitCost * r.qty; });
  return `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr>
      <th>${t('itemSearchColLocation')}</th><th>${t('batchColBatch')}</th><th class="num">${t('itemSearchColQty')}</th><th>${t('batchColExpiry')}</th>
      <th class="num cost-col">${t('itemSearchColUnitCost')}</th><th class="num cost-col">${t('itemSearchColCostTotal')}</th></tr></thead><tbody>
    ${rows.map(r => `<tr>
      <td>${r.code ? esc(r.code) : `<span style="color:var(--ink-soft);">${t('itemSearchNoLocation')}</span>`}</td>
      <td>${esc(r.i.batchNo)}${r.i.isOpening ? ' <span style="color:var(--ink-soft);font-size:11px;">(' + t('batchOpening') + ')</span>' : ''}</td>
      <td class="num">${isQty(r.qty)} ${unit}</td>
      <td>${r.i.expiry ? esc(r.i.expiry) + (typeof batchExpiryBadge === 'function' ? batchExpiryBadge(r.i.expiry, true) : '') : '–'}</td>
      <td class="num cost-col">${r.unitCost === null ? '–' : isMoney(r.unitCost)}</td>
      <td class="num cost-col">${r.unitCost === null ? '–' : isMoney(r.unitCost * r.qty)}</td></tr>`).join('')}
    </tbody><tfoot><tr style="font-weight:700;"><td colspan="2">${t('invListTotals')}</td><td class="num">${isQty(totQty)} ${unit}</td><td></td><td class="num cost-col"></td><td class="num cost-col">${isMoney(totVal)}${missing ? ' <span style="font-weight:400;color:var(--ink-soft);font-size:11px;">(' + tf('itemSearchMissingCost', { n: missing }) + ')</span>' : ''}</td></tr></tfoot></table></div>`;
}
function itemSearchBatchHtml(p){
  const unit = esc(p.unit || '');
  const rows = itemSearchBatchRows(p.id);
  if(!rows.length) return `<div class="empty-note">${t('itemSearchNoStock')}</div>`;
  const totQty = rows.reduce((s, r) => s + r.i.remaining, 0);
  let totVal = 0, missing = 0; rows.forEach(r => { if(r.unitCost === null) missing++; else totVal += r.unitCost * r.i.remaining; });
  return `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr>
      <th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('itemSearchColQty')}</th><th>${t('itemSearchColLocation')}</th>
      <th class="num cost-col">${t('itemSearchColUnitCost')}</th><th class="num cost-col">${t('itemSearchColCostTotal')}</th></tr></thead><tbody>
    ${rows.map(r => {
      const locLines = r.locs.map(l => `<div>${esc(l.code)} · <b>${isQty(l.rem)}</b> ${unit}</div>`).join('') + (r.noLoc > 1e-9 ? `<div style="color:var(--ink-soft);">${t('itemSearchNoLocation')} · <b>${isQty(r.noLoc)}</b> ${unit}</div>` : '');
      return `<tr>
      <td style="vertical-align:top;">${esc(r.i.batchNo)}${r.i.isOpening ? ' <span style="color:var(--ink-soft);font-size:11px;">(' + t('batchOpening') + ')</span>' : ''}</td>
      <td style="vertical-align:top;">${r.i.expiry ? esc(r.i.expiry) + (typeof batchExpiryBadge === 'function' ? batchExpiryBadge(r.i.expiry, true) : '') : '–'}</td>
      <td class="num" style="vertical-align:top;"><b>${isQty(r.i.remaining)}</b> ${unit}</td>
      <td style="font-size:12.5px;vertical-align:top;">${locLines || '–'}</td>
      <td class="num cost-col" style="vertical-align:top;">${r.unitCost === null ? '–' : isMoney(r.unitCost)}</td>
      <td class="num cost-col" style="vertical-align:top;">${r.unitCost === null ? '–' : isMoney(r.unitCost * r.i.remaining)}</td></tr>`;
    }).join('')}
    </tbody><tfoot><tr style="font-weight:700;"><td colspan="2">${t('invListTotals')}</td><td class="num">${isQty(totQty)} ${unit}</td><td></td><td class="num cost-col"></td><td class="num cost-col">${isMoney(totVal)}${missing ? ' <span style="font-weight:400;color:var(--ink-soft);font-size:11px;">(' + tf('itemSearchMissingCost', { n: missing }) + ')</span>' : ''}</td></tr></tfoot></table></div>`;
}

// 進出貨紀錄:跳到歷史紀錄 → 進出貨紀錄,商品篩選成這個商品(其他篩選清掉)
async function itemSearchGoLog(pid){
  if(!isLogAllowed()) return;
  const p = products.find(x => x.id === pid); if(!p) return;
  switchTab('tab-log');
  switchLogSubTab('subtab-log-tx');
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
  set('logCategoryFilter', ''); set('logTypeFilter', ''); set('logPartyFilter', ''); set('logDateFrom', ''); set('logDateTo', '');
  const showAll = document.getElementById('logShowAllCatalog'); if(showAll && p.hidden) showAll.checked = true;
  try{ await ensureTransactionsLoadedFrom(''); }catch(e){}
  set('logFilter', '');
  renderLog();                                   // 先重畫一次,商品下拉選單才有這個商品的選項
  const sel = document.getElementById('logFilter');
  if(sel && Array.from(sel.options).some(o => o.value === pid)){ sel.value = pid; renderLog(); }
}
