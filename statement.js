// ============================================================
// Statement(客戶對帳單)— 會計 > Statement
//   · 選出貨方 + Statement 日期(預設本月底),即時由 Invoice / 付款 / Credit Note 算出,不另存
//   · 每張 Invoice:Invoice 行(+)、縮排的付款與已套用的 Credit Note(−,各自的日期)、Balance 行
//   · 單獨且未用完的 Credit Note 放在底部 Unapplied Credits,從應付總額扣除
//   · 帳齡依到期日:Current / 1-30 / 31-60 / 61-90 / 90+,另有 Credit 欄
//   · 預設只列未付清的 Invoice;可勾選一併列出期間內已付清的
// ============================================================
let stmtState = { key: '', asOf: '', incPaid: false, from: '' };
let stmtData = null;   // 最近一次算出的結果

function stmtMonthEnd(){
  const iso = invToday(); const m = /^(\d{4})-(\d{2})/.exec(iso);
  const d = new Date(Date.UTC(+m[1], +m[2], 0));
  return `${d.getUTCFullYear()}-${invPad(d.getUTCMonth() + 1)}-${invPad(d.getUTCDate())}`;
}
function stmtKeyOf(r){
  const sp = invPartyOf(r);
  if(sp) return 'p:' + sp.id;
  return 'n:' + invNormName(r.customer);
}
function stmtDaysBetween(a, b){   // b - a(天)
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a || ''), pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b || '');
  if(!pa || !pb) return 0;
  return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
}
const stmtR2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// 括號表示負數
const stmtMoney = n => { const v = stmtR2(n); return v < 0 ? '(' + invMoney2(-v) + ')' : invMoney2(v); };

