// ============================================================
// 訂貨帳號線上申請
//  1. 登入頁「申請訂貨帳號」表單(公開,不需登入)→ Edge Function request-account
//  2. 申請人點 email 確認連結(?confirm_request=TOKEN)→ 申請單進入待審
//  3. 出貨方管理 →「待審申請」:管理者 / 會計審核(核准 = 連結或新增出貨方 + 建立訂貨帳號並寄歡迎信;拒絕 = 留紀錄)
// 申請資料只存在 account_requests 表;核准之前不會建立任何使用者或出貨方。
// ============================================================
Object.assign(I18N.zh, {
  arApplyLink: '申請訂貨帳號', arTitle: '申請訂貨帳號',
  arIntro: '請填寫公司資料,送出後我們會寄一封確認信到你的 Email;確認後由我們審核,通過會再寄信給你設定密碼。',
  arCompany: '公司名稱', arAbn: 'ABN(11 碼)', arContact: '聯繫人姓名', arPhone: '聯繫電話(選填)', arEmail: 'Email(用來登入)',
  arBillTo: 'Bill To 地址(選填,沒填就同 Ship To)', arShipTo: 'Ship To 送貨地址',
  arSubmit: '送出申請', arCancel: '取消', arSending: '送出中…',
  arErrRequired: '請填寫公司名稱、聯繫人姓名、Email 與 Ship To 地址。', arErrAbn: 'ABN 不正確,請確認是 11 碼數字。', arErrEmail: 'Email 格式不正確。',
  arErrCaptcha: '請先完成人機驗證。', arErrCaptchaFailed: '人機驗證失敗,請重試。',
  arErrTooMany: '申請次數太多,請稍後再試。', arErrDupAbn: '這個 ABN 已經有申請或帳號了,請聯絡我們。', arErrGeneric: '送出失敗,請稍後再試。',
  arSentTitle: '已寄出確認信', arSentMsg: '請到 {email} 收信並點確認連結(3 天內有效)。確認後我們才會開始審核。沒收到的話請看垃圾郵件匣。',
  arConfirmedMsg: '✓ Email 已確認,我們會盡快審核你的申請,通過後會寄信給你設定密碼。',
  arConfirmedAlready: '這個申請已經確認過了,不需要再點一次。',
  arConfirmExpired: '確認連結已過期,請重新申請。', arConfirmInvalid: '這個確認連結無效。', arConfirmError: '確認失敗,請稍後再試。',
  arTabPending: '待審', arTabDone: '已處理', arDoneEmpty: '還沒有已處理的申請。', arApprovedLabel: '已核准', arRejectedLabel: '已拒絕', arReason: '原因', arReviewedBy: '處理人', arReviewedAt: '處理時間', arKeepNote: '已拒絕的紀錄保留 180 天。', arBtnPending: '待審申請', arListTitle: '訂貨帳號申請(待審)', arListEmpty: '目前沒有待審的申請。',
  arColSubmitted: '申請時間', arFlagDupAbn: '⚠ 已有出貨方使用此 ABN:{name}', arFlagDupName: '⚠ 已有同名出貨方:{name}', arFlagDupEmail: '⚠ 已有出貨方使用此 Email:{name}',
  arBtnApprove: '核准', arBtnReject: '拒絕', arBtnRejectSelected: '拒絕所選', arSelectAll: '全選',
  arApproveTitle: '核准申請', arLinkExisting: '連結到現有出貨方', arCreateNew: '新增出貨方(帶入申請資料)',
  arPickParty: '— 選擇出貨方 —', arApproveHint: '核准後會建立一個只能看到此出貨方的訂貨帳號,並自動寄出歡迎信(含設定密碼連結)。',
  arDiscount: 'Discount(%)', arApproving: '核准中…', arApprovedOk: '✓ 已核准,歡迎信已寄到 {email}', arErrPickParty: '請選擇一個出貨方。',
  arApproveFailed: '核准失敗:{msg}', arRejectReason: '拒絕原因(選填,只留在紀錄,不會寄給申請人)', arRejectTitle: '拒絕申請',
  arRejectedOk: '✓ 已拒絕 {n} 筆申請', arRejectFailed: '拒絕失敗:{msg}', arNeedSql: '資料庫還沒建立申請資料表,請先執行 sql/account_requests.sql。',
  arPickRows: '請先勾選要拒絕的申請。', arClose: '關閉',
});
Object.assign(I18N.en, {
  arApplyLink: 'Apply for an ordering account', arTitle: 'Apply for an ordering account',
  arIntro: 'Fill in your company details. We will email you a confirmation link; once confirmed we review your request and email you a link to set your password.',
  arCompany: 'Company name', arAbn: 'ABN (11 digits)', arContact: 'Contact name', arPhone: 'Phone (optional)', arEmail: 'Email (used to sign in)',
  arBillTo: 'Bill To address (optional; defaults to Ship To)', arShipTo: 'Ship To address',
  arSubmit: 'Submit request', arCancel: 'Cancel', arSending: 'Sending…',
  arErrRequired: 'Please fill in company name, contact name, email and Ship To address.', arErrAbn: 'Invalid ABN — it must be 11 digits.', arErrEmail: 'Invalid email address.',
  arErrCaptcha: 'Please complete the human check first.', arErrCaptchaFailed: 'Human check failed, please try again.',
  arErrTooMany: 'Too many requests. Please try again later.', arErrDupAbn: 'This ABN already has a request or an account. Please contact us.', arErrGeneric: 'Could not submit. Please try again later.',
  arSentTitle: 'Confirmation email sent', arSentMsg: 'Check {email} and click the confirmation link (valid for 3 days). We only start reviewing after you confirm. Check your spam folder if you cannot find it.',
  arConfirmedMsg: '✓ Email confirmed. We will review your request soon and email you a link to set your password once approved.',
  arConfirmedAlready: 'This request has already been confirmed — no need to click again.',
  arConfirmExpired: 'This confirmation link has expired. Please apply again.', arConfirmInvalid: 'This confirmation link is not valid.', arConfirmError: 'Confirmation failed. Please try again later.',
  arTabPending: 'Pending', arTabDone: 'Processed', arDoneEmpty: 'No processed applications yet.', arApprovedLabel: 'Approved', arRejectedLabel: 'Rejected', arReason: 'Reason', arReviewedBy: 'Reviewed by', arReviewedAt: 'Reviewed at', arKeepNote: 'Rejected records are kept for 180 days.', arBtnPending: 'Pending applications', arListTitle: 'Ordering account applications (pending)', arListEmpty: 'No pending applications.',
  arColSubmitted: 'Submitted', arFlagDupAbn: '⚠ A customer already uses this ABN: {name}', arFlagDupName: '⚠ A customer with the same name exists: {name}', arFlagDupEmail: '⚠ A customer already uses this email: {name}',
  arBtnApprove: 'Approve', arBtnReject: 'Reject', arBtnRejectSelected: 'Reject selected', arSelectAll: 'Select all',
  arApproveTitle: 'Approve application', arLinkExisting: 'Link to an existing customer', arCreateNew: 'Create a new customer (prefilled from the application)',
  arPickParty: '— Select customer —', arApproveHint: 'Approving creates an ordering account that can only see this customer, and emails a welcome message with a set-password link.',
  arDiscount: 'Discount (%)', arApproving: 'Approving…', arApprovedOk: '✓ Approved. Welcome email sent to {email}', arErrPickParty: 'Please select a customer.',
  arApproveFailed: 'Approval failed: {msg}', arRejectReason: 'Reason (optional; kept in the record only, not sent to the applicant)', arRejectTitle: 'Reject application',
  arRejectedOk: '✓ Rejected {n} application(s)', arRejectFailed: 'Reject failed: {msg}', arNeedSql: 'The applications table does not exist yet — run sql/account_requests.sql first.',
  arPickRows: 'Select the applications to reject first.', arClose: 'Close',
});

