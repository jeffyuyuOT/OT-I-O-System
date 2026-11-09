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

function dnRefSourceOf(ref){
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
  if(bad){ if(msg){ msg.className = 'msg error'; msg.textContent = bad; } return; }
  txBatchItems = items;
  // 勾選視窗裡的非庫存商品換成這次勾選的;手動另外加的(不在單據裡的)保留
  const srcKeys = new Set(d.ns.map(n => n.name + '|' + n.unit));
  txNsItems = txNsItems.filter(n => !srcKeys.has(n.name + '|' + (n.unit || ''))).concat(ns);
  dnCloseSelectModal();
  renderTxBatchList(); renderProductSelect();
}
