// ============================================================
// Invoice(發票)
//
// - 系統設置 → Invoice 格式(管理者、會計看得到):公司資料(名稱、地址、ABN 必填;電話、Email、網址、Logo 選填)和銀行資料。
//   存在 app_data 'invoiceSettings'(JSON);下一張 Invoice 號碼存在 app_data 'invoiceNextNo'。
// - 已完成訂單 Action → Create Invoice(管理者、會計):先跳出 Invoice 預覽視窗,按「儲存 PDF」或「列印」才會真的建立
//   (取號碼、記下日期 / 操作者),Invoice 內容快照存在 order.invoice;之後 Action 變成 Invoice,可以匯出 PDF 或列印。
// - Invoice 版面參照 TF International 的 Tax Invoice:左上公司資料,右上 Invoice No / Invoice Date / Terms / Due Date / Sale Rep,
//   Name(Bill To)與 Ship To、Notes、品項表(#、Product Description、Comment、Quantity、Price、Disc%、Amount、Tax、Barcode)、
//   Payment Method 與 Before Tax / Tax / Total。價格都是 Ex. GST;商品有勾 GST 才另外算 10% Tax。
// 依賴:sell-price.js(訂單單價)、parties.js(出貨方資料)。
// ============================================================
let invSettings = { companyName: '', abn: '', address: '', phone: '', email: '', website: '', logo: '', bankName: '', bankAccName: '', bsb: '', accNo: '' };
let invLogoDraft = null;   // 設定頁剛選好還沒儲存的 Logo(dataURL);'' = 要移除;null = 沒動

const invEsc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const invNl2br = s => invEsc(s).replace(/\r?\n/g, '<br>');

async function loadInvoiceSettings(){
  try{
    const r = await dbGet('invoiceSettings');
    const o = r && r.value ? JSON.parse(r.value) : null;
    if(o && typeof o === 'object') Object.keys(invSettings).forEach(k => { if(typeof o[k] === 'string') invSettings[k] = o[k]; });
  }catch(e){}
}
function invSettingsComplete(){ return !!(invSettings.companyName.trim() && invSettings.address.trim() && invSettings.abn.trim()); }

