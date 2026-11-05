// ============================================================
// 會計分頁 → 開立發票 (Create Invoice)
//   · New Invoice:選出貨方、挑商品(分類 + 搜尋,價格自動帶入)或自訂品項,直接開一張沒有訂單的 Invoice
//   · Generate from Order:挑一張或多張訂單(待處理 / 已完成 / 全部,可依日期、出貨方篩選),合併成一張 Invoice
// 需要先執行 sql/invoice_orders.sql。整頁受「隱藏 Invoice 功能」控制。
// ============================================================
const icState = {
  mode: 'new',                 // 'new' | 'order'
  partyId: '', partySearch: '',
  items: [],                   // { productId, sku, desc, unit, qty, price, gst, custom }
  note: '',
  of: { status: 'pending', from: '', to: '', partyId: '', q: '' },
  sel: new Set()
};
let icPickCat = '', icPickQ = '';

function icOk(){ return typeof canCreateInvoice === 'function' && canCreateInvoice(); }
function icParty(id){ return (typeof shippingParties !== 'undefined' ? shippingParties : []).find(x => x.id === id) || null; }
function icPartyLabel(sp){ return sp ? (sp.companyName && sp.companyName !== sp.name ? `${sp.name} (${sp.companyName})` : sp.name) : ''; }
function icR2(n){ return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// ---------- 頁面 ----------
async function icOpenPage(){
  if(!icOk()) return;
  const root = document.getElementById('invoiceCreateRoot');
  if(!root) return;
  try{ await loadInvoiceSettings(); }catch(e){}
  icRender();
}
function icSetMode(m){ icState.mode = m; icRender(); }
function icRender(){
  const root = document.getElementById('invoiceCreateRoot');
  if(!root) return;
  if(!icOk()){ root.innerHTML = ''; return; }
  const tab = (m, label) => `<button class="btn ${icState.mode === m ? '' : 'ghost'}" onclick="icSetMode('${m}')">${label}</button>`;
  root.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${tab('new', t('icModeNew'))}${tab('order', t('icModeOrder'))}</div><div id="icBody"></div>`;
  if(icState.mode === 'new') icRenderNew(); else icRenderOrder();
}

// ---------- New Invoice ----------
function icPartyMatches(q){
  q = (q || '').trim().toLowerCase();
  const all = (typeof shippingParties !== 'undefined' ? shippingParties : []).filter(p => !p.deleted);
  return all.filter(p => !q || [p.name, p.companyName, p.code, p.abn].join(' ').toLowerCase().includes(q)).slice(0, 12);
}
function icRenderNew(){
  const host = document.getElementById('icBody'); if(!host) return;
  const sp = icParty(icState.partyId);
  const partyBlock = sp
    ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><b>${invEsc(icPartyLabel(sp))}</b><span class="del-link" onclick="icClearParty()">${t('icChangeParty')}</span></div>`
    : `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
         <input id="icPartyInput" type="text" placeholder="${invEsc(t('icPartySearchPh'))}" value="${invEsc(icState.partySearch)}" oninput="icOnPartySearch(this.value)" style="flex:1;min-width:200px;" autocomplete="off" />
         ${hasCapability('cap-manage-parties') ? `<button class="btn ghost" onclick="icAddParty()">＋ ${t('icAddParty')}</button>` : ''}
       </div>
       <div id="icPartyList" style="margin-top:6px;max-height:220px;overflow:auto;"></div>`;
  host.innerHTML = `
    <div class="settings-card" style="margin-bottom:10px;">
      <div class="section-title" style="margin-top:0;">${t('icFieldParty')}</div>
      ${partyBlock}
    </div>
    <div class="settings-card" style="margin-bottom:10px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        <div class="section-title" style="margin:0;flex:1;">${t('icFieldItems')}</div>
        <button class="btn ghost" onclick="icOpenProductPicker()">＋ ${t('icAddProduct')}</button>
        <button class="btn ghost" onclick="icOpenCustomItem()">＋ ${t('icAddCustom')}</button>
      </div>
      <div id="icItems"></div>
    </div>
    <div class="settings-card" style="margin-bottom:10px;">
      <div class="section-title" style="margin-top:0;">Note</div>
      <textarea id="icNote" rows="2" style="width:100%;box-sizing:border-box;" oninput="icState.note=this.value">${invEsc(icState.note)}</textarea>
    </div>
    <div id="icMsg" class="msg"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn" onclick="icPreviewNew()">${t('icBtnPreview')}</button><button class="btn ghost" onclick="icResetNew()">${t('icBtnReset')}</button></div>`;
  if(!sp) icOnPartySearch(icState.partySearch);
  icRenderItems();
}
function icOnPartySearch(v){
  icState.partySearch = v;
  const box = document.getElementById('icPartyList'); if(!box) return;
  if(!(v || '').trim()){ box.innerHTML = ''; return; }   // 還沒輸入就不列出來,輸入後才搜尋
  const m = icPartyMatches(v);
  box.innerHTML = m.length
    ? m.map(p => `<div class="batch-link" style="padding:6px 4px;border-bottom:1px solid var(--line);cursor:pointer;" onclick="icPickParty('${invEsc(p.id)}')">${invEsc(icPartyLabel(p))}</div>`).join('')
    : `<div class="empty-note">${t('icNoParty')}</div>`;
}
function icPickParty(id){
  const changed = icState.partyId !== id;
  icState.partyId = id; icState.partySearch = '';
  if(changed && icState.items.length) icReprice();
  icRenderNew();
}
function icClearParty(){ icState.partyId = ''; icRenderNew(); }
function icAddParty(){ icState.awaitNewParty = (typeof shippingParties !== 'undefined' ? shippingParties.length : 0); openPartyEditModal(''); }
// parties.js 儲存出貨方之後呼叫:新增的出貨方直接選起來
function icOnPartiesChanged(newPartyId){
  if(newPartyId && icState.awaitNewParty !== undefined){ icState.partyId = newPartyId; icState.awaitNewParty = undefined; }
  if(document.getElementById('icBody') && icState.mode === 'new') icRenderNew();
}
function icResetNew(){ icState.partyId = ''; icState.partySearch = ''; icState.items = []; icState.note = ''; icRenderNew(); }

// 價格:現在的售價 × 出貨方折扣(跟訂單用同一套計算)
function icPriceFor(productId, qty){
  try{
    const fake = { partyId: icState.partyId, status: 'pending', items: [] };
    const pr = spPriceOrderItem(fake, { productId, qty: Number(qty) || 1 });
    if(pr && pr.unit !== null && pr.unit !== undefined && Number.isFinite(Number(pr.unit))) return { unit: Number(pr.unit), disc: Number(pr.discountPct) || 0 };
  }catch(e){}
  return { unit: null, disc: 0 };
}
function icReprice(){
  icState.items.forEach(it => { if(!it.custom && !it.priceEdited){ const p = icPriceFor(it.productId, it.qty); it.price = p.unit === null ? '' : p.unit; it.disc = p.disc; } });
}
function icRenderItems(){
  const box = document.getElementById('icItems'); if(!box) return;
  const its = icState.items;
  if(!its.length){ box.innerHTML = `<div class="empty-note">${t('icNoItems')}</div>`; return; }
  let sale = 0, tax = 0;
  const gstRate = (typeof SP_GST_RATE !== 'undefined') ? SP_GST_RATE : 0.10;
  const rows = its.map((it, i) => {
    const amt = icR2((Number(it.price) || 0) * (Number(it.qty) || 0)); sale += amt; if(it.gst) tax += icR2(amt * gstRate);
    return `<tr>
      <td>${invEsc(it.desc)}${it.sku ? `<div style="font-size:11px;color:var(--ink-soft);">${invEsc(it.sku)}</div>` : ''}</td>
      <td><input type="number" min="0" step="any" value="${invEsc(it.qty)}" style="width:70px;" oninput="icEditItem(${i},'qty',this.value)" /> ${invEsc(it.unit || '')}</td>
      <td><input type="number" min="0" step="0.01" value="${it.price === '' ? '' : invEsc(it.price)}" placeholder="0.00" style="width:90px;" oninput="icEditItem(${i},'price',this.value)" /></td>
      <td class="num" id="icAmt${i}">${invMoney2(amt)}</td>
      <td><span class="del-link" onclick="icRemoveItem(${i})">✕</span></td></tr>`;
  }).join('');
  box.innerHTML = `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('icColItem')}</th><th>${t('icColQty')}</th><th>${t('icColPrice')}</th><th class="num">${t('icColAmount')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div id="icTotals" style="text-align:right;font-size:13px;margin-top:6px;"></div>`;
  icRenderTotals();
}
function icRenderTotals(){
  const el = document.getElementById('icTotals'); if(!el) return;
  const gstRate = (typeof SP_GST_RATE !== 'undefined') ? SP_GST_RATE : 0.10;
  let sale = 0, tax = 0;
  icState.items.forEach((it, i) => {
    const amt = icR2((Number(it.price) || 0) * (Number(it.qty) || 0)); sale += amt; if(it.gst) tax += icR2(amt * gstRate);
    const c = document.getElementById('icAmt' + i); if(c) c.textContent = invMoney2(amt);
  });
  el.innerHTML = `${t('spSaleAmt')}: ${invMoney2(sale)} · ${t('spGstAmt')}: ${invMoney2(tax)} · <b>${t('spTotalAmt')}: ${invMoney2(sale + tax)}</b>`;
}
function icEditItem(i, k, v){
  const it = icState.items[i]; if(!it) return;
  if(k === 'gst') it.gst = !!v;
  else if(k === 'price'){ it.price = v === '' ? '' : Number(v); it.priceEdited = true; }
  else it.qty = v === '' ? '' : Number(v);
  if(k === 'qty' && !it.custom && !it.priceEdited){ const p = icPriceFor(it.productId, it.qty); it.price = p.unit === null ? '' : p.unit; it.disc = p.disc; icRenderItems(); return; }
  icRenderTotals();
}
function icRemoveItem(i){ icState.items.splice(i, 1); icRenderItems(); }

// ---------- 挑商品 ----------
function icCloseOverlay(id){ const o = document.getElementById(id); if(o) o.remove(); }
function icOpenProductPicker(){
  if(!icState.partyId){ showInfoModal(t('icNeedPartyFirst')); return; }
  icCloseOverlay('icPickOverlay');
  const ov = document.createElement('div');
  ov.id = 'icPickOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1200';
  ov.onclick = e => { if(e.target === ov) icCloseOverlay('icPickOverlay'); };
  const cats = (typeof categoryOrder !== 'undefined' ? categoryOrder : []).map(c => `<option value="${invEsc(c)}" ${c === icPickCat ? 'selected' : ''}>${invEsc(catLabel(c))}</option>`).join('');
  ov.innerHTML = `<div class="modal-box" style="max-width:min(560px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('icAddProduct')}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
      <select id="icPickCat" onchange="icPickCat=this.value;icRenderPickList()"><option value="">${t('icAllCategories')}</option>${cats}</select>
      <input id="icPickQ" type="text" placeholder="${invEsc(t('icProductSearchPh'))}" value="${invEsc(icPickQ)}" oninput="icPickQ=this.value;icRenderPickList()" style="flex:1;min-width:140px;" autocomplete="off" />
    </div>
    <div id="icPickList" style="max-height:55vh;overflow:auto;"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="icCloseOverlay('icPickOverlay')">${t('btnClose')}</button></div>
  </div>`;
  document.body.appendChild(ov);
  icRenderPickList();
}
function icRenderPickList(){
  const box = document.getElementById('icPickList'); if(!box) return;
  const q = (icPickQ || '').trim().toLowerCase();
  const list = (typeof products !== 'undefined' ? products : []).filter(p => !p.hidden
    && (!icPickCat || (p.category || '未分類') === icPickCat)
    && (!q || [p.name, p.sku].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 80);
  if(!list.length){ box.innerHTML = `<div class="empty-note">${t('icNoProducts')}</div>`; return; }
  box.innerHTML = list.map(p => {
    const pr = icPriceFor(p.id, 1);
    const added = icState.items.some(x => x.productId === p.id);
    return `<div style="display:flex;gap:8px;align-items:center;padding:6px 2px;border-bottom:1px solid var(--line);${added ? 'opacity:.55;' : ''}">
      <div style="flex:1;min-width:0;"><div>${invEsc(p.name)}</div><div style="font-size:11px;color:var(--ink-soft);">${invEsc(p.sku || '')} · ${invEsc(p.unit || '')}</div></div>
      <div style="white-space:nowrap;font-size:12.5px;">${pr.unit === null ? '–' : invMoney2(pr.unit)}</div>
      <button class="btn ghost" ${added ? 'disabled' : ''} onclick="icAddProduct('${invEsc(p.id)}')">${added ? '✓' : '＋'}</button>
    </div>`;
  }).join('');
}
function icAddProduct(pid){
  const p = (typeof products !== 'undefined' ? products : []).find(x => x.id === pid); if(!p) return;
  if(icState.items.some(x => x.productId === pid)) return;
  const pr = icPriceFor(pid, 1);
  icState.items.push({ productId: pid, sku: p.sku || '', desc: p.name, unit: p.unit || '', qty: 1, price: pr.unit === null ? '' : pr.unit, disc: pr.disc, gst: !!p.gst, custom: false });
  icRenderPickList(); icRenderItems();
}
function icOpenCustomItem(){
  icCloseOverlay('icCustomOverlay');
  const ov = document.createElement('div');
  ov.id = 'icCustomOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1200';
  ov.innerHTML = `<div class="modal-box" style="max-width:380px;">
    <div class="section-title" style="margin-top:0;">${t('icAddCustom')}</div>
    <label style="font-size:12px;">${t('icColItem')}</label><input id="icCuName" type="text" style="width:100%;box-sizing:border-box;margin-bottom:8px;" />
    <div style="display:flex;gap:8px;">
      <div style="flex:1;"><label style="font-size:12px;">${t('icColQty')}</label><input id="icCuQty" type="number" min="0" step="any" value="1" style="width:100%;box-sizing:border-box;" /></div>
      <div style="flex:1;"><label style="font-size:12px;">${t('icColPrice')}</label><input id="icCuPrice" type="number" step="0.01" placeholder="0.00" style="width:100%;box-sizing:border-box;" /></div>
    </div>
    <label style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:13px;"><input id="icCuGst" type="checkbox" checked /> GST</label>
    <div id="icCuMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="icCloseOverlay('icCustomOverlay')">${t('btnCancel')}</button><button class="btn" onclick="icSaveCustom()">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
  const n = document.getElementById('icCuName'); if(n) n.focus();
}
function icSaveCustom(){
  const name = document.getElementById('icCuName').value.trim();
  const qty = Number(document.getElementById('icCuQty').value);
  const priceRaw = document.getElementById('icCuPrice').value;
  const msg = document.getElementById('icCuMsg');
  if(!name || !(qty > 0) || priceRaw === '' || !Number.isFinite(Number(priceRaw))){ msg.className = 'msg error'; msg.textContent = t('icCustomBad'); return; }
  icState.items.push({ productId: '', sku: '', desc: name, unit: '', qty, price: Number(priceRaw), disc: 0, gst: document.getElementById('icCuGst').checked, custom: true });
  icCloseOverlay('icCustomOverlay'); icRenderItems();
}

// ---------- 組出 Invoice 內容 ----------
// 共用的表頭(公司、銀行、客戶、付款條件);lines 之後再補
function icSnapHeader(sp, nameFallback){
  const payType = sp && sp.paymentType === 'cod' ? 'cod' : 'bank';
  const term = payType === 'cod' ? 0 : (sp && Number(sp.paymentTerm) > 0 ? Number(sp.paymentTerm) : 7);
  const today = (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0, 10);
  const name = (sp && (sp.companyName || sp.name)) || nameFallback || '';
  return {
    no: '', date: today, dueDate: invAddDays(today, term), paymentType: payType, term,
    saleRep: (typeof userDisplayName === 'function' && currentUser) ? userDisplayName(currentUser) : '',
    company: { name: invSettings.companyName, abn: invSettings.abn, address: invSettings.address, phone: invSettings.phone, email: invSettings.email, website: invSettings.website },
    bank: { bankName: invSettings.bankName, accName: invSettings.bankAccName, bsb: invSettings.bsb, accNo: invSettings.accNo },
    customer: { name, billTo: (sp && sp.billTo) || '', email: (sp && sp.email) || '', abn: (sp && sp.abn) || '' },
    ship: { name, address: (sp && (sp.shipTo !== undefined ? sp.shipTo : sp.address)) || '', contact: (sp && sp.contactPerson) || '' },
    paid: 0, filtered: true,
    currency: (typeof getSystemCurrency === 'function') ? getSystemCurrency() : 'AUD'
  };
}
function icFinishTotals(snap){
  snap.beforeTax = icR2(snap.lines.reduce((s, l) => s + l.amount, 0));
  snap.tax = icR2(snap.lines.reduce((s, l) => s + l.tax, 0));
  snap.total = icR2(snap.beforeTax + snap.tax);
  return snap;
}
function icPreviewNew(){
  const msg = document.getElementById('icMsg');
  const bad = k => { if(msg){ msg.className = 'msg error'; msg.textContent = t(k); } };
  if(!invSettingsComplete()){ showInfoModal(t('invNeedSettings')); return; }
  const sp = icParty(icState.partyId);
  if(!sp) return bad('icNeedParty');
  if(!icState.items.length) return bad('icNeedItems');
  const gstRate = (typeof SP_GST_RATE !== 'undefined') ? SP_GST_RATE : 0.10;
  const lines = [];
  for(const it of icState.items){
    const qty = Number(it.qty), price = Number(it.price);
    if(!(qty > 0) || it.price === '' || !Number.isFinite(price)) return bad('icBadLine');
    const disc = it.disc > 0 && it.disc < 100 && !it.priceEdited ? it.disc : 0;
    const listPrice = disc > 0 ? icR2(price / (1 - disc / 100)) : price;
    const amount = icR2(price * qty);
    lines.push({ n: lines.length + 1, desc: it.desc, sku: it.sku || '', comment: '', qty, unit: it.unit || '', price: listPrice, disc, amount, tax: it.gst ? icR2(amount * gstRate) : 0 });
  }
  const snap = Object.assign(icSnapHeader(sp), { note: icState.note || '', orderNo: '', lines });
  icFinishTotals(snap);
  invShowModal(null, snap, false, { orders: [], partyId: sp.id, manual: true });
}

// ---------- 合併訂單 ----------
// 把多張訂單各自的 Invoice 內容合併:相同品項(SKU + 名稱 + 單價 + 折扣)的數量與金額加總,Note 列出訂單編號
function icMergeSnaps(snaps, orderNos){
  const base = Object.assign({}, snaps[0]);
  const map = new Map();
  snaps.forEach(s => (s.lines || []).forEach(l => {
    const k = [l.sku || '', l.desc || '', l.price, l.disc || 0, l.unit || ''].join('|');
    const ex = map.get(k);
    if(ex){ ex.qty = icR2(Number(ex.qty) + Number(l.qty)); ex.amount = icR2(ex.amount + l.amount); ex.tax = icR2(ex.tax + l.tax); }
    else map.set(k, Object.assign({}, l));
  }));
  base.lines = Array.from(map.values()).map((l, i) => Object.assign(l, { n: i + 1 }));
  base.note = orderNos.length > 1 ? `Orders: ${orderNos.join(', ')}` : (snaps[0].note || '');
  base.orderNo = orderNos.join(', ');
  return icFinishTotals(base);
}

// ---------- Generate from Order ----------
function icOrderRows(){
  const f = icState.of;
  const q = (f.q || '').trim().toLowerCase();
  return (orders || []).filter(o => {
    if(o.deleted) return false;
    const st = orderStatus(o);
    if(f.status === 'pending' && st === 'confirmed') return false;
    if(f.status === 'completed' && st !== 'confirmed') return false;
    if(f.partyId && o.partyId !== f.partyId) return false;
    const d = o.date || '';
    if(f.from && d < f.from) return false;
    if(f.to && d > f.to) return false;
    if(q && ![o.orderNo, o.partyName].join(' ').toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || ''))).slice(0, 300);
}
function icRenderOrder(){
  const host = document.getElementById('icBody'); if(!host) return;
  const f = icState.of;
  const partyOpts = (typeof shippingParties !== 'undefined' ? shippingParties : []).filter(p => !p.deleted).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(p => `<option value="${invEsc(p.id)}" ${f.partyId === p.id ? 'selected' : ''}>${invEsc(icPartyLabel(p))}</option>`).join('');
  const stOpt = (v, l) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`;
  host.innerHTML = `
    <div class="settings-card" style="margin-bottom:10px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <div><div style="font-size:11px;color:var(--ink-soft);">${t('invFltStatus')}</div><select onchange="icOf('status',this.value)">${stOpt('pending', t('icStPending'))}${stOpt('completed', t('icStCompleted'))}${stOpt('all', t('icStAll'))}</select></div>
        <div><div style="font-size:11px;color:var(--ink-soft);">${t('icFrom')}</div><input type="date" value="${invEsc(f.from)}" onchange="icOf('from',this.value)" /></div>
        <div><div style="font-size:11px;color:var(--ink-soft);">${t('icTo')}</div><input type="date" value="${invEsc(f.to)}" onchange="icOf('to',this.value)" /></div>
        <div><div style="font-size:11px;color:var(--ink-soft);">${t('icFieldParty')}</div><select onchange="icOf('partyId',this.value)"><option value="">${t('invFltAll')}</option>${partyOpts}</select></div>
        <div style="flex:1;min-width:140px;"><div style="font-size:11px;color:var(--ink-soft);">${t('invFltSearch')}</div><input type="text" value="${invEsc(f.q)}" placeholder="${invEsc(t('icOrderSearchPh'))}" oninput="icState.of.q=this.value;icRenderOrderList()" style="width:100%;box-sizing:border-box;" /></div>
      </div>
    </div>
    <div id="icOrderList"></div>
    <div id="icMsg" class="msg"></div>
    <div id="icGenBar"></div>`;
  icRenderOrderList();
}
function icOf(k, v){ icState.of[k] = v; icState.sel = new Set(); icRenderOrder(); }
function icSelParty(){
  const first = Array.from(icState.sel)[0];
  const o = first ? orders.find(x => x.id === first) : null;
  return o ? (o.partyId || '') : null;
}
function icRenderOrderList(){
  const box = document.getElementById('icOrderList'); if(!box) return;
  const rows = icOrderRows();
  const lockParty = icSelParty();
  const body = rows.map(o => {
    const linked = !!o.invoice;
    const otherParty = lockParty !== null && (o.partyId || '') !== lockParty;
    const dis = linked || otherParty;
    const st = orderStatus(o);
    const stLabel = o.deleted ? t('statusOrderCancelled') : (st === 'confirmed' ? t('statusCompleted') : (st === 'processing' ? t('statusProcessing') : t('statusPending')));
    const n = (o.items || []).filter(it => !it.deleted).length;
    return `<tr style="${dis ? 'opacity:.5;' : ''}">
      <td><input type="checkbox" ${icState.sel.has(o.id) ? 'checked' : ''} ${dis ? 'disabled' : ''} onchange="icToggleOrder('${invEsc(o.id)}',this.checked)" /></td>
      <td style="white-space:nowrap;">${invEsc(o.orderNo || '')}</td><td style="white-space:nowrap;">${invEsc(o.date || '')}</td>
      <td>${invEsc(o.partyName || '')}</td><td>${invEsc(stLabel)}</td><td class="num">${n}</td>
      <td style="white-space:nowrap;">${linked ? `${invEsc(t('invLinkedLabel'))} INV${invEsc(o.invoice.no || '')}` : ''}</td></tr>`;
  }).join('');
  box.innerHTML = rows.length
    ? `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th></th><th>${t('invColOrder')}</th><th>${t('icColDate')}</th><th>${t('icFieldParty')}</th><th>${t('invFltStatus')}</th><th class="num">${t('icColItems')}</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="empty-note">${t('icNoOrders')}</div>`;
  const bar = document.getElementById('icGenBar');
  if(bar) bar.innerHTML = `<div style="margin-top:8px;"><button class="btn" ${icState.sel.size ? '' : 'disabled'} onclick="icGenerateFromOrders()">${tf('icBtnGenerate', { n: icState.sel.size })}</button></div>`;
}
function icToggleOrder(id, on){ if(on) icState.sel.add(id); else icState.sel.delete(id); icRenderOrderList(); }
function icGenerateFromOrders(){
  const msg = document.getElementById('icMsg');
  const fail = html => { if(msg){ msg.className = 'msg error'; msg.textContent = html; } };
  if(!invSettingsComplete()){ showInfoModal(t('invNeedSettings')); return; }
  const picked = Array.from(icState.sel).map(id => orders.find(o => o.id === id)).filter(Boolean);
  if(!picked.length) return;
  if(picked.some(o => o.invoice)) return fail(t('icOrderLinked'));
  if(new Set(picked.map(o => o.partyId || '')).size > 1) return fail(t('icMixedParty'));
  const snaps = [];
  for(const o of picked){
    const r = invBuildSnapshot(o);
    if(!r.ok){
      if(r.reason === 'price') return fail(`${o.orderNo || ''}: ` + tf('invNoPrice', { names: r.names.slice(0, 8).join(', ') + (r.names.length > 8 ? '…' : '') }));
      return fail(`${o.orderNo || ''}: ` + t(r.reason === 'settings' ? 'invNeedSettings' : 'invNoItems'));
    }
    snaps.push(r.snap);
  }
  const nos = picked.map(o => o.orderNo || '').filter(Boolean);
  const snap = snaps.length === 1 ? snaps[0] : icMergeSnaps(snaps, nos);
  const links = picked.map(o => ({ id: o.id, no: o.orderNo || '' }));
  if(msg){ msg.className = 'msg'; msg.textContent = ''; }
  invShowModal(picked.length === 1 ? picked[0].id : null, snap, false, { orders: links, partyId: picked[0].partyId || '', manual: false });
}

// ---------- 真的建立(按下 Save PDF / Print 才建立)----------
async function invEnsureCreatedMulti(){
  const link = invModal.link;
  const msg = document.getElementById('invModalMsg');
  const fail = key => { if(msg){ msg.className = 'msg error'; msg.textContent = t(key); } return null; };
  const snap0 = Object.assign({}, invModal.snap);
  snap0.date = (typeof todayISO === 'function') ? todayISO() : snap0.date;
  snap0.dueDate = invAddDays(snap0.date, snap0.term || 0);
  snap0.saleRep = (typeof userDisplayName === 'function' && currentUser) ? userDisplayName(currentUser) : snap0.saleRep;
  snap0.createdAt = new Date().toISOString();
  snap0.orders = link.orders;
  const objs = link.orders.map(o => orders.find(x => x.id === o.id)).filter(Boolean);
  if(objs.some(o => o.invoice)) return fail('invAlreadyExists');
  try{
    const { data, error } = await sb.rpc('invoice_create_multi', { p_snapshot: snap0, p_orders: link.orders, p_party_id: link.partyId || '' });
    if(error) throw error;
    invDbMode = 'table';
    const snap = Object.assign({}, snap0, { no: data.invoice_no, id: data.id });
    objs.forEach(o => { o.invoice = { id: data.id, no: data.invoice_no, date: snap.date }; });
    try{ if(objs.length) await upsertOrders(objs); }
    catch(e){ console.error('Invoice 已建立,但訂單連結儲存失敗', e); }
    invModal.snap = snap; invModal.created = true;
    try{ logInventoryAction('order_edit', `Invoice created: ${snap.no} (${snap.customer && snap.customer.name}${snap.orderNo ? ', orders ' + snap.orderNo : ''})`, snap.orderNo || ''); }catch(e){}
    invList = [];
    try{ renderOrders(); }catch(e){}
    icState.sel = new Set();
    if(icState.mode === 'order' && document.getElementById('icOrderList')) icRenderOrderList();
    if(link.manual){ icState.items = []; icState.note = ''; icState.partyId = ''; }
    return snap;
  }catch(e){
    console.error('建立 Invoice 失敗', e);
    if(/invoice_exists/.test((e && e.message) || '')) return fail('invAlreadyExists');
    if(/invoice_forbidden/.test((e && e.message) || '')) return fail('invForbidden');
    if(invIsMissingFn(e)) return fail('icNeedSql');
    return fail('invCreateFailed');
  }
}

// 「隱藏 Invoice 功能」切換時
function icApplyVisibility(){
  const off = typeof hideInvoiceEnabled !== 'undefined' && hideInvoiceEnabled;
  const sel = document.getElementById('accountingSubtabSelect');
  if(sel){
    const o = Array.from(sel.options).find(x => x.value === 'subtab-acc-create-invoice');
    if(o) o.hidden = off, o.disabled = off;
  }
  if(off){ try{ icCloseOverlay('icPickOverlay'); icCloseOverlay('icCustomOverlay'); }catch(e){} }
}
