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
const BATCH_EXPIRY_WARN_DAYS = 30;               // 預設值;實際用 batchWarnDays()(系統設置可改)
function batchWarnDays(){ return (typeof getBatchExpiryWarnDays === 'function') ? getBatchExpiryWarnDays() : BATCH_EXPIRY_WARN_DAYS; }

let batchAvailable = true;                       // 資料表不存在時變 false → 功能整個停用
let batchData = { items: [], loaded: false, stale: false, error: '' };
// 庫存位置分批次:batch_item_id -> [{ code, qty }](只含有指定位置的;沒指定的 = 進貨量 − 加總 = 未分配位置)
let batchItemLocs = {};
// 位置剩餘量(含出貨異動):batch_item_id -> [{ code, rem }](視圖 batch_item_loc_stock,需先執行 sql/batch_location_phase_b.sql)
let batchItemLocRem = {};
// 出貨前選好的「批次 × 位置」分配計畫:productId -> [{ batchItemId, code, qty }],出貨寫入後由 batchAllocateAfter 取用
let batchLocPlans = {};
let batchDataPromise = null;
let batchTxMoveCache = {};                       // txId -> [{ batch_item_id, qty, kind }]
let batchPicks = {};                             // `${orderId}::${productId}` -> [{ batchItemId, qty }](核對頁手動指定)
let txBatchTrackChecked = true;                  // 登記進貨「進入批次追蹤」勾選狀態(預設勾選)
let batchFormExtrasSig = '';
let batchOrderDetailCache = {};                  // orderId -> Promise<{ productId: [{ item, qty, shipCost }] }>(已完成訂單詳情用)
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
    .batch-info-icon{ color:var(--ink-soft); text-decoration:none; cursor:pointer; }
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
    const itemSelect = cols => () => sb.from('batch_items')
      .select('id,batch_id,product_id,expiry,qty_in,unit_cost_base,unit_cost_total,supplier_lot,batches(' + cols + ')')
      .order('id', { ascending: true });
    const fetchItems = async () => {
      // margin_pct 欄位需要先執行 sql/batch_tracking_phase3c_margin.sql;還沒執行就先不帶這個欄位
      try{ return await fetchAllPages(itemSelect('batch_no,batch_date,purchase_id,is_opening,invoice_no,supplier,margin_pct')); }
      catch(e){
        if(/margin_pct/i.test((e && e.message) || '')) return fetchAllPages(itemSelect('batch_no,batch_date,purchase_id,is_opening,invoice_no,supplier'));
        throw e;
      }
    };
    const [itemRows, stockRows] = await Promise.all([
      fetchItems(),
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
        marginPct: (b.margin_pct === null || b.margin_pct === undefined) ? null : Number(b.margin_pct),
        remaining: remMap[r.id] !== undefined ? remMap[r.id] : Number(r.qty_in)
      };
    });
    batchData.loaded = true; batchData.stale = false; batchData.error = '';
    batchAvailable = true;
    // 商品行備註(batch_items.note,需先執行 sql/batch_location_phase_a.sql);沒有這個欄位就略過
    try{
      const noteRows = await fetchAllPages(() => sb.from('batch_items').select('id,note').not('note', 'is', null).order('id', { ascending: true }));
      const nm = {}; noteRows.forEach(r => { nm[r.id] = r.note || ''; });
      batchData.items.forEach(i => { i.note = nm[i.id] || ''; });
    }catch(e){ batchData.items.forEach(i => { i.note = ''; }); }
    // 位置資料(需先執行 sql/batch_location_phase_a.sql);表不存在或讀取失敗只是沒有位置顯示,不影響其他批次功能
    batchItemLocs = {};
    try{
      const locRows = await fetchAllPages(() => sb.from('batch_item_locations').select('batch_item_id,location_code,qty').order('id', { ascending: true }));
      locRows.forEach(r => { (batchItemLocs[r.batch_item_id] = batchItemLocs[r.batch_item_id] || []).push({ code: r.location_code, qty: Number(r.qty) }); });
    }catch(e){ if(!batchIsMissingTableError(e)) console.warn('批次位置資料讀取失敗', e); }
    batchItemLocRem = {};
    try{
      const remRows = await fetchAllPages(() => sb.from('batch_item_loc_stock').select('batch_item_id,location_code,remaining').order('batch_item_id', { ascending: true }));
      remRows.forEach(r => { (batchItemLocRem[r.batch_item_id] = batchItemLocRem[r.batch_item_id] || []).push({ code: r.location_code, rem: Number(r.remaining) }); });
    }catch(e){
      // 視圖還沒建立(phase b SQL 未執行):退回用進貨時記的位置數量(不含出貨異動)
      Object.keys(batchItemLocs).forEach(id => { batchItemLocRem[id] = batchItemLocs[id].map(l => ({ code: l.code, rem: l.qty })); });
    }
  } catch(e){
    console.warn('批次資料讀取失敗', e);
    // 資料表還沒建立(SQL 還沒執行)→ 整個功能停用;其他錯誤(網路…)只是這次沒載到
    if(e && (e.code === 'PGRST205' || e.code === '42P01' || /does not exist|schema cache/i.test(e.message || ''))) batchAvailable = false;
    batchData.items = []; batchData.loaded = true; batchData.stale = false; batchData.error = (e && e.message) || String(e);
  }
  try{ if(typeof renderStockCards === 'function' && document.getElementById('stockCards')) renderStockCards(); }catch(e){}
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
function batchMarkStale(){ batchData.stale = true; batchTxMoveCache = {}; batchOrderCache = {}; batchOrderDetailCache = {}; }

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------
function batchEsc(s){ return String(s === null || s === undefined ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function batchProductName(pid){ const p = products.find(x => x.id === pid); return p ? p.name : pid; }
function batchProductUnit(pid){ const p = products.find(x => x.id === pid); return p ? (p.unit || '') : ''; }
function batchFmtQty(n){ return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
// 金額顯示跟隨「系統預設幣種」(系統管理 → 系統設置):AUD 維持 $,其他幣種顯示幣種代碼
function batchFmtMoney(n){
  if(n === null || n === undefined) return '–';
  const cur = (typeof getSystemCurrency === 'function') ? getSystemCurrency() : 'AUD';
  return (cur === 'AUD' ? '$' : cur + ' ') + Number(n).toFixed(2);
}
function batchUnitCost(i){ return (i.unitCostTotal !== null && i.unitCostTotal !== undefined) ? i.unitCostTotal : i.unitCostBase; }

// ---- 出貨當下單價快照(batch_movements.unit_cost,見 sql/batch_tracking_phase2b_ship_cost_snapshot.sql)----
// 畫面上顯示「目前的批次單價」;如果出貨當時的價格跟現在不同(例如後來更新了報關費),在旁邊標一個記號,
// 點一下顯示出貨當時用的價格。SQL 還沒執行(沒有 unit_cost 欄位)時自動退回不含價格的查詢。
let batchShipCostSupported = true;
async function batchSelectMovements(cols, apply){
  if(batchShipCostSupported){
    const r = await apply(sb.from('batch_movements').select(cols + ',unit_cost'));
    if(!r.error) return r;
    if(!/unit_cost/i.test(r.error.message || '')) return r;
    batchShipCostSupported = false;
  }
  return apply(sb.from('batch_movements').select(cols));
}
function batchNum(v){ return (v === null || v === undefined || v === '') ? null : Number(v); }
function batchCostDiffers(ship, cur){
  const a = batchNum(ship), b = batchNum(cur);
  if(a === null && b === null) return false;
  if(a === null || b === null) return true;
  return Math.abs(a - b) >= 0.005;
}
// 目前批次單價 + (出貨價不同時)可點擊的記號
function batchCostWithFlag(shipCost, item){
  const cur = batchUnitCost(item);
  const ship = batchNum(shipCost);
  let html = batchFmtMoney(cur);
  if(batchShipCostSupported && batchCostDiffers(ship, cur)){
    html += ` <span class="batch-cost-flag" title="${batchEsc(t('batchCostFlagTitle'))}" style="cursor:pointer;color:var(--warn-dark,#b45309);font-weight:700;" onclick="batchShowShipCost(event, ${ship === null ? 'null' : ship}, ${cur === null || cur === undefined ? 'null' : cur})">ⓘ</span>`;
  }
  return html;
}
function batchShowShipCost(ev, ship, cur){
  ev.stopPropagation();
  const old = document.getElementById('batchShipCostPop');
  if(old) old.remove();
  const pop = document.createElement('div');
  pop.id = 'batchShipCostPop';
  pop.style.cssText = 'position:fixed;z-index:3000;background:#fff;border:1px solid var(--line,#ccc);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:8px 12px;font-size:12.5px;max-width:260px;line-height:1.5;';
  pop.innerHTML = `<div><strong>${t('batchShipCostLabel')}:</strong> ${ship === null ? t('batchShipCostNone') : batchFmtMoney(ship)}</div>
    <div style="color:var(--ink-soft);">${t('batchCurrentCostLabel')}: ${batchFmtMoney(cur)}</div>`;
  document.body.appendChild(pop);
  const x = Math.min(ev.clientX, window.innerWidth - pop.offsetWidth - 8);
  const y = Math.min(ev.clientY + 12, window.innerHeight - pop.offsetHeight - 8);
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
  setTimeout(() => {
    const close = () => { pop.remove(); document.removeEventListener('click', close, true); };
    document.addEventListener('click', close, true);
  }, 0);
}

// 有效期先到期先出;沒有有效期的排後面,依進貨日 FIFO(期初批次日期最舊)。資料庫端排序規則一樣。
function batchFefoCompare(a, b){
  // 期初批次(沒有有效期、視為最舊)優先;其餘先到期先出,沒有有效期的排後面,再依進貨日 FIFO
  if(a.isOpening && !b.isOpening) return -1;
  if(!a.isOpening && b.isOpening) return 1;
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
// 庫存總覽用:一組商品(一個商品家族)裡「還有庫存」的批次行的到期狀態。
// 回傳 { status: 'expired'|'soon'|'', lines: [{ batchNo, expiry, days, remaining, productId }] }(lines 只含已過期/快到期的,依有效期由近到遠)。
function batchExpirySummary(productIds){
  if(!batchActive() || !batchData.loaded) return { status: '', lines: [] };
  const ids = new Set(productIds), warn = batchWarnDays();
  const lines = [];
  batchData.items.forEach(i => {
    if(!ids.has(i.productId) || !i.expiry || !(i.remaining > 0)) return;
    const d = batchDaysUntil(i.expiry);
    if(d <= warn) lines.push({ batchNo: i.batchNo, expiry: i.expiry, days: d, remaining: i.remaining, productId: i.productId });
  });
  lines.sort((a, b) => a.days - b.days);
  const status = lines.length === 0 ? '' : (lines[0].days < 0 ? 'expired' : 'soon');
  return { status, lines };
}
// 有效期旁的警示圖示(快到期 🟠 / 已過期 🔴),點擊才顯示「幾天後到期」
function batchExpiryIconHtml(expiry){
  if(!expiry) return '';
  const d = batchDaysUntil(expiry);
  if(d >= 0 && d > batchWarnDays()) return '';
  const icon = d < 0 ? '🔴' : '🟠';
  return ` <span style="cursor:pointer;" title="${batchEsc(t('batchExpiryIconTitle'))}" onclick="event.stopPropagation();batchShowExpiryInfo('${batchEsc(expiry)}')">${icon}</span>`;
}
function batchShowExpiryInfo(expiry){
  const d = batchDaysUntil(expiry);
  showInfoModal((d < 0 ? t('batchExpired') : tf('batchExpiresInDays', { n: d })) + ' (EXP ' + expiry + ')');
}
// 這個批次商品行的庫存價值(成本)= 剩餘量 × Total price;沒有成本資料回傳 null
function batchItemValue(i){
  const c = (typeof spTotalUnit === 'function') ? spTotalUnit(i) : null;
  return (c === null || !(i.remaining > 0)) ? null : c * i.remaining;
}
// 一組批次商品行的庫存價值加總:{ sum, missing(有庫存但沒成本的行數) }
function batchValueSum(items){
  let sum = 0, missing = 0;
  items.forEach(i => { if(!(i.remaining > 0)) return; const v = batchItemValue(i); if(v === null) missing++; else sum += v; });
  return { sum, missing };
}
function batchExpiryBadge(expiry, small){
  if(!expiry) return '';
  const d = batchDaysUntil(expiry);
  const sz = small ? 'font-size:11px;' : '';   // small:商品頁 / 批次頁用,比預設再小一點
  if(d < 0) return ` <span style="color:var(--crit);font-weight:700;${sz}">🔴 ${t('batchExpired')}</span>`;
  if(d <= batchWarnDays()) return ` <span style="color:#B8860B;font-weight:700;${sz}">🟠 ${tf('batchExpiresInDays', { n: d })}</span>`;
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
  // 有指定位置的 picks:每個(批次行, 位置)各自的數量
  const curCode = {};
  (opts.picks || []).forEach(p => { if(p.code !== undefined && p.code !== null) curCode[p.batchItemId + '|' + p.code] = (curCode[p.batchItemId + '|' + p.code] || 0) + p.qty; });
  const rows = items.map(i => {
    const buckets = batchBucketsOrdered(i);
    const multi = buckets.length > 1;
    const head = `${batchEsc(i.batchNo)}${i.isOpening ? ' <span style="color:var(--ink-soft);font-size:11px;">(' + t('batchOpening') + ')</span>' : ''}`;
    const exp = i.expiry ? batchEsc(i.expiry) + batchExpiryBadge(i.expiry) : '–';
    if(!multi){
      const b = buckets[0] || { code: '', rem: i.remaining };
      return `<tr>
        <td>${head}</td><td>${exp}</td>
        <td style="font-size:12px;">${b.code ? '📍 ' + batchEsc(b.code) : '<span style="color:var(--ink-soft);">–</span>'}</td>
        <td class="num">${batchFmtQty(i.remaining)}</td>
        <td class="num"><input type="number" class="batch-pick-input" data-id="${i.id}" data-code="${batchEsc(b.code)}" data-max="${i.remaining}" min="0" max="${i.remaining}" step="1" value="${cur[i.id] || ''}" oninput="batchPickerUpdateSum()" style="width:80px;" /></td>
      </tr>`;
    }
    // 同一個批次行放在多個位置:每個位置一列;預設顯示自動分配的結果(未分布先出、再依位置數量由多到少)
    let left = cur[i.id] || 0;
    const hasCodePicks = buckets.some(b => curCode[i.id + '|' + b.code] !== undefined);
    return buckets.map((b, k) => {
      let v = '';
      if(hasCodePicks){ v = curCode[i.id + '|' + b.code] || ''; }
      else if(left > 0){ const take = Math.min(left, b.rem); if(take > 0){ v = take; left -= take; } }
      return `<tr>
        <td>${k === 0 ? head : ''}</td><td>${k === 0 ? exp : ''}</td>
        <td style="font-size:12px;">${b.code ? '📍 ' + batchEsc(b.code) : '<span style="color:var(--ink-soft);">' + t('unassignedLocationLabel') + '</span>'}</td>
        <td class="num">${batchFmtQty(b.rem)}</td>
        <td class="num"><input type="number" class="batch-pick-input" data-id="${i.id}" data-code="${batchEsc(b.code)}" data-max="${b.rem}" min="0" max="${b.rem}" step="1" value="${v}" oninput="batchPickerUpdateSum()" style="width:80px;" /></td>
      </tr>`;
    }).join('');
  }).join('');
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
        <thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th>${t('batchLocTitle')}</th><th class="num">${t('batchColRemaining')}</th><th class="num">${t('batchColAllocated')}</th></tr></thead>
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
    if(v > 0) picks.push({ batchItemId: inp.dataset.id, qty: v, code: inp.dataset.code || '', max: parseFloat(inp.dataset.max) });
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
  const sums = {};
  picks.forEach(p => { sums[p.batchItemId] = (sums[p.batchItemId] || 0) + p.qty; });
  const same = Object.keys(sums).length === Object.keys(auto).length && Object.keys(sums).every(id => Math.abs((auto[id] || 0) - sums[id]) < 1e-9);
  batchClosePicker();
  if(onSave) onSave(same ? [] : picks.map(p => ({ batchItemId: p.batchItemId, qty: p.qty, code: p.code || '' })));
}

// ------------------------------------------------------------
// 訂單核對頁:每個商品「改數量」與「刪除」之間的「批次」按鈕、分配預覽
// ------------------------------------------------------------
// 批次圖示:黃色斜放的吊牌(inline SVG,不依賴字型,顏色在各種背景都清楚)
function batchTagIcon(){
  return '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-4px;"><g transform="rotate(35 12 12)"><path d="M7 6.5 L10 2.5 H14 L17 6.5 V20.5 a1.5 1.5 0 0 1 -1.5 1.5 H8.5 A1.5 1.5 0 0 1 7 20.5 Z" fill="#f6c21c" stroke="#a87a00" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="7.2" r="1.7" fill="#fff" stroke="#a87a00" stroke-width="1.2"/><path d="M9.5 13 H14.5 M9.5 16.5 H14.5" stroke="#a87a00" stroke-width="1.2" stroke-linecap="round"/></g></svg>';
}
function batchPickKey(orderId, productId){ return orderId + '::' + productId; }

function batchOrderItemButtonHtml(o, it){
  if(!batchIsTracked(it.productId) || !(it.qty > 0)) return '';
  const has = (batchPicks[batchPickKey(o.id, it.productId)] || []).length > 0;
  return `<span class="del-link" style="margin-left:8px;" title="${batchEsc(t('btnBatchPick'))}" onclick="batchOpenPickerForOrderItem('${o.id}','${it.productId}')">${batchTagIcon()}${has ? ' ✓' : ''}</span>`;
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
// 同一個 tx 的指定批次可能含多個位置的重複批次行,送資料庫前合併
function batchMergeManual(picks){
  const m = {};
  (picks || []).forEach(p => { m[p.batch_item_id] = (m[p.batch_item_id] || 0) + Number(p.qty); });
  return Object.keys(m).map(id => ({ batch_item_id: id, qty: m[id] }));
}
async function batchAllocateAfter(txList, picksByTx){
  if(!batchActive() || !txList || txList.length === 0) return;
  try{ await ensureBatchDataLoaded(); }catch(e){}
  const list = txList.filter(tx => batchIsTracked(tx.productId));
  if(list.length === 0) return;
  const ids = list.map(tx => tx.id);
  // 出貨前已經選好「批次 × 位置」的計畫(數量必須剛好等於這筆出貨)→ 直接用計畫的批次分配,資料庫就不會另外挑
  const planByTx = {};
  list.forEach(tx => {
    const plan = batchLocPlans[tx.productId];
    // 計畫只在剛選完位置的短時間內有效(避免之前被取消、沒用到的計畫被別的流程誤用)
    if(plan && plan.length && Date.now() - (plan.at || 0) < 120000 && Math.abs(plan.reduce((a, x) => a + x.qty, 0) - tx.qty) < 1e-9) planByTx[tx.id] = plan;
  });
  const manual = {};
  for(const tx of list){
    if(planByTx[tx.id]){ manual[tx.id] = batchMergeManual(planByTx[tx.id].map(x => ({ batch_item_id: x.batchItemId, qty: x.qty }))); continue; }
    let mp = (picksByTx && picksByTx[tx.id] && picksByTx[tx.id].length) ? picksByTx[tx.id].slice() : [];
    // 已完成訂單增加數量(補出貨):預設先拿這張訂單原本用的批次,那批沒了才依先到期先出往下拿
    if(tx.orderId){
      const pref = await batchOrderPreferredPicks(tx.orderId, tx.productId);
      mp = mp.concat(pref.map(x => ({ batch_item_id: x.batchItemId, qty: x.qty })));
    }
    if(mp.length) manual[tx.id] = batchMergeManual(mp);
  }
  let res;
  let usedFallback = false;
  try{
    res = await batchRpc('batch_allocate', { p_tx_ids: ids, p_manual: manual });
  } catch(e){
    if(Object.keys(manual).length > 0 && batchIsPickError(e)){
      try{
        res = await batchRpc('batch_allocate', { p_tx_ids: ids, p_manual: {} });
        usedFallback = true;
        showInfoModal(t('batchPickFallbackNotice'));
      } catch(e2){ batchAllocFailed(e2); list.forEach(tx => { delete batchLocPlans[tx.productId]; }); return; }
    } else { batchAllocFailed(e); list.forEach(tx => { delete batchLocPlans[tx.productId]; }); return; }
  }
  // 位置:把這次出貨在每個批次商品行扣的量拆到各位置(有計畫照計畫,沒有計畫就依預設順序)
  try{ await batchTagOutLocations(list, usedFallback ? {} : planByTx); }
  catch(e){ console.error('出貨位置標記失敗', e); showInfoModal(t('batchLocTagFailed')); }
  list.forEach(tx => { delete batchLocPlans[tx.productId]; });
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
    // 退貨只退回原批次;位置一律回到「未分布」(貨回倉庫時不知道原本放哪,之後再用庫存分布轉移、或批次追蹤的「設定位置」指派)
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
// 切換(multipack ⇄ 主商品)寫入後:同批次、同有效期一出一進;位置也一樣(從哪個位置切換,切出來的商品就放在同一個位置)。
// 回傳 null,或 { dest: [{ code, qty }] } = 切換出來的商品(目標商品)各位置的數量,給呼叫端同步庫存分布。
async function batchConvertAfter(conversionId, fromProductId, outQty, convertedQty){
  try{
    if(!batchActive()) return null;
    await ensureBatchDataLoaded();
    if(!batchIsTracked(fromProductId)) return null;
    // 切換前選好的「批次 × 位置」計畫(2 分鐘內有效、數量剛好等於這次切換量才採用)
    let plan = batchLocPlans[fromProductId];
    delete batchLocPlans[fromProductId];
    if(!(plan && plan.length && Date.now() - (plan.at || 0) < 120000 && Math.abs(plan.reduce((a, x) => a + x.qty, 0) - outQty) < 1e-9)) plan = null;
    const manual = plan ? batchMergeManual(plan.map(x => ({ batch_item_id: x.batchItemId, qty: x.qty }))) : [];
    let res;
    try{
      res = await batchRpc('batch_convert', { p_conversion_id: conversionId, p_manual: manual });
    } catch(e){
      // 指定的批次不能照原樣切換(例如換成大單位時數量不是換算比例的整數倍)→ 改回自動分配,不套用位置計畫
      if(plan && /batch_convert_step|batch_bad_pick|batch_insufficient/.test((e && e.message) || '')){
        plan = null;
        res = await batchRpc('batch_convert', { p_conversion_id: conversionId, p_manual: [] });
      } else throw e;
    }
    let dest = null;
    if(plan && res && res.tracked && !(res.untracked > 0)){
      const ratio = outQty > 0 ? convertedQty / outQty : 1;
      const okInt = plan.every(x => Math.abs(x.qty * ratio - Math.round(x.qty * ratio)) < 1e-9);
      if(okInt){
        try{
          await batchRpc('batch_tag_convert_locations', { p_conversion_id: conversionId, p_rows: plan.map(x => ({ batch_item_id: x.batchItemId, code: x.code, qty: x.qty })) });
          const m = {};
          plan.forEach(x => { if(x.code) m[x.code] = (m[x.code] || 0) + x.qty * ratio; });
          dest = { dest: Object.keys(m).map(c => ({ code: c, qty: Math.round(m[c]) })) };
        }catch(e){
          console.error('切換位置標記失敗', e);
          if(!batchIsMissingFunctionError(e)) showInfoModal(t('batchLocTagFailed'));
        }
      }
    }
    batchMarkStale();
    await ensureBatchDataLoaded();
    if(res && res.tracked && res.untracked > 0) showInfoModal(tf('batchConvertUntrackedNotice', { n: batchFmtQty(res.untracked) }));
    return dest;
  } catch(e){
    console.error('批次切換失敗', e);
    showInfoModal(t('batchConvertFailed'));
    return null;
  }
}
// 切換出來的商品放到跟來源一樣的位置(庫存分布):位置紀錄已存在就加上去,不存在就建立
async function batchAddToProductLocations(productId, dest){
  for(const d of (dest || [])){
    try{
      let loc = productLocations.find(l => l.productId === productId && l.locationCode === d.code);
      if(loc){ loc.qty += d.qty; await upsertProductLocation(loc); }
      else {
        const tpl = productLocations.find(l => l.locationCode === d.code);
        loc = { id: genId(), productId, zone: tpl ? tpl.zone : '', aisle: tpl ? tpl.aisle : '', bay: tpl ? tpl.bay : '', level: tpl ? tpl.level : '', bin: tpl ? tpl.bin : '', locationCode: d.code, qty: d.qty, photoUrl: null };
        productLocations.push(loc);
        await upsertProductLocation(loc);
      }
    }catch(e){ console.error('切換後同步庫存分布失敗', e); }
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
      if(!l){ l = { productId: pid, expiry: key, qty: 0, amount: null, totalAmount: null, origAmount: null, origCurrency: '', fxRate: null, supplierLot: '' }; lines.push(l); }
      l.qty += Number(it.qty) || 0;
      if(it.amount !== undefined && it.amount !== null) l.amount = (l.amount || 0) + Number(it.amount);
      if(it.totalAmount !== undefined && it.totalAmount !== null) l.totalAmount = (l.totalAmount || 0) + Number(it.totalAmount);
      if(it.origAmount !== undefined && it.origAmount !== null){ l.origAmount = (l.origAmount || 0) + Number(it.origAmount); l.origCurrency = it.origCurrency || l.origCurrency; l.fxRate = it.fxRate || l.fxRate; }
      if(it.supplierLot && !l.supplierLot) l.supplierLot = it.supplierLot;
    });
    g.cn.forEach(it => {
      let left = Number(it.qty) || 0;
      const unitAmt = (it.amount !== undefined && it.amount !== null && it.qty) ? Number(it.amount) / Number(it.qty) : null;
      const key = it.expiry || '';
      lines.slice().sort((a, b) => ((a.expiry === key ? 0 : 1) - (b.expiry === key ? 0 : 1)) || batchExpiryCompare(a.expiry, b.expiry)).forEach(l => {
        if(left <= 0 || l.qty <= 0) return;
        const take = Math.min(left, l.qty);
        const ratioLeft = (l.qty - take) / l.qty; // Credit Note 退掉的比例,總價/原幣金額照比例縮減
        l.qty -= take;
        if(unitAmt !== null && l.amount !== null) l.amount -= take * unitAmt;
        if(l.totalAmount !== null) l.totalAmount *= ratioLeft;
        if(l.origAmount !== null) l.origAmount *= ratioLeft;
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
    amount: l.amount === null ? null : l.amount, supplier_lot: l.supplierLot || '',
    // 第二期:總價 = 底價 + 分攤的其他支出;沒有分攤時總價等於底價
    total_amount: l.totalAmount !== null ? l.totalAmount : (l.amount === null ? null : l.amount),
    orig_amount: l.origAmount, orig_currency: l.origCurrency || '', fx_rate: l.fxRate
  }));
  const data = await batchRpc('batch_save_purchase', {
    p_purchase_id: purchase.id, p_date: purchase.date, p_invoice_no: purchase.invoiceNo || null,
    p_supplier: purchase.partyName || null, p_items: payload
  });
  // 第三期:新批次先帶入預設 margin(已經有 margin 的批次不動);margin 欄位沒建立(SQL 未執行)時略過
  try{
    if(data && data.batch_id && typeof spDefaultMargin === 'function') await batchRpc('batch_set_margin', { p_batch_id: data.batch_id, p_margin: spDefaultMargin(), p_only_if_null: true });
  }catch(e){ console.warn('設定批次預設 margin 失敗', e); }
  batchMarkStale();
  try{ await ensureBatchDataLoaded(); }catch(e){}
  return data;
}

// 編輯進貨單前先在前端檢查:數量不能低於該行已經出貨的量(最後以資料庫為準)
function batchValidatePurchaseEdit(purchase, newItems){
  if(!batchActive() || !purchase.batchTracked) return '';
  const mine = batchData.items.filter(i => i.purchaseId === purchase.id && i.qtyIn > 0);
  const lines = batchNetPurchaseLines(newItems);
  const sameKey = (l, i) => l.productId === i.productId && l.expiry === (i.expiry || '');
  for(const i of mine){
    const used = i.qtyIn - i.remaining;
    if(used <= 0) continue;
    let l = lines.find(x => sameKey(x, i));
    if(!l){
      // 只是改了有效期:同商品舊的行裡沒對應的只有這一行、新的清單裡沒對應現有行的也只有一行 → 視為同一行改有效期
      // (資料庫 batch_save_purchase 用同樣規則,出貨紀錄會跟著這一行走)
      const oldUnmatched = mine.filter(m => m.productId === i.productId && !lines.some(x => sameKey(x, m)));
      const newUnmatched = lines.filter(x => x.productId === i.productId && !mine.some(m => sameKey(x, m)));
      if(oldUnmatched.length === 1 && newUnmatched.length === 1) l = newUnmatched[0];
    }
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
    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--ink);cursor:pointer;white-space:nowrap;" title="${batchEsc(t('batchTrackToggleHint'))}">
      <input type="checkbox" id="txBatchTrackChk" ${txBatchTrackChecked ? 'checked' : ''} onchange="txBatchTrackChecked=this.checked;renderTxBatchList();" style="width:16px;height:16px;cursor:pointer;" />
      ${t('batchTrackToggle')}
    </label>`;
  // 有效期/供應商批號改在清單每一行填寫(有效期欄、📝 詳細資料),新增商品那一排不再有這兩欄
  extraWrap.style.display = 'none'; extraWrap.innerHTML = '';
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
// 日期欄位輸入年份時,每按一個數字瀏覽器就會觸發一次 change;如果每次都重畫清單,輸入框會被換掉而跳出。
// 所以 change 只暫存數值(不重畫),離開欄位(blur)才合併同商品同有效期的行並重畫。
function updateTxBatchItemExpiry(batchItemId, value){
  const it = txBatchItems.find(x => x.batchItemId === batchItemId);
  if(!it) return;
  it.expiry = value || '';
}
function commitTxBatchItemExpiry(batchItemId){
  const it = txBatchItems.find(x => x.batchItemId === batchItemId);
  if(!it) return;
  const other = txBatchItems.find(x => x !== it && x.productId === it.productId && (x.expiry || '') === (it.expiry || '')
    && (x.docType || '') === (it.docType || '') && (x.sourceFilename || '') === (it.sourceFilename || ''));
  if(other){
    other.qty += it.qty;
    if(it.amount !== undefined && it.amount !== null) other.amount = (other.amount || 0) + it.amount;
    if(it.supplierLot && !other.supplierLot) other.supplierLot = it.supplierLot;
    if(it.note) other.note = other.note ? other.note + '\n' + it.note : it.note;
    batchLocOnQtyChange(other);
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
  return `<button onclick="batchOpenPickerForTxItem('${it.batchItemId}')" title="${t('btnBatchPick')}">${batchTagIcon()}${has ? ' ✓' : ''}</button>`;
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
      const { data, error } = await batchSelectMovements('tx_id,batch_item_id,qty,kind,location_code', q => q.in('tx_id', chunk));
      if(error) throw error;
      chunk.forEach(id => { batchTxMoveCache[id] = []; });
      (data || []).forEach(m => { batchTxMoveCache[m.tx_id].push(m); });
    }
    els.forEach(el => {
      let html = '';
      if(el.dataset.batchType === 'in' && el.dataset.batchPurchase){
        html = batchData.items.filter(i => i.purchaseId === el.dataset.batchPurchase && i.productId === el.dataset.batchProduct)
          .map(i => `<span class="batch-tag">${batchEsc(i.batchNo)}${i.expiry ? ' · EXP ' + batchEsc(i.expiry) : ''}</span>`).join('');
      } else {
        html = (batchTxMoveCache[el.dataset.batchTx] || []).map(m => {
          const i = batchData.items.find(x => x.id === m.batch_item_id);
          if(!i) return '';
          return `<span class="batch-tag">${batchEsc(i.batchNo)} ×${batchFmtQty(Math.abs(Number(m.qty)))}${i.expiry ? ' · EXP ' + batchEsc(i.expiry) : ''}${m.location_code ? ' · 📍' + batchEsc(m.location_code) : ''}</span>`;
        }).join('');
      }
      el.innerHTML = html;
    });
  } catch(e){ console.warn('批次標籤載入失敗', e); }
}

// ------------------------------------------------------------
// 庫存總覽 → 批次追蹤
// ------------------------------------------------------------
let bt = { view: 'product', category: '', search: '', productId: '', includeDepleted: false, batchId: '', from: '', to: '', histItemId: '', back: null };

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
  if(bt.view === 'history'){
    // 歷史紀錄是一個頁面(不是視窗):整個批次追蹤區域換成歷史紀錄,按「上一頁」回到原本的清單
    root.innerHTML = batchRenderHistoryPage();
    return;
  }
  let body = '';
  let toolbarFilters = '';
  if(bt.view === 'batch') body = batchRenderBatchView();
  else if(bt.view === 'date') body = batchRenderDateView();
  else { toolbarFilters = batchProductFiltersHtml(); body = batchRenderProductView(); }
  root.innerHTML = `
    <div class="toolbar" style="margin-bottom:10px;">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <div class="section-title" style="margin:0;">${t('batchTrackerTitle')}</div>
        ${toolbarFilters}
      </div>
      <div class="batch-seg">${seg('product', t('batchViewProduct'))}${seg('batch', t('batchViewBatch'))}${seg('date', t('batchViewDate'))}</div>
    </div>
    <div id="batchUnallocatedBanner"></div>
    ${body}`;
  batchLoadUnallocatedBanner();
}

// 商品頁的「分類篩選 + 搜尋」放在標題列(跟「批次追蹤」標題同一行)
function batchProductFiltersHtml(){
  const trackedIds = [...new Set(batchData.items.map(i => i.productId))];
  const usedCats = [...new Set(trackedIds.map(pid => { const p = products.find(x => x.id === pid); return p ? (p.category || '未分類') : null; }).filter(Boolean))];
  const catLabelFn = (c) => (typeof catLabel === 'function') ? catLabel(c) : c;
  return `
    <select title="${t('fieldFilterByCategory')}" onchange="bt.category=this.value;bt.productId='';renderBatchTracker();">
      <option value="">${t('catFilterAll')}</option>
      ${usedCats.map(c => `<option value="${batchEsc(c)}" ${bt.category === c ? 'selected' : ''}>${batchEsc(catLabelFn(c))}</option>`).join('')}
    </select>
    <input type="search" value="${batchEsc(bt.search)}" placeholder="${batchEsc(t('batchSearchProduct'))}" style="width:190px;" oninput="bt.search=this.value;batchTrackerRefreshList();" />`;
}
function batchRenderProductView(){
  if(bt.productId) return batchRenderProductDetail(bt.productId);
  return `<div id="batchProductList">${batchProductListHtml()}</div>`;
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
        <td>${nearest ? batchEsc(nearest.expiry) + batchExpiryBadge(nearest.expiry, true) : '–'}</td>
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
    if(Math.abs(diff) > 1e-9) untrackedRow = `<tr style="background:var(--bg-soft,#f5f5f0);"><td colspan="2">${diff > 0 ? t('batchUntracked') : t('batchOverTracked')}</td><td class="num">${batchFmtQty(Math.abs(diff))}</td><td colspan="2" style="font-size:11.5px;color:var(--ink-soft);">${t('batchUntrackedHint')}</td></tr>`;
  }catch(e){}
  return `
    <div style="margin:12px 0 8px;"><span style="display:inline-block;padding:5px 12px;background:rgba(0,0,0,0.07);border-radius:3px;font-weight:700;">${batchEsc(p ? p.name : pid)}</span></div>
    <div style="margin:0 0 10px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
      <span class="batch-link" onclick="bt.productId='';renderBatchTracker();">← ${t('batchBackToList')}</span>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
        <input type="checkbox" ${bt.includeDepleted ? 'checked' : ''} onchange="bt.includeDepleted=this.checked;renderBatchTracker();" /> ${t('batchIncludeDepleted')}
      </label>
    </div>
    <table class="stock-table">
      <thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('batchColRemaining')}</th><th class="num">Sell price</th><th></th></tr></thead>
      <tbody>
        ${items.length === 0 ? `<tr><td colspan="5" class="empty-note">${t('batchNoBatches')}</td></tr>` : items.map(i => `
          <tr>
            <td><span class="batch-link" onclick="batchTrackerOpenBatch('${i.batchId}')">${batchEsc(i.batchNo)}</span>${i.isOpening ? ' <span style="color:var(--ink-soft);font-size:11px;">(' + t('batchOpening') + ')</span>' : ''}</td>
            <td>${i.expiry ? batchEsc(i.expiry) + batchExpiryBadge(i.expiry, true) : '–'}</td>
            <td class="num">${batchFmtQty(i.remaining)} ${batchEsc(batchProductUnit(pid))}</td>
            <td class="num">${(typeof spSellCellHtml === 'function') ? spSellCellHtml(i) : batchFmtMoney(batchUnitCost(i))}</td>
            <td style="white-space:nowrap;"><span class="del-link" onclick="batchTrackerOpenHistory('${i.id}')">${t('batchBtnHistory')}</span> <span class="batch-info-icon" style="margin-left:6px;" title="${batchEsc(t('batchDetailsTitle'))}" onclick="batchOpenItemDetail('${i.id}')">ⓘ</span></td>
          </tr>`).join('')}
        ${untrackedRow}
      </tbody>
      ${items.length === 0 ? '' : (() => { const live = items.filter(i => i.remaining > 0); const v = batchValueSum(live); const q = live.reduce((a, i) => a + i.remaining, 0); return `<tfoot><tr style="font-weight:700;"><td colspan="2" style="text-align:right;">${t('batchValueTotal')} · ${t('batchStockValue')} <span class="batch-info-icon" style="font-weight:400;" title="${batchEsc(t('batchValueHelpTitle'))}" onclick="showInfoModal(t('batchValueHelp'))">ⓘ</span>${v.missing ? `<div style="font-weight:400;font-size:11px;color:var(--ink-soft);">(${tf('batchValueMissing', { n: v.missing })})</div>` : ''}</td><td class="num" style="text-align:right;">${batchFmtQty(q)} ${batchEsc(batchProductUnit(pid))}</td><td class="num" style="text-align:right;">${(typeof spMoney === 'function') ? spMoney(v.sum) : v.sum.toFixed(2)}</td><td></td></tr></tfoot>`; })()}
    </table>`;
}

// ---- 詳細資料視窗 ----
function batchCloseDetail(){ const o = document.getElementById('batchDetailOverlay'); if(o) o.remove(); }
function batchShowDetailModal(title, bodyHtml){
  batchCloseDetail();
  const ov = document.createElement('div');
  ov.id = 'batchDetailOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1100';
  ov.onclick = e => { if(e.target === ov) batchCloseDetail(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:min(460px,92vw);">
    <div class="section-title" style="margin-top:0;">${title}</div>
    ${bodyHtml}
    <div class="modal-actions"><button class="btn ghost" onclick="batchCloseDetail()">${t('btnClose')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
const batchDetailRow = (label, val) => `<tr><td style="color:var(--ink-soft);white-space:nowrap;">${label}</td><td>${val || '–'}</td></tr>`;
// 商品頁:這個批次商品行的 供應商批號 / Invoice / 供應商
function batchOpenItemDetail(itemId){
  const i = batchData.items.find(x => x.id === itemId);
  if(!i) return;
  batchShowDetailModal(`${batchEsc(batchProductName(i.productId))}-${batchEsc(i.batchNo)}`, `<table class="stock-table"><tbody>
    ${batchDetailRow(t('batchFieldLot'), batchEsc(i.supplierLot))}
    ${batchDetailRow('Invoice', batchEsc(i.invoiceNo))}
    ${batchDetailRow(t('batchColSupplier'), batchEsc(i.supplier))}
    ${batchDetailRow(t('batchLocTitle'), batchLocSummaryHtml(i))}
    ${batchDetailRow(t('batchFieldNote'), batchEsc(i.note).replace(/\n/g, '<br>'))}
  </tbody></table>`);
}
// 批次頁:這個批次的 進貨日期 / Invoice / 供應商 / 各商品的供應商批號 / Margin 設置
function batchOpenBatchDetail(batchId){
  const items = batchData.items.filter(i => i.batchId === batchId);
  if(items.length === 0) return;
  const h = items[0];
  const lots = items.filter(i => i.supplierLot).map(i => `${batchEsc(batchProductName(i.productId))}: ${batchEsc(i.supplierLot)}`).join('<br>');
  const marginBlock = (typeof spMarginOf === 'function' && !h.isOpening) ? `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <strong style="font-size:12.5px;">Margin</strong>
        <input id="batchDetailMargin" type="number" min="0" step="any" value="${spMarginOf(h)}" style="width:90px;" /><span>%</span>
        <button class="btn" onclick="spSaveBatchMarginFromModal('${batchId}')">${t('btnSave')}</button>
      </div>
      <div style="margin-top:6px;"><span class="batch-link" style="font-size:12px;" onclick="spOpenDefaultMarginModal()">${t('spManageDefault')}</span></div>
      <div style="font-size:11.5px;color:var(--ink-soft);margin-top:4px;">Sell price = Total price × (1 + Margin%)</div>
    </div>` : '';
  batchShowDetailModal(batchEsc(h.batchNo), `<table class="stock-table"><tbody>
    ${batchDetailRow(t('batchColDate'), batchEsc(h.isOpening ? t('batchOpening') : h.batchDate))}
    ${batchDetailRow('Invoice', batchEsc(h.invoiceNo))}
    ${batchDetailRow(t('batchColSupplier'), batchEsc(h.supplier))}
    ${batchDetailRow(t('batchFieldLot'), lots)}
  </tbody></table>${marginBlock}`);
}
// 「編輯」:跳到 歷史紀錄 → 進貨單,開啟這個批次對應進貨單的編輯視窗
async function batchEditPurchase(purchaseId){
  if(!purchaseId) return;
  if(typeof partyTabAllowed === 'function' && !partyTabAllowed('tab-log')) return;
  switchTab('tab-log');
  switchLogSubTab('subtab-log-purchases');
  try{ if(typeof ensurePurchasesLoaded === 'function') await ensurePurchasesLoaded(); }catch(e){}
  if(typeof openEditPurchaseModal === 'function') openEditPurchaseModal(purchaseId);
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
    <div style="margin:12px 0 8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <span style="display:inline-block;padding:5px 12px;background:rgba(0,0,0,0.07);border-radius:3px;font-weight:700;">${batchEsc(h.batchNo)}</span>
      ${h.purchaseId ? `<button class="btn ghost" onclick="batchEditPurchase('${batchEsc(h.purchaseId)}')">${t('btnEdit')}</button>` : ''}
      <span class="batch-info-icon" style="font-size:15px;" title="${batchEsc(t('batchDetailsTitle'))}" onclick="batchOpenBatchDetail('${h.batchId}')">ⓘ</span>
    </div>
    <div style="margin:0 0 10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <span class="batch-link" onclick="bt.batchId='';renderBatchTracker();">← ${t('batchBackToList')}</span>
      <span style="font-size:12px;color:var(--ink-soft);">${batchEsc(h.isOpening ? t('batchOpening') : h.batchDate)}</span>
    </div>
    <table class="stock-table">
      <thead><tr><th>${t('colProduct')}</th><th class="num">${t('batchColRemaining')}</th><th>${t('batchColExpiry')}</th><th class="num">Sell price</th><th></th></tr></thead>
      <tbody>${items.sort((a, b) => batchProductName(a.productId).localeCompare(batchProductName(b.productId))).map(i => `
        <tr>
          <td><span class="batch-link" onclick="batchTrackerOpenProduct('${i.productId}')">${batchEsc(batchProductName(i.productId))}</span></td>
          <td class="num">${batchFmtQty(i.remaining)} ${batchEsc(batchProductUnit(i.productId))}</td>
          <td>${i.expiry ? batchEsc(i.expiry) + batchExpiryBadge(i.expiry, true) : '–'}</td>
          <td class="num">${(typeof spSellCellHtml === 'function') ? spSellCellHtml(i) : batchFmtMoney(batchUnitCost(i))}</td>
          <td><span class="del-link" onclick="batchTrackerOpenHistory('${i.id}')">${t('batchBtnHistory')}</span></td>
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
  const mode = bt.dateMode === 'expiry' ? 'expiry' : 'received';
  const seg = `<div style="margin:0 0 10px;"><div class="batch-seg">
      <button class="${mode === 'received' ? 'active' : ''}" onclick="bt.dateMode='received';renderBatchTracker();">${t('batchDateModeReceived')}</button>
      <button class="${mode === 'expiry' ? 'active' : ''}" onclick="bt.dateMode='expiry';renderBatchTracker();">${t('batchDateModeExpiry')}</button>
    </div></div>`;
  if(mode === 'expiry') return seg + batchRenderExpiryList();
  const batches = {};
  batchData.items.forEach(i => {
    if(bt.from && i.batchDate < bt.from) return;
    if(bt.to && i.batchDate > bt.to) return;
    if(!batches[i.batchId]) batches[i.batchId] = { id: i.batchId, no: i.batchNo, date: i.batchDate, invoice: i.invoiceNo, supplier: i.supplier, isOpening: i.isOpening, n: 0 };
    batches[i.batchId].n++;
  });
  const list = Object.values(batches).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.no.localeCompare(a.no));
  return seg + `
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('batchDateFrom')}</label><input type="date" value="${bt.from}" onchange="bt.from=this.value;renderBatchTracker();" /></div>
      <div class="field"><label>${t('batchDateTo')}</label><input type="date" value="${bt.to}" onchange="bt.to=this.value;renderBatchTracker();" /></div>
    </div>
    ${batchBatchTableHtml(list)}`;
}
// 依有效期看:所有「還有庫存、有填有效期」的批次商品行,有效期最早的排最前面(已過期的在最上面)
function batchRenderExpiryList(){
  const warn = batchWarnDays();
  const live = batchData.items.filter(i => i.remaining > 0);
  const withExp = live.filter(i => i.expiry);
  const noExpCount = live.length - withExp.length;
  let rows = withExp.slice().sort((a, b) => a.expiry.localeCompare(b.expiry) || batchProductName(a.productId).localeCompare(batchProductName(b.productId)));
  if(bt.expOnly) rows = rows.filter(i => batchDaysUntil(i.expiry) <= warn);
  const table = rows.length === 0 ? `<div class="empty-note">${t('batchNoExpiryRows')}</div>` : `<table class="stock-table">
    <thead><tr><th>${t('batchColExpiry')}</th><th>${t('colProduct')}</th><th>${t('batchColBatch')}</th><th class="num">${t('batchColRemaining')}</th><th class="num">${t('batchStockValue')}</th></tr></thead>
    <tbody>${rows.map(i => `<tr>
      <td>${batchEsc(i.expiry)}${batchExpiryBadge(i.expiry, true)}</td>
      <td><span class="batch-link" onclick="batchTrackerOpenProduct('${i.productId}')">${batchEsc(batchProductName(i.productId))}</span></td>
      <td><span class="batch-link" onclick="batchTrackerOpenBatch('${i.batchId}')">${batchEsc(i.batchNo)}</span></td>
      <td class="num">${batchFmtQty(i.remaining)} ${batchEsc(batchProductUnit(i.productId))}</td>
      <td class="num">${(() => { const v = batchItemValue(i); return v === null ? '–' : spMoney(v); })()}</td>
    </tr>`).join('')}</tbody></table>`;
  // 摘要(不受下面「只看快到期與已過期」勾選影響):有填有效期的庫存總價值、快到期、已過期的價值
  const expired = batchValueSum(withExp.filter(i => batchDaysUntil(i.expiry) < 0));
  const soon = batchValueSum(withExp.filter(i => { const d = batchDaysUntil(i.expiry); return d >= 0 && d <= warn; }));
  const all = batchValueSum(withExp);
  const missingTotal = all.missing;
  const chip = (label, v, color) => `<span style="display:inline-block;padding:6px 12px;border:1px solid var(--line);border-radius:3px;background:#fff;"><span style="font-size:11px;color:var(--ink-soft);">${label}</span><br><strong style="font-size:14px;${color ? 'color:' + color + ';' : ''}">${spMoney(v)}</strong></span>`;
  const summary = `<div style="margin:0 0 12px;display:flex;gap:10px;flex-wrap:wrap;align-items:stretch;">
      ${chip(t('batchStockValue'), all.sum)}
      ${chip('🟠 ' + t('batchValueSoon'), soon.sum, '#B8860B')}
      ${chip('🔴 ' + t('batchValueExpired'), expired.sum, 'var(--crit)')}
      <span class="batch-info-icon" style="align-self:center;font-size:15px;" title="${batchEsc(t('batchValueHelpTitle'))}" onclick="showInfoModal(t('batchValueHelp'))">ⓘ</span>
      ${missingTotal ? `<span style="align-self:center;font-size:11px;color:var(--ink-soft);">${tf('batchValueMissing', { n: missingTotal })}</span>` : ''}
    </div>`;
  return `
    ${summary}
    <div style="margin:0 0 10px;">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
        <input type="checkbox" ${bt.expOnly ? 'checked' : ''} onchange="bt.expOnly=this.checked;renderBatchTracker();" /> ${t('batchExpOnlyLabel')}
      </label>
    </div>
    ${table}
    ${noExpCount > 0 ? `<div style="font-size:11.5px;color:var(--ink-soft);margin-top:8px;">${tf('batchNoExpiryNote', { n: noExpCount })}</div>` : ''}`;
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
  if(mode === 'history'){ batchTrackerOpenHistory(itemId); return; } // 歷史紀錄已改成頁面(見 batchRenderHistoryPage)
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
    const { data, error } = await batchSelectMovements('mv_date,qty,kind,party,order_no,note,created_at', q => q.eq('batch_item_id', itemId).order('mv_date', { ascending: true }).order('id', { ascending: true }));
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
// 載入「待處理訂單」時:每個品項可以先指定要從哪些批次出(只存在這張訂單上,決定預計的 Sell price;核對時優先使用)
function batchPendingItemPickable(it){
  return typeof registerOutFlowType !== 'undefined' && registerOutFlowType === 'load-pending' && batchIsTracked(it.productId) && it.qty > 0;
}
function batchOpenPickerForPendingItem(productId){
  const order = orders.find(o => o.id === registerLoadedOrderId);
  const item = order ? order.items.find(x => x.productId === productId && !x.deleted) : null;
  if(!order || !item) return;
  batchOpenPicker({
    productId, qty: item.qty, unit: item.unit, picks: item.batchPicks || [],
    onSave: async picks => {
      if(picks.length) item.batchPicks = picks; else delete item.batchPicks;
      try{ await upsertOrders([order]); } catch(e){ console.error('儲存批次指定失敗', e); showInfoModal(t('spMarginSaveFailed')); }
      if(typeof spRefreshOrderViews === 'function') spRefreshOrderViews(); else renderTxExistingItems();
    }
  });
}
function batchExistingItemButtonHtml(it, pending){
  if(batchPendingItemPickable(it)){
    const has = (it.batchPicks || []).length > 0;
    return `<span class="del-link" title="${batchEsc(t('btnBatchPick'))}" onclick="batchOpenPickerForPendingItem('${it.productId}')">${batchTagIcon()}${has ? ' ✓' : ''}</span>`;
  }
  if(!batchExistingItemTracked(it)) return '';
  return `<span class="del-link" title="${batchEsc(t('btnBatchPick'))}" onclick="batchOpenOrderBreakdownView('${it.productId}')">${batchTagIcon()}</span>`;
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
      if(btn) btn.innerHTML = batchTagIcon() + (picks.length ? ' ✓' : '');
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

// 載入已完成訂單、減少數量:這個品項如果用了兩個以上的批次,儲存時問要從哪個批次退回(扣掉)。
// 只有一個批次就不用問。回傳 picks([{ batchItemId, qty }]);使用者取消回傳 null;不需要問回傳 []。
async function batchAskReturnPicks(order, productId, qty, unit, name){
  if(!batchActive() || !batchIsTracked(productId)) return [];
  let rows = [];
  try{
    batchOrderCache = {};
    await ensureBatchDataLoaded();
    const map = await batchGetOrderBreakdown(order.id);
    rows = Object.keys(map[productId] || {}).map(id => ({ item: batchData.items.find(x => x.id === id), qty: map[productId][id] }))
      .filter(r => r.item && r.qty > 0).sort((a, b) => b.qty - a.qty || batchFefoCompare(a.item, b.item));
  } catch(e){ console.error(e); return []; }
  if(rows.length < 2) return [];
  // 預設:數量最多的批次先退(跟資料庫自動規則一致)
  let left = qty;
  const pre = {};
  rows.forEach(r => { const take = Math.min(r.qty, left); pre[r.item.id] = take; left -= take; });
  return new Promise(resolve => {
    batchClosePicker();
    const ov = document.createElement('div');
    ov.id = 'batchPickerOverlay';
    ov.className = 'modal-overlay';
    ov.style.display = 'flex';
    ov.style.zIndex = '1150';
    const u = batchEsc(unit || '');
    ov.innerHTML = `<div class="modal-box modal-box-wide">
      <div class="section-title" style="margin-top:0;">${t('batchReturnTitle')}</div>
      <p style="margin-bottom:10px;">${batchEsc(name)} · ${tf('batchReturnHint', { qty: batchFmtQty(qty), unit: u })}</p>
      <table class="stock-table">
        <thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('batchReturnColShipped')}</th><th class="num">${t('batchReturnColReturn')}</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${batchEsc(r.item.batchNo)}</td><td>${r.item.expiry ? batchEsc(r.item.expiry) : '–'}</td><td class="num">${batchFmtQty(r.qty)}</td>
          <td class="num"><input type="number" class="batch-return-input" data-id="${r.item.id}" data-max="${r.qty}" min="0" max="${r.qty}" step="1" value="${pre[r.item.id] || ''}" oninput="batchReturnUpdateSum(${qty})" style="width:80px;" /></td></tr>`).join('')}</tbody>
      </table>
      <div id="batchReturnSum" style="font-size:12px;margin:8px 0;color:var(--ink-soft);"></div>
      <div id="batchReturnMsg" class="msg"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="batchReturnCancel">${t('btnCancel')}</button>
        <button class="btn" id="batchReturnOk">${t('btnConfirmYes')}</button>
      </div></div>`;
    document.body.appendChild(ov);
    batchReturnUpdateSum(qty);
    document.getElementById('batchReturnCancel').onclick = () => { ov.remove(); resolve(null); };
    document.getElementById('batchReturnOk').onclick = () => {
      const picks = [];
      ov.querySelectorAll('.batch-return-input').forEach(inp => {
        const v = parseFloat(inp.value);
        if(v > 0) picks.push({ batchItemId: inp.dataset.id, qty: v, max: parseFloat(inp.dataset.max) });
      });
      const sum = picks.reduce((s, p) => s + p.qty, 0);
      const msg = document.getElementById('batchReturnMsg');
      if(picks.some(p => p.qty > p.max + 1e-9)){ msg.className = 'msg error'; msg.textContent = t('batchReturnOverShipped'); return; }
      if(Math.abs(sum - qty) > 1e-9){ msg.className = 'msg error'; msg.textContent = tf('batchReturnSumMismatch', { qty: batchFmtQty(qty) }); return; }
      ov.remove();
      resolve(picks.map(p => ({ batchItemId: p.batchItemId, qty: p.qty })));
    };
  });
}
function batchReturnUpdateSum(qty){
  const el = document.getElementById('batchReturnSum');
  if(!el) return;
  let sum = 0;
  document.querySelectorAll('#batchPickerOverlay .batch-return-input').forEach(inp => { const v = parseFloat(inp.value); if(v > 0) sum += v; });
  el.textContent = tf('batchPickerSum', { sum: batchFmtQty(sum), qty: batchFmtQty(qty) });
}

// ------------------------------------------------------------
// 批次追蹤 → 歷史紀錄(頁面)
// 歷史紀錄是批次追蹤區域裡的一個「頁面」,不是視窗:按「上一頁」(或手機的返回手勢)回到原本的清單。
// 點每一筆紀錄會跳出視窗,顯示對應的進貨單或訂單內容(這是唯一的視窗,所以不會有兩個視窗疊在一起)。
// ------------------------------------------------------------
let batchHist = { itemId: '', moves: [], loading: false };

function batchTrackerOpenHistory(itemId){
  bt.back = { view: bt.view, category: bt.category, search: bt.search, productId: bt.productId, includeDepleted: bt.includeDepleted, batchId: bt.batchId, from: bt.from, to: bt.to };
  bt.view = 'history';
  bt.histItemId = itemId;
  batchHist = { itemId, moves: [], loading: true };
  batchCloseInfoPopup();
  renderBatchTracker();
  try{ const root = document.getElementById('batchTrackerRoot'); if(root && root.scrollIntoView) root.scrollIntoView({ block: 'start' }); }catch(e){}
  batchLoadHistoryMoves(itemId);
}
async function batchLoadHistoryMoves(itemId){
  let moves = [];
  try{
    const { data, error } = await batchSelectMovements('id,mv_date,qty,kind,party,order_no,note,created_at,order_id,tx_id,location_code',
      q => q.eq('batch_item_id', itemId).order('mv_date', { ascending: true }).order('id', { ascending: true }));
    if(error) throw error;
    moves = data || [];
  } catch(e){ console.error('讀取批次歷史紀錄失敗', e); }
  if(batchHist.itemId !== itemId) return;
  batchHist.moves = moves; batchHist.loading = false;
  if(bt.view === 'history' && bt.histItemId === itemId) renderBatchTracker();
}
// 回到上一頁(原本的清單,含原本的篩選/選到的商品)。fromSystem = 手機返回手勢/瀏覽器返回鍵觸發。
function batchTrackerBack(fromSystem){
  if(fromSystem){
    // 有視窗開著就先關視窗;批次追蹤區域看不到時,不處理
    if(document.getElementById('batchInfoOverlay')){ batchCloseInfoPopup(); return true; }
    const root = document.getElementById('batchTrackerRoot');
    if(!root || root.offsetParent === null) return false;
  }
  if(bt.view !== 'history') return false;
  batchCloseInfoPopup();
  if(bt.back) Object.assign(bt, bt.back); else bt.view = 'product';
  bt.back = null; bt.histItemId = '';
  renderBatchTracker();
  return true;
}
function batchRenderHistoryPage(){
  const back = `<div style="margin:6px 0 10px;"><button class="btn ghost" onclick="batchTrackerBack()">← ${t('batchBackPrev')}</button></div>`;
  const i = batchData.items.find(x => x.id === bt.histItemId);
  if(!i) return back + `<div class="empty-note">${t('batchNoBatches')}</div>`;
  const unit = batchEsc(batchProductUnit(i.productId));
  const head = `<div class="section-title" style="margin-top:0;">${batchEsc(batchProductName(i.productId))} · ${batchEsc(i.batchNo)}${i.expiry ? ' · ' + t('batchExpiryShort') + ' ' + batchEsc(i.expiry) : ''}</div>
    <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">${t('batchHistClickHint')}</div>`;
  if(batchHist.loading) return back + head + `<div class="empty-note">${t('batchLoading')}</div>`;
  const rowStyle = 'cursor:pointer;';
  const rows = [`<tr style="${rowStyle}" onclick="batchHistOpenRow(-1)"><td>${batchEsc(i.isOpening ? t('batchOpening') : i.batchDate)}</td><td>${t('batchKindIn')}</td><td class="num" style="padding-right:72px;">+${batchFmtQty(i.qtyIn)} ${unit}</td><td>–</td><td>${batchEsc(i.supplier) || '–'}</td><td>${batchEsc(i.invoiceNo) || '–'}</td><td class="num">${batchFmtMoney(batchUnitCost(i))}</td></tr>`]
    .concat(batchHist.moves.map((m, idx) => `<tr style="${rowStyle}" onclick="batchHistOpenRow(${idx})"><td>${batchEsc(m.mv_date)}</td><td>${t(BATCH_KIND_LABEL_KEY[m.kind] || 'batchKindAdjust')}</td><td class="num" style="padding-right:72px;">${Number(m.qty) > 0 ? '+' : ''}${batchFmtQty(Number(m.qty))} ${unit}</td><td>${m.location_code ? '📍 ' + batchEsc(m.location_code) : '–'}</td><td>${batchEsc(m.party) || '–'}</td><td>${batchEsc(m.order_no) || '–'}</td><td class="num">${batchCostWithFlag(m.unit_cost, i)}</td></tr>`));
  return back + head + `<div class="batch-hist-wrap"><table class="stock-table batch-hist-table">
    <thead>
      <tr><th style="border-bottom:none;"></th><th style="border-bottom:none;"></th><th class="num" style="border-bottom:none;white-space:nowrap;padding-bottom:6px;padding-right:72px;"><span style="display:inline-block;padding:4px 10px;background:rgba(0,0,0,0.07);border-radius:3px;font-size:14px;font-weight:700;color:var(--ink);text-transform:none;letter-spacing:0;">${tf('batchHistRemaining', { qty: batchFmtQty(i.remaining) + ' ' + unit })}</span></th><th colspan="4" style="border-bottom:none;"></th></tr>
      <tr><th>${t('colDate')}</th><th>${t('colType')}</th><th class="num" style="padding-right:72px;">${t('colQty')}</th><th>${t('batchLocTitle')}</th><th>${t('batchColParty')}</th><th>${t('batchColOrderNo')}</th><th class="num">${t('batchColUnitCost')}</th></tr>
    </thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

// 單一視窗:顯示進貨單 / 訂單 / 異動內容
function batchOpenDocModal(title, bodyHtml){
  batchCloseInfoPopup();
  const ov = document.createElement('div');
  ov.id = 'batchInfoOverlay';
  ov.className = 'modal-overlay';
  ov.style.display = 'flex';
  ov.style.zIndex = '1150';
  ov.onclick = (e) => { if(e.target === ov) batchCloseInfoPopup(); };
  ov.innerHTML = `<div class="modal-box modal-box-wide"><div class="section-title" style="margin-top:0;">${title}</div><div id="batchDocBody">${bodyHtml}</div>
    <div class="modal-actions"><button class="btn ghost" onclick="batchCloseInfoPopup()">${t('btnClose') !== 'btnClose' ? t('btnClose') : 'Close'}</button></div></div>`;
  document.body.appendChild(ov);
}
function batchSetDocBody(html){ const el = document.getElementById('batchDocBody'); if(el) el.innerHTML = html; }

async function batchHistOpenRow(idx){
  const i = batchData.items.find(x => x.id === bt.histItemId);
  if(!i) return;
  if(idx < 0){
    if(i.isOpening || !i.purchaseId){ batchOpenDocModal(t('batchDocMove'), `<div class="empty-note">${t('batchDocOpeningNote')}</div>`); return; }
    return batchShowPurchaseModal(i.purchaseId, i);
  }
  const m = batchHist.moves[idx];
  if(!m) return;
  if(m.order_id) return batchShowOrderModal(m.order_id, m, i);
  if(m.tx_id && typeof transactions !== 'undefined'){
    const tx = transactions.find(x => x.id === m.tx_id);
    if(tx && tx.purchaseId) return batchShowPurchaseModal(tx.purchaseId, i);
  }
  batchShowMoveModal(m, i);
}
function batchShowMoveModal(m, i){
  const unit = batchEsc(batchProductUnit(i.productId));
  batchOpenDocModal(t('batchDocMove'), `<table class="stock-table"><tbody>
    <tr><td>${t('colDate')}</td><td>${batchEsc(m.mv_date)}</td></tr>
    <tr><td>${t('colType')}</td><td>${t(BATCH_KIND_LABEL_KEY[m.kind] || 'batchKindAdjust')}</td></tr>
    <tr><td>${t('colQty')}</td><td>${Number(m.qty) > 0 ? '+' : ''}${batchFmtQty(Number(m.qty))} ${unit}</td></tr>
    <tr><td>${t('batchColParty')}</td><td>${batchEsc(m.party) || '–'}</td></tr>
    <tr><td>${t('batchColOrderNo')}</td><td>${batchEsc(m.order_no) || '–'}</td></tr>
    <tr><td>${t('colNote')}</td><td>${batchEsc(m.note) || '–'}</td></tr>
  </tbody></table>`);
}
async function batchShowPurchaseModal(purchaseId, item){
  batchOpenDocModal(t('batchDocPurchase'), t('batchLoading'));
  try{ await ensurePurchasesLoaded(); }catch(e){}
  const p = purchases.find(x => x.id === purchaseId);
  if(!p){ batchSetDocBody(`<div class="empty-note">${t('batchDocNotFound')}</div>`); return; }
  const canPrice = typeof canEditPrice === 'function' && canEditPrice();
  const items = (p.items || []).filter(it => it.docType !== 'others');
  const showAmt = canPrice && items.some(it => it.amount);
  const hasExp = canPrice && p.costs && (p.costs.expensesAud > 0);
  const nos = [...new Set(batchData.items.filter(x => x.purchaseId === p.id).map(x => x.batchNo))];
  const fm = n => (n === null || n === undefined) ? '–' : Number(n).toFixed(2);
  const rows = items.map(it => {
    const pr = (typeof pcItemPrices === 'function') ? pcItemPrices(it) : { base: it.amount, total: it.amount };
    const isCn = it.docType === 'credit_note';
    const hi = item && it.productId === item.productId ? 'background:var(--warn-bg);' : '';
    return `<tr style="${hi}"><td>${batchEsc(it.name || batchProductName(it.productId))}${isCn ? ` <span style="color:var(--crit);font-size:11px;">(${t('docTypeCreditNoteBadge')})</span>` : ''}</td>
      <td class="num">${isCn ? -it.qty : it.qty} ${batchEsc(it.unit || '')}</td>
      <td>${it.expiry ? batchEsc(it.expiry) : '–'}</td>
      ${showAmt ? `<td class="num">${fm(pr.base)}</td>${hasExp ? `<td class="num"><strong>${fm(pr.total)}</strong></td>` : ''}` : ''}</tr>`;
  }).join('');
  let totals = '';
  if(showAmt && typeof pcPurchaseTotals === 'function'){
    const tt = pcPurchaseTotals(p);
    const cur = (p.costs && p.costs.baseCurrency) || 'AUD';
    totals = `<div style="font-size:12.5px;margin-top:6px;">${t('lblInvoiceSubtotal')}: <strong>${fm(tt.base)}</strong>${tt.expenses > 0 ? ` + ${t('lblOtherExpensesTotal')}: <strong>${fm(tt.expenses)}</strong> = ${t('lblPurchaseGrandTotal')}: <strong>${fm(tt.total)}</strong>` : ''} ${cur}</div>
      ${tt.expenses > 0 ? `<div style="font-size:12px;color:var(--ink-soft);margin-top:2px;">${(p.costs.expenses || []).map(e => `${batchEsc(e.name)} ${fm(e.amount)} ${batchEsc(e.currency)}${e.estimated ? ' ⚠' : ''}`).join(' · ')}</div>` : ''}`;
  }
  batchSetDocBody(`
    <div style="font-size:12.5px;margin-bottom:8px;">${batchEsc(p.date || '')} · ${batchEsc(p.partyName || p.partyId || '') || '–'} · Invoice ${batchEsc(p.invoiceNo) || '–'}${nos.length ? ' · ' + nos.map(n => `<span class="batch-tag">${batchEsc(n)}</span>`).join(' ') : ''}</div>
    <table class="stock-table"><thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th><th>${t('batchColExpiry')}</th>${showAmt ? `<th class="num">${hasExp ? t('colBasePrice') : t('colAmount')}</th>${hasExp ? `<th class="num">${t('colTotalPrice')}</th>` : ''}` : ''}</tr></thead><tbody>${rows}</tbody></table>
    ${totals}
    ${p.note ? `<div style="font-size:12px;color:var(--ink-soft);margin-top:6px;">${t('colNote')}: ${batchEsc(p.note)}</div>` : ''}`);
}
async function batchShowOrderModal(orderId, m, item){
  batchOpenDocModal(t('batchDocOrder'), t('batchLoading'));
  let o = (typeof orders !== 'undefined') ? orders.find(x => x.id === orderId) : null;
  if(!o){
    // 訂單只載入近期範圍;更早的訂單直接從資料庫抓這一筆
    try{
      const { data, error } = await sb.from('orders').select('id,payload').eq('id', orderId).maybeSingle();
      if(error) throw error;
      o = data ? data.payload : null;
    } catch(e){ console.error('讀取訂單失敗', e); }
  }
  if(!o){ batchSetDocBody(`<div class="empty-note">${t('batchDocNotFound')}</div>`); return; }
  const rows = (o.items || []).filter(it => !it.deleted).map(it => {
    const hi = item && it.productId === item.productId ? 'background:var(--warn-bg);' : '';
    return `<tr style="${hi}"><td>${batchEsc(it.name || batchProductName(it.productId))}</td><td class="num">${batchFmtQty(it.qty)} ${batchEsc(it.unit || batchProductUnit(it.productId))}</td></tr>`;
  }).join('');
  batchSetDocBody(`
    <div style="font-size:12.5px;margin-bottom:8px;"><strong>${batchEsc(o.orderNo || m.order_no || '')}</strong> · ${batchEsc(o.date || '')}${o.partyName ? ' · ' + batchEsc(o.partyName) : ''}${o.deleted ? ` · <span style="color:var(--crit);">${t('batchDocOrderCancelled')}</span>` : ''}</div>
    <table class="stock-table"><thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th></tr></thead><tbody>${rows}</tbody></table>
    ${o.note ? `<div style="font-size:12px;color:var(--ink-soft);margin-top:6px;">${t('colNote')}: ${batchEsc(o.note)}</div>` : ''}`);
}

// ------------------------------------------------------------
// 第三期:備份 / 還原 / 清除全部資料
// 批次三張表只開放讀取,寫入走 RPC(sql/batch_tracking_phase3_backup.sql)。
// ------------------------------------------------------------
function batchIsMissingTableError(e){
  return !!(e && (e.code === 'PGRST205' || e.code === '42P01' || /does not exist|schema cache/i.test(e.message || '')));
}
function batchIsMissingFunctionError(e){
  return !!(e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|does not exist/i.test(e.message || '')));
}

// 備份用:回傳 { version, batches, items, movements };功能關閉或資料表不存在時回傳 null(備份檔就不含這一段)。
async function batchExportForBackup(){
  if(!batchFeatureOn()) return null;
  try{
    const [batches, items, movements] = await Promise.all([
      fetchAllPages(() => sb.from('batches').select('*').order('id', { ascending: true })),
      fetchAllPages(() => sb.from('batch_items').select('*').order('id', { ascending: true })),
      fetchAllPages(() => sb.from('batch_movements').select('*').order('id', { ascending: true }))
    ]);
    // 位置表(sql/batch_location_phase_a.sql);還沒建立就當作沒有
    let locations = [];
    try{ locations = await fetchAllPages(() => sb.from('batch_item_locations').select('*').order('id', { ascending: true })); }
    catch(e){ if(!batchIsMissingTableError(e)) throw e; }
    // 庫存分布紀錄(轉移位置的紀錄);資料表還沒建立就當作沒有
    let locationTransferLog = [];
    try{ locationTransferLog = await fetchAllPages(() => sb.from('location_transfer_log').select('*').order('created_at', { ascending: true })); }
    catch(e){ if(!batchIsMissingTableError(e)) throw e; }
    return { version: 1, batches, items, movements, locations, locationTransferLog };
  } catch(e){
    if(batchIsMissingTableError(e)) return null;
    // 其他錯誤(網路…)不能默默產生一份不含批次資料的備份,讓呼叫端知道
    throw e;
  }
}

// 還原用:必須在 replaceAllTransactions 之後呼叫。
// 回傳 { ok, restored, cleared, skipped }:
//   restored = 備份檔含批次資料並已寫回;cleared = 備份檔沒有批次資料(舊備份),批次表已清空以免和還原後的庫存對不上;
//   skipped = 功能關閉/資料表不存在;ok=false = 失敗(通常是 SQL 還沒執行)。
async function batchRestoreFromBackup(backup){
  if(!batchFeatureOn() || !batchAvailable) return { ok: true, skipped: true };
  try{
    const bt3 = backup && backup.batchTracking;
    if(bt3 && Array.isArray(bt3.batches) && Array.isArray(bt3.items) && Array.isArray(bt3.movements)){
      const restoreArgs = { p_batches: bt3.batches, p_items: bt3.items, p_movements: bt3.movements };
      if(Array.isArray(bt3.locations)) restoreArgs.p_locations = bt3.locations;   // 舊備份沒有這一段
      await batchRpc('batch_restore_all', restoreArgs);
      try{ await batchRpc('location_log_restore', { p_rows: Array.isArray(bt3.locationTransferLog) ? bt3.locationTransferLog : [] }); }
      catch(e){ if(!batchIsMissingFunctionError(e) && !batchIsMissingTableError(e)) console.error('還原庫存分布紀錄失敗', e); }
      return { ok: true, restored: true };
    }
    await batchRpc('batch_clear_all', {});
    try{ await batchRpc('location_log_restore', { p_rows: [] }); }catch(e){}
    return { ok: true, cleared: true };
  } catch(e){
    console.error('還原批次資料失敗', e);
    if(batchIsMissingTableError(e)) return { ok: true, skipped: true };
    return { ok: false, error: (e && e.message) || String(e), missingFn: batchIsMissingFunctionError(e) };
  } finally {
    batchMarkStale();
    try{ await ensureBatchDataLoaded(true); }catch(e){}
  }
}

// 清除全部資料用。失敗會丟出例外(讓 clearAllData 跟其他清除步驟一樣整個報錯)。
async function batchClearAll(){
  if(!batchFeatureOn() || !batchAvailable) return;
  try{
    await batchRpc('batch_clear_all', {});
    try{ await batchRpc('location_log_restore', { p_rows: [] }); }catch(e){}
  } catch(e){
    if(batchIsMissingTableError(e)) return;
    throw e;
  } finally {
    batchData.items = []; batchMarkStale();
  }
}


// ------------------------------------------------------------
// 第三期:已完成訂單詳情顯示用了哪些批次(+ 出貨價和目前批次單價不同的 ⓘ)
// ------------------------------------------------------------
// 訂單商品列下方的佔位元素;batchFillOrderDetailLines 會依訂單 id / 商品 id 非同步填入標籤。
function batchOrderDetailLineHtml(o, it){
  if(!batchFeatureOn() || !batchAvailable || !o || o.deleted || it.deleted || !(it.qty > 0)) return '';
  return `<div class="batch-alloc-line batch-order-detail-line" data-oid="${batchEsc(o.id)}" data-pid="${batchEsc(it.productId)}"></div>`;
}
// 某張訂單每個商品實際用的批次:{ productId: [{ item, qty(淨出貨量), shipCost(出貨當時批次單價,加權平均) }] }
function batchGetOrderDetail(orderId){
  if(batchOrderDetailCache[orderId]) return batchOrderDetailCache[orderId];
  const p = (async () => {
    const { data, error } = await batchSelectMovements('batch_item_id,qty,kind', q => q.eq('order_id', orderId).in('kind', ['out', 'return']));
    if(error) throw error;
    const acc = {};   // itemId -> { qty, costSum, costQty, anyCost }
    (data || []).forEach(m => {
      const a = acc[m.batch_item_id] = acc[m.batch_item_id] || { qty: 0, costSum: 0, costQty: 0, anyCost: false };
      const q = -Number(m.qty);               // 出貨(負)→ 正的使用量;退回(正)→ 扣回
      a.qty += q;
      const c = batchNum(m.unit_cost);
      if(c !== null){ a.anyCost = true; a.costSum += c * q; a.costQty += q; }
    });
    const out = {};
    Object.keys(acc).forEach(id => {
      const i = batchData.items.find(x => x.id === id);
      const a = acc[id];
      if(!i || !(a.qty > 1e-9)) return;
      const shipCost = (a.anyCost && Math.abs(a.costQty) > 1e-9) ? a.costSum / a.costQty : null;
      (out[i.productId] = out[i.productId] || []).push({ item: i, qty: a.qty, shipCost });
    });
    return out;
  })();
  batchOrderDetailCache[orderId] = p;
  p.catch(() => { delete batchOrderDetailCache[orderId]; });
  return p;
}
async function batchFillOrderDetailLines(root){
  try{
    if(!root || !batchFeatureOn()) return;
    const els = Array.from(root.querySelectorAll('.batch-order-detail-line'));
    if(els.length === 0) return;
    await ensureBatchDataLoaded();
    if(!batchActive()) return;
    const orderIds = [...new Set(els.map(el => el.dataset.oid))];
    const results = {};
    await Promise.all(orderIds.map(async id => { try{ results[id] = await batchGetOrderDetail(id); }catch(e){ console.warn('訂單批次明細載入失敗', id, e); } }));
    els.forEach(el => {
      const map = results[el.dataset.oid];
      const rows = map && map[el.dataset.pid];
      if(!rows || rows.length === 0){ el.innerHTML = ''; return; }
      el.innerHTML = rows.slice().sort((a, b) => batchFefoCompare(a.item, b.item)).map(r => {
        const i = r.item, cur = batchUnitCost(i);
        const flag = (batchShipCostSupported && batchCostDiffers(r.shipCost, cur))
          ? ` <span class="batch-cost-flag" title="${batchEsc(t('batchCostFlagTitle'))}" style="cursor:pointer;color:var(--warn-dark,#b45309);font-weight:700;" onclick="batchShowShipCost(event, ${r.shipCost === null ? 'null' : r.shipCost}, ${cur === null || cur === undefined ? 'null' : cur})">ⓘ</span>`
          : '';
        const exp = i.expiry ? ' · ' + t('batchExpiryShort') + ' ' + batchEsc(i.expiry) : '';
        return `<span class="batch-tag">${batchEsc(i.batchNo)}${i.isOpening ? ' (' + t('batchOpening') + ')' : ''} ×${batchFmtQty(r.qty)}${exp}${flag}</span>`;
      }).join('');
    });
  } catch(e){ console.warn('訂單批次標籤載入失敗', e); }
}


// ============================================================
// 庫存位置分批次 第一階段(a):進貨時記錄每個批次商品行放在哪些位置
// 資料表/RPC 見 sql/batch_location_phase_a.sql。
// 進貨清單每一行 it.locs = [{ code, qty }];沒指定位置的數量 = 行數量 − 加總 = 「未分配位置」。
// 第一階段只記錄與顯示;出貨分配仍照 FEFO/FIFO,不依位置扣(之後階段再做)。
// ============================================================
let batchLastLocMap = null;   // productId -> 上次進貨放的位置代碼(app_data 'batchLastPurchaseLocation')
async function batchLoadLastLocMap(){
  if(batchLastLocMap) return batchLastLocMap;
  try{ batchLastLocMap = (await dbGet('batchLastPurchaseLocation')) || {}; }catch(e){ batchLastLocMap = {}; }
  return batchLastLocMap;
}
function batchLocDefaultCode(productId){
  const m = batchLastLocMap || {};
  if(m[productId]) return m[productId];
  const primary = typeof getPrimaryLocation === 'function' ? getPrimaryLocation(productId) : null;
  if(primary) return primary.locationCode;
  const p = products.find(x => x.id === productId);
  return (p && p.lastPrimaryLocation && p.lastPrimaryLocation.locationCode) || '';
}
function batchLocRowsShown(){ return batchRowsShowExpiry() && typeof productLocations !== 'undefined'; }
function batchLocAssigned(it){ return (it.locs || []).reduce((s, l) => s + (Number(l.qty) || 0), 0); }

// 新增到清單時帶入預設位置(整行數量放預設位置);之後可在「位置」視窗改
function batchLocInitForNewItem(it){
  if(it.locs !== undefined) return;
  if(!batchLocRowsShown() || it.docType === 'credit_note' || it.qty <= 0) return;
  const code = batchLocDefaultCode(it.productId);
  it.locs = code ? [{ code, qty: it.qty, auto: true }] : [];
}
// 渲染清單前呼叫:第一次載入記憶的位置,再替還沒有位置設定的行帶入預設(收據掃描載入的行也一樣)
function batchLocPrepareList(){
  if(!batchLocRowsShown()) return;
  if(!batchLastLocMap){ batchLoadLastLocMap().then(() => { if(typeof renderTxBatchList === 'function') renderTxBatchList(); }); return; }
  txBatchItems.forEach(batchLocInitForNewItem);
}
// 改數量:只有一個位置、而且是自動帶入的,數量跟著行數量走;其他情況超過行數量就依序縮減
function batchLocOnQtyChange(it){
  if(!it.locs || !it.locs.length) return;
  if(it.locs.length === 1 && it.locs[0].auto){ it.locs[0].qty = Math.max(0, it.qty); return; }
  let over = batchLocAssigned(it) - it.qty;
  for(let k = it.locs.length - 1; k >= 0 && over > 1e-9; k--){
    const cut = Math.min(over, it.locs[k].qty); it.locs[k].qty -= cut; over -= cut;
  }
  it.locs = it.locs.filter(l => l.qty > 1e-9);
}
function batchLocCellHtml(it){
  if(it.docType === 'credit_note' || it.qty <= 0) return '<td></td>';
  const locs = it.locs || [];
  const un = it.qty - batchLocAssigned(it);
  const summary = locs.length
    ? locs.map(l => `${batchEsc(l.code)}×${batchFmtQty(l.qty)}`).join('<br>') + (un > 1e-9 ? `<br><span style="color:var(--ink-soft);">${t('unassignedLocationLabel')}×${batchFmtQty(un)}</span>` : '')
    : `<span style="color:var(--ink-soft);">${t('unassignedLocationLabel')}</span>`;
  return `<td class="row-num tx-loc" data-label="${t('batchLocTitle')}" style="text-align:left;font-size:12px;min-width:220px;white-space:normal;line-height:1.4;"><span class="batch-link" onclick="batchLocOpenEditor('${it.batchItemId}')">📍 ${summary}</span></td>`;
}

// ---- 位置編輯視窗 ----
let batchLocEd = null;   // { itemId, rows: [{code, qty}] }
function batchLocCodesFor(productId){
  const codes = [];
  (productLocations || []).filter(l => l.productId === productId).forEach(l => { if(!codes.includes(l.locationCode)) codes.push(l.locationCode); });
  const d = batchLocDefaultCode(productId);
  if(d && !codes.includes(d)) codes.push(d);
  return codes;
}
function batchLocOpenEditor(itemId){
  const it = txBatchItems.find(x => x.batchItemId === itemId);
  if(!it) return;
  batchLocEd = { itemId, rows: (it.locs && it.locs.length ? it.locs : [{ code: '', qty: it.qty }]).map(l => ({ code: l.code, qty: l.qty })) };
  batchLocRenderEditor();
}
function batchLocRenderEditor(){
  const it = txBatchItems.find(x => x.batchItemId === batchLocEd.itemId);
  if(!it){ batchLocCloseEditor(); return; }
  const old = document.getElementById('batchLocOverlay'); if(old) old.remove();
  const listId = 'batchLocCodes';
  const assigned = batchLocEd.rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const un = it.qty - assigned;
  const ov = document.createElement('div');
  ov.id = 'batchLocOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1100';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(520px,94vw);">
    <div class="section-title" style="margin-top:0;">${t('batchLocEditTitle')} · ${batchEsc(it.name)} (${batchFmtQty(it.qty)} ${batchEsc(it.unit)})</div>
    <datalist id="${listId}">${batchLocCodesFor(it.productId).map(c => `<option value="${batchEsc(c)}"></option>`).join('')}</datalist>
    <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">${t('batchLocEditHint')}</div>
    ${batchLocEd.rows.map((r, k) => `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
      <input type="text" list="${listId}" value="${batchEsc(r.code)}" placeholder="${batchEsc(t('batchLocCodePh'))}" style="flex:1;min-width:0;" onchange="batchLocEd.rows[${k}].code=this.value.trim()" />
      <input type="number" min="0" step="1" value="${r.qty}" style="width:90px;" onchange="batchLocEd.rows[${k}].qty=Math.max(0,parseFloat(this.value)||0);batchLocRenderEditor()" />
      <button class="btn ghost" onclick="batchLocEd.rows.splice(${k},1);batchLocRenderEditor()" title="${t('btnDelete')}">✕</button>
    </div>`).join('')}
    <div style="margin:8px 0;"><button class="btn ghost" onclick="batchLocEd.rows.push({code:'',qty:Math.max(0,${un})});batchLocRenderEditor()">+ ${t('batchLocAddRow')}</button></div>
    <div style="font-size:12.5px;font-weight:600;${un < -1e-9 ? 'color:var(--crit);' : ''}">${un < -1e-9 ? tf('batchLocOver', { n: batchFmtQty(-un) }) : `${t('unassignedLocationLabel')}: ${batchFmtQty(Math.max(0, un))}`}</div>
    <div class="modal-actions"><button class="btn ghost" onclick="batchLocCloseEditor()">${t('btnCancel')}</button><button class="btn" onclick="batchLocSaveEditor()">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function batchLocCloseEditor(){ const o = document.getElementById('batchLocOverlay'); if(o) o.remove(); batchLocEd = null; }
function batchLocSaveEditor(){
  if(!batchLocEd) return;
  const it = txBatchItems.find(x => x.batchItemId === batchLocEd.itemId);
  if(!it){ batchLocCloseEditor(); return; }
  const rows = batchLocEd.rows.filter(r => r.code && r.qty > 0);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  if(total > it.qty + 1e-9){ batchLocRenderEditor(); return; }
  // 同代碼合併
  const merged = [];
  rows.forEach(r => { const m = merged.find(x => x.code === r.code); if(m) m.qty += r.qty; else merged.push({ code: r.code, qty: r.qty }); });
  it.locs = merged;
  batchLocCloseEditor();
  renderTxBatchList();
}

// ---- 進貨單送出後:寫入位置、同步「庫存分布」(product_locations) ----
function batchLocBuildPayload(items){
  const lines = {};
  items.forEach(it => {
    if(it.docType === 'credit_note' || it.qty <= 0) return;
    const p = products.find(x => x.id === it.productId);
    // 自動切換成主商品的行:批次行是主商品,數量 × 換算比例,批次、有效期、位置都跟著放在同樣的位置(跟庫存總覽切換同一套規則)
    const conv = !!(p && p.parentId && p.autoConvertOnStockIn);
    const pid = conv ? p.parentId : it.productId;
    const mult = conv ? (p.childWeight || 1) : 1;
    const locs = (it.locs || []).filter(l => l.code && l.qty > 0);
    const note = (it.note || '').trim();
    if(!locs.length && !note) return;
    const key = pid + '|' + (it.expiry || '');
    const ln = lines[key] = lines[key] || { product_id: pid, expiry: it.expiry || '', locs: [], note: '' };
    locs.forEach(l => ln.locs.push({ code: l.code, qty: l.qty * mult }));
    if(note) ln.note = ln.note ? ln.note + '\n' + note : note;
  });
  return Object.values(lines);
}
async function batchApplyPurchaseLocations(purchase, items){
  const payload = batchLocBuildPayload(items);
  if(!payload.length) return;
  await batchRpc('batch_set_purchase_locations', { p_purchase_id: purchase.id, p_rows: payload });
  // 同步庫存分布:每個位置把數量加上去(位置不存在就新增;欄位沿用同代碼的既有位置)
  const memo = await batchLoadLastLocMap();
  for(const ln of payload){
    if(!ln.locs.length) continue;
    for(const l of ln.locs){
      try{
        let loc = productLocations.find(x => x.productId === ln.product_id && x.locationCode === l.code);
        if(loc){ loc.qty += l.qty; await upsertProductLocation(loc); }
        else {
          const tpl = productLocations.find(x => x.locationCode === l.code);
          loc = { id: genId(), productId: ln.product_id, zone: tpl ? tpl.zone : '', aisle: tpl ? tpl.aisle : '', bay: tpl ? tpl.bay : '', level: tpl ? tpl.level : '', bin: tpl ? tpl.bin : '', locationCode: l.code, qty: l.qty, photoUrl: null };
          productLocations.push(loc);
          await upsertProductLocation(loc);
        }
      }catch(e){ console.error('進貨後同步庫存分布失敗', e); }
    }
    memo[ln.product_id] = ln.locs[0].code;
  }
  try{ await dbSet('batchLastPurchaseLocation', memo); }catch(e){}
  batchMarkStale();
  try{ await ensureBatchDataLoaded(); }catch(e){}
}

// ---- 顯示:批次商品行的位置 ----
function batchLocSummaryHtml(i){
  // 顯示「目前」各位置的剩餘量(含出貨、轉移),沒有位置資料的部分是未分布
  const buckets = batchBuckets(i).filter(b => b.rem > 1e-9);
  const located = buckets.filter(b => b.code);
  const unBucket = buckets.find(b => !b.code);
  let html = located.map(b => `${batchEsc(b.code)} ×${batchFmtQty(b.rem)}`).join('<br>');
  if(located.length && unBucket) html += `<br><span style="color:var(--ink-soft);">${t('unassignedLocationLabel')} ×${batchFmtQty(unBucket.rem)}</span>`;
  return html + `${html ? '<br>' : ''}<span class="batch-link" style="font-size:12px;" onclick="batchOpenSetLocations('${i.id}')">${t(located.length ? 'batchSetLocEdit' : 'batchSetLocAdd')}</span>`;
}

// ---- 設定批次位置:補登記既有批次(期初批次、進貨時沒記位置的批次)現在放在哪 ----
let batchSetLocEd = null;   // { itemId, rows: [{code, qty}] }
function batchOpenSetLocations(itemId){
  const i = batchData.items.find(x => x.id === itemId);
  if(!i) return;
  const cur = batchBuckets(i).filter(b => b.code && b.rem > 1e-9).map(b => ({ code: b.code, qty: b.rem }));
  batchSetLocEd = { itemId, rows: cur.length ? cur : [{ code: '', qty: i.remaining }] };
  batchRenderSetLocations();
}
function batchRenderSetLocations(){
  const i = batchData.items.find(x => x.id === batchSetLocEd.itemId);
  if(!i){ batchCloseSetLocations(); return; }
  const old = document.getElementById('batchSetLocOverlay'); if(old) old.remove();
  const assigned = batchSetLocEd.rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const un = i.remaining - assigned;
  const codes = [];
  (productLocations || []).filter(l => l.productId === i.productId).forEach(l => { if(!codes.includes(l.locationCode)) codes.push(l.locationCode); });
  const ov = document.createElement('div');
  ov.id = 'batchSetLocOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(520px,94vw);">
    <div class="section-title" style="margin-top:0;">${t('batchSetLocTitle')} · ${batchEsc(batchProductName(i.productId))}-${batchEsc(i.batchNo)}</div>
    <datalist id="batchSetLocCodes">${codes.map(c => `<option value="${batchEsc(c)}"></option>`).join('')}</datalist>
    <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">${tf('batchSetLocHint', { qty: batchFmtQty(i.remaining), unit: batchEsc(batchProductUnit(i.productId)) })}</div>
    ${batchSetLocEd.rows.map((r, k) => `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
      <input type="text" list="batchSetLocCodes" value="${batchEsc(r.code)}" placeholder="${batchEsc(t('batchLocCodePh'))}" style="flex:1;min-width:0;" onchange="batchSetLocEd.rows[${k}].code=this.value.trim()" />
      <input type="number" min="0" step="1" value="${r.qty}" style="width:90px;" onchange="batchSetLocEd.rows[${k}].qty=Math.max(0,parseFloat(this.value)||0);batchRenderSetLocations()" />
      <button class="btn ghost" onclick="batchSetLocEd.rows.splice(${k},1);batchRenderSetLocations()" title="${t('btnDelete')}">✕</button>
    </div>`).join('')}
    <div style="margin:8px 0;"><button class="btn ghost" onclick="batchSetLocEd.rows.push({code:'',qty:Math.max(0,${un})});batchRenderSetLocations()">+ ${t('batchLocAddRow')}</button></div>
    <div style="font-size:12.5px;font-weight:600;${un < -1e-9 ? 'color:var(--crit);' : ''}">${un < -1e-9 ? tf('batchLocOver', { n: batchFmtQty(-un) }) : `${t('unassignedLocationLabel')}: ${batchFmtQty(Math.max(0, un))}`}</div>
    <div id="batchSetLocMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="batchCloseSetLocations()">${t('btnCancel')}</button><button class="btn" onclick="batchSaveSetLocations()">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function batchCloseSetLocations(){ const o = document.getElementById('batchSetLocOverlay'); if(o) o.remove(); batchSetLocEd = null; }
async function batchSaveSetLocations(){
  if(!batchSetLocEd) return;
  const i = batchData.items.find(x => x.id === batchSetLocEd.itemId);
  const msg = document.getElementById('batchSetLocMsg');
  const rows = batchSetLocEd.rows.filter(r => r.code && r.qty > 0);
  const sum = rows.reduce((s, r) => s + r.qty, 0);
  if(!i || sum > i.remaining + 1e-9){ if(msg){ msg.className = 'msg error'; msg.textContent = t('batchPickerOverQty'); } return; }
  // 庫存分布同步:這個批次在各位置的數量變多/變少多少,庫存分布(product_locations)同一個位置就跟著增減;
  // 變多的部分是從「未分布」指派過去,所以庫存分布各位置加總不能超過商品總庫存。
  const oldMap = {};
  batchBuckets(i).forEach(b => { if(b.code) oldMap[b.code] = b.rem; });
  const newMap = {};
  rows.forEach(r => { newMap[r.code] = (newMap[r.code] || 0) + r.qty; });
  const deltas = {};
  Object.keys(Object.assign({}, oldMap, newMap)).forEach(c => { const d = (newMap[c] || 0) - (oldMap[c] || 0); if(Math.abs(d) > 1e-9) deltas[c] = d; });
  const currentSum = productLocations.filter(l => l.productId === i.productId).reduce((a, l) => a + l.qty, 0);
  let projected = currentSum;
  Object.keys(deltas).forEach(c => {
    const loc = productLocations.find(l => l.productId === i.productId && l.locationCode === c);
    const before = loc ? loc.qty : 0;
    projected += Math.max(0, before + deltas[c]) - before;
  });
  if(projected > computeStock(i.productId) + 1e-9){
    if(msg){ msg.className = 'msg error'; msg.textContent = t('batchSetLocExceedsStock'); }
    return;
  }
  if(msg){ msg.className = 'msg'; msg.textContent = t('savingMsg'); }
  try{
    await batchRpc('batch_set_item_locations', { p_item: i.id, p_rows: rows.map(r => ({ code: r.code, qty: r.qty })) });
    for(const c of Object.keys(deltas)){
      try{
        let loc = productLocations.find(l => l.productId === i.productId && l.locationCode === c);
        if(loc){
          loc.qty = Math.max(0, loc.qty + deltas[c]);
          if(loc.qty <= 1e-9){
            await deleteProductLocationRow(loc.id);
            productLocations = productLocations.filter(l => l.id !== loc.id);
          } else await upsertProductLocation(loc);
        } else if(deltas[c] > 0){
          const tpl = productLocations.find(l => l.locationCode === c);
          loc = { id: genId(), productId: i.productId, zone: tpl ? tpl.zone : '', aisle: tpl ? tpl.aisle : '', bay: tpl ? tpl.bay : '', level: tpl ? tpl.level : '', bin: tpl ? tpl.bin : '', locationCode: c, qty: deltas[c], photoUrl: null };
          productLocations.push(loc);
          await upsertProductLocation(loc);
        }
      }catch(e){ console.error('同步庫存分布失敗', e); }
    }
    try{ if(typeof refreshStockLocationView === 'function') refreshStockLocationView(); }catch(e){}
    batchCloseSetLocations();
    batchCloseDetail();
    batchMarkStale();
    try{ await ensureBatchDataLoaded(true); }catch(e){}
    try{ if(typeof renderBatchTracker === 'function') renderBatchTracker(); }catch(e){}
  } catch(e){
    console.error('設定批次位置失敗', e);
    if(msg){ msg.className = 'msg error'; msg.textContent = t('batchSetLocFailed'); }
  }
}

// ---- 進貨清單每行的「填寫詳細資料」:供應商批號、備註(備註顯示在批次追蹤商品頁的詳細資料) ----
function batchTxDetailButtonHtml(it){
  const has = !!((it.supplierLot || '').trim() || (it.note || '').trim());
  return `<button onclick="batchTxOpenDetails('${it.batchItemId}')" title="${batchEsc(t('batchTxDetailsTitle'))}">📝${has ? ' ✓' : ''}</button>`;
}
function batchTxOpenDetails(itemId){
  const it = txBatchItems.find(x => x.batchItemId === itemId);
  if(!it) return;
  const old = document.getElementById('batchTxDetOverlay'); if(old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'batchTxDetOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1100';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(460px,94vw);">
    <div class="section-title" style="margin-top:0;">${t('batchTxDetailsTitle')} · ${batchEsc(it.name)}</div>
    <div class="field"><label>${t('batchFieldLot')}</label><input id="batchTxDetLot" type="text" value="${batchEsc(it.supplierLot || '')}" style="width:100%;" /></div>
    <div class="field" style="margin-top:8px;"><label>${t('batchFieldNote')}</label><textarea id="batchTxDetNote" rows="3" style="width:100%;">${batchEsc(it.note || '')}</textarea></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('batchTxDetOverlay').remove()">${t('btnCancel')}</button><button class="btn" onclick="batchTxSaveDetails('${itemId}')">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function batchTxSaveDetails(itemId){
  const it = txBatchItems.find(x => x.batchItemId === itemId);
  const ov = document.getElementById('batchTxDetOverlay');
  if(it){
    it.supplierLot = document.getElementById('batchTxDetLot').value.trim();
    it.note = document.getElementById('batchTxDetNote').value.trim();
  }
  if(ov) ov.remove();
  renderTxBatchList();
}


// ============================================================
// 庫存位置分批次 第二階段(b):出貨依「批次 × 位置」分配
// 資料表/RPC 見 sql/batch_location_phase_b.sql。
// 規則:自動依 FEFO/FIFO 決定批次(期初批次先);批次行只放在一個位置 → 直接從那裡出;
// 放在多個位置而沒有指定 → 跳視窗問從哪個位置出;批次標籤視窗可以指定位置。
// ============================================================
// 一個批次商品行目前各位置的剩餘量。沒有位置資料 → 一個「未分布」桶(code='')。
function batchBuckets(item){
  const locs = (batchItemLocRem[item.id] || []).filter(l => l.rem > 1e-9);
  const sumLoc = locs.reduce((a, l) => a + l.rem, 0);
  const buckets = locs.map(l => ({ code: l.code, rem: l.rem }));
  const un = item.remaining - sumLoc;
  if(un > 1e-9 || buckets.length === 0) buckets.push({ code: '', rem: Math.max(0, un > 1e-9 ? un : item.remaining) });
  return buckets;
}
// 預設出貨順序:未分布先出,再依位置剩餘量由多到少
function batchBucketsOrdered(item){
  return batchBuckets(item).slice().sort((a, b) => (a.code === '' ? -1 : 0) - (b.code === '' ? -1 : 0) || b.rem - a.rem);
}
function batchBucketLabel(item, b){
  return `${item.batchNo}${item.expiry ? ' · ' + t('batchExpiryShort') + ' ' + item.expiry : ''} · 📍 ${b.code || t('unassignedLocationLabel')}`;
}

// 出貨前(扣庫存之前)解析:這次出貨會從哪些(批次, 位置)出。回傳 null = 這個商品不用批次位置邏輯(走原本流程);
// 否則回傳 { allocations, tracked, rest }:allocations = 原本 product_locations 扣減格式,rest = 沒有批次可扣的數量(走原本流程)。
// 取消(使用者在選位置視窗按取消)時丟出 Error('cancelled'),呼叫端照原本方式中止。
// 已完成訂單增加數量時的預設來源:這張訂單當初出貨用過的「批次 × 位置」(用得多的先),各自最多拿到該位置目前剩餘的量;
// 那個批次/位置的貨沒了,剩下的量就依一般順序(期初 → 先到期 → 先進貨)往下一批拿(同批次同有效期多個位置才會問)。
async function batchOrderPreferredPicks(orderId, productId){
  try{
    const { data, error } = await sb.from('batch_movements').select('batch_item_id,qty,location_code,kind').eq('order_id', orderId).in('kind', ['out', 'return']);
    if(error) throw error;
    const net = {};
    (data || []).forEach(m => {
      const it = batchData.items.find(x => x.id === m.batch_item_id);
      if(!it || it.productId !== productId) return;
      const k = m.batch_item_id + '|' + (m.location_code || '');
      net[k] = (net[k] || 0) - Number(m.qty);
    });
    const out = [];
    Object.keys(net).filter(k => net[k] > 1e-9).sort((a, b) => net[b] - net[a]).forEach(k => {
      const [id, code] = k.split('|');
      const it = batchData.items.find(x => x.id === id);
      const b = it ? batchBuckets(it).find(x => x.code === code) : null;
      if(b && b.rem > 1e-9) out.push({ batchItemId: id, code, qty: b.rem });
    });
    return out;
  }catch(e){ console.warn('讀取訂單原本出貨批次失敗', e); return []; }
}
async function batchResolveLocationAllocations(productId, neededQty, picks, orderId){
  delete batchLocPlans[productId];
  if(orderId && batchActive() && batchIsTracked(productId)){
    // 使用者在批次按鈕指定的先照指定;其餘預設拿這張訂單原本用的批次與位置
    picks = (picks || []).concat(await batchOrderPreferredPicks(orderId, productId));
  }
  if(!batchActive() || !batchIsTracked(productId) || !(neededQty > 0)) return null;
  const hasAnyLoc = batchItemsOfProduct(productId).some(i => (batchItemLocRem[i.id] || []).length > 0);
  if(!hasAnyLoc) return null;
  const product = products.find(x => x.id === productId);
  const prev = batchPreviewAllocation(productId, neededQty, picks);
  const plan = [];
  for(const line of prev.lines){
    const item = line.item;
    const buckets = batchBuckets(item).map(b => ({ ...b }));
    let need = line.qty;
    // 1) 批次標籤視窗指定的位置
    (picks || []).filter(p => p.batchItemId === item.id && p.code !== undefined && p.code !== null && (p.code !== '' || buckets.length > 1)).forEach(p => {
      const b = buckets.find(x => x.code === p.code);
      if(!b || need <= 0) return;
      const take = Math.min(p.qty, b.rem, need);
      if(take > 0){ plan.push({ batchItemId: item.id, code: b.code, qty: take }); b.rem -= take; need -= take; }
    });
    // 2) 其餘:只剩一個有庫存的位置 → 自動;兩個以上 → 問
    while(need > 1e-9){
      const cands = buckets.filter(b => b.rem > 1e-9);
      if(cands.length === 0) break;
      let b;
      if(cands.length === 1) b = cands[0];
      else {
        const choices = cands.map(c => ({ type: 'batchloc', id: c.code, label: batchBucketLabel(item, c), qty: c.rem }));
        const picked = await promptLocationChoice(product, need, choices);
        b = cands.find(c => c.code === picked.id);
      }
      const take = Math.min(b.rem, need);
      plan.push({ batchItemId: item.id, code: b.code, qty: take });
      b.rem -= take; need -= take;
    }
  }
  if(plan.length === 0) return null;
  const tracked = plan.reduce((a, x) => a + x.qty, 0);
  // 轉成 product_locations 扣減(位置代碼對得到這個商品的位置 → 扣那個位置;對不到 → 算未分布)
  const allocations = [];
  plan.forEach(x => {
    const loc = x.code ? productLocations.find(l => l.productId === productId && l.locationCode === x.code) : null;
    const key = loc ? loc.id : 'unassigned';
    let a = allocations.find(y => (y.id || 'unassigned') === key);
    if(!a){ a = loc ? { type: 'location', id: loc.id, label: loc.locationCode, qty: 0 } : { type: 'unassigned', id: null, label: t('unassignedLocationLabel'), qty: 0 }; allocations.push(a); }
    a.qty += x.qty;
  });
  // 有庫存卻沒有批次可扣的部分(未追蹤出貨)走原本的位置選擇
  const rest = Math.max(0, neededQty - tracked);
  if(Math.abs(tracked - neededQty) < 1e-9){ plan.at = Date.now(); batchLocPlans[productId] = plan; }   // 只有整筆都有批次分配時才採用計畫
  return { allocations, tracked, rest };
}

// 批次分配完成後:把這批出貨在每個批次商品行扣的量拆到位置。
// plans: txId -> [{batchItemId, code, qty}];沒有計畫的交易依預設順序(未分布先、再位置由多到少)。
async function batchTagOutLocations(txList, plans){
  const ids = txList.map(tx => tx.id);
  const { data, error } = await batchSelectMovements('id,tx_id,batch_item_id,qty,kind', q => q.in('tx_id', ids).eq('kind', 'out'));
  if(error) throw error;
  const byTx = {};
  (data || []).forEach(m => { ((byTx[m.tx_id] = byTx[m.tx_id] || {})[m.batch_item_id] = (byTx[m.tx_id][m.batch_item_id] || 0) + (-Number(m.qty))); });
  // 位置剩餘量的本機工作副本(同一批出貨有多筆動到同一個批次行時要累計扣減)
  const work = {};
  const bucketsOf = itemId => {
    if(!work[itemId]){
      const it = batchData.items.find(x => x.id === itemId);
      // 這時資料庫已扣掉本次出貨,但本機資料還是扣之前的數字(尚未重新載入),所以用本機數字當「出貨前」
      work[itemId] = it ? batchBucketsOrdered(it).map(b => ({ ...b })) : [];
    }
    return work[itemId];
  };
  for(const tx of txList){
    const moved = byTx[tx.id];
    if(!moved) continue;
    const rows = [];
    for(const itemId of Object.keys(moved)){
      if(!(batchItemLocRem[itemId] || []).length) continue;     // 這個批次行沒有位置資料,不用拆
      let need = moved[itemId];
      const bks = bucketsOf(itemId);
      const planned = ((plans && plans[tx.id]) || []).filter(x => x.batchItemId === itemId);
      planned.forEach(x => {
        const b = bks.find(y => y.code === x.code);
        const take = Math.min(x.qty, need, b ? b.rem : 0);
        if(take > 0){ rows.push({ batch_item_id: itemId, code: x.code, qty: take }); b.rem -= take; need -= take; }
      });
      for(const b of bks){
        if(need <= 1e-9) break;
        const take = Math.min(b.rem, need);
        if(take > 0){ rows.push({ batch_item_id: itemId, code: b.code, qty: take }); b.rem -= take; need -= take; }
      }
      if(need > 1e-9) rows.push({ batch_item_id: itemId, code: '', qty: need });   // 位置剩餘量不夠(資料不一致)→ 放未分布
    }
    if(rows.length) await batchRpc('batch_tag_locations', { p_tx_id: tx.id, p_rows: rows });
  }
}


// ============================================================
// 庫存位置分批次 第四階段(d):庫存分布「轉移位置」時,由使用者選實際搬了哪些批次
// 資料庫 RPC 見 sql/batch_location_phase_d.sql。轉移是倉庫內換位置,不是出貨,所以沒有先進先出,由人選。
// srcCode / dstCode:位置代碼,'' = 未分布。
// ============================================================
// 回傳 null = 這個商品在來源位置沒有任何批次庫存(不需要動批次);否則回傳 [{ batch_item_id, from_code, to_code, qty }]
// (只有一個候選批次時自動帶入,不問);使用者按取消 → 丟出 Error('cancelled')。
async function batchTransferPick(productId, qty, srcCode, dstCode){
  if(!batchActive()) return null;
  try{ await ensureBatchDataLoaded(); }catch(e){}
  if(!batchIsTracked(productId)) return null;
  const cands = [];
  batchItemsOfProduct(productId).forEach(i => {
    const b = batchBuckets(i).find(x => x.code === srcCode);
    if(b && b.rem > 1e-9) cands.push({ item: i, rem: b.rem });
  });
  if(cands.length === 0) return null;
  if(cands.length === 1){
    const q = Math.min(qty, cands[0].rem);
    return [{ batch_item_id: cands[0].item.id, from_code: srcCode, to_code: dstCode, qty: q }];
  }
  const picks = await batchTransferPicker(productId, qty, srcCode, dstCode, cands);
  return picks.map(p => ({ batch_item_id: p.id, from_code: srcCode, to_code: dstCode, qty: p.qty }));
}
function batchTransferPicker(productId, qty, srcCode, dstCode, cands){
  return new Promise((resolve, reject) => {
    const old = document.getElementById('batchTransferOverlay'); if(old) old.remove();
    const p = products.find(x => x.id === productId);
    const unit = p ? batchEsc(p.unit) : '';
    const ov = document.createElement('div');
    ov.id = 'batchTransferOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
    const rows = cands.map(c => `<tr>
      <td>${batchEsc(c.item.batchNo)}${c.item.isOpening ? ' <span style="color:var(--ink-soft);font-size:11px;">(' + t('batchOpening') + ')</span>' : ''}</td>
      <td>${c.item.expiry ? batchEsc(c.item.expiry) : '–'}</td>
      <td class="num">${batchFmtQty(c.rem)}</td>
      <td class="num"><input type="number" class="batch-tr-input" data-id="${c.item.id}" data-max="${c.rem}" min="0" max="${c.rem}" step="1" style="width:80px;" oninput="batchTransferUpdateSum()" /></td>
    </tr>`).join('');
    ov.innerHTML = `<div class="modal-box modal-box-wide">
      <div class="section-title" style="margin-top:0;">${t('batchTransferTitle')}</div>
      <p style="margin-bottom:8px;">${batchEsc(p ? p.name : '')} · ${tf('batchTransferHint', { qty: batchFmtQty(qty), unit, from: batchEsc(srcCode || t('unassignedLocationLabel')), to: batchEsc(dstCode || t('unassignedLocationLabel')) })}</p>
      <table class="stock-table">
        <thead><tr><th>${t('batchColBatch')}</th><th>${t('batchColExpiry')}</th><th class="num">${t('batchTransferHere')}</th><th class="num">${t('batchTransferMove')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="font-size:11.5px;color:var(--ink-soft);margin-top:6px;">${t('batchTransferRestNote')}</div>
      <div id="batchTransferSum" style="font-size:12px;margin:8px 0;color:var(--ink-soft);"></div>
      <div id="batchTransferMsg" class="msg"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="batchTransferCancel">${t('btnCancel')}</button>
        <button class="btn" id="batchTransferOk">${t('btnConfirmYes')}</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    batchTransferQty = qty;
    batchTransferUpdateSum();
    document.getElementById('batchTransferCancel').onclick = () => { ov.remove(); reject(new Error('cancelled')); };
    document.getElementById('batchTransferOk').onclick = () => {
      const picks = [];
      let bad = false;
      ov.querySelectorAll('.batch-tr-input').forEach(inp => {
        const v = parseFloat(inp.value);
        if(v > 0){ if(v > parseFloat(inp.dataset.max) + 1e-9) bad = true; picks.push({ id: inp.dataset.id, qty: v }); }
      });
      const sum = picks.reduce((a, x) => a + x.qty, 0);
      const msg = document.getElementById('batchTransferMsg');
      if(bad){ msg.className = 'msg error'; msg.textContent = t('batchPickerOverRemaining'); return; }
      if(sum > qty + 1e-9){ msg.className = 'msg error'; msg.textContent = t('batchPickerOverQty'); return; }
      ov.remove();
      resolve(picks);
    };
  });
}
let batchTransferQty = 0;
function batchTransferUpdateSum(){
  const el = document.getElementById('batchTransferSum');
  if(!el) return;
  let sum = 0;
  document.querySelectorAll('#batchTransferOverlay .batch-tr-input').forEach(inp => { const v = parseFloat(inp.value); if(v > 0) sum += v; });
  el.textContent = tf('batchTransferSum', { sum: batchFmtQty(sum), qty: batchFmtQty(batchTransferQty) });
}
// 位置轉移完成後呼叫:把批次記的位置搬過去。失敗不影響庫存分布本身(已經轉移成功),提示後可再處理。
async function batchApplyTransfer(rows){
  if(!rows || rows.length === 0) return;
  await batchRpc('batch_transfer_locations', { p_rows: rows });
  batchMarkStale();
  try{ await ensureBatchDataLoaded(true); }catch(e){}
}


// 轉移位置紀錄用:把 batchTransferPick 的結果轉成 [{ batchNo, expiry, qty }]
function batchTransferRowsLabel(rows){
  return (rows || []).map(r => {
    const it = batchData.items.find(x => x.id === r.batch_item_id);
    return { batchNo: it ? it.batchNo : '', expiry: it ? (it.expiry || '') : '', isOpening: it ? !!it.isOpening : false, qty: r.qty };
  });
}


// ---- 編輯進貨單:批次位置跟著數量變動、每行備註 ----
// 編輯前先記下這張進貨單各(商品, 位置)的「進貨位置數量」
function batchSnapshotPurchaseLocs(purchaseId){
  const snap = {};
  batchData.items.filter(i => i.purchaseId === purchaseId).forEach(i => {
    (batchItemLocs[i.id] || []).forEach(l => { const k = i.productId + '|' + l.code; snap[k] = (snap[k] || 0) + l.qty; });
  });
  return snap;
}
// 編輯後:位置數量超過新的進貨量就減回去(資料庫 batch_clamp_purchase_locations);行被移除的位置數量也一起算,
// 把減少的量同步從庫存分布(product_locations)扣掉,避免「未分布」憑空變成負數。
async function batchSyncPurchaseLocAfterEdit(purchaseId, before){
  try{
    await batchRpc('batch_clamp_purchase_locations', { p_purchase_id: purchaseId });
  }catch(e){ if(!batchIsMissingFunctionError(e)) console.error('調整批次位置失敗', e); }
  batchMarkStale();
  try{ await ensureBatchDataLoaded(true); }catch(e){}
  const after = batchSnapshotPurchaseLocs(purchaseId);
  let changed = false;
  for(const k of Object.keys(before || {})){
    const cut = (before[k] || 0) - (after[k] || 0);
    if(cut <= 1e-9) continue;
    const [pid, code] = k.split('|');
    const loc = productLocations.find(l => l.productId === pid && l.locationCode === code);
    if(!loc) continue;
    try{
      loc.qty = Math.max(0, loc.qty - cut);
      if(loc.qty <= 1e-9){ await deleteProductLocationRow(loc.id); productLocations = productLocations.filter(l => l.id !== loc.id); }
      else await upsertProductLocation(loc);
      changed = true;
    }catch(e){ console.error('編輯進貨單後同步庫存分布失敗', e); }
  }
  if(changed){ try{ if(typeof refreshStockLocationView === 'function') refreshStockLocationView(); }catch(e){} }
}
// 編輯進貨單視窗:這個商品行(商品+有效期)目前的批次備註
function batchLineNote(purchaseId, productId, expiry){
  const it = batchData.items.find(i => i.purchaseId === purchaseId && i.productId === productId && (i.expiry || '') === (expiry || ''));
  return it ? (it.note || '') : '';
}
// 只更新備註(不動位置)
async function batchSaveLineNotes(purchaseId, rows){
  if(!rows || rows.length === 0) return;
  try{
    await batchRpc('batch_set_purchase_locations', { p_purchase_id: purchaseId, p_rows: rows });
    batchMarkStale();
    try{ await ensureBatchDataLoaded(true); }catch(e){}
  }catch(e){ console.error('儲存批次備註失敗', e); }
}
