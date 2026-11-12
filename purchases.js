// ============================================================
// 進貨單(歷史紀錄 → 進貨單)——清單顯示/篩選/展開明細、
// 匯出 Excel、寄 Email 給會計(含訂單寄 Email,兩者共用同一套
// 寄送視窗跟邏輯)、編輯進貨單。
// ============================================================

// 進貨單清單(歷史紀錄 → 進貨單):依日期新到舊排序,每一列顯示日期/進貨方/Invoice,
// 點一列展開/收合明細(品項清單 + 收據附件連結,沒附件就顯示「(沒有附件)」)。支援日期區間跟
// 進貨方下拉篩選(比照「進出貨紀錄」子分頁的篩選列)。匯出是針對「單一張進貨單」,不是整份清單
// (每張單通常對應同一張收據/同一個進貨方,合併匯出反而不好用)。
let expandedPurchaseId = null;
let purchaseLogEstOnly = false;   // 只看含「預估」其他支出、還沒補實際金額的進貨單
function togglePurchaseLogEstOnly(){ purchaseLogEstOnly = !purchaseLogEstOnly; renderPurchaseLog(); }
// 同一進貨方、同一個 Invoice No.(不分大小寫、去頭尾空白)已經存在的進貨單(excludeId = 編輯中的那張)
function findDuplicatePurchase(partyName, supplierId, invoiceNo, excludeId){
  const inv = (invoiceNo || '').trim().toLowerCase();
  if(!inv) return null;
  const nm = (partyName || '').trim().toLowerCase();
  return (purchases || []).find(p => p.id !== excludeId && (p.invoiceNo || '').trim().toLowerCase() === inv &&
    ((supplierId && p.supplierId === supplierId) || (nm && (p.partyName || '').trim().toLowerCase() === nm))) || null;
}
function togglePurchaseDetail(id){
  expandedPurchaseId = (expandedPurchaseId === id) ? null : id;
  renderPurchaseLog();
}
function clearPurchaseLogFilters(){
  document.getElementById('purchaseLogDateFrom').value = '';
  document.getElementById('purchaseLogDateTo').value = '';
  document.getElementById('purchaseLogPartyFilter').value = '';
  purchaseLogPartyKey = '';
  purchaseLogEstOnly = false;
  renderPurchaseLog();
}
// 「已寄過 email」小圖示旁邊顯示的簡短時間文字——一張單可能補寄過好幾次(每次寄送都會覆蓋
// emailedAt),這裡顯示的一律是「最後一次」寄送的時間,不會列出全部歷史。
function formatEmailedTimeShort(iso){
  if(!iso) return '';
  try{
    const d = new Date(iso);
    return d.toLocaleString(lang === 'en' ? 'en-AU' : 'zh-TW', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  } catch(e){ return ''; }
}

// 進貨單的「進貨方」篩選鍵 / 顯示文字(見 renderPurchaseLog)
function purchasePartyKey(p){
  if(p.supplierId && purchaseSuppliers.some(x => x.id === p.supplierId)) return 'id:' + p.supplierId;
  const name = (p.partyName || p.partyId || '').trim();
  if(!name) return 'name:';
  const same = purchaseSuppliers.filter(x => (x.name || '').trim().toLowerCase() === name.toLowerCase());
  return same.length === 1 ? 'id:' + same[0].id : 'name:' + name;
}
function purchasePartyLabel(p){
  const key = purchasePartyKey(p);
  if(key.startsWith('id:')){ const sup = purchaseSuppliers.find(x => 'id:' + x.id === key); if(sup) return supplierOptionLabel(sup); }
  return p.partyName || p.partyId || '';
}

const PURCHASE_LOG_PAGE_SIZE = 50;
let purchaseLogPage = 1, purchaseLogSig = '', purchaseLogPartyKey = '', purchaseLogGotoId = null;
function purchaseLogGoPage(n){
  purchaseLogPage = n;
  renderPurchaseLog();
  const el = document.getElementById('purchaseLogTable');
  if(el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
}
// 進貨方搜索欄:手動輸入就不再用「從進貨方管理跳過來」的精準 id 篩選
function onPurchaseLogPartyInput(){ purchaseLogPartyKey = ''; renderPurchaseLog(); }
function renderPurchaseLog(){
  const container = document.getElementById('purchaseLogTable');
  if(!container) return;
  if(!purchasesLoaded){ ensurePurchasesLoaded().then(renderPurchaseLog); return; }

  const dateFrom = document.getElementById('purchaseLogDateFrom').value;
  const dateTo = document.getElementById('purchaseLogDateTo').value;
  const partyText = (document.getElementById('purchaseLogPartyFilter').value || '').trim().toLowerCase();

  // 金額、成本、預估支出屬於會計資料:沒有「查看價錢」權限的人(例如倉庫管理員)只看得到品項與數量
  const priceOn = (typeof canViewPrice !== 'function') || canViewPrice();
  let filtered = purchases.slice();
  if(dateFrom) filtered = filtered.filter(p => (p.date || '') >= dateFrom);
  if(dateTo) filtered = filtered.filter(p => (p.date || '') <= dateTo);
  if(purchaseLogPartyKey) filtered = filtered.filter(p => purchasePartyKey(p) === purchaseLogPartyKey);
  else if(partyText) filtered = filtered.filter(p => (purchasePartyLabel(p) + ' ' + (p.partyName || '')).toLowerCase().includes(partyText));
  // 篩選條件一變就回到第 1 頁
  const sig = [dateFrom, dateTo, purchaseLogPartyKey, partyText, purchaseLogEstOnly].join('|');
  if(sig !== purchaseLogSig){ purchaseLogSig = sig; purchaseLogPage = 1; }
  // 含預估其他支出的進貨單(只算符合日期/進貨方篩選的),頂端提示並可一鍵只看這些
  const hasEst = p => (p.costs && (p.costs.expenses || []).some(e => e.estimated));
  const estCount = priceOn ? filtered.filter(hasEst).length : 0;
  if(priceOn && purchaseLogEstOnly) filtered = filtered.filter(hasEst);
  const estBanner = (priceOn && (estCount > 0 || purchaseLogEstOnly)) ? `<div style="background:var(--warn-bg,#fff7e6);border:1px solid var(--warn-dark,#b45309);border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12.5px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;"><span>⚠ ${escapeHtmlForPrint(tf('pcEstPendingBanner', { n: estCount }))}</span><button class="btn ghost" style="font-size:12px;" onclick="togglePurchaseLogEstOnly()">${t(purchaseLogEstOnly ? 'pcEstShowAll' : 'pcEstShowOnly')}</button></div>` : '';

  if(filtered.length === 0){
    container.innerHTML = estBanner + `<div class="empty-note">${t('noPurchasesYet')}</div>`;
    return;
  }
  const sorted = filtered.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  // 分頁:每頁 PURCHASE_LOG_PAGE_SIZE 筆;「查看進貨單」跳過來時,翻到那張單所在的頁
  const pageCount = Math.max(1, Math.ceil(sorted.length / PURCHASE_LOG_PAGE_SIZE));
  if(purchaseLogGotoId){ const gi = sorted.findIndex(p => p.id === purchaseLogGotoId); if(gi >= 0) purchaseLogPage = Math.floor(gi / PURCHASE_LOG_PAGE_SIZE) + 1; purchaseLogGotoId = null; }
  purchaseLogPage = Math.min(Math.max(1, purchaseLogPage), pageCount);
  const pageRows = sorted.slice((purchaseLogPage - 1) * PURCHASE_LOG_PAGE_SIZE, purchaseLogPage * PURCHASE_LOG_PAGE_SIZE);
  const pager = pageCount > 1 ? `<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin:10px 0;font-size:13px;">
      <button class="btn ghost" ${purchaseLogPage <= 1 ? 'disabled' : ''} onclick="purchaseLogGoPage(${purchaseLogPage - 1})">‹ ${t('plPrev')}</button>
      <span>${tf('plPageInfo', { p: purchaseLogPage, n: pageCount, total: sorted.length })}</span>
      <button class="btn ghost" ${purchaseLogPage >= pageCount ? 'disabled' : ''} onclick="purchaseLogGoPage(${purchaseLogPage + 1})">${t('plNext')} ›</button>
    </div>` : '';
  // 批次追蹤開啟時,批次號獨立一欄(不再塞在 Invoice 欄裡,沒有 Invoice No. 時才不會被誤認成 Invoice)
  const showBatchCol = typeof batchActive === 'function' && batchActive();
  container.innerHTML = estBanner + pager + `<table class="stock-table purchase-log-table">
      <thead><tr>
        <th>${t('colPurchaseDate')}</th>
        <th>${t('colPurchaseParty')}</th>
        <th>${t('colPurchaseInvoiceNo')}</th>
        ${showBatchCol ? `<th>${t('batchColBatch')}</th>` : ''}
        <th></th>
      </tr></thead>
      <tbody>
        ${pageRows.map(p => `
          <tr>
            <td class="pl-date" style="cursor:pointer;white-space:nowrap;" onclick="togglePurchaseDetail('${p.id}')"><span class="td-mobile-label">${t('colPurchaseDate')}</span><span style="display:inline-block;width:14px;">${expandedPurchaseId === p.id ? '▾' : '▸'}</span>${escapeHtmlForPrint(p.date || '')}</td>
            <td class="pl-party" style="cursor:pointer;" onclick="togglePurchaseDetail('${p.id}')"><span class="td-mobile-label">${t('colPurchaseParty')}</span>${escapeHtmlForPrint(purchasePartyLabel(p))}${(typeof pcOverseasTagHtml === 'function') ? pcOverseasTagHtml(p) : ''}${(priceOn && typeof pcEstimateBadge === 'function') ? pcEstimateBadge(p) : ''}</td>
            <td class="pl-invoice" style="cursor:pointer;" onclick="togglePurchaseDetail('${p.id}')"><span class="td-mobile-label">${t('colPurchaseInvoiceNo')}</span>${escapeHtmlForPrint(p.invoiceNo || '')}${getPurchaseReceiptFileList(p).length > 0 ? ` <span title="${t('hasReceiptAttachedTitle')}">📎</span>` : ''}</td>
            ${showBatchCol ? (() => { const bt = (typeof batchPurchaseTagHtml === 'function') ? batchPurchaseTagHtml(p).trim() : ''; return `<td class="pl-batch" style="cursor:pointer;" onclick="togglePurchaseDetail('${p.id}')">${bt ? `<span class="td-mobile-label">${t('batchColBatch')}</span>${bt}` : ''}</td>`; })() : ''}
            <td class="pl-actions" style="white-space:nowrap;">
              <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;">
                ${p.emailedAt ? `<span style="text-align:right;"><span style="color:var(--safe);font-size:12px;" title="${tf('emailedToTitle', { email: p.emailedTo || '', when: p.emailedAt })}">${t('alreadyEmailedBadge')}</span><span style="margin-left:4px;color:var(--ink-soft);font-size:10.5px;">${formatEmailedTimeShort(p.emailedAt)}</span></span>` : ''}
                <button class="btn ghost" onclick="openPurchaseActionModal('${p.id}')">${t('lblAction')} ▾</button>
              </div>
            </td>
          </tr>
          ${expandedPurchaseId === p.id ? `
          <tr>
            <td colspan="${showBatchCol ? 5 : 4}" style="background:#fff;">
              ${orderBlockHtml('items', 'orderBlockItems', `<table class="stock-table" style="margin:2px 0;background:transparent;">
                <thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th>${(priceOn && (p.items || []).some(it => it.amount)) ? `<th class="num">${(priceOn && typeof pcPurchaseTotals === 'function' && p.costs && pcPurchaseTotals(p).expenses > 0) ? t('colBasePrice') : t('colAmount')}</th>` : ''}${(priceOn && typeof pcPurchaseTotals === 'function' && p.costs && pcPurchaseTotals(p).expenses > 0) ? `<th class="num">${t('colTotalPrice')}</th>` : ''}</tr></thead>
                <tbody>
                  ${(p.items || []).map(it => {
                    const isCreditNote = it.docType === 'credit_note';
                    const displayQty = isCreditNote ? -it.qty : it.qty;
                    const badge = isCreditNote ? ` <span style="color:var(--crit);font-weight:600;font-size:11px;">(${t('docTypeCreditNoteBadge')})</span>` : '';
                    const amountCell = (priceOn && (p.items || []).some(x => x.amount))
                      ? `<td class="num">${it.amount ? Number(isCreditNote ? -it.amount : it.amount).toFixed(2) : '–'}${(it.amount && !isCreditNote && !(priceOn && typeof pcPurchaseTotals === 'function' && p.costs && pcPurchaseTotals(p).expenses > 0)) ? ` <span class="batch-info-icon" style="cursor:pointer;" title="${escapeHtmlForPrint(t('pcPdTitle'))}" onclick="pcShowItemPrice('${p.id}','item',${(p.items || []).indexOf(it)})">ⓘ</span>` : ''}</td>` : '';
                    const totalCell = (priceOn && typeof pcPurchaseTotals === 'function' && p.costs && pcPurchaseTotals(p).expenses > 0)
                      ? `<td class="num"><strong>${(typeof pcItemPrices === 'function' && pcItemPrices(it).total !== null) ? pcItemPrices(it).total.toFixed(2) : '–'}</strong>${((it.totalAmount !== undefined && it.totalAmount !== null || it.amount) && !isCreditNote) ? ` <span class="batch-info-icon" style="cursor:pointer;" title="${escapeHtmlForPrint(t('pcPdTitle'))}" onclick="pcShowItemPrice('${p.id}','item',${(p.items || []).indexOf(it)})">ⓘ</span>` : ''}</td>` : '';
                    const rq = it.rcv ? `${isCreditNote ? -it.rcv.qty : it.rcv.qty} ${escapeHtmlForPrint(it.rcv.unit || '')}` : `${displayQty} ${escapeHtmlForPrint(it.unit || '')}`;
                    const swNote = it.rcv ? `<div style="color:var(--ink-soft);font-size:11px;">${escapeHtmlForPrint(tf('purchaseConvertedNote', { name: it.name, qty: displayQty, unit: it.unit || '' }))}</div>` : '';
                    const shownName = (it.rcv && it.rcv.name) ? it.rcv.name : it.name;
                    return `<tr><td>${escapeHtmlForPrint(shownName)}${badge}${(typeof batchLineNoHtml === 'function') ? batchLineNoHtml(p.id, it.productId, it.expiry || '') : ''}${swNote}</td><td class="num">${rq}</td>${amountCell}${totalCell}</tr>`;
                  }).join('')}${(p.nonStockItems || []).map(n => `<tr style="background:var(--bg-soft,#f5f5f0);"><td>${escapeHtmlForPrint(n.name || '')} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcNonStockBadge')})</span></td><td class="num">${n.qty} ${escapeHtmlForPrint(n.unit || '')}</td>${(priceOn && (p.items || []).some(x => x.amount)) ? `<td class="num">${Number(n.amount || 0).toFixed(2)}${(Number(n.amount) && !(priceOn && typeof pcPurchaseTotals === 'function' && p.costs && pcPurchaseTotals(p).expenses > 0)) ? ` <span class="batch-info-icon" style="cursor:pointer;" title="${escapeHtmlForPrint(t('pcPdTitle'))}" onclick="pcShowItemPrice('${p.id}','ns',${(p.nonStockItems || []).indexOf(n)})">ⓘ</span>` : ''}</td>` : ''}${(priceOn && typeof pcPurchaseTotals === 'function' && p.costs && pcPurchaseTotals(p).expenses > 0) ? (n.totalAmount !== undefined && n.totalAmount !== null ? `<td class="num"><strong>${Number(n.totalAmount).toFixed(2)}</strong> <span class="batch-info-icon" style="cursor:pointer;" title="${escapeHtmlForPrint(t('pcPdTitle'))}" onclick="pcShowItemPrice('${p.id}','ns',${(p.nonStockItems || []).indexOf(n)})">ⓘ</span></td>` : '<td class="num">–</td>') : ''}</tr>`).join('')}${(p.lineExpenses || []).map(l => `<tr style="background:var(--bg-soft,#f5f5f0);"><td>${escapeHtmlForPrint(l.name || '')} <span style="color:var(--ink-soft);font-size:11px;">(${t('pcLineExpBadge')})</span></td><td class="num"></td>${(priceOn && (p.items || []).some(x => x.amount)) ? `<td class="num">${Number(l.amount || 0).toFixed(2)}</td>` : ''}${(priceOn && typeof pcPurchaseTotals === 'function' && p.costs && pcPurchaseTotals(p).expenses > 0) ? '<td class="num">–</td>' : ''}</tr>`).join('')}
                </tbody>
              </table>${(priceOn && p.costs && typeof pcPurchaseTotals === 'function') ? (() => { const tt = pcPurchaseTotals(p); return `<div style="font-size:12.5px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;"><span>${t('lblInvoiceSubtotal')}: <strong>${tt.base.toFixed(2)}</strong>${tt.expenses > 0 ? ` + ${t('lblOtherExpensesTotal')}: <strong>${tt.expenses.toFixed(2)}</strong> = ${t('lblPurchaseGrandTotal')}: <strong>${tt.total.toFixed(2)}</strong>` : ''} ${p.costs.baseCurrency || 'AUD'}${p.costs.overseas ? ` (${tf('pcInvoiceCurrencyShort', { cur: p.costs.currency })})` : ''}</span>${(typeof pcHasOriginalData === 'function' && pcHasOriginalData(p)) ? `<button class="btn ghost" style="font-size:12px;" onclick="pcOpenOriginalModal('${p.id}')">${t('pcViewOriginal')}</button>` : ''}</div>`; })() : ''}`)}
              ${p.note ? orderBlockHtml('remark', 'orderBlockRemark', `<p style="font-size:12.5px;color:var(--ink);margin:0;">${tf('purchaseNoteLabel', { note: escapeHtmlForPrint(p.note) })}</p>`) : ''}
              ${orderBlockHtml('party', 'orderBlockReceipt', getPurchaseReceiptFileList(p).length > 0
                ? getPurchaseReceiptFileList(p).map(f => `<a href="${f.url}" target="_blank" style="font-size:12.5px;display:block;">📎 ${escapeHtmlForPrint(f.filename || t('linkViewUploadedReceipt'))}</a>`).join('')
                : `<span style="font-size:12.5px;color:var(--ink-soft);">${t('purchaseNoReceiptLabel')}</span>`)}
            </td>
          </tr>
          ` : ''}
        `).join('')}
      </tbody>
    </table>` + pager;
}

// 匯出「單一張」進貨單:格式跟資料維護「匯出進貨」用的欄位不太一樣——一張進貨單通常對應同一天、
// 同一個進貨方、同一張收據,所以日期/進貨方/Invoice No. 都不重複印在每一列,而是整份檔案開頭
// 一個標題列,底下就是這張單的品項列(只有 SKU/Name/Qty/Unit)。
// 把一張進貨單組成 Excel workbook——直接下載(exportSinglePurchase)、跟寄 email 前先上傳
// 附件(uploadPurchaseExcelForEmail)兩邊共用同一份邏輯,不要各自重寫一次,不然兩邊格式跑掉
// 對不起來。
// 統一取得一張進貨單的收據附件清單:新的進貨單存的是 receiptFiles(陣列,支援多檔案);
// 舊資料(這個功能改成多檔案之前建立的進貨單)存的是單一的 receiptUrl/receiptFilename,這裡
// 一併轉成同樣的陣列格式,畫面顯示、寄 email 附件都共用這個函式,不用到處寫 if 判斷新舊格式。
function getPurchaseReceiptFileList(p){
  if(Array.isArray(p.receiptFiles) && p.receiptFiles.length > 0) return p.receiptFiles;
  if(p.receiptUrl) return [{ url: p.receiptUrl, filename: p.receiptFilename || '' }];
  return [];
}

function buildPurchaseWorkbook(p){
  // 不入公司帳的商品(商品主檔設定)不列入會計用的進貨單檔案;非入庫商品與收據上的其他支出另外成列
  const exportItems = (p.items || []).filter(it => !it.noAcct);
  const nsItems = p.nonStockItems || [], lineItems = p.lineExpenses || [];
  const productMap = Object.fromEntries(products.map(pp => [pp.id, pp]));
  const supplier = p.partyName || p.partyId || '';
  const hasAnyAmount = exportItems.some(it => it.amount) || nsItems.length > 0 || lineItems.length > 0 || ((p.costs && p.costs.expenses) || []).length > 0;
  const hasAnyDocType = exportItems.some(it => it.docType);

  const aoa = [];
  aoa.push([`Supplier: ${supplier}`, `Invoice No.: ${p.invoiceNo || ''}`]);
  aoa.push([`Date: ${p.date || ''}`]);
  const hasOrig = exportItems.some(it => it.origCurrency) || nsItems.some(n => n.origCurrency) || lineItems.some(l => l.origCurrency) || ((p.costs && p.costs.expenses) || []).some(e => e.currency && e.currency !== ((p.costs && p.costs.baseCurrency) || 'AUD'));
  const headerRow = ['SKU', 'Name', 'Qty', 'Unit'];
  // 第二期:Base Price = 發票商品本身的金額(AUD);Total Price = Base Price + 分攤到的其他支出。沒有其他支出時兩者相同。
  if(hasAnyAmount) headerRow.push('Base Price', 'Base Unit Price', 'Other Expenses (allocated)', 'Total Price', 'Total Unit Price');
  if(hasAnyAmount && hasOrig) headerRow.push('Invoice Amount (orig.)', 'Invoice Currency', `FX Rate (to ${(p.costs && p.costs.baseCurrency) || 'AUD'})`);
  if(hasAnyDocType) headerRow.push('Document');
  aoa.push(headerRow);
  exportItems.forEach(it => {
    const prod = productMap[it.productId];
    const isCreditNote = it.docType === 'credit_note';
    // Credit Note 這筆在匯出報表裡顯示成負數——存進資料裡的 qty/amount 本身是正數(對應收據上
    // 印的數字,資料庫規定不能存負的),這裡純粹是匯出報表這層的呈現方式,讓人一眼看出這筆是
    // 扣減方向,不用另外去看 Document 欄才知道。
    const displayQty = isCreditNote ? -it.qty : it.qty;
    const displayAmount = it.amount ? (isCreditNote ? -it.amount : it.amount) : it.amount;
    const row = [
      prod && prod.sku ? prod.sku : (it.sku || ''),
      prod ? prod.name : (it.name || '(deleted product)'),
      displayQty,
      prod ? prod.unit : (it.unit || '')
    ];
    if(hasAnyAmount){
      const pr = (typeof pcItemPrices === 'function') ? pcItemPrices(it) : { base: displayAmount, total: displayAmount };
      const r2 = x => Math.round(x * 100) / 100;
      row.push(pr.base !== null ? r2(pr.base) : '');
      row.push(pr.base !== null && displayQty ? r2(pr.base / displayQty) : '');
      row.push(pr.base !== null && pr.total !== null ? r2(pr.total - pr.base) : '');
      row.push(pr.total !== null ? r2(pr.total) : '');
      row.push(pr.total !== null && displayQty ? r2(pr.total / displayQty) : '');
      if(hasOrig){
        row.push(it.origAmount !== undefined ? (isCreditNote ? -it.origAmount : it.origAmount) : '');
        row.push(it.origCurrency || '');
        row.push(it.fxRate || '');
      }
    }
    if(hasAnyDocType){
      row.push(it.docType ? `${it.docType === 'credit_note' ? 'Credit Note' : 'Invoice'}${it.sourceFilename ? ' - ' + it.sourceFilename : ''}` : '');
    }
    aoa.push(row);
  });

  // 非入庫商品、收據上的其他支出:跟商品一樣成列(金額已含在發票金額裡),標示類別
  const r2x = x => Math.round(x * 100) / 100;
  const pushExtraRow = (name, qty, unit, amount, origAmount, origCur, fx) => {
    const row = ['', name, qty, unit];
    if(hasAnyAmount){
      row.push(r2x(amount), qty ? r2x(amount / qty) : '', 0, r2x(amount), qty ? r2x(amount / qty) : '');
      if(hasOrig){ row.push(origAmount !== undefined ? origAmount : '', origCur || '', fx || ''); }
    }
    if(hasAnyDocType) row.push('');
    aoa.push(row);
  };
  nsItems.forEach(n => pushExtraRow(`${n.name} (Non-stock)`, n.qty, n.unit || '', Number(n.amount) || 0, n.origAmount, n.origCurrency, n.fxRate));
  lineItems.forEach(l => pushExtraRow(`${l.name} (Other expense)`, '', '', Number(l.amount) || 0, l.origAmount, l.origCurrency, l.fxRate));
  // 跟此進貨單相關的其他支出(運費、報關等,通常付給其他廠商):同樣成列,標示 Related expense
  const relItems = (p.costs && p.costs.expenses) || [];
  const relBase = (p.costs && p.costs.baseCurrency) || 'AUD';
  relItems.forEach(e => pushExtraRow(`${e.name} (Related expense${e.payee ? " - " + e.payee : ""})`, '', '', Number(e.aud) || 0, e.currency !== relBase ? e.amount : undefined, e.currency !== relBase ? e.currency : '', e.currency !== relBase ? e.rate : ''));

  // 第二期:底價 / 其他支出 / 總價 合計(AUD),其他支出逐項列出(含原幣別與匯率)
  if(hasAnyAmount && typeof pcPurchaseTotals === 'function'){
    const tt = pcPurchaseTotals(p);
    aoa.push([]);
    aoa.push(['Invoice Items (Base Price)', '', '', '', tt.base]);
    if(tt.lineExpenses > 0) aoa.push(['Invoice Expenses (on receipt)', '', '', '', tt.lineExpenses]);
    if(p.costs && p.costs.expenses && p.costs.expenses.length){
      const basisName = { volume: 'Volume', weight: 'Weight', boxes: 'Boxes', amount: 'Amount' }[p.costs.basis] || p.costs.basis;
      aoa.push(['Allocated by', basisName]);
    }
    aoa.push(['Purchase Total (Total Price)', '', '', '', tt.total]);
    aoa.push([`Amounts in: ${(p.costs && p.costs.baseCurrency) || 'AUD'}`]);
    if(p.costs && p.costs.overseas) aoa.push([`Invoice currency: ${p.costs.currency}`]);
  }

  // 同一個商品(同一個 productId)在這張進貨單裡出現不只一筆的話——最常見的情境是原始發票
  // 一筆、後續因為缺貨另開的 Credit Note 退貨一筆——在原始逐筆明細下面另外加一段「Net Quantity
  // by Product」,把同一個商品的所有筆數(不管是發票還是 Credit Note)加總,顯示這個商品最終
  // 的淨數量/淨金額。上面的逐筆明細完全不受影響,原封不動保留每一筆的來源跟數字,這段純粹是
  // 額外附加的加總視圖,方便只想看最終結果的人一眼看到淨值,不用自己拿計算機把發票跟退貨的
  // 數字兜起來。
  const byProduct = {};
  exportItems.forEach(it => { (byProduct[it.productId] = byProduct[it.productId] || []).push(it); });
  const multiLineProductIds = Object.keys(byProduct).filter(pid => byProduct[pid].length > 1);
  if(multiLineProductIds.length > 0){
    aoa.push([]);
    aoa.push(['Net Quantity by Product']);
    aoa.push(hasAnyAmount ? ['SKU', 'Name', 'Net Qty', 'Unit', 'Net Amount'] : ['SKU', 'Name', 'Net Qty', 'Unit']);
    multiLineProductIds.forEach(pid => {
      const items = byProduct[pid];
      const prod = productMap[pid];
      // Credit Note 品項在這裡當負值扣掉——存進去的 qty/amount 本身都是正數(對應收據上印的
      // 數字,資料庫規定不能存負的),這裡純粹是匯出報表這層「淨值」算法用的正負號。
      const netQty = items.reduce((s, it) => s + (it.docType === 'credit_note' ? -it.qty : it.qty), 0);
      const netAmount = items.some(it => it.amount)
        ? items.reduce((s, it) => s + (it.docType === 'credit_note' ? -(it.amount || 0) : (it.amount || 0)), 0)
        : '';
      const row = [
        prod && prod.sku ? prod.sku : (items[0].sku || ''),
        prod ? prod.name : (items[0].name || '(deleted product)'),
        netQty,
        prod ? prod.unit : (items[0].unit || '')
      ];
      if(hasAnyAmount) row.push(netAmount);
      aoa.push(row);
    });
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headerRow.map((h, i) => ({ wch: i === 0 ? 12 : i === 1 ? 32 : i < 4 ? 10 : 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Purchase');

  const filename = `Opulent - Stock in ${p.date || todayISO()}.xlsx`;
  return { wb, filename };
}

// 把這張進貨單寄給指定的 email 地址:先把 Excel 檔案(跟直接下載用的是同一份邏輯)上傳到
// Storage,再呼叫後端的 Edge Function(send-purchase-email)去真正寄信——瀏覽器端的 JS 沒辦法
// 直接寄信(沒有地方能安全存放寄信服務的金鑰),所以這一步一定要透過後端,不是這裡能完成的。
// 在 Edge Function 真的部署、Resend 網域驗證通過之前,這裡呼叫一定會失敗,錯誤訊息會清楚地
// 告訴使用者「email 還沒設定好」,不會讓人誤以為信已經寄出去了。寄成功後,在這張進貨單上記錄
// emailedTo/emailedAt,歷史紀錄清單就會顯示「已寄過」的小圖示。
async function sendPurchaseEmail(purchaseId, toEmail, ccEmail, msgEl, note){
  const p = purchases.find(x => x.id === purchaseId);
  if(!p) throw new Error('找不到這張進貨單');
  // 支援逗號分隔的多個收件人地址,每一個都要各自驗證格式對不對,任何一個格式錯就整個擋下來,
  // 不會「前面幾個對、最後一個錯」也照樣送出去。副本(cc)是選填,有填的話一樣逐一驗證。
  const toEmails = (toEmail || '').split(',').map(e => e.trim()).filter(Boolean);
  if(toEmails.length === 0 || toEmails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error(t('errInvalidEmailAddress'));
  const ccEmails = (ccEmail || '').split(',').map(e => e.trim()).filter(Boolean);
  if(ccEmails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error(t('errInvalidEmailAddress'));

  if(msgEl){ msgEl.className = 'msg'; msgEl.textContent = t('sendingEmailMsg'); }

  const { wb, filename } = buildPurchaseWorkbook(p);
  const excelArrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const excelBlob = new Blob([excelArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const excelPath = `${purchaseId}/${genId()}.xlsx`;

  const { error: uploadError } = await sb.storage.from('purchase-exports').upload(excelPath, excelBlob, { upsert: true });
  if(uploadError) throw new Error(t('errExcelUploadFailed'));
  const { data: excelUrlData } = sb.storage.from('purchase-exports').getPublicUrl(excelPath);

  // 後端 Edge Function 還沒部署/Resend 網域還沒驗證通過的話,這裡會丟出錯誤,呼叫端要接住
  // 並顯示清楚的訊息,不要讓使用者以為信已經寄出去了。
  // excelFilename 明確帶正確的檔名過去(跟直接匯出下載時同一個名稱,例如「Opulent - Stock in
  // 2026-08-15.xlsx」),不要讓後端從 Storage 網址裡的隨機檔名去反推——Storage 裡存的檔名本身
  // 是 genId() 亂數(避免同一張單重複上傳時互相覆蓋或撞名),不是給使用者看的檔名。
  // receiptFiles 現在是陣列(支援多檔案附件),用 getPurchaseReceiptFileList() 統一處理
  // 新舊兩種資料格式。to/cc 傳陣列過去(後端 Edge Function 也已經改成接受陣列),支援同時寄給
  // 好幾個收件人、外加副本。
  const { error: fnError } = await sb.functions.invoke('send-purchase-email', {
    body: {
      purchaseId,
      to: toEmails,
      cc: ccEmails,
      excelUrl: excelUrlData.publicUrl,
      excelFilename: filename,
      receiptFiles: getPurchaseReceiptFileList(p),
      date: p.date || '',
      supplier: p.partyName || p.partyId || '',
      invoiceNo: p.invoiceNo || '',
      note: (note || '').trim() // 附註:後端會把它接在信件原本內容下面,顯示成「Note: ...」
    }
  });
  if(fnError) throw new Error(t('errEmailSendFailed'));

  p.emailedTo = toEmails.join(', ');
  p.emailedCc = ccEmails.join(', ');
  p.emailedAt = new Date().toISOString();
  await upsertPurchase(p);
}

// 已完成訂單的「寄 Email」:邏輯跟 sendPurchaseEmail 幾乎一樣,差別是這裡沒有收據附件、
// Excel 內容用的是訂單匯出那份格式(buildOrderSheetAoa),存放暫存 Excel 附件用的還是同一個
// purchase-exports bucket(單純是「寄信前暫存附件」用途,不是真的只限進貨單使用,不用另外
//開一個 bucket)。Edge Function 那邊 invoiceNo 這個欄位借來放訂單編號,信件內文標籤是通用的
// 「Reference No.」,不是寫死「Invoice No.」,兩種情境共用同一支函式不會顯示錯欄位名稱。
async function sendOrderEmail(orderId, toEmail, ccEmail, msgEl, note, exportMode){
  const order = orders.find(o => o.id === orderId);
  if(!order) throw new Error('找不到這張訂單');
  const toEmails = (toEmail || '').split(',').map(e => e.trim()).filter(Boolean);
  if(toEmails.length === 0 || toEmails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error(t('errInvalidEmailAddress'));
  const ccEmails = (ccEmail || '').split(',').map(e => e.trim()).filter(Boolean);
  if(ccEmails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error(t('errInvalidEmailAddress'));

  if(msgEl){ msgEl.className = 'msg'; msgEl.textContent = t('sendingEmailMsg'); }

  const partyLabel = order.partyName || 'Unspecified';
  const dateLabel = order.date;
  // 系統設置的 Sell price 顯示方式為「僅匯出」或「訂單跟匯出都顯示」時,已完成訂單的 Excel 附件多一欄 Sell price
  // (核對當下固定的售價);成本價(Price / Total price)不放進寄給客戶的附件。
  const sellMap = (typeof spExportEnabled === 'function' && spExportEnabled() && !isPreVerificationStatus(order)) ? spExportSellPriceMap([order]) : null;
  const { aoa, hiddenRows } = buildOrderSheetAoa([order], partyLabel, dateLabel, exportMode, null, sellMap);
  const wb = buildOrderSheetWorkbook(aoa, hiddenRows);
  const excelArrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const excelBlob = new Blob([excelArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  const safeParty = (order.partyName || 'Order').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '') || 'Order';
  const noPart = order.orderNo ? `${order.orderNo.replace('#','')}_` : '';
  const filename = `order_sheet_${noPart}${safeParty}_${order.date}.xlsx`;
  const excelPath = `${orderId}/${genId()}.xlsx`;

  const { error: uploadError } = await sb.storage.from('purchase-exports').upload(excelPath, excelBlob, { upsert: true });
  if(uploadError) throw new Error(t('errExcelUploadFailed'));
  const { data: excelUrlData } = sb.storage.from('purchase-exports').getPublicUrl(excelPath);

  const { error: fnError } = await sb.functions.invoke('send-purchase-email', {
    body: {
      purchaseId: orderId,
      to: toEmails,
      cc: ccEmails,
      excelUrl: excelUrlData.publicUrl,
      excelFilename: filename,
      receiptFiles: [],
      date: order.date || '',
      supplier: order.partyName || '',
      invoiceNo: order.orderNo || '',
      note: (note || '').trim()
    }
  });
  if(fnError) throw new Error(t('errEmailSendFailed'));

  order.emailedTo = toEmails.join(', ');
  order.emailedCc = ccEmails.join(', ');
  order.emailedAt = new Date().toISOString();
  await upsertOrders([order]);
}

// 歷史紀錄/已完成訂單的「寄 Email」:跳出同一個視窗讓使用者確認/修改收件人,預設帶入會計 Email
// (或者如果這張單/訂單之前已經寄過,帶入上次寄的那個地址,方便重寄給同一個人)。進貨單、
// 已完成訂單共用同一個彈出視窗,用 sendEmailTargetType 分辨現在是哪一種、要呼叫哪個寄送函式,
// 不用做兩份幾乎一樣的 modal HTML。
let sendPurchaseEmailTargetId = null;
let sendEmailTargetType = 'purchase'; // 'purchase' 或 'order'
function openSendPurchaseEmailModal(purchaseId){
  const p = purchases.find(x => x.id === purchaseId);
  if(!p) return;
  sendPurchaseEmailInFlight = false;
  const _btn1 = document.getElementById('btnConfirmSendPurchaseEmail');
  if(_btn1) _btn1.disabled = false;
  sendEmailTargetType = 'purchase';
  sendPurchaseEmailTargetId = purchaseId;
  const defaults = getAccountingEmailToAndCc();
  document.getElementById('sendPurchaseEmailInput').value = p.emailedTo || defaults.to || '';
  document.getElementById('sendPurchaseCcInput').value = p.emailedCc !== undefined ? p.emailedCc : (defaults.cc || '');
  document.getElementById('sendPurchaseEmailModalMsg').textContent = '';
  document.getElementById('sendPurchaseEmailNoteInput').value = '';
  document.getElementById('sendPurchaseEmailModalOverlay').style.display = 'flex';
}
let sendOrderEmailMode = 'general';
function openSendOrderEmailModal(orderId, exportMode){
  sendOrderEmailMode = exportMode === 'accountant' ? 'accountant' : 'general';
  const order = orders.find(o => o.id === orderId);
  if(!order) return;
  sendPurchaseEmailInFlight = false;
  const _btn2 = document.getElementById('btnConfirmSendPurchaseEmail');
  if(_btn2) _btn2.disabled = false;
  sendEmailTargetType = 'order';
  sendPurchaseEmailTargetId = orderId;
  const defaults = getAccountingEmailToAndCc();
  document.getElementById('sendPurchaseEmailInput').value = order.emailedTo || defaults.to || '';
  document.getElementById('sendPurchaseCcInput').value = order.emailedCc !== undefined ? order.emailedCc : (defaults.cc || '');
  document.getElementById('sendPurchaseEmailModalMsg').textContent = '';
  document.getElementById('sendPurchaseEmailNoteInput').value = '';
  document.getElementById('sendPurchaseEmailModalOverlay').style.display = 'flex';
}
function closeSendPurchaseEmailModal(){
  sendPurchaseEmailTargetId = null;
  document.getElementById('sendPurchaseEmailModalOverlay').style.display = 'none';
}
// 寄送進貨單/訂貨單 email 的按鈕本來沒有防止連點的保護,手指按快一點或網路慢的時候容易
// 一次觸發送出兩三封重複的 email。這裡用一個進行中旗標 + 停用按鈕雙重保護:按下就立刻鎖住,
// 不管成功或失敗最後都會解鎖(成功的話 modal 也會關閉,解鎖與否其實不影響使用者觀感,但還是
// 解開比較保險,避免 modal 被其他流程重新打開時按鈕還是鎖住的)。
let sendPurchaseEmailInFlight = false;
async function confirmSendPurchaseEmail(){
  if(!sendPurchaseEmailTargetId || sendPurchaseEmailInFlight) return;
  sendPurchaseEmailInFlight = true;
  const btn = document.getElementById('btnConfirmSendPurchaseEmail');
  if(btn) btn.disabled = true;
  const msgEl = document.getElementById('sendPurchaseEmailModalMsg');
  const email = (document.getElementById('sendPurchaseEmailInput').value || '').trim();
  const cc = (document.getElementById('sendPurchaseCcInput').value || '').trim();
  const note = (document.getElementById('sendPurchaseEmailNoteInput').value || '').trim();
  try{
    if(sendEmailTargetType === 'order'){
      await sendOrderEmail(sendPurchaseEmailTargetId, email, cc, msgEl, note, sendOrderEmailMode);
      renderOrders();
    } else {
      await sendPurchaseEmail(sendPurchaseEmailTargetId, email, cc, msgEl, note);
      renderPurchaseLog();
    }
    msgEl.className = 'msg ok';
    msgEl.textContent = t('emailSentMsg');
    setTimeout(closeSendPurchaseEmailModal, 900);
  } catch(e){
    console.error('寄送 email 失敗', e);
    msgEl.className = 'msg error';
    msgEl.textContent = `⚠ ${e.message || t('errEmailSendFailed')}`;
  } finally {
    sendPurchaseEmailInFlight = false;
    if(btn) btn.disabled = false;
  }
}

// 歷史紀錄裡編輯一張進貨單:主要是給補資料用的(當初建立進貨單時 Invoice Number 還沒拿到手、
// 收據還沒補齊,等資料齊全了再回頭補上)——只能改日期/進貨方/Invoice Number/收據附件這幾樣
// 單據層級的資訊。原本不開放編輯品項數量/金額,因為那是實際庫存數字的依據,改了會跟已經發生的
// 進出貨紀錄對不起來——後來加了品項編輯功能(見下面 editPurchaseWorkingItems 相關函式),改動
// 品項時會連動重新產生這張進貨單底下的庫存異動紀錄(transactions)、自動調整目前庫存,兩邊才會
// 一直保持一致,不會出現「進貨單寫的數字」跟「庫存異動紀錄/目前庫存」對不起來的情況。
let editPurchaseTargetId = null;
let editPurchasePreviewIdx = -1;
let editPurchaseWorkingReceiptFiles = []; // 編輯中的收據附件清單(工作副本),按「取消」不會影響到原本存的資料,只有按「儲存」才會真的寫回去
// 編輯中的品項清單(工作副本,深複製自 p.items),結構跟 p.items 一樣:
// { productId, sku, name, unit, qty, amount?, docType?, sourceFilename? }。
// 按「取消」不會動到原本存的資料,只有按「儲存」才會真的比對差異、重新產生 transactions。
let editPurchaseWorkingItems = [];
// 編輯進貨單的「進貨方」欄位:跟登記進出貨→進貨的供應商選擇邏輯一樣——下拉選單列出「進貨方管理」
// 裡現有的供應商(依名稱排序),選了「+ 新增供應商」才會跳出文字輸入框讓你打新名字。下拉選單
// 選了現有供應商,底下那個文字輸入框(實際存檔用的欄位)會同步改成那個名字、但保持隱藏;
// 存檔時(confirmEditPurchase)一律只讀文字輸入框的值,不用管當下是下拉選的還是手打的。
// currentName 是這張進貨單目前的進貨方名稱:如果剛好對得到清單裡的某個供應商,下拉選單直接選中
// 那筆;對不到的話(例如供應商後來被刪掉了,或本來就是手打的名字),視為「新增供應商」模式,
// 文字輸入框直接顯示、並帶入原本的名字,不會讓使用者看不到原本填的是什麼。
let editPurchaseSupplierId = '';   // 編輯進貨單:目前選的進貨方 id(手動輸入新名稱時是空字串)
function populateEditPurchasePartySelect(currentName, currentSupplierId){
  const sel = document.getElementById('editPurchasePartySelect');
  const input = document.getElementById('editPurchasePartyInput');
  if(!sel || !input) return;
  const sorted = purchaseSuppliers.slice().sort((a,b) => (a.name || '').localeCompare(b.name || '') || (a.code || '').localeCompare(b.code || ''));
  sel.innerHTML = `<option value="">${t('optSelectSupplier')}</option>` +
    sorted.map(s => `<option value="${s.id}">${escapeHtmlForPrint(supplierOptionLabel(s))}</option>`).join('') +
    `<option value="__new__">${t('optAddNewSupplier')}</option>`;
  // 先用進貨單上記的 id 找;舊進貨單沒有 id 時,名稱剛好只對應一個進貨方才用它
  let match = currentSupplierId ? sorted.find(x => x.id === currentSupplierId) : null;
  if(!match && currentName){
    const same = sorted.filter(x => x.name === currentName);
    if(same.length === 1) match = same[0];
  }
  if(match){
    sel.value = match.id; editPurchaseSupplierId = match.id;
    input.style.display = 'none';
    input.value = match.name;
  } else {
    sel.value = '__new__'; editPurchaseSupplierId = '';
    input.style.display = '';
    input.value = currentName || '';
  }
}function onEditPurchasePartySelectChange(value){
  const input = document.getElementById('editPurchasePartyInput');
  if(value === '__new__'){
    editPurchaseSupplierId = '';
    input.style.display = '';
    input.value = '';
    input.focus();
  } else {
    const sup = purchaseSuppliers.find(x => x.id === value);
    editPurchaseSupplierId = sup ? sup.id : '';
    input.style.display = 'none';
    input.value = sup ? sup.name : '';
  }
}function openEditPurchaseModal(purchaseId){
  const p = purchases.find(x => x.id === purchaseId);
  if(!p) return;
  editPurchaseTargetId = purchaseId;
  editPurchaseWorkingReceiptFiles = getPurchaseReceiptFileList(p).slice();
  editPurchasePreviewIdx = -1;
  editPurchaseWorkingItems = (p.items || []).map(it => ({...it}));
  if(typeof paEditLoad === 'function') paEditLoad(p);   // 進貨帳務:入會計紀錄 / GST
  document.getElementById('editPurchaseDateInput').value = p.date || '';
  { const _amt = document.getElementById('editPurchaseAddItemAmount'); if(_amt){ _amt.disabled = !canEditPrice(); if(!canEditPrice()) _amt.value = ''; } }
  populateEditPurchasePartySelect(p.partyName || p.partyId || '', p.supplierId || '');
  document.getElementById('editPurchaseInvoiceInput').value = p.invoiceNo || '';
  document.getElementById('editPurchaseNoteInput').value = p.note || '';
  document.getElementById('editPurchaseReceiptUploadMsg').textContent = '';
  document.getElementById('editPurchaseScanMsg').textContent = '';
  document.getElementById('editPurchaseScanUnmatchedWrap').innerHTML = '';
  document.getElementById('editPurchaseModalMsg').textContent = '';
  renderEditPurchaseReceiptList();
  populateEditPurchaseAddItemSelect();
  renderEditPurchaseItemsList();
  if(typeof pcEditInit === 'function') pcEditInit(p);
  {
    const pv = (typeof canViewPrice !== 'function') || canViewPrice();   // 倉管看不到價錢:金額、GST、入會計、成本/其他支出整區隱藏(儲存時原本的金額資料原樣保留)
    const hide = (id, on) => { const el = document.getElementById(id); if(el) el.style.display = on ? 'none' : ''; };
    if(!pv){ hide('editPurchaseAccWrap', true); hide('editPurchaseCostsWrap', true); }
    else hide('editPurchaseCostsWrap', false);
    hide('editPurchaseAddItemAmount', !pv);
  }
  document.getElementById('editPurchaseModalOverlay').style.display = 'flex';
}
function closeEditPurchaseModal(){
  editPurchaseTargetId = null;
  editPurchaseWorkingReceiptFiles = [];
  editPurchaseWorkingItems = [];
  if(typeof pcEditClose === 'function') pcEditClose();
  document.getElementById('editPurchaseModalOverlay').style.display = 'none';
}
function renderEditPurchaseReceiptList(){
  const wrap = document.getElementById('editPurchaseReceiptExistingWrap');
  if(!wrap) return;
  if(editPurchaseWorkingReceiptFiles.length === 0){
    wrap.innerHTML = `<span style="font-size:12px;color:var(--ink-soft);">${t('purchaseNoReceiptLabel')}</span>`;
    return;
  }
  // 附件類型(發票/Credit Note/其他)的選單邏輯,跟登記進出貨那邊的收據附件清單
  // (renderPurchaseReceiptPreviewList)完全一樣:預設一律當「發票」,不用檔名關鍵字去猜,
  // 猜錯的後果是掃描出來的金額/數量方向整個算反,寧可讓使用者自己選比較保險——這裡標記的
  // 類型會影響「🔍 用收據掃描帶入數量/金額」怎麼處理掃描結果(發票用來覆蓋/補上品項,
  // Credit Note 另外記一筆會在儲存時互相抵銷的品項,不會直接覆蓋掉)。
  const showDocTypeTag = hasFeature('receiptScanModule');
  wrap.innerHTML = editPurchaseWorkingReceiptFiles.map((f, i) => `
    <div style="display:flex;align-items:center;gap:10px;">
      <a href="${f.url}" target="_blank" download="${escapeHtmlForPrint(f.filename || '')}" style="font-size:12.5px;">📎 ${escapeHtmlForPrint(f.filename || '')}</a>
      ${showDocTypeTag ? `
        <select style="font-size:11.5px;padding:2px 4px;" onchange="setEditPurchaseReceiptFileDocType(${i}, this.value)">
          <option value="invoice" ${(f.docType || 'invoice') === 'invoice' ? 'selected' : ''}>${t('optDocTypeInvoice')}</option>
          <option value="credit_note" ${f.docType === 'credit_note' ? 'selected' : ''}>${t('optDocTypeCreditNote')}</option>
          <option value="others" ${f.docType === 'others' ? 'selected' : ''}>${t('optDocTypeOthers')}</option>
        </select>
      ` : ''}
      <span class="del-link" onclick="toggleEditPurchaseReceiptPreview(${i})">${t(editPurchasePreviewIdx === i ? 'epPreviewClose' : 'epPreview')}</span>
      <span class="del-link" onclick="removeEditPurchaseReceiptFile(${i})">${t('btnRemoveFile')}</span>
    </div>
  `).join('');
  renderEditPurchaseReceiptPreview();
}
function toggleEditPurchaseReceiptPreview(i){
  editPurchasePreviewIdx = (editPurchasePreviewIdx === i) ? -1 : i;
  renderEditPurchaseReceiptList();
}
function renderEditPurchaseReceiptPreview(){
  const box = document.getElementById('editPurchaseReceiptPreview'); if(!box) return;
  const f = editPurchaseWorkingReceiptFiles[editPurchasePreviewIdx];
  if(!f){ box.style.display = 'none'; box.innerHTML = ''; return; }
  const name = (f.filename || f.url || '').toLowerCase().split('?')[0];
  const u = escapeHtmlForPrint(f.url || '');
  let inner;
  if(/\.(png|jpe?g|gif|webp|bmp)$/.test(name)) inner = `<img src="${u}" style="max-width:100%;display:block;margin:0 auto;" />`;
  else if(/\.pdf$/.test(name)) inner = `<iframe src="${u}" style="width:100%;height:100%;border:0;"></iframe>`;
  else inner = `<div style="padding:12px;font-size:12.5px;color:var(--ink-soft);">${t('epNoPreview')}</div>`;
  box.style.display = 'block';
  box.innerHTML = `<div style="height:420px;min-height:160px;resize:vertical;overflow:auto;border:1px solid var(--line);border-radius:6px;background:#fff;">${inner}</div>`;
}
function setEditPurchaseReceiptFileDocType(index, docType){
  const f = editPurchaseWorkingReceiptFiles[index];
  if(f) f.docType = docType;
}
function removeEditPurchaseReceiptFile(index){
  editPurchaseWorkingReceiptFiles.splice(index, 1);
  renderEditPurchaseReceiptList();
}
async function handleEditPurchaseReceiptUpload(inputEl){
  const files = inputEl.files ? Array.from(inputEl.files) : [];
  if(files.length === 0) return;
  const msgEl = document.getElementById('editPurchaseReceiptUploadMsg');
  const maxBytes = 10 * 1024 * 1024;
  let successCount = 0, failCount = 0;
  for(const file of files){
    const excelMimeTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel' // .xls
    ];
    const validType = file.type.startsWith('image/') || file.type === 'application/pdf' || excelMimeTypes.includes(file.type);
    if(!validType || file.size > maxBytes){
      failCount++;
      continue;
    }
    msgEl.style.color = 'var(--ink-soft)';
    msgEl.textContent = tf('uploadingReceiptMsgWithName', { name: file.name });
    // 儲存路徑改成純英數(亂數 id + 副檔名),不直接放使用者的原始檔名(可能有中文/特殊符號)——
    // 理由跟 transactions.js 的 handlePurchaseReceiptUpload 一樣,原始檔名完整保留在 filename
    // 欄位,不受儲存路徑限制。
    const safeExt = (file.name.split('.').pop() || 'dat').toLowerCase().replace(/[^a-z0-9]/g, '') || 'dat';
    const path = `${genId()}.${safeExt}`;
    try{
      const { error } = await sb.storage.from('purchase-receipts').upload(path, file, { upsert: true });
      if(error) throw error;
      const { data } = sb.storage.from('purchase-receipts').getPublicUrl(path);
      editPurchaseWorkingReceiptFiles.push({ url: data.publicUrl, filename: file.name });
      successCount++;
    } catch(e){
      console.error('上傳收據失敗', e);
      failCount++;
    }
  }
  renderEditPurchaseReceiptList();
  if(failCount === 0){ msgEl.style.color = 'var(--safe)'; msgEl.textContent = t('receiptUploadedMsg'); }
  else if(successCount === 0){ msgEl.style.color = 'var(--crit)'; msgEl.textContent = t('errReceiptUploadFailed'); }
  else { msgEl.style.color = 'var(--warn)'; msgEl.textContent = tf('receiptUploadedPartialMsg', { success: successCount, fail: failCount }); }
  inputEl.value = '';
}
// 編輯品項清單——渲染目前的工作副本(editPurchaseWorkingItems),每一列可以直接改數量/金額、
// 或整列移除。輸入框用 oninput 直接寫回 editPurchaseWorkingItems,不需要另外按確認,跟其他
// 地方的品項清單編輯習慣一致(例如登記進出貨那邊的 txBatchItems 清單)。
function renderEditPurchaseItemsList(){
  const wrap = document.getElementById('editPurchaseItemsWrap');
  if(!wrap) return;
  if(editPurchaseWorkingItems.length === 0){
    wrap.innerHTML = `<div class="empty-note" style="padding:8px 0;">${lang === 'en' ? 'No items.' : '（沒有品項）'}</div>`;
    return;
  }
  // 一個商品一行(會計一次輸入大量價格時好看):品名 / 數量 / 單位 / 金額 / GST / 有效期 / 供應商批號 / 備註 / 移除。
  // 用 grid 讓標題與每列欄位對齊;視窗太窄時橫向捲動,不換行。
  const paOnNow = (typeof paOn === 'function' && paOn());
  const batchOn = editPurchaseIsBatchTracked();
  const priceVis = (typeof canViewPrice !== 'function') || canViewPrice();   // 沒有「查看價錢」權限(倉管)整個價格區都不顯示
  const cols = ['minmax(220px,1fr)', '84px', '54px'];
  if(priceVis) cols.push('110px');
  if(paOnNow && priceVis) cols.push('84px', '78px', '96px');   // 不含稅 / GST 金額 / GST 選項
  // 看得到價錢的人:有效期、供應商批號收進 📝 詳細資料視窗,空間留給金額與 GST;倉管維持直接在清單上輸入
  const expInDetail = batchOn && priceVis;
  if(batchOn) cols.push(...(expInDetail ? ['46px'] : ['138px', '120px', '46px']));
  cols.push('44px');
  const grid = `display:grid;grid-template-columns:${cols.join(' ')};gap:8px;align-items:center;min-width:${cols.reduce((s, c) => s + (parseInt((c.match(/\d+/) || [0])[0], 10) || 0), 0) + 8 * cols.length}px;`;
  const flags = editPurchasePriceFlags();
  const flagN = Object.keys(flags).length;
  const hdrCss = 'font-size:11px;color:var(--ink-soft);';
  const cur = escapeHtmlForPrint(typeof getSystemCurrency === 'function' ? getSystemCurrency() : 'AUD');
  const hdr = `<div style="${grid}${hdrCss}position:sticky;top:0;background:var(--bg,#fff);z-index:1;padding:2px 0;">
          <span></span><span>${t('colQty')}</span><span></span>${priceVis ? `<span>${t('colAmount')} (${cur})</span>` : ''}
          ${(paOnNow && priceVis) ? `<span style="text-align:right;">${t('paColEx')}</span><span style="text-align:right;">${t('paColGstAmt')}</span><span>GST</span>` : ''}
          ${batchOn ? (expInDetail ? '<span></span>' : `<span>${t('batchColExpiry')}</span><span>${t('batchLotLabel')}</span><span></span>`) : ''}
          <span></span>
        </div>`;
  wrap.innerHTML = `
    <div id="editPurchaseFlagBanner" style="display:${flagN ? 'block' : 'none'};font-size:12.5px;color:#9a6a00;background:#fff4dc;border-radius:6px;padding:5px 10px;margin-bottom:6px;">${flagN ? escapeHtmlForPrint(tf('epFlagSummary', { n: flagN })) : ''}</div>
    <div style="overflow-x:auto;">
     <div style="display:flex;flex-direction:column;gap:0;">
      ${hdr}
      ${editPurchaseWorkingItems.map((it, i) => `
        <div style="${grid}padding:5px 0;border-bottom:1px solid var(--line);${it._scanUpdated ? 'background:var(--warn-bg);' : ''}">
          <div style="min-width:0;font-size:12.5px;line-height:1.3;">
            ${escapeHtmlForPrint(it.name || '')}${it.sku ? ` <span style="color:var(--ink-soft);">(${escapeHtmlForPrint(it.sku)})</span>` : ''}
            ${it.docType === 'credit_note' ? ` <span style="color:var(--crit);font-weight:600;font-size:11px;">(${t('docTypeCreditNoteBadge')})</span>` : ''}
            ${it._scanUpdated ? `<span style="color:var(--warn-dark);font-size:11px;margin-left:4px;">🔍</span>` : ''}
            <span id="epFlagMk_${i}" style="display:${flags[i] ? 'inline' : 'none'};color:#d97706;cursor:help;" title="${flags[i] ? escapeHtmlForPrint(flags[i].msg) : ''}">⚠</span>
          </div>
          <input type="number" value="${it.qty}" min="0" step="any" style="width:100%;" oninput="updateEditPurchaseItemQty(${i}, this.value)" />
          <span style="font-size:11.5px;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtmlForPrint(it.unit || '')}</span>
          ${priceVis ? `          <input type="number" value="${it.amount !== undefined && it.amount !== null ? it.amount : ''}" min="0" step="any" placeholder="$" style="width:100%;${flags[i] ? 'background:#fff4dc;border-color:#d97706;' : ''}" ${canEditPrice() ? (flags[i] ? 'title="' + escapeHtmlForPrint(flags[i].msg) + '"' : '') : 'readonly title="' + t('priceReadOnlyTitle') + '"'} oninput="updateEditPurchaseItemAmount(${i}, this.value, this)" />
          ${(paOnNow && priceVis) ? (() => { const sp = paGstSplitStr(it, (document.getElementById('editPurchaseGstMode') || {}).value === 'inc' ? 'inc' : 'ex', paEditSkipRow(it)); return `<span id="epEx_${i}" style="text-align:right;font-size:12.5px;">${sp[0]}</span><span id="epGs_${i}" style="text-align:right;font-size:12.5px;">${sp[1]}</span>`; })() : ''}
          ${paOnNow ? (it.noAcct ? '<span style="font-size:11.5px;color:var(--ink-soft);">' + t('paOffBooksShort') + '</span>' : ((typeof pcEd !== 'undefined' && pcEd && pcEd.import) ? paImportNoteHtml() : paGstSelectHtml(it.gst, 'paEditSetGst(' + i + ', this.value)'))) : ''}` : ''}
          ${batchOn ? ((!it.noBatch) ? `
          ${expInDetail ? '' : `<input type="date" value="${it.expiry || ''}" title="${t('batchColExpiry')}" style="width:100%;" onchange="updateEditPurchaseItemExpiry(${i}, this.value)" />
          <input type="text" value="${escapeHtmlForPrint(it.supplierLot || '')}" title="${t('batchFieldLot')}" style="width:100%;" oninput="updateEditPurchaseItemLot(${i}, this.value)" />`}
          ${(it.docType === 'credit_note') ? '<span></span>' : `<button type="button" class="btn ghost" style="padding:2px 8px;" title="${t('batchFieldNote')}" onclick="editPurchaseOpenLineNote(${i})">📝${(it.batchNote !== undefined ? it.batchNote : batchLineNote(editPurchaseTargetId, it.productId, it.expiry || '')) ? ' ✓' : ''}</button>`}` : (expInDetail ? '<span></span>' : '<span></span><span></span><span></span>')) : ''}
          <span class="del-link" onclick="removeEditPurchaseItem(${i})">${t('btnRemoveItem')}</span>
        </div>
      `).join('')}
     </div>
    </div>
  `;
  if(typeof paReceiptGstHintUpdate === 'function') paReceiptGstHintUpdate();
}
function editPurchaseIsBatchTracked(){
  if(typeof batchActive !== 'function' || !batchActive()) return false;
  const p = purchases.find(x => x.id === editPurchaseTargetId);
  return !!(p && p.batchTracked);
}
function updateEditPurchaseItemExpiry(index, value){
  const it = editPurchaseWorkingItems[index];
  if(!it) return;
  if(value) it.expiry = value; else delete it.expiry;
  // 同商品、同有效期的品項合併成一列(有效期不同才分開列);合併後重畫清單
  if(editPurchaseMergeDuplicateAt(index)) renderEditPurchaseItemsList();
}
// 兩列是不是「同一批」:同商品、同單據類型(發票 / Credit Note)、同有效期
function editPurchaseSameLineKey(a, b){
  return a.productId === b.productId && (a.docType || '') === (b.docType || '') && (a.expiry || '') === (b.expiry || '');
}
// 把第 index 列併進它前面「同一批」的那一列(數量、金額相加;供應商批號沿用第一個有填的)。有合併回傳 true。
function editPurchaseMergeDuplicateAt(index){
  const it = editPurchaseWorkingItems[index];
  if(!it) return false;
  const target = editPurchaseWorkingItems.find((x, i) => i !== index && editPurchaseSameLineKey(x, it));
  if(!target) return false;
  target.qty = (target.qty || 0) + (it.qty || 0);
  if(it.amount !== undefined && it.amount !== null) target.amount = (target.amount || 0) + it.amount;
  if(!target.supplierLot && it.supplierLot) target.supplierLot = it.supplierLot;
  editPurchaseWorkingItems.splice(index, 1);
  return true;
}
// 商品行備註:點 📝 開小視窗編輯(存進批次,顯示在批次追蹤商品頁的詳細資料)
function editPurchaseOpenLineNote(index){
  const it = editPurchaseWorkingItems[index];
  if(!it) return;
  const cur = it.batchNote !== undefined ? it.batchNote : batchLineNote(editPurchaseTargetId, it.productId, it.expiry || '');
  const old = document.getElementById('editPurchaseLineNoteOverlay'); if(old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'editPurchaseLineNoteOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1250';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(420px,94vw);">
    <div class="section-title" style="margin-top:0;">${t('batchFieldNote')} · ${escapeHtmlForPrint(it.name || '')}</div>
    ${((typeof canViewPrice !== 'function') || canViewPrice()) ? `<div class="field"><label>${t('batchColExpiry')}</label><input id="editPurchaseLineExpiryInput" type="date" value="${escapeHtmlForPrint(it.expiry || '')}" style="width:100%;" /></div>
    <div class="field" style="margin-top:8px;"><label>${t('batchFieldLot')}</label><input id="editPurchaseLineLotInput" type="text" value="${escapeHtmlForPrint(it.supplierLot || '')}" style="width:100%;" /></div>
    <div style="font-size:12px;color:var(--ink-soft);margin:8px 0 2px;">${t('batchFieldNote')}</div>` : ''}
    <textarea id="editPurchaseLineNoteInput" rows="4" style="width:100%;box-sizing:border-box;">${escapeHtmlForPrint(cur)}</textarea>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('editPurchaseLineNoteOverlay').remove()">${t('btnCancel')}</button><button class="btn" onclick="editPurchaseSaveLineNote(${index})">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function editPurchaseSaveLineNote(index){
  const it = editPurchaseWorkingItems[index];
  const el = document.getElementById('editPurchaseLineNoteInput');
  if(it && el) it.batchNote = el.value.trim();
  const exEl = document.getElementById('editPurchaseLineExpiryInput'), lotEl = document.getElementById('editPurchaseLineLotInput');
  let merged = false;
  if(it && lotEl) updateEditPurchaseItemLotValue(it, lotEl.value);
  if(it && exEl){
    const nv = exEl.value || '';
    if(nv !== (it.expiry || '')){ if(nv) it.expiry = nv; else delete it.expiry; merged = editPurchaseMergeDuplicateAt(index); }
  }
  const ov = document.getElementById('editPurchaseLineNoteOverlay'); if(ov) ov.remove();
  renderEditPurchaseItemsList();
}
function updateEditPurchaseItemLotValue(it, value){
  const v = (value || '').trim();
  if(v) it.supplierLot = v; else delete it.supplierLot;
}
function updateEditPurchaseItemLot(index, value){
  const it = editPurchaseWorkingItems[index];
  if(!it) return;
  const v = (value || '').trim();
  if(v) it.supplierLot = v; else delete it.supplierLot;
}
function updateEditPurchaseItemQty(index, value){
  const it = editPurchaseWorkingItems[index];
  if(!it) return;
  const n = parseFloat(value);
  it.qty = Number.isFinite(n) ? n : 0;
  delete it.rcv;   // 數量被改過,收據原始單位/數量不再準確 → 退回顯示主商品單位
}
// 會計核價輔助:缺價(沒填或 0)、或單價和同商品上一次進貨差超過 20% 的行,標黃色請會計確認
function editPurchasePriceFlags(){
  const out = {};
  if(!canEditPrice()) return out;
  const cur = purchases.find(x => x.id === editPurchaseTargetId);
  const curDate = (cur && cur.date) || '';
  const lastMap = {};
  purchases.filter(x => x.id !== editPurchaseTargetId && (!curDate || (x.date || '') <= curDate))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''))
    .forEach(q => (q.items || []).forEach(it => {
      if(!it.productId || lastMap[it.productId] !== undefined || it.noAcct || (it.docType && it.docType !== 'invoice')) return;
      const a = Number(it.amount), n = Number(it.qty);
      if(a > 0 && n > 0) lastMap[it.productId] = a / n;
    }));
  editPurchaseWorkingItems.forEach((it, i) => { const f = editPurchaseFlagFor(it, lastMap); if(f) out[i] = f; });
  editPurchaseFlagLast = lastMap;
  return out;
}
let editPurchaseFlagLast = {};
function editPurchaseFlagFor(it, lastMap){
  if(it.noAcct || (it.docType && it.docType !== 'invoice')) return null;
  const a = Number(it.amount), n = Number(it.qty);
  if(!(a > 0)) return { kind: 'missing', msg: t('epFlagMissing') };
  const last = lastMap[it.productId];
  if(last && n > 0){
    const diff = (a / n - last) / last;
    if(Math.abs(diff) > 0.2) return { kind: 'diff', msg: tf('epFlagDiff', { pct: (diff > 0 ? '+' : '') + Math.round(diff * 100), last: last.toFixed(2) }) };
  }
  return null;
}
function editPurchaseRefreshFlagUI(i, el){
  const it = editPurchaseWorkingItems[i]; if(!it) return;
  const f = editPurchaseFlagFor(it, editPurchaseFlagLast);
  if(el){ el.style.background = f ? '#fff4dc' : ''; el.style.borderColor = f ? '#d97706' : ''; el.title = f ? f.msg : ''; }
  const mk = document.getElementById('epFlagMk_' + i);
  if(mk){ mk.style.display = f ? 'inline' : 'none'; mk.title = f ? f.msg : ''; }
  const all = {}; let n = 0;
  editPurchaseWorkingItems.forEach(x => { if(editPurchaseFlagFor(x, editPurchaseFlagLast)) n++; });
  const b = document.getElementById('editPurchaseFlagBanner');
  if(b){ b.style.display = n ? 'block' : 'none'; b.textContent = n ? tf('epFlagSummary', { n }) : ''; }
}
function updateEditPurchaseItemAmount(index, value, el){
  if(!canEditPrice()) return; // 沒有「編輯價錢」權限只能看不能改
  const it = editPurchaseWorkingItems[index];
  if(!it) return;
  if(value === ''){ delete it.amount; editPurchaseRefreshFlagUI(index, el); if(typeof paEditRefreshCells === 'function') paEditRefreshCells(index); return; }
  const n = parseFloat(value);
  it.amount = Number.isFinite(n) ? n : undefined;
  editPurchaseRefreshFlagUI(index, el);
  if(typeof paEditRefreshCells === 'function') paEditRefreshCells(index);
}
function removeEditPurchaseItem(index){
  editPurchaseWorkingItems.splice(index, 1);
  renderEditPurchaseItemsList();
}
// 新增品項的下拉選單:跟其他地方一樣,隱藏的商品不列出來(已經停用/不再進貨的商品不該
// 讓人選到去補登進貨紀錄)。
function populateEditPurchaseAddItemSelect(){
  const sel = document.getElementById('editPurchaseAddItemSelect');
  if(!sel) return;
  const sorted = products.filter(p => !p.hidden).slice().sort((a,b) => (a.name||'').localeCompare(b.name||''));
  sel.innerHTML = `<option value="">${t('optSelectProduct')}</option>` +
    sorted.map(p => `<option value="${p.id}">${escapeHtmlForPrint(p.name)}${p.sku ? ` (${escapeHtmlForPrint(p.sku)})` : ''}</option>`).join('');
  sel.value = '';
  // 商品很多:改成可搜尋(打字會跳出相似的商品名),跟登記進貨的商品欄一樣
  if(typeof makeSelectSearchable === 'function'){
    makeSelectSearchable('editPurchaseAddItemSelect');
    const w = sel.closest('.searchable-select-wrap');
    if(w){ w.style.flex = '1 1 200px'; w.style.minWidth = '160px'; w.style.width = 'auto'; }
  }
}
function addEditPurchaseItem(){
  const sel = document.getElementById('editPurchaseAddItemSelect');
  const qtyInput = document.getElementById('editPurchaseAddItemQty');
  const amountInput = document.getElementById('editPurchaseAddItemAmount');
  const msgEl = document.getElementById('editPurchaseModalMsg');
  const productId = sel.value;
  if(!productId){ msgEl.className = 'msg error'; msgEl.textContent = t('errSelectProductFirst'); return; }
  const qty = parseFloat(qtyInput.value);
  if(!Number.isFinite(qty) || qty <= 0){ msgEl.className = 'msg error'; msgEl.textContent = t('errEnterPositiveQty'); return; }
  const p = products.find(x => x.id === productId);
  if(!p) return;
  const amountVal = (!canEditPrice() || amountInput.value === '') ? undefined : parseFloat(amountInput.value);
  // 新增的品項,如果清單裡已經有「同商品、同單據類型、同樣沒有有效期」的一列,直接把數量/金額併進去,
  // 不要平白多出重複的兩列看起來像同一個商品被記兩筆帳。(新增當下還沒填有效期,之後在那一列填的有效期
  // 如果跟另一列相同,會在 updateEditPurchaseItemExpiry 自動合併;有效期不同才會分開列。)
  const existing = editPurchaseWorkingItems.find(it => it.productId === productId && !it.docType && !it.expiry);
  if(existing){
    existing.qty = (existing.qty || 0) + qty;
    if(amountVal !== undefined) existing.amount = (existing.amount || 0) + amountVal;
  } else {
    const item = { productId, sku: p.sku || '', name: p.name, unit: p.unit, qty };
    if(typeof batchProductTracked === 'function' && editPurchaseIsBatchTracked() && !batchProductTracked(productId)) item.noBatch = true;
    if(amountVal !== undefined) item.amount = amountVal;
    editPurchaseWorkingItems.push(item);
  }
  sel.value = ''; qtyInput.value = ''; amountInput.value = '';
  msgEl.textContent = '';
  renderEditPurchaseItemsList();
}

// 編輯進貨單時用收據掃描帶入數量/金額——跟登記進出貨那邊的完整逐行確認流程(scanReceiptForItems)
// 是分開的兩套邏輯,不共用 txBatchItems/pendingPurchaseReceiptFiles 這些全域狀態,避免使用者
// 同時在登記進出貨畫面累積到一半的品項清單,被這裡的掃描結果覆蓋掉。這裡刻意做得比較簡化:
// 每一行掃描結果先查「收據品項記憶對照表」(跟登記進出貨共用同一份記憶,同一個供應商之前掃過的
// 品項這裡也能直接命中),查不到的話用商品名稱做簡單比對(完全相同或互相包含,不分大小寫)
// 去對照這張進貨單「目前清單裡已經有的品項」——對到的話直接把數量/金額蓋掉(標記 🔍 讓使用者
// 注意到),完全比對不到的話不會自動幫忙新增一個猜測的商品,而是列在下面提示使用者自己用
// 「新增品項」手動處理,避免資料被錯誤地自動歸到不相關的商品上。不管有沒有自動比對到,都要
// 使用者自己按「儲存」才會真的存檔,這裡只負責先把資料準備好、方便使用者確認。
async function scanReceiptForEditPurchase(){
  const msgEl = document.getElementById('editPurchaseScanMsg');
  const unmatchedWrap = document.getElementById('editPurchaseScanUnmatchedWrap');
  unmatchedWrap.innerHTML = '';
  // 「其他」(Delivery Note 之類)不掃,道理跟登記進出貨那邊一樣——掃了也不是真的品項/金額。
  const scannableFiles = editPurchaseWorkingReceiptFiles.filter(f => f.docType !== 'others' && /\.(jpe?g|png|gif|bmp|webp|pdf|xlsx|xls)$/i.test(f.filename || f.url));
  if(scannableFiles.length === 0){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('editPurchaseScanNoFileMsg');
    return;
  }
  if(!RECEIPT_SCAN_SERVICE_URL || !RECEIPT_SCAN_SERVICE_API_KEY){
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = t('errReceiptScanNotConfigured');
    return;
  }
  const p = purchases.find(x => x.id === editPurchaseTargetId);
  const partyId = p ? (p.partyId || p.partyName) : null;
  msgEl.style.color = 'var(--ink-soft)';
  let isPdf = false;
  try{
    let allLines = [];
    for(let fileIdx = 0; fileIdx < scannableFiles.length; fileIdx++){
      const file = scannableFiles[fileIdx];
      const docType = file.docType || 'invoice';
      isPdf = /\.pdf$/i.test(file.filename || file.url);
      const isExcel = /\.(xlsx|xls)$/i.test(file.filename || file.url);
      msgEl.textContent = scannableFiles.length > 1
        ? tf('scanningFileMsg', { current: fileIdx + 1, total: scannableFiles.length, name: file.filename })
        : (isPdf ? t('convertingPdfMsg') : t('scanningReceiptMsg'));
      const ocrSources = isExcel ? [file.url] : (isPdf ? await renderAllPdfPagesAsImageDataUrls(file.url) : [file.url]);
      for(let i = 0; i < ocrSources.length; i++){
        const pdfBaseName = (file.filename || 'receipt').replace(/\.[^.]+$/, '');
        const pageFilename = isExcel
          ? file.filename
          : isPdf
            ? (ocrSources.length > 1 ? `${pdfBaseName}-page-${i + 1}.png` : `${pdfBaseName}.png`)
            : file.filename;
        const data = await callReceiptScanService(ocrSources[i], i, pageFilename);
        const pageLines = (data.lines || []).map(l => {
          if(!l.qty || l.qty <= 0) return null;
          const rawAmount = (l.amount && l.amount > 0) ? l.amount : null;
          return { description: l.name, qty: l.qty, amount: rawAmount, docType, sourceFilename: file.filename };
        }).filter(Boolean);
        allLines = allLines.concat(pageLines);
      }
    }
    if(allLines.length === 0){
      msgEl.style.color = 'var(--crit)';
      msgEl.textContent = t('errReceiptScanNoLines');
      return;
    }
    let matchedCount = 0;
    const unmatchedLines = [];
    allLines.forEach(line => {
      // 先查記憶對照表(跟登記進出貨共用),查不到再用名稱簡單比對這張進貨單目前的品項清單,
      // 兩種方式都只是為了找出這一行掃描結果對應到「哪個商品」,不代表要怎麼套用到品項清單裡
      // ——套用方式接下來依 docType 分成兩種,發票/Credit Note 意義不一樣,不能用同一種處理。
      const memory = findReceiptLineMapping(partyId, line.description);
      let productId = (memory && memory.type === 'product' && memory.product) ? memory.product.id : null;
      let matchedExistingItem = productId ? editPurchaseWorkingItems.find(it => it.productId === productId) : null;
      if(!matchedExistingItem){
        const normalizedDesc = (line.description || '').trim().toLowerCase();
        matchedExistingItem = editPurchaseWorkingItems.find(it => {
          const normalizedName = (it.name || '').trim().toLowerCase();
          return normalizedName && normalizedDesc && (normalizedName === normalizedDesc || normalizedName.includes(normalizedDesc) || normalizedDesc.includes(normalizedName));
        });
        if(matchedExistingItem) productId = matchedExistingItem.productId;
      }
      if(!productId){ unmatchedLines.push(line); return; }

      if(line.docType === 'credit_note'){
        // Credit Note:不覆蓋原本的品項,另外記一筆(跟登記進出貨的 addOcrLineToTxBatch 同一套
        // 規則——同一份文件裡同一個商品出現好幾次直接加總,但不會併進發票那一行),儲存時
        // buildPurchaseInTransactions 會自動把同一個商品的發票數量扣掉 Credit Note 數量、
        // 只記淨值,不需要在這裡自己算。
        const existingCreditLine = editPurchaseWorkingItems.find(it =>
          it.productId === productId && it.docType === 'credit_note' && it.sourceFilename === line.sourceFilename
        );
        if(existingCreditLine){
          existingCreditLine.qty += line.qty;
          if(line.amount !== null) existingCreditLine.amount = (existingCreditLine.amount || 0) + line.amount;
          existingCreditLine._scanUpdated = true;
        } else {
          const src = matchedExistingItem || products.find(x => x.id === productId);
          const newItem = { productId, sku: src.sku || '', name: src.name, unit: src.unit, qty: line.qty, docType: 'credit_note', sourceFilename: line.sourceFilename, _scanUpdated: true };
          if(line.amount !== null) newItem.amount = line.amount;
          editPurchaseWorkingItems.push(newItem);
        }
      } else {
        // 發票(或沒特別標記類型):用來修正/補上品項的正確數量,直接覆蓋掉比對到的那一列
        // (這是「進貨單先登記、收據後補到」的主要情境),完全比對不到才新增一列。
        if(matchedExistingItem){
          matchedExistingItem.qty = line.qty;
          if(line.amount !== null) matchedExistingItem.amount = line.amount;
          matchedExistingItem._scanUpdated = true;
        } else {
          const src = products.find(x => x.id === productId);
          const newItem = { productId, sku: src.sku || '', name: src.name, unit: src.unit, qty: line.qty, _scanUpdated: true };
          if(line.amount !== null) newItem.amount = line.amount;
          editPurchaseWorkingItems.push(newItem);
        }
      }
      matchedCount++;
    });
    renderEditPurchaseItemsList();
    if(unmatchedLines.length > 0){
      msgEl.style.color = 'var(--warn-dark)';
      msgEl.textContent = tf('editPurchaseScanFoundMsg', { n: allLines.length, matched: matchedCount, unmatched: unmatchedLines.length });
      unmatchedWrap.innerHTML = `<div>${t('editPurchaseScanUnmatchedTitle')}</div>` +
        unmatchedLines.map(l => `<div>・${escapeHtmlForPrint(l.description || '')} — ${t('colQty')}: ${l.qty}${l.amount !== null ? `, ${t('colAmount')}: ${l.amount}` : ''}${l.docType === 'credit_note' ? ` (${t('optDocTypeCreditNote')})` : ''}</div>`).join('');
    } else {
      msgEl.style.color = 'var(--safe)';
      msgEl.textContent = tf('editPurchaseScanAllMatchedMsg', { n: allLines.length });
    }
  } catch(e){
    console.error('編輯進貨單時收據掃描失敗', e);
    msgEl.style.color = 'var(--crit)';
    msgEl.textContent = isPdf ? t('errPdfConvertFailed') : t('errReceiptScanFailed');
  }
}

// 把一份品項清單(shape 跟 purchase.items 一樣)整理成要送進 transactions 表的庫存異動紀錄——
// 跟登記進出貨(submitTxBatchSimple)裡產生 transactions 的邏輯共用同一套規則:同一個商品如果
// 同時有 Credit Note 跟一般品項(發票),先互相抵銷、只記淨值那一筆,方向由淨值正負決定;
// 沒有 Credit Note 牽涉到的品項,直接照原數量各自登記。這裡不重做「批量商品自動切換主商品」
// 那段換算——items 陣列存進 purchase.items 的當下就已經是換算後的結果了(productId 已經是
// 主商品、qty 也已經是換算後的數量),不需要在這裡重複換算一次。
function buildPurchaseInTransactions(items, meta){
  const productGroups = {};
  items.forEach(it => { (productGroups[it.productId] = productGroups[it.productId] || []).push(it); });
  const buildSourceNote = (its) => {
    const uniqueDocs = [...new Set(its.filter(it => it.docType).map(it =>
      `${t(it.docType === 'credit_note' ? 'optDocTypeCreditNote' : 'optDocTypeInvoice')} ${it.sourceFilename || ''}`.trim()
    ))];
    return uniqueDocs.length > 0 ? tf('txSourceDocNoteMulti', { docs: uniqueDocs.join('、') }) : '';
  };
  const newTxs = [];
  Object.keys(productGroups).forEach(productId => {
    const group = productGroups[productId];
    const creditNoteItems = group.filter(it => it.docType === 'credit_note');
    const incomingItems = group.filter(it => it.docType !== 'credit_note');
    const pushTx = (type, qty, sourceItems) => {
      if(!qty) return;
      const sourceNote = buildSourceNote(sourceItems);
      const finalNote = sourceNote ? (meta.note ? `${meta.note}、${sourceNote}` : sourceNote) : meta.note;
      newTxs.push({ id: genId(), productId, type, qty, date: meta.date, party: meta.party, note: finalNote, invoiceNo: meta.invoiceNo, purchaseId: meta.purchaseId });
    };
    if(creditNoteItems.length > 0 && incomingItems.length > 0){
      const incomingQty = incomingItems.reduce((s, it) => s + it.qty, 0);
      const creditQty = creditNoteItems.reduce((s, it) => s + it.qty, 0);
      const netQty = incomingQty - creditQty;
      if(netQty > 0) pushTx('in', netQty, group);
      else if(netQty < 0) pushTx('out', Math.abs(netQty), group);
    } else if(creditNoteItems.length > 0){
      creditNoteItems.forEach(it => pushTx('out', it.qty, [it]));
    } else {
      incomingItems.forEach(it => pushTx('in', it.qty, [it]));
    }
  });
  return newTxs;
}

async function confirmEditPurchase(){
  if(!editPurchaseTargetId) return;
  const p = purchases.find(x => x.id === editPurchaseTargetId);
  const msgEl = document.getElementById('editPurchaseModalMsg');
  if(!p){ msgEl.className = 'msg error'; msgEl.textContent = '找不到這張進貨單,請重新整理頁面再試一次。'; return; }
  await ensureTransactionsLoadedFrom(p.date || ''); // 這張單產生的庫存異動可能比預設載入範圍更早

  const dateVal = document.getElementById('editPurchaseDateInput').value;
  const partyVal = document.getElementById('editPurchasePartyInput').value.trim();
  const invoiceVal = document.getElementById('editPurchaseInvoiceInput').value.trim();
  const noteVal = document.getElementById('editPurchaseNoteInput').value.trim();
  if(!dateVal){ msgEl.className = 'msg error'; msgEl.textContent = t('errSelectOrderDate'); return; }
  if(editPurchaseWorkingItems.some(it => !(it.qty > 0))){
    msgEl.className = 'msg error';
    msgEl.textContent = t('errEnterPositiveQty');
    return;
  }
  // 改了進貨方或 Invoice No. 之後和別張進貨單重複 → 先確認
  if(invoiceVal && (invoiceVal !== (p.invoiceNo || '') || partyVal !== (p.partyName || ''))){
    const dup = findDuplicatePurchase(partyVal, editPurchaseSupplierId || p.supplierId || '', invoiceVal, p.id);
    if(dup){
      const ok = await new Promise(res => showConfirmModal(tf('errDupInvoiceConfirm', { party: dup.partyName || '', inv: dup.invoiceNo || '', date: dup.date || '' }), () => res(true), () => res(false)));
      if(!ok) return;
    }
  }

  // 品項清單存檔前先去掉 _scanUpdated(只是編輯畫面上用來標記「這行剛被掃描結果蓋過」的暫時
  // UI 旗標,不是資料本身的一部分,不能真的存進 purchase.items 裡)。
  const cleanItems = editPurchaseWorkingItems.map(it => {
    const { _scanUpdated, batchNote, ...rest } = it;
    return rest;
  });
  if(typeof paEditCheck === 'function'){
    paAutoFillGst(cleanItems);
    const paErr = paEditCheck(cleanItems);
    if(paErr){ msgEl.className = 'msg error'; msgEl.textContent = '⚠ ' + paErr; return; }
  }
  // 比較品項有沒有真的改過:正規化成只留下影響庫存/金額的欄位、排序後再比較,不受「使用者
  // 只是把某一列刪掉又加回來、順序跟原本不一樣」這種操作影響——只要最終內容一樣,就不算改過,
  // 不需要白白重新產生一次 transactions。
  const normalizeForCompare = (items) => items.map(it => ({
    productId: it.productId,
    qty: Number(it.qty) || 0,
    amount: (it.amount !== undefined && it.amount !== null) ? Number(it.amount) : null,
    docType: it.docType || null,
    sourceFilename: it.sourceFilename || null,
    expiry: it.expiry || null,
    supplierLot: it.supplierLot || null
  })).sort((a,b) => `${a.productId}|${a.docType}|${a.sourceFilename}|${a.expiry}`.localeCompare(`${b.productId}|${b.docType}|${b.sourceFilename}|${b.expiry}`));
  let itemsChanged = JSON.stringify(normalizeForCompare(p.items || [])) !== JSON.stringify(normalizeForCompare(cleanItems));

  // 批次追蹤:數量不能低於這個批次已經出貨的量(最後以資料庫為準)
  if(p.batchTracked && typeof batchValidatePurchaseEdit === 'function'){
    try{ await ensureBatchDataLoaded(true); }catch(e){}
    const batchErr = batchValidatePurchaseEdit(p, cleanItems);
    if(batchErr){ msgEl.className = 'msg error'; msgEl.textContent = '⚠ ' + batchErr; return; }
  }

  // 第二期:有成本資料的進貨單,品項金額改了就用原本的其他支出/分攤依據重新算每行總價
  let costsChanged = false;
  if(typeof pcEditApply === 'function'){
    const costRes = pcEditApply(p, cleanItems);
    if(costRes.error){ msgEl.className = 'msg error'; msgEl.textContent = '⚠ ' + costRes.error; return; }
    costsChanged = !!costRes.changed;
    if(costRes.converted) itemsChanged = true;   // 轉成海外採購:金額換算成澳幣,連帶重建進貨庫存紀錄
  }

  msgEl.className = 'msg'; msgEl.textContent = t('savingMsg');
  const oldDate = p.date, oldParty = p.partyName, oldInvoice = p.invoiceNo, oldNote = p.note;
  const oldGstSig = JSON.stringify([p.gstMode === 'inc' ? 'inc' : 'ex', (p.items || []).map(i => i.gst === true)]);   // 含 GST 時批次成本要扣掉 GST:模式或品項 GST 變了要重存批次
  p.date = dateVal;
  p.partyName = partyVal;
  p.partyId = partyVal;
  if(editPurchaseSupplierId) p.supplierId = editPurchaseSupplierId; else delete p.supplierId;
  p.invoiceNo = invoiceVal;
  p.note = noteVal;
  p.items = cleanItems;
  if(typeof paEditApply === 'function') paEditApply(p);   // 入會計紀錄 / GST 模式
  const gstCostChanged = (JSON.stringify([p.gstMode === 'inc' ? 'inc' : 'ex', (p.items || []).map(i => i.gst === true)]) !== oldGstSig) && (p.gstMode === 'inc' || oldGstSig.indexOf('"inc"') >= 0);
  p.receiptFiles = editPurchaseWorkingReceiptFiles.slice();
  delete p.receiptUrl; // 舊格式欄位一旦編輯過就統一改用新的 receiptFiles 陣列,不留舊欄位造成混淆
  delete p.receiptFilename;
  try{
    await upsertPurchase(p);

    if(itemsChanged){
      // 品項(數量/金額/新增/移除)有改過的話,不能只改文字欄位——連帶把當初這張進貨單建立時
      // 一起產生的庫存異動紀錄(transactions,用 purchaseId 連回這張單)整批刪掉重建:先刪除舊的
      // (deleteTransactions 會自動把當初加的庫存扣回去),再依照新的品項清單重新產生一批
      // (insertTransactions 會自動把新的數量加回庫存去)——這樣目前庫存才會正確反映「差額」,
      // 不用自己手動去算加減多少。重建後的 transactions 一律採用這次存檔當下最新的
      // 日期/進貨方/Invoice Number/備註,不需要再另外跑下面「只同步文字欄位」那段。
      const oldTxs = transactions.filter(tx => tx.purchaseId === p.id);
      await deleteTransactions(oldTxs);
      oldTxs.forEach(tx => { const i = transactions.indexOf(tx); if(i >= 0) transactions.splice(i, 1); });
      const newTxs = buildPurchaseInTransactions(cleanItems, { date: dateVal, party: partyVal, invoiceNo: invoiceVal, note: noteVal, purchaseId: p.id });
      await insertTransactions(newTxs);
      transactions.push(...newTxs);
    } else if(dateVal !== oldDate || partyVal !== oldParty || invoiceVal !== oldInvoice || noteVal !== (oldNote || '')){
      // 品項沒有改,但日期/進貨方/Invoice Number/備註改了的話,連動更新當初送出這張進貨單時
      // 一起建立的那幾筆庫存異動紀錄——那些紀錄自己也各自存了一份 party/invoiceNo/date/note,
      // 不是即時參照進貨單,不連動更新的話,「歷史紀錄→進出貨紀錄」看到的會是編輯前的舊資料,
      // 跟進貨單本身顯示的對不起來。庫存數量/商品完全不受影響,只同步這四個純文字欄位。
      const linkedTxs = transactions.filter(t => t.purchaseId === p.id);
      for(const tx of linkedTxs){
        tx.date = dateVal;
        tx.party = partyVal;
        tx.note = noteVal;
        if(invoiceVal) tx.invoiceNo = invoiceVal; else delete tx.invoiceNo;
        try{
          const { error } = await sb.from('transactions').update({ date: dateVal, party: partyVal || null, note: noteVal || null, invoice_no: invoiceVal || null }).eq('id', tx.id);
          if(error) throw error;
        } catch(e){ console.error('同步更新進出貨紀錄失敗', e); }
      }
    }
    // 批次追蹤:同步批次(數量/有效期/批號/日期/Invoice/供應商有改才呼叫)
    if(p.batchTracked && typeof batchSavePurchase === 'function' && (itemsChanged || costsChanged || gstCostChanged || dateVal !== oldDate || partyVal !== oldParty || invoiceVal !== oldInvoice)){
      const locBefore = (typeof batchSnapshotPurchaseLocs === 'function') ? batchSnapshotPurchaseLocs(p.id) : null;
      try{
        await batchSavePurchase(p);
        // 位置:數量改少或整行移除後,批次記的位置數量跟著減回去,庫存分布同步扣掉
        if(locBefore && typeof batchSyncPurchaseLocAfterEdit === 'function') await batchSyncPurchaseLocAfterEdit(p.id, locBefore);
      }
      catch(be){
        console.error('同步批次失敗', be);
        const inUse = (typeof batchParseInUseError === 'function') ? batchParseInUseError(be) : null;
        showInfoModal(inUse ? tf('batchEditBelowUsed', { name: batchProductName(inUse.product_id), batch: '', used: inUse.min_qty }) : t('batchCreateFailed'));
      }
    }
    // 每行的批次備註(只在有填/改過時才寫入;不動位置)
    if(p.batchTracked && typeof batchSaveLineNotes === 'function'){
      const noteRows = {};
      editPurchaseWorkingItems.forEach(it => {
        if(it.batchNote === undefined || it.docType === 'credit_note') return;
        const key = it.productId + '|' + (it.expiry || '');
        const prev = noteRows[key];
        noteRows[key] = { product_id: it.productId, expiry: it.expiry || '', note: prev && prev.note ? prev.note + '\n' + it.batchNote.trim() : it.batchNote.trim() };
      });
      await batchSaveLineNotes(p.id, Object.values(noteRows));
    }
    renderPurchaseLog();
    if(itemsChanged) renderAll(); // 庫存數字真的變了,連動刷新庫存總覽等其他畫面
    closeEditPurchaseModal();
  } catch(e){
    console.error('儲存進貨單失敗', e);
    msgEl.className = 'msg error';
    msgEl.textContent = '⚠ 儲存失敗,請重新整理頁面再試一次。';
  }
}

// 進貨單紀錄的 Action:編輯 / 匯出這張進貨單 / 寄 Email(跟訂單的 Action 同一種小視窗)
function openPurchaseActionModal(purchaseId){
  const p = purchases.find(x => x.id === purchaseId);
  if(!p) return;
  const old = document.getElementById('purchaseActionOverlay'); if(old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'purchaseActionOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex';
  ov.onclick = e => { if(e.target === ov) ov.remove(); };
  const exportLabel = t('btnExportPurchaseLog').replace(/^📤\s*/, '');
  ov.innerHTML = `<div class="modal-box" style="max-width:340px;">
    <div class="section-title" style="margin-bottom:12px;">${escapeHtmlForPrint(p.date || '')}${p.invoiceNo ? ' · ' + escapeHtmlForPrint(p.invoiceNo) : ''}</div>
    <div class="field">
      <label>${t('lblAction')}</label>
      <select id="purchaseActionSelect">
        <option value="edit">${t('btnEdit')}</option>
        <option value="export">${escapeHtmlForPrint(exportLabel)}</option>
        ${typeof acctEmailOn === 'function' && !acctEmailOn() ? '' : `<option value="email">${t('btnSendEmail')}</option>`}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('purchaseActionOverlay').remove()">${t('btnCancel')}</button>
      <button class="btn" onclick="confirmPurchaseActionModal('${purchaseId}')">${t('btnRunAction')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
function confirmPurchaseActionModal(purchaseId){
  const sel = document.getElementById('purchaseActionSelect');
  const action = sel ? sel.value : '';
  const ov = document.getElementById('purchaseActionOverlay'); if(ov) ov.remove();
  if(action === 'edit') openEditPurchaseModal(purchaseId);
  else if(action === 'export') exportSinglePurchase(purchaseId);
  else if(action === 'email') openSendPurchaseEmailModal(purchaseId);
}

function exportSinglePurchase(purchaseId){
  const msg = document.getElementById('purchaseLogExportMsg');
  if(typeof XLSX === 'undefined'){ msg.className='msg error'; msg.textContent='Excel 套件載入失敗,請重新整理頁面再試一次'; return; }
  const p = purchases.find(x => x.id === purchaseId);
  if(!p){ msg.className='msg error'; msg.textContent='找不到這張進貨單,請重新整理頁面再試一次。'; return; }

  const { wb, filename } = buildPurchaseWorkbook(p);
  XLSX.writeFile(wb, filename);
  msg.className = 'msg ok';
  msg.textContent = `✓ 已匯出:${filename}`;
}

