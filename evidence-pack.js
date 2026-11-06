// ============================================================
// 附件打包下載(會計設定)
//  · 選財年(7 月~6 月)+ 期間(全年 / 季度 / 單月),把該期間進貨單的附件(發票、收據)打包成一個 zip
//  · zip 裡:附件按月份分資料夾,檔名 = 日期_供應商_發票號碼_序號_原檔名;另有 index.csv 列出該期間所有進貨單(沒附件的也列)
//  · 附件本身存在 Supabase Storage(purchase-receipts),完整資料備份只含網址,所以報稅用的紀錄靠這個另外留一份
// ============================================================
Object.assign(I18N.zh, {
  evTitle: '附件打包下載', evHint: '把某個期間進貨單的附件(發票、收據)打包成 zip 下載,另附一份進貨單清單 index.csv。完整資料備份只含附件的網址,不含檔案本身,報稅用的紀錄建議每季或每年下載保存。',
  evFy: '財年', evPeriod: '期間', evAllYear: '全年', evQ: '第 {n} 季', evMonth: '{m} 月', evDownload: '下載 zip', evBusy: '打包中… {done}/{total}',
  evNone: '這個期間沒有進貨單。', evNoFiles: '這個期間的進貨單都沒有附件,只下載清單 index.csv。', evNoZip: '打包元件載入失敗,請重新整理頁面再試。', evDone: '完成:{files} 個附件、{n} 張進貨單。', evFailed: '{n} 個附件下載失敗(已列在 index.csv 的備註欄)。'
});
Object.assign(I18N.en, {
  evTitle: 'Download attachments pack', evHint: 'Download a zip of the purchase attachments (invoices, receipts) for a period, plus an index.csv listing the purchases. The full data backup only keeps attachment links, not the files, so download this each quarter or year for tax records.',
  evFy: 'Financial year', evPeriod: 'Period', evAllYear: 'Full year', evQ: 'Quarter {n}', evMonth: '{m}', evDownload: 'Download zip', evBusy: 'Packing… {done}/{total}',
  evNone: 'No purchases in this period.', evNoFiles: 'None of the purchases in this period have attachments; downloading index.csv only.', evNoZip: 'The zip component failed to load. Please refresh and try again.', evDone: 'Done: {files} attachment(s), {n} purchase(s).', evFailed: '{n} attachment(s) failed to download (noted in index.csv).'
});
const EV_MONTHS_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function evEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function evFyStart(){ const d = new Date(); return d.getMonth() + 1 >= 7 ? d.getFullYear() : d.getFullYear() - 1; }
function evFyLabel(y){ return 'FY' + String(y).slice(2) + '-' + String(y + 1).slice(2); }
// 期間值:all / q1..q4 / m7..m12,m1..m6(月份數字)
function evRange(fy, per){
  const y = Number(fy);
  if(per === 'all') return { from: `${y}-07-01`, to: `${y + 1}-06-30` };
  const Q = { q1: [`${y}-07-01`, `${y}-09-30`], q2: [`${y}-10-01`, `${y}-12-31`], q3: [`${y + 1}-01-01`, `${y + 1}-03-31`], q4: [`${y + 1}-04-01`, `${y + 1}-06-30`] };
  if(Q[per]) return { from: Q[per][0], to: Q[per][1] };
  const m = Number(String(per).slice(1)); const yy = m >= 7 ? y : y + 1;
  const last = new Date(Date.UTC(yy, m, 0)).getUTCDate(); const mm = String(m).padStart(2, '0');
  return { from: `${yy}-${mm}-01`, to: `${yy}-${mm}-${String(last).padStart(2, '0')}` };
}
function evRender(){
  const box = document.getElementById('evoPackCard'); if(!box) return;
  const cur = evFyStart(); const fys = []; for(let y = cur; y >= 2024; y--) fys.push(y);
  const monthOrder = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
  const perOpts = [['all', t('evAllYear')], ['q1', tf('evQ', { n: 1 })], ['q2', tf('evQ', { n: 2 })], ['q3', tf('evQ', { n: 3 })], ['q4', tf('evQ', { n: 4 })]]
    .concat(monthOrder.map(m => ['m' + m, (lang === 'zh') ? tf('evMonth', { m }) : EV_MONTHS_EN[m - 1]]));
  const keepFy = (document.getElementById('evFySel') || {}).value, keepPer = (document.getElementById('evPerSel') || {}).value;
  box.innerHTML = `<div class="section-title">${t('evTitle')}</div>
    <p style="font-size:11.5px;color:var(--ink-soft);margin:0 0 8px;">${t('evHint')}</p>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <label style="font-size:12px;">${t('evFy')} <select id="evFySel">${fys.map(y => `<option value="${y}">${evFyLabel(y)}</option>`).join('')}</select></label>
      <label style="font-size:12px;">${t('evPeriod')} <select id="evPerSel">${perOpts.map(([v, l]) => `<option value="${v}">${evEsc(l)}</option>`).join('')}</select></label>
      <button class="btn ghost" id="evBtn" onclick="evDownload()">${t('evDownload')}</button>
      <span id="evMsg" style="font-size:12px;color:var(--ink-soft);"></span></div>`;
  if(keepFy) document.getElementById('evFySel').value = keepFy;
  if(keepPer) document.getElementById('evPerSel').value = keepPer;
}
function evMsg(s, bad){ const m = document.getElementById('evMsg'); if(m){ m.style.color = bad ? 'var(--crit)' : 'var(--ink-soft)'; m.textContent = s || ''; } }
function evSafe(s){ return String(s == null ? '' : s).replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60); }
function evCsv(rows){ return '﻿' + rows.map(r => r.map(c => { const s = String(c == null ? '' : c); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n'); }
function evSaveBlob(blob, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function evDownload(){
  const fy = document.getElementById('evFySel').value, per = document.getElementById('evPerSel').value;
  const rg = evRange(fy, per);
  const btn = document.getElementById('evBtn'); btn.disabled = true; evMsg('…');
  try{
    await ensurePurchasesLoaded();
    const list = purchases.filter(p => p.date && p.date >= rg.from && p.date <= rg.to).sort((a, b) => (a.date + (a.partyName || '')).localeCompare(b.date + (b.partyName || '')));
    if(!list.length){ evMsg(t('evNone'), true); return; }
    const tasks = [];
    list.forEach(p => getPurchaseReceiptFileList(p).forEach((f, i) => tasks.push({ p, f, i })));
    const idx = [['Purchase date', 'Supplier', 'Invoice no.', 'Purchase ID', 'Attachment count', 'Files', 'Note']];
    const stem = `purchase-attachments_${evFyLabel(Number(fy))}_${per}`;
    if(!tasks.length){
      list.forEach(p => idx.push([p.date, p.partyName || p.partyId || '', p.invoiceNo || '', p.id, 0, '', '']));
      evSaveBlob(new Blob([evCsv(idx)], { type: 'text/csv;charset=utf-8' }), stem + '_index.csv');
      evMsg(t('evNoFiles')); return;
    }
    if(typeof JSZip === 'undefined'){ evMsg(t('evNoZip'), true); return; }
    const zip = new JSZip(); let done = 0, failed = 0; const res = new Map();   // purchase id → { files:[], notes:[] }
    for(const { p, f, i } of tasks){
      const r = res.get(p.id) || { files: [], notes: [] }; res.set(p.id, r);
      evMsg(tf('evBusy', { done, total: tasks.length }));
      const base = evSafe(f.filename) || ('file-' + (i + 1));
      const name = `${p.date.slice(0, 7)}/${p.date}_${evSafe(p.partyName || p.partyId || '')}_${evSafe(p.invoiceNo || '')}_${i + 1}_${base}`;
      try{
        const resp = await fetch(f.url); if(!resp.ok) throw new Error('HTTP ' + resp.status);
        zip.file(name, await resp.blob()); r.files.push(name);
      }catch(e){ failed++; r.notes.push('FAILED: ' + base + ' (' + (e.message || e) + ')'); console.error('附件下載失敗', f.url, e); }
      done++;
    }
    list.forEach(p => { const r = res.get(p.id) || { files: [], notes: [] }; idx.push([p.date, p.partyName || p.partyId || '', p.invoiceNo || '', p.id, getPurchaseReceiptFileList(p).length, r.files.join(' | '), r.notes.join(' | ')]); });
    zip.file('index.csv', evCsv(idx));
    evMsg(tf('evBusy', { done: tasks.length, total: tasks.length }));
    const blob = await zip.generateAsync({ type: 'blob' });
    evSaveBlob(blob, stem + '.zip');
    evMsg(tf('evDone', { files: tasks.length - failed, n: list.length }) + (failed ? ' ' + tf('evFailed', { n: failed }) : ''), failed > 0);
  }catch(e){ console.error('附件打包失敗', e); evMsg(String(e && e.message || e), true); }
  finally{ btn.disabled = false; }
}
