// ============================================================
// Invoice / Credit Note 用 email 寄給出貨方(客戶)
//   · Invoice 清單、Credit Note 清單最左邊的 ✉ 圖示 → 視窗有「新增 email / 寄送紀錄」兩個分頁(預設新增)
//   · 收件人預設帶出貨方的 email;寄件者 = 會計 Email(主要那個),客戶回覆也會回到它(Reply-To)
//   · 預設主旨/內文放在 系統設置 → 「Invoice / Credit Note Email 預設內容」(app_data: docEmailTemplate),每次寄送可以再改
//   · 附上該張單據的 PDF;實際寄信由 Edge Function send-document-email(Resend)做,並寫入 document_emails(誰、幾時、寄給誰)
//   · 需要先執行 sql/document_emails.sql 並部署 send-document-email
// ============================================================
Object.assign(I18N.zh, {
  deTipMail: 'Email 給出貨方', deTitleInv: '寄送 Invoice', deTitleCn: '寄送 Credit Note',
  deTabNew: '新增 email', deTabLog: '寄送紀錄', deTo: '收件者', deCc: '副本(CC,選填)', deFrom: '寄件者(會計 Email)', deSubject: '主旨', deBody: '內容',
  deAttach: '附件', deSend: '寄出', deClose: '關閉', deSending: '寄送中,請稍候…',
  deNoParty: '這張單據沒有對應的出貨方 email,請直接填寫收件者(也可以到「出貨方管理」補上 email)。',
  deNoSender: '還沒設定會計 Email。請先到 系統設置 → 會計 Email 新增地址並設為「主要」,才能用它當寄件者。',
  deBadTo: '收件者 email 格式不正確。', deBadCc: '副本 email 格式不正確。', deSentOk: '✓ 已寄出', deFail: '寄送失敗', deNeedSql: '尚未建立寄送紀錄資料表,請先執行 sql/document_emails.sql。',
  deLogEmpty: '還沒有寄送紀錄。', deLogBy: '寄送者', deLogWhen: '時間', deLogTo: '收件者', deLogSubject: '主旨', deLogFrom: '寄件者 / 回覆至', deLogFromShort: '寄件', deLogReplyTo: '回覆至',
  deSentTag: 'email已寄', deFnMissing: '寄信功能尚未部署(Edge Function: send-document-email)。', deForbidden: '只有管理者與會計可以寄送。', deNoLib: 'PDF 元件載入失敗,請重新整理頁面再試一次。',
  secDocEmail: 'Invoice / Credit Note Email 預設內容',
  docEmailHint: '在 Invoice 清單 / Credit Note 清單用 ✉ 寄送時,預設帶入的主旨與內文(每次寄送前還是可以修改)。可用代號:{docType}(Invoice 或 Credit Note)、{no}(單號)、{customer}(客戶)、{date}(日期)、{total}(含 GST 總額)、{sender}(寄件者名稱)。',
  docEmailSubjectLbl: '主旨', docEmailBodyLbl: '內文', docEmailSaved: '✓ 已儲存', docEmailReset: '還原預設'
});
Object.assign(I18N.en, {
  deTipMail: 'Email to customer', deTitleInv: 'Email Invoice', deTitleCn: 'Email Credit Note',
  deTabNew: 'New email', deTabLog: 'Sent log', deTo: 'To', deCc: 'CC (optional)', deFrom: 'From (accounting email)', deSubject: 'Subject', deBody: 'Message',
  deAttach: 'Attachment', deSend: 'Send', deClose: 'Close', deSending: 'Sending…',
  deNoParty: 'This document has no customer email on file. Enter the recipient, or add an email in Parties.',
  deNoSender: 'No accounting email set. Add one in Settings → Accounting Email and mark it Primary to use it as the sender.',
  deBadTo: 'The recipient email is not valid.', deBadCc: 'The CC email is not valid.', deSentOk: '✓ Sent', deFail: 'Sending failed', deNeedSql: 'The email log table is missing. Run sql/document_emails.sql first.',
  deLogEmpty: 'Nothing sent yet.', deLogBy: 'Sent by', deLogWhen: 'When', deLogTo: 'To', deLogSubject: 'Subject', deLogFrom: 'From / reply-to', deLogFromShort: 'From', deLogReplyTo: 'Reply-to',
  deSentTag: 'Emailed', deFnMissing: 'The email function is not deployed (Edge Function: send-document-email).', deForbidden: 'Only admins and accountants can send.', deNoLib: 'The PDF component failed to load. Please refresh and try again.',
  secDocEmail: 'Invoice / Credit Note email template',
  docEmailHint: 'Default subject and message used when sending with ✉ from the Invoice / Credit Note lists (editable on every send). Placeholders: {docType} (Invoice or Credit Note), {no}, {customer}, {date}, {total} (inc. GST), {sender}.',
  docEmailSubjectLbl: 'Subject', docEmailBodyLbl: 'Message', docEmailSaved: '✓ Saved', docEmailReset: 'Reset to default'
});

