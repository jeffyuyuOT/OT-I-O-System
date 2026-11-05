// ============================================================
// 其他支出(會計 → 其他支出)
//   · 獨立的支出記錄(other_expenses 表,sql/other_expenses.sql):品項、金額、GST、對象(選填)
//   · 同一份清單也列出「進貨單裡跟進貨單相關的其他支出」(運費、疊櫃費…),Linked INV 點開看進貨單詳細資料
//   · 付款記錄沿用 purchase_payments:獨立支出 purchase_id = 'exp:<id>';進貨單相關支出 = '<進貨單id>#<支出id>'
// ============================================================
let oeRows = [];
let oeErr = '';
let oeFilter = { from: '', to: '', status: '', type: '', q: '' };
let oeEdit = null;   // 新增 / 編輯視窗狀態 { id }

function oeEsc(s){ return paEsc(s); }
async function oeLoad(){
  oeErr = '';
  try{
    const { data, error } = await sb.from('other_expenses').select('*').order('exp_date', { ascending: false }).limit(20000);
    if(error) throw error;
    oeRows = data || [];
  }catch(e){
    oeRows = [];
    oeErr = (e && (e.code === '42P01' || /other_expenses/.test(e.message || ''))) ? 'sql' : 'error';
    if(oeErr === 'error') console.error('讀取其他支出失敗', e);
  }
}
async function oeOpenPage(){
  const root = document.getElementById('otherExpensesRoot'); if(!root) return;
  if(!paOn()){ root.innerHTML = ''; return; }
  root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  try{ if(typeof ensurePurchasesLoaded === 'function') await ensurePurchasesLoaded(); }catch(e){}
  await Promise.all([oeLoad(), paLoadPayments()]);
  oeRender();
}
function oeFind(id){ return oeRows.find(r => r.id === id) || null; }
function oeInfo(e){
  const mode = e.gst_mode === 'inc' ? 'inc' : 'ex', a = Number(e.amount) || 0;
  const gstBase = e.gst === true ? a : 0;
  let gst, total, ex;
  if(mode === 'ex'){ gst = gstBase * PA_GST_RATE; ex = a; total = a + gst; }
  else { gst = gstBase * PA_GST_RATE / (1 + PA_GST_RATE); total = a; ex = a - gst; }
  const paid = paPaidOf('exp:' + e.id), balance = paR2(total - paid);
  const status = paid <= 0.004 ? 'unpaid' : (balance > 0.004 ? 'partial' : (balance < -0.004 ? 'overpaid' : 'paid'));
  return { paid, balance, status, ex: paR2(ex), gst: paR2(gst), total: paR2(total) };
}
// 獨立支出 + 進貨單相關支出 → 同一種列
function oeAllEntries(){
  const out = [];
  oeRows.forEach(e => { const i = oeInfo(e); out.push({ kind: 'sa', date: e.exp_date, name: e.name, payee: e.payee || '', e, info: i, sortKey: (e.exp_date || '') + '|' + (e.created_at || '') }); });
  (purchases || []).filter(p => paCounted(p)).forEach(p => paExpList(p).forEach(x => {
    out.push({ kind: 'rel', date: p.date || '', name: x.e.name || '', payee: x.e.payee || '', p, x, info: paExpInfo(p, x), sortKey: (p.date || '') + '|' + (p.createdAt || '') });
  }));
  out.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  return out;
}
function oeFiltered(){
  const f = oeFilter, q = (f.q || '').trim().toLowerCase();
  return oeAllEntries().filter(en =>
    (!f.from || en.date >= f.from) && (!f.to || en.date <= f.to)
    && (!f.type || (f.type === 'sa' ? en.kind === 'sa' : en.kind === 'rel'))
    && (!f.status || en.info.status === f.status)
    && (!q || [en.name, en.payee, en.kind === 'rel' ? (en.p.invoiceNo || '') + ' ' + (en.p.partyName || '') : (en.e.note || '')].join(' ').toLowerCase().includes(q)));
}
function oeRender(){
  const root = document.getElementById('otherExpensesRoot'); if(!root) return;
  if(oeErr === 'sql'){ root.innerHTML = `<div class="empty-note">${t('oeNeedSql')}</div>`; return; }
  if(oeErr){ root.innerHTML = `<div class="empty-note">${t('invLoadFailed')}</div>`; return; }
  const f = oeFilter;
  const list = oeFiltered();
  const sum = { t: 0, p: 0, b: 0 };
  const rows = list.map(en => {
    const i = en.info;
    sum.t += i.total; sum.p += i.paid; sum.b += i.balance;
    let linked = '', payBtn, extra = '', fx = '';
    if(en.kind === 'rel'){
      const p = en.p;
      linked = `<span class="del-link" onclick="paOpenDetails('${oeEsc(p.id)}')" title="${oeEsc(t('invBtnDetails'))}">${oeEsc(p.invoiceNo || t('oeNoInvNo'))}</span><div style="font-size:11px;color:var(--ink-soft);">${oeEsc(p.partyName || '')}</div>`;
      payBtn = `<span class="del-link" onclick="paOpenPayments('${oeEsc(p.id)}','${oeEsc(en.x.e.id || '')}','${oeEsc(en.x.e.name || '')}')">${t('paBtnPayments')}</span>`;
      fx = paExpFxIcon(p, en.x.e);
      extra = ` <span style="font-size:11px;color:var(--ink-soft);">(${oeEsc(t('pcExpBadge'))})</span>${en.x.e.estimated ? ' <span style="color:#b45309;font-size:11px;" title="' + oeEsc(t('paExpEstimatedWarn')) + '">⚠</span>' : ''}`;
    } else {
      linked = '<span style="color:var(--ink-soft);">–</span>';
      payBtn = `<span class="del-link" onclick="paOpenPayments(null,'','','${oeEsc(en.e.id)}')">${t('paBtnPayments')}</span> <span class="del-link" style="margin-left:6px;" onclick="oeOpenForm('${oeEsc(en.e.id)}')">${t('btnEdit')}</span> <span class="del-link" style="margin-left:6px;" onclick="oeDelete('${oeEsc(en.e.id)}')">${t('btnDelete')}</span>`;
      if(en.e.note) extra = ` <span title="${oeEsc(en.e.note)}" style="color:var(--ink-soft);cursor:help;">ⓘ</span>`;
    }
    return `<tr${en.kind === 'rel' ? ' style="background:var(--bg-soft,#f7f7f2);"' : ''}>
      <td style="white-space:nowrap;">${oeEsc(paDmy(en.date))}</td>
      <td>${oeEsc(en.name)}${extra}</td>
      <td>${en.payee ? oeEsc(en.payee) : '<span style="color:var(--ink-soft);">–</span>'}</td>
      <td>${linked}</td>
      <td class="num"><b>${paM2(i.total)}</b>${fx}</td>
      <td class="num">${paM2(i.paid)}</td><td class="num"><b>${paM2(i.balance)}</b></td>
      <td style="white-space:nowrap;">${paStatusBadge(i.status)}</td>
      <td style="white-space:nowrap;">${payBtn}</td>
    </tr>`;
  }).join('');
  const sel = (id, val, opts) => `<select id="${id}" onchange="oeOnFilter()">${opts.map(o => `<option value="${oeEsc(o[0])}" ${val === o[0] ? 'selected' : ''}>${oeEsc(o[1])}</option>`).join('')}</select>`;
  const card = (label, val) => `<div style="flex:1 1 130px;min-width:120px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${label}</div><div style="font-size:17px;font-weight:700;">${val}</div></div>`;
  root.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
      ${card(t('oeSumTotal') + ' (' + list.length + ')', paM2(sum.t))}
      ${card(t('paSumPaid'), paM2(sum.p))}
      ${card(t('paSumBalance'), paM2(sum.b))}
    </div>
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('lblFromDate')}</label><input type="date" id="oeFlt_from" value="${oeEsc(f.from)}" onchange="oeOnFilter()" /></div>
      <div class="field"><label>${t('lblToDate')}</label><input type="date" id="oeFlt_to" value="${oeEsc(f.to)}" onchange="oeOnFilter()" /></div>
      <div class="field"><label>${t('paFltType')}</label>${sel('oeFlt_type', f.type, [['', t('invFltAll')], ['sa', t('oeTypeStandalone')], ['rel', t('oeTypeRelated')]])}</div>
      <div class="field"><label>${t('invFltStatus')}</label>${sel('oeFlt_status', f.status, [['', t('invFltAll')], ['unpaid', t('invSt_unpaid')], ['partial', t('invSt_partial')], ['paid', t('invSt_paid')], ['overpaid', t('invSt_overpaid')]])}</div>
      <div class="field" style="min-width:220px;"><label>${t('invFltSearch')}</label><input type="search" id="oeFlt_q" value="${oeEsc(f.q)}" oninput="oeOnFilter(true)" placeholder="${oeEsc(t('oeSearchPh'))}" /></div>
      <button class="btn ghost" onclick="oeClearFilter()" style="align-self:flex-end;">${t('btnClearFilter')}</button>
    </div>
    ${list.length === 0 ? `<div class="empty-note">${t('oeEmpty')}</div>` : `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('colDate')}</th><th>${t('oeColItem')}</th><th>${t('oeColPayee')}</th><th>Linked INV</th><th class="num">${t('paColAmount')}</th><th class="num">${t('paColPaid')}</th><th class="num">${t('paColUnpaid')}</th><th>${t('invFltStatus')}</th><th></th></tr></thead>
      <tbody>${rows}<tr style="font-weight:700;border-top:2px solid var(--line, #ccc);"><td colspan="4" style="text-align:right;">${t('invListTotals')} (${list.length})</td><td class="num">${paM2(sum.t)}</td><td class="num">${paM2(sum.p)}</td><td class="num">${paM2(sum.b)}</td><td colspan="2"></td></tr></tbody>
    </table></div>`}`;
}
function oeOnFilter(keepFocus){
  oeFilter = {
    from: (document.getElementById('oeFlt_from') || {}).value || '', to: (document.getElementById('oeFlt_to') || {}).value || '',
    type: (document.getElementById('oeFlt_type') || {}).value || '', status: (document.getElementById('oeFlt_status') || {}).value || '',
    q: (document.getElementById('oeFlt_q') || {}).value || ''
  };
  const pos = keepFocus ? ((document.getElementById('oeFlt_q') || {}).selectionStart || 0) : 0;
  oeRender();
  if(keepFocus){ const el = document.getElementById('oeFlt_q'); if(el){ el.focus(); try{ el.setSelectionRange(pos, pos); }catch(e){} } }
}
function oeClearFilter(){ oeFilter = { from: '', to: '', status: '', type: '', q: '' }; oeRender(); }

// ---- 新增 / 編輯 ----
function oeNames(){
  const set = new Map();
  oeRows.forEach(r => { if(r.name) set.set(r.name.toLowerCase(), r.name); });
  (purchases || []).forEach(p => ((p.costs && p.costs.expenses) || []).forEach(e => { if(e.name) set.set(e.name.toLowerCase(), e.name); }));
  return Array.from(set.values());
}
function oePayees(){
  const set = new Map();
  oeRows.forEach(r => { if(r.payee) set.set(r.payee.toLowerCase(), r.payee); });
  (typeof pcPayeeNames === 'function' ? pcPayeeNames() : []).forEach(n => set.set(n.toLowerCase(), n));
  return Array.from(set.values());
}
// 選了用過的品項 → 帶入上次的對象 / GST / 輸入方式(只補空白欄位)
function oeFillFromName(){
  const nm = ((document.getElementById('oeFName') || {}).value || '').trim().toLowerCase(); if(!nm) return;
  const last = oeRows.find(r => (r.name || '').toLowerCase() === nm);
  let payee = last ? last.payee : '', gst = last ? last.gst : null, mode = last ? last.gst_mode : '';
  if(!last && typeof pcLastExpenseFor === 'function'){
    const h = pcLastExpenseFor('', nm); if(h && h.exp){ payee = h.exp.payee || ''; gst = (h.exp.gst === true || h.exp.gst === false) ? h.exp.gst : null; }
  }
  const pe = document.getElementById('oeFPayee'), ge = document.getElementById('oeFGst'), me = document.getElementById('oeFMode');
  if(pe && !pe.value && payee) pe.value = payee;
  if(ge && !ge.value && (gst === true || gst === false)) ge.value = gst ? 'y' : 'n';
  if(me && mode && me.dataset.touched !== '1') me.value = mode;
}
function oeOpenForm(id){
  const e = id ? oeFind(id) : null;
  oeEdit = { id: id || '' };
  paCloseOverlay('oeFormOverlay');
  const ov = document.createElement('div');
  ov.id = 'oeFormOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.onclick = ev => { if(ev.target === ov) oeCloseForm(); };
  const gv = e ? (e.gst === true ? 'y' : (e.gst === false ? 'n' : '')) : '';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(520px,96vw);max-height:92vh;overflow:auto;">
    <div class="section-title" style="margin-top:0;">${t(e ? 'oeFormEdit' : 'oeFormAdd')}</div>
    <datalist id="oeNameList">${oeNames().map(n => `<option value="${oeEsc(n)}"></option>`).join('')}</datalist>
    <datalist id="oePayeeList">${oePayees().map(n => `<option value="${oeEsc(n)}"></option>`).join('')}</datalist>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px;">
      <div class="field"><label>${t('colDate')}</label><input type="date" id="oeFDate" value="${oeEsc(e ? e.exp_date : paToday())}" /></div>
      <div class="field"><label>${t('oeColItem')}</label><input type="text" id="oeFName" list="oeNameList" value="${oeEsc(e ? e.name : '')}" onchange="oeFillFromName()" /></div>
      <div class="field"><label>${t('oeFldPayee')}</label><input type="text" id="oeFPayee" list="oePayeeList" value="${oeEsc(e ? (e.payee || '') : '')}" /></div>
      <div class="field"><label>${t('invPayAmount')}</label><input type="number" step="0.01" min="0" id="oeFAmount" value="${e ? oeEsc(e.amount) : ''}" placeholder="0.00" /></div>
      <div class="field"><label>GST</label><select id="oeFGst"><option value="" ${gv === '' ? 'selected' : ''}>${oeEsc(t('paGstUnset'))}</option><option value="y" ${gv === 'y' ? 'selected' : ''}>GST</option><option value="n" ${gv === 'n' ? 'selected' : ''}>${oeEsc(t('paGstNone'))}</option></select></div>
      <div class="field"><label>${t('paGstModeLabel')}</label><select id="oeFMode" onchange="this.dataset.touched='1'"><option value="ex" ${(!e || e.gst_mode !== 'inc') ? 'selected' : ''}>${oeEsc(t('paGstModeEx'))}</option><option value="inc" ${(e && e.gst_mode === 'inc') ? 'selected' : ''}>${oeEsc(t('paGstModeInc'))}</option></select></div>
      <div class="field" style="grid-column:1 / -1;"><label>${t('colNote')}</label><input type="text" id="oeFNote" value="${oeEsc(e ? (e.note || '') : '')}" /></div>
    </div>
    <div id="oeFMsg" class="msg"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="oeCloseForm()">${t('btnCancel')}</button>
      <button class="btn" onclick="oeSave()">${t('btnSave')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
function oeCloseForm(){ paCloseOverlay('oeFormOverlay'); oeEdit = null; }
async function oeSave(){
  if(!oeEdit) return;
  const g = id => ((document.getElementById(id) || {}).value || '');
  const msg = document.getElementById('oeFMsg');
  const fail = k => { msg.className = 'msg error'; msg.textContent = '⚠ ' + t(k); };
  const date = g('oeFDate'), name = g('oeFName').trim(), payee = g('oeFPayee').trim(), note = g('oeFNote').trim();
  const amt = parseFloat(g('oeFAmount')), gv = g('oeFGst'), mode = g('oeFMode') === 'inc' ? 'inc' : 'ex';
  if(!date){ fail('invPayBadDate'); return; }
  if(!name){ fail('oeErrName'); return; }
  if(!Number.isFinite(amt) || amt < 0){ fail('invPayBadAmount'); return; }
  if(gv !== 'y' && gv !== 'n'){ fail('oeErrGst'); return; }
  msg.className = 'msg'; msg.textContent = t('savingMsg');
  try{
    const { error } = await sb.rpc('other_expense_save', { p_id: oeEdit.id || null, p_date: date, p_name: name, p_payee: payee, p_amount: paR2(amt), p_gst: gv === 'y', p_gst_mode: mode, p_note: note });
    if(error) throw error;
    await oeLoad();
    oeCloseForm();
    oeRender();
  }catch(e){
    console.error('儲存其他支出失敗', e);
    msg.className = 'msg error'; msg.textContent = '⚠ ' + t((e && (e.code === 'PGRST202' || e.code === '42P01' || /other_expense/.test(e.message || ''))) ? 'oeNeedSql' : 'invSaveFailed');
  }
}
function oeDelete(id){
  const hasPay = paRows.some(r => r.purchase_id === 'exp:' + id);
  showConfirmModal(t(hasPay ? 'oeDeleteConfirmHasPay' : 'oeDeleteConfirm'), async () => {
    try{
      const { error } = await sb.rpc('other_expense_delete', { p_id: id });
      if(error) throw error;
      await Promise.all([oeLoad(), paLoadPayments()]);
      oeRender();
    }catch(e){ console.error(e); showInfoModal(t('invPaidFailed')); }
  });
}

// ---- 備份 / 還原 / 清除全部資料(跟 Invoice 備份一起) ----
async function oeBackupExport(){
  try{
    const { data, error } = await sb.from('other_expenses').select('*').limit(50000);
    if(error) return null;
    return data || [];
  }catch(e){ return null; }
}
async function oeBackupRestore(rows){
  if(!Array.isArray(rows)){ try{ await sb.rpc('other_expenses_clear_all'); }catch(e){} return; }
  const { error } = await sb.rpc('other_expenses_restore_all', { p_rows: rows });
  if(error) throw error;
}
async function oeBackupClear(){ try{ await sb.rpc('other_expenses_clear_all'); }catch(e){} }

function oeApplyVisibility(){
  const sel = document.getElementById('accountingSubtabSelect'); if(!sel) return;
  const o = Array.from(sel.options).find(x => x.value === 'subtab-acc-expenses');
  if(o){ o.hidden = !paOn(); o.disabled = !paOn(); }
}
document.addEventListener('DOMContentLoaded', () => { try{ oeApplyVisibility(); }catch(e){} });
