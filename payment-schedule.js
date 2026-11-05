// ============================================================
// Payment & Collection Schedule(會計 → 付款與收款排程)
//   收款(Collection)= 未收完的 Invoice,到期日用 Invoice 的到期日(invRowInfo.due,Credit Note 已扣除);
//   付款(Payment)  = 未付完的進貨單 / 進貨相關支出(沿用該進貨單);到期日 = paDue(p):填了「付款到期日」用填的,
//                     否則 發票日期 + 進貨方 Payment terms;湊不齊就不做到期判定;獨立其他支出目前沒有到期日欄位,一律歸在「未設定到期日」。
//   「N 天內到期」包含已逾期的。畫面:摘要卡 + 月曆(每天顯示應付/應收合計)+ 單據清單。
//   不需要新 SQL。
// ============================================================
let schType = '';          // '' = 全部, 'pay', 'col'
let schDays = 30;          // 看幾天內到期
let schMonth = '';         // 月曆顯示月份 YYYY-MM
let schDay = '';           // 點選的日期(篩選清單)
let schItems = [];
let schCnAvail = { n: 0, amt: 0 };
let schErr = [];
const SCH_PAY_COLOR = '#c2410c', SCH_PAY_BG = '#ffedd5', SCH_COL_COLOR = '#15803d', SCH_COL_BG = '#dcfce7';

function schEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function schM(n){ return (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function schToday(){ return (typeof invToday === 'function') ? invToday() : new Date().toISOString().slice(0, 10); }
function schAdd(iso, d){ const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); }

async function schOpenPage(){
  const root = document.getElementById('paySchedRoot'); if(!root) return;
  if(!paOn()){ root.innerHTML = ''; return; }
  root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  await schLoad();
  schBuild();
  if(!schMonth) schMonth = schToday().slice(0, 7);
  schRender();
}
async function schLoad(){
  schErr = [];
  try{ await invLoadList(true); }catch(e){ schErr.push('Invoice'); }
  try{ if(typeof ensurePurchasesLoaded === 'function') await ensurePurchasesLoaded(); }catch(e){ schErr.push('Purchases'); }
  try{ await paLoadPayments(); if(paErr) schErr.push('Purchase payments'); }catch(e){ schErr.push('Purchase payments'); }
  try{ await oeLoad(); if(oeErr === 'error') schErr.push('Other expenses'); }catch(e){ schErr.push('Other expenses'); }
  schCnAvail = { n: 0, amt: 0 };
  try{
    let r = await sb.from('credit_notes').select('id,total,applied').is('invoice_id', null);
    if(r.error && r.error.code === '42703') r = await sb.from('credit_notes').select('id,total').is('invoice_id', null);
    if(!r.error) (r.data || []).forEach(c => { const av = (Number(c.total) || 0) - (Number(c.applied) || 0); if(av > 0.004){ schCnAvail.n++; schCnAvail.amt += av; } });
  }catch(e){}
}
function schBuild(){
  const items = [];
  (typeof invList !== 'undefined' ? invList : []).forEach(r => {
    const i = invRowInfo(r);
    if(i.balance <= 0.004) return;
    items.push({ dir: 'col', due: i.due || r.invoice_date, date: r.invoice_date, amt: i.balance, who: (r.customer || r.party_id || '').trim(), ref: 'INV' + (r.invoice_no || ''), est: false, open: `invOpenDetails('${schEsc(r.id)}')`, overdue: i.status === 'overdue' });
  });
  // 進貨單有填「付款到期日」才做到期判定;沒填的放在「未設定到期日」(不算進 N 天內,也不算逾期)。進貨相關支出沿用該進貨單的到期日。
  (purchases || []).filter(p => paCounted(p)).forEach(p => {
    const i = paInfo(p), dd = paDue(p), due = dd.date, est = dd.src === 'terms', dt = p.invoiceDate || p.date || '';
    if(i.balance > 0.004) items.push({ dir: 'pay', due, est, date: dt, amt: i.balance, who: p.partyName || '', ref: p.invoiceNo || '', open: `paOpenDetails('${schEsc(p.id)}')` });
    paExpList(p).forEach(x => {
      const ei = paExpInfo(p, x);
      if(ei.balance > 0.004) items.push({ dir: 'pay', due, est, date: dt, amt: ei.balance, who: x.e.payee || p.partyName || '', ref: x.e.name || '', open: `oeOpenDetails('rel','${schEsc(p.id)}','${schEsc(x.e.id || '')}','${schEsc(x.e.name || '')}')` });
    });
  });
  (oeRows || []).forEach(e => {
    const i = oeInfo(e);
    if(i.balance > 0.004) items.push({ dir: 'pay', due: '', date: e.exp_date || '', amt: i.balance, who: e.payee || '', ref: e.name || '', open: `oeOpenDetails('sa','${schEsc(e.id)}')` });
  });
  items.forEach(x => { x.overdue = !!x.due && x.due < schToday(); });
  items.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  schItems = items;
}
function schVisible(){ return schItems.filter(x => !schType || x.dir === schType); }
function schSet(k, v){
  if(k === 'type') schType = v;
  if(k === 'days') schDays = Math.max(0, Math.min(3650, parseInt(v, 10) || 0));
  schDay = '';
  schRender();
}
function schPickDay(d){ schDay = (schDay === d) ? '' : d; schRender(); }
function schShiftMonth(n){ const [y, m] = schMonth.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); schMonth = d.toISOString().slice(0, 7); schRender(); }
function schGoToday(){ schMonth = schToday().slice(0, 7); schDay = ''; schRender(); }

