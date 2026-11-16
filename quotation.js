// ============================================================
// Quotation(報價單)— 會計 > Quotation
//   · 每張報價單有自動編號 Q-0001(建立時給、之後不變,作廢的號碼不會重用)
//   · 抬頭:開立日期、To(出貨方或手動輸入)、聯絡人/電話/Email/地址、Sales Rep
//   · 商品行:最低數量、商品描述、單價(不含 GST)、每箱數量;可從庫存商品挑,也可自由輸入
//   · 到期日:一週 / 兩週 / 一個月自動算,或手填;印在報價單上;列表顯示 有效 / 已過期 / 已作廢
//   · 資料存在 app_data 的 'quotations'(JSON),不需要 SQL;可輸出 PDF / 列印、複製成新報價單
// ============================================================
let qtData = { next: 1, defaultNote: '', items: [] };
let qtLoaded = false;
let qtEditing = null;          // 目前編輯中的報價單(草稿物件);null = 顯示列表
let qtFilter = { q: '', status: 'all' };

function qtEsc(s){ return (typeof invEsc === 'function') ? invEsc(s) : String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function qtToday(){ return (typeof invToday === 'function') ? invToday() : new Date().toISOString().slice(0, 10); }
function qtDmy(iso){ return (typeof invIsoToDmy === 'function') ? invIsoToDmy(iso) : iso; }
function qtNo(n){ return 'Q-' + String(n).padStart(4, '0'); }
function qtMoney(n){ const v = Number(n); return Number.isFinite(v) ? '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''; }
// 每行:Qty × 單價(不含 GST)= 小計,GST 10%(每行四捨五入到分),Total = 小計 + GST。Qty 不是數字或沒填單價的行不計入合計。
const QT_GST_RATE = 0.1;
function qtLineCalc(l){
  const qty = parseFloat(String(l.minQty == null ? '' : l.minQty).replace(/,/g, ''));
  const price = (l.price === '' || l.price == null) ? NaN : Number(l.price);
  if(!Number.isFinite(qty) || !Number.isFinite(price)) return null;
  const ex = Math.round(qty * price * 100) / 100;
  const gst = Math.round(ex * QT_GST_RATE * 100) / 100;
  return { ex, gst, total: Math.round((ex + gst) * 100) / 100 };
}
function qtTotals(lines){
  let ex = 0, gst = 0;
  (lines || []).forEach(l => { const c = qtLineCalc(l); if(c){ ex += c.ex; gst += c.gst; } });
  ex = Math.round(ex * 100) / 100; gst = Math.round(gst * 100) / 100;
  return { ex, gst, total: Math.round((ex + gst) * 100) / 100 };
}
function qtTotalsEditorHtml(lines){
  const s = qtTotals(lines);
  return `${t('qtSubtotal')}: <b>${qtMoney(s.ex)}</b> &nbsp;·&nbsp; GST 10%: <b>${qtMoney(s.gst)}</b> &nbsp;·&nbsp; ${t('qtTotalInc')}: <b>${qtMoney(s.total)}</b>`;
}
function qtUpdateTotals(){
  const el = document.getElementById('qtTotalsLive');
  if(el && qtEditing) el.innerHTML = qtTotalsEditorHtml(qtEditing.lines);
}
function qtAddDays(iso, d){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if(!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + d));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}
function qtAddMonth(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if(!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2], +m[3]));   // 月份 +1(m[2] 是 1 起算,Date 月份 0 起算)
  if(dt.getUTCDate() !== +m[3]) dt.setUTCDate(0);        // 例如 1/31 → 2/28:退回上個月最後一天
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}
function qtExpiryFromPreset(issue, preset){
  if(preset === 'week') return qtAddDays(issue, 7);
  if(preset === 'fortnight') return qtAddDays(issue, 14);
  if(preset === 'month') return qtAddMonth(issue);
  return '';
}
function qtStatusOf(q){
  if(q.void) return 'void';
  if(q.expiryDate && q.expiryDate < qtToday()) return 'expired';
  return 'valid';
}
function qtStatusLabel(st){ return st === 'void' ? t('qtStatusVoid') : (st === 'expired' ? t('qtStatusExpired') : t('qtStatusValid')); }
function qtCanUse(){ return typeof currentUser !== 'undefined' && !!currentUser && (currentUser.role === 'admin' || currentUser.role === 'accountant' || currentUser.role === 'sales'); }