async function stmtOpenPage(){
  const root = document.getElementById('statementRoot'); if(!root) return;
  if(!canCreateInvoice()){ root.innerHTML = ''; return; }
  if(!stmtState.asOf) stmtState.asOf = stmtMonthEnd();
  if(!stmtState.from) stmtState.from = stmtState.asOf.slice(0, 8) + '01';
  root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  await invLoadList(true);
  stmtRenderForm();
  stmtOpenLog();
}
function stmtCustomers(){
  const m = new Map();
  (invList || []).forEach(r => { const k = stmtKeyOf(r); if(!m.has(k)) m.set(k, invCustLabel(r) || r.customer || '—'); });
  return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
}
function stmtRenderForm(){
  const root = document.getElementById('statementRoot'); if(!root) return;
  const opts = stmtCustomers().map(([k, l]) => `<option value="${invEsc(k)}" ${k === stmtState.key ? 'selected' : ''}>${invEsc(l)}</option>`).join('');
  root.innerHTML = `<div class="toolbar" style="margin:0 0 10px;gap:8px;justify-content:flex-start;">
      <button class="btn" id="stmtBtnLog" onclick="stmtOpenLog()">${t('stmtLog')}</button>
      <button class="btn ghost" id="stmtBtnNew" onclick="stmtShowNewForm()">${t('stmtCreateNew')}</button>
    </div>
    <div id="stmtOut"></div>`;
}
// Create new statement:選出貨方 + 日期 + 是否列出已付清,按預覽才跳出 PDF 視窗
function stmtShowNewForm(){
  const out = document.getElementById('stmtOut'); if(!out) return;
  const opts = stmtCustomers().map(([k, l]) => `<option value="${invEsc(k)}" ${k === stmtState.key ? 'selected' : ''}>${invEsc(l)}</option>`).join('');
  const lb = document.getElementById('stmtBtnLog'), nb = document.getElementById('stmtBtnNew');
  if(lb) lb.className = 'btn ghost'; if(nb) nb.className = 'btn';
  out.innerHTML = `<div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;align-items:end;">
      <div class="field"><label>${t('icFieldParty')}</label><select id="stmtParty" onchange="stmtState.key=this.value"><option value="">—</option>${opts}</select></div>
      <div class="field"><label>${t('stmtAsOf')}</label><input type="date" id="stmtAsOf" value="${invEsc(stmtState.asOf)}" onchange="stmtState.asOf=this.value" /></div>
      <div style="display:flex;align-items:center;gap:8px;padding-bottom:8px;"><input type="checkbox" id="stmtIncPaid" style="width:auto;margin:0;flex:0 0 auto;" ${stmtState.incPaid ? 'checked' : ''} onchange="stmtState.incPaid=this.checked;stmtShowNewForm()" /><label for="stmtIncPaid" style="margin:0;text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:400;cursor:pointer;">${t('stmtIncPaid')}</label></div>
      ${stmtState.incPaid ? `<div class="field"><label>${t('stmtPaidFrom')}</label><input type="date" id="stmtFrom" value="${invEsc(stmtState.from)}" onchange="stmtState.from=this.value" /></div>` : ''}
    </div>
    <div style="margin:10px 0;"><button class="btn" onclick="stmtCreate()">${t('stmtCreateNew')}</button></div>
    <div id="stmtNewMsg" class="msg"></div>`;
}
async function stmtFetchPayments(ids){
  const out = [];
  for(let i = 0; i < ids.length; i += 80){
    const { data, error } = await sb.from('invoice_payments').select('id,invoice_id,pay_date,amount,method,note,credit_cn_id,pair_payment_id,created_at').in('invoice_id', ids.slice(i, i + 80));
    if(error) throw error;
    (data || []).forEach(x => out.push(x));
  }
  return out;
}
async function stmtFetchCreditNotes(){
  const q = cols => sb.from('credit_notes').select(cols).order('cn_date', { ascending: true }).limit(5000);
  const c0 = 'id,cn_no,invoice_id,invoice_no,party_id,customer,cn_date,total';
  let { data, error } = await q(c0 + ',applied');
  if(error && error.code === '42703') ({ data, error } = await q(c0));
  if(error) throw error;
  return data || [];
}
async function stmtBuild(){
  const key = stmtState.key, asOf = stmtState.asOf;
  if(!key || !asOf) return null;
  const invs = (invList || []).filter(r => stmtKeyOf(r) === key);
  const [cns, pays] = await Promise.all([stmtFetchCreditNotes(), stmtFetchPayments(invs.map(r => r.id))]);
  const myCns = cns.filter(c => stmtKeyOf(c) === key && (c.cn_date || '') <= asOf);
  return stmtCompute(key, invs, myCns, pays, asOf);
}
// 同一個出貨方最近一張已存的 Statement
async function stmtLatestOf(d){
  let q = sb.from('statements').select('st_no,as_of').order('as_of', { ascending: false }).order('created_at', { ascending: false }).limit(1);
  q = d.partyId ? q.eq('party_id', d.partyId) : q.eq('customer', d.name);
  const r = await q;
  if(r.error) throw r.error;
  return (r.data && r.data[0]) || null;
}
async function stmtCreate(){
  const msg = document.getElementById('stmtNewMsg');
  const bad = k => { if(msg){ msg.className = 'msg error'; msg.textContent = t(k); } };
  if(!stmtState.key) return bad('stmtPickFirst');
  if(!stmtState.asOf) return bad('invPayBadDate');
  if(msg){ msg.className = 'msg'; msg.textContent = t('batchLoading'); }
  try{
    const d = await stmtBuild();
    if(!d) return bad('stmtPickFirst');
    const last = await stmtLatestOf(d);
    if(last && last.as_of && stmtState.asOf < last.as_of){
      if(msg){ msg.textContent = ''; }
      showInfoModal(tf('stmtDateBefore', { date: invIsoToDmy(last.as_of), no: last.st_no }));
      return;
    }
    if(msg){ msg.textContent = ''; }
    stmtData = d;
    stmtShowModal(false);
  }catch(e){
    console.error('Statement 讀取失敗', e);
    if(msg){ msg.className = 'msg error'; msg.textContent = invIsMissingFn(e) ? t('icNeedSqlCn') : t('invLoadFailed'); }
  }
}
// PDF 預覽視窗:新增(取消/列印/儲存 PDF/確認新增)或從紀錄開啟(關閉/登記付款/列印/儲存 PDF)
function stmtCloseModal(){ const o = document.getElementById('stmtDocOverlay'); if(o) o.remove(); }
function stmtShowModal(saved){
  stmtCloseModal();
  const d = stmtData; if(!d) return;
  const ov = document.createElement('div');
  ov.id = 'stmtDocOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  const canPay = saved && !d._paidAt;
  ov.innerHTML = `<div class="modal-box" style="max-width:min(1040px,98vw);max-height:94vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${saved ? 'Statement · ' + invEsc(stmtRef(d)) : t('stmtCreateNew')}</div>
    <div style="overflow:auto;border:1px solid var(--line);background:#eee;padding:8px;"><div id="stmtPreviewHost" style="zoom:1.1;">${stmtDocHtml(d)}</div></div>
    <div id="stmtModalMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="stmtCloseModal()">${saved ? t('btnClose') : t('btnCancel')}</button>
      ${canPay ? `<button class="btn ghost" onclick="stmtCloseModal();stmtOpenPay()">${t('stmtRecordPay')}</button>` : ''}
      <button class="btn ghost" onclick="stmtPrint()">${t('invBtnPrint')}</button>
      <button class="btn ${saved ? '' : 'ghost'}" onclick="stmtSavePdf()">${t('invBtnSavePdf')}</button>
      ${saved ? '' : `<button class="btn" id="stmtConfirmBtn" onclick="stmtConfirmNew()">${t('stmtConfirmAdd')}</button>`}
    </div>
  </div>`;
  document.body.appendChild(ov);
}
async function stmtConfirmNew(){
  const btn = document.getElementById('stmtConfirmBtn'); if(btn) btn.disabled = true;
  if(!(await stmtEnsureSaved())){ if(btn) btn.disabled = false; return; }
  stmtCloseModal();
  await stmtOpenLog();
}
function stmtFileName(d){ return `Statement_${(d.stNo || String(d.name || '').replace(/[^\w]+/g, '_'))}_${d.asOf}.pdf`; }
async function stmtPdfBlob(snap){
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;';
  holder.innerHTML = stmtDocHtml(snap);
  document.body.appendChild(holder);
  try{
    return await html2pdf().set({
      margin: 0, image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr'] }
    }).from(holder.firstElementChild).outputPdf('blob');
  } finally { holder.remove(); }
}
async function stmtSavePdf(){
  if(!stmtData) return;
  const msg = document.getElementById('stmtModalMsg');
  if(typeof html2pdf === 'undefined'){ if(msg){ msg.className = 'msg error'; msg.textContent = t('invPdfLibMissing'); } return; }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;';
  holder.innerHTML = stmtDocHtml(stmtData);
  document.body.appendChild(holder);
  try{
    await html2pdf().set({
      margin: 0, filename: stmtFileName(stmtData), image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr'] }
    }).from(holder.firstElementChild).save();
  }catch(e){ console.error('產生 PDF 失敗', e); if(msg){ msg.className = 'msg error'; msg.textContent = t('invPdfFailed'); } }
  holder.remove();
}
function stmtCompute(key, invs, cns, pays, asOf){
  const cnById = {}; cns.forEach(c => { cnById[c.id] = c; });
  const from = stmtState.incPaid ? stmtState.from : '';
  const blocks = [];
  invs.filter(r => (r.invoice_date || '') <= asOf).forEach(r => {
    const gross = Number(r.total) || 0;
    const ev = [];
    cns.filter(c => c.invoice_id === r.id).forEach(c => ev.push({ date: c.cn_date, sort: '1' + (c.cn_no || ''), kind: 'cn', text: `Credit Note ${c.cn_no} applied to INV${r.invoice_no}`, amount: -(Number(c.total) || 0) }));
    pays.filter(p => p.invoice_id === r.id && (p.pay_date || '') <= asOf).forEach(p => {
      const cn = p.credit_cn_id ? (cnById[p.credit_cn_id] || null) : null;
      const text = p.credit_cn_id ? `Credit Note ${cn ? cn.cn_no : ''} applied` : `Payment${p.method ? ' - ' + p.method : ''}${p.note ? ' (' + p.note + ')' : ''}`;
      ev.push({ date: p.pay_date, sort: '2' + (p.created_at || ''), kind: p.credit_cn_id ? 'cn' : 'pay', text, amount: -(Number(p.amount) || 0) });
    });
    ev.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.sort.localeCompare(b.sort));
    const balance = stmtR2(gross + ev.reduce((s, e) => s + e.amount, 0));
    const due = r.payment_type === 'cod' ? invAddDays(r.invoice_date, invCodGrace()) : (r.due_date || r.invoice_date);
    const lastAct = ev.reduce((m, e) => (e.date || '') > m ? e.date : m, r.invoice_date || '');
    const open = Math.abs(balance) > 0.004;
    if(!open && !(from && lastAct >= from && lastAct <= asOf)) return;
    blocks.push({ r, gross, ev, balance, due });
  });
  blocks.sort((a, b) => (a.r.invoice_date || '').localeCompare(b.r.invoice_date || '') || String(a.r.invoice_no).localeCompare(String(b.r.invoice_no)));
  // 單獨的 Credit Note:截至 asOf 還沒用掉的額度
  const unapplied = [];
  cns.filter(c => !c.invoice_id).forEach(c => {
    const used = pays.filter(p => p.credit_cn_id === c.id && (p.pay_date || '') <= asOf).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const avail = stmtR2((Number(c.total) || 0) - used);
    if(avail > 0.004) unapplied.push({ c, avail });
  });
  // 帳齡(依到期日)
  const ag = { cur: 0, d30: 0, d60: 0, d90: 0, d91: 0, credit: 0 };
  blocks.forEach(b => {
    if(b.balance < -0.004){ ag.credit += -b.balance; return; }
    if(b.balance <= 0.004) return;
    const days = stmtDaysBetween(b.due, asOf);
    const k = days <= 0 ? 'cur' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'd91';
    ag[k] += b.balance;
  });
  unapplied.forEach(u => { ag.credit += u.avail; });
  Object.keys(ag).forEach(k => { ag[k] = stmtR2(ag[k]); });
  const total = stmtR2(ag.cur + ag.d30 + ag.d60 + ag.d90 + ag.d91 - ag.credit);
  const first = invs[0];
  const sp0 = first ? invPartyOf(first) : null;
  const keep = o => ({ id: o.id, invoice_no: o.invoice_no, invoice_date: o.invoice_date, order_no: o.order_no });
  return { key, asOf, blocks: blocks.map(b => Object.assign({}, b, { r: keep(b.r) })), unapplied: unapplied.map(u => ({ c: { id: u.c.id, cn_no: u.c.cn_no, cn_date: u.c.cn_date }, avail: u.avail })), ag, total, partyId: sp0 ? sp0.id : '', sp: sp0 ? { abn: sp0.abn || '', billTo: sp0.billTo || '', code: sp0.code || '' } : null, name: first ? invCustLabel(first) : '', from, settings: Object.assign({}, invSettings, { logo: '' }) };
}
function stmtRef(d){ return d.stNo || ''; }
function stmtDocHtml(d){
  const s = Object.assign({}, d.settings || invSettings || {}, { logo: (invSettings || {}).logo }), sp = d.sp || {};
  const th = 'padding:5px 6px;border-bottom:1.5px solid #333;text-align:left;font-size:11.5px;';
  const td = 'padding:3px 6px;font-size:11.5px;vertical-align:top;';
  const num = 'text-align:right;white-space:nowrap;';
  let rows = '';
  d.blocks.forEach(b => {
    rows += `<tr><td style="${td}white-space:nowrap;">${invEsc(invIsoToDmy(b.r.invoice_date))}</td><td style="${td}">INV${invEsc(b.r.invoice_no)}</td><td style="${td}">Invoice${b.r.order_no ? ' (' + invEsc(b.r.order_no) + ')' : ''}</td><td style="${td}${num}">${stmtMoney(b.gross)}</td></tr>`;
    b.ev.forEach(e => {
      rows += `<tr><td style="${td}white-space:nowrap;">${invEsc(invIsoToDmy(e.date))}</td><td style="${td}"></td><td style="${td}padding-left:18px;${e.kind === 'cn' ? 'color:#1d7a3c;' : ''}">↳ ${invEsc(e.text)}</td><td style="${td}${num}">${stmtMoney(e.amount)}</td></tr>`;
    });
    rows += `<tr><td style="${td}"></td><td style="${td}"></td><td style="${td}font-weight:700;">Balance</td><td style="${td}${num}font-weight:700;border-top:1px solid #999;">${stmtMoney(b.balance)}</td></tr>`;
  });
  if(!d.blocks.length) rows = `<tr><td colspan="4" style="${td}color:#777;padding:14px 6px;">No outstanding invoices as at this date.</td></tr>`;
  let un = '';
  if(d.unapplied.length){
    un = `<tr><td colspan="4" style="${td}padding-top:12px;font-weight:700;">Unapplied Credits</td></tr>` + d.unapplied.map(u =>
      `<tr><td style="${td}white-space:nowrap;">${invEsc(invIsoToDmy(u.c.cn_date))}</td><td style="${td}"></td><td style="${td}color:#1d7a3c;font-style:italic;">Credit Note ${invEsc(u.c.cn_no)} - available credit</td><td style="${td}${num}color:#1d7a3c;">${stmtMoney(-u.avail)}</td></tr>`).join('');
  }
  const a = d.ag, ac = 'padding:5px 8px;text-align:right;font-size:11.5px;';
  const bk = [s.bankName && `Bank: ${s.bankName}`, s.bankAccName && `Account name: ${s.bankAccName}`, s.bsb && `BSB: ${s.bsb}`, s.accNo && `Account no: ${s.accNo}`].filter(Boolean);
  return `<div class="inv-doc stmt-doc" style="background:#fff;color:#111;width:210mm;max-width:100%;min-height:200mm;margin:0 auto;padding:12mm;box-sizing:border-box;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;">
      <div style="font-size:11.5px;line-height:1.5;">
        ${s.logo ? `<img src="${s.logo}" style="max-height:60px;max-width:200px;display:block;margin-bottom:6px;" />` : ''}
        <div style="font-weight:700;font-size:14px;">${invEsc(s.companyName || '')}</div>
        ${s.abn ? `<div>ABN ${invEsc(s.abn)}</div>` : ''}
        <div>${invNl2br(s.address || '')}</div>
        ${s.phone ? `<div>${invEsc(s.phone)}</div>` : ''}${s.email ? `<div>${invEsc(s.email)}</div>` : ''}${s.website ? `<div>${invEsc(s.website)}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:22px;font-weight:700;letter-spacing:1px;">STATEMENT</div>
        <div style="font-size:11.5px;margin-top:4px;">Statement date: <b>${invEsc(invIsoToDmy(d.asOf))}</b></div>
        ${stmtRef(d) ? `<div style="font-size:11.5px;">Statement No.: <b>${invEsc(stmtRef(d))}</b></div>` : `<div style="font-size:11.5px;color:#888;">Statement No.: <i>assigned when saved</i></div>`}
      </div>
    </div>
    <div style="margin:14px 0 12px;font-size:12px;line-height:1.5;">
      <div style="font-weight:700;font-size:13px;">${invEsc(d.name)}</div>
      ${sp.abn ? `<div>ABN ${invEsc(sp.abn)}</div>` : ''}
      <div>${invNl2br(sp.billTo || '')}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;"><thead><tr><th style="${th}width:80px;">Date</th><th style="${th}width:90px;">Invoice No.</th><th style="${th}">Details</th><th style="${th}${num}width:100px;">Amount</th></tr></thead><tbody>${rows}${un}</tbody></table>
    ${(a.d30 + a.d60 + a.d90 + a.d91) > 0.004 ? `<table style="margin:16px 0 0 auto;border-collapse:collapse;border:1px solid #999;"><thead><tr>${['Current', '1-30 Days', '31-60 Days', '61-90 Days', '90+ Days', 'Credit'].map(h => `<th style="${ac}border-bottom:1px solid #999;font-weight:700;">${h}</th>`).join('')}</tr></thead>
      <tbody><tr>${[a.cur, a.d30, a.d60, a.d90, a.d91].map(v => `<td style="${ac}">${invMoney2(v)}</td>`).join('')}<td style="${ac}color:#1d7a3c;">${a.credit ? '(' + invMoney2(a.credit) + ')' : '0.00'}</td></tr></tbody></table>` : ''}
    <div style="margin-top:8px;text-align:right;font-size:14px;font-weight:700;">TOTAL AMOUNT DUE &nbsp; $${stmtMoney(d.total)}</div>
    ${bk.length ? `<div style="margin-top:18px;border-top:1px solid #ccc;padding-top:8px;font-size:11.5px;line-height:1.5;"><div style="font-weight:700;">Payment details</div>${bk.map(x => `<div>${invEsc(x)}</div>`).join('')}<div style="color:#555;">Please quote ${stmtRef(d) ? 'Statement No. <b>' + invEsc(stmtRef(d)) + '</b>' : 'the Statement No. (assigned when saved)'} as the payment reference.</div></div>` : ''}
  </div>`;
}
// 存檔(產生 ST 號碼);同一份畫面已經存過就沿用同一個號碼
async function stmtEnsureSaved(){
  if(!stmtData) return false;
  if(stmtData.stNo) return true;
  try{
    const snap = JSON.parse(JSON.stringify(stmtData));
    const { data, error } = await sb.rpc('statement_save', { p_snapshot: snap, p_party_id: stmtData.partyId || '' });
    if(error) throw error;
    stmtData.stNo = data && data.st_no; stmtData._id = data && data.id;
    const host = document.getElementById('stmtPreviewHost'); if(host && stmtData) host.innerHTML = stmtDocHtml(stmtData);
    try{ logInventoryAction('order_edit', `Statement ${stmtData.stNo} saved (${stmtData.name}, ${stmtData.asOf})`, ''); }catch(e){}
    return true;
  }catch(e){
    console.error('Statement 存檔失敗', e);
    showInfoModal(invIsMissingFn(e) || (e && e.code === '42P01') ? t('stmtNeedSql') : t('stmtSaveFailed'));
    return false;
  }
}
async function stmtPrint(){
  if(!stmtData){ showInfoModal(t('stmtPickFirst')); return; }
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const dd = iframe.contentWindow.document;
  dd.open();
  dd.write(`<!doctype html><html><head><meta charset="utf-8"><title>Statement ${invEsc(stmtData.name)} ${invEsc(stmtData.asOf)}</title><style>@page{size:A4;margin:0;} body{margin:0;} .stmt-doc{width:210mm !important;} tr{page-break-inside:avoid;}</style></head><body>${stmtDocHtml(stmtData)}</body></html>`);
  dd.close();
  const go = () => { try{ iframe.contentWindow.focus(); iframe.contentWindow.print(); }catch(e){ console.error(e); } setTimeout(() => iframe.remove(), 2000); };
  setTimeout(go, 300);
}

// ---------- 依 Statement 登記付款 ----------
// 一次結清:未使用的 Credit Note(與其他 Invoice 多收的金額)先由舊到新抵扣各張未付清的 Invoice,
// 剩下的金額再用客人實際付的總額由舊到新分配。抵扣用 invoice_apply_credit,付款用 invoice_payment_save。
let stmtPay = null;   // { open, srcs, stId }
async function stmtLiveFromSnapshot(){
  try{
    const ids = stmtData.blocks.map(b => b.r.id);
    let r = await sb.from('invoices').select('id,total,paid,credited').in('id', ids);
    if(r.error && r.error.code === '42703') r = await sb.from('invoices').select('id,total,paid').in('id', ids);
    if(r.error) throw r.error;
    const cur = {}; (r.data || []).forEach(x => { cur[x.id] = stmtR2((Number(x.total) || 0) - (Number(x.credited) || 0) - (Number(x.paid) || 0)); });
    const open = [], srcs = [];
    stmtData.blocks.forEach(b => {
      const bal = cur[b.r.id]; if(bal === undefined) return;
      if(bal > 0.004) open.push(Object.assign({}, b, { balance: bal }));
      else if(bal < -0.004) srcs.push({ type: 'invoice', id: b.r.id, label: 'INV' + b.r.invoice_no + ' ' + t('invOverAmount'), avail: stmtR2(-bal) });
    });
    const cnIds = stmtData.unapplied.map(u => u.c.id).filter(Boolean);
    if(cnIds.length){
      let c = await sb.from('credit_notes').select('id,cn_no,total,applied').in('id', cnIds);
      if(c.error && c.error.code === '42703') c = await sb.from('credit_notes').select('id,cn_no,total').in('id', cnIds);
      if(c.error) throw c.error;
      (c.data || []).forEach(x => { const av = stmtR2((Number(x.total) || 0) - (Number(x.applied) || 0)); if(av > 0.004) srcs.unshift({ type: 'cn', id: x.id, label: 'Credit Note ' + x.cn_no, avail: av }); });
    }
    return { open, srcs };
  }catch(e){ console.error('讀取目前餘額失敗', e); showInfoModal(t('invLoadFailed')); return null; }
}
async function stmtOpenPay(){
  if(!stmtData){ showInfoModal(t('stmtPickFirst')); return; }
  if(stmtData._saved && stmtData._paidAt){ showInfoModal(tf('stmtAlreadyPaid', { date: invIsoToDmy(String(stmtData._paidAt).slice(0, 10)) })); return; }
  let open, srcs = [];
  if(stmtData._saved){
    // 舊 Statement 還沒登記過付款:金額改用 Invoice / Credit Note 的「目前」餘額
    // 同一個出貨方有更新的 Statement 時,舊的不能再登記付款(新的已經包含舊的紀錄)
    try{
      let q = sb.from('statements').select('st_no').gt('created_at', stmtData._createdAt).order('created_at', { ascending: false }).limit(1);
      q = stmtData.partyId ? q.eq('party_id', stmtData.partyId) : q.eq('customer', stmtData.name);
      const nr = await q;
      if(nr.error) throw nr.error;
      if(nr.data && nr.data.length){ showInfoModal(tf('stmtSuperseded', { no: nr.data[0].st_no })); return; }
    }catch(e){ console.error(e); showInfoModal(t('invLoadFailed')); return; }
    const live = await stmtLiveFromSnapshot();
    if(!live) return;
    open = live.open; srcs = live.srcs;
    if(!open.length){ showInfoModal(t('stmtNoOpen')); return; }
  }else{
    open = stmtData.blocks.filter(b => b.balance > 0.004);
    if(!open.length){ showInfoModal(t('stmtNoOpen')); return; }
    if(!(await stmtEnsureSaved())) return;   // 先存檔拿到 Statement 號碼,付款備註才有號碼可以查
    stmtData.unapplied.forEach(u => srcs.push({ type: 'cn', id: u.c.id, label: 'Credit Note ' + u.c.cn_no, avail: u.avail }));
    stmtData.blocks.filter(b => b.balance < -0.004).forEach(b => srcs.push({ type: 'invoice', id: b.r.id, label: 'INV' + b.r.invoice_no + ' ' + t('invOverAmount'), avail: stmtR2(-b.balance) }));
  }
  stmtPay = { open, srcs, stId: stmtData._id || '' };
  const ov = document.createElement('div');
  ov.id = 'stmtPayOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(600px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('stmtRecordPay')} · ${invEsc(stmtData.name)}</div>
    <p style="font-size:11.5px;color:var(--ink-soft);margin:0 0 8px;">${t('stmtPayHint')}</p>
    ${srcs.length ? `<label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin:0 0 8px;cursor:pointer;"><input type="checkbox" id="stmtUseCredit" checked style="width:auto;margin:3px 0 0;" onchange="stmtPlan()" /><span>${t('stmtUseCredit')}<br><span style="color:var(--ink-soft);">${srcs.map(x => invEsc(x.label) + ' ' + invMoney2(x.avail)).join(' · ')}</span></span></label>` : ''}
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;">
      <div class="field"><label>${t('invPayDate')}</label><input type="date" id="stmtPayDate" value="${invEsc(invToday())}" /></div>
      <div class="field"><label>${t('stmtCashAmt')}</label><input type="number" id="stmtPayAmt" min="0" step="0.01" oninput="stmtAllocate()" /></div>
      <div class="field"><label>${t('invPayMethod')}</label><select id="stmtPayMethod">${INV_PAY_METHODS.map(m => `<option>${invEsc(m)}</option>`).join('')}</select></div>
      <div class="field"><label>${t('colNote')}</label><input type="text" id="stmtPayNote" value="${invEsc(stmtRef(stmtData))}" /></div>
    </div>
    <div style="overflow-x:auto;margin-top:8px;"><table class="stock-table"><thead><tr><th>Invoice</th><th class="num">${t('invColBalance')}</th><th class="num">${t('stmtCreditCol')}</th><th class="num">${t('invPayAmount')}</th></tr></thead><tbody>
      ${open.map((b, i) => `<tr><td>INV${invEsc(b.r.invoice_no)} · ${invEsc(invIsoToDmy(b.r.invoice_date))}</td><td class="num">${invMoney2(b.balance)}</td><td class="num stmtCr" data-i="${i}"></td><td class="num"><input type="number" class="stmtAlloc" data-i="${i}" min="0" step="0.01" style="width:100px;text-align:right;" oninput="stmtAllocSum()" /></td></tr>`).join('')}
    </tbody></table></div>
    <div id="stmtAllocInfo" style="font-size:12px;margin-top:6px;"></div>
    <div id="stmtPayMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('stmtPayOverlay').remove()">${t('btnCancel')}</button><button class="btn" id="stmtPayBtn" onclick="stmtPaySave()">${t('invPayAddBtn')}</button></div>
  </div>`;
  document.body.appendChild(ov);
  stmtPlan(true);
}
// 抵扣計畫:每個額度來源由舊到新蓋掉各張 Invoice 的未收
function stmtCreditPlan(){
  const use = !!(document.getElementById('stmtUseCredit') || {}).checked;
  const bal = stmtPay.open.map(b => b.balance), plan = [];
  if(use) stmtPay.srcs.forEach(src => {
    let left = src.avail;
    bal.forEach((v, i) => { const take = stmtR2(Math.min(left, v)); if(take > 0.004){ plan.push({ src, i, amt: take }); bal[i] = stmtR2(v - take); left = stmtR2(left - take); } });
  });
  return { plan, rest: bal };
}
function stmtPlan(first){
  const { plan, rest } = stmtCreditPlan();
  document.querySelectorAll('#stmtPayOverlay .stmtCr').forEach(td => {
    const i = +td.dataset.i, c = stmtR2(stmtPay.open[i].balance - rest[i]);
    td.textContent = c > 0.004 ? '-' + invMoney2(c) : '';
  });
  document.querySelectorAll('#stmtPayOverlay .stmtAlloc').forEach(inp => { inp.dataset.max = rest[+inp.dataset.i]; });
  const amt = document.getElementById('stmtPayAmt');
  if(amt) amt.value = invMoney2(stmtR2(rest.reduce((s, v) => s + v, 0)));
  stmtAllocate();
}
function stmtAllocate(){
  let left = stmtR2(Number((document.getElementById('stmtPayAmt') || {}).value) || 0);
  document.querySelectorAll('#stmtPayOverlay .stmtAlloc').forEach(inp => {
    const mx = Number(inp.dataset.max) || 0, v = Math.max(0, Math.min(mx, left));
    inp.value = v > 0 ? invMoney2(v) : ''; left = stmtR2(left - v);
  });
  stmtAllocSum();
}
function stmtAllocSum(){
  const amt = stmtR2(Number((document.getElementById('stmtPayAmt') || {}).value) || 0);
  let sum = 0; document.querySelectorAll('#stmtPayOverlay .stmtAlloc').forEach(i => { sum += Number(i.value) || 0; });
  sum = stmtR2(sum);
  const el = document.getElementById('stmtAllocInfo');
  if(el) el.innerHTML = `${t('stmtAllocated')}: <b>${invMoney2(sum)}</b> / ${invMoney2(amt)}${Math.abs(sum - amt) > 0.004 ? ` <span style="color:#b42318;">(${t('stmtAllocDiff')} ${invMoney2(amt - sum)})</span>` : ''}`;
}
async function stmtPaySave(){
  const msg = document.getElementById('stmtPayMsg');
  const date = (document.getElementById('stmtPayDate') || {}).value;
  const method = (document.getElementById('stmtPayMethod') || {}).value || '';
  const note = ((document.getElementById('stmtPayNote') || {}).value || '').trim();
  const amt = stmtR2(Number((document.getElementById('stmtPayAmt') || {}).value) || 0);
  const { plan, rest } = stmtCreditPlan();
  const items = []; let sum = 0;
  document.querySelectorAll('#stmtPayOverlay .stmtAlloc').forEach(inp => {
    const v = stmtR2(Number(inp.value) || 0), i = +inp.dataset.i;
    if(v > 0){ items.push({ b: stmtPay.open[i], v, max: rest[i] }); sum += v; }
  });
  sum = stmtR2(sum);
  const bad = k => { msg.className = 'msg error'; msg.textContent = t(k); };
  if(!date) return bad('invPayBadDate');
  if(!plan.length && !(amt > 0)) return bad('invPayBadAmount');
  if(Math.abs(sum - amt) > 0.004) return bad('stmtAllocMismatch');
  if(items.some(x => x.v > x.max + 0.004)) return bad('invPaidTooMuch');
  const btn = document.getElementById('stmtPayBtn'); if(btn) btn.disabled = true;
  let done = 0; const total = plan.length + items.length;
  try{
    for(const x of plan){
      const { error } = await sb.rpc('invoice_apply_credit', { p_invoice_id: stmtPay.open[x.i].r.id, p_source_type: x.src.type, p_source_id: x.src.id, p_amount: x.amt, p_date: date });
      if(error) throw error;
      done++;
    }
    for(const x of items){
      const { error } = await sb.rpc('invoice_payment_save', { p_invoice_id: x.b.r.id, p_payment_id: null, p_date: date, p_amount: x.v, p_method: method, p_note: note });
      if(error) throw error;
      done++;
    }
    try{ logInventoryAction('order_edit', `Statement ${stmtRef(stmtData)} payment ${invMoney2(amt)} (${method}), credit applied ${invMoney2(plan.reduce((s, x) => s + x.amt, 0))}`, ''); }catch(e){}
    try{ if(stmtPay.stId) await sb.rpc('statement_mark_paid', { p_id: stmtPay.stId }); }catch(e){}
    document.getElementById('stmtPayOverlay').remove();
    invList = []; if(typeof icCnRows !== 'undefined') icCnRows = null;
    await stmtOpenPage();
  }catch(e){
    console.error('Statement 登記付款失敗', e);
    if(btn) btn.disabled = false;
    msg.className = 'msg error';
    msg.textContent = (done ? tf('stmtPayPartial', { n: done, m: total }) + ' ' : '') + (invIsMissingFn(e) ? t('invPayNeedSql') : t('invPaidFailed'));
    if(done) invList = [];
  }
}

// ---------- Statement 紀錄(已存檔的快照) ----------
let stmtLogRows = [];
async function stmtOpenLog(){
  const out = document.getElementById('stmtOut'); if(!out) return;
  const lb = document.getElementById('stmtBtnLog'), nb = document.getElementById('stmtBtnNew');
  if(lb) lb.className = 'btn'; if(nb) nb.className = 'btn ghost';
  out.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  try{
    const { data, error } = await sb.from('statements').select('id,st_no,customer,party_id,as_of,total_due,created_by,created_at').order('created_at', { ascending: false }).limit(1000);
    if(error) throw error;
    stmtLogRows = data || [];
    try{ if(typeof deLoadSent === 'function') await deLoadSent(true); }catch(e){}
    stmtRenderLog('');
  }catch(e){
    console.error('讀取 Statement 紀錄失敗', e);
    out.innerHTML = `<div class="msg error">${invIsMissingFn(e) || (e && e.code === '42P01') ? t('stmtNeedSql') : t('invLoadFailed')}</div>`;
  }
}
function stmtRenderLog(q){
  const out = document.getElementById('stmtOut'); if(!out) return;
  const k = (q || '').trim().toLowerCase();
  const rows = stmtLogRows.filter(r => !k || [r.st_no, r.customer].join(' ').toLowerCase().includes(k));
  out.innerHTML = `<div class="field" style="max-width:320px;"><input type="text" id="stmtLogQ" value="${invEsc(q || '')}" placeholder="${invEsc(t('stmtLogSearch'))}" oninput="stmtRenderLog(this.value);const i=document.getElementById('stmtLogQ');i.focus();i.setSelectionRange(i.value.length,i.value.length)" /></div>
    ${rows.length ? `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th></th><th>Statement No.</th><th>${t('icFieldParty')}</th><th>${t('stmtAsOf')}</th><th class="num">${t('stmtAmountDue')}</th><th>${t('invDtCreated')}</th></tr></thead><tbody>
      ${rows.map(r => { const v = `style="cursor:pointer;" onclick="stmtViewSaved('${invEsc(r.id)}')"`; return `<tr>${typeof deIconCell === 'function' ? deIconCell('statement', r.id) : '<td></td>'}<td ${v}><b>${invEsc(r.st_no)}</b></td><td ${v}>${invEsc(r.customer || '')}</td><td ${v}>${invEsc(invIsoToDmy(r.as_of))}</td><td class="num" ${v}>${invMoney2(r.total_due)}</td><td ${v}>${invEsc(r.created_by || '')}${r.created_at ? ' · ' + invEsc(invIsoToDmy(String(r.created_at).slice(0, 10))) : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : `<div class="empty-note">${t('stmtLogEmpty')}</div>`}`;
}
async function stmtViewSaved(id){
  try{
    let { data, error } = await sb.from('statements').select('st_no,snapshot,paid_at,created_at').eq('id', id).maybeSingle();
    if(error && error.code === '42703') ({ data, error } = await sb.from('statements').select('st_no,snapshot').eq('id', id).maybeSingle());   // 還沒執行新版 SQL:沒有 paid_at 欄
    if(error || !data) throw error || new Error('not found');
    stmtData = data.snapshot; stmtData._saved = true; stmtData._id = id; stmtData._paidAt = data.paid_at || ''; stmtData._createdAt = data.created_at || '';
    if(!stmtData.stNo) stmtData.stNo = data.st_no;
    stmtShowModal(true);
  }catch(e){ console.error(e); showInfoModal(t('invLoadFailed')); }
}