function schRender(){
  const root = document.getElementById('paySchedRoot'); if(!root) return;
  const E = schEsc, today = schToday(), limit = schAdd(today, schDays);
  const vis = schVisible();
  const dated = vis.filter(x => x.due), nodue = vis.filter(x => !x.due);
  const within = dated.filter(x => x.due <= limit);
  const sum = dir => within.filter(x => x.dir === dir).reduce((s, x) => s + x.amt, 0);
  const cnt = dir => within.filter(x => x.dir === dir).length;
  const pay = sum('pay'), col = sum('col'), overduePay = within.filter(x => x.dir === 'pay' && x.overdue).reduce((s, x) => s + x.amt, 0), overdueCol = within.filter(x => x.dir === 'col' && x.overdue).reduce((s, x) => s + x.amt, 0);
  const need = Math.max(0, pay - col);
  const card = (label, val, sub, color) => `<div style="flex:1 1 170px;min-width:150px;border:1px solid var(--line);border-left:4px solid ${color};border-radius:8px;padding:8px 10px;"><div style="font-size:11px;color:var(--ink-soft);">${label}</div><div style="font-size:18px;font-weight:700;">${val}</div>${sub ? `<div style="font-size:11px;color:var(--ink-soft);">${sub}</div>` : ''}</div>`;
  const errs = schErr.length ? `<div class="msg error" style="margin-bottom:8px;">⚠ ${E(tf('arpErrPartial', { names: schErr.join(', ') }))}</div>` : '';
  const dayOpts = [7, 14, 30, 60, 90].map(n => `<option value="${n}" ${schDays === n ? 'selected' : ''}>${E(tf('schWithinN', { n }))}</option>`).join('') + ([7, 14, 30, 60, 90].includes(schDays) ? '' : `<option value="${schDays}" selected>${E(tf('schWithinN', { n: schDays }))}</option>`);
  const typeOpts = [['', t('schAll')], ['pay', t('schPayment')], ['col', t('schCollection')]].map(o => `<option value="${o[0]}" ${schType === o[0] ? 'selected' : ''}>${E(o[1])}</option>`).join('');

  // ---- 月曆 ----
  const [cy, cm] = schMonth.split('-').map(Number);
  const first = new Date(Date.UTC(cy, cm - 1, 1)), startDow = (first.getUTCDay() + 6) % 7;   // 週一開頭
  const dim = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
  const byDay = {};
  dated.forEach(x => { const d = x.overdue ? today : x.due; (byDay[d] = byDay[d] || { pay: 0, col: 0, n: 0 }); byDay[d][x.dir] += x.amt; byDay[d].n++; });
  let cells = '';
  for(let i = 0; i < startDow; i++) cells += '<div></div>';
  for(let d = 1; d <= dim; d++){
    const iso = `${schMonth}-${String(d).padStart(2, '0')}`, b = byDay[iso];
    const inR = iso >= today && iso <= limit;
    cells += `<div onclick="schPickDay('${iso}')" style="cursor:pointer;min-height:64px;border:1px solid ${schDay === iso ? 'var(--ink)' : 'var(--line)'};border-radius:6px;padding:3px 4px;font-size:11px;background:${iso === today ? '#fffbe6' : (inR ? '#fff' : '#fafafa')};${inR ? '' : 'opacity:.75;'}">
      <div style="font-weight:${iso === today ? 700 : 500};color:var(--ink-soft);">${d}</div>
      ${b && b.pay ? `<div style="margin-top:2px;padding:1px 4px;border-radius:4px;background:${SCH_PAY_BG};color:${SCH_PAY_COLOR};font-weight:600;white-space:nowrap;">−${schM(b.pay)}</div>` : ''}
      ${b && b.col ? `<div style="margin-top:2px;padding:1px 4px;border-radius:4px;background:${SCH_COL_BG};color:${SCH_COL_COLOR};font-weight:600;white-space:nowrap;">+${schM(b.col)}</div>` : ''}
    </div>`;
  }
  const dows = ['一', '二', '三', '四', '五', '六', '日'].map(x => `<div style="text-align:center;font-size:11px;color:var(--ink-soft);">${x}</div>`).join('');
  const calendar = `<div style="display:flex;align-items:center;gap:8px;margin:14px 0 6px;">
      <button class="btn ghost" onclick="schShiftMonth(-1)">‹</button><b>${schMonth}</b><button class="btn ghost" onclick="schShiftMonth(1)">›</button>
      <button class="btn ghost" onclick="schGoToday()">${t('schToday')}</button>
      <span style="font-size:11.5px;color:var(--ink-soft);margin-left:6px;"><span style="background:${SCH_PAY_BG};color:${SCH_PAY_COLOR};padding:1px 6px;border-radius:4px;">− ${t('schPayment')}</span> <span style="background:${SCH_COL_BG};color:${SCH_COL_COLOR};padding:1px 6px;border-radius:4px;">+ ${t('schCollection')}</span></span>
    </div>
    <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">${t('schCalNote')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;max-width:900px;">${dows}${cells}</div>`;

  // ---- 清單 ----
  let listItems = schDay ? dated.filter(x => (x.overdue ? today : x.due) === schDay) : within;
  const rowsHtml = listItems.map(x => {
    const isPay = x.dir === 'pay', c = isPay ? SCH_PAY_COLOR : SCH_COL_COLOR, bg = isPay ? SCH_PAY_BG : SCH_COL_BG;
    const days = Math.round((new Date(x.due + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
    const dueTxt = x.overdue ? `<span style="color:#b42318;font-weight:700;">${E(tf('schOverdueDays', { n: -days }))}</span>` : (days === 0 ? E(t('schDueToday')) : E(tf('schInDays', { n: days })));
    return `<tr><td><span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;background:${bg};color:${c};">${E(isPay ? t('schPayment') : t('schCollection'))}</span></td>
      <td>${E(x.due)}${x.est ? ` <span title="${E(t('schEstTip'))}" style="color:var(--ink-soft);font-size:11px;">~</span>` : ''}<div style="font-size:11px;">${dueTxt}</div></td>
      <td>${E(x.who)}</td><td>${E(x.ref)}</td><td>${E(x.date)}</td>
      <td class="num" style="color:${c};font-weight:700;">${isPay ? '−' : '+'}${schM(x.amt)}</td>
      <td><span class="batch-info-icon" onclick="${x.open}" title="${E(t('invBtnDetails'))}">ⓘ</span></td></tr>`;
  }).join('');
  const table = `<div style="margin:16px 0 6px;font-size:14px;font-weight:700;">${E(schDay ? tf('schListDay', { d: schDay }) : tf('schListWithin', { n: schDays }))} (${listItems.length})</div>
    <div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('schColType')}</th><th>${t('schColDue')}</th><th>${t('schColParty')}</th><th>${t('schColRef')}</th><th>${t('schColDate')}</th><th class="num">${t('schColBalance')}</th><th></th></tr></thead>
    <tbody>${rowsHtml || `<tr><td colspan="7" style="color:var(--ink-soft);">${E(t('arpNoData'))}</td></tr>`}</tbody></table></div>`;

  const nodueRows = (schType === 'col' ? [] : nodue).map(x => `<tr><td>${E(x.who)}</td><td>${E(x.ref)}</td><td>${E(x.date)}</td><td class="num" style="color:${SCH_PAY_COLOR};font-weight:700;">−${schM(x.amt)}</td><td><span class="batch-info-icon" onclick="${x.open}" title="${E(t('invBtnDetails'))}">ⓘ</span></td></tr>`).join('');
  const nodueTable = nodueRows ? `<div style="margin:16px 0 6px;font-size:14px;font-weight:700;">${E(t('schNoDueTitle'))} (${nodue.length})</div><div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('schColParty')}</th><th>${t('schColRef')}</th><th>${t('schColDate')}</th><th class="num">${t('schColBalance')}</th><th></th></tr></thead><tbody>${nodueRows}</tbody></table></div>` : '';
  root.innerHTML = `${errs}
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('schColType')}</label><select onchange="schSet('type',this.value)">${typeOpts}</select></div>
      <div class="field"><label>${t('schDueWithin')}</label><select onchange="schSet('days',this.value)">${dayOpts}</select></div>
      <div class="field"><label>${t('schCustomDays')}</label><input type="number" min="0" max="3650" value="${schDays}" style="width:80px;" onchange="schSet('days',this.value)" /></div>
      <button class="btn ghost" onclick="schReload()" style="align-self:flex-end;">${t('arpBtnReload')}</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${schType === 'col' ? '' : card(tf('schCardPay', { n: schDays }), schM(pay), tf('schCardSub', { c: cnt('pay'), o: schM(overduePay) }), SCH_PAY_COLOR)}
      ${schType === 'pay' ? '' : card(tf('schCardCol', { n: schDays }), schM(col), tf('schCardSub', { c: cnt('col'), o: schM(overdueCol) }), SCH_COL_COLOR)}
      ${schType ? '' : card(t('schCardNet'), (col - pay >= 0 ? '+' : '−') + schM(Math.abs(col - pay)), t('schCardNetSub'), '#475569')}
      ${schType ? '' : card(t('schCardNeed'), schM(need), tf('schCardNeedSub', { p: schM(pay) }), '#b42318')}
    </div>
    <div style="font-size:11.5px;color:var(--ink-soft);margin:6px 0 0;">${E(t('schTermsNote'))}${nodue.length ? ' ' + E(tf('schNoDueNote', { n: nodue.length, a: schM(nodue.reduce((q, x) => q + x.amt, 0)) })) : ''}${schCnAvail.n ? ' ' + E(tf('schCnNote', { n: schCnAvail.n, a: schM(schCnAvail.amt) })) : ''}</div>
    ${calendar}${table}${nodueTable}`;
}
async function schReload(){ const root = document.getElementById('paySchedRoot'); if(root) root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`; await schLoad(); schBuild(); schRender(); }

function schApplyVisibility(){
  const sel = document.getElementById('accountingSubtabSelect'); if(!sel) return;
  const o = Array.from(sel.options).find(x => x.value === 'subtab-acc-schedule');
  if(o){ o.hidden = !paOn(); o.disabled = !paOn(); }
}
document.addEventListener('DOMContentLoaded', () => { try{ schApplyVisibility(); }catch(e){} });