async function qtLoad(){
  try{
    const r = await dbGet('quotations');
    if(r && r.value){
      const o = JSON.parse(r.value);
      if(o && Array.isArray(o.items)) qtData = { next: Math.max(1, parseInt(o.next, 10) || 1), defaultNote: (typeof o.defaultNote === 'string' && o.defaultNote.trim() !== '10% GST to be applied.') ? o.defaultNote : '', items: o.items };
    }
  }catch(e){ console.error('讀取報價單失敗', e); }
  // 保險:編號永遠大於已存在的最大號碼
  qtData.items.forEach(q => { const m = /^Q-(\d+)$/.exec(q.no || ''); if(m && +m[1] >= qtData.next) qtData.next = +m[1] + 1; });
  qtLoaded = true;
}
async function qtPersist(){ await dbSet('quotations', JSON.stringify(qtData)); }

async function qtOpenPage(){
  if(!qtLoaded) await qtLoad();
  qtEditing = null;
  qtRender();
}

// ---------- 列表 ----------
function qtRender(){
  const root = document.getElementById('quotationRoot'); if(!root) return;
  if(qtEditing){ qtRenderEditor(root); return; }
  root.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px;">
      <button class="btn" onclick="qtNew()">＋ ${t('qtNew')}</button>
      <input type="text" id="qtSearch" value="${qtEsc(qtFilter.q)}" placeholder="${qtEsc(t('qtSearchPh'))}" oninput="qtFilter.q=this.value;qtRenderListOnly()" style="width:240px;" />
      <select onchange="qtFilter.status=this.value;qtRenderListOnly()" style="width:auto;">
        ${['all', 'valid', 'expired', 'void'].map(s => `<option value="${s}" ${qtFilter.status === s ? 'selected' : ''}>${s === 'all' ? t('qtStatusAll') : qtStatusLabel(s)}</option>`).join('')}
      </select>
    </div>
    <div id="qtListHost"></div>`;
  qtRenderListOnly();
}
function qtRenderListOnly(){
  const host = document.getElementById('qtListHost'); if(!host) return;
  const q = (qtFilter.q || '').trim().toLowerCase();
  const rows = qtData.items.slice().sort((a, b) => (b.no || '').localeCompare(a.no || '')).filter(x => {
    const st = qtStatusOf(x);
    if(qtFilter.status !== 'all' && st !== qtFilter.status) return false;
    return !q || [x.no, x.toName, x.contactPerson, x.salesRep].join(' ').toLowerCase().includes(q);
  });
  host.innerHTML = qtListHtml(rows);
}
function qtListHtml(rows){
  if(!rows.length) return `<div class="empty-note">${t('qtEmpty')}</div>`;
  const stColor = { valid: 'var(--safe)', expired: 'var(--warn)', void: 'var(--ink-soft)' };
  return `<div style="overflow-x:auto;"><table class="stock-table">
    <thead><tr><th>Quote #</th><th>${t('qtColIssue')}</th><th>${t('qtColTo')}</th><th>${t('qtColRep')}</th><th>${t('qtColExpiry')}</th><th>${t('qtColStatus')}</th><th></th></tr></thead>
    <tbody>${rows.map(x => {
      const st = qtStatusOf(x);
      return `<tr>
        <td class="row-name"><span class="del-link" style="font-weight:600;" onclick="qtOpen('${x.id}')">${qtEsc(x.no)}</span></td>
        <td>${qtEsc(qtDmy(x.issueDate))}</td>
        <td>${qtEsc(x.toName)}</td>
        <td>${qtEsc(x.salesRep)}</td>
        <td>${qtEsc(qtDmy(x.expiryDate))}</td>
        <td style="color:${stColor[st]};font-weight:600;white-space:nowrap;">${qtStatusLabel(st)}</td>
        <td style="white-space:nowrap;text-align:right;">
          <span class="del-link" style="color:var(--ink);" onclick="qtOpen('${x.id}')">${t('qtBtnOpen')}</span>
          <span class="del-link" style="margin-left:10px;color:var(--ink);" onclick="qtCopy('${x.id}')">${t('qtBtnCopy')}</span>
          <span class="del-link" style="margin-left:10px;color:var(--ink);" onclick="qtPdfById('${x.id}')">PDF</span>
          <span class="del-link" style="margin-left:10px;" onclick="qtToggleVoid('${x.id}')">${x.void ? t('qtBtnRestore') : t('qtBtnVoid')}</span>
        </td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ---------- 新增 / 開啟 / 複製 ----------
function qtMyName(){ try{ return (typeof currentUser !== 'undefined' && currentUser && typeof userDisplayName === 'function') ? userDisplayName(currentUser) : ''; }catch(e){ return ''; } }
function qtBlank(){
  const issue = qtToday();
  return {
    id: '', no: '', issueDate: issue, expiryPreset: 'month', expiryDate: qtAddMonth(issue),
    toName: '', partyId: '', contactPerson: '', phone: '', email: '', address: '',
    salesRep: qtMyName(), lines: [qtBlankLine()], note: qtData.defaultNote || '', void: false
  };
}
function qtBlankLine(){ return { minQty: '', desc: '', price: '', perCtn: '', productId: '', priceEdited: false }; }
// 單價自動帶入:定價管理的售價 × 出貨方折扣(跟開 Invoice 同一套計算);手動改過的價錢不會被蓋掉
function qtFindProductByName(name){
  const n = String(name || '').trim().toLowerCase(); if(!n) return null;
  try{ return (products || []).find(p => !p.hidden && String(p.name || '').trim().toLowerCase() === n) || null; }catch(e){ return null; }
}
function qtAutoPrice(l){
  if(!l.productId || typeof spPriceOrderItem !== 'function') return null;
  try{
    const qty = parseFloat(String(l.minQty || '').replace(/,/g, '')) || 1;
    const pr = spPriceOrderItem({ partyId: (qtEditing && qtEditing.partyId) || '', status: 'pending', items: [] }, { productId: l.productId, qty });
    if(pr && pr.unit !== null && pr.unit !== undefined && Number.isFinite(Number(pr.unit))) return Math.round(Number(pr.unit) * 100) / 100;
  }catch(e){}
  return null;
}
// 重新帶入某一行(沒手動改過價錢才會),並把畫面上的單價欄位更新
function qtRepriceLine(i){
  const l = qtEditing && qtEditing.lines[i]; if(!l || l.priceEdited) return;
  const p = qtAutoPrice(l);
  l.price = p === null ? '' : p;
  const el = document.getElementById('qtPrice' + i); if(el) el.value = l.price;
  qtUpdateTotals();
}
function qtOnDescChange(i, val){
  const l = qtEditing.lines[i]; if(!l) return;
  l.desc = val;
  const p = qtFindProductByName(val);
  l.productId = p ? p.id : '';
  if(p){ l.priceEdited = false; qtRepriceLine(i); }
}
function qtOnQtyChange(i, val){
  const l = qtEditing.lines[i]; if(!l) return;
  l.minQty = val;
  qtRepriceLine(i);   // 售價有數量階梯時,數量改了價錢可能跟著變
  qtUpdateTotals();
}
function qtOnPriceInput(i, val){
  const l = qtEditing.lines[i]; if(!l) return;
  l.price = val;
  l.priceEdited = String(val).trim() !== '';   // 清空 = 回到自動帶入
  if(!l.priceEdited) qtRepriceLine(i);
  qtUpdateTotals();
}
function qtNew(){ qtEditing = qtBlank(); qtRender(); }
function qtOpen(id){
  const q = qtData.items.find(x => x.id === id); if(!q) return;
  qtEditing = JSON.parse(JSON.stringify(q));
  if(!qtEditing.lines || !qtEditing.lines.length) qtEditing.lines = [qtBlankLine()];
  qtRender();
}
function qtCopy(id){
  const q = qtData.items.find(x => x.id === id); if(!q) return;
  const c = JSON.parse(JSON.stringify(q));
  const issue = qtToday();
  Object.assign(c, { id: '', no: '', void: false, issueDate: issue, expiryPreset: 'month', expiryDate: qtAddMonth(issue), salesRep: qtMyName() || c.salesRep, createdAt: undefined, createdBy: undefined, updatedAt: undefined });
  qtEditing = c; qtRender();
}
async function qtToggleVoid(id){
  const q = qtData.items.find(x => x.id === id); if(!q) return;
  const go = async () => {
    await qtLoad();   // 先讀最新,避免蓋掉別人剛存的
    const cur = qtData.items.find(x => x.id === id); if(!cur) return;
    cur.void = !cur.void; cur.updatedAt = new Date().toISOString();
    try{ await qtPersist(); }catch(e){ showInfoModal(t('qtSaveFail')); return; }
    qtRender();
  };
  if(!q.void) showConfirmModal(tf('qtVoidConfirm', { no: q.no }), go); else go();
}

// ---------- 編輯畫面 ----------
function qtPartyOptionsHtml(){
  try{ return (shippingParties || []).map(sp => `<option value="${qtEsc(sp.name)}"></option>`).join(''); }catch(e){ return ''; }
}
function qtProductOptionsHtml(){
  try{ return (products || []).filter(p => !p.hidden).map(p => `<option value="${qtEsc(p.name)}"></option>`).join(''); }catch(e){ return ''; }
}
function qtRenderEditor(root){
  const q = qtEditing;
  const presetBtn = (k, label) => `<button type="button" class="btn ${q.expiryPreset === k ? '' : 'ghost'}" style="padding:5px 10px;" onclick="qtSetPreset('${k}')">${label}</button>`;
  root.innerHTML = `
    <datalist id="qtPartyList">${qtPartyOptionsHtml()}</datalist>
    <datalist id="qtProductList">${qtProductOptionsHtml()}</datalist>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px;">
      <button class="btn ghost" onclick="qtBack()">← ${t('qtBackToList')}</button>
      <strong style="font-size:15px;">${q.no ? qtEsc(q.no) : t('qtNewTitle')}</strong>
      ${q.void ? `<span style="color:var(--ink-soft);font-weight:600;">(${t('qtStatusVoid')})</span>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;max-width:900px;">
      <div class="field"><label>${t('qtIssueDate')}</label><input type="date" id="qtIssue" value="${qtEsc(q.issueDate)}" onchange="qtOnIssueChange(this.value)" /></div>
      <div class="field"><label>${t('qtSalesRep')}</label><input type="text" id="qtRep" value="${qtEsc(q.salesRep)}" /></div>
      <div class="field"><label>${t('qtTo')}</label><input type="text" id="qtTo" list="qtPartyList" value="${qtEsc(q.toName)}" onchange="qtOnToChange(this.value)" placeholder="${qtEsc(t('qtToPh'))}" /></div>
      <div class="field"><label>${t('qtContact')}</label><input type="text" id="qtContact" value="${qtEsc(q.contactPerson)}" /></div>
      <div class="field"><label>${t('qtPhone')}</label><input type="text" id="qtPhone" value="${qtEsc(q.phone)}" /></div>
      <div class="field"><label>E-mail</label><input type="text" id="qtEmail" value="${qtEsc(q.email)}" /></div>
      <div class="field" style="grid-column:1/-1;"><label>${t('qtAddress')}</label><input type="text" id="qtAddr" value="${qtEsc(q.address)}" /></div>
    </div>
    <div class="field" style="margin-top:10px;">
      <label>${t('qtExpiry')}</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        ${presetBtn('week', t('qtPresetWeek'))}${presetBtn('fortnight', t('qtPresetFortnight'))}${presetBtn('month', t('qtPresetMonth'))}
        <input type="date" id="qtExpiryDate" value="${qtEsc(q.expiryDate)}" onchange="qtOnExpiryManual(this.value)" style="width:auto;" />
        <span style="font-size:12px;color:var(--ink-soft);">${q.expiryPreset === 'custom' ? t('qtPresetCustom') : ''}</span>
      </div>
    </div>
    <div class="section-title" style="font-size:13px;margin:14px 0 6px;">${t('qtLines')}</div>
    <div style="overflow-x:auto;"><table class="stock-table" style="min-width:640px;">
      <thead><tr><th style="width:110px;">${t('qtMinQty')}</th><th>${t('qtDesc')}</th><th style="width:130px;">${t('qtPrice')}</th><th style="width:120px;">Qty/CTN</th><th style="width:34px;"></th></tr></thead>
      <tbody id="qtLinesBody">${q.lines.map((l, i) => qtLineRowHtml(l, i)).join('')}</tbody>
    </table></div>
    <button class="btn ghost" style="margin-top:8px;" onclick="qtAddLine()">＋ ${t('qtAddLine')}</button>
 <div style="margin-top:6px;font-size:12px;color:var(--ink-soft);">${t('qtPriceAutoHint')}</div>
    <div id="qtTotalsLive" style="margin-top:10px;font-size:13px;">${qtTotalsEditorHtml(q.lines)}</div>
    <div class="field-block" style="margin-top:12px;max-width:900px;">
      <label>${t('qtNote')}</label>
      <textarea id="qtNote" rows="4" style="width:100%;">${qtEsc(q.note)}</textarea>
    </div>
    <div id="qtMsg" class="msg"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
      <button class="btn" onclick="qtSave()">${t('qtBtnSave')}</button>
      <button class="btn ghost" onclick="qtPreview()">${t('qtBtnPreview')}</button>
      <button class="btn ghost" onclick="qtPdfDraft()">PDF</button>
      <button class="btn ghost" onclick="qtPrintDraft()">${t('qtBtnPrint')}</button>
    </div>`;
}
function qtLineRowHtml(l, i){
  return `<tr>
    <td><input type="text" value="${qtEsc(l.minQty)}" oninput="qtOnQtyChange(${i}, this.value)" style="width:100%;" /></td>
    <td><input type="text" list="qtProductList" value="${qtEsc(l.desc)}" onchange="qtOnDescChange(${i}, this.value)" oninput="qtEditing.lines[${i}].desc=this.value" style="width:100%;" /></td>
    <td><input type="number" id="qtPrice${i}" step="any" min="0" value="${qtEsc(l.price)}" oninput="qtOnPriceInput(${i}, this.value)" style="width:100%;" placeholder="0.00" /></td>
    <td><input type="text" value="${qtEsc(l.perCtn)}" oninput="qtEditing.lines[${i}].perCtn=this.value" style="width:100%;" /></td>
    <td><span class="fc-row-del" onclick="qtRemoveLine(${i})" title="${qtEsc(t('qtRemoveLine'))}">✕</span></td>
  </tr>`;
}
function qtAddLine(){ qtSyncFields(); qtEditing.lines.push(qtBlankLine()); qtRender(); }
function qtRemoveLine(i){
  qtSyncFields();
  qtEditing.lines.splice(i, 1);
  if(!qtEditing.lines.length) qtEditing.lines.push(qtBlankLine());
  qtRender();
}
// 把畫面上的抬頭欄位讀回草稿(商品行是 oninput 即時寫回的)
function qtSyncFields(){
  const q = qtEditing; if(!q) return;
  const g = id => { const el = document.getElementById(id); return el ? el.value : null; };
  const v = (id, key, trim) => { const x = g(id); if(x !== null) q[key] = trim ? x.trim() : x; };
  v('qtIssue', 'issueDate'); v('qtRep', 'salesRep', true); v('qtTo', 'toName', true); v('qtContact', 'contactPerson', true);
  v('qtPhone', 'phone', true); v('qtEmail', 'email', true); v('qtAddr', 'address', true); v('qtNote', 'note'); v('qtExpiryDate', 'expiryDate');
}
function qtOnIssueChange(val){
  qtSyncFields();
  qtEditing.issueDate = val;
  if(qtEditing.expiryPreset !== 'custom') qtEditing.expiryDate = qtExpiryFromPreset(val, qtEditing.expiryPreset);
  qtRender();
}
function qtSetPreset(k){
  qtSyncFields();
  qtEditing.expiryPreset = k;
  qtEditing.expiryDate = qtExpiryFromPreset(qtEditing.issueDate, k);
  qtRender();
}
function qtOnExpiryManual(val){
  qtSyncFields();
  qtEditing.expiryDate = val;
  qtEditing.expiryPreset = 'custom';
  qtRender();
}
// To 選到現有出貨方:自動帶入聯絡人 / 電話 / Email / 地址(只填目前空白的欄位,不蓋掉手打的)
function qtOnToChange(val){
  qtSyncFields();
  const name = (val || '').trim();
  const sp = (typeof shippingParties !== 'undefined' ? shippingParties : []).find(x => (x.name || '').trim().toLowerCase() === name.toLowerCase());
  if(sp){
    qtEditing.partyId = sp.id;
    if(!qtEditing.contactPerson) qtEditing.contactPerson = sp.contactPerson || '';
    if(!qtEditing.phone) qtEditing.phone = sp.phone !== undefined ? sp.phone : (sp.contact || '');
    if(!qtEditing.email) qtEditing.email = sp.email || '';
    if(!qtEditing.address) qtEditing.address = sp.shipTo !== undefined ? sp.shipTo : (sp.billTo || '');
  } else qtEditing.partyId = '';
  qtEditing.lines.forEach((l, i) => qtRepriceLine(i));   // 出貨方折扣不同 → 沒手動改過的單價重新帶入
  qtRender();
}
function qtBack(){ qtEditing = null; qtRender(); }

// ---------- 儲存 ----------
function qtValidate(q){
  if(!q.toName) return t('qtErrNoTo');
  if(!q.issueDate) return t('qtErrNoIssue');
  if(!q.expiryDate) return t('qtErrNoExpiry');
  if(q.expiryDate < q.issueDate) return t('qtErrExpiryBefore');
  const used = q.lines.filter(l => (l.desc || '').trim());
  if(!used.length) return t('qtErrNoLines');
  return '';
}
async function qtSave(){
  qtSyncFields();
  const q = qtEditing, msg = document.getElementById('qtMsg');
  const err = qtValidate(q);
  if(err){ msg.className = 'msg error'; msg.textContent = err; return; }
  const rec = JSON.parse(JSON.stringify(q));
  rec.lines = rec.lines.filter(l => (l.desc || '').trim() || (l.price !== '' && l.price != null));
  const now = new Date().toISOString();
  await qtLoad();   // 先讀最新的:編號與別人剛存的報價單才不會衝突
  if(!rec.id){
    rec.id = 'qt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    rec.no = qtNo(qtData.next); qtData.next++;
    rec.createdAt = now; rec.createdBy = qtMyName();
    qtData.items.push(rec);
  } else {
    const idx = qtData.items.findIndex(x => x.id === rec.id);
    rec.createdAt = rec.createdAt || now;
    if(idx >= 0) qtData.items[idx] = Object.assign({}, qtData.items[idx], rec); else qtData.items.push(rec);
  }
  rec.updatedAt = now;
  qtData.defaultNote = rec.note || '';
  try{ await qtPersist(); }
  catch(e){ msg.className = 'msg error'; msg.textContent = t('qtSaveFail'); return; }
  qtEditing = JSON.parse(JSON.stringify(rec));
  qtRender();
  const m2 = document.getElementById('qtMsg'); if(m2){ m2.className = 'msg ok'; m2.textContent = tf('qtSaved', { no: rec.no }); }
}

// ---------- 報價單文件(給客戶看,英文) ----------
function qtCompany(){
  const c = (typeof invSettings !== 'undefined' && invSettings) ? invSettings : {};
  return { name: c.companyName || '', abn: c.abn || '', address: c.address || '', phone: c.phone || '', email: c.email || '', website: c.website || '', logo: c.logo || '' };
}
function qtDocHtml(q){
  const c = qtCompany();
  const td = 'padding:6px 8px;border:1px solid #000;';
  const lines = (q.lines || []).filter(l => (l.desc || '').trim() || (l.price !== '' && l.price != null));
  const showCtn = lines.some(l => String(l.perCtn || '').trim());
  const rows = lines.map(l => {
    const c = qtLineCalc(l);
    return `<tr>
      <td style="${td}text-align:center;">${qtEsc(l.minQty)}</td>
      <td style="${td}">${qtEsc(l.desc)}</td>
      <td style="${td}text-align:right;">${l.price !== '' && l.price != null ? qtMoney(l.price) : ''}</td>
      <td style="${td}text-align:right;">${c ? qtMoney(c.gst) : ''}</td>
      <td style="${td}text-align:right;font-weight:700;">${c ? qtMoney(c.total) : ''}</td>
      ${showCtn ? `<td style="${td}text-align:center;">${qtEsc(l.perCtn)}</td>` : ''}</tr>`;
  }).join('');
  const sum = qtTotals(lines);
  const tl = 'padding:5px 8px;text-align:right;';
  const lab = 'color:#444;white-space:nowrap;padding:3px 10px 3px 0;vertical-align:top;';
  return `<div class="qt-doc" style="width:794px;box-sizing:border-box;padding:40px 44px 32px;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.45;">
    <div style="display:flex;gap:16px;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:12px;">
      ${c.logo ? `<img src="${c.logo}" alt="" style="max-height:80px;max-width:150px;object-fit:contain;" />` : ''}
      <div>
        <div style="font-size:22px;font-weight:800;">${qtEsc(c.name)}</div>
        <div>${qtEsc(c.address).replace(/\n/g, '<br>')}</div>
        <div>${[c.phone ? 'Phone: ' + qtEsc(c.phone) : '', c.email ? 'E-mail: ' + qtEsc(c.email) : ''].filter(Boolean).join(' &nbsp;|&nbsp; ')}</div>
        ${c.abn ? `<div>ABN: ${qtEsc(c.abn)}</div>` : ''}
      </div>
    </div>
    <div style="text-align:center;margin:18px 0 14px;"><span style="display:inline-block;font-size:20px;font-weight:800;letter-spacing:1px;line-height:1.3;padding-bottom:2px;border-bottom:2px solid #000;">QUOTATION</span></div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:14px;"><tr>
      <td style="vertical-align:top;width:58%;"><table style="border-collapse:collapse;">
        <tr><td style="${lab}">To:</td><td style="font-weight:700;">${qtEsc(q.toName)}</td></tr>
        ${q.contactPerson ? `<tr><td style="${lab}">Contact Person:</td><td>${qtEsc(q.contactPerson)}</td></tr>` : ''}
        ${q.phone ? `<tr><td style="${lab}">Contact Number:</td><td>${qtEsc(q.phone)}</td></tr>` : ''}
        ${q.email ? `<tr><td style="${lab}">E-mail:</td><td>${qtEsc(q.email)}</td></tr>` : ''}
        ${q.address ? `<tr><td style="${lab}">Address:</td><td>${qtEsc(q.address)}</td></tr>` : ''}
      </table></td>
      <td style="vertical-align:top;"><table style="border-collapse:collapse;margin-left:auto;">
        <tr><td style="${lab}">Quote #:</td><td style="font-weight:700;">${qtEsc(q.no || '(draft)')}</td></tr>
        <tr><td style="${lab}">Issue Date:</td><td>${qtEsc(qtDmy(q.issueDate))}</td></tr>
        <tr><td style="${lab}">Valid Until:</td><td style="font-weight:700;">${qtEsc(qtDmy(q.expiryDate))}</td></tr>
        ${q.salesRep ? `<tr><td style="${lab}">Sales Rep:</td><td>${qtEsc(q.salesRep)}</td></tr>` : ''}
      </table></td></tr></table>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f0f0f0;">
        <th style="${td}width:50px;">Qty</th><th style="${td}">Product Description</th><th style="${td}width:80px;">Each</th><th style="${td}width:75px;">GST</th><th style="${td}width:90px;">Total</th>${showCtn ? `<th style="${td}width:65px;">Qty/CTN</th>` : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table style="margin:10px 0 0 auto;border-collapse:collapse;min-width:260px;">
      <tr><td style="${tl}">Subtotal</td><td style="${tl}">${qtMoney(sum.ex)}</td></tr>
      <tr><td style="${tl}">GST (10%)</td><td style="${tl}">${qtMoney(sum.gst)}</td></tr>
      <tr><td style="${tl}font-weight:800;font-size:14px;border-top:2px solid #000;">Total (inc. GST)</td><td style="${tl}font-weight:800;font-size:14px;border-top:2px solid #000;">${qtMoney(sum.total)}</td></tr>
    </table>
    ${(q.note || '').trim() ? `<div style="margin-top:16px;white-space:pre-wrap;">${qtEsc(q.note)}</div>` : ''}
    <div style="margin-top:30px;">BEST REGARDS</div>
    <div style="margin-top:34px;border-top:1px solid #000;width:260px;"></div>
  </div>`;
}
function qtFileName(q){ return `Quotation_${q.no || 'draft'}_${String(q.toName || '').replace(/[^\w]+/g, '_')}.pdf`; }
// 草稿(還沒儲存)也能預覽 / PDF / 列印;沒有編號時文件上顯示 (draft),所以正式要寄給客戶前請先儲存
function qtDraftSnapshot(){ qtSyncFields(); return JSON.parse(JSON.stringify(qtEditing)); }
function qtPreview(){
  const q = qtDraftSnapshot();
  const err = qtValidate(q), msg = document.getElementById('qtMsg');
  if(err){ msg.className = 'msg error'; msg.textContent = err; return; }
  msg.className = 'msg'; msg.textContent = '';
  const ov = document.getElementById('qtPreviewOverlay');
  document.getElementById('qtPreviewHost').innerHTML = qtDocHtml(q);
  ov.style.display = 'flex';
}
function qtClosePreview(){ document.getElementById('qtPreviewOverlay').style.display = 'none'; }
async function qtPdf(q){
  const msg = document.getElementById('qtMsg');
  if(typeof html2pdf === 'undefined'){ if(msg){ msg.className = 'msg error'; msg.textContent = t('invPdfLibMissing'); } else showInfoModal(t('invPdfLibMissing')); return; }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;';
  holder.innerHTML = qtDocHtml(q);
  document.body.appendChild(holder);
  try{
    await html2pdf().set({
      margin: 0, filename: qtFileName(q), image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr'] }
    }).from(holder.firstElementChild).save();
  }catch(e){ console.error('產生 PDF 失敗', e); showInfoModal(t('invPdfFailed')); }
  holder.remove();
}
function qtPdfDraft(){
  const q = qtDraftSnapshot(); const err = qtValidate(q);
  if(err){ const m = document.getElementById('qtMsg'); m.className = 'msg error'; m.textContent = err; return; }
  qtPdf(q);
}
function qtPdfById(id){ const q = qtData.items.find(x => x.id === id); if(q) qtPdf(q); }
function qtPrint(q){
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const dd = iframe.contentWindow.document;
  dd.open();
  dd.write(`<!doctype html><html><head><meta charset="utf-8"><title>Quotation ${qtEsc(q.no || '')}</title><style>@page{size:A4;margin:0;} body{margin:0;} .qt-doc{width:210mm !important;} tr{page-break-inside:avoid;}</style></head><body>${qtDocHtml(q)}</body></html>`);
  dd.close();
  setTimeout(() => { try{ iframe.contentWindow.focus(); iframe.contentWindow.print(); }catch(e){ console.error(e); } setTimeout(() => iframe.remove(), 2000); }, 300);
}
function qtPrintDraft(){
  const q = qtDraftSnapshot(); const err = qtValidate(q);
  if(err){ const m = document.getElementById('qtMsg'); m.className = 'msg error'; m.textContent = err; return; }
  qtPrint(q);
}
