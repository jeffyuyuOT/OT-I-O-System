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
  if(stmtState.key) stmtGenerate();
}
function stmtCustomers(){
  const m = new Map();
  (invList || []).forEach(r => { const k = stmtKeyOf(r); if(!m.has(k)) m.set(k, invCustLabel(r) || r.customer || '—'); });
  return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
}
function stmtRenderForm(){
  const root = document.getElementById('statementRoot'); if(!root) return;
  const opts = stmtCustomers().map(([k, l]) => `<option value="${invEsc(k)}" ${k === stmtState.key ? 'selected' : ''}>${invEsc(l)}</option>`).join('');
  root.innerHTML = `<div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;align-items:end;">
      <div class="field"><label>${t('icFieldParty')}</label><select id="stmtParty" onchange="stmtState.key=this.value;stmtGenerate()"><option value="">—</option>${opts}</select></div>
      <div class="field"><label>${t('stmtAsOf')}</label><input type="date" id="stmtAsOf" value="${invEsc(stmtState.asOf)}" onchange="stmtState.asOf=this.value;stmtGenerate()" /></div>
      <div class="field"><label style="display:flex;gap:6px;align-items:center;font-weight:400;"><input type="checkbox" id="stmtIncPaid" ${stmtState.incPaid ? 'checked' : ''} onchange="stmtState.incPaid=this.checked;stmtGenerate()" /> ${t('stmtIncPaid')}</label>
        <input type="date" id="stmtFrom" value="${invEsc(stmtState.from)}" ${stmtState.incPaid ? '' : 'disabled'} onchange="stmtState.from=this.value;stmtGenerate()" /></div>
    </div>
    <div class="toolbar" style="margin:10px 0;gap:8px;">
      <button class="btn" onclick="stmtPrint()">${t('stmtPrint')}</button>
      <button class="btn ghost" onclick="stmtOpenPay()">${t('stmtRecordPay')}</button>
    </div>
    <div id="stmtOut"></div>`;
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
async function stmtGenerate(){
  const out = document.getElementById('stmtOut'); if(!out) return;
  const key = stmtState.key, asOf = stmtState.asOf;
  if(!key || !asOf){ out.innerHTML = ''; stmtData = null; return; }
  const sel = document.getElementById('stmtFrom'); if(sel) sel.disabled = !stmtState.incPaid;
  out.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  try{
    const invs = (invList || []).filter(r => stmtKeyOf(r) === key);
    const [cns, pays] = await Promise.all([stmtFetchCreditNotes(), stmtFetchPayments(invs.map(r => r.id))]);
    const myCns = cns.filter(c => stmtKeyOf(c) === key && (c.cn_date || '') <= asOf);
    stmtData = stmtCompute(key, invs, myCns, pays, asOf);
    out.innerHTML = `<div style="overflow:auto;border:1px solid var(--line);background:#eee;padding:8px;">${stmtDocHtml(stmtData)}</div>`;
  }catch(e){
    console.error('Statement 讀取失敗', e);
    out.innerHTML = `<div class="msg error">${invIsMissingFn(e) ? t('icNeedSqlCn') : t('invLoadFailed')}</div>`;
    stmtData = null;
  }
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
  return { key, asOf, blocks, unapplied, ag, total, sp: first ? invPartyOf(first) : null, name: first ? invCustLabel(first) : '', from };
}
function stmtDocHtml(d){
  const s = invSettings || {}, sp = d.sp || {};
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
  if(!d.blocks.length) rows = `<tr><td colspan="4" style="${td}color:#777;padding:14px 6px;">${invEsc(t('stmtNone'))}</td></tr>`;
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
      </div>
    </div>
    <div style="margin:14px 0 12px;font-size:12px;line-height:1.5;">
      <div style="font-weight:700;font-size:13px;">${invEsc(d.name)}</div>
      ${sp.abn ? `<div>ABN ${invEsc(sp.abn)}</div>` : ''}
      <div>${invNl2br(sp.billTo || '')}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;"><thead><tr><th style="${th}width:80px;">Date</th><th style="${th}width:90px;">Invoice No.</th><th style="${th}">Details</th><th style="${th}${num}width:100px;">Amount</th></tr></thead><tbody>${rows}${un}</tbody></table>
    <table style="margin:16px 0 0 auto;border-collapse:collapse;border:1px solid #999;"><thead><tr>${['Current', '1-30 Days', '31-60 Days', '61-90 Days', '90+ Days', 'Credit'].map(h => `<th style="${ac}border-bottom:1px solid #999;font-weight:700;">${h}</th>`).join('')}</tr></thead>
      <tbody><tr>${[a.cur, a.d30, a.d60, a.d90, a.d91].map(v => `<td style="${ac}">${invMoney2(v)}</td>`).join('')}<td style="${ac}color:#1d7a3c;">${a.credit ? '(' + invMoney2(a.credit) + ')' : '0.00'}</td></tr></tbody></table>
    <div style="margin-top:8px;text-align:right;font-size:14px;font-weight:700;">TOTAL AMOUNT DUE &nbsp; $${stmtMoney(d.total)}</div>
    ${bk.length ? `<div style="margin-top:18px;border-top:1px solid #ccc;padding-top:8px;font-size:11.5px;line-height:1.5;"><div style="font-weight:700;">Payment details</div>${bk.map(x => `<div>${invEsc(x)}</div>`).join('')}<div style="color:#555;">Please quote your invoice number(s) as the payment reference.</div></div>` : ''}
  </div>`;
}
function stmtPrint(){
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

// ---------- 依 Statement 登記付款(一筆總額,由舊到新分配到各張未付清的 Invoice) ----------
function stmtOpenPay(){
  if(!stmtData){ showInfoModal(t('stmtPickFirst')); return; }
  const open = stmtData.blocks.filter(b => b.balance > 0.004);
  if(!open.length){ showInfoModal(t('stmtNoOpen')); return; }
  const tot = stmtR2(open.reduce((s, b) => s + b.balance, 0));
  const ov = document.createElement('div');
  ov.id = 'stmtPayOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(560px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t('stmtRecordPay')} · ${invEsc(stmtData.name)}</div>
    <p style="font-size:11.5px;color:var(--ink-soft);margin:0 0 8px;">${t('stmtPayHint')}</p>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;">
      <div class="field"><label>${t('invPayDate')}</label><input type="date" id="stmtPayDate" value="${invEsc(invToday())}" /></div>
      <div class="field"><label>${t('invPayAmount')}</label><input type="number" id="stmtPayAmt" min="0.01" step="0.01" value="${invMoney2(tot)}" oninput="stmtAllocate()" /></div>
      <div class="field"><label>${t('invPayMethod')}</label><select id="stmtPayMethod">${INV_PAY_METHODS.map(m => `<option>${invEsc(m)}</option>`).join('')}</select></div>
      <div class="field"><label>${t('colNote')}</label><input type="text" id="stmtPayNote" value="Statement ${invEsc(stmtData.asOf)}" /></div>
    </div>
    <div style="overflow-x:auto;margin-top:8px;"><table class="stock-table"><thead><tr><th>Invoice</th><th class="num">${t('invColBalance')}</th><th class="num">${t('invPayAmount')}</th></tr></thead><tbody>
      ${open.map((b, i) => `<tr><td>INV${invEsc(b.r.invoice_no)} · ${invEsc(invIsoToDmy(b.r.invoice_date))}</td><td class="num">${invMoney2(b.balance)}</td><td class="num"><input type="number" class="stmtAlloc" data-i="${i}" data-max="${b.balance}" min="0" step="0.01" style="width:100px;text-align:right;" oninput="stmtAllocSum()" /></td></tr>`).join('')}
    </tbody></table></div>
    <div id="stmtAllocInfo" style="font-size:12px;margin-top:6px;"></div>
    <div id="stmtPayMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('stmtPayOverlay').remove()">${t('btnCancel')}</button><button class="btn" id="stmtPayBtn" onclick="stmtPaySave()">${t('invPayAddBtn')}</button></div>
  </div>`;
  document.body.appendChild(ov);
  stmtAllocate();
}
function stmtAllocate(){
  let left = stmtR2(Number((document.getElementById('stmtPayAmt') || {}).value) || 0);
  document.querySelectorAll('#stmtPayOverlay .stmtAlloc').forEach(inp => {
    const mx = Number(inp.dataset.max), v = Math.max(0, Math.min(mx, left));
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
  const open = stmtData.blocks.filter(b => b.balance > 0.004);
  const items = []; let sum = 0;
  document.querySelectorAll('#stmtPayOverlay .stmtAlloc').forEach(inp => {
    const v = stmtR2(Number(inp.value) || 0), b = open[+inp.dataset.i];
    if(v > 0 && b){ items.push({ b, v }); sum += v; }
  });
  sum = stmtR2(sum);
  const bad = k => { msg.className = 'msg error'; msg.textContent = t(k); };
  if(!date) return bad('invPayBadDate');
  if(!(amt > 0) || !items.length) return bad('invPayBadAmount');
  if(Math.abs(sum - amt) > 0.004) return bad('stmtAllocMismatch');
  if(items.some(x => x.v > x.b.balance + 0.004)) return bad('invPaidTooMuch');
  const btn = document.getElementById('stmtPayBtn'); if(btn) btn.disabled = true;
  let done = 0;
  try{
    for(const x of items){
      const { error } = await sb.rpc('invoice_payment_save', { p_invoice_id: x.b.r.id, p_payment_id: null, p_date: date, p_amount: x.v, p_method: method, p_note: note });
      if(error) throw error;
      done++;
    }
    try{ logInventoryAction('order_edit', `Statement payment ${invMoney2(amt)} (${method}) allocated to ${items.map(x => 'INV' + x.b.r.invoice_no).join(', ')}`, ''); }catch(e){}
    document.getElementById('stmtPayOverlay').remove();
    await stmtOpenPage();
  }catch(e){
    console.error('Statement 登記付款失敗', e);
    if(btn) btn.disabled = false;
    msg.className = 'msg error';
    msg.textContent = (done ? tf('stmtPayPartial', { n: done, m: items.length }) + ' ' : '') + (invIsMissingFn(e) ? t('invPayNeedSql') : t('invPaidFailed'));
    if(done) invList = [];
  }
}