const DE_DEFAULT_TEMPLATE = {
  subject: '{docType} {no} from Orange Tea Australia',
  body: 'Hi {customer},\n\nPlease find attached {docType} {no} dated {date} (total {total} inc. GST).\n\nIf you have any questions, just reply to this email.\n\nKind regards,\n{sender}'
};
let docEmailTemplate = Object.assign({}, DE_DEFAULT_TEMPLATE);
let deTemplateLoaded = false;
async function deLoadTemplate(){
  if(deTemplateLoaded) return;
  try{
    const r = await dbGet('docEmailTemplate');
    if(r && r.value){ const o = JSON.parse(r.value); if(o && typeof o === 'object') docEmailTemplate = { subject: o.subject || DE_DEFAULT_TEMPLATE.subject, body: o.body || DE_DEFAULT_TEMPLATE.body }; }
  }catch(e){}
  deTemplateLoaded = true;
}
function deFill(str, v){ return String(str || '').replace(/\{(docType|no|customer|date|total|sender)\}/g, (m, k) => (v[k] === undefined ? m : v[k])); }
function dePrimaryEmail(){
  const list = (typeof accountingEmails !== 'undefined' ? accountingEmails : []).filter(e => e && e.email);
  const p = list.find(e => e.isPrimary) || list[0];
  return p ? p.email : '';
}
function deSenderName(){ return (typeof invSettings !== 'undefined' && invSettings && (invSettings.companyName || invSettings.company_name)) || 'Orange Tea Australia'; }
function deWhen(iso){
  try{ const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; }catch(e){ return iso || ''; }
}

// ---------- 清單上的「已寄」標記 ----------
const deSent = {};   // 'invoice:<id>' → 最新寄送時間 ISO
let deSentLoaded = false;
async function deLoadSent(force){
  if(deSentLoaded && !force) return;
  try{
    const { data, error } = await sb.from('document_emails').select('doc_type,doc_id,sent_at').order('sent_at', { ascending: false }).limit(20000);
    if(error) throw error;
    Object.keys(deSent).forEach(k => delete deSent[k]);
    (data || []).forEach(r => { const k = r.doc_type + ':' + r.doc_id; if(!deSent[k]) deSent[k] = r.sent_at; });
    deSentLoaded = true;
  }catch(e){ /* 資料表還沒建立:就當作都沒寄過 */ }
}
function deIconCell(type, id){
  const at = deSent[type + ':' + id];
  return `<td style="white-space:nowrap;"><span class="batch-info-icon" style="font-size:16px;margin:0;" title="${invEsc(t('deTipMail'))}" onclick="deOpen('${type}','${invEsc(id)}')">✉</span>${at ? `<div style="font-size:10.5px;color:#1d7a3c;line-height:1.25;">${invEsc(t('deSentTag'))}<br>${invEsc(deWhen(at))}</div>` : ''}</td>`;
}

