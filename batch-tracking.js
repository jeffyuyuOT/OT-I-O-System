// ============================================================
// 批次追蹤(Batch tracking)
//
// 進貨時給每一批貨一個批次號(YYMMDD-NNN),出貨時知道這次出的貨是從哪一批出的。
// 資料表/RPC 見 batch_tracking_phase1.sql(batches / batch_items / batch_movements、
// batch_save_purchase / batch_allocate / batch_return / batch_convert)。
//
// 這個檔案放:資料載入、分配預覽、批次選擇視窗、各流程呼叫的 RPC 包裝、進出貨紀錄標籤、
// 「庫存總覽 → 批次追蹤」頁面。整個功能受 hasFeature('batchTracking') 控制
// (ot-custom-features.js),而且如果資料表還沒建立(SQL 沒執行)會自動停用,不影響原本流程。
//
// 設計原則:
// - 畫面上的分配結果只是預覽,真正分配在資料庫裡(batch_allocate,鎖定批次後執行)。
// - 批次相關的任何失敗都不能讓原本的進出貨/核對失敗:錯誤只會跳提示,
//   沒分配到的出貨會出現在批次追蹤頁的「未分配出貨」清單,可以補分配。
// ============================================================
const BATCH_EXPIRY_WARN_DAYS = 30;

let batchAvailable = true;                       // 資料表不存在時變 false → 功能整個停用
let batchData = { items: [], loaded: false, stale: false, error: '' };
let batchDataPromise = null;
let batchTxMoveCache = {};                       // txId -> [{ batch_item_id, qty, kind }]
let batchPicks = {};                             // `${orderId}::${productId}` -> [{ batchItemId, qty }](核對頁手動指定)
let txBatchTrackChecked = true;                  // 登記進貨「進入批次追蹤」勾選狀態(預設勾選)
let batchFormExtrasSig = '';
let batchOrderCache = {};                        // orderId -> Promise<{ productId: { batchItemId: qty } }>
let batchEditPicks = {};                         // productId -> [{ batchItemId, qty }](登記進出貨→載入已完成訂單,改數量時暫存的指定批次)

function batchFeatureOn(){ return typeof hasFeature === 'function' && hasFeature('batchTracking'); }
function batchActive(){ return batchFeatureOn() && batchAvailable; }

(function batchInjectStyles(){
  if(document.getElementById('batchTrackingStyles')) return;
  const st = document.createElement('style');
  st.id = 'batchTrackingStyles';
  st.textContent = `
    .batch-tag{ display:inline-block; font-family:'IBM Plex Mono',monospace; font-size:11px; padding:1px 6px; border:1px solid var(--line); border-radius:2px; margin:2px 4px 0 0; background:#fff; color:var(--ink); white-space:nowrap; }
    .batch-tag i{ font-style:normal; color:var(--ink-soft); margin-left:4px; }
    .batch-tag-warn{ border-color:var(--crit); color:var(--crit); }
    .order-items div.batch-alloc-line, .batch-alloc-line{ display:block; flex:0 0 100%; width:100%; font-size:11px; margin-top:2px; padding:0; border-bottom:none; text-align:left; }
    .batch-link{ color:var(--ink); text-decoration:underline; cursor:pointer; }
    .batch-seg{ display:inline-flex; gap:0; border:1px solid var(--line); border-radius:2px; overflow:hidden; }
    .batch-seg button{ border:0; background:#fff; padding:6px 14px; font-family:inherit; font-size:12.5px; cursor:pointer; }
    .batch-seg button.active{ background:var(--ink); color:#fff; }
    #batchTrackerRoot .stock-table td, #batchTrackerRoot .stock-table th{ vertical-align:middle; }
  `;
  document.head.appendChild(st);
})();

// ------------------------------------------------------------
// 資料載入
// ------------------------------------------------------------
async function batchRpc(name, args){
  const { data, error } = await sb.rpc(name, args);
  if(error) throw error;
  return data;
}

async function loadBatchData(){
  try{
    const [itemRows, stockRows] = await Promise.all([
      fetchAllPages(() => sb.from('batch_items')
        .select('id,batch_id,product_id,expiry,qty_in,unit_cost_base,unit_cost_total,supplier_lot,batches(batch_no,batch_date,purchase_id,is_opening,invoice_no,supplier)')
        .order('id', { ascending: true })),
      fetchAllPages(() => sb.from('batch_item_stock').select('batch_item_id,remaining').order('batch_item_id', { ascending: true }))
    ]);
    const remMap = {};
    stockRows.forEach(r => { remMap[r.batch_item_id] = Number(r.remaining); });
    const num = v => (v === null || v === undefined) ? null : Number(v);
    batchData.items = itemRows.map(r => {
      const b = r.batches || {};
      return {
        id: r.id, batchId: r.batch_id, productId: r.product_id, expiry: r.expiry || '',
        qtyIn: Number(r.qty_in), unitCostBase: num(r.unit_cost_base), unitCostTotal: num(r.unit_cost_total),
        supplierLot: r.supplier_lot || '',
        batchNo: b.batch_no || '', batchDate: b.batch_date || '', purchaseId: b.purchase_id || '',
        isOpening: !!b.is_opening, invoiceNo: b.invoice_no || '', supplier: b.supplier || '',
        remaining: remMap[r.id] !== undefined ? remMap[r.id] : Number(r.qty_in)
      };
    });
    batchData.loaded = true; batchData.stale = false; batchData.error = '';
    batchAvailable = true;
  } catch(e){
    console.warn('批次資料讀取失敗', e);
    // 資料表還沒建立(SQL 還沒執行)→ 整個功能停用;其他錯誤(網路…)只是這次沒載到
    if(e && (e.code === 'PGRST205' || e.code === '42P01' || /does not exist|schema cache/i.test(e.message || ''))) batchAvailable = false;
    batchData.items = []; batchData.loaded = true; batchData.stale = false; batchData.error = (e && e.message) || String(e);
  }
  try{ if(typeof renderVerifyPage === 'function') renderVerifyPage(); }catch(e){}
  try{ if(typeof renderTxBatchList === 'function') renderTxBatchList(); }catch(e){}
  try{ if(typeof renderLog === 'function' && document.getElementById('logTable')) renderLog(); }catch(e){}
}

