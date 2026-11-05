// ============================================================
// Invoice(發票)
//
// - 系統設置 → Invoice 格式(管理者、會計看得到):公司資料(名稱、地址、ABN 必填;電話、Email、網址、Logo 選填)和銀行資料。
//   存在 app_data 'invoiceSettings'(JSON)。Invoice 本身存在獨立資料表 invoices(sql/invoices_table.sql),號碼由資料庫連號;
//   還沒執行 SQL 時退回舊做法(快照存在訂單裡、號碼存在 app_data 'invoiceNextNo')。
// - 已完成訂單 Action → Create Invoice(管理者、會計):先跳出 Invoice 預覽視窗,按「儲存 PDF」或「列印」才會真的建立
//   (取號碼、記下日期 / 操作者),內容快照存進 invoices 資料表,order.invoice 只留 { id, no, date } 的參照;之後 Action 變成 Invoice。
// - 會計分頁 → Invoices:所有 Invoice 的清單(篩選日期 / 客戶 / 號碼),點一張可預覽、匯出 PDF、列印,也能匯出清單 Excel。
// - Invoice 版面參照 TF International 的 Tax Invoice:左上公司資料,右上 Invoice No / Invoice Date / Terms / Due Date / Sale Rep,
//   Name(Bill To)與 Ship To、Notes、品項表(#、Product Description、Comment、Quantity、Price、Disc%、Amount、Tax、Barcode)、
//   Payment Method 與 Before Tax / Tax / Total。價格都是 Ex. GST;商品有勾 GST 才另外算 10% Tax。
// 依賴:sell-price.js(訂單單價)、parties.js(出貨方資料)。
// ============================================================
let invSettings = { companyName: '', abn: '', address: '', phone: '', email: '', website: '', logo: '', bankName: '', bankAccName: '', bsb: '', accNo: '', codGraceDays: '7' };
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

// ---------- 資料庫函式(invoices 資料表)----------
let invDbMode = null;   // 'table'(已執行 sql/invoices_table.sql)/ 'legacy'(還沒執行,退回舊做法)
function invIsMissingFn(e){ return !!(e && (e.code === 'PGRST202' || e.code === '42883' || e.code === 'PGRST205' || e.code === '42P01' || /could not find the (function|table)|does not exist/i.test(e.message || ''))); }
async function invGetNextNo(){
  try{
    const { data, error } = await sb.rpc('invoice_get_next');
    if(error) throw error;
    invDbMode = 'table'; return Number(data) || 1;
  }catch(e){
    if(!invIsMissingFn(e)) throw e;
    invDbMode = 'legacy';
    const r = await dbGet('invoiceNextNo'); const n = r && r.value ? parseInt(r.value, 10) : 1; return Number.isFinite(n) && n > 0 ? n : 1;
  }
}
async function invSetNextNo(n){
  try{
    const { error } = await sb.rpc('invoice_set_next', { p_n: n });
    if(error) throw error;
    invDbMode = 'table';
  }catch(e){
    if(!invIsMissingFn(e)) throw e;
    invDbMode = 'legacy'; await dbSet('invoiceNextNo', String(n));
  }
}