// ---------- 視窗 ----------
let deCtx = null;   // { type, id, row, tab, sending }
function deClose(){ const o = document.getElementById('deOverlay'); if(o) o.remove(); deCtx = null; }
function deRowOf(type, id){
  if(type === 'credit_note') return (typeof icCnRows !== 'undefined' && icCnRows || []).find(r => r.id === id);
  return (typeof invList !== 'undefined' ? invList : []).find(r => r.id === id);
}
async function deOpen(type, id){
  const row = deRowOf(type, id); if(!row) return;
  await deLoadTemplate();
  deCtx = { type, id, row, tab: 'new', sending: false };
  const ov = document.createElement('div');
  ov.id = 'deOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1300';
  ov.onclick = e => { if(e.target === ov) deClose(); };
  document.body.appendChild(ov);
  deRender();
}
function deDocNo(){ const r = deCtx.row; return deCtx.type === 'credit_note' ? r.cn_no : r.invoice_no; }
function deTotalText(){
  const r = deCtx.row;
  if(deCtx.type === 'credit_note') return '(' + invMoney2(r.total) + ')';
  try{ return invMoney2(invRowInfo(r).total); }catch(e){ return invMoney2(r.total); }
}
function deVars(){
  const r = deCtx.row, cn = deCtx.type === 'credit_note';
  return { docType: cn ? 'Credit Note' : 'Invoice', no: (cn ? '' : 'INV') + deDocNo(), customer: invCustLabel(r) || 'there', date: invIsoToDmy(cn ? r.cn_date : r.invoice_date), total: deTotalText(), sender: deSenderName() };
}
function deRender(){
  const ov = document.getElementById('deOverlay'); if(!ov || !deCtx) return;
  const cn = deCtx.type === 'credit_note', tab = deCtx.tab;
  const keep = deCtx.draft || null;
  const tabBtn = (k, l) => `<button class="btn ${tab === k ? '' : 'ghost'}" style="padding:6px 14px;" onclick="deSetTab('${k}')">${invEsc(l)}</button>`;
  ov.innerHTML = `<div class="modal-box" style="max-width:min(620px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${invEsc(t(cn ? 'deTitleCn' : 'deTitleInv'))} · ${invEsc((cn ? '' : 'INV') + deDocNo())}</div>
    <div style="font-size:12.5px;margin:0 0 8px;">${invEsc(invCustLabel(deCtx.row))}</div>
    <div style="display:flex;gap:6px;margin-bottom:10px;">${tabBtn('new', t('deTabNew'))}${tabBtn('log', t('deTabLog'))}</div>
    <div id="deBody"></div></div>`;
  if(tab === 'new') deRenderNew(keep); else deRenderLog();
}
function deSetTab(k){
  if(!deCtx || deCtx.sending) return;
  if(deCtx.tab === 'new') deCtx.draft = deReadForm();
  deCtx.tab = k; deRender();
}
function deReadForm(){
  const g = n => (document.getElementById(n) || {}).value || '';
  return { to: g('deTo'), cc: g('deCc'), subject: g('deSubject'), body: g('deBody_txt') };
}
function deRenderNew(draft){
  const body = document.getElementById('deBody'); if(!body) return;
  const v = deVars(), sp = invPartyOf(deCtx.row), sender = dePrimaryEmail();
  const d = draft || { to: (sp && sp.email) || '', cc: '', subject: deFill(docEmailTemplate.subject, v), body: deFill(docEmailTemplate.body, v) };
  const noParty = !draft && !(sp && sp.email);
  body.innerHTML = `
    ${noParty ? `<div class="msg" style="margin-bottom:8px;color:#9a6a00;">${invEsc(t('deNoParty'))}</div>` : ''}
    ${sender ? '' : `<div class="msg error" style="margin-bottom:8px;">${invEsc(t('deNoSender'))}</div>`}
    <div class="field" style="margin-bottom:8px;"><label>${invEsc(t('deTo'))}</label><input id="deTo" type="text" value="${invEsc(d.to)}" placeholder="name@example.com, name2@example.com" /></div>
    <div class="field" style="margin-bottom:8px;"><label>${invEsc(t('deCc'))}</label><input id="deCc" type="text" value="${invEsc(d.cc)}" /></div>
    <div class="field" style="margin-bottom:8px;"><label>${invEsc(t('deFrom'))}</label><input type="text" value="${invEsc(sender)}" readonly style="background:#f4f4f2;" /></div>
    <div class="field" style="margin-bottom:8px;"><label>${invEsc(t('deSubject'))}</label><input id="deSubject" type="text" value="${invEsc(d.subject)}" /></div>
    <div class="field" style="margin-bottom:8px;"><label>${invEsc(t('deBody'))}</label><textarea id="deBody_txt" rows="9" style="width:100%;box-sizing:border-box;">${invEsc(d.body)}</textarea></div>
    <div style="font-size:12px;color:var(--ink-soft);margin-bottom:10px;">📎 ${invEsc(t('deAttach'))}: ${invEsc(deFileName())}</div>
    <div id="deMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="deClose()">${invEsc(t('deClose'))}</button><button class="btn" id="deSendBtn" onclick="deSend()" ${sender ? '' : 'disabled'}>${invEsc(t('deSend'))}</button></div>`;
}
function deFileName(){
  const r = deCtx.row, cn = deCtx.type === 'credit_note';
  return `${cn ? 'CreditNote' : 'Invoice'}_${deDocNo()}_${String(invCustLabel(r) || '').replace(/[^\w\-]+/g, '_').slice(0, 30)}.pdf`;
}
async function deRenderLog(){
  const body = document.getElementById('deBody'); if(!body) return;
  body.innerHTML = `<div class="empty-note">${invEsc(t('batchLoading'))}</div>`;
  const ctx = deCtx;
  try{
    const { data, error } = await sb.from('document_emails').select('*').eq('doc_type', ctx.type).eq('doc_id', ctx.id).order('sent_at', { ascending: false });
    if(error) throw error;
    if(deCtx !== ctx || ctx.tab !== 'log') return;
    const rows = (data || []).map(r => `<tr><td style="white-space:nowrap;vertical-align:top;">${invEsc(deWhen(r.sent_at))}</td><td style="vertical-align:top;">${invEsc(r.sent_by || '')}</td><td style="vertical-align:top;word-break:break-all;">${invEsc(r.to_email || '')}${r.cc_email ? `<div style="font-size:11px;color:var(--ink-soft);">CC ${invEsc(r.cc_email)}</div>` : ''}</td><td style="vertical-align:top;">${invEsc(r.subject || '')}<div style="font-size:11px;color:var(--ink-soft);word-break:break-all;">${invEsc(t('deLogFromShort'))}: ${invEsc(r.from_email || '')}${(r.reply_to && r.reply_to !== r.from_email) ? ` · ${invEsc(t('deLogReplyTo'))}: ${invEsc(r.reply_to)}` : ''}</div></td></tr>`).join('');
    body.innerHTML = (data || []).length
      ? `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${invEsc(t('deLogWhen'))}</th><th>${invEsc(t('deLogBy'))}</th><th>${invEsc(t('deLogTo'))}</th><th>${invEsc(t('deLogSubject'))}</th></tr></thead><tbody>${rows}</tbody></table></div><div class="modal-actions"><button class="btn ghost" onclick="deClose()">${invEsc(t('deClose'))}</button></div>`
      : `<div class="empty-note">${invEsc(t('deLogEmpty'))}</div><div class="modal-actions"><button class="btn ghost" onclick="deClose()">${invEsc(t('deClose'))}</button></div>`;
  }catch(e){
    if(deCtx !== ctx) return;
    const missing = e && (e.code === '42P01' || /document_emails/.test(e.message || ''));
    body.innerHTML = `<div class="empty-note">${invEsc(missing ? t('deNeedSql') : t('invLoadFailed'))}</div>`;
  }
}
function deBlobToBase64(blob){
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}
async function deSend(){
  if(!deCtx || deCtx.sending) return;
  const msg = document.getElementById('deMsg'), btn = document.getElementById('deSendBtn');
  const f = deReadForm(), sender = dePrimaryEmail();
  const re = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;
  const split = s => s.split(',').map(x => x.trim()).filter(Boolean);
  const to = split(f.to), cc = split(f.cc);
  const fail = k => { msg.className = 'msg error'; msg.textContent = t(k); };
  if(!sender) return fail('deNoSender');
  if(!to.length || to.some(x => !re.test(x))) return fail('deBadTo');
  if(cc.some(x => !re.test(x))) return fail('deBadCc');
  if(typeof html2pdf === 'undefined') return fail('deNoLib');
  deCtx.sending = true; if(btn) btn.disabled = true;
  msg.className = 'msg'; msg.textContent = t('deSending');
  const ctx = deCtx;
  try{
    try{ await loadInvoiceSettings(); }catch(e){}
    let snap;
    if(ctx.type === 'credit_note'){
      const { data, error } = await sb.from('credit_notes').select('snapshot').eq('id', ctx.id).maybeSingle();
      if(error || !data) throw error || new Error('not found');
      snap = data.snapshot;
    } else snap = await invFetchSnapshot(ctx.id);
    const pdf = await deBlobToBase64(await invPdfBlobFromSnap(snap));
    const res = await arInvoke('send-document-email', {
      docType: ctx.type, docId: ctx.id, docNo: (ctx.type === 'credit_note' ? '' : 'INV') + deDocNo(),
      to, cc, subject: f.subject, body: f.body, senderEmail: sender, senderName: deSenderName(),
      pdfBase64: pdf, pdfFilename: invFileName(snap)
    });
    if(!res.ok){
      const m = res.message || '';
      msg.className = 'msg error';
      msg.textContent = /forbidden/.test(m) ? t('deForbidden') : (/not found|NOT_FOUND|404|FunctionsFetchError|Failed to send/i.test(m) && !res.data.error ? t('deFnMissing') : `${t('deFail')}: ${m}${res.data && res.data.detail ? ' · ' + res.data.detail : ''}`);
      ctx.sending = false; if(btn) btn.disabled = false;
      return;
    }
    deSent[ctx.type + ':' + ctx.id] = (res.data && res.data.sentAt) || new Date().toISOString();
    ctx.sending = false; ctx.draft = null; ctx.tab = 'log';
    if(deCtx === ctx){ deRender(); }
    try{ if(ctx.type === 'credit_note') icCnRender(); else invRerenderLists(); }catch(e){}
  }catch(e){
    console.error('寄送 Invoice/Credit Note email 失敗', e);
    ctx.sending = false;
    const m2 = document.getElementById('deMsg'), b2 = document.getElementById('deSendBtn');
    if(m2){ m2.className = 'msg error'; m2.textContent = t('deFail'); }
    if(b2) b2.disabled = false;
  }
}

