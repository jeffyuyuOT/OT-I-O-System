// ============================================================
// 非庫存商品(訂單 / Delivery Note)+ Delivery Note 選關聯單據後的「勾選商品」視窗
//   · 訂單(新增、載入待處理、載入已完成)與 Delivery Note 都可以加非庫存商品:名稱、數量、單位、單價(有價錢權限才看得到單價)。
//     非庫存商品不動庫存,存在 order.nonStockItems / deliveryNote.nonStockItems。
//     出現在:訂單明細、撿貨單/列印、開 Invoice 時帶入(單價必填)、Delivery Note 列印。
//   · Delivery Note 選了「關聯單據」(訂單或非銷售出庫單)後,跳出視窗列出該單據的商品,勾選要放進 Delivery Note 的商品與數量
//     (不能超過單據上的數量),之後庫存商品只能從該單據裡挑;非庫存商品可以另外加。
// ============================================================
let txNsItems = [];   // { id, name, qty, unit, price, gst }

function txNsClean(){
  return txNsItems.map(n => ({ id: n.id, name: n.name, qty: n.qty, unit: n.unit || '', price: (n.price === undefined || n.price === '') ? null : n.price, gst: !!n.gst }));
}
function txNsOf(obj){ return ((obj && obj.nonStockItems) || []).map(n => ({ id: n.id || genId(), name: n.name, qty: n.qty, unit: n.unit || '', price: (n.price === undefined ? null : n.price), gst: !!n.gst })); }
function txNsSig(list){ return JSON.stringify((list || []).map(n => [n.name, Number(n.qty), n.unit || '', n.price === null || n.price === undefined || n.price === '' ? null : Number(n.price), !!n.gst])); }
function txNsChanged(order){ return txNsSig(txNsClean()) !== txNsSig(order.nonStockItems || []); }
// 套用到訂單(儲存時呼叫);回傳是否有變動
function txNsApply(order){
  if(!txNsChanged(order)) return false;
  const before = (order.nonStockItems || []).map(n => `${n.name} ${n.qty}${n.unit ? ' ' + n.unit : ''}`).join('; ');
  const next = txNsClean();
  if(next.length) order.nonStockItems = next; else delete order.nonStockItems;
  try{ logInventoryAction('order_edit', `Order ${order.orderNo || order.id} - non-stock items: [${before}] → [${next.map(n => `${n.name} ${n.qty}${n.unit ? ' ' + n.unit : ''}`).join('; ')}]`, order.orderNo); }catch(e){}
  return true;
}

function txNsActive(){
  if(currentTxType === 'out') return registerOutKind !== 'nonsales' && (registerOutFlowType === 'new-order' || registerOutFlowType === 'load-pending' || registerOutFlowType === 'load-completed');
  if(currentTxType === 'delivery') return registerDeliveryFlowType === 'new' || registerDeliveryFlowType === 'load';
  return false;
}
function txNsShowPrice(){ return currentTxType === 'out' && typeof canViewPrice === 'function' && canViewPrice(); }