// ---------- 設定頁 ----------
async function invRenderSettings(){
  const set = (id, v) => { const el = document.getElementById(id); if(el && document.activeElement !== el) el.value = v || ''; };
  set('invCompanyName', invSettings.companyName); set('invAbn', invSettings.abn); set('invAddress', invSettings.address);
  set('invPhone', invSettings.phone); set('invEmail', invSettings.email); set('invWebsite', invSettings.website);
  set('invBankName', invSettings.bankName); set('invBankAccName', invSettings.bankAccName); set('invBsb', invSettings.bsb); set('invAccNo', invSettings.accNo);
  const prev = document.getElementById('invLogoPreview');
  const logo = invLogoDraft !== null ? invLogoDraft : invSettings.logo;
  if(prev){ prev.src = logo || ''; prev.style.display = logo ? '' : 'none'; }
  const nx = document.getElementById('invNextNo');
  if(nx && document.activeElement !== nx){
    try{ const r = await dbGet('invoiceNextNo'); const n = r && r.value ? parseInt(r.value, 10) : 1; nx.value = String(Number.isFinite(n) && n > 0 ? n : 1); }
    catch(e){ nx.value = '1'; }
  }
}
// Logo 縮小到最寬 400px 再存,避免設定資料太大
function invOnLogoChosen(files){
  const f = files && files[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 400 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      invLogoDraft = c.toDataURL('image/png');
      invRenderSettings();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(f);
}
function invClearLogo(){ invLogoDraft = ''; const fi = document.getElementById('invLogoFile'); if(fi) fi.value = ''; invRenderSettings(); }
async function invSaveSettings(){
  const msg = document.getElementById('invSettingsMsg');
  const g = id => (document.getElementById(id) || { value: '' }).value.trim();
  const next = { companyName: g('invCompanyName'), abn: g('invAbn'), address: g('invAddress'), phone: g('invPhone'), email: g('invEmail'), website: g('invWebsite'),
    logo: invLogoDraft !== null ? invLogoDraft : invSettings.logo, bankName: g('invBankName'), bankAccName: g('invBankAccName'), bsb: g('invBsb'), accNo: g('invAccNo') };
  if(!next.companyName || !next.address || !next.abn){ msg.className = 'msg error'; msg.textContent = t('invNeedRequired'); return; }
  const nn = parseInt(g('invNextNo'), 10);
  if(!Number.isFinite(nn) || nn < 1){ msg.className = 'msg error'; msg.textContent = t('invBadNextNo'); return; }
  try{
    await dbSet('invoiceSettings', JSON.stringify(next));
    await dbSet('invoiceNextNo', String(nn));
    invSettings = next; invLogoDraft = null;
    msg.className = 'msg ok'; msg.textContent = t('invSaved');
  }catch(e){ console.error('儲存 Invoice 設定失敗', e); msg.className = 'msg error'; msg.textContent = t('spMarginSaveFailed'); }
}

// ---------- Invoice 內容(快照)----------
const invPad = (n, w) => String(n).padStart(w || 2, '0');
function invIsoToDmy(iso){ const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); }
function invAddDays(iso, days){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if(!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return `${d.getUTCFullYear()}-${invPad(d.getUTCMonth() + 1)}-${invPad(d.getUTCDate())}`;
}
function invMoney2(n){ return (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2); }
function invFmtQty(n){ const v = Number(n); return Number.isInteger(v) ? v.toFixed(2) : String(Math.round(v * 1000) / 1000); }

// 從已完成訂單產生 Invoice 內容;回傳 { ok, snap } 或 { ok:false, reason, names }
function invBuildSnapshot(order){
  if(!invSettingsComplete()) return { ok: false, reason: 'settings' };
  const sp = (typeof shippingParties !== 'undefined') ? shippingParties.find(x => x.id === order.partyId) : null;
  const gstRate = (typeof SP_GST_RATE !== 'undefined') ? SP_GST_RATE : 0.10;
  const noPrice = [];
  const lines = [];
  (order.items || []).filter(it => !it.deleted && it.qty > 0).forEach((it, i) => {
    const pr = spPriceOrderItem(order, it);
    if(pr.unit === null || pr.unit === undefined){ noPrice.push(it.name); return; }
    const p = (typeof products !== 'undefined') ? products.find(x => x.id === it.productId) : null;
    const unit = Number(pr.unit);
    const disc = (pr.manual || !pr.discountPct) ? 0 : Number(pr.discountPct);
    const listPrice = disc > 0 && disc < 100 ? Math.round(unit / (1 - disc / 100) * 100) / 100 : unit;
    const amount = Math.round(unit * it.qty * 100) / 100;
    const tax = p && p.gst ? Math.round(amount * gstRate * 100) / 100 : 0;
    lines.push({ n: lines.length + 1, desc: it.name, sku: it.sku || (p && p.sku) || '', comment: it.note || '', qty: it.qty, unit: it.unit || '', price: listPrice, disc, amount, tax, barcode: (p && p.barcode) || '' });
  });
  if(noPrice.length) return { ok: false, reason: 'price', names: noPrice };
  if(lines.length === 0) return { ok: false, reason: 'empty' };
  const beforeTax = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const tax = Math.round(lines.reduce((s, l) => s + l.tax, 0) * 100) / 100;
  const payType = sp && sp.paymentType === 'cod' ? 'cod' : 'bank';
  const term = payType === 'cod' ? 0 : (sp && Number(sp.paymentTerm) > 0 ? Number(sp.paymentTerm) : 7);
  const today = (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0, 10);
  const name = (sp && (sp.companyName || sp.name)) || order.partyName || '';
  const snap = {
    no: '', date: today, dueDate: invAddDays(today, term), paymentType: payType, term,
    saleRep: (typeof userDisplayName === 'function' && currentUser) ? userDisplayName(currentUser) : '',
    company: { name: invSettings.companyName, abn: invSettings.abn, address: invSettings.address, phone: invSettings.phone, email: invSettings.email, website: invSettings.website },
    bank: { bankName: invSettings.bankName, accName: invSettings.bankAccName, bsb: invSettings.bsb, accNo: invSettings.accNo },
    customer: { name, billTo: (sp && sp.billTo) || '', email: (sp && sp.email) || '', abn: (sp && sp.abn) || '' },
    ship: { name, address: (sp && (sp.shipTo !== undefined ? sp.shipTo : sp.address)) || '', contact: (sp && sp.contactPerson) || '' },
    note: order.note || '', orderNo: order.orderNo || '',
    lines, beforeTax, tax, total: Math.round((beforeTax + tax) * 100) / 100,
    currency: (typeof getSystemCurrency === 'function') ? getSystemCurrency() : 'AUD'
  };
  return { ok: true, snap };
}

// ---------- Invoice 版面(HTML)----------
function invDocHtml(snap, logoDataUrl){
  const c = snap.company || {};
  const termText = snap.paymentType === 'cod' ? 'COD' : `${snap.term} Days`;
  const bk = snap.bank || {};
  const bankHtml = snap.paymentType === 'cod'
    ? `<div style="font-weight:700;">Cash on Delivery (COD)</div><div style="margin-top:4px;">Payment is due on delivery.</div>`
    : `<div>Please pay by bank transfer to:</div>
       ${bk.bankName ? `<div style="font-weight:700;margin-top:3px;">${invEsc(bk.bankName)}</div>` : ''}
       ${bk.accName ? `<div>A/C Name: ${invEsc(bk.accName)}</div>` : ''}
       <div>${bk.bsb ? 'BSB: ' + invEsc(bk.bsb) : ''}${bk.bsb && bk.accNo ? ', ' : ''}${bk.accNo ? 'A/C: ' + invEsc(bk.accNo) : ''}</div>
       <div style="margin-top:3px;">Payment Reference: Invoice No. ${invEsc(snap.no)}</div>`;
  const th = 'padding:5px 6px;text-align:left;font-weight:700;border-bottom:1px solid #000;';
  const td = 'padding:5px 6px;vertical-align:top;border-bottom:1px solid #ddd;';
  const rows = snap.lines.map(l => `<tr style="page-break-inside:avoid;">
      <td style="${td}">${l.n}</td>
      <td style="${td}">${l.sku ? `<b>${invEsc(l.sku)}</b><br>` : ''}${invEsc(l.desc)}</td>
      <td style="${td}">${invEsc(l.comment)}</td>
      <td style="${td}text-align:right;">${invFmtQty(l.qty)}${l.unit ? '<br><span style="font-size:9px;">' + invEsc(l.unit) + '</span>' : ''}</td>
      <td style="${td}text-align:right;">${invMoney2(l.price)}</td>
      <td style="${td}text-align:right;">${invMoney2(l.disc)}%</td>
      <td style="${td}text-align:right;">${invMoney2(l.amount)}</td>
      <td style="${td}text-align:right;">${invMoney2(l.tax)}</td>
      <td style="${td}">${invEsc(l.barcode)}</td>
    </tr>`).join('');
  const cu = snap.customer || {}, sh = snap.ship || {};
  return `<div class="inv-doc" style="width:794px;box-sizing:border-box;padding:40px 44px 32px;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.45;">
    <table style="width:100%;border-collapse:collapse;"><tr>
      <td style="vertical-align:top;width:60%;">
        <div style="display:flex;gap:14px;align-items:flex-start;">
          ${logoDataUrl ? `<img src="${logoDataUrl}" alt="" style="max-height:78px;max-width:150px;object-fit:contain;" />` : ''}
          <div>
            <div style="font-size:14px;font-weight:700;">${invEsc(c.name)}</div>
            <div>${invNl2br(c.address)}</div>
            ${c.phone ? `<div>Tel: ${invEsc(c.phone)}</div>` : ''}
            ${c.email ? `<div>${invEsc(c.email)}</div>` : ''}
            ${c.website ? `<div>${invEsc(c.website)}</div>` : ''}
            <div>ABN: ${invEsc(c.abn)}</div>
          </div>
        </div>
      </td>
      <td style="vertical-align:top;text-align:right;">
        <div style="font-size:24px;font-weight:400;letter-spacing:0.5px;">TAX INVOICE</div>
        <table style="margin-left:auto;margin-top:8px;border-collapse:collapse;text-align:left;">
          <tr><td style="padding:2px 14px 2px 0;font-weight:700;">Invoice No:</td><td>${invEsc(snap.no)}</td></tr>
          <tr><td style="padding:2px 14px 2px 0;font-weight:700;">Invoice Date:</td><td>${invEsc(invIsoToDmy(snap.date))}</td></tr>
          <tr><td style="padding:2px 14px 2px 0;font-weight:700;">Terms:</td><td>${invEsc(termText)}</td></tr>
          <tr><td style="padding:2px 14px 2px 0;font-weight:700;">Due Date:</td><td>${invEsc(invIsoToDmy(snap.dueDate))}</td></tr>
          <tr><td style="padding:2px 14px 2px 0;font-weight:700;">Sale Rep</td><td>${invEsc(snap.saleRep)}</td></tr>
        </table>
      </td></tr></table>

    <table style="width:100%;border-collapse:collapse;margin-top:22px;"><tr>
      <td style="vertical-align:top;width:50%;padding-right:14px;">
        <div style="font-weight:700;">Name:</div>
        <div>${invEsc(cu.name)}</div>
        <div>${invNl2br(cu.billTo)}</div>
        ${cu.email ? `<div style="margin-top:6px;">${invEsc(cu.email)}</div>` : ''}
        <div style="font-weight:700;margin-top:4px;">Customer ABN: <span style="font-weight:400;">${invEsc(cu.abn)}</span></div>
      </td>
      <td style="vertical-align:top;">
        <div style="font-weight:700;">Ship To:</div>
        <div>${invEsc(sh.name)}</div>
        ${sh.contact ? `<div>${invEsc(sh.contact)}</div>` : ''}
        <div>${invNl2br(sh.address)}</div>
      </td></tr></table>

    <div style="border:1px solid #000;margin-top:16px;padding:6px 8px;min-height:34px;"><b>Notes:</b> ${invEsc(snap.note)}${snap.orderNo ? `<span style="float:right;">Order ${invEsc(snap.orderNo)}</span>` : ''}</div>

    <table style="width:100%;border-collapse:collapse;margin-top:16px;border-top:1px solid #000;">
      <thead><tr>
        <th style="${th}width:22px;">#</th><th style="${th}">Product Description</th><th style="${th}">Comment</th>
        <th style="${th}text-align:right;">Quantity</th><th style="${th}text-align:right;">Price</th><th style="${th}text-align:right;">Disc%</th>
        <th style="${th}text-align:right;">Amount</th><th style="${th}text-align:right;">Tax</th><th style="${th}">Barcode</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:24px;page-break-inside:avoid;"><tr>
      <td style="vertical-align:top;width:58%;border:1px solid #000;padding:8px 10px;">
        <div style="font-weight:700;text-decoration:underline;margin-bottom:4px;">Payment Method</div>
        ${bankHtml}
      </td>
      <td style="vertical-align:top;padding:0;border:1px solid #000;border-left:none;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 10px;border-bottom:1px solid #000;">Before Tax</td><td style="padding:8px 10px;border-bottom:1px solid #000;text-align:right;">${invMoney2(snap.beforeTax)}</td></tr>
          <tr><td style="padding:8px 10px;border-bottom:1px solid #000;">Tax</td><td style="padding:8px 10px;border-bottom:1px solid #000;text-align:right;">${invMoney2(snap.tax)}</td></tr>
          <tr style="font-weight:700;"><td style="padding:8px 10px;">Total ${invEsc(snap.currency || 'AUD')}</td><td style="padding:8px 10px;text-align:right;">${invMoney2(snap.total)}</td></tr>
        </table>
      </td></tr></table>

    <div style="margin-top:16px;font-size:10px;page-break-inside:avoid;">
      <div>I agree to the following statements and acknowledge the associated responsibilities:</div>
      <div>I agree to complete the signing process, confirming that the quantity and items listed on this invoice are correct.</div>
      <div>Signing indicates the completion of the delivery process, and I accept that no further replenishments will be made thereafter.</div>
      <div style="margin-top:22px;font-size:12px;">Full Name: ____________________________ &nbsp;&nbsp; Signature: ____________________________</div>
    </div>
  </div>`;
}

// ---------- 預覽視窗 ----------
let invModal = null;   // { orderId, snap, created }
function invCloseModal(){ const o = document.getElementById('invoiceOverlay'); if(o) o.remove(); invModal = null; }
function invShowModal(orderId, snap, created){
  invCloseModal();
  invModal = { orderId, snap, created };
  const ov = document.createElement('div');
  ov.id = 'invoiceOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  const order = orders.find(o => o.id === orderId);
  const title = `${created ? 'Invoice' : 'Create Invoice'}${order && order.orderNo ? ' · ' + order.orderNo : ''}`;
  const shown = created ? snap : Object.assign({}, snap, { no: t('invNoAuto') });
  ov.innerHTML = `<div class="modal-box" style="max-width:min(900px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${invEsc(title)}</div>
    ${created ? '' : `<p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${t('invCreateHint')}</p>`}
    <div style="overflow:auto;border:1px solid var(--line);background:#eee;padding:8px;"><div id="invPreviewHost" style="zoom:0.85;">${invDocHtml(shown, invSettings.logo)}</div></div>
    <div id="invModalMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="invCloseModal()">${created ? t('btnClose') : t('btnCancel')}</button>
      <button class="btn ghost" onclick="invDoPrint()">${t('invBtnPrint')}</button>
      <button class="btn" onclick="invDoSavePdf()">${created ? t('invBtnExport') : t('invBtnSavePdf')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
function invOpenCreate(orderId){
  if(!canCreateInvoice()) return;
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted || orderStatus(order) !== 'confirmed') return;
  if(order.invoice){ invShowModal(orderId, order.invoice, true); return; }
  const r = invBuildSnapshot(order);
  if(!r.ok){
    if(r.reason === 'settings') showInfoModal(t('invNeedSettings'));
    else if(r.reason === 'price') showInfoModal(tf('invNoPrice', { names: r.names.slice(0, 8).join(', ') + (r.names.length > 8 ? '…' : '') }));
    else showInfoModal(t('invNoItems'));
    return;
  }
  invShowModal(orderId, r.snap, false);
}
function invOpenView(orderId){
  const order = orders.find(o => o.id === orderId);
  if(order && order.invoice) invShowModal(orderId, order.invoice, true);
}
// 按下儲存 / 列印才真的建立 Invoice:取號碼、記下今天日期與操作者,存回訂單
async function invEnsureCreated(){
  if(!invModal) return null;
  if(invModal.created) return invModal.snap;
  const order = orders.find(o => o.id === invModal.orderId);
  if(!order) return null;
  if(order.invoice){ invModal.snap = order.invoice; invModal.created = true; return order.invoice; }
  const msg = document.getElementById('invModalMsg');
  try{
    let n = 1;
    const r = await dbGet('invoiceNextNo');
    const v = r && r.value ? parseInt(r.value, 10) : 1;
    if(Number.isFinite(v) && v > 0) n = v;
    const snap = Object.assign({}, invModal.snap, { no: invPad(n, 8), createdAt: new Date().toISOString() });
    // 日期、Due date、Sale Rep 以「按下建立」當下為準
    snap.date = (typeof todayISO === 'function') ? todayISO() : snap.date;
    snap.dueDate = invAddDays(snap.date, snap.term || 0);
    snap.saleRep = (typeof userDisplayName === 'function' && currentUser) ? userDisplayName(currentUser) : snap.saleRep;
    await dbSet('invoiceNextNo', String(n + 1));
    order.invoice = snap;
    await upsertOrders([order]);
    invModal.snap = snap; invModal.created = true;
    try{ logInventoryAction('order_edit', `Order ${order.orderNo || order.id} - invoice created: ${snap.no}`, order.orderNo); }catch(e){}
    try{ renderOrders(); }catch(e){}
    return snap;
  }catch(e){
    console.error('建立 Invoice 失敗', e);
    delete order.invoice;
    if(msg){ msg.className = 'msg error'; msg.textContent = t('invCreateFailed'); }
    return null;
  }
}
function invRefreshModalAfterCreate(){
  const host = document.getElementById('invPreviewHost');
  if(host && invModal) host.innerHTML = invDocHtml(invModal.snap, invSettings.logo);
  const ov = document.getElementById('invoiceOverlay');
  if(ov && invModal){
    const ttl = ov.querySelector('.section-title'); const order = orders.find(o => o.id === invModal.orderId);
    if(ttl) ttl.textContent = 'Invoice' + (order && order.orderNo ? ' · ' + order.orderNo : '');
    const hint = ov.querySelector('p'); if(hint) hint.remove();
  }
}
function invFileName(snap){ return `Invoice_${snap.no}_${String((snap.customer && snap.customer.name) || '').replace(/[^\w\-]+/g, '_').slice(0, 30)}.pdf`; }

async function invDoSavePdf(){
  const snap = await invEnsureCreated(); if(!snap) return;
  invRefreshModalAfterCreate();
  const msg = document.getElementById('invModalMsg');
  if(typeof html2pdf === 'undefined'){ if(msg){ msg.className = 'msg error'; msg.textContent = t('invPdfLibMissing'); } return; }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;';
  holder.innerHTML = invDocHtml(snap, invSettings.logo);
  document.body.appendChild(holder);
  try{
    await html2pdf().set({
      margin: 0, filename: invFileName(snap), image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr'] }
    }).from(holder.firstElementChild).save();
  }catch(e){ console.error('產生 PDF 失敗', e); if(msg){ msg.className = 'msg error'; msg.textContent = t('invPdfFailed'); } }
  holder.remove();
}
async function invDoPrint(){
  const snap = await invEnsureCreated(); if(!snap) return;
  invRefreshModalAfterCreate();
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const d = iframe.contentWindow.document;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${invEsc(invFileName(snap))}</title>
    <style>@page{size:A4;margin:0;} body{margin:0;} .inv-doc{width:210mm !important;min-height:297mm;} tr{page-break-inside:avoid;}</style></head><body>${invDocHtml(snap, invSettings.logo)}</body></html>`);
  d.close();
  const go = () => { try{ iframe.contentWindow.focus(); iframe.contentWindow.print(); }catch(e){ console.error(e); } setTimeout(() => iframe.remove(), 2000); };
  if(iframe.contentWindow.document.readyState === 'complete') setTimeout(go, 200); else iframe.onload = () => setTimeout(go, 200);
}
