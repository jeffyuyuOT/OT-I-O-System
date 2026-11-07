// ============================================================
// Purchase List 附件打包(會計 → Purchase List)
//  · 依 Purchase List 目前的篩選結果,把進貨單附件(發票、收據)打包成 zip
//  · zip 裡:附件按月份分資料夾,檔名 = 日期_供應商_發票號碼_序號_原檔名;另有 index.csv 列出所有篩選到的進貨單(沒附件的也列)
//  · 附件本身存在 Supabase Storage(purchase-receipts),完整資料備份只含網址,所以報稅用的紀錄靠這個另外留一份
// ============================================================
Object.assign(I18N.zh, {
  evPackBtn: '📦 下載附件打包 zip', evHint: '完整資料備份只含附件的網址,不含檔案本身,報稅用的紀錄建議定期用這個下載保存。',
  evBusy: '打包中… {done}/{total}', evCancel: '取消', evCancelled: '已取消,沒有下載任何檔案。', evNone: '目前篩選結果沒有進貨單。', evNoFiles: '篩選結果的進貨單都沒有附件,只下載清單 index.csv。', evNoZip: '打包元件載入失敗,請重新整理頁面再試。', evDone: '完成:{files} 個附件、{n} 張進貨單。', evFailed: '{n} 個附件下載失敗(已列在 index.csv 的備註欄)。',
  accExportXlsx: '匯出清單 Excel'
});
Object.assign(I18N.en, {
  evPackBtn: '📦 Download attachments pack (zip)', evHint: 'The full data backup only keeps attachment links, not the files, so download this regularly for tax records.',
  evBusy: 'Packing… {done}/{total}', evCancel: 'Cancel', evCancelled: 'Cancelled. Nothing was downloaded.', evNone: 'No purchases in the current results.', evNoFiles: 'None of the purchases in the results have attachments; downloading index.csv only.', evNoZip: 'The zip component failed to load. Please refresh and try again.', evDone: 'Done: {files} attachment(s), {n} purchase(s).', evFailed: '{n} attachment(s) failed to download (noted in index.csv).',
  accExportXlsx: 'Export list (Excel)'
});
function evEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function evMsg(s, bad){ const m = document.getElementById('evMsg'); if(m){ m.style.color = bad ? 'var(--crit)' : 'var(--ink-soft)'; m.textContent = s || ''; } }
function evSafe(s){ return String(s == null ? '' : s).replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60); }
function evCsv(rows){ return '﻿' + rows.map(r => r.map(c => { const s = String(c == null ? '' : c); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n'); }
function evSaveBlob(blob, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
let evCancelled = false;
function evCancelRun(){ evCancelled = true; const c = document.getElementById('evCancelBtn'); if(c) c.disabled = true; }
async function evDownload(){
  const btn = document.getElementById('evBtn'); btn.disabled = true; evMsg('…');
  evCancelled = false; const cb = document.getElementById('evCancelBtn'); if(cb){ cb.disabled = false; cb.style.display = ''; }
  try{
    await ensurePurchasesLoaded();
    const list = paFiltered().filter(p => p.date).sort((a, b) => (a.date + (a.partyName || '')).localeCompare(b.date + (b.partyName || '')));
    if(!list.length){ evMsg(t('evNone'), true); return; }
    const tasks = [];
    list.forEach(p => getPurchaseReceiptFileList(p).forEach((f, i) => tasks.push({ p, f, i })));
    const idx = [['Purchase date', 'Supplier', 'Invoice no.', 'Attachment count', 'Files', 'Note']];
    const stem = `purchase-attachments_${(typeof invToday === 'function') ? invToday() : new Date().toISOString().slice(0, 10)}`;
    if(!tasks.length){
      list.forEach(p => idx.push([p.date, p.partyName || p.partyId || '', p.invoiceNo || '', 0, '', '']));
      evSaveBlob(new Blob([evCsv(idx)], { type: 'text/csv;charset=utf-8' }), stem + '_index.csv');
      evMsg(t('evNoFiles')); return;
    }
    if(typeof JSZip === 'undefined'){ evMsg(t('evNoZip'), true); return; }
    const zip = new JSZip(); let done = 0, failed = 0; const res = new Map();   // purchase id → { files:[], notes:[] }
    for(const { p, f, i } of tasks){
      if(evCancelled) break;
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
    if(evCancelled){ evMsg(t('evCancelled')); return; }
    list.forEach(p => { const r = res.get(p.id) || { files: [], notes: [] }; idx.push([p.date, p.partyName || p.partyId || '', p.invoiceNo || '', getPurchaseReceiptFileList(p).length, r.files.join(' | '), r.notes.join(' | ')]); });
    zip.file('index.csv', evCsv(idx));
    evMsg(tf('evBusy', { done: tasks.length, total: tasks.length }));
    const blob = await zip.generateAsync({ type: 'blob' });
    evSaveBlob(blob, stem + '.zip');
    evMsg(tf('evDone', { files: tasks.length - failed, n: list.length }) + (failed ? ' ' + tf('evFailed', { n: failed }) : ''), failed > 0);
  }catch(e){ console.error('附件打包失敗', e); evMsg(String(e && e.message || e), true); }
  finally{ btn.disabled = false; const c2 = document.getElementById('evCancelBtn'); if(c2) c2.style.display = 'none'; }
}
