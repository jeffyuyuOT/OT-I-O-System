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
                <thead><tr><th>${t('colProduct')}</th><th class="num">${t('colQty')}</th></tr></thead>
                <tbody>
                  ${(p.items || []).map(it => `<tr><td>${escapeHtmlForPrint(it.name)}</td><td class="num">${it.qty} ${escapeHtmlForPrint(it.unit || '')}</td></tr>`).join('')}
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

  const aoa = [];
  aoa.push([`Supplier: ${supplier}`, `Invoice No.: ${p.invoiceNo || ''}`]);
  aoa.push([`Date: ${p.date || ''}`]);
  aoa.push(hasAnyAmount ? ['SKU', 'Name', 'Qty', 'Unit', 'Amount', 'Unit Price'] : ['SKU', 'Name', 'Qty', 'Unit']);
  (p.items || []).forEach(it => {
    const prod = productMap[it.productId];
    const row = [
      prod && prod.sku ? prod.sku : (it.sku || ''),
      prod ? prod.name : (it.name || '(deleted product)'),
      it.qty,
      prod ? prod.unit : (it.unit || '')
    ];
    if(hasAnyAmount){
      row.push(it.amount || '');
      row.push(it.amount ? Math.round((it.amount / it.qty) * 100) / 100 : ''); // 單價用「金額 ÷ 數量」現算,不是另外存的欄位——auto convert 換算單位之後,數量已經是換算後的單位,這裡算出來的就自然是換算後單位的單價
    }
    aoa.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = hasAnyAmount
    ? [{wch:10},{wch:32},{wch:8},{wch:10},{wch:12},{wch:12}]
    : [{wch:10},{wch:32},{wch:8},{wch:10}];
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
async function confirmSendPurchaseEmail(){
  if(!sendPurchaseEmailTargetId) return;
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
  }
}

// 歷史紀錄裡編輯一張進貨單:主要是給補資料用的(當初建立進貨單時 Invoice Number 還沒拿到手、
// 收據還沒補齊,等資料齊全了再回頭補上)——只能改日期/進貨方/Invoice Number/收據附件這幾樣
// 單據層級的資訊,不會動到品項清單或已經記錄的庫存異動(那些是實際庫存數字的依據,改了會跟
// 已經發生的進出貨紀錄對不起來,不開放在這裡編輯)。
let editPurchaseTargetId = null;
let editPurchaseWorkingReceiptFiles = []; // 編輯中的收據附件清單(工作副本),按「取消」不會影響到原本存的資料,只有按「儲存」才會真的寫回去
function openEditPurchaseModal(purchaseId){
  const p = purchases.find(x => x.id === purchaseId);
  if(!p) return;
  editPurchaseTargetId = purchaseId;
  editPurchaseWorkingReceiptFiles = getPurchaseReceiptFileList(p).slice();
  document.getElementById('editPurchaseDateInput').value = p.date || '';
  document.getElementById('editPurchasePartyInput').value = p.partyName || p.partyId || '';
  document.getElementById('editPurchaseInvoiceInput').value = p.invoiceNo || '';
  document.getElementById('editPurchaseNoteInput').value = p.note || '';
  document.getElementById('editPurchaseReceiptUploadMsg').textContent = '';
  document.getElementById('editPurchaseModalMsg').textContent = '';
  renderEditPurchaseReceiptList();
  document.getElementById('editPurchaseModalOverlay').style.display = 'flex';
}
function closeEditPurchaseModal(){
  editPurchaseTargetId = null;
  editPurchaseWorkingReceiptFiles = [];
  document.getElementById('editPurchaseModalOverlay').style.display = 'none';
}
function renderEditPurchaseReceiptList(){
  const wrap = document.getElementById('editPurchaseReceiptExistingWrap');
  if(!wrap) return;
  if(editPurchaseWorkingReceiptFiles.length === 0){
    wrap.innerHTML = `<span style="font-size:12px;color:var(--ink-soft);">${t('purchaseNoReceiptLabel')}</span>`;
    return;
  }
  wrap.innerHTML = editPurchaseWorkingReceiptFiles.map((f, i) => `
    <div style="display:flex;align-items:center;gap:10px;">
      <a href="${f.url}" target="_blank" style="font-size:12.5px;">📎 ${escapeHtmlForPrint(f.filename || '')}</a>
      <span class="del-link" onclick="removeEditPurchaseReceiptFile(${i})">${t('btnRemoveFile')}</span>
    </div>
  `).join('');
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
    if((!file.type.startsWith('image/') && file.type !== 'application/pdf') || file.size > maxBytes){
      failCount++;
      continue;
    }
    msgEl.style.color = 'var(--ink-soft)';
    msgEl.textContent = tf('uploadingReceiptMsgWithName', { name: file.name });
    const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_');
    const path = `${genId()}/${safeName}`;
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

  msgEl.className = 'msg'; msgEl.textContent = t('savingMsg');
  const oldDate = p.date, oldParty = p.partyName, oldInvoice = p.invoiceNo, oldNote = p.note;
  p.date = dateVal;
  p.partyName = partyVal;
  p.partyId = partyVal;
  p.invoiceNo = invoiceVal;
  p.note = noteVal;
  p.receiptFiles = editPurchaseWorkingReceiptFiles.slice();
  delete p.receiptUrl; // 舊格式欄位一旦編輯過就統一改用新的 receiptFiles 陣列,不留舊欄位造成混淆
  delete p.receiptFilename;
  try{
    await upsertPurchase(p);
    // 進貨單的日期/進貨方/Invoice Number/備註改了的話,連動更新當初送出這張進貨單時一起建立的
    // 那幾筆庫存異動紀錄(transactions,用 purchaseId 連回這張單)——那些紀錄自己也各自存了一份
    // party/invoiceNo/date/note,不是即時參照進貨單,不連動更新的話,「歷史紀錄→進出貨紀錄」看到
    // 的會是編輯前的舊資料,跟進貨單本身顯示的對不起來。庫存數量/商品完全不受影響,只同步這四個
    // 純文字欄位。
    if(dateVal !== oldDate || partyVal !== oldParty || invoiceVal !== oldInvoice || noteVal !== (oldNote || '')){
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

