// ============================================================
// Sell price(售價)
//
// 批次的 Total price(進貨底價 + 分攤的其他支出)× (1 + margin%) = Sell price。
// - margin 是「每個批次」一個數字(batches.margin_pct),新批次建立時先帶入預設值(系統預設 margin,
//   app_data 'batchDefaultMargin'),之後可以在批次頁手動改;沒設定過的舊批次用目前的預設值。
// - 訂單商品的售價 = 用到的批次 Sell price 依用量加權平均 × (1 − 出貨方 Discount%)。
// - 「Sell price 顯示方式」(系統設置,app_data 'sellPriceMode':none / export / all)決定新增訂單 / 待處理訂單 / 已完成訂單
//   要不要顯示售價;批次頁的 margin / Sell price 不受這個開關影響。
// 依賴:batch-tracking.js(批次資料與分配預覽)。
// ============================================================
// Sell price 顯示方式(系統設置):'none' 不顯示 / 'export' 僅已完成訂單的匯出檔案顯示 / 'all' 訂單畫面與匯出都顯示
let spSellPriceMode = 'none';
let spDefaultMarginPct = 0;
// Sell price 依據(系統設置,app_data 'sellPriceBasis'):'batch' = 依批次成本 + 批次 margin 計算(預設)/ 'setting' = 用 Price Setting 頁面設定的價格
let spSellBasis = 'batch';
// 警示 margin(%,app_data 'sellWarnMargin'):Price Setting 裡 margin 低於這個值會顯示警示圖案
let spWarnMarginPct = 0;
// Price Setting 的價格:{ 商品id: 售價 }(app_data 'priceSettings')
let spPriceMap = {};
// Price Setting 依據下,手動輸入過 margin 的批次:{ 批次id: margin% }(app_data 'batchMarginManual');沒在這裡的批次 margin 一律顯示空白
let spManualMargins = {};

async function loadSellPriceSettings(){
  try{
    const r = await dbGet('sellPriceMode');
    if(r && ['none', 'export', 'all'].includes(String(r.value))) spSellPriceMode = String(r.value);
    else {
      // 舊版的勾選開關(showSellPrice = true)等於「訂單跟匯出都顯示」
      const old = await dbGet('showSellPrice');
      if(old && String(old.value) === 'true') spSellPriceMode = 'all';
    }
  } catch(e){}
  try{
    const r = await dbGet('batchDefaultMargin');
    const n = r && r.value !== undefined && r.value !== null ? Number(r.value) : NaN;
    if(Number.isFinite(n) && n >= 0) spDefaultMarginPct = n;
  } catch(e){}
  try{
    const r = await dbGet('sellWarnMargin');
    const n = r && r.value !== undefined && r.value !== null ? Number(r.value) : NaN;
    if(Number.isFinite(n)) spWarnMarginPct = n;
  } catch(e){}
  try{
    const r = await dbGet('sellPriceBasis');
    if(r && ['batch', 'setting'].includes(String(r.value))) spSellBasis = String(r.value);
  } catch(e){}
  try{
    const r = await dbGet('batchMarginManual');
    const m = r && r.value ? JSON.parse(r.value) : null;
    if(m && typeof m === 'object' && !Array.isArray(m)){
      spManualMargins = {};
      Object.keys(m).forEach(k => { const v = Number(m[k]); if(Number.isFinite(v)) spManualMargins[k] = v; });
    }
  } catch(e){}
  try{
    const r = await dbGet('priceSettings');
    const m = r && r.value ? JSON.parse(r.value) : null;
    if(m && typeof m === 'object' && !Array.isArray(m)){
      spPriceMap = {};
      Object.keys(m).forEach(k => { const v = Number(m[k]); if(Number.isFinite(v) && v >= 0) spPriceMap[k] = v; });
    }
  } catch(e){}
}
function spDefaultMargin(){ return spDefaultMarginPct; }
function spWarnMargin(){ return spWarnMarginPct; }
function spIsSettingBasis(){ return spSellBasis === 'setting'; }
// Price Setting 裡這個商品的售價;沒設定回傳 null
function spSettingPrice(pid){
  const v = spPriceMap[pid];
  return (v === undefined || v === null || !Number.isFinite(Number(v))) ? null : Number(v);
}
// 這個商品算得出售價嗎(依批次 cost,或 Price Setting 有設定)
function spPriceable(pid){
  if(spIsSettingBasis()) return spSettingPrice(pid) !== null || (typeof batchIsTracked === 'function' && batchIsTracked(pid));
  return typeof batchIsTracked === 'function' && batchIsTracked(pid);
}
// 要不要在訂單畫面顯示售價(開關打開、而且批次追蹤可用)
function spEnabled(){ return spSellPriceMode === 'all' && typeof batchActive === 'function' && batchActive(); }
// 已完成訂單的匯出檔案要不要多一欄 Sell price('export' 或 'all')
function spExportEnabled(){ return (spSellPriceMode === 'export' || spSellPriceMode === 'all') && typeof batchActive === 'function' && batchActive(); }