// ---------- 設定頁 ----------
async function invRenderSettings(){
  const set = (id, v) => { const el = document.getElementById(id); if(el && document.activeElement !== el) el.value = v || ''; };
  set('invCompanyName', invSettings.companyName); set('invAbn', invSettings.abn); set('invAddress', invSettings.address);
  set('invPhone', invSettings.phone); set('invEmail', invSettings.email); set('invWebsite', invSettings.website);
  set('invCodGrace', invSettings.codGraceDays); set('invBankName', invSettings.bankName); set('invBankAccName', invSettings.bankAccName); set('invBsb', invSettings.bsb); set('invAccNo', invSettings.accNo);
  const prev = document.getElementById('invLogoPreview');
  const logo = invLogoDraft !== null ? invLogoDraft : invSettings.logo;
  if(prev){ prev.src = logo || ''; prev.style.display = logo ? '' : 'none'; }
  const nx = document.getElementById('invNextNo');
  if(nx && document.activeElement !== nx){
    try{ const n = await invGetNextNo(); nx.value = String(n); }
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
    logo: invLogoDraft !== null ? invLogoDraft : invSettings.logo, bankName: g('invBankName'), bankAccName: g('invBankAccName'), bsb: g('invBsb'), accNo: g('invAccNo'), codGraceDays: g('invCodGrace') };
  if(!next.companyName || !next.address || !next.abn){ msg.className = 'msg error'; msg.textContent = t('invNeedRequired'); return; }
  const cg = parseInt(next.codGraceDays, 10);
  if(!Number.isFinite(cg) || cg < 0 || cg > 365){ msg.className = 'msg error'; msg.textContent = t('invBadCodGrace'); return; }
  next.codGraceDays = String(cg);
  const nn = parseInt(g('invNextNo'), 10);
  if(!Number.isFinite(nn) || nn < 1){ msg.className = 'msg error'; msg.textContent = t('invBadNextNo'); return; }
  try{
    await dbSet('invoiceSettings', JSON.stringify(next));
    await invSetNextNo(nn);
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
function invBuildSnapshot(order, opts){
  if(!(opts && opts.skipSettings) && !invSettingsComplete()) return { ok: false, reason: 'settings' };
  const sp = (typeof shippingParties !== 'undefined') ? shippingParties.find(x => x.id === order.partyId) : null;
  const gstRate = (typeof SP_GST_RATE !== 'undefined') ? SP_GST_RATE : 0.10;
  const noPrice = [];
  const lines = [];
  const productsAll = (typeof products !== 'undefined') ? products : [];
  // 「會計匯出不顯示」的商品設定也套用在 Invoice:跟會計匯出同一套規則
  //  · 整個家族都不顯示:主商品跟底下所有批量商品的品項都不列入
  //  · 僅顯示切換的批量商品數量:主商品本身不列入,但訂單核對時切換出去的批量商品數量改列在批量商品自己的行,
  //    金額以主商品的單價 × 切換換算出的主商品數量計算(總金額跟原本被切換掉的那部分一致)
  const wholeFamilyHidden = new Set();
  productsAll.forEach(pp => {
    if(!pp.parentId && pp.hideFromCompletedOrderExport && pp.hideFromCompletedOrderExportMode === 'wholeFamily'){
      wholeFamilyHidden.add(pp.id);
      if(typeof getChildProducts === 'function') getChildProducts(pp.id).forEach(c => wholeFamilyHidden.add(c.id));
    }
  });
  const addLine = (it, p, unit, disc, listPrice, amount) => {
    const tax = p && p.gst ? Math.round(amount * gstRate * 100) / 100 : 0;
    lines.push({ n: lines.length + 1, desc: it.name, sku: it.sku || (p && p.sku) || '', comment: it.note || '', qty: it.qty, unit: it.unit || '', price: listPrice, disc, amount, tax });
  };
  (order.items || []).filter(it => !it.deleted && it.qty > 0).forEach(it => {
    const p = productsAll.find(x => x.id === it.productId) || null;
    if(wholeFamilyHidden.has(it.productId)) return;
    const pr = spPriceOrderItem(order, it);
    if(p && p.hideFromCompletedOrderExport && !p.parentId){
      // 主商品本身不列入;切換出去的批量商品改列在批量商品自己的行
      (it.fulfilledViaSwitch || []).forEach(sw => {
        if(wholeFamilyHidden.has(sw.childId)) return;
        if(pr.unit === null || pr.unit === undefined){ noPrice.push(it.name); return; }
        const cp = productsAll.find(x => x.id === sw.childId) || null;
        const amount = Math.round(Number(pr.unit) * Number(sw.convertedQty || 0) * 100) / 100;
        const cq = Number(sw.childQty) || 0;
        const unitPrice = cq > 0 ? Math.round(amount / cq * 100) / 100 : 0;
        addLine({ name: sw.childName || (cp && cp.name) || '', sku: sw.childSku || '', unit: sw.childUnit || '', qty: cq, note: it.note }, cp, unitPrice, 0, unitPrice, amount);
      });
      return;
    }
    if(pr.unit === null || pr.unit === undefined){ noPrice.push(it.name); return; }
    const unit = Number(pr.unit);
    const disc = (pr.manual || !pr.discountPct) ? 0 : Number(pr.discountPct);
    const listPrice = disc > 0 && disc < 100 ? Math.round(unit / (1 - disc / 100) * 100) / 100 : unit;
    const amount = Math.round(unit * it.qty * 100) / 100;
    addLine(it, p, unit, disc, listPrice, amount);
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
    lines, beforeTax, tax, total: Math.round((beforeTax + tax) * 100) / 100, paid: 0, filtered: true,
    currency: (typeof getSystemCurrency === 'function') ? getSystemCurrency() : 'AUD'
  };
  return { ok: true, snap };
}

// ---------- Invoice 版面(HTML)----------
function invDocHtml(snap, logoDataUrl){
  snap = invNormalizeSnap(snap);
  const cnDoc = snap.docType === 'credit_note';
  const mm = n => cnDoc ? '(' + invMoney2(n) + ')' : invMoney2(n);   // Credit Note 的金額用括號表示負數
  const c = snap.company || {};
  const termText = snap.paymentType === 'cod' ? 'COD' : `${snap.term} Days`;
  const bk = snap.bank || {};
  const bankHtml = cnDoc
    ? `<div style="font-weight:700;">${snap.invoiceNo ? 'Credit applied to Invoice ' + invEsc(snap.invoiceNo) : 'Credit held on customer account'}</div>${(snap.lines || []).some(l => l.ret) ? '<div style="margin-top:4px;">Items marked for return are to be returned to the warehouse.</div>' : ''}`
    : snap.paymentType === 'cod'
    ? `<div style="font-weight:700;">Cash on Delivery (COD)</div><div style="margin-top:4px;">Payment is due on delivery.</div>`
    : `<div>Please pay by bank transfer to:</div>
       ${bk.bankName ? `<div style="font-weight:700;margin-top:3px;">${invEsc(bk.bankName)}</div>` : ''}
       ${bk.accName ? `<div>A/C Name: ${invEsc(bk.accName)}</div>` : ''}
       <div>${bk.bsb ? 'BSB: ' + invEsc(bk.bsb) : ''}${bk.bsb && bk.accNo ? ', ' : ''}${bk.accNo ? 'A/C: ' + invEsc(bk.accNo) : ''}</div>
       <div style="margin-top:3px;">Payment Reference: Invoice No. ${invEsc(snap.no)}</div>`;
  const th = 'padding:5px 6px;text-align:left;font-weight:700;border-bottom:1px solid #000;';
  const td = 'padding:5px 6px;vertical-align:top;border-bottom:1px solid #ddd;word-wrap:break-word;overflow-wrap:anywhere;';
  const rows = snap.lines.map(l => `<tr style="page-break-inside:avoid;">
      <td style="${td}">${l.n}</td>
      <td style="${td}">${l.sku ? `<b>${invEsc(l.sku)}</b><br>` : ''}${invEsc(l.desc)}</td>
      <td style="${td}">${invEsc(l.comment)}</td>
      <td style="${td}text-align:right;">${invFmtQty(l.qty)}${l.unit ? '<br><span style="font-size:9px;">' + invEsc(l.unit) + '</span>' : ''}</td>
      <td style="${td}text-align:right;">${mm(l.price)}</td>
      <td style="${td}text-align:right;">${invMoney2(l.disc)}%</td>
      <td style="${td}text-align:right;">${mm(l.amount)}</td>
      <td style="${td}text-align:right;">${mm(l.tax)}</td>
    </tr>`).join('');
  const cu = snap.customer || {}, sh = snap.ship || {};
  const paid = Math.max(0, Number(snap.paid) || 0);
  const balance = Math.round((Number(snap.total) - paid) * 100) / 100;
  const tr = 'padding:8px 10px;border-bottom:1px solid #000;';
  return `<div class="inv-doc" style="width:794px;box-sizing:border-box;padding:40px 44px 32px;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.45;display:flex;flex-direction:column;">
   <div class="inv-main">
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
        <div style="font-size:24px;font-weight:400;letter-spacing:0.5px;">${cnDoc ? 'CREDIT NOTE' : 'TAX INVOICE'}</div>
        <table style="margin-left:auto;margin-top:4px;border-collapse:collapse;text-align:left;">
          <tr><td style="padding:1px 14px 1px 0;font-weight:700;">${cnDoc ? 'Credit Note No:' : 'Invoice No:'}</td><td>${invEsc(snap.no)}</td></tr>
          <tr><td style="padding:1px 14px 1px 0;font-weight:700;">${cnDoc ? 'Date:' : 'Invoice Date:'}</td><td>${invEsc(invIsoToDmy(snap.date))}</td></tr>
          ${cnDoc ? '' : `<tr><td style="padding:1px 14px 1px 0;font-weight:700;">Terms:</td><td>${invEsc(termText)}</td></tr>
          <tr><td style="padding:1px 14px 1px 0;font-weight:700;">Due Date:</td><td>${invEsc(invIsoToDmy(snap.dueDate))}</td></tr>`}
          <tr><td style="padding:1px 14px 1px 0;font-weight:700;">Sale Rep</td><td>${invEsc(snap.saleRep)}</td></tr>
        </table>
      </td></tr></table>

    <table style="width:100%;border-collapse:collapse;margin-top:4px;"><tr>
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

    <div style="border:1px solid #000;margin-top:16px;padding:6px 8px;min-height:34px;"><b>Notes:</b> ${invNl2br(snap.note)}${snap.orderNo ? `<span style="float:right;">Order ${invEsc(snap.orderNo)}</span>` : ''}</div>

    <table style="width:100%;border-collapse:collapse;margin-top:16px;border-top:1px solid #000;table-layout:fixed;">
      <colgroup><col style="width:30px;" /><col style="width:185px;" /><col /><col style="width:58px;" /><col style="width:56px;" /><col style="width:58px;" /><col style="width:64px;" /><col style="width:50px;" /></colgroup>
      <thead><tr>
        <th style="${th}">#</th><th style="${th}">Product Description</th><th style="${th}">Comment</th>
        <th style="${th}text-align:right;">Quantity</th><th style="${th}text-align:right;">Price</th><th style="${th}text-align:right;">Disc%</th>
        <th style="${th}text-align:right;">Amount</th><th style="${th}text-align:right;">Tax</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
   </div>

   <div class="inv-foot" style="margin-top:auto;padding-top:24px;">
    <table style="width:100%;border-collapse:collapse;page-break-inside:avoid;"><tr>
      <td style="vertical-align:top;width:58%;border:1px solid #000;padding:8px 10px;">
        <div style="font-weight:700;text-decoration:underline;margin-bottom:4px;">${cnDoc ? 'Credit Details' : 'Payment Method'}</div>
        ${bankHtml}
      </td>
      <td style="vertical-align:top;padding:0;border:1px solid #000;border-left:none;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="${tr}">Before Tax</td><td style="${tr}text-align:right;">${mm(snap.beforeTax)}</td></tr>
          <tr><td style="${tr}">Tax</td><td style="${tr}text-align:right;">${mm(snap.tax)}</td></tr>
          ${cnDoc ? `<tr style="font-weight:700;background:#d9d9d9;"><td style="padding:8px 10px;background:#d9d9d9;">Total Credit</td><td style="padding:8px 10px;text-align:right;background:#d9d9d9;">${mm(snap.total)}</td></tr>` : `<tr style="font-weight:700;"><td style="${tr}">Total Amt</td><td style="${tr}text-align:right;">${invMoney2(snap.total)}</td></tr>
          <tr><td style="${tr}">${snap.id ? 'Paid' : 'Paid Today'}</td><td style="${tr}text-align:right;">${invMoney2(paid)}</td></tr>
          <tr style="font-weight:700;background:#d9d9d9;"><td style="padding:8px 10px;background:#d9d9d9;">Balance Due</td><td style="padding:8px 10px;text-align:right;background:#d9d9d9;">${invMoney2(balance)}</td></tr>`}
        </table>
      </td></tr></table>

    <div style="margin-top:16px;font-size:10px;page-break-inside:avoid;">
      <div><b>Terms:</b> Signing confirms receipt and finalizes the order. Returns of standard products incur a 30% restocking fee. Due to health and hygiene reasons, all food products are strictly non-returnable and non-exchangeable.</div>
    </div>
   </div>
  </div>`;
}

// 讓整張 Invoice 的高度剛好是 A4 的整數頁,付款方式/簽名區塊才會貼在(最後一頁)A4 的最底部。
// pageH:一頁的高度(px 數字,或帶單位的字串);host:裝著 .inv-doc 的容器。
function invFitPages(host, mode){
  const doc = host && host.querySelector ? host.querySelector('.inv-doc') : null;
  if(!doc) return;
  doc.style.minHeight = '0';
  const real = doc.scrollHeight;
  // 列印時每次換頁會因為「整列不拆開」、表頭重複而多佔一點高度,預留一些空間再算頁數
  const gap = mode === 'print' ? 110 : 0;
  let pages = 1;
  while(real + gap * (pages - 1) > pages * 1120) pages++;
  doc.style.minHeight = mode === 'print' ? (pages === 1 ? 295 : pages * 297 - 20) + 'mm' : (pages * 1120) + 'px';
}

// ---------- 預覽視窗 ----------
let invModal = null;   // { orderId, snap, created, link }  link = 手動 / 多張訂單合併的 Invoice(見 invoice-create.js)
function invCloseModal(){ const o = document.getElementById('invoiceOverlay'); if(o) o.remove(); invModal = null; }
function invShowModal(orderId, snap, created, link){
  invCloseModal();
  invModal = { orderId, snap, created, link: link || null };
  const ov = document.createElement('div');
  ov.id = 'invoiceOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  const order = orders.find(o => o.id === orderId);
  const isCn = snap.docType === 'credit_note';
  const title = isCn ? `${created ? 'Credit Note' : 'Create Credit Note'}${snap.no ? ' · ' + snap.no : ''}` : `${created ? 'Invoice' : 'Create Invoice'}${(order && order.orderNo) || snap.orderNo ? ' · ' + ((order && order.orderNo) || snap.orderNo) : ''}`;
  const shown = created ? snap : Object.assign({}, snap, { no: t('invNoAuto') });
  ov.innerHTML = `<div class="modal-box" style="max-width:min(900px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${invEsc(title)}</div>
    ${created ? '' : `<p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${t('invCreateHint')}</p>`}
    <div style="overflow:auto;border:1px solid var(--line);background:#eee;padding:8px;"><div id="invPreviewHost" style="zoom:0.85;">${invDocHtml(shown, invSettings.logo)}</div></div>
    <div id="invModalMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="invCloseModal()">${created ? t('btnClose') : t('btnCancel')}</button>
      ${isCn && created && snap.invoiceId ? `<button class="btn ghost" onclick="var i='${invEsc(snap.invoiceId)}';invCloseModal();invOpenDetails(i)">Invoice ${invEsc(snap.invoiceNo || '')}</button>` : ''}
      ${isCn ? '' : (created ? (invModal.snap.id ? `<button class="btn ghost" onclick="invOpenPayments(invModal.snap.id)">${t('invBtnPayments')}</button>` : '') : `<button class="btn ghost" onclick="invOpenPaidPrompt()">${t('invBtnPaidToday')}</button>`)}
      <button class="btn ghost" onclick="invDoPrint()">${t('invBtnPrint')}</button>
      <button class="btn" onclick="invDoSavePdf()">${created ? t('invBtnExport') : t('invBtnSavePdf')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  invFitPages(document.getElementById('invPreviewHost'), 'pdf');
}

// ---- Paid Today:輸入今天已收金額,Balance Due 自動扣除 ----
function invOpenPaidPrompt(){
  if(!invModal) return;
  const snap = invModal.snap;
  const ov = document.createElement('div');
  ov.id = 'invPaidOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1200';
  ov.innerHTML = `<div class="modal-box" style="max-width:360px;">
    <div class="section-title" style="margin-top:0;">${t('invBtnPaidToday')}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">Total Amt: <b>${invMoney2(snap.total)}</b></p>
    <input id="invPaidInput" type="number" min="0" step="0.01" value="${Number(snap.paid) > 0 ? invMoney2(snap.paid) : ''}" style="width:100%;box-sizing:border-box;" placeholder="0.00" />
    <label style="font-size:12px;display:block;margin-top:8px;">${t('invPayMethod')}</label>
    <select id="invPaidMethod" style="width:100%;box-sizing:border-box;">${INV_PAY_METHODS.map(m => `<option value="${m}" ${(snap.paidMethod || 'Bank Transfer') === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <div id="invPaidMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('invPaidOverlay').remove()">${t('btnCancel')}</button><button class="btn" onclick="invSavePaid()">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
  const inp = document.getElementById('invPaidInput'); if(inp){ inp.focus(); inp.select(); }
}
async function invSavePaid(){
  if(!invModal) return;
  const msg = document.getElementById('invPaidMsg');
  const raw = (document.getElementById('invPaidInput') || {}).value;
  const v = raw === '' || raw === undefined ? 0 : Math.round(Number(raw) * 100) / 100;
  if(!Number.isFinite(v) || v < 0){ msg.className = 'msg error'; msg.textContent = t('invPaidBad'); return; }
  if(v > Number(invModal.snap.total) + 0.0001){ msg.className = 'msg error'; msg.textContent = t('invPaidTooMuch'); return; }
  if(invModal.created){
    // 已建立的 Invoice:存回資料庫(或舊版:存在訂單裡)
    try{
      if(invModal.snap.id && invDbMode !== 'legacy'){
        const { error } = await sb.rpc('invoice_set_paid', { p_id: invModal.snap.id, p_paid: v });
        if(error) throw error;
      } else {
        const order = orders.find(o => o.id === invModal.orderId);
        if(!order || !order.invoice || !order.invoice.lines) throw new Error('no order invoice');
        order.invoice.paid = v;
        await upsertOrders([order]);
      }
    }catch(e){
      console.error('儲存 Paid Today 失敗', e);
      msg.className = 'msg error'; msg.textContent = invIsMissingFn(e) ? t('invPaidNeedSql') : t('invPaidFailed');
      return;
    }
  }
  invModal.snap.paid = v;
  const pm = document.getElementById('invPaidMethod'); if(pm) invModal.snap.paidMethod = pm.value;
  const po = document.getElementById('invPaidOverlay'); if(po) po.remove();
  const host = document.getElementById('invPreviewHost');
  if(host){
    const shown = invModal.created ? invModal.snap : Object.assign({}, invModal.snap, { no: t('invNoAuto') });
    host.innerHTML = invDocHtml(shown, invSettings.logo);
    invFitPages(host, 'pdf');
  }
}
function invOpenCreate(orderId){
  if(!canCreateInvoice()) return;
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted) return;   // 待處理 / 處理中 / 已完成的訂單都可以開 Invoice(一張訂單只能開一次)
  if(order.invoice){ invOpenView(orderId); return; }
  const r = invBuildSnapshot(order);
  if(!r.ok){
    if(r.reason === 'settings') showInfoModal(t('invNeedSettings'));
    else if(r.reason === 'price') showInfoModal(tf('invNoPrice', { names: r.names.slice(0, 8).join(', ') + (r.names.length > 8 ? '…' : '') }));
    else showInfoModal(t('invNoItems'));
    return;
  }
  invShowModal(orderId, r.snap, false);
}
async function invFetchSnapshot(invoiceId){
  const { data, error } = await sb.from('invoices').select('snapshot').eq('id', invoiceId).maybeSingle();
  if(error || !data) throw error || new Error('not found');
  return data.snapshot;
}
async function invOpenView(orderId){
  const order = orders.find(o => o.id === orderId);
  if(!order || !order.invoice) return;
  if(invOrderSyncable(order)) await invSyncOrders([order]);
  if(order.invoice.lines){ invShowModal(orderId, order.invoice, true); return; }
  try{ invShowModal(orderId, await invFetchSnapshot(order.invoice.id), true); }
  catch(e){ console.error('讀取 Invoice 失敗', e); showInfoModal(t('invLoadFailed')); }
}
// 按下儲存 / 列印才真的建立 Invoice:取號碼、記下今天日期與操作者,存回訂單
async function invEnsureCreated(){
  if(!invModal) return null;
  if(invModal.created) return invModal.snap;
  if(invModal.link) return await invEnsureCreatedMulti();
  const order = orders.find(o => o.id === invModal.orderId);
  if(!order) return null;
  if(order.invoice && order.invoice.lines){ invModal.snap = order.invoice; invModal.created = true; return order.invoice; }
  const msg = document.getElementById('invModalMsg');
  const fail = (key) => { if(msg){ msg.className = 'msg error'; msg.textContent = t(key || 'invCreateFailed'); } return null; };
  // 日期、Due date、Sale Rep 以「按下建立」當下為準
  const snap0 = Object.assign({}, invModal.snap);
  snap0.date = (typeof todayISO === 'function') ? todayISO() : snap0.date;
  snap0.dueDate = invAddDays(snap0.date, snap0.term || 0);
  snap0.saleRep = (typeof userDisplayName === 'function' && currentUser) ? userDisplayName(currentUser) : snap0.saleRep;
  snap0.createdAt = new Date().toISOString();
  const prevInvoice = order.invoice;
  try{
    let snap;
    try{
      const { data, error } = await sb.rpc('invoice_create', { p_snapshot: snap0, p_order_id: order.id, p_order_no: order.orderNo || '', p_party_id: order.partyId || '' });
      if(error) throw error;
      invDbMode = 'table';
      snap = Object.assign({}, snap0, { no: data.invoice_no, id: data.id });
      order.invoice = { id: data.id, no: data.invoice_no, date: snap.date };
    }catch(e){
      if(/invoice_exists/.test((e && e.message) || '')) return fail('invAlreadyExists');
      if(/invoice_forbidden/.test((e && e.message) || '')) return fail('invForbidden');
      if(!invIsMissingFn(e)) throw e;
      // 還沒執行 sql/invoices_table.sql:退回舊做法(快照存在訂單裡,號碼存在 app_data)
      invDbMode = 'legacy';
      const n = await invGetNextNo();
      snap = Object.assign({}, snap0, { no: invPad(n, 8) });
      await dbSet('invoiceNextNo', String(n + 1));
      order.invoice = snap;
    }
    await upsertOrders([order]);
    invModal.snap = snap; invModal.created = true;
    try{ logInventoryAction('order_edit', `Order ${order.orderNo || order.id} - invoice created: ${snap.no}`, order.orderNo); }catch(e){}
    try{ renderOrders(); }catch(e){}
    return snap;
  }catch(e){
    console.error('建立 Invoice 失敗', e);
    if(prevInvoice) order.invoice = prevInvoice; else delete order.invoice;
    return fail('invCreateFailed');
  }
}
function invRefreshModalAfterCreate(){
  const host = document.getElementById('invPreviewHost');
  if(host && invModal){ host.innerHTML = invDocHtml(invModal.snap, invSettings.logo); invFitPages(host, 'pdf'); }
  const ov = document.getElementById('invoiceOverlay');
  if(ov && invModal){
    const ttl = ov.querySelector('.section-title'); const order = orders.find(o => o.id === invModal.orderId);
    if(ttl && invModal.snap.docType === 'credit_note') ttl.textContent = 'Credit Note · ' + invModal.snap.no;
    else if(ttl) ttl.textContent = 'Invoice' + ((order && order.orderNo) || invModal.snap.orderNo ? ' · ' + ((order && order.orderNo) || invModal.snap.orderNo) : '');
    const hint = ov.querySelector('p'); if(hint) hint.remove();
  }
}
function invFileName(snap){ return `${snap.docType === 'credit_note' ? 'CreditNote' : 'Invoice'}_${snap.no}_${String((snap.customer && snap.customer.name) || '').replace(/[^\w\-]+/g, '_').slice(0, 30)}.pdf`; }

async function invDoSavePdf(){
  const snap = await invEnsureCreated(); if(!snap) return;
  invRefreshModalAfterCreate();
  const msg = document.getElementById('invModalMsg');
  if(typeof html2pdf === 'undefined'){ if(msg){ msg.className = 'msg error'; msg.textContent = t('invPdfLibMissing'); } return; }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;';
  holder.innerHTML = invDocHtml(snap, invSettings.logo);
  document.body.appendChild(holder);
  invFitPages(holder, 'pdf');
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
    <style>@page{size:A4;margin:0;} body{margin:0;} .inv-doc{width:210mm !important;min-height:297mm;} .inv-foot{break-inside:avoid;} tr{page-break-inside:avoid;}</style></head><body>${invDocHtml(snap, invSettings.logo)}</body></html>`);
  d.close();
  const go = () => { try{ invFitPages(iframe.contentWindow.document.body, 'print'); iframe.contentWindow.focus(); iframe.contentWindow.print(); }catch(e){ console.error(e); } setTimeout(() => iframe.remove(), 2000); };
  if(iframe.contentWindow.document.readyState === 'complete') setTimeout(go, 200); else iframe.onload = () => setTimeout(go, 200);
}


// ============================================================
// MYOB 匯入檔(Sales - Item 版面,Tab 分隔的 .txt,有標題列)
// 欄位與順序參照 MYOB AccountRight / AccountEdge「Import Sales → Item」通用格式:
//   在 MYOB 裡:File > Import/Export Assistant > Import > Sales > Item Sales,
//   選 Tab-separated、First Record is Header Record。
// 規則:Co./Last Name 要跟 MYOB 客戶卡完全一致;Item Number(這裡用商品 SKU)要跟 MYOB 存貨品項一致;
// 同一張 Invoice 的第一行放完整資料,後面各行只放品項;Invoice 與 Invoice 之間空一行。
// ============================================================
const INV_MYOB_COLS = ['Co./Last Name','First Name','Addr 1 - Line 1','           - Line 2','           - Line 3','           - Line 4','Inclusive','Invoice #','Date','Customer PO','Ship Via','Delivery Status','Item Number','Quantity','Description','Price','Inc-Tax Price','Discount','Total','Inc-Tax Total','Job','Comment','Journal Memo','Salesperson Last Name','Salesperson First Name','Shipping Date','Referral Source','Tax Code','Non-GST Amount','GST Amount','LCT Amount','Freight Amount','Inc-Tax Freight Amount','Freight Tax Code','Freight Non-GST Amount','Freight GST Amount','Freight LCT Amount','Sale Status','Currency Code','Exchange Rate','Terms - Payment is Due','           - Discount Days','           - Balance Due Days','           - % Discount','           - % Monthly Charge','Amount Paid','Payment Method','Payment Notes','Name on Card','Card Number','Expiry Date','Authorisation Code','BSB','Account Number','Drawer/Account Name','Cheque Number','Category','Location ID','Card ID','Record ID'];
function invMyobClean(v){ return String(v === undefined || v === null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim(); }
// 「會計匯出不顯示」的商品 SKU(整個家族都不顯示:主商品+批量商品;僅顯示切換:主商品本身)。
// MYOB 匯入檔也比照會計匯出,不包含這些商品——舊的 Invoice 快照(沒記錄商品 id)也靠 SKU 過濾。
function invAccountantHiddenSkus(){
  const set = new Set();
  const ps = (typeof products !== 'undefined') ? products : [];
  ps.forEach(p => {
    if(p.parentId || !p.hideFromCompletedOrderExport) return;
    if(p.sku) set.add(p.sku);
    if(p.hideFromCompletedOrderExportMode === 'wholeFamily' && typeof getChildProducts === 'function'){
      getChildProducts(p.id).forEach(c => { if(c.sku) set.add(c.sku); });
    }
  });
  return set;
}
// 舊版開出的 Invoice(快照沒有 filtered 標記)可能還含有「會計匯出不顯示」的商品:顯示/列印/匯出時
// 依 SKU 過濾掉,並用剩下的品項重算 Before Tax / Tax / Total。新開的 Invoice 在建立時就已經過濾。
function invNormalizeSnap(snap){
  if(!snap || snap.filtered) return snap;
  const hidden = invAccountantHiddenSkus();
  const lines = (snap.lines || []).filter(l => !(l.sku && hidden.has(l.sku)));
  if(lines.length === (snap.lines || []).length) return snap;
  const out = Object.assign({}, snap, { lines: lines.map((l, i) => Object.assign({}, l, { n: i + 1 })) });
  out.beforeTax = Math.round(out.lines.reduce((a, l) => a + Number(l.amount || 0), 0) * 100) / 100;
  out.tax = Math.round(out.lines.reduce((a, l) => a + Number(l.tax || 0), 0) * 100) / 100;
  out.total = Math.round((out.beforeTax + out.tax) * 100) / 100;
  return out;
}
function invMyobText(snap, fallbackNo){
  snap = invNormalizeSnap(snap);
  const idx = {}; INV_MYOB_COLS.forEach((c, i) => { idx[c.trim()] = i; });
  const idx2 = {}; // 有重複名稱的欄位(縮排的 Line 2~4 等)用位置取
  const blank = () => INV_MYOB_COLS.map(() => '');
  const rate = (typeof SP_GST_RATE !== 'undefined') ? SP_GST_RATE : 0.10;
  const cu = snap.customer || {};
  const addr = String(cu.billTo || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const invNo = snap.no || fallbackNo || '';
  const rows = [INV_MYOB_COLS];
  (snap.lines || []).forEach((l, i) => {
    const r = blank();
    const set = (name, v) => { const k = INV_MYOB_COLS.findIndex(c => c.trim() === name); if(k >= 0) r[k] = invMyobClean(v); };
    set('Co./Last Name', cu.name);
    set('Invoice #', invNo);
    const taxed = Number(l.tax) > 0;
    if(i === 0){
      r[2] = invMyobClean(addr[0]); r[3] = invMyobClean(addr[1]); r[4] = invMyobClean(addr[2]); r[5] = invMyobClean(addr[3]);
      set('Date', invIsoToDmy(snap.date));
      set('Customer PO', snap.orderNo);
      set('Comment', snap.note);
      set('Journal Memo', 'Sale; ' + (cu.name || ''));
      set('Sale Status', 'I');
      if(snap.paymentType === 'cod'){ set('Terms - Payment is Due', '1'); }
      else { set('Terms - Payment is Due', '3'); r[INV_MYOB_COLS.indexOf('           - Balance Due Days')] = String(snap.term || 0); r[INV_MYOB_COLS.indexOf('           - Discount Days')] = '0'; r[INV_MYOB_COLS.indexOf('           - % Discount')] = '0'; }
    }
    set('Item Number', l.sku);
    set('Quantity', invFmtQty(l.qty).replace(/\.00$/, ''));
    set('Description', l.comment ? `${l.desc} - ${l.comment}` : l.desc);
    set('Price', invMoney2(l.price));
    set('Inc-Tax Price', invMoney2(taxed ? l.price * (1 + rate) : l.price));
    set('Discount', Number(l.disc) > 0 ? invMoney2(l.disc) : '0');
    set('Total', invMoney2(l.amount));
    set('Inc-Tax Total', invMoney2(Number(l.amount) + Number(l.tax || 0)));
    set('Tax Code', taxed ? 'GST' : 'FRE');
    set('GST Amount', invMoney2(l.tax || 0));
    rows.push(r);
  });
  const text = rows.map(r => r.join('\t')).join('\r\n') + '\r\n\r\n';
  return text;
}
async function invExportMyob(orderId){
  if(!isInvoiceRole()) return;
  const order = orders.find(o => o.id === orderId);
  if(!order || order.deleted) return;
  let snap = null;
  try{
    if(order.invoice) snap = order.invoice.lines ? order.invoice : await invFetchSnapshot(order.invoice.id);
  }catch(e){ console.error('讀取 Invoice 失敗', e); showInfoModal(t('invLoadFailed')); return; }
  if(!snap){
    const r = invBuildSnapshot(order);   // 還沒開 Invoice:用目前訂單內容產生(不會建立 Invoice、不會佔用號碼)
    if(!r.ok){
      if(r.reason === 'settings') showInfoModal(t('invNeedSettings'));
      else if(r.reason === 'price') showInfoModal(tf('invNoPrice', { names: r.names.slice(0, 8).join(', ') + (r.names.length > 8 ? '…' : '') }));
      else showInfoModal(t('invNoItems'));
      return;
    }
    snap = r.snap;
  }
  const text = invMyobText(snap, order.orderNo);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `MYOB_Sales_${(snap.no || order.orderNo || 'order').replace(/[^\w\-]+/g, '')}_${(typeof todayISO === 'function') ? todayISO() : ''}.txt`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}


// ============================================================
// 訂單 ↔ Invoice 連動:訂單(待處理 / 已完成)改了內容,Invoice 的明細與總額跟著更新並留下變更紀錄;
// 訂單簽收之後訂單不能再改,Invoice 也就不再變。Invoice 號碼、日期、已收款不隨訂單變動。
// ============================================================
// 訂單卡片狀態欄左邊的「linked INV00000001」(只有看得到 Invoice 的人看得到;點下去開 Invoice)
function invLinkedBadgeHtml(o){
  if(!o || !o.invoice || !o.invoice.no || typeof canCreateInvoice !== 'function' || !canCreateInvoice()) return '';
  return `<span class="inv-linked-badge" title="${invEsc(t('invLinkedTip'))}" style="font-size:11.5px;color:var(--ink-soft);margin-right:6px;cursor:pointer;white-space:nowrap;" onclick="event.stopPropagation();invOpenView('${invEsc(o.id)}')">${invEsc(t('invLinkedLabel'))} <span style="text-decoration:underline;font-weight:600;">INV${invEsc(o.invoice.no)}</span><span title="Copy" style="margin-left:4px;cursor:pointer;" onclick="event.stopPropagation();invCopyText('INV${invEsc(o.invoice.no)}',this)">⧉</span></span>`;
}
const INV_LINE_KEYS = ['desc', 'sku', 'comment', 'qty', 'unit', 'price', 'disc', 'amount', 'tax'];
function invLineKey(l){ return (l.sku || '') + '|' + (l.desc || ''); }
// 比對新舊兩份快照,回傳變更內容(沒變回傳 null)
function invDiffSnap(oldS, newS){
  const oldL = oldS.lines || [], newL = newS.lines || [];
  const same = oldL.length === newL.length && oldL.every((l, i) => INV_LINE_KEYS.every(k => String(l[k] === undefined ? '' : l[k]) === String(newL[i][k] === undefined ? '' : newL[i][k])));
  const noteChanged = (oldS.note || '') !== (newS.note || '');
  if(same && !noteChanged && Number(oldS.total) === Number(newS.total)) return null;
  const om = new Map(oldL.map(l => [invLineKey(l), l])), nm = new Map(newL.map(l => [invLineKey(l), l]));
  const d = { added: [], removed: [], changed: [], total: [Number(oldS.total), Number(newS.total)] };
  newL.forEach(l => { const o = om.get(invLineKey(l)); if(!o) d.added.push({ desc: l.desc, qty: l.qty, unit: l.unit, price: l.price }); else if(Number(o.qty) !== Number(l.qty) || Number(o.price) !== Number(l.price) || Number(o.amount) !== Number(l.amount)) d.changed.push({ desc: l.desc, unit: l.unit, qty: [o.qty, l.qty], price: [o.price, l.price] }); });
  oldL.forEach(l => { if(!nm.has(invLineKey(l))) d.removed.push({ desc: l.desc, qty: l.qty, unit: l.unit, price: l.price }); });
  if(noteChanged) d.note = [oldS.note || '', newS.note || ''];
  return d;
}
function invOrderSyncable(o){ return !!(o && o.invoice && o.invoice.id && !o.invoice.lines && !o.deleted && !o.signedAt); }
let invSyncBusy = false;
// 把一批訂單(或全部)跟各自的 Invoice 對一次,有差異就更新。回傳更新了幾張。
async function invSyncOrders(orderList){
  if(invSyncBusy || typeof canCreateInvoice !== 'function' || !canCreateInvoice() || invDbMode === 'legacy') return 0;
  const list = (orderList || orders || []).filter(invOrderSyncable);
  if(!list.length) return 0;
  invSyncBusy = true; let n = 0;
  try{
    await loadInvoiceSettings();
    const { data, error } = await sb.from('invoices').select('id,snapshot').in('id', list.map(o => o.invoice.id));
    if(error) throw error;
    const snaps = new Map((data || []).map(r => [r.id, r.snapshot]));
    const done = new Set();
    for(const o of list){
      const invId = o.invoice.id;
      if(done.has(invId)) continue;      // 多張訂單合併的 Invoice 只處理一次
      done.add(invId);
      const oldS = snaps.get(invId); if(!oldS) continue;
      let r;
      if(Array.isArray(oldS.orders) && oldS.orders.length > 1){
        // 多張訂單合併的 Invoice:用所有連結的訂單重新合併
        const members = oldS.orders.map(x => orders.find(y => y.id === x.id));
        if(members.some(m => !m || m.deleted)) continue;
        const parts = members.map(m => invBuildSnapshot(m));
        if(parts.some(x => !x.ok)) continue;
        r = { ok: true, snap: icMergeSnaps(parts.map(x => x.snap), members.map(m => m.orderNo || '').filter(Boolean)) };
      } else {
        r = invBuildSnapshot(o);
      }
      if(!r.ok) continue;     // 設定不完整、有品項沒價錢、或整張訂單沒有品項:不動 Invoice
      const newS = Object.assign({}, oldS, { lines: r.snap.lines, beforeTax: r.snap.beforeTax, tax: r.snap.tax, total: r.snap.total, note: r.snap.note, orderNo: r.snap.orderNo });
      const detail = invDiffSnap(oldS, newS);
      if(!detail) continue;
      const { error: e2 } = await sb.rpc('invoice_sync', { p_invoice_id: invId, p_snapshot: newS, p_detail: detail });
      if(e2){ if(!invIsMissingFn(e2)) console.error('更新 Invoice 失敗', e2); continue; }   // 還沒執行 invoice_changes.sql 就不連動
      n++;
      try{ logInventoryAction('order_edit', `Order ${o.orderNo || o.id} - invoice ${oldS.no} updated (${invMoney2(detail.total[0])} → ${invMoney2(detail.total[1])})`, o.orderNo); }catch(e){}
    }
  }catch(e){ console.error('同步 Invoice 失敗', e); }
  finally{ invSyncBusy = false; }
  if(n){ invList = []; try{ invRerenderLists(); }catch(e){} }
  return n;
}
// 訂單編輯前的檢查:改完之後 Invoice 新總額如果會低於已收款,不給改(請會計用 Credit Note 處理)。
// mods = { qty: { 商品id: 新數量 }, del: [商品id] };回傳 true = 可以繼續。沒有 Invoice、已簽收、或還沒執行 SQL 都放行。
async function invGuardOrderEdit(order, mods){
  try{
    if(!order || !order.invoice || !order.invoice.id || order.invoice.lines || order.signedAt) return true;
    if(typeof invSettings === 'undefined') return true;
    const before = invBuildSnapshot(order, { skipSettings: true });
    if(!before.ok) return true;
    const clone = Object.assign({}, order, { items: (order.items || []).map(it => Object.assign({}, it)) });
    const m = mods || {};
    clone.items.forEach(it => {
      if(m.qty && Object.prototype.hasOwnProperty.call(m.qty, it.productId)) it.qty = Number(m.qty[it.productId]);
      if(m.del && m.del.indexOf(it.productId) >= 0) it.deleted = true;
    });
    const after = invBuildSnapshot(clone, { skipSettings: true });
    const newTotal = after.ok ? Number(after.snap.total) : (after.reason === 'empty' ? 0 : null);
    if(newTotal === null) return true;
    const delta = Math.round((newTotal - Number(before.snap.total)) * 100) / 100;
    if(delta >= 0) return true;     // 金額只會增加或不變,不可能低於已收款
    const { data, error } = await sb.rpc('invoice_edit_guard', { p_invoice_id: order.invoice.id, p_delta: delta });
    if(error){ if(!invIsMissingFn(error)) console.error('Invoice 檢查失敗', error); return true; }
    if(data === false){
      showInfoModal(tf('invUnderpaidBlock', { no: order.invoice.no || '' }));
      return false;
    }
  }catch(e){ console.error('Invoice 檢查失敗', e); }
  return true;
}
// 訂單存檔後呼叫(db.js upsertOrders):不擋住存檔,背景同步
function invAfterOrdersSaved(orderList){
  try{ if(typeof canCreateInvoice === 'function' && canCreateInvoice()) invSyncOrders(orderList); }catch(e){}
}

// ============================================================
// 會計分頁 → Invoices 清單(含收款狀態)、收款記錄、出貨方的 Invoice 記錄
// ============================================================
let invList = [];            // 從 invoices 資料表讀到的清單(不含完整快照)
let invListError = '';
const INV_PAY_METHODS = ['Bank Transfer', 'Cash', 'Card', 'Cheque', 'Other'];
// 每個清單畫面(會計分頁、出貨方的 Invoice 記錄視窗)各有自己的篩選條件
const invCtx = {
  main:  { rootId: 'invoiceListRoot', filter: { from: '', to: '', q: '', status: '', pay: '', rep: '' }, scope: null },
  party: { rootId: 'invPartyRecordsRoot', filter: { from: '', to: '', q: '', status: '', pay: '', rep: '' }, scope: null, partyId: '' }
};
function invToday(){ return (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0, 10); }
function invCodGrace(){ const n = parseInt(invSettings.codGraceDays, 10); return Number.isFinite(n) && n >= 0 ? n : 7; }
// 一張 Invoice 的付款狀態:paid / partial / unpaid / overdue
// · 有 Due Date(Bank Transfer):過了 Due Date 且還有餘額 = overdue
// · COD:視為「到貨當天到期」,但有寬限天數(系統設置 → Invoice 格式,預設 7 天),過了寬限天數還沒收完才算 overdue
function invRowInfo(r){
  const gross = Number(r.total) || 0, credited = Math.min(Number(r.credited) || 0, gross);
  const total = Math.round((gross - credited) * 100) / 100;   // 扣掉 Credit Note 之後的應收金額
  const paid = Number(r.paid) || 0;                           // 不再截斷:Credit Note 扣完之後如果已收比應收多,就是「多收」
  const balance = Math.round((total - paid) * 100) / 100;    // 負數 = 多收(待退款)
  const due = r.payment_type === 'cod' ? invAddDays(r.invoice_date, invCodGrace()) : (r.due_date || r.invoice_date);
  let status;
  if(balance < -0.004) status = 'overpaid';
  else if(balance <= 0.004) status = 'paid';
  else if(due && invToday() > due) status = 'overdue';
  else status = paid > 0 ? 'partial' : 'unpaid';
  return { total, gross, credited, paid, balance, status, due };
}
function invStatusBadge(st){
  const col = { paid: ['#e7f6ec', '#1d7a3c'], partial: ['#fff4dc', '#9a6a00'], unpaid: ['#eef0f3', '#555'], overdue: ['#fde8e8', '#b42318'], overpaid: ['#efe6fb', '#6b3fa0'] }[st] || ['#eee', '#555'];
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;background:${col[0]};color:${col[1]};white-space:nowrap;">${invEsc(t('invSt_' + st))}</span>`;
}
async function invLoadList(force){
  if(!force && invList.length && !invListError) return;
  invListError = '';
  const base = 'id,invoice_no,order_id,order_no,party_id,customer,invoice_date,due_date,terms,payment_type,sale_rep,before_tax,tax,total,paid,currency';
  const run = cols => sb.from('invoices').select(cols).order('invoice_date', { ascending: false }).order('invoice_no', { ascending: false }).limit(5000);
  try{
    // change_count(Invoice 變更過幾次)需要先執行 sql/invoice_changes.sql;還沒執行就退回不帶這欄
    let { data, error } = await run(base + ',change_count,credited');
    if(error && (error.code === '42703' || /change_count|credited/.test(error.message || ''))) ({ data, error } = await run(base + ',change_count'));
    if(error && (error.code === '42703' || /change_count/.test(error.message || ''))) ({ data, error } = await run(base));
    if(error) throw error;
    invList = data || [];
  }catch(e){
    invList = [];
    invListError = (invIsMissingFn(e) && !/paid/.test(e.message || '')) ? 'sql' : ((e && (e.code === '42703' || /paid/.test(e.message || ''))) ? 'paysql' : 'error');
    if(invListError === 'error') console.error('讀取 Invoice 清單失敗', e);
  }
}
// 「隱藏 Invoice 功能」勾選/取消時,立刻更新畫面:Invoice 格式設定、Invoices 子分頁、已完成訂單的 Invoice 動作選單
function applyInvoiceFeatureVisibility(){
  const off = (typeof hideInvoiceEnabled !== 'undefined') && hideInvoiceEnabled;
  const card = document.getElementById('invoiceSettingsCard'); if(card) card.style.display = off ? 'none' : '';
  const sel = document.getElementById('accountingSubtabSelect');
  if(sel){
    const o = Array.from(sel.options).find(x => x.value === 'subtab-acc-invoices');
    if(o) o.hidden = o.disabled = off;
    if(off && sel.value === 'subtab-acc-invoices'){
      const tab = document.getElementById('tab-accounting');
      if(tab && tab.classList.contains('active-tab') && typeof switchAccountingSubTab === 'function') switchAccountingSubTab('subtab-price-setting');
      else sel.value = 'subtab-price-setting';
    }
  }
  if(off){ try{ invClosePartyRecords(); invClosePayments(); invCloseDetails(); invCloseModal(); }catch(e){} }
  try{ icApplyVisibility(); }catch(e){}
  try{ if(typeof renderOrders === 'function') renderOrders(); }catch(e){}
}
async function invOpenListPage(){
  if(!canCreateInvoice()) return;
  const root = document.getElementById(invCtx.main.rootId);
  if(root) root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  await invSyncOrders();   // 先把「別人改了訂單、Invoice 還沒跟上」的補上(例如倉庫管理員改的)
  await invLoadList(true);
  invRenderList('main');
}
function invFilteredList(key){
  const c = invCtx[key], f = c.filter, q = (f.q || '').trim().toLowerCase();
  return invList.filter(r => (!c.scope || c.scope(r))
    && (!f.from || r.invoice_date >= f.from) && (!f.to || r.invoice_date <= f.to)
    && (!f.pay || (f.pay === 'cod' ? r.payment_type === 'cod' : r.payment_type !== 'cod'))
    && (!f.rep || (r.sale_rep || '') === f.rep)
    && (!f.status || invRowInfo(r).status === f.status)
    && (!q || ['INV' + (r.invoice_no || ''), r.invoice_no, r.customer, r.order_no, r.sale_rep].join(' ').toLowerCase().includes(q)));
}
function invRenderList(key){
  key = key || 'main';
  const c = invCtx[key], root = document.getElementById(c.rootId);
  if(!root) return;
  if(invListError === 'sql'){ root.innerHTML = `<div class="empty-note">${t('invListNeedSql')}</div>`; return; }
  if(invListError === 'paysql'){ root.innerHTML = `<div class="empty-note">${t('invPayNeedSql')}</div>`; return; }
  if(invListError){ root.innerHTML = `<div class="empty-note">${t('invLoadFailed')}</div>`; return; }
  const f = c.filter;
  const scoped = invList.filter(r => !c.scope || c.scope(r));
  const reps = Array.from(new Set(scoped.map(r => r.sale_rep).filter(Boolean))).sort();
  const list = invFilteredList(key);
  const sum = list.reduce((a, r) => {
    const i = invRowInfo(r);
    a.b += Number(r.before_tax) || 0; a.t += Number(r.tax) || 0; a.g += i.total; a.p += i.paid; a.bal += i.balance;
    if(i.status === 'overdue'){ a.od += i.balance; a.odN++; }
    return a;
  }, { b: 0, t: 0, g: 0, p: 0, bal: 0, od: 0, odN: 0 });
  const showCust = key !== 'party';   // 出貨方的 Invoice 記錄整頁都是同一個客戶,不用再列客戶欄
  const rows = list.map(r => {
    const i = invRowInfo(r);
    const changed = Number(r.change_count) > 0;
    return `<tr>
      <td style="white-space:nowrap;cursor:pointer;" onclick="invOpenFromList('${invEsc(r.id)}')"><span class="batch-link">${invEsc(r.invoice_no)}</span></td>
      <td style="white-space:nowrap;">${invEsc(invIsoToDmy(r.invoice_date))}</td>
      ${showCust ? `<td>${invEsc(r.customer)}</td>` : ''}
      <td>${invOrderLinks(r.order_no)}</td>
      <td class="num"><b>${invMoney2(i.total)}</b></td>
      <td class="num">${invMoney2(i.paid)}</td><td class="num"><b>${invMoney2(i.balance)}</b></td>
      <td style="white-space:nowrap;">${invStatusBadge(i.status)}</td>
      <td style="white-space:nowrap;"><span class="del-link" onclick="invOpenPayments('${invEsc(r.id)}')">${t('invBtnPayments')}</span> <span class="batch-info-icon" style="margin-left:6px;" title="${invEsc(t('invBtnDetails'))}" onclick="invOpenDetails('${invEsc(r.id)}')">ⓘ</span>${changed ? `<span class="batch-info-icon" title="${invEsc(t('invChangedTip'))}" style="color:#b45309;font-size:15px;margin-left:6px;" onclick="invOpenDetails('${invEsc(r.id)}')">✎</span>` : ''}</td>
    </tr>`;
  }).join('');
  const sel = (id, val, opts) => `<select id="${id}" onchange="invOnListFilter('${key}')">${opts.map(o => `<option value="${invEsc(o[0])}" ${val === o[0] ? 'selected' : ''}>${invEsc(o[1])}</option>`).join('')}</select>`;
  const card = (label, val, warn) => `<div style="flex:1 1 130px;min-width:120px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;${warn ? 'border-color:#e8b4b0;background:#fdf3f2;' : ''}"><div style="font-size:11px;color:var(--ink-soft);">${label}</div><div style="font-size:16px;font-weight:700;">${val}</div></div>`;
  root.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
      ${card(t('invSumInvoiced') + ' (' + list.length + ')', invMoney2(sum.g))}
      ${card(t('invSumPaid'), invMoney2(sum.p))}
      ${card(t('invSumBalance'), invMoney2(sum.bal))}
      ${card(t('invSumOverdue') + ' (' + sum.odN + ')', invMoney2(sum.od), sum.odN > 0)}
    </div>
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('lblFromDate')}</label><input type="date" id="invFlt_${key}_from" value="${invEsc(f.from)}" onchange="invOnListFilter('${key}')" /></div>
      <div class="field"><label>${t('lblToDate')}</label><input type="date" id="invFlt_${key}_to" value="${invEsc(f.to)}" onchange="invOnListFilter('${key}')" /></div>
      <div class="field"><label>${t('invFltStatus')}</label>${sel('invFlt_' + key + '_status', f.status, [['', t('invFltAll')], ['unpaid', t('invSt_unpaid')], ['partial', t('invSt_partial')], ['paid', t('invSt_paid')], ['overdue', t('invSt_overdue')], ['overpaid', t('invSt_overpaid')]])}</div>
      <div class="field"><label>${t('invFltPayType')}</label>${sel('invFlt_' + key + '_pay', f.pay, [['', t('invFltAll')], ['bank', 'Bank Transfer'], ['cod', 'COD']])}</div>
      <div class="field"><label>Sale Rep</label>${sel('invFlt_' + key + '_rep', f.rep, [['', t('invFltAll')]].concat(reps.map(x => [x, x])))}</div>
      <div class="field" style="min-width:220px;"><label>${t('invFltSearch')}</label><input type="search" id="invFlt_${key}_q" value="${invEsc(f.q)}" oninput="invOnListFilter('${key}',true)" placeholder="${invEsc(t(key === 'party' ? 'invListSearchPhParty' : 'invListSearchPh'))}" /></div>
      <button class="btn ghost" onclick="invClearListFilter('${key}')" style="align-self:flex-end;">${t('btnClearFilter')}</button>
      <button class="btn ghost" onclick="invExportListXlsx('${key}')" style="align-self:flex-end;">${t('invExportList')}</button>
    </div>
    ${list.length === 0 ? `<div class="empty-note">${t('invListEmpty')}</div>` : `<div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">${t('invListClickHint')}</div>
    <div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>Invoice No</th><th>Invoice Date</th>${showCust ? `<th>${t('invColCustomer')}</th>` : ''}<th>${t('invColOrder')}</th><th class="num">${t('spTotalAmt')}</th><th class="num">${t('invColPaid')}</th><th class="num">${t('invColBalance')}</th><th>${t('invFltStatus')}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="font-weight:700;"><td colspan="${showCust ? 4 : 3}" style="text-align:right;">${t('invListTotals')} (${list.length})</td><td class="num">${invMoney2(sum.g)}</td><td class="num">${invMoney2(sum.p)}</td><td class="num">${invMoney2(sum.bal)}</td><td colspan="2"></td></tr></tfoot></table></div>`}`;
}
function invClearListFilter(key){
  invCtx[key].filter = { from: '', to: '', q: '', status: '', pay: '', rep: '' };
  invRenderList(key);
}
function invOnListFilter(key, typing){
  key = key || 'main';
  const g = n => (document.getElementById(`invFlt_${key}_${n}`) || {}).value || '';
  invCtx[key].filter = { from: g('from'), to: g('to'), q: g('q'), status: g('status'), pay: g('pay'), rep: g('rep') };
  if(!typing){ invRenderList(key); return; }
  // 輸入搜尋字時只重畫,保留輸入框的游標
  const pos = (document.getElementById(`invFlt_${key}_q`) || {}).selectionStart;
  invRenderList(key);
  const el = document.getElementById(`invFlt_${key}_q`); if(el){ el.focus(); try{ el.setSelectionRange(pos, pos); }catch(e){} }
}
function invRerenderLists(){
  invRenderList('main');
  if(document.getElementById(invCtx.party.rootId)) invRenderList('party');
}
async function invOpenFromList(id){
  try{ invShowModal(null, await invFetchSnapshot(id), true); }
  catch(e){ console.error('讀取 Invoice 失敗', e); showInfoModal(t('invLoadFailed')); }
}
function invExportListXlsx(key){
  key = key || 'main';
  if(typeof XLSX === 'undefined'){ showInfoModal(t('psImportNoXlsx')); return; }
  const list = invFilteredList(key);
  const aoa = [['Invoice No', 'Invoice Date', 'Customer', 'Order No', 'Terms', 'Due Date', 'Sale Rep', 'Sale Amt (Ex. GST)', 'GST', 'Total Amt (Inc. GST)', 'Paid', 'Balance Due', 'Status', 'Currency']]
    .concat(list.map(r => {
      const i = invRowInfo(r);
      return [r.invoice_no, r.invoice_date, r.customer, r.order_no, r.payment_type === 'cod' ? 'COD' : (r.terms ? r.terms + ' Days' : ''), r.payment_type === 'cod' ? '' : r.due_date, r.sale_rep, Number(r.before_tax), Number(r.tax), i.total, i.paid, i.balance, t('invSt_' + i.status), r.currency];
    }));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 8 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
  XLSX.writeFile(wb, `invoices_${invToday()}.xlsx`);
}

// ---------- 詳細資料視窗(清單上放不下的欄位 + 變更紀錄)----------
function invCloseDetails(){ const o = document.getElementById('invDetailsOverlay'); if(o) o.remove(); }
function invChangeDetailHtml(d){
  if(!d) return '';
  const q = n => (Number.isInteger(Number(n)) ? String(Number(n)) : invMoney2(n));
  const li = [];
  (d.added || []).forEach(x => li.push(`<li>${invEsc(t('invChAdded'))}: ${invEsc(x.desc)} × ${q(x.qty)} ${invEsc(x.unit || '')} @ ${invMoney2(x.price)}</li>`));
  (d.removed || []).forEach(x => li.push(`<li>${invEsc(t('invChRemoved'))}: ${invEsc(x.desc)} × ${q(x.qty)} ${invEsc(x.unit || '')}</li>`));
  (d.changed || []).forEach(x => {
    const parts = [];
    if(Number(x.qty[0]) !== Number(x.qty[1])) parts.push(`${invEsc(t('invChQty'))} ${q(x.qty[0])} → ${q(x.qty[1])}`);
    if(Number(x.price[0]) !== Number(x.price[1])) parts.push(`${invEsc(t('invChPrice'))} ${invMoney2(x.price[0])} → ${invMoney2(x.price[1])}`);
    li.push(`<li>${invEsc(x.desc)}: ${parts.join(', ') || invEsc(t('invChAmount'))}</li>`);
  });
  if(d.note) li.push(`<li>${invEsc(t('invChNote'))}: "${invEsc(d.note[0])}" → "${invEsc(d.note[1])}"</li>`);
  return li.length ? `<ul style="margin:3px 0 0 16px;padding:0;font-size:12px;">${li.join('')}</ul>` : '';
}
async function invOpenDetails(invoiceId){
  if(!canCreateInvoice()) return;
  try{
    const [{ data: inv, error: e1 }, cr] = await Promise.all([
      sb.from('invoices').select('*').eq('id', invoiceId).maybeSingle(),
      sb.from('invoice_changes').select('*').eq('invoice_id', invoiceId).order('changed_at', { ascending: false })
    ]);
    if(e1 || !inv) throw e1 || new Error('not found');
    const changes = cr.error ? [] : (cr.data || []);   // 變更紀錄表還沒建立就當作沒有
    let cnList = [];
    try{ const cq = await sb.from('credit_notes').select('id,cn_no,cn_date,total,return_status').eq('invoice_id', invoiceId).order('cn_date', { ascending: false }); cnList = cq.error ? [] : (cq.data || []); }catch(e){}
    const i = invRowInfo(inv);
    const row = (k, v) => `<tr><td style="color:var(--ink-soft);white-space:nowrap;vertical-align:top;">${k}</td><td>${v === '' || v === null || v === undefined ? '–' : v}</td></tr>`;
    const terms = inv.payment_type === 'cod' ? `COD (${invEsc(tf('invDtCodGrace', { n: invCodGrace() }))})` : (inv.terms ? invEsc(inv.terms) + ' Days' : '');
    const when = iso => { try{ return new Date(iso).toLocaleString(); }catch(e){ return iso || ''; } };
    const ov = document.createElement('div');
    ov.id = 'invDetailsOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
    ov.onclick = e => { if(e.target === ov) invCloseDetails(); };
    ov.innerHTML = `<div class="modal-box" style="max-width:min(640px,96vw);max-height:92vh;overflow:auto;">
      <div class="section-title" style="margin-top:0;">${invEsc(t('invDetailTitle'))} · ${invEsc(inv.invoice_no)}</div>
      <div style="font-size:12.5px;margin:0 0 8px;">${invEsc(inv.customer)} · ${invStatusBadge(i.status)}</div>
      <table class="stock-table"><tbody>
        ${row('Invoice Date', invEsc(invIsoToDmy(inv.invoice_date)))}
        ${row('Terms', terms)}
        ${row('Due Date', inv.payment_type === 'cod' ? '' : invEsc(invIsoToDmy(inv.due_date)))}
        ${row(t('invDtPayType'), inv.payment_type === 'cod' ? 'COD' : 'Bank Transfer')}
        ${row('Sale Rep', invEsc(inv.sale_rep))}
        ${row(t('invColOrder'), invOrderLinks(inv.order_no))}
        ${row(t('spSaleAmt'), invMoney2(inv.before_tax))}
        ${row(t('spGstAmt'), invMoney2(inv.tax))}
        ${row(t('spTotalAmt'), '<b>' + invMoney2(i.total) + '</b>')}
        ${Number(inv.credited) > 0 ? row(t('icCredited'), '(' + invMoney2(inv.credited) + ')') : ''}
        ${row(t('invColPaid'), invMoney2(i.paid))}
        ${row(t('invColBalance'), '<b>' + invMoney2(i.balance) + '</b>')}
        ${row(t('invDtCreated'), invEsc((inv.created_by || '') + (inv.created_at ? ' · ' + when(inv.created_at) : '')))}
      </tbody></table>
      ${cnList.length ? `<div style="margin-top:12px;font-size:12.5px;font-weight:700;">Credit Notes</div>${cnList.map(c => `<div style="padding:4px 0;border-top:1px solid var(--line);font-size:12px;"><span class="batch-link" onclick="invCloseDetails();icCnView('${invEsc(c.id)}')">${invEsc(c.cn_no)}</span> · ${invEsc(invIsoToDmy(c.cn_date))} · <b>(${invMoney2(c.total)})</b> · ${icRsBadge(c.return_status)}</div>`).join('')}` : ''}
      ${i.status === 'overpaid' ? `<div style="margin-top:12px;border:1px solid #cdb8ec;background:#f6f0fd;border-radius:8px;padding:8px 10px;font-size:12.5px;">
          <div style="font-weight:700;margin-bottom:4px;">${invEsc(t('invOverTitle'))}</div>
          <div>${invEsc(t('invOverGross'))}: ${invMoney2(i.gross)} − Credit Notes (${invMoney2(i.credited)}) = ${invEsc(t('invOverNet'))} <b>${invMoney2(i.total)}</b></div>
          <div>${invEsc(t('invColPaid'))}: <b>${invMoney2(i.paid)}</b> → ${invEsc(t('invOverAmount'))} <b>${invMoney2(-i.balance)}</b></div>
          <div style="margin-top:6px;"><button class="btn" onclick="invOpenRefund('${invEsc(inv.id)}')">${invEsc(t('invBtnRefund'))}</button></div>
        </div>` : ''}
      <div style="margin-top:12px;font-size:12.5px;font-weight:700;">${invEsc(t('invChangeTitle'))}</div>
      ${changes.length === 0 ? `<div class="empty-note" style="margin:4px 0;">${invEsc(t('invChangeNone'))}</div>` : changes.map(c => `<div style="padding:6px 0;border-top:1px solid var(--line);">
          <div style="font-size:12px;"><b>${invEsc(when(c.changed_at))}</b> · ${invEsc(c.changed_by || '')} · ${invEsc(t('invChTotal'))} ${invMoney2(c.before_total)} → <b>${invMoney2(c.after_total)}</b></div>
          ${invChangeDetailHtml(c.detail)}
        </div>`).join('')}
      <div class="modal-actions"><button class="btn ghost" onclick="invCloseDetails()">${t('btnClose')}</button></div>
    </div>`;
    document.body.appendChild(ov);
  }catch(e){
    console.error('讀取 Invoice 詳細資料失敗', e);
    showInfoModal(t('invLoadFailed'));
  }
}

// ---------- 客戶額度:用單獨的 Credit Note / 其他 Invoice 的多收金額,抵扣這張 Invoice 的未收 ----------
async function invCreditSources(row){
  const out = [];
  const same = (a) => (row.party_id && a.party_id === row.party_id) || (row.customer && a.customer === row.customer);
  try{
    let r = await sb.from('credit_notes').select('id,cn_no,total,applied,party_id,customer').is('invoice_id', null);
    if(r.error && r.error.code === '42703') r = await sb.from('credit_notes').select('id,cn_no,total,party_id,customer').is('invoice_id', null);
    (r.data || []).filter(same).forEach(c => { const av = Math.round((Number(c.total) - Number(c.applied || 0)) * 100) / 100; if(av > 0.004) out.push({ type: 'cn', id: c.id, label: `${c.cn_no} · ${t('invCreditAvail')} ${invMoney2(av)}`, avail: av }); });
  }catch(e){}
  await invLoadList(true);
  (invList || []).filter(x => x.id !== row.id && same(x)).forEach(x => {
    const i = invRowInfo(x);
    if(i.balance < -0.004) out.push({ type: 'invoice', id: x.id, label: `INV${x.invoice_no} · ${t('invOverAmount')} ${invMoney2(-i.balance)}`, avail: Math.round(-i.balance * 100) / 100 });
  });
  return out;
}
async function invOpenApplyCredit(){
  if(!invPay) return;
  const row = invPay.row;
  const paid = Math.round(invPay.payments.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
  const info = invRowInfo(Object.assign({}, row, { paid }));
  const srcs = await invCreditSources(row);
  if(!srcs.length){ showInfoModal(t('invNoCredit')); return; }
  window.invCreditCtx = { srcs, balance: info.balance };
  const old = document.getElementById('invApplyOverlay'); if(old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'invApplyOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1350';
  ov.innerHTML = `<div class="modal-box" style="max-width:400px;">
    <div class="section-title" style="margin-top:0;">${invEsc(t('invBtnApplyCredit'))} · ${invEsc(row.invoice_no)}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${invEsc(t('invApplyHint'))}</p>
    <label style="font-size:12px;">${invEsc(t('invCreditSource'))}</label>
    <select id="invApSrc" onchange="invApplySrcChange()" style="width:100%;box-sizing:border-box;margin-bottom:8px;">${srcs.map((s, i) => `<option value="${i}">${invEsc(s.label)}</option>`).join('')}</select>
    <label style="font-size:12px;">${invEsc(t('invPayDate'))}</label><input id="invApDate" type="date" value="${invToday()}" style="width:100%;box-sizing:border-box;margin-bottom:8px;" />
    <label style="font-size:12px;">${invEsc(t('invPayAmount'))}</label><input id="invApAmt" type="number" min="0" step="0.01" style="width:100%;box-sizing:border-box;" />
    <div id="invApMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('invApplyOverlay').remove()">${t('btnCancel')}</button><button class="btn" onclick="invApplyCreditDo()">${invEsc(t('invBtnApplyCredit'))}</button></div>
  </div>`;
  document.body.appendChild(ov);
  invApplySrcChange();
}
function invApplySrcChange(){
  const c = window.invCreditCtx; if(!c) return;
  const s = c.srcs[Number(document.getElementById('invApSrc').value)];
  const el = document.getElementById('invApAmt'); if(el && s) el.value = invMoney2(Math.min(s.avail, c.balance));
}
async function invApplyCreditDo(){
  const c = window.invCreditCtx; if(!c || !invPay) return;
  const msg = document.getElementById('invApMsg');
  const s = c.srcs[Number(document.getElementById('invApSrc').value)];
  const amt = Math.round(Number(document.getElementById('invApAmt').value) * 100) / 100;
  const date = document.getElementById('invApDate').value;
  if(!date){ msg.className = 'msg error'; msg.textContent = t('invPayBadDate'); return; }
  if(!s || !Number.isFinite(amt) || amt <= 0 || amt > s.avail + 0.004 || amt > c.balance + 0.004){ msg.className = 'msg error'; msg.textContent = t('invApplyBad'); return; }
  try{
    const { error } = await sb.rpc('invoice_apply_credit', { p_invoice_id: invPay.id, p_source_type: s.type, p_source_id: s.id, p_amount: amt, p_date: date });
    if(error) throw error;
    try{ logInventoryAction('order_edit', `Invoice ${invPay.row.invoice_no} - credit applied: ${invMoney2(amt)} (${s.label})`, invPay.row.invoice_no); }catch(e){}
    document.getElementById('invApplyOverlay').remove();
    invList = []; if(typeof icCnRows !== 'undefined') icCnRows = null;
    await invPayReload();
    try{ await invLoadList(true); invRerenderLists(); }catch(e){}
  }catch(e){
    console.error('額度抵扣失敗', e);
    msg.className = 'msg error';
    msg.textContent = invIsMissingFn(e) ? t('invPayNeedSql') : (/credit_exceeds|credit_source/.test((e && e.message) || '') ? t('invApplyBad') : t('invPaidFailed'));
  }
}

// ---------- 多收 → 退款(在收款記錄裡記一筆負數收款)----------
function invOpenRefund(invoiceId){
  
  const row = invList.find(x => x.id === invoiceId);
  // 以資料庫現況為準:重新讀一次這張 Invoice
  sb.from('invoices').select('id,invoice_no,total,paid,credited,payment_type,invoice_date').eq('id', invoiceId).maybeSingle().then(({ data, error }) => {
    if(error || !data){ showInfoModal(t('invLoadFailed')); return; }
    const i = invRowInfo(data), over = Math.round(-i.balance * 100) / 100;
    if(over <= 0){ showInfoModal(t('invRefundNone')); return; }
    const old = document.getElementById('invRefundOverlay'); if(old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'invRefundOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1300';
    ov.innerHTML = `<div class="modal-box" style="max-width:380px;">
      <div class="section-title" style="margin-top:0;">${invEsc(t('invBtnRefund'))} · ${invEsc(data.invoice_no)}</div>
      <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">${invEsc(t('invRefundHint'))}</p>
      <label style="font-size:12px;">${invEsc(t('invPayDate'))}</label><input id="invRfDate" type="date" value="${invToday()}" style="width:100%;box-sizing:border-box;margin-bottom:8px;" />
      <label style="font-size:12px;">${invEsc(t('invPayAmount'))}</label><input id="invRfAmt" type="number" min="0" step="0.01" value="${invMoney2(over)}" style="width:100%;box-sizing:border-box;margin-bottom:8px;" />
      <label style="font-size:12px;">${invEsc(t('invPayMethod'))}</label><select id="invRfMethod" style="width:100%;box-sizing:border-box;margin-bottom:8px;">${INV_PAY_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
      <input id="invRfNote" type="text" placeholder="${invEsc(t('colNote'))}" style="width:100%;box-sizing:border-box;" />
      <div id="invRfMsg" class="msg"></div>
      <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('invRefundOverlay').remove()">${t('btnCancel')}</button><button class="btn" onclick="invDoRefund('${invEsc(invoiceId)}',${over})">${invEsc(t('invBtnRefund'))}</button></div>
    </div>`;
    document.body.appendChild(ov);
  });
}
let invRefundCtx = null;
async function invDoRefund(invoiceId, maxAmt){
  const msg = document.getElementById('invRfMsg');
  const date = document.getElementById('invRfDate').value;
  const amt = Math.round(Number(document.getElementById('invRfAmt').value) * 100) / 100;
  if(!date){ msg.className = 'msg error'; msg.textContent = t('invPayBadDate'); return; }
  if(!Number.isFinite(amt) || amt <= 0 || amt > maxAmt + 0.004){ msg.className = 'msg error'; msg.textContent = t('invRefundBad'); return; }
  try{
    const { error } = await sb.rpc('invoice_refund', { p_invoice_id: invoiceId, p_date: date, p_amount: amt, p_method: document.getElementById('invRfMethod').value, p_note: (document.getElementById('invRfNote').value || '').trim() });
    if(error) throw error;
    try{ logInventoryAction('order_edit', `Invoice ${invoiceId} - refund ${invMoney2(amt)}`, ''); }catch(e){}
    document.getElementById('invRefundOverlay').remove();
    invCloseDetails();
    invList = [];
    await invLoadList(true);
    try{ invRerenderLists(); }catch(e){}
    invOpenDetails(invoiceId);
  }catch(e){
    console.error('退款失敗', e);
    msg.className = 'msg error';
    msg.textContent = invIsMissingFn(e) ? t('invPayNeedSql') : (/refund_exceeds/.test((e && e.message) || '') ? t('invRefundBad') : t('invPaidFailed'));
  }
}

// ---------- 收款記錄視窗 ----------
let invPay = null;   // { id, row, payments:[], editingId }
function invClosePayments(){ const o = document.getElementById('invPaymentsOverlay'); if(o) o.remove(); invPay = null; }
async function invOpenPayments(invoiceId){
  if(!canCreateInvoice()) return;
  try{
    const selInv = cols => sb.from('invoices').select(cols).eq('id', invoiceId).maybeSingle();
    const [{ data: inv, error: e1 }, { data: pays, error: e2 }] = await Promise.all([
      selInv('id,invoice_no,customer,party_id,invoice_date,due_date,payment_type,terms,total,paid,credited').then(r => (r.error && r.error.code === '42703') ? selInv('id,invoice_no,customer,party_id,invoice_date,due_date,payment_type,terms,total,paid') : r),
      sb.from('invoice_payments').select('*').eq('invoice_id', invoiceId).order('pay_date', { ascending: true }).order('created_at', { ascending: true })
    ]);
    if(e1 || e2 || !inv) throw e1 || e2 || new Error('not found');
    invPay = { id: invoiceId, row: inv, payments: pays || [], editingId: null };
    invRenderPayments();
  }catch(e){
    console.error('讀取收款記錄失敗', e);
    showInfoModal(invIsMissingFn(e) || (e && e.code === '42703') ? t('invPayNeedSql') : t('invLoadFailed'));
  }
}
function invRenderPayments(){
  if(!invPay) return;
  let ov = document.getElementById('invPaymentsOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'invPaymentsOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
    ov.onclick = e => { if(e.target === ov) invClosePayments(); };
    document.body.appendChild(ov);
  }
  const r = invPay.row;
  const paid = Math.round(invPay.payments.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
  const info = invRowInfo(Object.assign({}, r, { paid }));
  const total = info.total;   // 扣掉 Credit Note 之後的應收
  const ed = invPay.payments.find(p => p.id === invPay.editingId) || null;
  const dateV = ed ? ed.pay_date : invToday();
  const amtV = ed ? invMoney2(ed.amount) : (info.balance > 0 ? invMoney2(info.balance) : '');
  const defMethod = r.payment_type === 'cod' ? 'Cash' : 'Bank Transfer';
  const methodV = ed ? ((ed.method && ed.method !== 'Paid Today') ? ed.method : defMethod) : defMethod;   // 舊記錄的「Paid Today」不再是選項,編輯時請改選實際的付款方式
  const methods = INV_PAY_METHODS.concat(methodV && !INV_PAY_METHODS.includes(methodV) ? [methodV] : []);
  const rows = invPay.payments.map(p => `<tr>
      <td style="white-space:nowrap;">${invEsc(invIsoToDmy(p.pay_date))}</td>
      <td class="num">${invMoney2(p.amount)}</td>
      <td>${invEsc(p.method || '')}</td>
      <td>${invEsc(p.note || '')}<div style="font-size:10.5px;color:var(--ink-soft);">${invEsc(p.created_by || '')}</div></td>
      <td style="white-space:nowrap;text-align:right;">${(Number(p.amount) < 0 || p.credit_cn_id || p.pair_payment_id) ? '' : `<span class="del-link" onclick="invPayEdit('${invEsc(p.id)}')" style="margin-right:6px;">${t('btnEdit')}</span>`}<span class="del-link" onclick="invPayDelete('${invEsc(p.id)}')">${t('btnDelete')}</span></td>
    </tr>`).join('');
  ov.innerHTML = `<div class="modal-box" style="max-width:min(640px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('invPayTitle')} · ${invEsc(r.invoice_no)}</div>
    <div style="font-size:12.5px;margin:0 0 8px;">${invEsc(r.customer)} · ${invStatusBadge(info.status)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
      <div style="flex:1 1 110px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;"><div style="font-size:11px;color:var(--ink-soft);">Total Amt</div><b>${invMoney2(total)}</b></div>
      <div style="flex:1 1 110px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${t('invColPaid')}</div><b>${invMoney2(paid)}</b></div>
      <div style="flex:1 1 110px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${t('invColBalance')}</div><b>${invMoney2(info.balance)}</b></div>
    </div>
    ${invPay.payments.length === 0 ? `<div class="empty-note" style="margin:6px 0;">${t('invPayEmpty')}</div>` : `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('invPayDate')}</th><th class="num">${t('invPayAmount')}</th><th>${t('invPayMethod')}</th><th>${t('colNote')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">
      <div style="font-size:12.5px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">${ed ? t('invPayEditTitle') : t('invPayAddTitle')}${!ed && info.balance > 0.004 ? `<button class="btn ghost" style="font-weight:400;" onclick="invOpenApplyCredit()">${invEsc(t('invBtnApplyCredit'))}</button>` : ''}</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;">
        <div class="field"><label>${t('invPayDate')}</label><input type="date" id="invPayDate" value="${invEsc(dateV)}" /></div>
        <div class="field"><label>${t('invPayAmount')}</label><input type="number" id="invPayAmount" min="0.01" step="0.01" value="${invEsc(amtV)}" placeholder="0.00" /></div>
        <div class="field"><label>${t('invPayMethod')}</label><select id="invPayMethod">${methods.map(m => `<option value="${invEsc(m)}" ${m === methodV ? 'selected' : ''}>${invEsc(m)}</option>`).join('')}</select></div>
        <div class="field"><label>${t('colNote')}</label><input type="text" id="invPayNote" value="${invEsc(ed ? (ed.note || '') : '')}" /></div>
      </div>
      <div id="invPayMsg" class="msg"></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="invClosePayments()">${t('btnClose')}</button>
      ${ed ? `<button class="btn ghost" onclick="invPay.editingId=null;invRenderPayments()">${t('btnCancel')}</button>` : ''}
      <button class="btn" onclick="invPaySave()">${ed ? t('btnSave') : t('invPayAddBtn')}</button>
    </div>
  </div>`;
}
function invPayEdit(id){ if(invPay){ invPay.editingId = id; invRenderPayments(); } }
async function invPayReload(){
  if(!invPay) return;
  const id = invPay.id;
  const { data: pays } = await sb.from('invoice_payments').select('*').eq('invoice_id', id).order('pay_date', { ascending: true }).order('created_at', { ascending: true });
  invPay.payments = pays || [];
  invPay.editingId = null;
  const paid = Math.round(invPay.payments.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
  invPay.row.paid = paid;
  const lr = invList.find(x => x.id === id); if(lr) lr.paid = paid;
  // 如果 Invoice 預覽視窗正開著同一張,一併更新(Paid / Balance Due)
  if(invModal && invModal.snap && invModal.snap.id === id){
    invModal.snap.paid = paid;
    const host = document.getElementById('invPreviewHost');
    if(host){ host.innerHTML = invDocHtml(invModal.snap, invSettings.logo); invFitPages(host, 'pdf'); }
  }
  invRenderPayments();
  invRerenderLists();
}
async function invPaySave(){
  if(!invPay) return;
  const msg = document.getElementById('invPayMsg');
  const date = (document.getElementById('invPayDate') || {}).value;
  const amt = Math.round(Number((document.getElementById('invPayAmount') || {}).value) * 100) / 100;
  const method = (document.getElementById('invPayMethod') || {}).value || '';
  const note = ((document.getElementById('invPayNote') || {}).value || '').trim();
  if(!date){ msg.className = 'msg error'; msg.textContent = t('invPayBadDate'); return; }
  if(!Number.isFinite(amt) || amt <= 0){ msg.className = 'msg error'; msg.textContent = t('invPayBadAmount'); return; }
  const others = invPay.payments.filter(p => p.id !== invPay.editingId).reduce((s, p) => s + Number(p.amount), 0);
  const allSum = invPay.payments.reduce((s, p) => s + Number(p.amount), 0);
  const netTotal = Number(invPay.row.total) - Number(invPay.row.credited || 0);
  if(others + amt > Math.max(netTotal, allSum) + 0.004){ msg.className = 'msg error'; msg.textContent = t('invPaidTooMuch'); return; }
  try{
    const { error } = await sb.rpc('invoice_payment_save', { p_invoice_id: invPay.id, p_payment_id: invPay.editingId, p_date: date, p_amount: amt, p_method: method, p_note: note });
    if(error) throw error;
    try{ logInventoryAction('order_edit', `Invoice ${invPay.row.invoice_no} - payment ${invPay.editingId ? 'edited' : 'added'}: ${invMoney2(amt)} (${method})`, invPay.row.invoice_no); }catch(e){}
    await invPayReload();
  }catch(e){
    console.error('儲存收款失敗', e);
    msg.className = 'msg error';
    msg.textContent = invIsMissingFn(e) ? t('invPayNeedSql') : (/invoice_bad_paid/.test((e && e.message) || '') ? t('invPaidTooMuch') : t('invPaidFailed'));
  }
}
async function invPayDelete(paymentId){
  if(!invPay) return;
  const p = invPay.payments.find(x => x.id === paymentId); if(!p) return;
  const ov = document.createElement('div');
  ov.id = 'invPayDelOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1300';
  ov.innerHTML = `<div class="modal-box" style="max-width:380px;"><p style="margin:0 0 6px;">${invEsc(tf('invPayDeleteConfirm', { amount: invMoney2(p.amount), date: invIsoToDmy(p.pay_date) }))}</p>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('invPayDelOverlay').remove()">${t('btnCancel')}</button><button class="btn danger" onclick="document.getElementById('invPayDelOverlay').remove();invPayDeleteDo('${invEsc(paymentId)}')">${t('btnDelete')}</button></div></div>`;
  document.body.appendChild(ov);
}
async function invPayDeleteDo(paymentId){
  if(!invPay) return;
  const p = invPay.payments.find(x => x.id === paymentId); if(!p) return;
  try{
    const { error } = await sb.rpc('invoice_payment_delete', { p_payment_id: paymentId });
    if(error) throw error;
    try{ logInventoryAction('order_edit', `Invoice ${invPay.row.invoice_no} - payment deleted: ${invMoney2(p.amount)}`, invPay.row.invoice_no); }catch(e){}
    invList = [];   // 轉入 / 轉出的收款會連動另一張 Invoice,清單重新讀取
    await invPayReload();
  }catch(e){
    console.error('刪除收款失敗', e);
    const msg = document.getElementById('invPayMsg'); if(msg){ msg.className = 'msg error'; msg.textContent = t('invPaidFailed'); }
  }
}

// ---------- 出貨方管理 → 這個出貨方的 Invoice 記錄 ----------
const invNormName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function invClosePartyRecords(){ const o = document.getElementById('invPartyRecordsOverlay'); if(o) o.remove(); }
async function invOpenPartyRecords(partyId){
  if(!canCreateInvoice()) { showInfoModal(t('invForbidden')); return; }
  const sp = shippingParties.find(x => x.id === partyId);
  if(!sp) return;
  // 比對規則:Invoice 存的 party_id 等於這個出貨方;舊 Invoice 沒有 party_id 時,用客戶名稱(公司名稱或出貨方名稱)比對
  const names = new Set([sp.companyName, sp.name].map(invNormName).filter(Boolean));
  invCtx.party.partyId = partyId;
  invCtx.party.filter = { from: '', to: '', q: '', status: '', pay: '', rep: '' };
  invCtx.party.scope = r => r.party_id ? r.party_id === partyId : names.has(invNormName(r.customer));
  invClosePartyRecords();
  const ov = document.createElement('div');
  ov.id = 'invPartyRecordsOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  ov.onclick = e => { if(e.target === ov) invClosePartyRecords(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:min(1100px,97vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${invEsc(sp.name)}${sp.code ? ' (' + invEsc(sp.code) + ')' : ''} · ${t('invPartyRecordsTitle')}</div>
    <div id="${invCtx.party.rootId}"><div class="empty-note">${t('batchLoading')}</div></div>
    <div class="modal-actions"><button class="btn ghost" onclick="invClosePartyRecords()">${t('btnClose')}</button></div>
  </div>`;
  document.body.appendChild(ov);
  await invLoadList(true);
  invRenderList('party');
}

// ============================================================
// 備份 / 還原 / 清除全部資料(只有管理者;資料表沒建立時略過)
// ============================================================
async function invExportForBackup(){
  try{
    const { data, error } = await sb.from('invoices').select('*').order('invoice_no', { ascending: true }).limit(100000);
    if(error) throw error;
    const pr = await sb.from('invoice_payments').select('*').order('created_at', { ascending: true }).limit(200000);
    const payments = pr.error ? [] : (pr.data || []);   // 收款表還沒建立(沒執行 invoice_payments.sql)時,備份裡就沒有收款
    const cr = await sb.from('invoice_changes').select('*').order('id', { ascending: true }).limit(200000);
    const changes = cr.error ? [] : (cr.data || []);    // 變更紀錄表還沒建立(沒執行 invoice_changes.sql)時,備份裡就沒有變更紀錄
    const creditNotes = (typeof icCnExportForBackup === 'function') ? await icCnExportForBackup() : null;   // Credit Note 表還沒建立時為 null
    let settings = null;   // Invoice 格式(公司資料、銀行資料、Logo 等)
    try{ const sr = await dbGet('invoiceSettings'); settings = sr && sr.value ? sr.value : null; }catch(e){}
    return { invoices: data || [], payments, changes, creditNotes, settings, next: await invGetNextNo() };
  }catch(e){
    if(invIsMissingFn(e)) return null;
    throw e;
  }
}
async function invRestoreFromBackup(backup){
  const d = backup && backup.invoiceData;
  if(!d || !Array.isArray(d.invoices)) return;
  const args = { p_rows: d.invoices, p_next: d.next || 1, p_payments: Array.isArray(d.payments) ? d.payments : [] };
  let { error } = await sb.rpc('invoice_restore_all', Object.assign({ p_changes: Array.isArray(d.changes) ? d.changes : [] }, args));
  if(error && invIsMissingFn(error)) ({ error } = await sb.rpc('invoice_restore_all', args));   // 還沒執行 invoice_changes.sql:用舊版函式還原(不含變更紀錄)
  if(error && !invIsMissingFn(error)) throw error;
  if(typeof icCnRestoreFromBackup === 'function'){
    // 舊備份沒有 Credit Note 資料時,要把現有的清掉(否則還原 Invoice 後它們會變成沒有對應 Invoice 的獨立 Credit Note)
    if(d.creditNotes) await icCnRestoreFromBackup(d.creditNotes); else if(typeof icCnClearAll === 'function') await icCnClearAll();
  }
  if(typeof d.settings === 'string' && d.settings){
    try{ await dbSet('invoiceSettings', d.settings); await loadInvoiceSettings(); }catch(e){ console.error(e); }
  }
}
async function invClearAll(){
  const { error } = await sb.rpc('invoice_clear_all');
  if(error && !invIsMissingFn(error)) throw error;
  if(typeof icCnClearAll === 'function') await icCnClearAll();
}


// 發票清單 / 詳細資料裡的訂單號:點下去跳到該訂單(待處理 → 訂貨後台管理;已完成 → 歷史紀錄的已完成訂單)
function invOrderLinks(orderNo){
  const parts = String(orderNo || '').split(/\s*,\s*/).filter(Boolean);
  if(!parts.length) return '';
  return parts.map(no => {
    const o = (typeof orders !== 'undefined' ? orders : []).find(x => x.orderNo === no);
    return o ? `<span class="batch-link" onclick="invGotoOrder('${invEsc(o.id)}')">${invEsc(no)}</span>` : invEsc(no);
  }).join(', ');
}
function invGotoOrder(orderId){
  const o = orders.find(x => x.id === orderId);
  if(!o) return;
  try{ if(typeof invCloseDetails === 'function') invCloseDetails(); }catch(e){}
  expandedOrderIds.add(orderId);
  if(isPreVerificationStatus(o) && !o.deleted){
    switchTab('tab-order-admin');
    switchOrderAdminSubTab('subtab-order-pending');
    ['pendingOrderPartyFilter','pendingOrderDateFrom','pendingOrderDateTo'].forEach(id => { const e = document.getElementById(id); if(e) e.value = ''; });
    renderPendingOrders();
  } else {
    switchTab('tab-log');
    const sel = document.getElementById('logSubtabSelect'); if(sel) sel.value = 'subtab-log-completed';
    switchLogSubTab('subtab-log-completed');
    const pf = document.getElementById('completedOrderPartyFilter'); if(pf) pf.value = '';
    const df = document.getElementById('completedOrderDateFrom'); if(df) df.value = '';
    const dt = document.getElementById('completedOrderDateTo'); if(dt) dt.value = '';
    renderOrders();
  }
  setTimeout(() => {
    const el = document.querySelector(`.tab-content.active .order-card[data-oid="${orderId}"], .order-card[data-oid="${orderId}"]`);
    if(!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const old = el.style.boxShadow; el.style.boxShadow = '0 0 0 3px var(--yellow, #e5a02f)';
    setTimeout(() => { el.style.boxShadow = old; }, 2500);
  }, 150);
}

// 複製文字到剪貼簿,圖示暫時變成 ✓
function invCopyText(text, el){
  const done = () => { if(!el) return; const o = el.textContent; el.textContent = '✓'; setTimeout(() => { el.textContent = o; }, 1200); };
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); }catch(e){} ta.remove(); done(); };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
