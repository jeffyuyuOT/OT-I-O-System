// ============================================================
// 會計分頁 → 開立發票 (Create Invoice)
//   · New Invoice:選出貨方、挑商品(分類 + 搜尋,價格自動帶入)或自訂品項,直接開一張沒有訂單的 Invoice
//   · Generate from Order:挑一張或多張訂單(待處理 / 已完成 / 全部,可依日期、出貨方篩選),合併成一張 Invoice
// 需要先執行 sql/invoice_orders.sql。整頁受「隱藏 Invoice 功能」控制。
// ============================================================
const icState = {
  mode: 'new',                 // 'new' | 'order' | 'cnNew' | 'cnInvoice'
  cnInv: null,                 // 從 Invoice 產生 Credit Note 時選到的 Invoice { id, no, snap }
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
function icIsCn(){ return icState.mode === 'cnNew' || icState.mode === 'cnInvoice'; }
function icSetMode(m){
  if(m !== icState.mode && m !== 'order' && icState.mode !== 'order'){ icState.partyId = ''; icState.partySearch = ''; icState.items = []; icState.note = ''; icState.cnInv = null; }
  icState.mode = m; icRender();
}
function icRender(){
  const root = document.getElementById('invoiceCreateRoot');
  if(!root) return;
  if(!icOk()){ root.innerHTML = ''; return; }
  const tab = (m, label, on) => `<button class="btn ${on ? '' : 'ghost'}" onclick="icSetMode('${m}')">${label}</button>`;
  const isCnMode = icIsCn(), md = icState.mode;
  // 第一層:先選 Invoice 或 Credit Note;第二層:新增 / 從訂單(或 Invoice)產生
  const top = `<select onchange="icSetMode(this.value)" style="min-width:260px;font-size:15px;padding:6px 8px;"><option value="${isCnMode ? 'new' : md}" ${!isCnMode ? 'selected' : ''}>${t('icDocInvoice')}</option><option value="${isCnMode ? md : 'cnNew'}" ${isCnMode ? 'selected' : ''}>${t('icDocCn')}</option></select>`;
  const sub = isCnMode
    ? tab('cnNew', t('icSubNew'), md === 'cnNew') + tab('cnInvoice', t('icModeCnInvoice'), md === 'cnInvoice')
    : tab('new', t('icSubNew'), md === 'new') + tab('order', t('icModeOrder'), md === 'order');
  root.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${top}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;padding-left:10px;border-left:3px solid var(--line);">${sub}</div><div id="icBody"></div>`;
  if(icState.mode === 'order') icRenderOrder(); else icRenderNew();
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
  const cn = icIsCn(), fromInv = icState.mode === 'cnInvoice';
  const partyBlock = fromInv ? icInvoiceBlock() : sp
    ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${hasCapability('cap-manage-parties') ? `<b class="batch-link" style="cursor:pointer;" title="${invEsc(t('icEditPartyTip'))}" onclick="openPartyEditModal('${invEsc(sp.id)}')">${invEsc(icPartyLabel(sp))}</b>` : `<b>${invEsc(icPartyLabel(sp))}</b>`}<span class="del-link" onclick="icClearParty()">${t('icChangeParty')}</span></div>`
    : `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
         <input id="icPartyInput" type="text" placeholder="${invEsc(t('icPartySearchPh'))}" value="${invEsc(icState.partySearch)}" oninput="icOnPartySearch(this.value)" style="flex:1;min-width:200px;" autocomplete="off" />
         ${hasCapability('cap-manage-parties') ? `<button class="btn ghost" onclick="icAddParty()">＋ ${t('icAddParty')}</button>` : ''}
       </div>
       <div id="icPartyList" style="margin-top:6px;max-height:220px;overflow:auto;"></div>`;
  host.innerHTML = `
    <div class="settings-card" style="margin-bottom:10px;">
      <div class="section-title" style="margin-top:0;">${fromInv ? t('icFieldInvoice') : t('icFieldParty')}</div>
      ${partyBlock}
    </div>
    <div class="settings-card" style="margin-bottom:10px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        <div class="section-title" style="margin:0;flex:1;">${t('icFieldItems')}</div>
        ${fromInv && icState.cnInv ? `<button class="btn ghost" onclick="icOpenInvoiceItems()">${t('icPickFromInvoice')}</button>` : ''}
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
    <div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn" onclick="icPreviewNew()">${cn ? t('icBtnPreviewCn') : t('icBtnPreview')}</button><button class="btn ghost" onclick="icResetNew()">${t('icBtnReset')}</button></div>`;
  if(!sp && !fromInv) icOnPartySearch(icState.partySearch);
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
  if(document.getElementById('icBody') && icState.mode === 'new'){ icReprice(); icRenderNew(); }   // 折扣改了:重新計算沒手動改過價的品項
}
function icResetNew(){ icState.partyId = ''; icState.partySearch = ''; icState.items = []; icState.note = ''; icState.cnInv = null; icRenderNew(); }

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
      <td><input type="number" min="0" ${it.maxQty ? `max="${it.maxQty}"` : ''} step="any" value="${invEsc(it.qty)}" style="width:70px;" oninput="icEditItem(${i},'qty',this.value)" /> ${invEsc(it.unit || '')}</td>
      <td><input type="number" min="0" step="0.01" value="${it.price === '' ? '' : invEsc(it.price)}" placeholder="0.00" style="width:90px;" oninput="icEditItem(${i},'price',this.value)" /></td>
      ${icIsCn() ? `<td style="text-align:center;"><input type="checkbox" ${it.ret ? 'checked' : ''} ${it.custom || it.noRet ? 'disabled' : ''} onchange="icEditItem(${i},'ret',this.checked)" /></td>` : ''}
      <td class="num" id="icAmt${i}">${invMoney2(amt)}</td>
      <td><span class="del-link" onclick="icRemoveItem(${i})">✕</span></td></tr>`;
  }).join('');
  box.innerHTML = `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('icColItem')}</th><th>${t('icColQty')}</th><th>${t('icColPrice')}</th>${icIsCn() ? `<th>${t('icColReturn')}</th>` : ''}<th class="num">${t('icColAmount')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
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
  else if(k === 'ret') it.ret = !!v;
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
  icState.items.push({ productId: pid, sku: p.sku || '', desc: p.name, unit: p.unit || '', qty: 1, price: pr.unit === null ? '' : pr.unit, disc: pr.disc, gst: !!p.gst, custom: false, ret: icIsCn() });
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
  icState.items.push({ productId: '', sku: '', desc: name, unit: '', qty, price: Number(priceRaw), disc: 0, gst: document.getElementById('icCuGst').checked, custom: true, ret: false });
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
  if(icIsCn()) return icPreviewCn();
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
  if(link.kind === 'credit_note') return await icEnsureCreatedCn();
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
    const o2 = Array.from(sel.options).find(x => x.value === 'subtab-acc-credit-notes');
    if(o2) o2.hidden = off, o2.disabled = off;
  }
  if(off){ try{ icCloseOverlay('icPickOverlay'); icCloseOverlay('icCustomOverlay'); icCloseOverlay('icInvItemsOverlay'); icCloseOverlay('icCnStatusOverlay'); const w = document.getElementById('txCnWrap'); if(w) w.style.display = 'none'; }catch(e){} }
}