const AR_E = s => (typeof escapeHtmlForPrint === 'function') ? escapeHtmlForPrint(s) : String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function arValidAbn(raw){
  const d = String(raw || '').replace(/\D/g, '');
  if(d.length !== 11) return false;
  const w = [10,1,3,5,7,9,11,13,15,17,19];
  const n = d.split('').map(Number); n[0] -= 1;
  return n.reduce((s, x, i) => s + x * w[i], 0) % 89 === 0;
}
function arFmtAbn(raw){
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0,2)} ${d.slice(2,5)} ${d.slice(5,8)} ${d.slice(8)}` : d;
}
// functions.invoke 對非 2xx 只給泛用錯誤;把函式回傳的 JSON 取出來
async function arInvoke(name, body){
  const { data, error } = await sb.functions.invoke(name, { body });
  if(!error) return { ok: true, data: data || {} };
  let payload = null;
  try{ if(error.context && typeof error.context.json === 'function') payload = await error.context.json(); }catch(e){}
  return { ok: false, data: payload || {}, message: (payload && payload.error) || error.message || 'error' };
}
function arOverlay(id, html, maxW){
  const old = document.getElementById(id); if(old) old.remove();
  const el = document.createElement('div');
  el.id = id; el.className = 'modal-overlay'; el.style.display = 'flex'; el.style.zIndex = '9000';
  el.innerHTML = `<div class="modal-box" style="max-width:min(${maxW || 480}px, 94vw);max-height:92vh;overflow-y:auto;">${html}</div>`;
  document.body.appendChild(el);
  return el;
}
function arClose(id){ const el = document.getElementById(id); if(el) el.remove(); }

// ---------- 1. 申請表單(登入頁) ----------
let arTurnstileId = null, arTurnstileToken = '';
function arTurnstileKey(){ return (typeof TURNSTILE_SITE_KEY !== 'undefined' && TURNSTILE_SITE_KEY) ? TURNSTILE_SITE_KEY : ''; }
function arLoadTurnstile(){
  const key = arTurnstileKey();
  if(!key) return;
  const render = () => {
    const host = document.getElementById('arTurnstileHost');
    if(!host || !window.turnstile) return;
    arTurnstileToken = '';
    arTurnstileId = window.turnstile.render(host, { sitekey: key, callback: tok => { arTurnstileToken = tok; }, 'expired-callback': () => { arTurnstileToken = ''; } });
  };
  if(window.turnstile){ render(); return; }
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true; s.onload = render;
  document.head.appendChild(s);
}
function openAccountRequestForm(){
  const f = (id, label, type, extra) => `<div class="field-block"><label>${t(label)}</label><input type="${type || 'text'}" id="${id}" style="width:100%;" ${extra || ''} /></div>`;
  arOverlay('arFormOverlay', `
    <div class="section-title" style="margin-bottom:8px;">${t('arTitle')}</div>
    <p style="font-size:12.5px;color:var(--ink-soft);margin:0 0 12px;">${t('arIntro')}</p>
    ${f('arCompany', 'arCompany', 'text', 'maxlength="120"')}
    ${f('arAbn', 'arAbn', 'text', 'inputmode="numeric" maxlength="14" placeholder="12 345 678 901"')}
    ${f('arContact', 'arContact', 'text', 'maxlength="80" autocomplete="name"')}
    ${f('arPhone', 'arPhone', 'tel', 'maxlength="40" autocomplete="tel"')}
    ${f('arEmail', 'arEmail', 'email', 'maxlength="160" autocomplete="email"')}
    <div class="field-block"><label>${t('arBillTo')}</label><textarea id="arBillTo" maxlength="400" style="width:100%;min-height:50px;font-family:inherit;"></textarea></div>
    <div class="field-block"><label>${t('arShipTo')}</label><textarea id="arShipTo" maxlength="400" style="width:100%;min-height:50px;font-family:inherit;"></textarea></div>
    <div style="position:absolute;left:-9999px;top:-9999px;height:0;overflow:hidden;" aria-hidden="true"><input type="text" id="arWebsite" tabindex="-1" autocomplete="off" /></div>
    <div id="arTurnstileHost" style="margin:8px 0;"></div>
    <div id="arMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="arClose('arFormOverlay')">${t('arCancel')}</button>
      <button class="btn" id="arSubmitBtn" onclick="submitAccountRequest()">${t('arSubmit')}</button>
    </div>`);
  arLoadTurnstile();
}
async function submitAccountRequest(){
  const v = id => (document.getElementById(id).value || '').trim();
  const msg = document.getElementById('arMsg'), btn = document.getElementById('arSubmitBtn');
  const fail = k => { msg.className = 'msg error'; msg.textContent = t(k); };
  const company = v('arCompany'), contactName = v('arContact'), email = v('arEmail'), shipTo = v('arShipTo');
  if(!company || !contactName || !email || !shipTo) return fail('arErrRequired');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('arErrEmail');
  if(!arValidAbn(v('arAbn'))) return fail('arErrAbn');
  if(arTurnstileKey() && !arTurnstileToken) return fail('arErrCaptcha');
  btn.disabled = true; btn.textContent = t('arSending'); msg.className = 'msg'; msg.textContent = '';
  const r = await arInvoke('request-account', {
    action: 'submit', company, abn: v('arAbn').replace(/\D/g, ''), contactName, phone: v('arPhone'), email,
    billTo: v('arBillTo'), shipTo, website: v('arWebsite'), turnstileToken: arTurnstileToken,
  });
  btn.disabled = false; btn.textContent = t('arSubmit');
  if(!r.ok){
    const code = r.data && r.data.error;
    if(window.turnstile && arTurnstileId !== null){ try{ window.turnstile.reset(arTurnstileId); arTurnstileToken = ''; }catch(e){} }
    return fail(code === 'bad_abn' ? 'arErrAbn' : code === 'bad_email' ? 'arErrEmail' : code === 'missing_fields' ? 'arErrRequired'
      : code === 'captcha_failed' ? 'arErrCaptchaFailed' : code === 'too_many' ? 'arErrTooMany' : code === 'duplicate_abn' ? 'arErrDupAbn' : 'arErrGeneric');
  }
  arClose('arFormOverlay');
  showInfoModal(t('arSentTitle') + '\n\n' + tf('arSentMsg', { email }));
}

// ---------- 2. Email 確認連結 ----------
async function handleConfirmRequestLink(){
  const params = new URLSearchParams(window.location.search);
  const token = params.get('confirm_request');
  if(!token) return;
  try{ params.delete('confirm_request'); const q = params.toString(); history.replaceState(null, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash); }catch(e){}
  const r = await arInvoke('request-account', { action: 'confirm', token });
  const state = r.data && r.data.state;
  showInfoModal(state === 'confirmed' ? t('arConfirmedMsg') : state === 'already' ? t('arConfirmedAlready')
    : state === 'expired' ? t('arConfirmExpired') : state === 'invalid' ? t('arConfirmInvalid') : t('arConfirmError'));
}

// ---------- 3. 審核(出貨方管理) ----------
let arPending = [], arPendingFetchedAt = 0, arView = 'pending';
function arCanReview(){ return !!currentUser && (currentUser.role === 'admin' || currentUser.role === 'accountant'); }
async function arFetchPending(){
  const { data, error } = await sb.from('account_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if(error) return { error };
  arPending = data || []; arPendingFetchedAt = Date.now();
  return { data: arPending };
}
async function acctReqRefreshBadge(force){
  const btn = document.getElementById('acctReqBtn');
  if(!btn) return;
  if(!arCanReview()){ btn.style.display = 'none'; return; }
  btn.style.display = '';
  if(force || Date.now() - arPendingFetchedAt > 30000) await arFetchPending();
  btn.textContent = `📝 ${t('arBtnPending')}${arPending.length ? ' (' + arPending.length + ')' : ''}`;
}
function arPartyMatches(r){
  const abn = String(r.abn || '').replace(/\D/g, ''), name = String(r.company_name || '').trim().toLowerCase(), em = String(r.email || '').toLowerCase();
  const out = {};
  (shippingParties || []).forEach(sp => {
    if(!out.abn && abn && String(sp.abn || '').replace(/\D/g, '') === abn) out.abn = sp;
    if(!out.name && name && [sp.name, sp.companyName].some(x => String(x || '').trim().toLowerCase() === name)) out.name = sp;
    if(!out.email && em && String(sp.email || '').trim().toLowerCase() === em) out.email = sp;
  });
  return out;
}
async function openAccountRequestList(){
  if(!arCanReview()) return;
  arOverlay('arListOverlay', `<div class="section-title" style="margin-bottom:10px;">${t('arListTitle')}</div>
    <div style="display:flex;gap:8px;margin-bottom:10px;"><button class="btn" id="arTabPending" onclick="arSetView('pending')">${t('arTabPending')}</button><button class="btn ghost" id="arTabDone" onclick="arSetView('done')">${t('arTabDone')}</button></div>
    <div id="arListBody"></div>`, 760);
  arView = 'pending';
  try{ sb.rpc('account_request_cleanup').then(() => {}, () => {}); }catch(e){}
  await arRenderList(true);
}
function arSetView(v){
  arView = v;
  const a = document.getElementById('arTabPending'), b = document.getElementById('arTabDone');
  if(a) a.className = 'btn' + (v === 'pending' ? '' : ' ghost');
  if(b) b.className = 'btn' + (v === 'done' ? '' : ' ghost');
  arRenderList(true);
}
async function arRenderDone(body){
  const { data, error } = await sb.from('account_requests').select('*').in('status', ['approved', 'rejected']).order('reviewed_at', { ascending: false }).limit(100);
  if(error){ body.innerHTML = `<div class="msg error">${AR_E(error.message)}</div>`; return; }
  const rows = (data || []).map(r => {
    const rej = r.status === 'rejected';
    const when = r.reviewed_at ? new Date(r.reviewed_at).toLocaleString(lang === 'zh' ? 'zh-TW' : 'en-AU') : '';
    return `<div style="border:1px solid var(--line,#ddd);border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:13px;">
      <div><span style="font-weight:600;font-size:14px;">${AR_E(r.company_name)}</span>
        <span style="margin-left:8px;color:${rej ? 'var(--crit)' : 'var(--ok,#2a7a3b)'};font-weight:600;">${t(rej ? 'arRejectedLabel' : 'arApprovedLabel')}</span></div>
      <div style="color:var(--ink-soft);">ABN ${AR_E(arFmtAbn(r.abn))} · ${AR_E(r.contact_name)}${r.phone ? ' · ' + AR_E(r.phone) : ''} · ${AR_E(r.email)}</div>
      <div style="color:var(--ink-soft);font-size:12px;margin-top:4px;">${t('arReviewedBy')}: ${AR_E(r.reviewed_by || '—')} · ${t('arReviewedAt')}: ${AR_E(when || '—')}</div>
      ${rej ? `<div style="margin-top:4px;">${t('arReason')}: ${AR_E(r.reject_reason || '—')}</div>` : ''}
    </div>`;
  }).join('');
  body.innerHTML = (rows || `<div class="empty-note">${t('arDoneEmpty')}</div>`)
    + `<div style="font-size:11.5px;color:var(--ink-soft);margin-top:6px;">${t('arKeepNote')}</div>
    <div class="modal-actions"><button class="btn ghost" onclick="arClose('arListOverlay')">${t('arClose')}</button></div>`;
}
async function arRenderList(refetch){
  const body = document.getElementById('arListBody');
  if(!body) return;
  if(arView === 'done'){ await arRenderDone(body); return; }
  if(refetch){
    const r = await arFetchPending();
    if(r.error){ body.innerHTML = `<div class="msg error">${AR_E(/relation|does not exist|schema cache/i.test(r.error.message || '') ? t('arNeedSql') : r.error.message)}</div><div class="modal-actions"><button class="btn ghost" onclick="arClose('arListOverlay')">${t('arClose')}</button></div>`; return; }
  }
  acctReqRefreshBadge(false);
  if(!arPending.length){
    body.innerHTML = `<div class="empty-note">${t('arListEmpty')}</div><div class="modal-actions"><button class="btn ghost" onclick="arClose('arListOverlay')">${t('arClose')}</button></div>`;
    return;
  }
  const cards = arPending.map(r => {
    const m = arPartyMatches(r);
    const flags = [m.abn && tf('arFlagDupAbn', { name: m.abn.name }), m.name && tf('arFlagDupName', { name: m.name.name }), m.email && tf('arFlagDupEmail', { name: m.email.name })].filter(Boolean)
      .map(x => `<div style="color:var(--crit);font-size:12px;margin-top:4px;">${AR_E(x)}</div>`).join('');
    const when = new Date(r.created_at).toLocaleString(lang === 'zh' ? 'zh-TW' : 'en-AU');
    return `<div style="border:1px solid var(--line,#ddd);border-radius:8px;padding:10px 12px;margin-bottom:10px;display:flex;gap:10px;">
      <input type="checkbox" class="arSel" value="${r.id}" style="margin-top:4px;" />
      <div style="flex:1;min-width:0;font-size:13px;">
        <div style="font-weight:600;font-size:14px;">${AR_E(r.company_name)}</div>
        <div style="color:var(--ink-soft);">ABN ${AR_E(arFmtAbn(r.abn))} · ${AR_E(r.contact_name)}${r.phone ? ' · ' + AR_E(r.phone) : ''} · ${AR_E(r.email)}</div>
        <div style="margin-top:4px;white-space:pre-line;">Ship To: ${AR_E(r.ship_to)}${r.bill_to ? '\nBill To: ' + AR_E(r.bill_to) : ''}</div>
        <div style="color:var(--ink-soft);font-size:11.5px;margin-top:4px;">${t('arColSubmitted')}: ${AR_E(when)}</div>
        ${flags}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button class="btn" onclick="openAccountRequestApprove('${r.id}')">${t('arBtnApprove')}</button>
        <button class="btn ghost" style="color:var(--crit);border-color:var(--crit);" onclick="openAccountRequestReject(['${r.id}'])">${t('arBtnReject')}</button>
      </div></div>`;
  }).join('');
  body.innerHTML = `
    <label style="font-size:12.5px;display:inline-flex;align-items:center;gap:6px;margin-bottom:8px;"><input type="checkbox" onchange="document.querySelectorAll('.arSel').forEach(c => c.checked = this.checked)" /> ${t('arSelectAll')}</label>
    ${cards}
    <div id="arListMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" style="margin-right:auto;color:var(--crit);border-color:var(--crit);" onclick="arRejectSelected()">${t('arBtnRejectSelected')}</button>
      <button class="btn ghost" onclick="arClose('arListOverlay')">${t('arClose')}</button>
    </div>`;
}
function arListMsg(text, ok){ const m = document.getElementById('arListMsg'); if(m){ m.className = 'msg ' + (ok ? 'ok' : 'error'); m.textContent = text; } }

// 核准
function openAccountRequestApprove(id){
  const r = arPending.find(x => x.id === id);
  if(!r) return;
  const m = arPartyMatches(r);
  const match = m.abn || m.name || m.email || null;
  const opts = (shippingParties || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(sp => `<option value="${AR_E(sp.id)}" ${match && match.id === sp.id ? 'selected' : ''}>${AR_E(partyOptionLabel(sp))}</option>`).join('');
  arOverlay('arApproveOverlay', `
    <div class="section-title" style="margin-bottom:6px;">${t('arApproveTitle')}</div>
    <div style="font-size:13px;margin-bottom:6px;"><b>${AR_E(r.company_name)}</b> · ${AR_E(r.email)}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 10px;">${t('arApproveHint')}</p>
    <label style="display:flex;gap:6px;align-items:center;margin-bottom:6px;"><input type="radio" name="arMode" value="existing" ${match ? 'checked' : ''} onchange="arApproveMode()" /> ${t('arLinkExisting')}</label>
    <select id="arPartySel" style="width:100%;margin-bottom:12px;"><option value="">${t('arPickParty')}</option>${opts}</select>
    <label style="display:flex;gap:6px;align-items:center;margin-bottom:6px;"><input type="radio" name="arMode" value="new" ${match ? '' : 'checked'} onchange="arApproveMode()" /> ${t('arCreateNew')}</label>
    <div id="arNewBox">
      <div class="field-block"><label>${t('fieldPaymentType')}</label>
        <select id="arPayType" style="width:100%;" onchange="document.getElementById('arPayTerm').disabled = this.value === 'cod'"><option value="bank">Bank Transfer</option><option value="cod">COD</option></select></div>
      <div class="field-block"><label>${t('fieldPaymentTerm')}</label>
        <select id="arPayTerm" style="width:100%;">${[7,14,21,30,45,60].map(d => `<option value="${d}">${d} Days</option>`).join('')}</select></div>
      <div class="field-block"><label>${t('arDiscount')}</label><input type="number" id="arDisc" min="0" max="100" step="any" placeholder="0" style="width:120px;" /></div>
    </div>
    <div id="arApproveMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="arClose('arApproveOverlay')">${t('arCancel')}</button>
      <button class="btn" id="arApproveBtn" onclick="confirmAccountRequestApprove('${r.id}')">${t('arBtnApprove')}</button>
    </div>`);
  arApproveMode();
}
function arApproveMode(){
  const mode = (document.querySelector('input[name="arMode"]:checked') || {}).value;
  document.getElementById('arPartySel').disabled = mode !== 'existing';
  document.getElementById('arNewBox').style.display = mode === 'new' ? '' : 'none';
}
async function confirmAccountRequestApprove(id){
  const r = arPending.find(x => x.id === id);
  if(!r) return;
  const msg = document.getElementById('arApproveMsg'), btn = document.getElementById('arApproveBtn');
  const mode = (document.querySelector('input[name="arMode"]:checked') || {}).value;
  let partyId = '', created = null;
  if(mode === 'existing'){
    partyId = document.getElementById('arPartySel').value;
    if(!partyId){ msg.className = 'msg error'; msg.textContent = t('arErrPickParty'); return; }
  } else {
    const dRaw = document.getElementById('arDisc').value.trim();
    const discount = dRaw === '' ? 0 : Number(dRaw);
    if(!Number.isFinite(discount) || discount < 0 || discount > 100){ msg.className = 'msg error'; msg.textContent = t('errPartyDiscountInvalid'); return; }
    const payType = document.getElementById('arPayType').value === 'cod' ? 'cod' : 'bank';
    created = {
      id: genId(), hiddenProductIds: [], name: r.company_name, companyName: r.company_name, contactPerson: r.contact_name,
      phone: r.phone || '', email: r.email, billTo: r.bill_to || '', shipTo: r.ship_to || '', abn: arFmtAbn(r.abn),
      paymentType: payType, paymentTerm: payType === 'cod' ? 0 : (parseInt(document.getElementById('arPayTerm').value, 10) || 7),
      note: '', orderFrequency: 'weekly', discount,
    };
    created.code = nextEntityCode('C', shippingParties);
    shippingParties.push(created);
    try{ await saveShippingParties(); }
    catch(e){ shippingParties = shippingParties.filter(x => x.id !== created.id); msg.className = 'msg error'; msg.textContent = tf('arApproveFailed', { msg: e.message || e }); return; }
    partyId = created.id;
  }
  btn.disabled = true; btn.textContent = t('arApproving'); msg.className = 'msg'; msg.textContent = '';
  const res = await arInvoke('approve-account', { requestId: id, partyId, appUrl: appBaseUrl() });
  btn.disabled = false; btn.textContent = t('arBtnApprove');
  if(!res.ok){
    // 帳號尚未建立成功(沒有 userId 記錄)才還原剛新增的出貨方;已建立帳號但寄信失敗時保留,讓管理者再按一次核准重寄
    const mailFailed = /Email sending failed/i.test(res.message || '');
    if(created && !mailFailed){
      shippingParties = shippingParties.filter(x => x.id !== created.id);
      try{ await saveShippingParties(); }catch(e){}
    }
    msg.className = 'msg error'; msg.textContent = tf('arApproveFailed', { msg: res.message });
    if(mailFailed && created){ arPendingFixPartyChoice(id, created.id); }
    return;
  }
  arClose('arApproveOverlay');
  renderPartiesTable(); try{ populatePartySelect(); }catch(e){}
  await arRenderList(true);
  arListMsg(tf('arApprovedOk', { email: r.email }), true);
}
// 寄信失敗後再按「核准」:帳號已綁定剛新增的出貨方,直接改成「連結現有出貨方」避免重複建立
function arPendingFixPartyChoice(reqId, partyId){
  const sel = document.getElementById('arPartySel');
  if(!sel) return;
  if(![...sel.options].some(o => o.value === partyId)){
    const sp = shippingParties.find(x => x.id === partyId);
    if(sp){ const o = document.createElement('option'); o.value = sp.id; o.textContent = partyOptionLabel(sp); sel.appendChild(o); }
  }
  sel.value = partyId;
  const radio = document.querySelector('input[name="arMode"][value="existing"]');
  if(radio) radio.checked = true;
  arApproveMode();
}

// 拒絕(單筆 / 多筆)
function arRejectSelected(){
  const ids = [...document.querySelectorAll('.arSel:checked')].map(c => c.value);
  if(!ids.length){ arListMsg(t('arPickRows'), false); return; }
  openAccountRequestReject(ids);
}
function openAccountRequestReject(ids){
  arOverlay('arRejectOverlay', `
    <div class="section-title" style="margin-bottom:8px;">${t('arRejectTitle')} (${ids.length})</div>
    <div class="field-block"><label>${t('arRejectReason')}</label><textarea id="arRejectReason" maxlength="300" style="width:100%;min-height:60px;font-family:inherit;"></textarea></div>
    <div id="arRejectMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="arClose('arRejectOverlay')">${t('arCancel')}</button>
      <button class="btn" style="background:var(--crit);" id="arRejectBtn" onclick='confirmAccountRequestReject(${JSON.stringify(ids)})'>${t('arBtnReject')}</button>
    </div>`, 420);
}
async function confirmAccountRequestReject(ids){
  const reason = (document.getElementById('arRejectReason').value || '').trim();
  const msg = document.getElementById('arRejectMsg');
  document.getElementById('arRejectBtn').disabled = true;
  const { data, error } = ids.length === 1
    ? await sb.rpc('account_request_reject', { p_id: ids[0], p_reason: reason })
    : await sb.rpc('account_request_bulk_reject', { p_ids: ids, p_reason: reason });
  if(error){ document.getElementById('arRejectBtn').disabled = false; msg.className = 'msg error'; msg.textContent = tf('arRejectFailed', { msg: error.message }); return; }
  arClose('arRejectOverlay');
  await arRenderList(true);
  arListMsg(tf('arRejectedOk', { n: ids.length === 1 ? 1 : (Number(data) || ids.length) }), true);
}
