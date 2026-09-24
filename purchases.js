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
function togglePurchaseDetail(id){
  expandedPurchaseId = (expandedPurchaseId === id) ? null : id;
  renderPurchaseLog();
}
function clearPurchaseLogFilters(){
  document.getElementById('purchaseLogDateFrom').value = '';
  document.getElementById('purchaseLogDateTo').value = '';
  document.getElementById('purchaseLogPartyFilter').value = '';
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

function renderPurchaseLog(){
  const container = document.getElementById('purchaseLogTable');
  if(!container) return;

  // 進貨方下拉篩選的選項,依目前所有進貨單裡實際出現過的進貨方動態產生,並保留使用者原本選的值
  // (如果篩選後那個進貨方已經不在清單裡,才會被重設成「全部對象」)。
  const partySel = document.getElementById('purchaseLogPartyFilter');
  const prevParty = partySel.value;
  const distinctParties = [...new Set(purchases.map(p => p.partyName || p.partyId || '').filter(Boolean))].sort();
  partySel.innerHTML = `<option value="">${t('logPartyAll')}</option>` + distinctParties.map(p => `<option value="${p.replace(/"/g,'&quot;')}">${p}</option>`).join('');
  if(distinctParties.includes(prevParty)) partySel.value = prevParty;

  const dateFrom = document.getElementById('purchaseLogDateFrom').value;
  const dateTo = document.getElementById('purchaseLogDateTo').value;
  const partyFilter = partySel.value;

  let filtered = purchases.slice();
  if(dateFrom) filtered = filtered.filter(p => (p.date || '') >= dateFrom);
  if(dateTo) filtered = filtered.filter(p => (p.date || '') <= dateTo);
  if(partyFilter) filtered = filtered.filter(p => (p.partyName || p.partyId || '') === partyFilter);

  if(filtered.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noPurchasesYet')}</div>`;
    return;
  }
  const sorted = filtered.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  container.innerHTML = `<table class="stock-table purchase-log-table">
      <thead><tr>
        <th>${t('colPurchaseDate')}</th>
        <th>${t('colPurchaseParty')}</th>
        <th>${t('colPurchaseInvoiceNo')}</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${sorted.map(p => `
          <tr>
            <td class="pl-date" style="cursor:pointer;white-space:nowrap;" onclick="togglePurchaseDetail('${p.id}')"><span class="td-mobile-label">${t('colPurchaseDate')}</span>${escapeHtmlForPrint(p.date || '')}</td>
            <td class="pl-party" style="cursor:pointer;" onclick="togglePurchaseDetail('${p.id}')"><span class="td-mobile-label">${t('colPurchaseParty')}</span>${escapeHtmlForPrint(p.partyName || p.partyId || '')}</td>
            <td class="pl-invoice" style="cursor:pointer;" onclick="togglePurchaseDetail('${p.id}')"><span class="td-mobile-label">${t('colPurchaseInvoiceNo')}</span>${escapeHtmlForPrint(p.invoiceNo || '')}${getPurchaseReceiptFileList(p).length > 0 ? ` <span title="${t('hasReceiptAttachedTitle')}">📎</span>` : ''}</td>
            <td class="pl-actions" style="white-space:nowrap;">
              <span class="del-link" onclick="openEditPurchaseModal('${p.id}')">${t('btnEdit')}</span>
              &nbsp;·&nbsp;
              <span class="del-link" onclick="exportSinglePurchase('${p.id}')">${t('btnExportPurchaseLog')}</span>
              &nbsp;·&nbsp;
              <span class="del-link" onclick="openSendPurchaseEmailModal('${p.id}')">${t('btnSendEmail')}</span>
              ${p.emailedAt ? `<br class="pl-actions-br"><span style="color:var(--safe);font-size:12px;" title="${tf('emailedToTitle', { email: p.emailedTo || '', when: p.emailedAt })}">${t('alreadyEmailedBadge')}</span><span style="margin-left:4px;color:var(--ink-soft);font-size:10.5px;">${formatEmailedTimeShort(p.emailedAt)}</span>` : ''}
            </td>
          </tr>
          ${expandedPurchaseId === p.id ? `
          <tr>
            <td colspan="4" style="background:var(--panel);">
              <table class="stock-table" style="margin:6px 0;">
                <thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th>${(p.items || []).some(it => it.amount) ? `<th class="num">${t('colAmount')}</th>` : ''}</tr></thead>
                <tbody>
                  ${(p.items || []).map(it => {
                    const isCreditNote = it.docType === 'credit_note';
                    const displayQty = isCreditNote ? -it.qty : it.qty;
                    const badge = isCreditNote ? ` <span style="color:var(--crit);font-weight:600;font-size:11px;">(${t('docTypeCreditNoteBadge')})</span>` : '';
                    const amountCell = (p.items || []).some(x => x.amount)
                      ? `<td class="num">${it.amount ? Number(isCreditNote ? -it.amount : it.amount).toFixed(2) : '–'}</td>` : '';
                    return `<tr><td>${escapeHtmlForPrint(it.name)}${badge}</td><td class="num">${displayQty} ${escapeHtmlForPrint(it.unit || '')}</td>${amountCell}</tr>`;
                  }).join('')}
                </tbody>
              </table>
              ${p.note ? `<p style="font-size:12.5px;color:var(--ink);margin:0 0 8px;">${tf('purchaseNoteLabel', { note: escapeHtmlForPrint(p.note) })}</p>` : ''}
              ${getPurchaseReceiptFileList(p).length > 0
                ? getPurchaseReceiptFileList(p).map(f => `<a href="${f.url}" target="_blank" style="font-size:12.5px;display:block;">📎 ${escapeHtmlForPrint(f.filename || t('linkViewUploadedReceipt'))}</a>`).join('')
                : `<span style="font-size:12.5px;color:var(--ink-soft);">${t('purchaseNoReceiptLabel')}</span>`}
            </td>
          </tr>
          ` : ''}
        `).join('')}
      </tbody>
    </table>`;
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
  const productMap = Object.fromEntries(products.map(pp => [pp.id, pp]));
  const supplier = p.partyName || p.partyId || '';
  const hasAnyAmount = (p.items || []).some(it => it.amount);
  const hasAnyDocType = (p.items || []).some(it => it.docType);

  const aoa = [];
  aoa.push([`Supplier: ${supplier}`, `Invoice No.: ${p.invoiceNo || ''}`]);
  aoa.push([`Date: ${p.date || ''}`]);
  const headerRow = ['SKU', 'Name', 'Qty', 'Unit'];
  if(hasAnyAmount) headerRow.push('Amount', 'Unit Price');
  if(hasAnyDocType) headerRow.push('Document');
  aoa.push(headerRow);
  (p.items || []).forEach(it => {
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
      row.push(displayAmount || '');
      row.push(it.amount ? Math.round((displayAmount / displayQty) * 100) / 100 : ''); // 單價用「金額 ÷ 數量」現算,不是另外存的欄位——auto convert 換算單位之後,數量已經是換算後的單位,這裡算出來的就自然是換算後單位的單價(負數除負數還是正的單價,方向正確)
    }
    if(hasAnyDocType){
      row.push(it.docType ? `${it.docType === 'credit_note' ? 'Credit Note' : 'Invoice'}${it.sourceFilename ? ' - ' + it.sourceFilename : ''}` : '');
    }
    aoa.push(row);
  });

  // 同一個商品(同一個 productId)在這張進貨單裡出現不只一筆的話——最常見的情境是原始發票
  // 一筆、後續因為缺貨另開的 Credit Note 退貨一筆——在原始逐筆明細下面另外加一段「Net Quantity
  // by Product」,把同一個商品的所有筆數(不管是發票還是 Credit Note)加總,顯示這個商品最終
  // 的淨數量/淨金額。上面的逐筆明細完全不受影響,原封不動保留每一筆的來源跟數字,這段純粹是
  // 額外附加的加總視圖,方便只想看最終結果的人一眼看到淨值,不用自己拿計算機把發票跟退貨的
  // 數字兜起來。
  const byProduct = {};
  (p.items || []).forEach(it => { (byProduct[it.productId] = byProduct[it.productId] || []).push(it); });
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
  ws['!cols'] = hasAnyAmount
    ? [{wch:10},{wch:32},{wch:8},{wch:10},{wch:12},{wch:12},{wch:24}]
    : [{wch:10},{wch:32},{wch:8},{wch:10},{wch:24}];
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
async function sendPurchaseEmail(purchaseId, toEmail, ccEmail, msgEl){
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
      invoiceNo: p.invoiceNo || ''
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
async function sendOrderEmail(orderId, toEmail, ccEmail, msgEl){
  const order = orders.find(o => o.id === orderId);
  if(!order) throw new Error('找不到這張訂單');
  const toEmails = (toEmail || '').split(',').map(e => e.trim()).filter(Boolean);
  if(toEmails.length === 0 || toEmails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error(t('errInvalidEmailAddress'));
  const ccEmails = (ccEmail || '').split(',').map(e => e.trim()).filter(Boolean);
  if(ccEmails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error(t('errInvalidEmailAddress'));

  if(msgEl){ msgEl.className = 'msg'; msgEl.textContent = t('sendingEmailMsg'); }

  const partyLabel = order.partyName || 'Unspecified';
  const dateLabel = order.date;
  const { aoa, hiddenRows } = buildOrderSheetAoa([order], partyLabel, dateLabel);
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
      invoiceNo: order.orderNo || ''
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
  document.getElementById('sendPurchaseEmailModalOverlay').style.display = 'flex';
}
function openSendOrderEmailModal(orderId){
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
  try{
    if(sendEmailTargetType === 'order'){
      await sendOrderEmail(sendPurchaseEmailTargetId, email, cc, msgEl);
      renderOrders();
    } else {
      await sendPurchaseEmail(sendPurchaseEmailTargetId, email, cc, msgEl);
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
function populateEditPurchasePartySelect(currentName){
  const sel = document.getElementById('editPurchasePartySelect');
  const input = document.getElementById('editPurchasePartyInput');
  if(!sel || !input) return;
  const sortedNames = purchaseSuppliers.map(s => s.name).sort((a,b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">${t('optSelectSupplier')}</option>` +
    sortedNames.map(p => `<option value="${p.replace(/"/g,'&quot;')}">${escapeHtmlForPrint(p)}</option>`).join('') +
    `<option value="__new__">${t('optAddNewSupplier')}</option>`;
  if(currentName && sortedNames.includes(currentName)){
    sel.value = currentName;
    input.style.display = 'none';
    input.value = currentName;
  } else {
    sel.value = '__new__';
    input.style.display = '';
    input.value = currentName || '';
  }
}
function onEditPurchasePartySelectChange(value){
  const input = document.getElementById('editPurchasePartyInput');
  if(value === '__new__'){
    input.style.display = '';
    input.value = '';
    input.focus();
  } else {
    input.style.display = 'none';
    input.value = value;
  }
}
function openEditPurchaseModal(purchaseId){
  const p = purchases.find(x => x.id === purchaseId);
  if(!p) return;
  editPurchaseTargetId = purchaseId;
  editPurchaseWorkingReceiptFiles = getPurchaseReceiptFileList(p).slice();
  editPurchaseWorkingItems = (p.items || []).map(it => ({...it}));
  document.getElementById('editPurchaseDateInput').value = p.date || '';
  populateEditPurchasePartySelect(p.partyName || p.partyId || '');
  document.getElementById('editPurchaseInvoiceInput').value = p.invoiceNo || '';
  document.getElementById('editPurchaseNoteInput').value = p.note || '';
  document.getElementById('editPurchaseReceiptUploadMsg').textContent = '';
  document.getElementById('editPurchaseScanMsg').textContent = '';
  document.getElementById('editPurchaseScanUnmatchedWrap').innerHTML = '';
  document.getElementById('editPurchaseModalMsg').textContent = '';
  renderEditPurchaseReceiptList();
  populateEditPurchaseAddItemSelect();
  renderEditPurchaseItemsList();
  document.getElementById('editPurchaseModalOverlay').style.display = 'flex';
}
function closeEditPurchaseModal(){
  editPurchaseTargetId = null;
  editPurchaseWorkingReceiptFiles = [];
  editPurchaseWorkingItems = [];
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
      <span class="del-link" onclick="removeEditPurchaseReceiptFile(${i})">${t('btnRemoveFile')}</span>
    </div>
  `).join('');
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
  wrap.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${editPurchaseWorkingItems.map((it, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);${it._scanUpdated ? 'background:var(--warn-bg);' : ''}">
          <div style="flex:1 1 140px;min-width:0;font-size:12.5px;">
            ${escapeHtmlForPrint(it.name || '')}${it.sku ? ` <span style="color:var(--ink-soft);">(${escapeHtmlForPrint(it.sku)})</span>` : ''}
            ${it.docType === 'credit_note' ? ` <span style="color:var(--crit);font-weight:600;font-size:11px;">(${t('docTypeCreditNoteBadge')})</span>` : ''}
            ${it._scanUpdated ? `<span style="color:var(--warn-dark);font-size:11px;margin-left:4px;">🔍</span>` : ''}
          </div>
          <input type="number" value="${it.qty}" min="0" step="any" style="width:70px;" oninput="updateEditPurchaseItemQty(${i}, this.value)" />
          <span style="font-size:11.5px;color:var(--ink-soft);">${escapeHtmlForPrint(it.unit || '')}</span>
          <input type="number" value="${it.amount !== undefined && it.amount !== null ? it.amount : ''}" min="0" step="any" placeholder="$" style="width:90px;" oninput="updateEditPurchaseItemAmount(${i}, this.value)" />
          <span class="del-link" onclick="removeEditPurchaseItem(${i})">${t('btnRemoveItem')}</span>
        </div>
      `).join('')}
    </div>
  `;
}
function updateEditPurchaseItemQty(index, value){
  const it = editPurchaseWorkingItems[index];
  if(!it) return;
  const n = parseFloat(value);
  it.qty = Number.isFinite(n) ? n : 0;
}
function updateEditPurchaseItemAmount(index, value){
  const it = editPurchaseWorkingItems[index];
  if(!it) return;
  if(value === ''){ delete it.amount; return; }
  const n = parseFloat(value);
  it.amount = Number.isFinite(n) ? n : undefined;
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
  const amountVal = amountInput.value === '' ? undefined : parseFloat(amountInput.value);
  // 手動新增的品項,如果剛好跟清單裡已經有的某一項是同一個商品、也同樣沒有 docType/來源檔案
  // (代表都是一般手動輸入的,不是分屬不同收據來源),直接把數量/金額併進那一列,不要平白多出
  // 重複的兩列看起來像同一個商品被記兩筆帳。
  const existing = editPurchaseWorkingItems.find(it => it.productId === productId && !it.docType && !it.sourceFilename);
  if(existing){
    existing.qty = (existing.qty || 0) + qty;
    if(amountVal !== undefined) existing.amount = (existing.amount || 0) + amountVal;
  } else {
    const item = { productId, sku: p.sku || '', name: p.name, unit: p.unit, qty };
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

  // 品項清單存檔前先去掉 _scanUpdated(只是編輯畫面上用來標記「這行剛被掃描結果蓋過」的暫時
  // UI 旗標,不是資料本身的一部分,不能真的存進 purchase.items 裡)。
  const cleanItems = editPurchaseWorkingItems.map(it => {
    const { _scanUpdated, ...rest } = it;
    return rest;
  });
  // 比較品項有沒有真的改過:正規化成只留下影響庫存/金額的欄位、排序後再比較,不受「使用者
  // 只是把某一列刪掉又加回來、順序跟原本不一樣」這種操作影響——只要最終內容一樣,就不算改過,
  // 不需要白白重新產生一次 transactions。
  const normalizeForCompare = (items) => items.map(it => ({
    productId: it.productId,
    qty: Number(it.qty) || 0,
    amount: (it.amount !== undefined && it.amount !== null) ? Number(it.amount) : null,
    docType: it.docType || null,
    sourceFilename: it.sourceFilename || null
  })).sort((a,b) => `${a.productId}|${a.docType}|${a.sourceFilename}`.localeCompare(`${b.productId}|${b.docType}|${b.sourceFilename}`));
  const itemsChanged = JSON.stringify(normalizeForCompare(p.items || [])) !== JSON.stringify(normalizeForCompare(cleanItems));

  msgEl.className = 'msg'; msgEl.textContent = t('savingMsg');
  const oldDate = p.date, oldParty = p.partyName, oldInvoice = p.invoiceNo, oldNote = p.note;
  p.date = dateVal;
  p.partyName = partyVal;
  p.partyId = partyVal;
  p.invoiceNo = invoiceVal;
  p.note = noteVal;
  p.items = cleanItems;
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
    renderPurchaseLog();
    if(itemsChanged) renderAll(); // 庫存數字真的變了,連動刷新庫存總覽等其他畫面
    closeEditPurchaseModal();
  } catch(e){
    console.error('儲存進貨單失敗', e);
    msgEl.className = 'msg error';
    msgEl.textContent = '⚠ 儲存失敗,請重新整理頁面再試一次。';
  }
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