function ensureBatchDataLoaded(force){
  if(!batchFeatureOn()) return Promise.resolve();
  if(!force && batchData.loaded && !batchData.stale) return Promise.resolve();
  if(!batchDataPromise) batchDataPromise = loadBatchData().finally(() => { batchDataPromise = null; });
  return batchDataPromise;
}
function batchMarkStale(){ batchData.stale = true; batchTxMoveCache = {}; batchOrderCache = {}; }

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------
function batchEsc(s){ return String(s === null || s === undefined ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function batchProductName(pid){ const p = products.find(x => x.id === pid); return p ? p.name : pid; }
function batchProductUnit(pid){ const p = products.find(x => x.id === pid); return p ? (p.unit || '') : ''; }
function batchFmtQty(n){ return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
function batchFmtMoney(n){ return (n === null || n === undefined) ? '–' : '$' + Number(n).toFixed(2); }
function batchUnitCost(i){ return (i.unitCostTotal !== null && i.unitCostTotal !== undefined) ? i.unitCostTotal : i.unitCostBase; }

// 有效期先到期先出;沒有有效期的排後面,依進貨日 FIFO(期初批次日期最舊)。資料庫端排序規則一樣。
function batchFefoCompare(a, b){
  const ae = a.expiry || '', be = b.expiry || '';
  if(ae && !be) return -1;
  if(!ae && be) return 1;
  if(ae !== be) return ae < be ? -1 : 1;
  if(a.batchDate !== b.batchDate) return a.batchDate < b.batchDate ? -1 : 1;
  return a.batchNo < b.batchNo ? -1 : (a.batchNo > b.batchNo ? 1 : 0);
}
function batchExpiryCompare(a, b){
  if(a && !b) return -1;
  if(!a && b) return 1;
  return a < b ? -1 : (a > b ? 1 : 0);
}
function batchItemsOfProduct(pid, includeDepleted){
  return batchData.items.filter(i => i.productId === pid && (includeDepleted || i.remaining > 0)).sort(batchFefoCompare);
}
function batchIsTracked(pid){ return batchActive() && batchData.items.some(i => i.productId === pid); }

function batchDaysUntil(dateStr){
  const parts = String(dateStr).split('-').map(Number);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(parts[0], parts[1] - 1, parts[2]) - today) / 86400000);
}
function batchExpiryBadge(expiry){
  if(!expiry) return '';
  const d = batchDaysUntil(expiry);
  if(d < 0) return ` <span style="color:var(--crit);font-weight:700;">🔴 ${t('batchExpired')}</span>`;
  if(d <= BATCH_EXPIRY_WARN_DAYS) return ` <span style="color:#B8860B;font-weight:700;">🟠 ${tf('batchExpiresInDays', { n: d })}</span>`;
  return '';
}

// ------------------------------------------------------------
// 分配預覽(畫面顯示用;真正的分配在資料庫 batch_allocate)
// ------------------------------------------------------------
function batchPreviewAllocation(productId, qty, picks){
  const rows = batchItemsOfProduct(productId).map(i => ({ item: i, left: i.remaining }));
  const byId = {};
  rows.forEach(r => { byId[r.item.id] = r; });
  let need = qty;
  const lines = [];
  (picks || []).forEach(p => {
    const r = byId[p.batchItemId];
    if(!r || need <= 0) return;
    const take = Math.min(p.qty, r.left, need);
    if(take > 0){ lines.push({ item: r.item, qty: take, manual: true }); r.left -= take; need -= take; }
  });
  rows.forEach(r => {
    if(need <= 0 || r.left <= 0) return;
    const take = Math.min(r.left, need);
    lines.push({ item: r.item, qty: take, manual: false });
    r.left -= take; need -= take;
  });
  return { lines, untracked: Math.max(0, need) };
}

function batchAllocLabelHtml(alloc){
  if(alloc.lines.length === 0 && alloc.untracked <= 0) return '';
  const parts = alloc.lines.map(l =>
    `<span class="batch-tag">${batchEsc(l.item.batchNo)} ×${batchFmtQty(l.qty)}${l.item.expiry ? ' · ' + t('batchExpiryShort') + ' ' + batchEsc(l.item.expiry) : ''}<i>${l.manual ? t('batchManualTag') : t('batchAutoTag')}</i></span>`);
  if(alloc.untracked > 0) parts.push(`<span class="batch-tag batch-tag-warn">${t('batchUntracked')} ×${batchFmtQty(alloc.untracked)}</span>`);
  return `<div class="batch-alloc-line">${parts.join('')}</div>`;
}

// ------------------------------------------------------------
// 批次選擇視窗(核對頁 / 登記出貨共用)
// opts: { productId, qty, unit, picks:[{batchItemId, qty}], onSave(picks) }
// ------------------------------------------------------------
let batchPickerOpts = null;
function batchClosePicker(){
  const ov = document.getElementById('batchPickerOverlay');
  if(ov) ov.remove();
  batchPickerOpts = null;
}
function batchOpenPicker(opts){
  batchClosePicker();
  const items = batchItemsOfProduct(opts.productId);
  // 預設顯示「目前實際會怎麼分配」(自動分配的結果,或已指定的批次加上自動補的部分),可以直接改數字
  const cur = {};
  batchPreviewAllocation(opts.productId, opts.qty, opts.picks).lines.forEach(l => { cur[l.item.id] = (cur[l.item.id] || 0) + l.qty; });
  const rows = items.map(i => `
    <tr>
      <td>${batchEsc(i.batchNo)}${i.isOpening ? ' <span style="color:var(--ink-soft);font-size:11px;">(' + t('batchOpening') + ')</span>' : ''}</td>
      <td>${i.expiry ? batchEsc(i.expiry) + batchExpiryBadge(i.expiry) : '–'}</td>
      <td class="num">${batchFmtQty(i.remaining)}</td>
      <td class="num"><input type="number" class="batch-pick-input" data-id="${i.id}" data-max="${i.remaining}" min="0" max="${i.remaining}" step="1" value="${cur[i.id] || ''}" oninput="batchPickerUpdateSum()" style="width:80px;" /></td>
    </tr>`).join('');
  const ov = document.createElement('div');
  ov.id = 'batchPickerOverlay';
  ov.className = 'modal-overlay';
  ov.style.display = 'flex';
  ov.style.zIndex = '1150';
  ov.innerHTML = `
    <div class="modal-box modal-box-wide">
      <div class="section-title" style="margin-top:0;">${t('batchPickerTitle')}</div>
      <p style="margin-bottom:10px;">${batchEsc(batchProductName(opts.productId))} · ${tf('batchPickerHint', { qty: batchFmtQty(opts.qty), unit: batchEsc(opts.unit || '') })}</p>
      ${items.length === 0 ? `<div class="empty-note">${t('batchPickerNoBatches')}</div>` : `
      <table class="stock-table">
        <thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('batchColRemaining')}</th><th class="num">${t('batchColAllocated')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`}
      <div style="font-size:11.5px;color:var(--ink-soft);">${t('batchPickerEditHint')}</div>
      <div id="batchPickerSum" style="font-size:12px;margin:8px 0;color:var(--ink-soft);"></div>
      <div id="batchPickerMsg" class="msg"></div>
      <div class="modal-actions">
        <button class="btn ghost" onclick="batchClosePicker()">${t('btnCancel')}</button>
        <button class="btn ghost" onclick="batchPickerClear()">${t('batchPickerClear')}</button>
        <button class="btn" onclick="batchPickerSave()">${t('btnSave')}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  batchPickerOpts = opts;
  batchPickerUpdateSum();
}
function batchPickerCollect(){
  const picks = [];
  document.querySelectorAll('#batchPickerOverlay .batch-pick-input').forEach(inp => {
    const v = parseFloat(inp.value);
    if(v > 0) picks.push({ batchItemId: inp.dataset.id, qty: v, max: parseFloat(inp.dataset.max) });
  });
  return picks;
}
function batchPickerUpdateSum(){
  if(!batchPickerOpts) return;
  const sum = batchPickerCollect().reduce((s, p) => s + p.qty, 0);
  const el = document.getElementById('batchPickerSum');
  if(el) el.textContent = tf('batchPickerSum', { sum: batchFmtQty(sum), qty: batchFmtQty(batchPickerOpts.qty) });
}
function batchPickerClear(){
  document.querySelectorAll('#batchPickerOverlay .batch-pick-input').forEach(inp => { inp.value = ''; });
  batchPickerUpdateSum();
}
function batchPickerSave(){
  if(!batchPickerOpts) return;
  const msg = document.getElementById('batchPickerMsg');
  const picks = batchPickerCollect();
  const over = picks.find(p => p.qty > p.max + 1e-9);
  if(over){ msg.className = 'msg error'; msg.textContent = t('batchPickerOverRemaining'); return; }
  const sum = picks.reduce((s, p) => s + p.qty, 0);
  if(sum > batchPickerOpts.qty + 1e-9){ msg.className = 'msg error'; msg.textContent = t('batchPickerOverQty'); return; }
  const onSave = batchPickerOpts.onSave;
  // 如果改完的數字跟自動分配的結果一樣,就維持「自動」,不算手動指定
  const auto = {};
  batchPreviewAllocation(batchPickerOpts.productId, batchPickerOpts.qty, []).lines.forEach(l => { auto[l.item.id] = (auto[l.item.id] || 0) + l.qty; });
  const same = picks.length === Object.keys(auto).length && picks.every(p => Math.abs((auto[p.batchItemId] || 0) - p.qty) < 1e-9);
  batchClosePicker();
  if(onSave) onSave(same ? [] : picks.map(p => ({ batchItemId: p.batchItemId, qty: p.qty })));
}

// ------------------------------------------------------------
// 訂單核對頁:每個商品「改數量」與「刪除」之間的「批次」按鈕、分配預覽
// ------------------------------------------------------------
function batchPickKey(orderId, productId){ return orderId + '::' + productId; }

function batchOrderItemButtonHtml(o, it){
  if(!batchIsTracked(it.productId) || !(it.qty > 0)) return '';
  const has = (batchPicks[batchPickKey(o.id, it.productId)] || []).length > 0;
  return `<span class="del-link" style="margin-left:8px;" onclick="batchOpenPickerForOrderItem('${o.id}','${it.productId}')">${t('btnBatchPick')}${has ? ' ✓' : ''}</span>`;
}
function batchOrderItemPreviewHtml(o, it){
  return ''; // 不主動顯示分配結果,點「批次」按鈕在視窗裡看/改
  if(!batchIsTracked(it.productId) || !(it.qty > 0)) return '';
  return batchAllocLabelHtml(batchPreviewAllocation(it.productId, it.qty, batchPicks[batchPickKey(o.id, it.productId)]));
}
function batchOpenPickerForOrderItem(orderId, productId){
  const o = orders.find(x => x.id === orderId);
  if(!o) return;
  const it = o.items.find(x => x.productId === productId && !x.deleted);
  if(!it) return;
  const key = batchPickKey(orderId, productId);
  batchOpenPicker({
    productId, qty: it.qty, unit: it.unit, picks: batchPicks[key] || [],
    onSave: picks => {
      if(picks.length) batchPicks[key] = picks; else delete batchPicks[key];
      renderVerifyPage();
    }
  });
}
// 核對前的警示:會分配到已過期批次、或批次庫存不夠(超出部分以「未追蹤」出貨)
function batchVerifyWarnings(order, activeItems){
  if(!batchActive()) return '';
  const lines = [];
  activeItems.forEach(it => {
    if(!batchIsTracked(it.productId) || !(it.qty > 0)) return;
    const alloc = batchPreviewAllocation(it.productId, it.qty, batchPicks[batchPickKey(order.id, it.productId)]);
    alloc.lines.forEach(l => {
      if(l.item.expiry && batchDaysUntil(l.item.expiry) < 0){
        lines.push(tf('batchWarnExpiredLine', { name: it.name, batch: l.item.batchNo, expiry: l.item.expiry }));
      }
    });
    if(alloc.untracked > 0) lines.push(tf('batchWarnShortLine', { name: it.name, n: batchFmtQty(alloc.untracked) }));
  });
  return lines.length ? '\n\n⚠ ' + lines.join('\n⚠ ') : '';
}
function batchClearPicksForOrder(orderId){
  Object.keys(batchPicks).forEach(k => { if(k.startsWith(orderId + '::')) delete batchPicks[k]; });
}

// ------------------------------------------------------------
// 出貨/退回分配(呼叫資料庫 RPC)。永遠不丟錯誤給呼叫端。
// ------------------------------------------------------------
function batchIsPickError(e){ return /batch_insufficient|batch_bad_pick/.test((e && e.message) || ''); }
function batchProductsOfTxs(txList, res){
  // 回報「批次庫存不足、以未追蹤出貨」的商品
  const lines = [];
  txList.forEach(tx => {
    const r = res && res[tx.id];
    if(r && r.untracked > 0) lines.push(`${batchProductName(tx.productId)} ×${batchFmtQty(r.untracked)}`);
  });
  return lines;
}
async function batchAllocateAfter(txList, picksByTx){
  if(!batchActive() || !txList || txList.length === 0) return;
  try{ await ensureBatchDataLoaded(); }catch(e){}
  const list = txList.filter(tx => batchIsTracked(tx.productId));
  if(list.length === 0) return;
  const ids = list.map(tx => tx.id);
  const manual = {};
  list.forEach(tx => { if(picksByTx && picksByTx[tx.id] && picksByTx[tx.id].length) manual[tx.id] = picksByTx[tx.id]; });
  let res;
  try{
    res = await batchRpc('batch_allocate', { p_tx_ids: ids, p_manual: manual });
  } catch(e){
    if(Object.keys(manual).length > 0 && batchIsPickError(e)){
      try{
        res = await batchRpc('batch_allocate', { p_tx_ids: ids, p_manual: {} });
        showInfoModal(t('batchPickFallbackNotice'));
      } catch(e2){ batchAllocFailed(e2); return; }
    } else { batchAllocFailed(e); return; }
  }
  batchMarkStale();
  try{ await ensureBatchDataLoaded(); }catch(e){}
  const lines = batchProductsOfTxs(list, res);
  if(lines.length) showInfoModal(t('batchUntrackedNotice') + '\n' + lines.join('\n'));
}
async function batchReturnAfter(txList, picksByTx){
  if(!batchActive() || !txList || txList.length === 0) return;
  try{ await ensureBatchDataLoaded(); }catch(e){}
  const list = txList.filter(tx => batchIsTracked(tx.productId));
  if(list.length === 0) return;
  try{
    await batchRpc('batch_return', { p_tx_ids: list.map(tx => tx.id), p_manual: picksByTx || {} });
    batchMarkStale();
    await ensureBatchDataLoaded();
  } catch(e){ console.error('批次退回失敗', e); }
}
function batchAllocFailed(e){
  console.error('批次分配失敗', e);
  showInfoModal(t('batchAllocFailed'));
}
// db.js 的 insertTransactions 寫入成功後呼叫:出貨 → 分配、入庫(退回)→ 退回原批次。
// 絕對不能丟錯誤(呼叫端會把丟錯誤當成「交易寫入失敗」去回滾)。
async function batchAfterInsert(txList){
  try{
    if(!batchActive()) return;
    const outs = txList.filter(tx => tx.type === 'out' && !tx.conversion);
    const restocks = txList.filter(tx => tx.type === 'restock' && !tx.conversion);
    if(outs.length === 0 && restocks.length === 0) return;
    await ensureBatchDataLoaded();
    const picksByTx = {};
    outs.forEach(tx => {
      const it = (typeof txBatchItems !== 'undefined') ? txBatchItems.find(x => x.productId === tx.productId && x.batchPicks && x.batchPicks.length) : null;
      if(it) picksByTx[tx.id] = it.batchPicks.map(p => ({ batch_item_id: p.batchItemId, qty: p.qty }));
    });
    await batchAllocateAfter(outs, picksByTx);
    await batchReturnAfter(restocks, {});
  } catch(e){ console.error('批次掛鉤失敗', e); }
}
async function batchConvertAfter(conversionId, fromProductId){
  try{
    if(!batchActive()) return;
    await ensureBatchDataLoaded();
    if(!batchIsTracked(fromProductId)) return;
    const res = await batchRpc('batch_convert', { p_conversion_id: conversionId, p_manual: [] });
    batchMarkStale();
    await ensureBatchDataLoaded();
    if(res && res.tracked && res.untracked > 0) showInfoModal(tf('batchConvertUntrackedNotice', { n: batchFmtQty(res.untracked) }));
  } catch(e){
    console.error('批次切換失敗', e);
    showInfoModal(t('batchConvertFailed'));
  }
}

// ------------------------------------------------------------
// 進貨單 → 批次
// ------------------------------------------------------------
// 同一張單裡:發票行依(商品, 有效期)合併;Credit Note 先扣同有效期的行,不夠再依有效期由早到晚扣其他行
// (跟登記進貨時 transactions 的淨值做法一致)。淨值 <= 0 的行不進批次。
function batchNetPurchaseLines(items){
  const byProduct = {};
  (items || []).forEach(it => {
    if(it.docType === 'others') return;
    const g = byProduct[it.productId] = byProduct[it.productId] || { inc: [], cn: [] };
    (it.docType === 'credit_note' ? g.cn : g.inc).push(it);
  });
  const out = [];
  Object.keys(byProduct).forEach(pid => {
    const g = byProduct[pid];
    const lines = [];
    g.inc.forEach(it => {
      const key = it.expiry || '';
      let l = lines.find(x => x.expiry === key);
      if(!l){ l = { productId: pid, expiry: key, qty: 0, amount: null, supplierLot: '' }; lines.push(l); }
      l.qty += Number(it.qty) || 0;
      if(it.amount !== undefined && it.amount !== null) l.amount = (l.amount || 0) + Number(it.amount);
      if(it.supplierLot && !l.supplierLot) l.supplierLot = it.supplierLot;
    });
    g.cn.forEach(it => {
      let left = Number(it.qty) || 0;
      const unitAmt = (it.amount !== undefined && it.amount !== null && it.qty) ? Number(it.amount) / Number(it.qty) : null;
      const key = it.expiry || '';
      lines.slice().sort((a, b) => ((a.expiry === key ? 0 : 1) - (b.expiry === key ? 0 : 1)) || batchExpiryCompare(a.expiry, b.expiry)).forEach(l => {
        if(left <= 0 || l.qty <= 0) return;
        const take = Math.min(left, l.qty);
        l.qty -= take;
        if(unitAmt !== null && l.amount !== null) l.amount -= take * unitAmt;
        left -= take;
      });
    });
    lines.forEach(l => { if(l.qty > 0) out.push(l); });
  });
  return out;
}

async function batchSavePurchase(purchase){
  const lines = batchNetPurchaseLines(purchase.items || []);
  const payload = lines.map(l => ({
    product_id: l.productId, expiry: l.expiry || '', qty: l.qty,
    amount: l.amount === null ? null : l.amount, supplier_lot: l.supplierLot || ''
  }));
  const data = await batchRpc('batch_save_purchase', {
    p_purchase_id: purchase.id, p_date: purchase.date, p_invoice_no: purchase.invoiceNo || null,
    p_supplier: purchase.partyName || null, p_items: payload
  });
  batchMarkStale();
  try{ await ensureBatchDataLoaded(); }catch(e){}
  return data;
}

// 編輯進貨單前先在前端檢查:數量不能低於該行已經出貨的量(最後以資料庫為準)
function batchValidatePurchaseEdit(purchase, newItems){
  if(!batchActive() || !purchase.batchTracked) return '';
  const mine = batchData.items.filter(i => i.purchaseId === purchase.id && i.qtyIn > 0);
  const lines = batchNetPurchaseLines(newItems);
  for(const i of mine){
    const used = i.qtyIn - i.remaining;
    if(used <= 0) continue;
    const l = lines.find(x => x.productId === i.productId && x.expiry === (i.expiry || ''));
    const newQty = l ? l.qty : 0;
    if(newQty < used - 1e-9) return tf('batchEditBelowUsed', { name: batchProductName(i.productId), batch: i.batchNo, used: batchFmtQty(used) });
  }
  return '';
}
function batchParseInUseError(e){
  const m = /batch_in_use:(\{.*\})/.exec((e && e.message) || '');
  if(!m) return null;
  try{ return JSON.parse(m[1]); }catch(x){ return null; }
}

// ------------------------------------------------------------
// 登記進貨表單:「進入批次追蹤」勾選、有效期/供應商批號欄位
// ------------------------------------------------------------
function batchFormTrackChecked(){ return batchActive() && txBatchTrackChecked; }
function batchRowsShowExpiry(){ return typeof currentTxType !== 'undefined' && currentTxType === 'in' && batchFormTrackChecked(); }

function batchRenderFormExtras(){
  const trackWrap = document.getElementById('txBatchTrackWrap');
  const extraWrap = document.getElementById('txBatchExtraFields');
  if(!trackWrap || !extraWrap) return;
  const isIn = typeof currentTxType !== 'undefined' && currentTxType === 'in' && batchActive();
  const sig = [lang, isIn, txBatchTrackChecked].join('|');
  if(sig === batchFormExtrasSig) return;
  batchFormExtrasSig = sig;
  if(!isIn){ trackWrap.style.display = 'none'; trackWrap.innerHTML = ''; extraWrap.style.display = 'none'; extraWrap.innerHTML = ''; return; }
  trackWrap.style.display = '';
  trackWrap.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--ink);cursor:pointer;">
      <input type="checkbox" id="txBatchTrackChk" ${txBatchTrackChecked ? 'checked' : ''} onchange="txBatchTrackChecked=this.checked;renderTxBatchList();" style="width:16px;height:16px;cursor:pointer;" />
      ${t('batchTrackToggle')}
    </label>
    <div style="font-size:11.5px;color:var(--ink-soft);margin:2px 0 0 24px;">${t('batchTrackToggleHint')}</div>`;
  if(txBatchTrackChecked){
    extraWrap.style.display = '';
    extraWrap.innerHTML = `
      <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:6px;">
        <div class="field"><label>${t('batchFieldExpiry')}</label><input id="txExpiry" type="date" /></div>
        <div class="field"><label>${t('batchFieldLot')}</label><input id="txSupplierLot" type="text" /></div>
      </div>`;
  } else { extraWrap.style.display = 'none'; extraWrap.innerHTML = ''; }
}
function batchReadAddFields(){
  if(!batchRowsShowExpiry()) return { expiry: '', lot: '' };
  const e = document.getElementById('txExpiry'), l = document.getElementById('txSupplierLot');
  return { expiry: e ? e.value : '', lot: l ? l.value.trim() : '' };
}
function batchClearAddFields(){
  const e = document.getElementById('txExpiry'), l = document.getElementById('txSupplierLot');
  if(e) e.value = '';
  if(l) l.value = '';
}
function batchResetFormAfterSubmit(){
  txBatchTrackChecked = true;
  batchFormExtrasSig = '';
  batchClearAddFields();
}
// 列表上改有效期/批號。同商品、同有效期、同文件來源的行自動合併數量。
function updateTxBatchItemExpiry(batchItemId, value){
  const it = txBatchItems.find(x => x.batchItemId === batchItemId);
  if(!it) return;
  it.expiry = value || '';
  const other = txBatchItems.find(x => x !== it && x.productId === it.productId && (x.expiry || '') === (it.expiry || '')
    && (x.docType || '') === (it.docType || '') && (x.sourceFilename || '') === (it.sourceFilename || ''));
  if(other){
    other.qty += it.qty;
    if(it.amount !== undefined && it.amount !== null) other.amount = (other.amount || 0) + it.amount;
    if(it.supplierLot && !other.supplierLot) other.supplierLot = it.supplierLot;
    txBatchItems = txBatchItems.filter(x => x !== it);
  }
  renderTxBatchList();
}
function updateTxBatchItemLot(batchItemId, value){
  const it = txBatchItems.find(x => x.batchItemId === batchItemId);
  if(!it) return;
  it.supplierLot = (value || '').trim();
}
// 非進貨類型(出貨/調整):每一行的「批次」按鈕與預覽
function batchTxRowPickable(it){
  // 載入「待處理訂單」新增商品時只是改訂單內容、還不會出貨,不需要批次;等到核對頁按核對才分配批次
  if(typeof registerOutFlowType !== 'undefined' && registerOutFlowType === 'load-pending') return false;
  return typeof currentTxType !== 'undefined' && currentTxType !== 'in' && batchIsTracked(it.productId) && it.qty > 0;
}
function batchTxRowPreviewHtml(it){
  return ''; // 不主動顯示,點「批次」按鈕在視窗裡看/改
  if(!batchTxRowPickable(it)) return '';
  return batchAllocLabelHtml(batchPreviewAllocation(it.productId, it.qty, it.batchPicks));
}
function batchTxRowButtonHtml(it){
  if(!batchTxRowPickable(it)) return '';
  const has = it.batchPicks && it.batchPicks.length > 0;
  return `<button onclick="batchOpenPickerForTxItem('${it.batchItemId}')" title="${t('btnBatchPick')}">📦${has ? '✓' : ''}</button>`;
}
function batchOpenPickerForTxItem(batchItemId){
  const it = txBatchItems.find(x => x.batchItemId === batchItemId);
  if(!it) return;
  batchOpenPicker({
    productId: it.productId, qty: it.qty, unit: it.unit, picks: it.batchPicks || [],
    onSave: picks => { if(picks.length) it.batchPicks = picks; else delete it.batchPicks; renderTxBatchList(); }
  });
}
// 提交進貨時,取消勾選批次追蹤、但清單裡有商品「過去已經有批次紀錄」→ 先警示
function batchTrackedNamesInTxList(){
  const names = [];
  txBatchItems.forEach(it => { if(batchIsTracked(it.productId) && !names.includes(it.name)) names.push(it.name); });
  return names;
}
function batchConfirmUntracked(names){
  return new Promise(resolve => {
    showConfirmModal(tf('batchUntrackWarn', { names: names.join('、') }), () => resolve(true), () => resolve(false));
  });
}

// 進貨單清單:顯示這張單的批次號
function batchPurchaseTagHtml(p){
  if(!batchActive() || !p.batchTracked) return '';
  const nos = [...new Set(batchData.items.filter(i => i.purchaseId === p.id).map(i => i.batchNo))];
  return nos.length ? ' ' + nos.map(n => `<span class="batch-tag">${batchEsc(n)}</span>`).join('') : '';
}

// ------------------------------------------------------------
// 進出貨紀錄:每筆顯示批次標籤
// ------------------------------------------------------------
function batchTxTagPlaceholder(tx){
  if(!batchActive() || !batchIsTracked(tx.productId)) return '';
  return `<span class="batch-tx-tag" data-batch-tx="${tx.id}" data-batch-type="${tx.type}" data-batch-purchase="${tx.purchaseId || ''}" data-batch-product="${tx.productId}"></span>`;
}
async function batchFillTxTags(root){
  try{
    if(!batchActive() || !root) return;
    const els = Array.from(root.querySelectorAll('.batch-tx-tag'));
    if(els.length === 0) return;
    const need = [];
    els.forEach(el => {
      const isPurchaseIn = el.dataset.batchType === 'in' && el.dataset.batchPurchase;
      if(!isPurchaseIn && !(el.dataset.batchTx in batchTxMoveCache) && !need.includes(el.dataset.batchTx)) need.push(el.dataset.batchTx);
    });
    for(let i = 0; i < need.length; i += 150){
      const chunk = need.slice(i, i + 150);
      const { data, error } = await sb.from('batch_movements').select('tx_id,batch_item_id,qty,kind').in('tx_id', chunk);
      if(error) throw error;
      chunk.forEach(id => { batchTxMoveCache[id] = []; });
      (data || []).forEach(m => { batchTxMoveCache[m.tx_id].push(m); });
    }
    els.forEach(el => {
      let html = '';
      if(el.dataset.batchType === 'in' && el.dataset.batchPurchase){
        html = batchData.items.filter(i => i.purchaseId === el.dataset.batchPurchase && i.productId === el.dataset.batchProduct)
          .map(i => `<span class="batch-tag">${batchEsc(i.batchNo)}${i.expiry ? ' · ' + batchEsc(i.expiry) : ''}</span>`).join('');
      } else {
        html = (batchTxMoveCache[el.dataset.batchTx] || []).map(m => {
          const i = batchData.items.find(x => x.id === m.batch_item_id);
          if(!i) return '';
          return `<span class="batch-tag">${batchEsc(i.batchNo)} ×${batchFmtQty(Math.abs(Number(m.qty)))}${i.expiry ? ' · ' + batchEsc(i.expiry) : ''}</span>`;
        }).join('');
      }
      el.innerHTML = html;
    });
  } catch(e){ console.warn('批次標籤載入失敗', e); }
}

// ------------------------------------------------------------
// 庫存總覽 → 批次追蹤
// ------------------------------------------------------------
let bt = { view: 'product', category: '', search: '', productId: '', includeDepleted: false, batchId: '', from: '', to: '' };

function batchTrackerSetView(v){ bt.view = v; renderBatchTracker(); }
function batchTrackerOpenProduct(pid){ bt.view = 'product'; bt.productId = pid; renderBatchTracker(); }
function batchTrackerOpenBatch(batchId){ bt.view = 'batch'; bt.batchId = batchId; renderBatchTracker(); }

function renderBatchTracker(){
  const root = document.getElementById('batchTrackerRoot');
  if(!root) return;
  if(!batchFeatureOn() || !batchAvailable){ root.innerHTML = `<div class="empty-note">${t('batchUnavailable')}</div>`; return; }
  if(!batchData.loaded || batchData.stale){
    root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
    ensureBatchDataLoaded().then(renderBatchTracker);
    return;
  }
  if(batchData.error){
    root.innerHTML = `<div class="empty-note">${t('batchLoadError')}<br><span style="font-size:11px;">${batchEsc(batchData.error)}</span></div>`;
    return;
  }
  const seg = (v, label) => `<button class="${bt.view === v ? 'active' : ''}" onclick="batchTrackerSetView('${v}')">${label}</button>`;
  let body = '';
  if(bt.view === 'batch') body = batchRenderBatchView();
  else if(bt.view === 'date') body = batchRenderDateView();
  else body = batchRenderProductView();
  root.innerHTML = `
    <div class="toolbar" style="margin-bottom:10px;">
      <div class="section-title" style="margin:0;">${t('batchTrackerTitle')}</div>
      <div class="batch-seg">${seg('product', t('batchViewProduct'))}${seg('batch', t('batchViewBatch'))}${seg('date', t('batchViewDate'))}</div>
    </div>
    <div id="batchUnallocatedBanner"></div>
    ${body}`;
  batchLoadUnallocatedBanner();
}

function batchRenderProductView(){
  const trackedIds = [...new Set(batchData.items.map(i => i.productId))];
  const usedCats = [...new Set(trackedIds.map(pid => { const p = products.find(x => x.id === pid); return p ? (p.category || '未分類') : null; }).filter(Boolean))];
  const catLabelFn = (c) => (typeof catLabel === 'function') ? catLabel(c) : c;
  const filters = `
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field">
        <label>${t('fieldFilterByCategory')}</label>
        <select onchange="bt.category=this.value;bt.productId='';renderBatchTracker();">
          <option value="">${t('catFilterAll')}</option>
          ${usedCats.map(c => `<option value="${batchEsc(c)}" ${bt.category === c ? 'selected' : ''}>${batchEsc(catLabelFn(c))}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="min-width:220px;">
        <label>${t('batchSearchProduct')}</label>
        <input type="text" value="${batchEsc(bt.search)}" oninput="bt.search=this.value;batchTrackerRefreshList();" />
      </div>
    </div>`;
  if(bt.productId) return filters + batchRenderProductDetail(bt.productId);
  return filters + `<div id="batchProductList">${batchProductListHtml()}</div>`;
}
function batchTrackerRefreshList(){
  const el = document.getElementById('batchProductList');
  if(el) el.innerHTML = batchProductListHtml();
}
function batchProductListHtml(){
  const trackedIds = [...new Set(batchData.items.map(i => i.productId))];
  const q = bt.search.trim().toLowerCase();
  const rows = trackedIds.map(pid => ({ pid, p: products.find(x => x.id === pid) }))
    .filter(r => r.p && (!bt.category || (r.p.category || '未分類') === bt.category) && (!q || (r.p.name || '').toLowerCase().includes(q) || (r.p.sku || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.p.name || '').localeCompare(b.p.name || ''));
  if(rows.length === 0) return `<div class="empty-note">${t('batchNoTrackedProducts')}</div>`;
  return `<table class="stock-table">
    <thead><tr><th>${t('colProduct')}</th><th class="num">${t('batchColRemaining')}</th><th class="num">${t('batchColBatchCount')}</th><th>${t('batchColNearestExpiry')}</th></tr></thead>
    <tbody>${rows.map(({ pid, p }) => {
      const live = batchItemsOfProduct(pid);
      const total = live.reduce((s, i) => s + i.remaining, 0);
      const nearest = live.find(i => i.expiry);
      return `<tr style="cursor:pointer;" onclick="batchTrackerOpenProduct('${pid}')">
        <td>${batchEsc(p.name)}</td>
        <td class="num">${batchFmtQty(total)} ${batchEsc(p.unit || '')}</td>
        <td class="num">${live.length}</td>
        <td>${nearest ? batchEsc(nearest.expiry) + batchExpiryBadge(nearest.expiry) : '–'}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}
function batchRenderProductDetail(pid){
  const p = products.find(x => x.id === pid);
  const items = batchItemsOfProduct(pid, bt.includeDepleted);
  const liveTotal = batchItemsOfProduct(pid).reduce((s, i) => s + i.remaining, 0);
  let untrackedRow = '';
  try{
    const stock = computeStock(pid);
    const diff = stock - liveTotal;
    if(Math.abs(diff) > 1e-9) untrackedRow = `<tr style="background:var(--bg-soft,#f5f5f0);"><td colspan="2">${diff > 0 ? t('batchUntracked') : t('batchOverTracked')}</td><td class="num">${batchFmtQty(Math.abs(diff))}</td><td colspan="5" style="font-size:11.5px;color:var(--ink-soft);">${t('batchUntrackedHint')}</td></tr>`;
  }catch(e){}
  return `
    <div style="margin:6px 0 10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <span class="batch-link" onclick="bt.productId='';renderBatchTracker();">← ${t('batchBackToList')}</span>
      <strong>${batchEsc(p ? p.name : pid)}</strong>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
        <input type="checkbox" ${bt.includeDepleted ? 'checked' : ''} onchange="bt.includeDepleted=this.checked;renderBatchTracker();" /> ${t('batchIncludeDepleted')}
      </label>
    </div>
    <table class="stock-table">
      <thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('batchColRemaining')}</th><th class="num">${t('batchColUnitCost')}</th><th>${t('batchFieldLot')}</th><th>Invoice</th><th>${t('batchColSupplier')}</th><th></th></tr></thead>
      <tbody>
        ${items.length === 0 ? `<tr><td colspan="8" class="empty-note">${t('batchNoBatches')}</td></tr>` : items.map(i => `
          <tr>
            <td><span class="batch-link" onclick="batchTrackerOpenBatch('${i.batchId}')">${batchEsc(i.batchNo)}</span>${i.isOpening ? ' <span style="color:var(--ink-soft);font-size:11px;">(' + t('batchOpening') + ')</span>' : ''}</td>
            <td>${i.expiry ? batchEsc(i.expiry) + batchExpiryBadge(i.expiry) : '–'}</td>
            <td class="num"><span class="batch-link" onclick="batchOpenInfoPopup('${i.id}','qty')">${batchFmtQty(i.remaining)} ${batchEsc(batchProductUnit(pid))}</span></td>
            <td class="num">${batchFmtMoney(batchUnitCost(i))}</td>
            <td>${batchEsc(i.supplierLot) || '–'}</td>
            <td>${batchEsc(i.invoiceNo) || '–'}</td>
            <td>${batchEsc(i.supplier) || '–'}</td>
            <td><span class="del-link" onclick="batchOpenInfoPopup('${i.id}','history')">${t('batchBtnHistory')}</span></td>
          </tr>`).join('')}
        ${untrackedRow}
      </tbody>
    </table>`;
}

function batchRenderBatchView(){
  // 批次清單(一個批次一列)→ 點進去看這個批次的所有商品
  if(!bt.batchId){
    const batches = {};
    batchData.items.forEach(i => { if(!batches[i.batchId]) batches[i.batchId] = { id: i.batchId, no: i.batchNo, date: i.batchDate, invoice: i.invoiceNo, supplier: i.supplier, isOpening: i.isOpening, n: 0 }; batches[i.batchId].n++; });
    const list = Object.values(batches).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.no.localeCompare(a.no));
    return batchBatchTableHtml(list);
  }
  const items = batchData.items.filter(i => i.batchId === bt.batchId);
  if(items.length === 0) return `<div class="empty-note">${t('batchNoBatches')}</div>`;
  const h = items[0];
  return `
    <div style="margin:6px 0 10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <span class="batch-link" onclick="bt.batchId='';renderBatchTracker();">← ${t('batchBackToList')}</span>
      <strong>${batchEsc(h.batchNo)}</strong>
      <span style="font-size:12px;color:var(--ink-soft);">${batchEsc(h.isOpening ? t('batchOpening') : h.batchDate)} · Invoice ${batchEsc(h.invoiceNo) || '–'} · ${batchEsc(h.supplier) || '–'}</span>
    </div>
    <table class="stock-table">
      <thead><tr><th>${t('colProduct')}</th><th class="num">${t('batchColQtyIn')}</th><th class="num">${t('batchColRemaining')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('batchColUnitCost')}</th><th>${t('batchFieldLot')}</th><th></th></tr></thead>
      <tbody>${items.sort((a, b) => batchProductName(a.productId).localeCompare(batchProductName(b.productId))).map(i => `
        <tr>
          <td><span class="batch-link" onclick="batchTrackerOpenProduct('${i.productId}')">${batchEsc(batchProductName(i.productId))}</span></td>
          <td class="num">${batchFmtQty(i.qtyIn)}</td>
          <td class="num"><span class="batch-link" onclick="batchOpenInfoPopup('${i.id}','qty')">${batchFmtQty(i.remaining)} ${batchEsc(batchProductUnit(i.productId))}</span></td>
          <td>${i.expiry ? batchEsc(i.expiry) + batchExpiryBadge(i.expiry) : '–'}</td>
          <td class="num">${batchFmtMoney(batchUnitCost(i))}</td>
          <td>${batchEsc(i.supplierLot) || '–'}</td>
          <td><span class="del-link" onclick="batchOpenInfoPopup('${i.id}','history')">${t('batchBtnHistory')}</span></td>
        </tr>`).join('')}</tbody>
    </table>`;
}
function batchBatchTableHtml(list){
  if(list.length === 0) return `<div class="empty-note">${t('batchNoBatches')}</div>`;
  return `<table class="stock-table">
    <thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColDate')}</th><th>Invoice</th><th>${t('batchColSupplier')}</th><th class="num">${t('batchColItemCount')}</th></tr></thead>
    <tbody>${list.map(b => `<tr>
      <td><span class="batch-link" onclick="batchTrackerOpenBatch('${b.id}')">${batchEsc(b.no)}</span></td>
      <td>${b.isOpening ? t('batchOpening') : batchEsc(b.date)}</td>
      <td>${batchEsc(b.invoice) || '–'}</td><td>${batchEsc(b.supplier) || '–'}</td><td class="num">${b.n}</td>
    </tr>`).join('')}</tbody></table>`;
}
function batchRenderDateView(){
  const batches = {};
  batchData.items.forEach(i => {
    if(bt.from && i.batchDate < bt.from) return;
    if(bt.to && i.batchDate > bt.to) return;
    if(!batches[i.batchId]) batches[i.batchId] = { id: i.batchId, no: i.batchNo, date: i.batchDate, invoice: i.invoiceNo, supplier: i.supplier, isOpening: i.isOpening, n: 0 };
    batches[i.batchId].n++;
  });
  const list = Object.values(batches).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.no.localeCompare(a.no));
  return `
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('batchDateFrom')}</label><input type="date" value="${bt.from}" onchange="bt.from=this.value;renderBatchTracker();" /></div>
      <div class="field"><label>${t('batchDateTo')}</label><input type="date" value="${bt.to}" onchange="bt.to=this.value;renderBatchTracker();" /></div>
    </div>
    ${batchBatchTableHtml(list)}`;
}

// 「未分配出貨」橫幅:已追蹤商品的出貨交易還沒(完整)分配到批次(例如分配那一步剛好斷線)
async function batchLoadUnallocatedBanner(){
  const el = document.getElementById('batchUnallocatedBanner');
  if(!el) return;
  try{
    const { data, error } = await sb.from('batch_unallocated_tx').select('tx_id,product_id,unallocated,tx_date').limit(500);
    if(error) throw error;
    // 只列「還有批次庫存可以分配」的商品;批次全部出完後超出的部分本來就是未追蹤,不用一直提醒
    const rows = (data || []).filter(r => batchItemsOfProduct(r.product_id).length > 0);
    const stillThere = document.getElementById('batchUnallocatedBanner');
    if(!stillThere) return;
    if(rows.length === 0){ stillThere.innerHTML = ''; return; }
    stillThere.innerHTML = `<div style="border:1px solid var(--warn,#B8860B);background:var(--warn-bg,#FFF8E1);padding:8px 12px;margin-bottom:10px;font-size:12.5px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <span>⚠ ${tf('batchUnallocatedBanner', { n: rows.length })}</span>
      <button class="btn ghost" onclick="batchBackfillAllocate()">${t('batchBtnBackfill')}</button>
      <span id="batchBackfillMsg" style="font-size:12px;"></span>
    </div>`;
  } catch(e){ console.warn('讀取未分配出貨失敗', e); }
}
async function batchBackfillAllocate(){
  const msg = document.getElementById('batchBackfillMsg');
  try{
    const { data, error } = await sb.from('batch_unallocated_tx').select('tx_id').limit(1000);
    if(error) throw error;
    const ids = (data || []).map(r => r.tx_id);
    for(let i = 0; i < ids.length; i += 100){
      await batchRpc('batch_allocate', { p_tx_ids: ids.slice(i, i + 100), p_manual: {} });
    }
    batchMarkStale();
    await ensureBatchDataLoaded(true);
    renderBatchTracker();
  } catch(e){
    console.error('補分配失敗', e);
    if(msg){ msg.style.color = 'var(--crit)'; msg.textContent = t('batchAllocFailedShort'); }
  }
}

// 數量/歷史小視窗
function batchCloseInfoPopup(){ const ov = document.getElementById('batchInfoOverlay'); if(ov) ov.remove(); }
const BATCH_KIND_LABEL_KEY = { out: 'batchKindOut', return: 'batchKindReturn', convert_out: 'batchKindConvertOut', convert_in: 'batchKindConvertIn', adjust: 'batchKindAdjust' };
async function batchOpenInfoPopup(itemId, mode){
  const i = batchData.items.find(x => x.id === itemId);
  if(!i) return;
  batchCloseInfoPopup();
  const ov = document.createElement('div');
  ov.id = 'batchInfoOverlay';
  ov.className = 'modal-overlay';
  ov.style.display = 'flex';
  ov.style.zIndex = '1150';
  ov.onclick = (e) => { if(e.target === ov) batchCloseInfoPopup(); };
  ov.innerHTML = `<div class="modal-box modal-box-wide"><div id="batchInfoBody">${t('batchLoading')}</div>
    <div class="modal-actions"><button class="btn ghost" onclick="batchCloseInfoPopup()">${t('btnClose') !== 'btnClose' ? t('btnClose') : 'Close'}</button></div></div>`;
  document.body.appendChild(ov);
  let moves = [];
  try{
    const { data, error } = await sb.from('batch_movements').select('mv_date,qty,kind,party,order_no,note,created_at').eq('batch_item_id', itemId).order('mv_date', { ascending: true }).order('id', { ascending: true });
    if(error) throw error;
    moves = data || [];
  } catch(e){ console.error(e); }
  const body = document.getElementById('batchInfoBody');
  if(!body) return;
  const unit = batchEsc(batchProductUnit(i.productId));
  const head = `<div class="section-title" style="margin-top:0;">${batchEsc(batchProductName(i.productId))} · ${batchEsc(i.batchNo)}${i.expiry ? ' · ' + t('batchExpiryShort') + ' ' + batchEsc(i.expiry) : ''}</div>`;
  if(mode === 'qty'){
    const sumKind = k => moves.filter(m => m.kind === k).reduce((s, m) => s + Number(m.qty), 0);
    const row = (label, v) => `<tr><td>${label}</td><td class="num">${v > 0 ? '+' : ''}${batchFmtQty(v)} ${unit}</td></tr>`;
    body.innerHTML = head + `<table class="stock-table"><tbody>
      ${row(t('batchQtyOriginal'), i.qtyIn)}
      ${row(t('batchKindOut'), sumKind('out'))}
      ${sumKind('return') ? row(t('batchKindReturn'), sumKind('return')) : ''}
      ${sumKind('convert_out') ? row(t('batchKindConvertOut'), sumKind('convert_out')) : ''}
      ${sumKind('convert_in') ? row(t('batchKindConvertIn'), sumKind('convert_in')) : ''}
      ${sumKind('adjust') ? row(t('batchKindAdjust'), sumKind('adjust')) : ''}
      <tr style="font-weight:700;"><td>${t('batchColRemaining')}</td><td class="num">${batchFmtQty(i.remaining)} ${unit}</td></tr>
    </tbody></table>`;
  } else {
    body.innerHTML = head + `<table class="stock-table">
      <thead><tr><th>${t('colDate')}</th><th>${t('colType')}</th><th class="num">${t('colQty')}</th><th>${t('batchColParty')}</th><th>${t('batchColOrderNo')}</th></tr></thead>
      <tbody>
        <tr><td>${batchEsc(i.isOpening ? t('batchOpening') : i.batchDate)}</td><td>${t('batchKindIn')}</td><td class="num">+${batchFmtQty(i.qtyIn)} ${unit}</td><td>${batchEsc(i.supplier) || '–'}</td><td>${batchEsc(i.invoiceNo) || '–'}</td></tr>
        ${moves.map(m => `<tr><td>${batchEsc(m.mv_date)}</td><td>${t(BATCH_KIND_LABEL_KEY[m.kind] || 'batchKindAdjust')}</td><td class="num">${Number(m.qty) > 0 ? '+' : ''}${batchFmtQty(Number(m.qty))} ${unit}</td><td>${batchEsc(m.party) || '–'}</td><td>${batchEsc(m.order_no) || '–'}</td></tr>`).join('')}
      </tbody></table>`;
  }
}

// ------------------------------------------------------------
// 登記進出貨 → 載入已完成訂單:每個商品顯示目前用了哪些批次;改數量(增加)可以指定批次
// 同批次的增加量會直接加到該批次的數量;不同批次則多出一個批次標籤與數量。
// ------------------------------------------------------------
function batchExistingItemTracked(it){
  return typeof registerOutFlowType !== 'undefined' && registerOutFlowType === 'load-completed' && batchIsTracked(it.productId) && it.qty > 0;
}
function batchExistingItemLineHtml(it){
  return ''; // 不主動顯示,點「批次」按鈕在視窗裡看
  if(!batchExistingItemTracked(it)) return '';
  return `<div class="batch-alloc-line batch-order-line" data-pid="${it.productId}"></div>`;
}
function batchExistingItemButtonHtml(it, pending){
  if(!batchExistingItemTracked(it)) return '';
  return `<span class="del-link" onclick="batchOpenOrderBreakdownView('${it.productId}')">${t('btnBatchPick')}</span>`;
}
function batchOpenPickerForExistingItem(productId){
  const order = orders.find(o => o.id === registerLoadedOrderId);
  const item = order ? order.items.find(x => x.productId === productId && !x.deleted) : null;
  const input = document.getElementById('txExistingItemQtyInput_' + productId);
  const pending = registerPendingItemChanges[productId];
  if(!item) return;
  // 編輯中用輸入框的數字;不在編輯中則用已暫存的新數量
  const typed = input ? parseFloat(input.value) : (pending && pending.type === 'qty' ? pending.newQty : NaN);
  const delta = typed - item.qty;
  if(!(delta > 0)){ showInfoModal(t('batchPickNeedIncrease')); return; }
  batchOpenPicker({
    productId, qty: delta, unit: item.unit,
    picks: batchEditPicks[productId] || (pending && pending.picks) || [],
    onSave: picks => {
      if(picks.length) batchEditPicks[productId] = picks; else delete batchEditPicks[productId];
      if(!input){
        // 不在編輯中(數量已暫存):指定的批次直接存進暫存變更,並重畫預覽
        if(pending){ if(picks.length) pending.picks = picks; else delete pending.picks; }
        delete batchEditPicks[productId];
        renderTxExistingItems();
        return;
      }
      const btn = document.getElementById('batchExistBtn_' + productId);
      if(btn) btn.textContent = t('btnBatchPick') + (picks.length ? ' ✓' : '');
    }
  });
}
async function batchGetOrderBreakdown(orderId){
  if(batchOrderCache[orderId]) return batchOrderCache[orderId];
  const p = (async () => {
    const { data, error } = await sb.from('batch_movements').select('batch_item_id,qty,kind').eq('order_id', orderId).in('kind', ['out', 'return']);
    if(error) throw error;
    const map = {};
    (data || []).forEach(m => {
      const i = batchData.items.find(x => x.id === m.batch_item_id);
      if(!i) return;
      map[i.productId] = map[i.productId] || {};
      map[i.productId][m.batch_item_id] = (map[i.productId][m.batch_item_id] || 0) - Number(m.qty);
    });
    return map;
  })();
  batchOrderCache[orderId] = p;
  p.catch(() => { delete batchOrderCache[orderId]; });
  return p;
}
async function batchFillOrderBreakdown(root, order){
  try{
    if(!batchActive() || !root) return;
    const els = Array.from(root.querySelectorAll('.batch-order-line'));
    if(els.length === 0) return;
    await ensureBatchDataLoaded();
    const map = await batchGetOrderBreakdown(order.id);
    els.forEach(el => {
      const pid = el.dataset.pid;
      const item = order.items.find(x => x.productId === pid && !x.deleted);
      const cur = Object.assign({}, map[pid] || {});
      const add = {}, manual = {};
      let addUntracked = 0;
      const pending = registerPendingItemChanges[pid];
      if(item && pending && pending.type === 'qty' && pending.newQty > item.qty){
        const alloc = batchPreviewAllocation(pid, pending.newQty - item.qty, pending.picks);
        alloc.lines.forEach(l => { add[l.item.id] = (add[l.item.id] || 0) + l.qty; if(l.manual) manual[l.item.id] = true; });
        addUntracked = alloc.untracked;
      }
      const ids = [...new Set([...Object.keys(cur), ...Object.keys(add)])]
        .map(id => batchData.items.find(x => x.id === id)).filter(Boolean).sort(batchFefoCompare);
      let html = ids.map(i => {
        const base = cur[i.id] || 0, plus = add[i.id] || 0;
        const exp = i.expiry ? ' · ' + t('batchExpiryShort') + ' ' + batchEsc(i.expiry) : '';
        return `<span class="batch-tag">${batchEsc(i.batchNo)} ×${batchFmtQty(base + plus)}${exp}${plus ? `<i style="color:var(--warn-dark,#B8860B);font-weight:700;">+${batchFmtQty(plus)} ${manual[i.id] ? t('batchManualTag') : t('batchAutoTag')}</i>` : ''}</span>`;
      }).join('');
      if(addUntracked > 0) html += `<span class="batch-tag batch-tag-warn">${t('batchUntracked')} +${batchFmtQty(addUntracked)}</span>`;
      el.innerHTML = html;
    });
  } catch(e){ console.warn('訂單批次明細載入失敗', e); }
}

// 載入已完成訂單:原本的品項已經出貨,批次視窗只能看(每個批次出了多少),不能改。
async function batchOpenOrderBreakdownView(productId){
  const order = orders.find(o => o.id === registerLoadedOrderId);
  if(!order) return;
  batchClosePicker();
  const ov = document.createElement('div');
  ov.id = 'batchPickerOverlay';
  ov.className = 'modal-overlay';
  ov.style.display = 'flex';
  ov.style.zIndex = '1150';
  ov.innerHTML = `<div class="modal-box modal-box-wide"><div id="batchOrderViewBody">${t('batchLoading')}</div>
    <div class="modal-actions"><button class="btn ghost" onclick="batchClosePicker()">${t('btnClose')}</button></div></div>`;
  document.body.appendChild(ov);
  let rows = [];
  try{
    batchOrderCache = {}; // 每次都重新讀,確保反映最新儲存的結果
    await ensureBatchDataLoaded();
    const map = await batchGetOrderBreakdown(order.id);
    rows = Object.keys(map[productId] || {}).map(id => ({ item: batchData.items.find(x => x.id === id), qty: map[productId][id] }))
      .filter(r => r.item && r.qty > 0).sort((a, b) => batchFefoCompare(a.item, b.item));
  } catch(e){ console.error(e); }
  const body = document.getElementById('batchOrderViewBody');
  if(!body) return;
  const unit = batchEsc(batchProductUnit(productId));
  body.innerHTML = `<div class="section-title" style="margin-top:0;">${t('batchPickerTitle')}</div>
    <p style="margin-bottom:10px;">${batchEsc(batchProductName(productId))} · ${t('batchOrderViewHint')}</p>
    ${rows.length === 0 ? `<div class="empty-note">${t('batchOrderViewEmpty')}</div>` : `
    <table class="stock-table"><thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('batchColAllocated')}</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${batchEsc(r.item.batchNo)}${r.item.isOpening ? ' (' + t('batchOpening') + ')' : ''}</td><td>${r.item.expiry ? batchEsc(r.item.expiry) : '–'}</td><td class="num">${batchFmtQty(r.qty)} ${unit}</td></tr>`).join('')}</tbody></table>`}`;
}