function spRound2(n){ return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
// 批次的 margin:依批次成本計價時,沒設定過就用系統預設 margin;依 Price Setting 計價時,沒手動輸入過就是 null(顯示空白)
function spMarginOf(item){
  if(spIsSettingBasis()){
    const v = item ? spManualMargins[item.batchId] : undefined;
    return (v === undefined || v === null || !Number.isFinite(Number(v))) ? null : Number(v);
  }
  const m = item && item.marginPct;
  return (m === null || m === undefined || !Number.isFinite(Number(m))) ? spDefaultMarginPct : Number(m);
}
// 這個批次商品行的 Total price(單價)/ Sell price(單價);沒有成本資料回傳 null
function spTotalUnit(item){
  const c = (typeof batchUnitCost === 'function') ? batchUnitCost(item) : null;
  return (c === null || c === undefined || !Number.isFinite(Number(c))) ? null : Number(c);
}
function spSellUnit(item){
  if(spIsSettingBasis()) return item ? spSettingPrice(item.productId) : null;
  const c = spTotalUnit(item);
  return c === null ? null : spRound2(c * (1 + spMarginOf(item) / 100));
}
function spMoney(n){ return (n === null || n === undefined) ? '–' : ((typeof batchFmtMoney === 'function') ? batchFmtMoney(n) : spRound2(n).toFixed(2)); }

// ---- 批次頁:margin 與預設值 ----
async function spSaveBatchMargin(batchId, raw){
  const v = String(raw).trim();
  const n = Number(v);
  if(v === '' || !Number.isFinite(n) || n < 0 || n > 1000){ showInfoModal(t('spMarginInvalid')); renderBatchTracker(); return; }
  try{
    await batchRpc('batch_set_margin', { p_batch_id: batchId, p_margin: n, p_only_if_null: false });
    batchData.items.forEach(i => { if(i.batchId === batchId) i.marginPct = n; });
  } catch(e){
    console.error('儲存 margin 失敗', e);
    showInfoModal(/batch_set_margin|margin_pct/i.test((e && e.message) || '') ? t('spMarginNeedSql') : t('spMarginSaveFailed'));
  }
  renderBatchTracker();
}
// ---- 單價欄:顯示 Total price,點擊看 Base price / 其他支出分攤 / Total price / Margin / Sell price ----
function spPriceCellHtml(i){
  const total = spTotalUnit(i);
  if(total === null) return '–';
  return `<span class="batch-link" title="${batchEsc(t('spPriceClickHint'))}" onclick="spShowPricePopup('${i.id}')">${spMoney(total)}</span>`;
}
function spShowPricePopup(itemId){
  const i = batchData.items.find(x => x.id === itemId);
  if(!i) return;
  const old = document.getElementById('spPriceOverlay'); if(old) old.remove();
  const base = (i.unitCostBase === null || i.unitCostBase === undefined) ? null : Number(i.unitCostBase);
  const total = spTotalUnit(i);
  const extra = (total !== null && base !== null) ? total - base : null;
  const settingBasis = spIsSettingBasis();
  const sellNow = spSellUnit(i);
  // 依 Price Setting 計價時,margin 是「Price Setting 售價相對這個批次成本」算出來的
  const margin = settingBasis ? ((sellNow !== null && total !== null && total > 0) ? spRound2((sellNow / total - 1) * 100) : null) : spMarginOf(i);
  const ov = document.createElement('div');
  ov.id = 'spPriceOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  ov.onclick = e => { if(e.target === ov) ov.remove(); };
  const row = (label, val, strong) => `<tr><td>${label}</td><td class="num" ${strong ? 'style="font-weight:700;"' : ''}>${val}</td></tr>`;
  ov.innerHTML = `<div class="modal-box" style="max-width:min(420px,92vw);">
    <div class="section-title" style="margin-top:0;">${batchEsc(batchProductName(i.productId))} · ${batchEsc(i.batchNo)}</div>
    <table class="stock-table"><tbody>
      ${row(t('spBasePrice'), spMoney(base))}
      ${row(t('spExtraCosts'), extra === null ? '–' : spMoney(extra))}
      ${row(t('spTotalPrice'), spMoney(total), true)}
      ${row('Margin', margin === null ? '–' : margin + '%')}
      ${row('Sell price', spMoney(sellNow), true)}
    </tbody></table>
    <p style="font-size:11.5px;color:var(--ink-soft);margin:8px 0 0;">${settingBasis ? t('spPopupNoteSetting') : 'Sell price = Total price × (1 + Margin%)'}</p>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('spPriceOverlay').remove()">${t('btnClose')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}

// ---- 系統設置:Sell price(顯示方式 / 依據 / Margin 設置,同一個區塊)----
function renderSellPriceSetting(){
  document.querySelectorAll('input[name="sellPriceMode"]').forEach(r => { r.checked = (r.value === spSellPriceMode); });
  document.querySelectorAll('input[name="sellPriceBasis"]').forEach(r => { r.checked = (r.value === spSellBasis); });
  const dm = document.getElementById('spDefaultMarginSetting'); if(dm && document.activeElement !== dm) dm.value = String(spDefaultMarginPct);
  const wm = document.getElementById('spWarnMarginSetting'); if(wm && document.activeElement !== wm) wm.value = String(spWarnMarginPct);
  const card = document.getElementById('sellPriceSettingCard');
  if(card) card.style.display = (typeof batchFeatureOn === 'function' && batchFeatureOn()) ? '' : 'none';
}
// 選項說明太長,不直接顯示,點旁邊的 ⓘ 才跳出視窗
function spShowModeHelp(mode){
  const key = { export: 'sellPriceModeExportHelp', all: 'sellPriceModeAllHelp', none: 'sellPriceModeNoneHelp', basisBatch: 'sellBasisBatchHelp', basisSetting: 'sellBasisSettingHelp' }[mode];
  if(key) showInfoModal(t(key));
}
async function applySellPriceMode(mode){
  if(!['none', 'export', 'all'].includes(mode)) return;
  spSellPriceMode = mode;
  try{ await dbSet('sellPriceMode', mode); } catch(e){ console.error('儲存失敗', e); }
  try{ if(typeof renderAll === 'function') renderAll(); }catch(e){}
}
// Sell price 依據:batch(批次成本 + margin)/ setting(Price Setting)。切換前先確認。
function applySellBasis(basis){
  if(!['batch', 'setting'].includes(basis) || basis === spSellBasis){ renderSellPriceSetting(); return; }
  showConfirmModal(t(basis === 'setting' ? 'sellBasisConfirmSetting' : 'sellBasisConfirmBatch'), async () => {
    spSellBasis = basis;
    try{ await dbSet('sellPriceBasis', basis); } catch(e){ console.error('儲存失敗', e); showInfoModal(t('spMarginSaveFailed')); spSellBasis = basis === 'setting' ? 'batch' : 'setting'; }
    renderSellPriceSetting();
    spRefreshAfterBasisChange();
  }, () => renderSellPriceSetting());
}
function spRefreshAfterBasisChange(){
  try{ if(typeof renderAll === 'function') renderAll(); }catch(e){}
  try{ if(typeof renderBatchTracker === 'function' && document.getElementById('batchTrackerRoot')) renderBatchTracker(); }catch(e){}
  try{ if(typeof psRenderPage === 'function') psRenderPage(); }catch(e){}
}
// 預設 margin / 警示 margin
async function spApplyMarginSettings(which, raw){
  const msg = document.getElementById('spMarginSettingMsg');
  const v = String(raw).trim(), n = Number(v);
  const bad = v === '' || !Number.isFinite(n) || n > 1000 || (which === 'default' && n < 0) || n < -100;
  if(bad){ if(msg){ msg.className = 'msg error'; msg.textContent = t('spMarginInvalid'); } renderSellPriceSetting(); return; }
  try{
    if(which === 'default'){ spDefaultMarginPct = n; await dbSet('batchDefaultMargin', String(n)); }
    else { spWarnMarginPct = n; await dbSet('sellWarnMargin', String(n)); }
    if(msg){ msg.className = 'msg ok'; msg.textContent = t('spMarginSettingSaved'); setTimeout(() => { if(msg.textContent === t('spMarginSettingSaved')) msg.textContent = ''; }, 2500); }
  } catch(e){ console.error('儲存失敗', e); if(msg){ msg.className = 'msg error'; msg.textContent = t('spMarginSaveFailed'); } }
  try{ if(typeof psRenderPage === 'function') psRenderPage(); }catch(e){}
  try{ if(typeof renderBatchTracker === 'function' && document.getElementById('batchTrackerRoot')) renderBatchTracker(); }catch(e){}
}
// ============================================================
// 訂單商品的售價
// ============================================================
function spPartyDiscountOfOrder(order){
  const sp = (typeof shippingParties !== 'undefined' && order) ? shippingParties.find(x => x.id === order.partyId) : null;
  return (typeof partyDiscountOf === 'function') ? partyDiscountOf(sp) : 0;
}
function spPartyDiscountById(partyId){
  const sp = (typeof shippingParties !== 'undefined') ? shippingParties.find(x => x.id === partyId) : null;
  return (typeof partyDiscountOf === 'function') ? partyDiscountOf(sp) : 0;
}
// 依預計(或指定)的批次分配算加權平均 Sell price,再套出貨方 Discount
// 回傳 { unit, base, discountPct, manual, frozen, lines:[{ batchNo, expiry, qty, ratio, sell }], untracked, unpricedQty }
function spPriceCalc(productId, qty, picks, discountPct){
  if(spIsSettingBasis()){
    // 依 Price Setting:整個商品一個售價,不看批次;批次分配只用來顯示用量
    const sp = spSettingPrice(productId);
    const al = (typeof batchIsTracked === 'function' && batchIsTracked(productId)) ? batchPreviewAllocation(productId, qty, picks) : { lines: [], untracked: 0 };
    const lns = al.lines.map(l => ({ batchNo: l.item.batchNo, isOpening: l.item.isOpening, expiry: l.item.expiry || '', qty: l.qty, sell: sp, manual: !!l.manual }));
    const tq = lns.reduce((x, l) => x + l.qty, 0);
    lns.forEach(l => { l.ratio = tq > 0 ? l.qty / tq : 0; });
    const un = sp === null ? null : spRound2(sp * (1 - (discountPct || 0) / 100));
    return { unit: un, base: sp === null ? null : spRound2(sp), discountPct: discountPct || 0, manual: false, frozen: false, lines: lns, untracked: 0, unpricedQty: sp === null ? qty : 0 };
  }
  const alloc = batchPreviewAllocation(productId, qty, picks);
  const lines = alloc.lines.map(l => ({ batchNo: l.item.batchNo, isOpening: l.item.isOpening, expiry: l.item.expiry || '', qty: l.qty, sell: spSellUnit(l.item), manual: !!l.manual }));
  const priced = lines.filter(l => l.sell !== null);
  const pricedQty = priced.reduce((s, l) => s + l.qty, 0);
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  lines.forEach(l => { l.ratio = totalQty > 0 ? l.qty / totalQty : 0; });
  const base = pricedQty > 0 ? priced.reduce((s, l) => s + l.sell * l.qty, 0) / pricedQty : null;
  const unit = base === null ? null : spRound2(base * (1 - (discountPct || 0) / 100));
  return { unit, base: base === null ? null : spRound2(base), discountPct: discountPct || 0, manual: false, frozen: false, lines, untracked: alloc.untracked, unpricedQty: totalQty - pricedQty };
}
function spPriceOrderItem(order, it){
  const disc = spPartyDiscountOfOrder(order);
  if(it.sellFrozen){
    return { unit: Number.isFinite(Number(it.sellPrice)) ? Number(it.sellPrice) : null, base: null, discountPct: Number(it.sellDiscount) || 0, manual: !!it.sellPriceManual, frozen: true, lines: [], untracked: 0, unpricedQty: 0 };
  }
  // 已核對(已完成)但沒有固定售價的訂單(例如功能上線前的舊訂單):不再依目前批次推算,顯示空白
  if(typeof isPreVerificationStatus === 'function' && !isPreVerificationStatus(order)){
    return { unit: null, base: null, discountPct: disc, manual: false, frozen: false, legacy: true, lines: [], untracked: 0, unpricedQty: 0 };
  }
  if(it.sellPriceManual && Number.isFinite(Number(it.sellPrice))){
    return { unit: Number(it.sellPrice), base: null, discountPct: disc, manual: true, frozen: false, lines: [], untracked: 0, unpricedQty: 0 };
  }
  if(!(it.qty > 0) || !spPriceable(it.productId)) return { unit: null, base: null, discountPct: disc, manual: false, frozen: false, lines: [], untracked: it.qty > 0 ? it.qty : 0, unpricedQty: 0 };
  return spPriceCalc(it.productId, it.qty, it.batchPicks, disc);
}
// 訂單品項後面的售價(可點擊看明細;editable=true 時明細視窗裡可以手動改)
function spOrderPriceHtml(order, it){
  if(!spEnabled() || !order || !it || it.deleted) return '';
  const pr = spPriceOrderItem(order, it);
  const label = pr.unit === null ? '–' : spMoney(pr.unit);
  const mark = pr.manual ? ' ✎' : '';
  return `<span class="batch-link sp-order-price" title="${batchEsc(t('spPriceClickHint'))}" style="margin-left:8px;" onclick="event.stopPropagation();spOpenOrderPricePopup('${order.id}','${it.productId}')">${label}${mark}</span>`;
}
function spCloseOrderPopup(){ const o = document.getElementById('spOrderPriceOverlay'); if(o) o.remove(); }
function spOpenOrderPricePopup(orderId, productId){
  const order = orders.find(o => o.id === orderId);
  const it = order ? order.items.find(x => x.productId === productId && !x.deleted) : null;
  if(!order || !it) return;
  spCloseOrderPopup();
  const pr = spPriceOrderItem(order, it);
  const unit = batchEsc(it.unit || batchProductUnit(productId));
  // 已完成(已固定售價)的訂單不能改;已簽收的訂單也不能改;沒有「編輯價錢」權限只能看
  const canEdit = !pr.frozen && !pr.legacy && !order.signedAt && !order.deleted && canEditPrice();
  let body = '';
  if(pr.frozen){
    body = `<p style="margin:0 0 6px;">Sell price: <strong>${spMoney(pr.unit)}</strong> / ${unit}</p>
      ${pr.discountPct ? `<p style="margin:0;font-size:12px;color:var(--ink-soft);">Discount ${pr.discountPct}%</p>` : ''}
      <p style="margin:8px 0 0;font-size:11.5px;color:var(--ink-soft);">${t('spFrozenNote')}</p>`;
  } else if(pr.legacy){
    body = `<p style="margin:0;font-size:12.5px;color:var(--ink-soft);">${t('spLegacyNote')}</p>`;
  } else {
    const calc = pr.manual ? spPriceCalc(productId, it.qty, it.batchPicks, pr.discountPct) : pr;
    const rows = calc.lines.map(l => `<tr><td>${batchEsc(l.batchNo)}${l.isOpening ? ' (' + t('batchOpening') + ')' : ''}</td><td class="num">${batchFmtQty(l.qty)}</td><td class="num">${Math.round(l.ratio * 1000) / 10}%</td><td class="num">${spMoney(l.sell)}</td></tr>`).join('');
    body = `${(calc.lines.length || spIsSettingBasis()) ? (calc.lines.length ? `<table class="stock-table"><thead><tr><th>${t('batchColBatch')}</th><th class="num">${t('colQty')}</th><th class="num">${t('spRatio')}</th><th class="num">Sell price</th></tr></thead><tbody>${rows}</tbody></table>` : '') : `<div class="empty-note">${t('spNoBatchCost')}</div>`}
      ${calc.untracked > 0 ? `<p style="font-size:11.5px;color:var(--warn-dark,#b45309);margin:6px 0 0;">${t('batchUntracked')}: ${batchFmtQty(calc.untracked)}</p>` : ''}
      ${calc.base !== null ? `<p style="margin:8px 0 2px;font-size:12.5px;">${t('spWeighted')}: <strong>${spMoney(calc.base)}</strong>${calc.discountPct ? ` · Discount ${calc.discountPct}% → <strong>${spMoney(calc.unit)}</strong>` : ''}</p>` : ''}
      ${pr.manual ? `<p style="margin:6px 0 0;font-size:12.5px;color:var(--warn-dark,#b45309);">${t('spManualNow')}: <strong>${spMoney(pr.unit)}</strong></p>` : ''}
      ${canEdit ? `<div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <span>${t('spManualPrice')}</span><input id="spManualPriceInput" type="number" min="0" step="0.01" value="${pr.unit === null ? '' : pr.unit}" style="width:110px;" />
        <button class="btn" onclick="spSaveManualPrice('${orderId}','${productId}')">${t('btnSave')}</button>
        ${pr.manual ? `<button class="btn ghost" onclick="spResetManualPrice('${orderId}','${productId}')">${t('spResetAuto')}</button>` : ''}
      </div>` : ''}`;
  }
  const ov = document.createElement('div');
  ov.id = 'spOrderPriceOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  ov.onclick = e => { if(e.target === ov) spCloseOrderPopup(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:min(460px,92vw);">
    <div class="section-title" style="margin-top:0;">${batchEsc(it.name || batchProductName(productId))} · ${batchFmtQty(it.qty)} ${unit}</div>
    ${body}
    <div class="modal-actions"><button class="btn ghost" onclick="spCloseOrderPopup()">${t('btnClose')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function spRefreshOrderViews(){
  try{ if(typeof renderPendingOrders === 'function') renderPendingOrders(); }catch(e){}
  try{ if(typeof renderOrders === 'function') renderOrders(); }catch(e){}
  try{ if(typeof renderTxExistingItems === 'function' && document.getElementById('txExistingItemsList')) renderTxExistingItems(); }catch(e){}
  try{ if(typeof renderVerifyPage === 'function' && document.getElementById('verifyPageOrderItems')) renderVerifyPage(); }catch(e){}
}
async function spSaveManualPrice(orderId, productId){
  const order = orders.find(o => o.id === orderId);
  const it = order ? order.items.find(x => x.productId === productId && !x.deleted) : null;
  const el = document.getElementById('spManualPriceInput');
  if(!order || !it || !el || !canEditPrice() || order.signedAt) return;
  const n = Number(el.value);
  if(el.value.trim() === '' || !Number.isFinite(n) || n < 0){ showInfoModal(t('spPriceInvalid')); return; }
  it.sellPrice = spRound2(n); it.sellPriceManual = true;
  try{ await upsertOrders([order]); } catch(e){ console.error('儲存售價失敗', e); showInfoModal(t('spMarginSaveFailed')); return; }
  spCloseOrderPopup(); spRefreshOrderViews();
}
async function spResetManualPrice(orderId, productId){
  const order = orders.find(o => o.id === orderId);
  const it = order ? order.items.find(x => x.productId === productId && !x.deleted) : null;
  if(!order || !it || !canEditPrice() || order.signedAt) return;
  delete it.sellPrice; delete it.sellPriceManual;
  try{ await upsertOrders([order]); } catch(e){ console.error('儲存售價失敗', e); showInfoModal(t('spMarginSaveFailed')); return; }
  spCloseOrderPopup(); spRefreshOrderViews();
}
// 登記進出貨清單(尚未建立訂單的品項)用:依出貨方 Discount 與預計批次算售價
function spTxItemPriceHtml(it, partyId){
  if(!spEnabled() || !it || !(it.qty > 0) || !spPriceable(it.productId)) return '–';
  const pr = spPriceCalc(it.productId, it.qty, null, spPartyDiscountById(partyId));
  return pr.unit === null ? '–' : spMoney(pr.unit);
}

// ---- 核對 / 直接建立已完成訂單時,把每個品項的售價固定下來(之後不能改)----
// 用「還沒出貨」當下的批次分配預覽計算(跟資料庫實際分配用同一套先到期先出規則);手動設定過的售價照用。
function spFreezeOne(order, it){
  if(it.deleted) return it;
  const disc = spPartyDiscountOfOrder(order);
  let unit = null, manual = false;
  if(it.sellPriceManual && Number.isFinite(Number(it.sellPrice))){ unit = Number(it.sellPrice); manual = true; }
  else if(it.qty > 0 && typeof batchActive === 'function' && batchActive() && spPriceable(it.productId)){
    unit = spPriceCalc(it.productId, it.qty, it.batchPicks, disc).unit;
  }
  const out = Object.assign({}, it, { sellFrozen: true, sellDiscount: disc, sellPriceManual: manual });
  if(unit === null) delete out.sellPrice; else out.sellPrice = unit;
  return out;
}
function spFreezeItems(order){ return (order.items || []).map(it => spFreezeOne(order, it)); }

// ---- 訂單匯出:每個商品的 Total price(進貨底價 + 分攤的其他支出),依這些訂單實際用到的批次用量加權平均 ----
async function spExportTotalPriceMap(orderList){
  const map = {};
  try{
    if(typeof batchActive !== 'function' || !batchActive()) return map;
    await ensureBatchDataLoaded();
    const ids = orderList.map(o => o.id);
    const acc = {};   // productId -> { sum, qty }
    for(let i = 0; i < ids.length; i += 100){
      const chunk = ids.slice(i, i + 100);
      const { data, error } = await sb.from('batch_movements').select('batch_item_id,qty,kind').in('order_id', chunk).in('kind', ['out', 'return']);
      if(error) throw error;
      (data || []).forEach(m => {
        const item = batchData.items.find(x => x.id === m.batch_item_id);
        const price = item ? spTotalUnit(item) : null;
        if(price === null) return;
        const q = -Number(m.qty);
        const a = acc[item.productId] = acc[item.productId] || { sum: 0, qty: 0 };
        a.sum += price * q; a.qty += q;
      });
    }
    Object.keys(acc).forEach(pid => { if(acc[pid].qty > 1e-9) map[pid] = spRound2(acc[pid].sum / acc[pid].qty); });
  } catch(e){ console.warn('匯出:計算 Total price 失敗,Price 欄位留空', e); }
  return map;
}

// ============================================================
// 訂單商品列的欄位:單價 | 數量 | 總價(單價 × 數量),上面有標題,訂單最下面有總金額
// ============================================================
const SP_UNIT_W = 'width:84px;text-align:right;flex:none;';
const SP_QTY_W = 'min-width:96px;text-align:right;flex:none;';
const SP_TOTAL_W = 'width:96px;text-align:right;flex:none;';
// 總價用粗體 + 淺灰底,跟單價(一般字重、可點擊的底線文字)一眼分得出來
const SP_TOTAL_PILL = 'display:inline-block;padding:1px 8px;border-radius:3px;background:rgba(0,0,0,0.07);font-weight:700;';
const SP_ACTIONS_W = 'width:150px;text-align:right;flex:none;white-space:nowrap;';

// 這個品項目前的單價(null = 沒有價格);qty 可以覆蓋(登記進出貨頁暫存的新數量)
function spItemUnit(order, it){
  if(!it || it.deleted) return null;
  return spPriceOrderItem(order, it).unit;
}
function spItemTotal(order, it, qtyOverride){
  const unit = spItemUnit(order, it);
  const q = qtyOverride !== undefined ? qtyOverride : it.qty;
  if(unit === null || !(q > 0)) return null;
  return spRound2(unit * q);
}
// 單價欄(可點擊看明細 / 手動改價)
function spUnitCellHtml(order, it){
  const inner = (typeof spOrderPriceHtml === 'function') ? spOrderPriceHtml(order, it) : '';
  return `<span style="${SP_UNIT_W}">${inner ? inner.replace('margin-left:8px;', '') : '–'}</span>`;
}
function spTotalCellHtml(order, it, qtyOverride){
  const v = spItemTotal(order, it, qtyOverride);
  return `<span style="${SP_TOTAL_W}"><span style="${SP_TOTAL_PILL}">${v === null ? '–' : spMoney(v)}</span></span>`;
}
// 標題列:單價 / 數量 / 總價(withActions = 這個清單每列右邊有「改數量 / 批次 / 刪除」,要留同樣的寬度才對得齊)
function spColsHeaderHtml(withActions){
  if(!spEnabled()) return '';
  return `<div class="sp-cols-head" style="display:flex;gap:10px;justify-content:flex-end;align-items:center;font-size:11px;color:var(--ink-soft);padding:2px 0;border-bottom:none;">
    <span style="flex:1;"></span><span style="${SP_QTY_W}">${t('colQty')}</span><span style="${SP_UNIT_W}">${t('spColUnitPrice')}</span><span style="${SP_TOTAL_W}">${t('spColTotalPrice')}</span>${withActions ? `<span style="${SP_ACTIONS_W}"></span>` : ''}
  </div>`;
}
// 一張訂單的總金額(沒有價格的品項不算進去,有的話旁邊註明)
function spOrderTotal(order, overrides){
  let sum = 0, missing = 0;
  (order.items || []).forEach(it => {
    if(it.deleted) return;
    const ov = overrides ? overrides(it) : undefined;     // undefined = 用原本;false = 不計(例如暫存刪除);數字 = 暫存的新數量
    if(ov === false) return;
    if(!(it.qty > 0)) return;
    const v = spItemTotal(order, it, typeof ov === 'number' ? ov : undefined);
    if(v === null) missing++; else sum += v;
  });
  return { sum: spRound2(sum), missing };
}
function spTotalRowHtml(sum, missing, withActions, label){
  if(!spEnabled()) return '';
  return `<div class="sp-total-row" style="display:flex;gap:10px;justify-content:flex-end;align-items:center;padding:6px 0 2px;border-bottom:none;font-weight:700;">
    <span style="flex:1;text-align:right;">${label || t('spOrderTotal')}${missing ? ` <span style="font-weight:400;font-size:11px;color:var(--ink-soft);">(${tf('spTotalMissing', { n: missing })})</span>` : ''}</span>
    <span style="${SP_TOTAL_W}"><span style="${SP_TOTAL_PILL}">${spMoney(sum)}</span></span>${withActions ? `<span style="${SP_ACTIONS_W}"></span>` : ''}
  </div>`;
}
function spOrderTotalRowHtml(order, withActions, overrides){
  const r = spOrderTotal(order, overrides);
  return spTotalRowHtml(r.sum, r.missing, withActions);
}

// 登記進出貨清單(還沒建立訂單的新品項):單項總價與整份清單的總金額
function spTxItemTotalHtml(it, partyId){
  if(!spEnabled() || !it || !(it.qty > 0) || !spPriceable(it.productId)) return '–';
  const pr = spPriceCalc(it.productId, it.qty, null, spPartyDiscountById(partyId));
  return pr.unit === null ? '–' : spMoney(spRound2(pr.unit * it.qty));
}
function spTxItemsTotal(partyId){
  let sum = 0, missing = 0;
  (txBatchItems || []).forEach(it => {
    if(!(it.qty > 0)) return;
    if(!spPriceable(it.productId)){ missing++; return; }
    const pr = spPriceCalc(it.productId, it.qty, null, spPartyDiscountById(partyId));
    if(pr.unit === null) missing++; else sum += pr.unit * it.qty;
  });
  return { sum: spRound2(sum), missing };
}

// 已完成訂單匯出:每個商品的 Sell price(單價),依各訂單核對當下固定的售價,以出貨數量加權平均
function spExportSellPriceMap(orderList){
  const acc = {};
  orderList.forEach(o => (o.items || []).forEach(it => {
    if(it.deleted || !(it.qty > 0) || !it.sellFrozen) return;
    const v = Number(it.sellPrice);
    if(!Number.isFinite(v)) return;
    const a = acc[it.productId] = acc[it.productId] || { sum: 0, qty: 0 };
    a.sum += v * it.qty; a.qty += it.qty;
  }));
  const map = {};
  Object.keys(acc).forEach(pid => { if(acc[pid].qty > 0) map[pid] = spRound2(acc[pid].sum / acc[pid].qty); });
  return map;
}

// Sell price 單價欄(批次追蹤頁用):顯示 Sell price,點擊看 Base / 其他支出 / Total / Margin / Sell 明細
function spSellCellHtml(i){
  const v = spSellUnit(i);
  if(v === null) return '–';
  return `<span class="batch-link" title="${batchEsc(t('spPriceClickHint'))}" onclick="spShowPricePopup('${i.id}')">${spMoney(v)}</span>`;
}
async function spSaveBatchMarginFromModal(batchId){
  const el = document.getElementById('batchDetailMargin');
  const v = el ? el.value : '';
  const n = Number(String(v).trim());
  const bad = String(v).trim() === '' || !Number.isFinite(n) || n < 0 || n > 1000;
  if(bad){ showInfoModal(t('spMarginInvalid')); return; }
  if(!spIsSettingBasis()){
    const ov = document.getElementById('batchDetailOverlay'); if(ov) ov.remove();
    await spSaveBatchMargin(batchId, v);
    return;
  }
  // 依 Price Setting 計價:只有「正在出貨」的批次,margin 才會覆蓋 Price Setting 的價格(先確認);
  // 還沒輪到的批次只記下 margin,輪到時 Price Setting 頁會提醒。
  const withCost = batchData.items.filter(i => i.batchId === batchId && !i.isOpening && spTotalUnit(i) !== null);
  if(withCost.length === 0){ showInfoModal(t('spBatchMarginNoCost')); return; }
  const cur = withCost.filter(i => { const c = (typeof psCurrentBatchItem === 'function') ? psCurrentBatchItem(i.productId) : null; return c && c.id === i.id; });
  const doSave = async () => {
    const ov = document.getElementById('batchDetailOverlay'); if(ov) ov.remove();
    try{
      try{ await batchRpc('batch_set_margin', { p_batch_id: batchId, p_margin: n, p_only_if_null: false }); }
      catch(e){ if(!/batch_set_margin|margin_pct/i.test((e && e.message) || '')) throw e; }   // margin_pct 欄位沒建立也不影響 Price Setting 流程
      batchData.items.forEach(i => { if(i.batchId === batchId) i.marginPct = n; });
      spManualMargins[batchId] = n;
      await dbSet('batchMarginManual', JSON.stringify(spManualMargins));
      if(cur.length > 0){
        const next = Object.assign({}, spPriceMap);
        cur.forEach(i => { next[i.productId] = spRound2(spTotalUnit(i) * (1 + n / 100)); });
        await psSavePriceMap(next, 'batchMargin', (withCost[0].batchNo || '') + ' · ' + n + '%');
      } else {
        showInfoModal(t('spBatchMarginSavedPending'));
      }
    } catch(e){
      console.error('儲存批次 margin / Price Setting 失敗', e);
      showInfoModal(t('spMarginSaveFailed'));
    }
    spRefreshAfterBasisChange();
  };
  if(cur.length === 0){ await doSave(); return; }
  showConfirmModal(t('spBatchMarginOverwrite') + '\n' + tf('spBatchMarginOverwriteN', { n: cur.length }), doSave);
}
