// ============================================================
// 切換紀錄(Convert History)——只保留最近 30 天,列表顯示、
// 復原切換(把一組配對的 out/in 交易復原)。
// ============================================================
function formatTimeHHMM(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getConversionRecords(){
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = [cutoff.getFullYear(), String(cutoff.getMonth()+1).padStart(2,'0'), String(cutoff.getDate()).padStart(2,'0')].join('-');
  const byId = {};
  transactions.forEach(tx => {
    if(!tx.conversion || !tx.conversionId) return;
    if(tx.date < cutoffStr) return;
    if(!byId[tx.conversionId]) byId[tx.conversionId] = {};
    byId[tx.conversionId][tx.type] = tx;
  });
  return Object.keys(byId)
    .map(id => byId[id])
    .filter(pair => pair.out && pair.in)
    .map(pair => {
      const fromP = products.find(x => x.id === pair.out.productId);
      const toP = products.find(x => x.id === pair.in.productId);
      // createdAt 這個欄位只存在記憶體裡,沒有存進資料庫,重新整理頁面後就會不見,導致同一天
      // 好幾筆切換記錄的排序退化成只看日期(當天全部同分同秒,排序就變成不穩定)。id 本身開頭
      // 就是建立當下的時間戳記(見 genId/idCreatedTime),不管有沒有重新整理過都在,拿來排序
      // 才會穩定、精確到毫秒,不會有這個問題。
      const idTime = idCreatedTime(pair.out.id) || idCreatedTime(pair.in.id);
      const createdAt = pair.out.createdAt || pair.in.createdAt || (idTime ? idTime.toISOString() : '');
      return {
        conversionId: pair.out.conversionId,
        date: pair.out.date,
        time: formatTimeHHMM(createdAt) || (idTime ? formatHHMM(idTime) : ''),
        sortKey: (idTime ? idTime.getTime() : 0) || (createdAt ? new Date(createdAt).getTime() : 0) || new Date(pair.out.date).getTime(),
        fromName: fromP ? fromP.name : t('deletedProductLabel'),
        fromQty: pair.out.qty,
        fromUnit: fromP ? fromP.unit : '',
        toName: toP ? toP.name : t('deletedProductLabel'),
        toQty: pair.in.qty,
        toUnit: toP ? toP.unit : ''
      };
    })
    .sort((a, b) => b.sortKey - a.sortKey);
}
function renderConvertHistoryTable(){
  const container = document.getElementById('convertHistoryTable');
  if(!container) return;
  const records = getConversionRecords();
  if(records.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noConvertHistory')}</div>`;
    return;
  }
  container.innerHTML = `<table class="stock-table">
      <thead><tr>
        <th>${t('colDate')}</th>
        <th>${t('convertFromLabel')}</th>
        <th>${t('convertToLabel')}</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${records.map(r => `
          <tr>
            <td style="white-space:nowrap;">${r.date}${r.time ? ` ${r.time}` : ''}</td>
            <td>${r.fromName} −${r.fromQty} ${r.fromUnit}</td>
            <td>${r.toName} +${r.toQty} ${r.toUnit}</td>
            <td><span class="del-link" onclick="undoConversion('${r.conversionId}')">${t('btnUndoConversion')}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

// 復原一組切換紀錄:把配對的兩筆交易一起刪除。由「歷史紀錄 → 切換紀錄」子分頁裡的「復原」
// 按鈕直接呼叫。
// 復原前要先檢查:這兩筆交易裡,「type 是 in(切換當下新增進去的那筆)」如果被移除,會不會讓那個
// 商品現在的庫存變成負的——如果切換之後那個商品又被出貨掉了(不管是透過訂單還是登記進出貨),
// 庫存可能已經不夠讓這筆切換完整復原,這種情況要擋下來並清楚告知是哪個商品、目前只剩多少庫存。
// 「type 是 out(切換當下扣掉的那筆)」復原時是把庫存加回去,不會有變負的風險,不用檢查。
async function undoConversion(conversionId){
  const pair = transactions.filter(tx => tx.conversionId === conversionId);
  if(pair.length === 0) return;

  for(const tx of pair){
    if(tx.type !== 'in') continue;
    const currentStock = computeStock(tx.productId);
    const afterRevert = currentStock - tx.qty;
    if(afterRevert < 0){
      const p = products.find(x => x.id === tx.productId);
      showInfoModal(tf('errUndoConversionWouldGoNegative', {
        name: p ? p.name : tx.productId,
        stock: currentStock,
        unit: p ? p.unit : '',
        needed: tx.qty
      }));
      return;
    }
  }

  transactions = transactions.filter(tx => tx.conversionId !== conversionId);
  await deleteTransactions(pair);
  logInventoryAction('conversion_undo', `Reverted conversion (id ${conversionId})`, null);
  renderAll();
  renderConvertHistoryTable();
}