// ---------- 系統設置:預設內容 ----------
function deRenderTemplateCard(){
  const card = document.getElementById('docEmailCard'); if(!card) return;
  deLoadTemplate().then(() => {
    const s = document.getElementById('docEmailSubject'), b = document.getElementById('docEmailBody');
    if(s && document.activeElement !== s) s.value = docEmailTemplate.subject;
    if(b && document.activeElement !== b) b.value = docEmailTemplate.body;
  });
}
async function deSaveTemplate(){
  const s = (document.getElementById('docEmailSubject') || {}).value || '', b = (document.getElementById('docEmailBody') || {}).value || '';
  docEmailTemplate = { subject: s.trim() || DE_DEFAULT_TEMPLATE.subject, body: b.trim() ? b : DE_DEFAULT_TEMPLATE.body };
  const m = document.getElementById('docEmailMsg');
  try{ await dbSet('docEmailTemplate', JSON.stringify(docEmailTemplate)); if(m){ m.className = 'msg ok'; m.textContent = t('docEmailSaved'); setTimeout(() => { m.textContent = ''; }, 1800); } }
  catch(e){ console.error('儲存 Email 預設內容失敗', e); if(m){ m.className = 'msg error'; m.textContent = t('deFail'); } }
}
function deResetTemplate(){
  docEmailTemplate = Object.assign({}, DE_DEFAULT_TEMPLATE);
  const s = document.getElementById('docEmailSubject'), b = document.getElementById('docEmailBody');
  if(s) s.value = docEmailTemplate.subject; if(b) b.value = docEmailTemplate.body;
  deSaveTemplate();
}
// 會計 Email 清單每次重畫時,順便更新預設內容卡片(設定頁開啟/還原備份都會經過)
const _deRenderAcctEmails = renderAccountingEmailList;
renderAccountingEmailList = function(){ _deRenderAcctEmails.apply(this, arguments); deRenderTemplateCard(); };
// 讀清單時順便讀「已寄」標記
const _deInvLoadList = invLoadList;
invLoadList = async function(force){ await _deInvLoadList(force); await deLoadSent(!!force); };
const _deIcCnOpenList = icCnOpenList;
icCnOpenList = async function(force){ await deLoadSent(!!force); return _deIcCnOpenList(force); };