// ============================================================
// Credit Note(貸項通知單)
//   · New Credit Note:選客戶、挑商品 / 自訂品項,單獨記在該客戶名下(不連 Invoice)
//   · Generate from Invoice:選一張 Invoice,在視窗裡挑要退 / 調整的品項(數量可改),也可以再加品項;連到原 Invoice 並扣減它的未收金額
//   · 每個品項可以勾「退貨入庫」:有勾的 Credit Note 帶「待入庫」狀態,在登記進出貨做退貨入庫時選對應的 Credit Note
// 只是帳務文件,不動庫存。需要先執行 sql/credit_notes.sql。
// ============================================================
function icInvoiceBlock(){
  const ci = icState.cnInv;
  if(ci){
    const r = ci.row || {};
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><b>INV${invEsc(ci.no)}</b><span>${invEsc(r.customer || (ci.snap && ci.snap.customer && ci.snap.customer.name) || '')}</span><span style="color:var(--ink-soft);font-size:12px;">${invEsc(invIsoToDmy(r.invoice_date || ''))} · ${invMoney2(r.total !== undefined ? r.total : (ci.snap && ci.snap.total))}</span><span class="del-link" onclick="icClearInvoice()">${t('icChangeParty')}</span></div>`;
  }
  return `<input id="icInvInput" type="text" placeholder="${invEsc(t('icInvSearchPh'))}" oninput="icOnInvSearch(this.value)" style="width:100%;box-sizing:border-box;" autocomplete="off" />
    <div id="icInvList" style="margin-top:6px;max-height:240px;overflow:auto;"></div>`;
}
async function icOnInvSearch(v){
  const box = document.getElementById('icInvList'); if(!box) return;
  const q = (v || '').trim().toLowerCase();
  if(!q){ box.innerHTML = ''; return; }
  await invLoadList();
  const m = (invList || []).filter(r => ['INV' + (r.invoice_no || ''), r.invoice_no, invCustSearch(r), r.order_no].join(' ').toLowerCase().includes(q)).slice(0, 12);
  box.innerHTML = m.length
    ? m.map(r => `<div class="batch-link" style="padding:6px 4px;border-bottom:1px solid var(--line);cursor:pointer;" onclick="icPickInvoice('${invEsc(r.id)}')">INV${invEsc(r.invoice_no)} · ${invEsc(invCustLabel(r))} · ${invEsc(invIsoToDmy(r.invoice_date))} · ${invMoney2(r.total)}</div>`).join('')
    : `<div class="empty-note">${t('icNoInvoice')}</div>`;
}
function icClearInvoice(){ icState.cnInv = null; icState.items = []; icState.partyId = ''; icRenderNew(); }
async function icPickInvoice(id){
  try{
    const row = (invList || []).find(r => r.id === id);
    const snap = await invFetchSnapshot(id);
    if(!row || !snap) throw new Error('not found');
    icState.cnInv = { id, no: row.invoice_no, snap, row };
    icState.partyId = row.party_id || '';
    icState.items = [];
    icRenderNew();
    icOpenInvoiceItems();
  }catch(e){ console.error('讀取 Invoice 失敗', e); showInfoModal(t('invLoadFailed')); }
}
// 挑品項的視窗:勾選要放進 Credit Note 的品項、改數量、決定要不要「退貨入庫」
function icOpenInvoiceItems(){
  const ci = icState.cnInv; if(!ci) return;
  icCloseOverlay('icInvItemsOverlay');
  const lines = (ci.snap.lines || []);
  const have = new Map(icState.items.filter(x => x.fromInv).map(x => [x.srcKey, x]));
  const ov = document.createElement('div');
  ov.id = 'icInvItemsOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1200';
  const rows = lines.map((l, i) => {
    const cur = have.get(i);
    const canRet = !!icFindProduct(l);
    return `<tr>
      <td><input type="checkbox" id="icIiSel${i}" ${cur ? 'checked' : ''} /></td>
      <td>${invEsc(l.desc)}${l.sku ? `<div style="font-size:11px;color:var(--ink-soft);">${invEsc(l.sku)}</div>` : ''}</td>
      <td class="num">${invFmtQty(l.qty)}</td>
      <td><input type="number" id="icIiQty${i}" min="0" max="${invEsc(l.qty)}" step="any" value="${invEsc(cur ? cur.qty : l.qty)}" style="width:70px;" /></td>
      <td class="num">${invMoney2(l.qty > 0 ? l.amount / l.qty : l.price)}</td>
      <td style="text-align:center;"><input type="checkbox" id="icIiRet${i}" ${cur ? (cur.ret ? 'checked' : '') : (canRet ? 'checked' : '')} ${canRet ? '' : 'disabled'} /></td></tr>`;
  }).join('');
  ov.innerHTML = `<div class="modal-box" style="max-width:min(720px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('icPickFromInvoice')} · INV${invEsc(ci.no)}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${t('icInvItemsHint')}</p>
    <div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th></th><th>${t('icColItem')}</th><th class="num">${t('icColInvQty')}</th><th>${t('icColCnQty')}</th><th class="num">${t('icColPrice')}</th><th>${t('icColReturn')}</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div id="icIiMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="icCloseOverlay('icInvItemsOverlay')">${t('btnCancel')}</button><button class="btn" onclick="icApplyInvoiceItems()">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function icFindProduct(l){
  const ps = (typeof products !== 'undefined' ? products : []);
  return (l.sku && ps.find(p => p.sku === l.sku)) || ps.find(p => p.name === l.desc) || null;
}
function icApplyInvoiceItems(){
  const ci = icState.cnInv; if(!ci) return;
  const msg = document.getElementById('icIiMsg');
  const picked = [];
  for(let i = 0; i < (ci.snap.lines || []).length; i++){
    if(!document.getElementById('icIiSel' + i).checked) continue;
    const l = ci.snap.lines[i];
    const qty = Number(document.getElementById('icIiQty' + i).value);
    if(!(qty > 0) || qty > Number(l.qty) + 0.0001){ msg.className = 'msg error'; msg.textContent = t('icInvItemsBad'); return; }
    const p = icFindProduct(l);
    picked.push({ fromInv: true, srcKey: i, productId: p ? p.id : '', sku: l.sku || '', desc: l.desc, unit: l.unit || '', qty, maxQty: Number(l.qty),
      price: icR2(l.qty > 0 ? l.amount / l.qty : l.price), disc: 0, gst: Number(l.tax) > 0, custom: false, priceEdited: true, noRet: !p,
      ret: !!(p && document.getElementById('icIiRet' + i).checked) });
  }
  icState.items = picked.concat(icState.items.filter(x => !x.fromInv));
  icCloseOverlay('icInvItemsOverlay');
  icRenderNew();
}

function icPreviewCn(){
  const msg = document.getElementById('icMsg');
  const bad = k => { if(msg){ msg.className = 'msg error'; msg.textContent = t(k); } };
  if(!invSettingsComplete()){ showInfoModal(t('invNeedSettings')); return; }
  const fromInv = icState.mode === 'cnInvoice';
  const ci = icState.cnInv;
  if(fromInv && !ci) return bad('icNeedInvoice');
  const sp = icParty(icState.partyId);
  if(!fromInv && !sp) return bad('icNeedParty');
  if(!icState.items.length) return bad('icNeedItems');
  const gstRate = (typeof SP_GST_RATE !== 'undefined') ? SP_GST_RATE : 0.10;
  const lines = [];
  for(const it of icState.items){
    const qty = Number(it.qty), price = Number(it.price);
    if(!(qty > 0) || it.price === '' || !Number.isFinite(price) || price < 0) return bad('icBadLine');
    if(it.maxQty && qty > it.maxQty + 0.0001) return bad('icInvItemsBad');
    const amount = icR2(price * qty);
    lines.push({ n: lines.length + 1, desc: it.desc, sku: it.sku || '', comment: '', qty, unit: it.unit || '', price, disc: 0, amount, tax: it.gst ? icR2(amount * gstRate) : 0, productId: it.productId || '', ret: !!it.ret });
  }
  if(ci && ci.row){
    const remain = icR2(Number(ci.row.total) - Number(ci.row.credited || 0));
    const thisTotal = icR2(lines.reduce((a, l) => a + l.amount + l.tax, 0));
    if(thisTotal > remain + 0.004) return bad('icCreditExceeds');   // 不能比這張 Invoice 剩下的金額還多
  }
  const head = icSnapHeader(sp, ci && ci.snap && ci.snap.customer ? ci.snap.customer.name : '');
  if(ci && ci.snap){ head.customer = ci.snap.customer || head.customer; head.ship = ci.snap.ship || head.ship; }
  const snap = Object.assign(head, { docType: 'credit_note', invoiceNo: ci ? ci.no : '', invoiceId: ci ? ci.id : '', note: icState.note || '', orderNo: '', lines, paymentType: '', term: 0, dueDate: '' });
  icFinishTotals(snap);
  invShowModal(null, snap, false, { kind: 'credit_note', invoiceId: ci ? ci.id : '', partyId: (ci && ci.row && ci.row.party_id) || (sp ? sp.id : '') });
}
async function icEnsureCreatedCn(){
  const link = invModal.link;
  const msg = document.getElementById('invModalMsg');
  const fail = key => { if(msg){ msg.className = 'msg error'; msg.textContent = t(key); } return null; };
  const snap0 = Object.assign({}, invModal.snap);
  snap0.date = (typeof todayISO === 'function') ? todayISO() : snap0.date;
  snap0.saleRep = (typeof userDisplayName === 'function' && currentUser) ? userDisplayName(currentUser) : snap0.saleRep;
  snap0.createdAt = new Date().toISOString();
  try{
    const { data, error } = await sb.rpc('credit_note_create', { p_snapshot: snap0, p_invoice_id: link.invoiceId || null, p_party_id: link.partyId || '' });
    if(error) throw error;
    const snap = Object.assign({}, snap0, { no: data.cn_no, id: data.id });
    invModal.snap = snap; invModal.created = true;
    try{ logInventoryAction('order_edit', `Credit note created: ${snap.no} (${snap.customer && snap.customer.name}${snap.invoiceNo ? ', invoice ' + snap.invoiceNo : ''})`, ''); }catch(e){}
    invList = []; icCnRows = null;
    icState.items = []; icState.note = ''; icState.cnInv = null; if(icState.mode === 'cnInvoice') icState.partyId = '';
    if(document.getElementById('icBody') && icState.mode !== 'order') icRenderNew();
    return snap;
  }catch(e){
    console.error('建立 Credit Note 失敗', e);
    if(/invoice_forbidden/.test((e && e.message) || '')) return fail('invForbidden');
    if(/credit_exceeds/.test((e && e.message) || '')) return fail('icCreditExceeds');
    if(invIsMissingFn(e)) return fail('icNeedSqlCn');
    return fail('invCreateFailed');
  }
}

// ---------- Credit Note 清單 ----------
let icCnRows = null, icCnErr = '';
const icCnF = { q: '', from: '', to: '', st: '' };
let icCnUsedOn = {};   // credit_note id → [{id, no}](這張單獨 Credit Note 抵扣過的 Invoice)
async function icCnOpenList(force){
  if(!icOk()) return;
  const root = document.getElementById('creditNoteListRoot'); if(!root) return;
  if(force || icCnRows === null){
    root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
    try{
      const q = cols => sb.from('credit_notes').select(cols).order('cn_date', { ascending: false }).order('cn_no', { ascending: false }).limit(5000);
      const cols0 = 'id,cn_no,invoice_id,invoice_no,party_id,customer,cn_date,total,return_status,created_by';
      let { data, error } = await q(cols0 + ',applied');
      if(error && error.code === '42703') ({ data, error } = await q(cols0));   // 還沒執行客戶額度的 SQL:沒有 applied 欄
      if(error) throw error;
      icCnRows = data || []; icCnErr = '';
      // 單獨的 Credit Note:找出它的額度抵扣到哪些 Invoice(Invoice 欄顯示 linked INV…)
      icCnUsedOn = {};
      try{
        const ids = icCnRows.filter(r => !r.invoice_id).map(r => r.id);
        if(ids.length){
          const pr = await sb.from('invoice_payments').select('invoice_id,credit_cn_id').in('credit_cn_id', ids);
          const pays = pr.error ? [] : (pr.data || []);
          if(pays.length){
            const ir = await sb.from('invoices').select('id,invoice_no').in('id', [...new Set(pays.map(x => x.invoice_id))]);
            const nm = {}; (ir.data || []).forEach(x => { nm[x.id] = x.invoice_no; });
            pays.forEach(x => { const a = (icCnUsedOn[x.credit_cn_id] = icCnUsedOn[x.credit_cn_id] || []); if(!a.some(y => y.id === x.invoice_id)) a.push({ id: x.invoice_id, no: nm[x.invoice_id] }); });
          }
        }
      }catch(e){}
    }catch(e){ icCnRows = []; icCnErr = invIsMissingFn(e) || (e && e.code === '42P01') ? 'sql' : 'error'; if(icCnErr === 'error') console.error('讀取 Credit Note 清單失敗', e); }
  }
  icCnRender();
}
function icRsBadge(st){
  const col = { none: ['#eef0f3', '#555'], pending: ['#fff4dc', '#9a6a00'], partial: ['#e8f0fe', '#1a56b0'], done: ['#e7f6ec', '#1d7a3c'] }[st] || ['#eee', '#555'];
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;background:${col[0]};color:${col[1]};white-space:nowrap;">${invEsc(t('icRs_' + (st || 'none')))}</span>`;
}
function icCnRender(){
  const root = document.getElementById('creditNoteListRoot'); if(!root || !icOk()) return;
  if(icCnErr === 'sql'){ root.innerHTML = `<div class="empty-note">${t('icNeedSqlCn')}</div>`; return; }
  if(icCnErr){ root.innerHTML = `<div class="empty-note">${t('invLoadFailed')}</div>`; return; }
  const f = icCnF, q = f.q.trim().toLowerCase();
  const list = (icCnRows || []).filter(r => (!f.from || r.cn_date >= f.from) && (!f.to || r.cn_date <= f.to) && (!f.st || (r.return_status || 'none') === f.st)
    && (!q || [r.cn_no, invCustSearch(r), 'INV' + (r.invoice_no || ''), r.invoice_no].join(' ').toLowerCase().includes(q)));
  const sum = list.reduce((a, r) => a + (Number(r.total) || 0), 0);
  const availSum = list.reduce((a, r) => a + (r.invoice_id ? 0 : (Number(r.total) || 0) - (Number(r.applied) || 0)), 0);   // 單獨 Credit Note 的可用額度合計
  const stOpt = (v, l) => `<option value="${v}" ${f.st === v ? 'selected' : ''}>${l}</option>`;
  const body = list.map(r => `<tr>
      <td style="white-space:nowrap;cursor:pointer;" onclick="icCnView('${invEsc(r.id)}')"><span class="batch-link">${invEsc(r.cn_no)}</span></td>
      <td style="white-space:nowrap;">${invEsc(invIsoToDmy(r.cn_date))}</td><td>${invEsc(invCustLabel(r))}</td>
      <td>${r.invoice_id ? `<span class="batch-link" onclick="invOpenDetails('${invEsc(r.invoice_id)}')">INV${invEsc(r.invoice_no || '')}</span>` : ((icCnUsedOn[r.id] || []).length ? (icCnUsedOn[r.id]).map(x => `<div style="white-space:nowrap;"><span class="batch-link" onclick="invOpenDetails('${invEsc(x.id)}')">INV${invEsc(x.no || '')}</span></div>`).join('') : '–')}</td>
      <td class="num"><b>(${invMoney2(r.total)})</b></td>
      <td class="num">${r.invoice_id ? '–' : invMoney2(Number(r.total) - Number(r.applied || 0))}</td>
      <td style="white-space:nowrap;">${icRsBadge(r.return_status)}</td>
      <td style="white-space:nowrap;"><span class="del-link" onclick="icCnOpenDetails('${invEsc(r.id)}')">${t('invBtnDetails')}</span>${(r.return_status || 'none') !== 'none' ? ` <span class="del-link" style="margin-left:6px;" onclick="icCnOpenStatus('${invEsc(r.id)}')">${t('icBtnReturnStatus')}</span>` : ''}</td></tr>`).join('');
  root.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px;">
      <div><div style="font-size:11px;color:var(--ink-soft);">${t('icFrom')}</div><input type="date" value="${invEsc(f.from)}" onchange="icCnF.from=this.value;icCnRender()" /></div>
      <div><div style="font-size:11px;color:var(--ink-soft);">${t('icTo')}</div><input type="date" value="${invEsc(f.to)}" onchange="icCnF.to=this.value;icCnRender()" /></div>
      <div><div style="font-size:11px;color:var(--ink-soft);">${t('icColReturnStatus')}</div><select onchange="icCnF.st=this.value;icCnRender()">${stOpt('', t('invFltAll'))}${stOpt('pending', t('icRs_pending'))}${stOpt('partial', t('icRs_partial'))}${stOpt('done', t('icRs_done'))}${stOpt('none', t('icRs_none'))}</select></div>
      <div style="flex:1;min-width:160px;"><div style="font-size:11px;color:var(--ink-soft);">${t('invFltSearch')}</div><input type="text" value="${invEsc(f.q)}" placeholder="${invEsc(t('icCnSearchPh'))}" oninput="icCnF.q=this.value;icCnRenderKeepFocus(this)" style="width:100%;box-sizing:border-box;" /></div>
    </div>
    ${list.length ? `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>Credit Note No</th><th>${t('icColDate')}</th><th>${t('invColCustomer')}</th><th>${t('icLinkedInvoice')}</th><th class="num">${t('spTotalAmt')}</th><th class="num">${t('invCreditAvail')}</th><th>${t('icColReturnStatus')}</th><th></th></tr></thead><tbody>${body}<tr style="font-weight:700;border-top:2px solid var(--line, #ccc);"><td colspan="4" style="text-align:right;">${t('invListTotals')} (${list.length})</td><td class="num">(${invMoney2(sum)})</td><td class="num">${invMoney2(availSum)}</td><td></td><td></td></tr></tbody></table></div>` : `<div class="empty-note">${t('icNoCn')}</div>`}`;
}
function icCnRenderKeepFocus(inp){
  const pos = inp.selectionStart; icCnRender();
  const el = document.querySelector('#creditNoteListRoot input[type=text]'); if(el){ el.focus(); try{ el.setSelectionRange(pos, pos); }catch(e){} }
}
async function icCnView(id){
  try{
    const { data, error } = await sb.from('credit_notes').select('snapshot').eq('id', id).maybeSingle();
    if(error || !data) throw error || new Error('not found');
    try{ await loadInvoiceSettings(); }catch(e){}
    invShowModal(null, data.snapshot, true, null);
  }catch(e){ console.error('讀取 Credit Note 失敗', e); showInfoModal(t('invLoadFailed')); }
}
async function icCnOpenDetails(id){
  try{
    const { data: cn, error } = await sb.from('credit_notes').select('*').eq('id', id).maybeSingle();
    if(error || !cn) throw error || new Error('not found');
    let uses = [];
    try{
      const pr = await sb.from('invoice_payments').select('id,invoice_id,pay_date,amount,created_by,created_at').eq('credit_cn_id', id).order('pay_date', { ascending: true });
      const pays = pr.error ? [] : (pr.data || []);
      if(pays.length){
        const ir = await sb.from('invoices').select('id,invoice_no').in('id', [...new Set(pays.map(x => x.invoice_id))]);
        const m = {}; (ir.data || []).forEach(x => { m[x.id] = x.invoice_no; });
        uses = pays.map(x => Object.assign({}, x, { invoice_no: m[x.invoice_id] }));
      }
    }catch(e){}
    const total = Number(cn.total) || 0, used = uses.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const when = iso => { try{ return new Date(iso).toLocaleString(); }catch(e){ return iso || ''; } };
    const row = (k, v) => `<tr><td style="color:var(--ink-soft);white-space:nowrap;vertical-align:top;">${k}</td><td>${v === '' || v === null || v === undefined ? '–' : v}</td></tr>`;
    icCloseOverlay('icCnDetailsOverlay');
    const ov = document.createElement('div');
    ov.id = 'icCnDetailsOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
    ov.onclick = e => { if(e.target === ov) icCloseOverlay('icCnDetailsOverlay'); };
    const lk = (id, no) => `<div style="white-space:nowrap;"><span class="batch-link" onclick="icCloseOverlay('icCnDetailsOverlay');invOpenDetails('${invEsc(id)}')">INV${invEsc(no || '')}</span></div>`;
    const linkInv = cn.invoice_id ? lk(cn.invoice_id, cn.invoice_no) : [...new Map(uses.map(x => [x.invoice_id, x])).values()].map(x => lk(x.invoice_id, x.invoice_no)).join('');
    ov.innerHTML = `<div class="modal-box" style="max-width:min(560px,96vw);max-height:92vh;overflow:auto;">
      <div class="section-title" style="margin-top:0;">${t('icCnDetailTitle')} · ${invEsc(cn.cn_no)}</div>
      <div style="font-size:12.5px;margin:0 0 8px;">${invEsc(invCustLabel(cn))} · ${icRsBadge(cn.return_status)}</div>
      <table style="width:100%;font-size:13px;border-collapse:collapse;"><tbody>
        ${row('Date', invEsc(invIsoToDmy(cn.cn_date)))}
        ${row(t('icLinkedInvoice'), linkInv)}
        ${row(t('spSaleAmt'), invMoney2(cn.before_tax))}
        ${row(t('spGstAmt'), invMoney2(cn.tax))}
        ${row(t('spTotalAmt'), '<b>(' + invMoney2(total) + ')</b>')}
        ${cn.invoice_id ? '' : row(t('icCnUsed'), invMoney2(used))}
        ${cn.invoice_id ? '' : row(t('invCreditAvail'), '<b>' + invMoney2(Math.max(0, total - used)) + '</b>')}
        ${row(t('invDtCreated'), invEsc((cn.created_by || '') + (cn.created_at ? ' · ' + when(cn.created_at) : '')))}
      </tbody></table>
      ${cn.invoice_id ? '' : `
        <div style="margin-top:12px;font-size:12.5px;font-weight:700;">${invEsc(t('icCnUseHistory'))}</div>
        ${uses.length ? uses.map(x => `<div style="padding:5px 0;border-top:1px solid var(--line);font-size:12px;"><span class="batch-link" onclick="icCloseOverlay('icCnDetailsOverlay');invOpenDetails('${invEsc(x.invoice_id)}')">INV${invEsc(x.invoice_no || '')}</span> · ${invEsc(invIsoToDmy(x.pay_date))} · <b>${invMoney2(x.amount)}</b>${x.created_by ? ' · ' + invEsc(x.created_by) : ''}</div>`).join('') : `<div class="empty-note" style="margin:4px 0;">${invEsc(t('icCnNoUse'))}</div>`}`}
      <div class="modal-actions"><button class="btn ghost" onclick="icCloseOverlay('icCnDetailsOverlay')">${t('btnClose')}</button><button class="btn ghost" onclick="icCloseOverlay('icCnDetailsOverlay');icCnView('${invEsc(cn.id)}')">${invEsc(t('icCnViewDoc'))}</button></div>
    </div>`;
    document.body.appendChild(ov);
  }catch(e){ console.error('讀取 Credit Note 詳細資料失敗', e); showInfoModal(t('invLoadFailed')); }
}
function icCnOpenStatus(id){
  const r = (icCnRows || []).find(x => x.id === id); if(!r) return;
  icCloseOverlay('icCnStatusOverlay');
  const ov = document.createElement('div');
  ov.id = 'icCnStatusOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.innerHTML = `<div class="modal-box" style="max-width:380px;">
    <div class="section-title" style="margin-top:0;">${invEsc(r.cn_no)} · ${t('icColReturnStatus')}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${t('icReturnStatusHint')}</p>
    <select id="icCnStatusSel" style="width:100%;box-sizing:border-box;">${['pending', 'partial', 'done'].map(v => `<option value="${v}" ${r.return_status === v ? 'selected' : ''}>${t('icRs_' + v)}</option>`).join('')}</select>
    <div id="icCnStatusMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="icCloseOverlay('icCnStatusOverlay')">${t('btnCancel')}</button><button class="btn" onclick="icCnSaveStatus('${invEsc(id)}')">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
async function icCnSaveStatus(id){
  const v = document.getElementById('icCnStatusSel').value;
  const { error } = await sb.rpc('credit_note_set_return_status', { p_id: id, p_status: v });
  if(error){ const m = document.getElementById('icCnStatusMsg'); if(m){ m.className = 'msg error'; m.textContent = /return_recorded/.test(error.message || '') ? t('icReturnRecorded') : t('invLoadFailed'); } if(!/return_recorded/.test(error.message || '')) console.error(error); return; }
  icCloseOverlay('icCnStatusOverlay');
  await icCnOpenList(true);
}

// ---------- 備份 / 還原 / 清除(資料表沒建立時略過)----------
async function icCnExportForBackup(){
  try{
    const { data, error } = await sb.from('credit_notes').select('*').order('cn_no', { ascending: true }).limit(100000);
    if(error) return null;
    const { data: c } = await sb.from('credit_note_counter').select('next_no').eq('id', 1).maybeSingle();
    return { rows: data || [], next: c ? Number(c.next_no) : 1 };
  }catch(e){ return null; }
}
async function icCnRestoreFromBackup(d){
  if(!d || !Array.isArray(d.rows)) return;
  const { error } = await sb.rpc('credit_notes_restore_all', { p_rows: d.rows, p_next: d.next || 1 });
  if(error && !invIsMissingFn(error)) throw error;
}
async function icCnClearAll(){
  const { error } = await sb.rpc('credit_notes_clear_all');
  if(error && !invIsMissingFn(error)) console.error(error);
}

// ============================================================
// 登記進出貨 → 入庫:選對應的 Credit Note(下拉選單,只列「待入庫 / 部分入庫」的)
// 選了就把還沒入庫的退貨品項帶進清單;送出後記下已入庫的數量,全部入庫就變「已入庫」。
// ============================================================
let icTxCnList = [];
async function icTxCnRefresh(type){
  const wrap = document.getElementById('txCnWrap'); if(!wrap) return;
  const off = typeof hideInvoiceEnabled !== 'undefined' && hideInvoiceEnabled;
  if(type !== 'restock' || off){ wrap.style.display = 'none'; return; }
  let list = [];
  try{ const { data, error } = await sb.rpc('credit_notes_pending', { p_party_id: null }); if(!error) list = data || []; }catch(e){}
  icTxCnList = list;
  if(!list.length){ wrap.style.display = 'none'; return; }   // 沒有待入庫的 Credit Note 就不顯示
  wrap.style.display = '';
  const sel = document.getElementById('txCnSelect');
  const keep = sel.value;
  sel.innerHTML = `<option value="">${invEsc(t('icTxCnNone'))}</option>` + list.map(c => {
    const names = (c.items || []).filter(x => Number(x.qty) - Number(x.returned) > 0).map(x => x.name).join(', ');
    return `<option value="${invEsc(c.id)}">${invEsc(c.cn_no)} · ${invEsc(c.customer || '')} · ${invEsc(invIsoToDmy(c.cn_date))} · ${invEsc(names.length > 60 ? names.slice(0, 60) + '…' : names)}</option>`;
  }).join('');
  if(keep && list.some(c => c.id === keep)) sel.value = keep;
  icTxCnHint();
}
function icTxCnHint(){
  const h = document.getElementById('txCnHint'); if(!h) return;
  const c = icTxCnList.find(x => x.id === (document.getElementById('txCnSelect') || {}).value);
  h.textContent = c ? (c.items || []).map(x => `${x.name}: ${Math.max(0, Number(x.qty) - Number(x.returned))} ${x.unit || ''}`).join(' · ') : t('icTxCnHint');
}
function icTxCnPick(){
  icTxCnHint();
  const c = icTxCnList.find(x => x.id === document.getElementById('txCnSelect').value);
  txBatchItems = txBatchItems.filter(it => !it.fromCn);
  if(c){
    (c.items || []).forEach(x => {
      const remain = Math.max(0, Number(x.qty) - Number(x.returned));
      const p = (typeof products !== 'undefined' ? products : []).find(pp => pp.id === x.productId);
      if(!p || remain <= 0) return;
      const ex = txBatchItems.find(it => it.productId === p.id && !(it.expiry || ''));
      if(ex) ex.qty += remain;
      else txBatchItems.push({ batchItemId: genId(), productId: p.id, sku: p.sku || '', name: p.name, unit: p.unit, qty: remain, expiry: '', supplierLot: '', fromCn: true });
    });
  }
  try{ renderTxBatchList(); }catch(e){}
}
async function icTxCnAfterSubmit(items){
  const sel = document.getElementById('txCnSelect');
  const id = sel ? sel.value : '';
  if(!id) return;
  const c = icTxCnList.find(x => x.id === id);
  const cnIds = new Set(((c && c.items) || []).map(x => x.productId));
  const sums = {};
  (items || []).forEach(it => { if(cnIds.has(it.productId)) sums[it.productId] = (sums[it.productId] || 0) + Number(it.qty); });
  const arr = Object.keys(sums).map(k => ({ productId: k, qty: sums[k] }));
  if(sel) sel.value = '';
  if(!arr.length){ icTxCnRefresh('restock'); return; }
  try{
    const { error } = await sb.rpc('credit_note_mark_returned', { p_id: id, p_items: arr });
    if(error) throw error;
  }catch(e){ console.error('更新 Credit Note 入庫狀態失敗', e); showInfoModal(t('icTxCnMarkFail')); }
  icCnRows = null;
  icTxCnRefresh('restock');
}