function renderTxNsSection(){
  const host = document.getElementById('txNsSection'); if(!host) return;
  if(!txNsActive()){ host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = '';
  const price = txNsShowPrice();
  const key = price ? 'p' : 'n';
  if(host.dataset.form !== key){
    host.dataset.form = key;
    host.innerHTML = `<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--line);">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px;">${t('txNsTitle')} <span style="font-weight:400;color:var(--ink-soft);font-size:11.5px;">${t('txNsHint')}</span></div>
      <div class="form-grid" style="grid-template-columns:1.6fr .7fr .7fr ${price ? '.8fr auto ' : ''}auto;gap:8px;align-items:end;">
        <div class="field"><label>${t('txNsName')}</label><input id="txNsName" type="text" /></div>
        <div class="field"><label>${t('lblQty')}</label><input id="txNsQty" type="number" step="any" min="0" placeholder="0" /></div>
        <div class="field"><label>${t('txNsUnit')}</label><input id="txNsUnit" type="text" /></div>
        ${price ? `<div class="field"><label>${t('txNsPrice')}</label><input id="txNsPrice" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;padding-bottom:8px;cursor:pointer;"><input id="txNsGst" type="checkbox" style="width:auto;margin:0;" /> GST</label>` : ''}
        <button class="btn ghost" type="button" onclick="addTxNsItem()">${t('txNsAdd')}</button>
      </div>
      <div id="txNsMsg" class="msg"></div>
      <div id="txNsRows"></div>
    </div>`;
  }
  const rows = document.getElementById('txNsRows'); if(!rows) return;
  if(!txNsItems.length){ rows.innerHTML = ''; return; }
  rows.innerHTML = `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('txNsName')}</th><th class="num">${t('lblQty')}</th><th>${t('txNsUnit')}</th>${price ? `<th class="num">${t('txNsPrice')}</th><th>GST</th>` : ''}<th></th></tr></thead><tbody>
    ${txNsItems.map(n => `<tr style="background:var(--bg-soft,#f5f5f0);"><td>${escapeHtmlForPrint(n.name)} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcNonStockBadge')})</span></td>
      <td class="num"><input type="number" class="order-qty-input" step="any" min="0" value="${n.qty}" onchange="txNsEdit('${n.id}','qty',this.value)" /></td>
      <td>${escapeHtmlForPrint(n.unit || '')}</td>
      ${price ? `<td class="num"><input type="number" class="order-qty-input" step="0.01" min="0" value="${n.price === null || n.price === undefined ? '' : n.price}" onchange="txNsEdit('${n.id}','price',this.value)" /></td>
      <td><input type="checkbox" ${n.gst ? 'checked' : ''} style="width:auto;" onchange="txNsEdit('${n.id}','gst',this.checked)" /></td>` : ''}
      <td><button onclick="removeTxNsItem('${n.id}')" title="${t('btnDelete')}">✕</button></td></tr>`).join('')}
  </tbody></table></div>`;
}
function addTxNsItem(){
  const g = id => (document.getElementById(id) || {}).value || '';
  const msg = document.getElementById('txNsMsg');
  const name = g('txNsName').trim(), qty = parseFloat(g('txNsQty')), unit = g('txNsUnit').trim();
  const bad = k => { if(msg){ msg.className = 'msg error'; msg.textContent = t(k); } };
  if(!name) return bad('txNsNeedName');
  if(!(qty > 0)) return bad('txNsNeedQty');
  let price = null;
  if(txNsShowPrice() && g('txNsPrice') !== ''){ price = parseFloat(g('txNsPrice')); if(!(price >= 0)) return bad('txNsNeedPrice'); }
  txNsItems.push({ id: genId(), name, qty, unit, price, gst: !!(document.getElementById('txNsGst') || {}).checked });
  ['txNsName', 'txNsQty', 'txNsUnit', 'txNsPrice'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  const gs = document.getElementById('txNsGst'); if(gs) gs.checked = false;
  if(msg){ msg.className = 'msg'; msg.textContent = ''; }
  renderTxNsSection();
}
function removeTxNsItem(id){ txNsItems = txNsItems.filter(n => n.id !== id); renderTxNsSection(); }
function txNsEdit(id, field, val){
  const n = txNsItems.find(x => x.id === id); if(!n) return;
  if(field === 'qty'){ const q = parseFloat(val); if(q > 0) n.qty = q; }
  else if(field === 'price'){ if(val === '') n.price = null; else { const p = parseFloat(val); if(p >= 0) n.price = p; } }
  else if(field === 'gst') n.gst = !!val;
  renderTxNsSection();
}

// ---- 訂單明細 / 列印用 ----
function orderNsRowsHtml(o){
  const list = (o && o.nonStockItems) || [];
  if(!list.length) return '';
  const showPrice = typeof canViewPrice === 'function' && canViewPrice();
  return list.map(n => `<div style="background:var(--bg-soft,#f5f5f0);">
      <span>${escapeHtmlForPrint(n.name)}</span> <span style="color:var(--ink-soft);font-size:11px;">(${t('pcNonStockBadge')})</span>
      <span style="color:var(--ink-soft);margin-left:6px;">${n.qty} ${escapeHtmlForPrint(n.unit || '')}${showPrice && n.price !== null && n.price !== undefined ? ' · $' + Number(n.price).toFixed(2) : ''}</span></div>`).join('');
}

// ============================================================
// Delivery Note:選關聯單據 → 勾選商品視窗
// ============================================================
let dnRefDoc = null;   // { items:[{productId,sku,name,unit,qty}], ns:[{name,qty,unit,price,gst}] } 目前選的關聯單據裡的內容

// 同一張關聯單據、已經完成(列印過)的其他 Delivery Note 已送出的數量(正在編輯的這張不算)
function dnRefDeliveredBy(ref){
  const items = {}, ns = {};
  (typeof deliveryNotes !== 'undefined' ? deliveryNotes : []).forEach(n => {
    // 只有已完成(已列印)的 Delivery Note 才算「已送」;待處理的在列印時才檢查數量
    if(!n || n.deleted || n.status !== 'completed' || !n.ref || n.ref.id !== ref.id || n.id === registerLoadedDeliveryNoteId) return;
    (n.items || []).forEach(it => { items[it.productId] = (items[it.productId] || 0) + (Number(it.qty) || 0); });
    (n.nonStockItems || []).forEach(x => { const k = x.name + '|' + (x.unit || ''); ns[k] = (ns[k] || 0) + (Number(x.qty) || 0); });
  });
  return { items, ns };
}
function dnRefSourceOf(ref){
  const d = dnRefSourceRaw(ref);
  if(!d) return d;
  const done = dnRefDeliveredBy(ref);
  d.items = d.items.map(it => ({ ...it, qty: it.qty - (done.items[it.productId] || 0) })).filter(it => it.qty > 1e-9);
  d.ns = d.ns.map(n => ({ ...n, qty: n.qty - (done.ns[n.name + '|' + (n.unit || '')] || 0) })).filter(n => n.qty > 1e-9);
  return d;
}
function dnRefSourceRaw(ref){
  if(!ref) return null;
  if(ref.type === 'order'){
    const o = (typeof orders !== 'undefined' ? orders : []).find(x => x.id === ref.id);
    if(!o) return null;
    const m = new Map();
    (o.items || []).filter(it => !it.deleted && it.qty > 0).forEach(it => {
      const k = it.productId; const ex = m.get(k);
      if(ex) ex.qty += it.qty; else m.set(k, { productId: it.productId, sku: it.sku || '', name: it.name, unit: it.unit, qty: it.qty });
    });
    return { items: Array.from(m.values()), ns: txNsOf(o) };
  }
  const s = (typeof nonSalesSlips !== 'undefined' ? nonSalesSlips : []).find(x => x.id === ref.id);
  if(!s) return null;
  const m = new Map();
  (s.items || []).filter(it => it.qty > 0).forEach(it => {
    const ex = m.get(it.productId);
    if(ex) ex.qty += it.qty; else m.set(it.productId, { productId: it.productId, sku: it.sku || '', name: it.name, unit: it.unit, qty: it.qty });
  });
  return { items: Array.from(m.values()), ns: [] };
}
// 修改訂單(待處理/已完成)儲存前:改後的數量如果比已開 Delivery Note 的數量少,擋下來,請先去改或刪 Delivery Note
function dnGuardOrderEdit(order, qtyMap, delIds, msg, opts){
  const notes = (typeof deliveryNotes !== 'undefined' ? deliveryNotes : []).filter(n => n && !n.deleted && n.ref && n.ref.id === order.id);
  if(!notes.length) return false;
  const done = {}, doneNs = {};
  notes.forEach(n => {
    (n.items || []).forEach(it => { (done[it.productId] = done[it.productId] || []).push({ no: n.date || '', qty: Number(it.qty) || 0 }); });
    (n.nonStockItems || []).forEach(x => { const k = x.name + '|' + (x.unit || ''); (doneNs[k] = doneNs[k] || []).push({ no: n.date || '', qty: Number(x.qty) || 0 }); });
  });
  const final = {};
  (order.items || []).filter(it => !it.deleted).forEach(it => {
    let q = it.qty;
    if(qtyMap && qtyMap[it.productId] !== undefined) q = qtyMap[it.productId];
    if(delIds && delIds.includes(it.productId)) q = 0;
    final[it.productId] = (final[it.productId] || 0) + q;
  });
  const bad = [];
  Object.keys(done).forEach(pid => {
    const sum = done[pid].reduce((s, x) => s + x.qty, 0);
    if(sum > (final[pid] || 0) + 1e-9){
      const it = (order.items || []).find(x => x.productId === pid);
      bad.push(`${it ? it.name : pid}: ${t('dnGuardNew')} ${final[pid] || 0} < ${t('dnGuardDelivered')} ${sum} (${done[pid].map(x => x.no).join(', ')})`);
    }
  });
  const nsNow = {};
  ((opts && opts.nsOrder) ? (opts.all ? [] : (order.nonStockItems || [])) : txNsClean()).forEach(n => { const k = n.name + '|' + (n.unit || ''); nsNow[k] = (nsNow[k] || 0) + n.qty; });
  Object.keys(doneNs).forEach(k => {
    const sum = doneNs[k].reduce((s, x) => s + x.qty, 0);
    if(sum > (nsNow[k] || 0) + 1e-9) bad.push(`${k.split('|')[0]}: ${t('dnGuardNew')} ${nsNow[k] || 0} < ${t('dnGuardDelivered')} ${sum}`);
  });
  if(!bad.length) return false;
  if(msg){ msg.className = 'msg error'; msg.textContent = `⚠ ${t('dnGuardMsg')}\n${bad.join('\n')}`; msg.style.whiteSpace = 'pre-line'; }
  return true;
}
// 直接刪除訂單品項/整張訂單(歷史頁面按刪除):有關聯 Delivery Note 就擋下來。productId 空 = 整張訂單
function dnGuardOrderDelete(order, productId){
  const m = { style: {} };
  const all = !productId;
  const ids = all ? (order.items || []).filter(it => !it.deleted).map(it => it.productId) : [productId];
  if(!dnGuardOrderEdit(order, {}, ids, m, { nsOrder: true, all })) return false;
  showInfoModal(m.textContent);
  return true;
}
// 目前 Delivery Note 的關聯單據內容(讀不到就 null = 不限制)
function dnRefDocCurrent(){
  if(currentTxType !== 'delivery' || !dnRefSelected) return null;
  dnRefDoc = dnRefSourceOf(dnRefSelected);
  return dnRefDoc;
}
function dnRefQtyLimit(productId){
  const d = dnRefDocCurrent(); if(!d) return null;
  const it = d.items.find(x => x.productId === productId);
  return it ? it.qty : 0;
}
function dnCloseSelectModal(){ const o = document.getElementById('dnPickOverlay'); if(o) o.remove(); }
function dnOpenSelectModal(){
  const d = dnRefDocCurrent(); if(!d) return;
  dnCloseSelectModal();
  const cur = {}; txBatchItems.forEach(it => { cur[it.productId] = (cur[it.productId] || 0) + it.qty; });
  const curNs = new Set(txNsItems.map(n => n.name + '|' + n.unit));
  const esc = escapeHtmlForPrint;
  const stockRows = d.items.map((it, i) => `<tr><td><input type="checkbox" class="dnPickCk" data-i="${i}" ${(cur[it.productId] || !Object.keys(cur).length) ? 'checked' : ''} style="width:auto;" onchange="dnPickToggle(${i})" /></td>
      <td>${esc(it.sku)}</td><td>${esc(it.name)}</td>
      <td class="num"><input type="number" class="order-qty-input dnPickQty" data-i="${i}" min="1" max="${it.qty}" step="1" value="${Math.min(it.qty, cur[it.productId] || it.qty)}" /></td>
      <td>/ ${it.qty} ${esc(it.unit || '')}</td></tr>`).join('');
  const nsRows = d.ns.map((n, i) => `<tr style="background:var(--bg-soft,#f5f5f0);"><td><input type="checkbox" class="dnPickNsCk" data-i="${i}" ${(curNs.has(n.name + '|' + n.unit) || (!Object.keys(cur).length && !txNsItems.length)) ? 'checked' : ''} style="width:auto;" /></td>
      <td></td><td>${esc(n.name)} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcNonStockBadge')})</span></td>
      <td class="num"><input type="number" class="order-qty-input dnPickNsQty" data-i="${i}" min="0" step="any" max="${n.qty}" value="${n.qty}" /></td>
      <td>/ ${n.qty} ${esc(n.unit || '')}</td></tr>`).join('');
  const ov = document.createElement('div');
  ov.id = 'dnPickOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(720px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('dnPickTitle')} · ${esc(dnRefSelected.no)}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${t('dnPickHint')}</p>
    ${(d.items.length || d.ns.length) ? `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th><input type="checkbox" id="dnPickAll" checked style="width:auto;" onchange="document.querySelectorAll('.dnPickCk,.dnPickNsCk').forEach(c => c.checked = this.checked)" /></th><th>SKU</th><th>${t('lblProduct')}</th><th class="num">${t('lblQty')}</th><th></th></tr></thead><tbody>${stockRows}${nsRows}</tbody></table></div>`
      : `<div class="empty-note">${t('dnPickEmpty')}</div>`}
    <div id="dnPickMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="dnCloseSelectModal()">${t('btnCancel')}</button><button class="btn" onclick="dnPickConfirm()">${t('dnPickConfirm')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function dnPickToggle(){}
function dnPickConfirm(){
  const d = dnRefDocCurrent(); if(!d) return;
  const msg = document.getElementById('dnPickMsg');
  const items = [], ns = [];
  let bad = '';
  document.querySelectorAll('.dnPickCk').forEach(ck => {
    if(!ck.checked) return;
    const i = +ck.dataset.i, src = d.items[i];
    const q = parseFloat((document.querySelector(`.dnPickQty[data-i="${i}"]`) || {}).value);
    if(!(q > 0) || !Number.isInteger(q)) bad = t('errQtyMustBeInteger');
    else if(q > src.qty) bad = tf('errDnQtyExceed', { name: src.name, max: src.qty, unit: src.unit || '' });
    else items.push({ batchItemId: genId(), productId: src.productId, sku: src.sku, name: src.name, unit: src.unit, qty: q });
  });
  document.querySelectorAll('.dnPickNsCk').forEach(ck => {
    if(!ck.checked) return;
    const i = +ck.dataset.i, src = d.ns[i];
    const q = parseFloat((document.querySelector(`.dnPickNsQty[data-i="${i}"]`) || {}).value);
    if(!(q > 0)) bad = t('txNsNeedQty');
    else if(q > src.qty) bad = tf('errDnQtyExceed', { name: src.name, max: src.qty, unit: src.unit || '' });
    else ns.push({ id: genId(), name: src.name, qty: q, unit: src.unit || '', price: src.price, gst: !!src.gst });
  });
  if(bad){ showInfoModal(bad); return; }
  txBatchItems = items;
  // 勾選視窗裡的非庫存商品換成這次勾選的;手動另外加的(不在單據裡的)保留
  const srcKeys = new Set(d.ns.map(n => n.name + '|' + n.unit));
  txNsItems = txNsItems.filter(n => !srcKeys.has(n.name + '|' + (n.unit || ''))).concat(ns);
  dnCloseSelectModal();
  renderTxBatchList(); renderProductSelect();
}


// ============================================================
// Delivery Note 紀錄:某張關聯單據(已完成訂單/非銷售出庫單)原本的商品量、各 Delivery Note 送了多少、剩餘多少
// ============================================================
function dnLinkedNotes(refId){
  return (typeof deliveryNotes !== 'undefined' ? deliveryNotes : []).filter(n => n && !n.deleted && n.ref && n.ref.id === refId)
    .slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}
// 這張訂單的 Delivery Note 出貨狀態:'none' 沒有關聯 DN / 'partial' 有關聯 DN 但還沒送完(Partially Shipped)/ 'done' 已送完;
// DN 資料還沒載入回傳 null。「已送」只算已完成(已列印)的 DN,待處理的 DN 在列印時才扣,跟選商品視窗同一套規則。
function dnOrderShipState(orderId){
  if(typeof deliveryNotesLoaded === 'undefined' || !deliveryNotesLoaded) return null;
  const linked = dnLinkedNotes(orderId);
  if(!linked.length) return 'none';
  const src = dnRefSourceRaw({ type: 'order', id: orderId });
  if(!src) return 'none';
  const items = {}, ns = {};
  linked.filter(n => n.status === 'completed').forEach(n => {
    (n.items || []).forEach(it => { items[it.productId] = (items[it.productId] || 0) + (Number(it.qty) || 0); });
    (n.nonStockItems || []).forEach(x => { const k = x.name + '|' + (x.unit || ''); ns[k] = (ns[k] || 0) + (Number(x.qty) || 0); });
  });
  const left = src.items.some(it => it.qty - (items[it.productId] || 0) > 1e-9) || src.ns.some(n => n.qty - (ns[n.name + '|' + (n.unit || '')] || 0) > 1e-9);
  return left ? 'partial' : 'done';
}
function dnOrderBadgeHtml(o){
  if(!o || o.deleted || dnOrderShipState(o.id) !== 'partial') return '';
  return `<span style="font-size:11px;font-weight:600;color:var(--warn,#b45309);border:1px solid currentColor;border-radius:10px;padding:0 7px;white-space:nowrap;" title="${t('dnBadgePartialTitle')}">${t('dnBadgePartial')}</span>`;
}
function dnRecordHtml(type, id){
  const esc = escapeHtmlForPrint;
  const src = dnRefSourceRaw({ type, id });
  const notes = dnLinkedNotes(id);
  if(!src) return `<div class="empty-note">${t('noRecordsYet')}</div>`;
  const tag = n => `${esc(n.no || n.date || '')}${n.note ? ' · ' + esc(n.note) : ''}${n.status === 'completed' ? '' : ` <span style="color:var(--ink-soft);">(${t('statusPending')})</span>`}`;
  const rowOf = (name, unit, orig, sent) => {
    const done = sent.filter(x => x.n.status === 'completed').reduce((s, x) => s + x.qty, 0);   // 剩餘只扣已完成的,待處理另外標示
    const pendQ = sent.filter(x => x.n.status !== 'completed').reduce((s, x) => s + x.qty, 0);
    const rem = orig - done;
    return `<tr><td>${esc(name)}</td><td class="num">${orig} ${esc(unit || '')}</td>
      <td style="font-size:12px;line-height:1.6;">${sent.length ? sent.map(x => `${tag(x.n)} × <b>${x.qty}</b>`).join('<br>') : '<span style="color:var(--ink-soft);">–</span>'}</td>
      <td class="num">${done}${pendQ ? `<div style="font-size:11px;color:var(--warn-dark,#b45309);">${t('dnRemPendShort')} ${pendQ}</div>` : ''}</td><td class="num" style="font-weight:700;${rem < -1e-9 ? 'color:var(--crit);' : ''}">${rem}</td></tr>`;
  };
  const rows = src.items.map(it => rowOf(it.name, it.unit, it.qty,
    notes.map(n => ({ n, qty: (n.items || []).filter(x => x.productId === it.productId).reduce((s, x) => s + (Number(x.qty) || 0), 0) })).filter(x => x.qty > 0))).join('')
    + (src.ns || []).map(nsx => rowOf(nsx.name, nsx.unit, nsx.qty,
    notes.map(n => ({ n, qty: (n.nonStockItems || []).filter(x => x.name === nsx.name && (x.unit || '') === (nsx.unit || '')).reduce((s, x) => s + (Number(x.qty) || 0), 0) })).filter(x => x.qty > 0))).join('');
  return `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('lblProduct')}</th><th class="num">${t('dnRecOrig')}</th><th>${t('dnRecSent')}</th><th class="num">${t('dnRecDelivered')}</th><th class="num">${t('dnRecRemain')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
async function dnShowRecordModal(type, id){
  await ensureDeliveryNotesLoaded();
  const old = document.getElementById('dnRecOverlay'); if(old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'dnRecOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1300';
  const no = type === 'order' ? ((orders.find(o => o.id === id) || {}).orderNo || '') : ((nonSalesSlips.find(x => x.id === id) || {}).no || '');
  ov.innerHTML = `<div class="modal-box" style="max-width:min(820px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('dnRecTitle')} · ${escapeHtmlForPrint(String(no))}</div>
    ${dnRecordHtml(type, id)}
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('dnRecOverlay').remove()">${t('btnClose')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}


// ============================================================
// 歷史紀錄 → Delivery Note:匯出「訂單剩餘數量」。只有已完成(已列印)的 Delivery Note 才計入已送數量
// ============================================================
let dnRemDocs = [];
function dnRemainCompute(){
  const byRef = {};
  deliveryNotes.filter(n => n && !n.deleted && n.ref && n.ref.id).forEach(n => { (byRef[n.ref.id] = byRef[n.ref.id] || { ref: n.ref, notes: [] }).notes.push(n); });
  const out = [];
  Object.keys(byRef).forEach(id => {
    const g = byRef[id];
    const src = dnRefSourceRaw({ type: g.ref.type, id });
    if(!src) return;
    const done = g.notes.filter(n => n.status === 'completed');
    const pend = g.notes.filter(n => n.status !== 'completed');
    const sumI = (list, pid) => list.reduce((s, n) => s + (n.items || []).filter(x => x.productId === pid).reduce((a, x) => a + (Number(x.qty) || 0), 0), 0);
    const sumN = (list, nm, un) => list.reduce((s, n) => s + (n.nonStockItems || []).filter(y => y.name === nm && (y.unit || '') === (un || '')).reduce((a, y) => a + (Number(y.qty) || 0), 0), 0);
    const items = src.items.map(it => ({ ...it, rem: it.qty - sumI(done, it.productId), pend: sumI(pend, it.productId) })).filter(x => x.rem > 1e-9);
    const ns = (src.ns || []).map(x => ({ ...x, rem: x.qty - sumN(done, x.name, x.unit), pend: sumN(pend, x.name, x.unit) })).filter(x => x.rem > 1e-9);
    if(!items.length && !ns.length) return;
    let date = '', party = '';
    if(g.ref.type === 'order'){ const o = orders.find(x => x.id === id); date = o ? (o.date || '') : ''; party = o ? (o.partyName || '') : ''; }
    else { const sl = nonSalesSlips.find(x => x.id === id); date = sl ? (sl.date || '') : ''; party = sl ? (sl.recipient || '') : ''; }
    out.push({ id, type: g.ref.type, no: g.ref.no, date, party, items, ns, pendCount: g.notes.filter(n => n.status !== 'completed').length });
  });
  return out.sort((a, b) => String(b.no).localeCompare(String(a.no)));
}
async function dnRemainOpen(){
  await Promise.all([ensureDeliveryNotesLoaded(), ensureOrdersLoadedFrom(''), ensureNonSalesSlipsLoaded()]);
  dnRemDocs = dnRemainCompute();
  const old = document.getElementById('dnRemOverlay'); if(old) old.remove();
  const esc = escapeHtmlForPrint;
  const rows = dnRemDocs.map((d, i) => `<tr><td><input type="checkbox" class="dnRemCk" data-i="${i}" style="width:auto;" /></td>
    <td style="white-space:nowrap;"><b>${esc(String(d.no))}</b><div style="font-size:11px;color:var(--ink-soft);">${dnRefTypeLabel(d.type)}</div>${d.pendCount ? `<div style="font-size:11px;color:var(--warn-dark,#b45309);">${tf('dnRemHasPending', { n: d.pendCount })}</div>` : ''}</td>
    <td style="white-space:nowrap;">${esc(d.date)}</td><td>${esc(d.party)}</td>
    <td style="font-size:12px;">${d.items.concat(d.ns).map(x => `${esc(x.name)} ${x.rem} ${esc(x.unit || '')}${x.pend ? ` <span style="color:var(--warn-dark,#b45309);">(${t('dnRemPendShort')} ${x.pend})</span>` : ''}`).join(', ')}</td></tr>`).join('');
  const ov = document.createElement('div');
  ov.id = 'dnRemOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1200';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(900px,98vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('dnRemTitle')}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${t('dnRemHint')}</p>
    ${dnRemDocs.length ? `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th><input type="checkbox" style="width:auto;" onchange="document.querySelectorAll('.dnRemCk').forEach(c=>c.checked=this.checked)" title="${t('dnRemSelectAll')}" /></th><th>${t('colDnRef')}</th><th>${t('colDate')}</th><th>${t('lblPartyGeneric')}</th><th>${t('dnRecRemain')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty-note">${t('dnRemNone')}</div>`}
    <div id="dnRemMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('dnRemOverlay').remove()">${t('btnClose')}</button>${dnRemDocs.length ? `<button class="btn" onclick="dnRemainExport()">${t('dnRemExport')}</button>` : ''}</div>
  </div>`;
  document.body.appendChild(ov);
}
function dnRemainExport(){
  const msg = document.getElementById('dnRemMsg');
  const picked = Array.from(document.querySelectorAll('.dnRemCk')).filter(c => c.checked).map(c => dnRemDocs[+c.dataset.i]);
  if(!picked.length){ if(msg){ msg.className = 'msg error'; msg.textContent = t('dnRemPickOne'); } return; }
  if(typeof XLSX === 'undefined'){ showInfoModal('Excel 套件載入失敗,請重新整理頁面再試一次'); return; }
  const agg = new Map();
  picked.forEach(d => {
    d.items.forEach(it => { const k = 'p|' + it.productId; const e = agg.get(k) || { sku: it.sku || '', name: it.name, unit: it.unit || '', rem: 0, pend: 0 }; e.rem += it.rem; e.pend += it.pend || 0; agg.set(k, e); });
    d.ns.forEach(it => { const k = 'n|' + it.name + '|' + (it.unit || ''); const e = agg.get(k) || { sku: '', name: it.name, unit: it.unit || '', rem: 0, pend: 0, ns: true }; e.rem += it.rem; e.pend += it.pend || 0; agg.set(k, e); });
  });
  const rows = Array.from(agg.values()).sort((a, b) => (a.ns ? 1 : 0) - (b.ns ? 1 : 0) || a.name.localeCompare(b.name));
  const aoa = [[t('dnRemSheetTitle')], [], ['SKU', 'Product Name', 'Unit', 'Remaining Qty', 'Pending DN Qty', 'Remaining after Pending']];
  rows.forEach(r => aoa.push([r.sku, r.name + (r.ns ? ` (${t('pcNonStockBadge')})` : ''), r.unit, r.rem, r.pend, r.rem - r.pend]));
  aoa.push([], [t('dnRemRelated')], ['Type', 'Document No.', 'Date', 'Party', 'Pending Delivery Notes']);
  picked.forEach(d => aoa.push([d.type === 'nonsales' ? 'Non-Sales Outbound Slip' : 'Order', String(d.no), d.date, d.party, d.pendCount || 0]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 16 }, { wch: 38 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Remaining');
  XLSX.writeFile(wb, `delivery_remaining_${todayISO()}.xlsx`);
}

// 列印 Delivery Note 前檢查:每個商品的數量不能超過「關聯單據 − 已完成 Delivery Note」的剩餘。超過就擋下來,並列出其他待處理的 Note
function dnPrintQtyCheck(data, selfId){
  if(!data.ref) return '';
  const src = dnRefSourceOf(data.ref); if(!src) return '';
  const others = dnLinkedNotes(data.ref.id).filter(n => n.status !== 'completed' && n.id !== selfId);
  const bad = [];
  const want = {}, wantNs = {};
  (data.items || []).forEach(it => { want[it.productId] = (want[it.productId] || 0) + it.qty; });
  Object.keys(want).forEach(pid => {
    const s = src.items.find(x => x.productId === pid);
    const rem = s ? s.qty : 0;
    if(want[pid] > rem + 1e-9){
      const name = ((data.items || []).find(x => x.productId === pid) || {}).name || pid;
      const occ = others.filter(n => (n.items || []).some(x => x.productId === pid)).map(n => n.no || n.date).join(', ');
      bad.push(`${name}: ${t('dnPrintWant')} ${want[pid]} > ${t('dnRecRemain')} ${rem}${occ ? ` (${t('dnPrintPendingBy')} ${occ})` : ''}`);
    }
  });
  (data.nonStockItems || []).forEach(n => { const k = n.name + '|' + (n.unit || ''); wantNs[k] = (wantNs[k] || 0) + n.qty; });
  Object.keys(wantNs).forEach(k => {
    const s = (src.ns || []).find(x => x.name + '|' + (x.unit || '') === k);
    const rem = s ? s.qty : 0;
    if(wantNs[k] > rem + 1e-9) bad.push(`${k.split('|')[0]}: ${t('dnPrintWant')} ${wantNs[k]} > ${t('dnRecRemain')} ${rem}`);
  });
  return bad.length ? `${t('dnPrintShort')}\n${bad.join('\n')}` : '';
}
async function dnDeletePending(id){
  await ensureDeliveryNotesLoaded();
  const n = deliveryNotes.find(x => x.id === id);
  if(!n || n.status === 'completed') return;
  showConfirmModal(tf('dnDeleteConfirm', { no: n.no || n.date || '' }), async () => {
    try{ await deleteDeliveryNoteRow(id); }
    catch(e){ showInfoModal(t('dnDeleteFail')); return; }
    deliveryNotes = deliveryNotes.filter(x => x.id !== id);
    if(registerLoadedDeliveryNoteId === id){ registerLoadedDeliveryNoteId = null; registerDeliveryFlowType = ''; txBatchItems = []; txNsItems = []; setTxDeliveryFlowType(''); }
    logInventoryAction('delivery_note', `Deleted pending Delivery Note ${n.no || ''} (${n.date})`, null);
    renderDeliveryNoteLog();
  });
}
