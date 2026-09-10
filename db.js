// ============================================================
// 資料存取層(Data Access Layer)——直接對 Supabase 做讀寫的函式、
// 資料表 row ↔ 前端物件的轉換(xxxToRow / rowToXxx)、庫存快取
// (productStockMap)。純粹的商品/訂單/交易紀錄等業務邏輯不放這裡,
// 只放「怎麼把資料存進去、怎麼把資料讀出來」這一層。
// ============================================================
// ---- Shared key-value storage helpers (replaces the old window.storage API) ----
async function dbGet(key){
  const { data, error } = await sb.from('app_data').select('value').eq('key', key).maybeSingle();
  if(error){ console.error('dbGet error', key, error); return null; }
  return data ? { value: data.value } : null;
}
async function dbSet(key, value){
  const { error } = await sb.from('app_data').upsert({ key, value, updated_at: new Date().toISOString() });
  if(error){ console.error('dbSet error', key, error); throw error; }
  return true;
}

// ---- Transactions: real per-row table (transactions/product_stock/confirm_order —
// see supabase_transactions_migration.sql) instead of one shared JSON blob under
// app_data. This means two people editing at the same time can no longer silently
// wipe out each other's records, and stock checks/deductions go through Postgres
// so they're atomic even with concurrent order confirmations. ----
let productStockMap = {}; // productId -> current on-hand stock (cached from product_stock table)

function txToRow(tx){
  return {
    id: tx.id,
    product_id: tx.productId,
    type: tx.type,
    qty: tx.qty,
    date: tx.date || null,
    party: tx.party || null,
    note: tx.note || null,
    invoice_no: tx.invoiceNo || null,
    system: !!tx.system,
    order_id: tx.orderId || null,
    conversion: !!tx.conversion,
    conversion_id: tx.conversionId || null,
    master_import_adjustment: !!tx.masterImportAdjustment,
    purchase_id: tx.purchaseId || null
  };
}
function rowToTx(row){
  const tx = { id: row.id, productId: row.product_id, type: row.type, qty: Number(row.qty), date: row.date, party: row.party || '', note: row.note || '' };
  if(row.invoice_no) tx.invoiceNo = row.invoice_no;
  if(row.system) tx.system = true;
  if(row.order_id) tx.orderId = row.order_id;
  if(row.conversion) tx.conversion = true;
  if(row.conversion_id) tx.conversionId = row.conversion_id;
  if(row.master_import_adjustment) tx.masterImportAdjustment = true;
  if(row.purchase_id) tx.purchaseId = row.purchase_id;
  return tx;
}
function txStockDelta(tx){ return tx.type === 'out' ? -tx.qty : tx.qty; }

async function dbAdjustStockBatch(deltaMap){
  const entries = Object.entries(deltaMap).filter(([,d]) => d);
  if(entries.length === 0) return;
  const payload = entries.map(([product_id, delta]) => ({ product_id, delta }));
  const { error } = await sb.rpc('adjust_stock_batch', { p_deltas: payload });
  if(error){ console.error('調整庫存快取失敗', payload, error); throw error; }
  entries.forEach(([pid, delta]) => { productStockMap[pid] = (productStockMap[pid] || 0) + delta; });
}

// 新增一或多筆交易紀錄:寫入 transactions 資料表(逐筆 insert,不覆蓋其他人同時寫入的資料),
// 並 atomic 調整對應商品的庫存快取。呼叫端仍要自己把 tx 物件 push 進本地的 transactions 陣列。
async function insertTransactions(txList){
  if(!txList || txList.length === 0) return;
  const { error } = await sb.from('transactions').insert(txList.map(txToRow));
  if(error){ console.error('新增交易紀錄失敗', error); throw error; }
  const deltaMap = {};
  txList.forEach(tx => { deltaMap[tx.productId] = (deltaMap[tx.productId] || 0) + txStockDelta(tx); });
  await dbAdjustStockBatch(deltaMap);
}

// 刪除一或多筆交易紀錄(傳完整物件,不是只傳 id,因為要知道該還原多少庫存)。
async function deleteTransactions(txList){
  if(!txList || txList.length === 0) return;
  const { error } = await sb.from('transactions').delete().in('id', txList.map(t => t.id));
  if(error){ console.error('刪除交易紀錄失敗', error); throw error; }
  const deltaMap = {};
  txList.forEach(tx => { deltaMap[tx.productId] = (deltaMap[tx.productId] || 0) - txStockDelta(tx); });
  await dbAdjustStockBatch(deltaMap);
}

// 編輯單筆交易紀錄:oldTx 是異動前的物件、newTx 是異動後的物件(呼叫前呼叫端已經把欄位改到 newTx 上)。
// 會先把舊的庫存影響還原,再套用新的 —— 就算商品被改成別的商品,兩邊的庫存都會對。
async function updateTransaction(oldTx, newTx){
  const { error } = await sb.from('transactions').update(txToRow(newTx)).eq('id', newTx.id);
  if(error){ console.error('更新交易紀錄失敗', error); throw error; }
  const deltaMap = {};
  deltaMap[oldTx.productId] = (deltaMap[oldTx.productId] || 0) - txStockDelta(oldTx);
  deltaMap[newTx.productId] = (deltaMap[newTx.productId] || 0) + txStockDelta(newTx);
  await dbAdjustStockBatch(deltaMap);
}

// 只有「還原備份」這個明確、具破壞性的動作才會整批覆蓋(先清空 transactions 表跟庫存快取,再整批寫回)。
// 平常的新增/刪除/編輯一律走上面幾個 function,不會整批覆蓋,才不會蓋掉其他使用者同時間寫入的資料。
async function replaceAllTransactions(txList){
  const { error: delErr } = await sb.from('transactions').delete().not('id', 'is', null);
  if(delErr){ console.error('清空交易紀錄失敗', delErr); throw delErr; }
  const chunkSize = 500;
  for(let i = 0; i < txList.length; i += chunkSize){
    const chunk = txList.slice(i, i + chunkSize).map(txToRow);
    if(chunk.length === 0) continue;
    const { error: insErr } = await sb.from('transactions').insert(chunk);
    if(insErr){ console.error('還原交易紀錄失敗', insErr); throw insErr; }
  }
  const stockMap = {};
  txList.forEach(tx => { stockMap[tx.productId] = (stockMap[tx.productId] || 0) + txStockDelta(tx); });
  const { error: rsErr } = await sb.rpc('replace_stock_cache', { p_stocks: Object.entries(stockMap).map(([product_id, stock]) => ({ product_id, stock })) });
  if(rsErr){ console.error('重建庫存快取失敗', rsErr); throw rsErr; }
  productStockMap = stockMap;
}

async function loadTransactions(){
  const { data, error } = await sb.from('transactions').select('*').order('id', { ascending: true });
  if(error){ console.error('讀取交易紀錄失敗', error); transactions = []; return; }
  transactions = (data || []).map(rowToTx);
}

async function loadProductStock(){
  const { data, error } = await sb.from('product_stock').select('*');
  if(error){ console.error('讀取庫存快取失敗', error); productStockMap = {}; return; }
  productStockMap = {};
  (data || []).forEach(row => { productStockMap[row.product_id] = Number(row.stock); });
}

async function saveProducts(){
  try{ await dbSet('products', JSON.stringify(products)); }
  catch(e){ console.error('儲存商品失敗', e); }
  scheduleAutoBackup();
}
async function loadOrders(){
  try{
    const { data, error } = await sb.from('orders').select('payload');
    if(error) throw error;
    orders = (data || []).map(r => r.payload);
  } catch(e){ console.error('讀取訂單失敗', e); orders = []; }
}
// Supabase's row-level security (see supplier_restriction_migration.sql)
// silently limits a supplier-restricted user's reach here — they only ever
// load their own supplier's rows in the first place (loadOrders above),
// so this can never touch another supplier's orders even though the code
// itself doesn't do any manual filtering.
//
// 正因為上面這條限制,本地端的 orders 陣列在「限定出貨方權限」的帳號手上永遠是不完整的,
// computePendingReserved()/computeAvailableForOrder() 只拿這份陣列算出來的「可訂數量」對
// 這種帳號來說可能是錯的(看不到別家出貨方訂走的量)。這支函式呼叫 pending_reserved_qty_rpc_
// migration.sql 建立的 security definer 函式,繞過該限制拿到「全系統、不分出貨方」的權威預訂
// 總量(只有商品 ID + 數量,不含任何出貨方細節),送出訂單前一定要再用這份資料驗證一次,
// 不能只信任本地端 collectOrderItems() 那次檢查——這正是之前庫存超賣問題的根本原因:
// 兩個出貨方權限沒有交集的使用者,彼此的預訂量互相看不到。
async function fetchGlobalReservedQty(){
  const { data, error } = await sb.rpc('get_pending_reserved_qty');
  if(error) throw error;
  const map = {};
  (data || []).forEach(row => { map[row.product_id] = parseFloat(row.reserved_qty) || 0; });
  return map;
}

// 平常新增/軟刪除訂單一律用這個:只 upsert 傳進來的那幾筆訂單,不會去比對「本地陣列裡沒有的,
// 就當作要從資料庫刪除」——上一版的 saveOrders() 是整批比對本地 vs 遠端、刪掉本地沒有的,如果
// 兩個人幾乎同時操作、彼此看到的本地快照不同步,會誤刪對方剛寫入還沒同步回來的訂單。
async function upsertOrders(orderList){
  if(!orderList || orderList.length === 0) return;
  const rows = orderList.map(o => ({
    id: o.id,
    party_id: o.partyId || null,
    payload: o,
    updated_at: new Date().toISOString()
  }));
  const { error } = await sb.from('orders').upsert(rows);
  if(error){ console.error('儲存訂單失敗', error); throw error; }
  scheduleAutoBackup();
}

async function loadDeliveryNotes(){
  try{
    const { data, error } = await sb.from('delivery_notes').select('payload');
    if(error) throw error;
    deliveryNotes = (data || []).map(r => r.payload);
  } catch(e){ console.error('讀取 Delivery Note 失敗', e); deliveryNotes = []; }
}

async function upsertDeliveryNotes(noteList){
  if(!noteList || noteList.length === 0) return;
  const rows = noteList.map(n => ({
    id: n.id,
    party_id: n.partyId || null,
    payload: n,
    updated_at: new Date().toISOString()
  }));
  const { error } = await sb.from('delivery_notes').upsert(rows);
  if(error){ console.error('儲存 Delivery Note 失敗', error); throw error; }
  scheduleAutoBackup();
}

async function loadPurchases(){
  try{
    const { data, error } = await sb.from('purchases').select('payload');
    if(error) throw error;
    purchases = (data || []).map(r => r.payload);
  } catch(e){ console.error('讀取進貨單失敗', e); purchases = []; }
}

async function upsertPurchase(p){
  const row = { id: p.id, party_id: p.partyId || null, payload: p, updated_at: new Date().toISOString() };
  const { error } = await sb.from('purchases').upsert(row);
  if(error){ console.error('儲存進貨單失敗', error); throw error; }
  scheduleAutoBackup();
}

function locationToRow(loc){
  return {
    id: loc.id, product_id: loc.productId,
    zone: loc.zone || null, aisle: loc.aisle || null, bay: loc.bay || null, level: loc.level || null, bin: loc.bin || null,
    location_code: loc.locationCode, qty: loc.qty, photo_url: loc.photoUrl || null,
    updated_at: new Date().toISOString()
  };
}
function rowToLocation(row){
  return {
    id: row.id, productId: row.product_id,
    zone: row.zone || '', aisle: row.aisle || '', bay: row.bay || '', level: row.level || '', bin: row.bin || '',
    locationCode: row.location_code, qty: Number(row.qty), photoUrl: row.photo_url || null
  };
}
async function loadProductLocations(){
  try{
    const { data, error } = await sb.from('product_locations').select('*');
    if(error) throw error;
    productLocations = (data || []).map(rowToLocation);
  } catch(e){ console.error('讀取庫存分布失敗', e); productLocations = []; }
}
async function upsertProductLocation(loc){
  const { error } = await sb.from('product_locations').upsert(locationToRow(loc));
  if(error){ console.error('儲存庫存分布失敗', error); throw error; }
  scheduleAutoBackup();
}
async function deleteProductLocationRow(id){
  const { error } = await sb.from('product_locations').delete().eq('id', id);
  if(error){ console.error('刪除庫存分布紀錄失敗', error); throw error; }
}

function receiptMappingToRow(m){
  return { id: m.id, party_id: m.partyId || null, normalized_text: m.normalizedText, product_id: m.productId, updated_at: new Date().toISOString() };
}
function rowToReceiptMapping(row){
  return { id: row.id, partyId: row.party_id || null, normalizedText: row.normalized_text, productId: row.product_id };
}
async function loadReceiptLineMappings(){
  try{
    const { data, error } = await sb.from('receipt_line_mappings').select('*');
    if(error) throw error;
    receiptLineMappings = (data || []).map(rowToReceiptMapping);
  } catch(e){ console.error('讀取收據辨識記憶對照表失敗', e); receiptLineMappings = []; }
}

function supplierToRow(s){
  return { id: s.id, name: s.name, phone: s.phone || null, address: s.address || null, note: s.note || null, updated_at: new Date().toISOString() };
}
function rowToSupplier(row){
  return { id: row.id, name: row.name, phone: row.phone || '', address: row.address || '', note: row.note || '' };
}
async function loadPurchaseSuppliers(){
  try{
    const { data, error } = await sb.from('purchase_suppliers').select('*');
    if(error) throw error;
    purchaseSuppliers = (data || []).map(rowToSupplier);
  } catch(e){ console.error('讀取進貨方管理清單失敗', e); purchaseSuppliers = []; }
}
async function upsertPurchaseSupplier(s){
  const { error } = await sb.from('purchase_suppliers').upsert(supplierToRow(s));
  if(error){ console.error('儲存進貨方失敗', error); throw error; }
  scheduleAutoBackup();
}
async function deletePurchaseSupplierRow(id){
  const { error } = await sb.from('purchase_suppliers').delete().eq('id', id);
  if(error){ console.error('刪除進貨方失敗', error); throw error; }
}

// 記住「這個供應商 + 這串文字」對應到哪個商品——同一組 partyId+normalizedText 已經記過的話,
// 直接更新那一筆(改指到新選的商品),不會留著舊的、產生兩筆矛盾的對照。
async function rememberReceiptLineMapping(partyId, normalizedText, productId){
  let existing = receiptLineMappings.find(m => (m.partyId || null) === (partyId || null) && m.normalizedText === normalizedText);
  const mapping = existing || { id: genId(), partyId: partyId || null, normalizedText, productId };
  mapping.productId = productId;
  if(!existing){
    receiptLineMappings.push(mapping);
    // 這筆是這次掃描過程中新建立的(不是原本就有、只是更新對應的商品),記下它的 id——如果
    // 這次的掃描整個被取消,才知道要把哪幾筆新建的記憶一起復原刪除,不能留下「掃描已經取消了,
    // 卻默默留下部分永久記憶」這種不一致的狀態。
    receiptOcrSessionNewMappingIds.push(mapping.id);
  }
  try{ await sb.from('receipt_line_mappings').upsert(receiptMappingToRow(mapping)); }
  catch(e){ console.error('儲存收據辨識記憶失敗', e); }
}
// 正規化 OCR 讀到的文字,拿來查記憶對照表用——轉小寫、去頭尾空白、把連續空白縮成一個,
// 這樣同一行文字即使 OCR 每次辨識出來的空白位置有些微差異,還是能對到同一筆記憶。
function normalizeReceiptLineText(text){
  return (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
}
// 回傳三種可能:{type:'product', product} 之前確認過對應到某個商品、{type:'skip'} 之前確認過
// 這行不是商品資訊(公司資訊、地址這類)、或 null(完全沒有記憶,要跳出視窗問)。
const RECEIPT_SKIP_SENTINEL = '__skip__';
function findReceiptLineMapping(partyId, rawText){
  const normalized = normalizeReceiptLineText(rawText);
  const match = receiptLineMappings.find(m => m.normalizedText === normalized && ((m.partyId || null) === (partyId || null)))
    || receiptLineMappings.find(m => m.normalizedText === normalized); // 找不到「這個供應商」專屬的對照,退一步看有沒有其他供應商也用過同樣文字對應到的商品(不同供應商的收據品項描述有時候剛好長一樣)
  if(!match) return null;
  if(match.productId === RECEIPT_SKIP_SENTINEL) return { type: 'skip' };
  const product = products.find(p => p.id === match.productId);
  return product ? { type: 'product', product } : null;
}

// 一個商品的位置紀錄被刪光(全部變成未分布)的時候,把「最後一次的主要位置」記在商品自己身上
// (product.lastPrimaryLocation,存完整的 zone/aisle/bay/level/bin,不是只存組合完的字串)——
// 這樣之後庫存分布頁面的下拉選單,就算這個商品目前完全沒有真正的位置資料,也能在清單最下面
// 提示「以前通常放在哪裡」,選了直接把新增位置的欄位都幫忙填好,不用重新想一次位置編號。
// 呼叫時機:任何一個位置被刪掉之後,如果那個商品的位置清單已經整個空了,而且剛好被刪掉的
// 就是原本的主要位置(通常是最後剩下的那一筆),才會記錄下來。
async function rememberLastPrimaryLocationIfNowEmpty(deletedLoc, wasPrimary){
  if(!wasPrimary) return;
  const stillHasLocations = productLocations.some(l => l.productId === deletedLoc.productId);
  if(stillHasLocations) return;
  const p = products.find(x => x.id === deletedLoc.productId);
  if(!p || (p.lastPrimaryLocation && p.lastPrimaryLocation.locationCode === deletedLoc.locationCode)) return;
  p.lastPrimaryLocation = {
    zone: deletedLoc.zone || '', aisle: deletedLoc.aisle || '', bay: deletedLoc.bay || '',
    level: deletedLoc.level || '', bin: deletedLoc.bin || '', locationCode: deletedLoc.locationCode
  };
  try{ await saveProducts(); }
  catch(e){ console.error('記錄最後主要位置失敗', e); }
}

async function deleteDeliveryNoteRow(id){
  const { error } = await sb.from('delivery_notes').delete().eq('id', id);
  if(error){ console.error('刪除 Delivery Note 失敗', error); throw error; }
  scheduleAutoBackup();
}

// 還原預設(清空所有資料 / 清空後台紀錄與訂單)兩種情況都要用到——Delivery Note 一定會關聯到
// 一張已完成訂單號,訂單被清空之後這些 Note 就變成指向不存在的訂單的孤兒資料,兩種清除模式
// 都應該一併清掉,不留下對不上任何訂單的殘留紀錄。
async function clearAllDeliveryNotes(){
  const { error } = await sb.from('delivery_notes').delete().not('id', 'is', null);
  if(error){ console.error('清空 Delivery Note 失敗', error); throw error; }
}

async function clearAllPurchases(){
  const { error } = await sb.from('purchases').delete().not('id', 'is', null);
  if(error){ console.error('清空進貨單失敗', error); throw error; }
}

// 只有「還原備份」這個明確、具破壞性的動作才會整批覆蓋(先清空 orders 表,再整批寫回本地陣列的內容)。
async function replaceAllOrders(orderList){
  const { error: delErr } = await sb.from('orders').delete().not('id', 'is', null);
  if(delErr){ console.error('清空訂單失敗', delErr); throw delErr; }
  if(orderList.length > 0){
    const rows = orderList.map(o => ({
      id: o.id,
      party_id: o.partyId || null,
      payload: o,
      updated_at: new Date().toISOString()
    }));
    const chunkSize = 500;
    for(let i = 0; i < rows.length; i += chunkSize){
      const { error: insErr } = await sb.from('orders').insert(rows.slice(i, i + chunkSize));
      if(insErr){ console.error('還原訂單失敗', insErr); throw insErr; }
    }
  }
  scheduleAutoBackup();
}
// ===== 後台紀錄(Inventory log):記錄「訂貨、進貨、出貨、入庫、修改訂單、刪除訂單…」等操作動作，
// 存進獨立的 inventory_log 資料表(見 inventory_log_migration.sql),每筆帶時間、操作動作、操作
// 使用者、還有一句人看得懂的描述。寫入失敗只印 console 錯誤、不擋住原本的操作，避免因為記錄稽核
// 紀錄失敗反而讓使用者真正要做的事(訂貨/登記進出貨…)也跟著失敗。 =====
async function logInventoryAction(actionType, description, orderNo){
  try{
    const { error } = await sb.from('inventory_log').insert({
      action_type: actionType,
      actor: (currentUser && currentUser.username) || null,
      description,
      order_no: orderNo || null
    });
    if(error) console.error('寫入後台紀錄失敗', error);
  } catch(e){ console.error('寫入後台紀錄失敗', e); }
}

async function loadInventoryLog(){
  try{
    const { data, error } = await sb.from('inventory_log')
      .select('id,created_at,action_type,actor,description,order_no')
      .order('created_at', { ascending: false })
      .limit(1000);
    if(error) throw error;
    inventoryLogs = data || [];
  } catch(e){ console.error('讀取後台紀錄失敗', e); inventoryLogs = []; }
}

// ===== 還原預設(系統設置分頁的破壞性重置動作)=====
// 「訂單編號」是資料庫序列 public.order_no_seq(見 next_order_no() RPC),前端 JS 沒有權限直接下
// ALTER SEQUENCE,所以重設回 1 要透過另一個 RPC:reset_order_no_seq()。這個 RPC 需要先在 Supabase
// SQL Editor 手動建立一次(SECURITY DEFINER 執行 ALTER SEQUENCE public.order_no_seq RESTART WITH 1;),
// 建立好之後這裡才能正常呼叫;如果還沒建立,會捕捉錯誤並提示使用者。
async function resetOrderNoSequence(){
  const { error } = await sb.rpc('reset_order_no_seq');
  if(error){ console.error('重設訂單編號序列失敗', error); throw error; }
}

// 從一組訂單裡找出「最大的訂單編號」(數字部分),沒有任何訂單或都沒有編號就回傳 0。
function maxOrderNoIn(orderList){
  let max = 0;
  (orderList || []).forEach(o => {
    if(o.orderNo){
      const m = String(o.orderNo).match(/(\d+)/);
      if(m) max = Math.max(max, parseInt(m[1], 10));
    }
  });
  return max;
}

// 還原備份之後要呼叫這個,把資料庫序列「推進」到還原進來的訂單編號之後,避免序列停在
// 比較低的舊位置,之後新建的訂單撞到還原回來的舊編號(見 sync_order_no_seq_migration.sql
// 裡的完整說明)。回傳 true/false 表示有沒有成功——呼叫端會依這個結果決定要不要在畫面上
// 額外提醒使用者(不會因為這一步失敗就擋住整個還原流程,訂單/商品/庫存還是照樣還原進去)。
async function syncOrderNoSequenceAfterRestore(orderList){
  const maxNo = maxOrderNoIn(orderList);
  if(maxNo <= 0) return true; // 沒有訂單編號可比對,不算失敗
  try{
    const { error } = await sb.rpc('sync_order_no_seq', { p_min_next: maxNo + 1 });
    if(error) throw error;
    return true;
  } catch(e){
    console.error('同步訂單編號序列失敗(可能是 sync_order_no_seq_migration.sql 還沒在 Supabase 執行過)', e);
    return false;
  }
}

// inventory_log 這張表通常只開放「新增/讀取」給一般前端角色(RLS 刻意不開放 DELETE,
// 避免使用者能竄改自己的操作稽核紀錄),所以直接用 sb.from('inventory_log').delete() 在
// 資料庫端會被權限擋掉、實際刪 0 筆,但不一定會丟出明確錯誤。要真的清空必須透過一個
// SECURITY DEFINER 的 RPC(clear_inventory_log)繞過這個限制,一樣需要先在 Supabase
// SQL Editor 手動建立一次。
async function clearInventoryLogTable(){
  const { error } = await sb.rpc('clear_inventory_log');
  if(error){ console.error('清空後台紀錄失敗', error); throw error; }
}

async function saveShippingParties(){
  try{ await dbSet('shippingParties', JSON.stringify(shippingParties)); }
  catch(e){ console.error('儲存出貨方失敗', e); }
  scheduleAutoBackup();
}
async function saveOrderCounter(){
  try{ await dbSet('orderCounter', String(orderCounter)); }
  catch(e){ console.error('儲存訂單編號計數失敗', e); }
}

// 訂貨頁面(confirm_order RPC)是用 public.order_no_seq 這個資料庫序列取號,絕對不會重複。
// 這裡改成呼叫 next_order_no() RPC,讓「登記進出貨→併入已完成訂單」也直接向同一個序列拿號,
// 兩邊從此共用同一個號碼來源,不會再各自獨立計數、也不會再有撞號的可能(不管兩個人是不是幾乎同時
// 提交)。原本「重新跟資料庫核對最大值再 +1」的本機算法已經不需要了,保留 orderCounter 只用來
// 支援舊資料裡缺編號的補齊邏輯(見 loadData)。
async function getSafeNextOrderNo(){
  const { data, error } = await sb.rpc('next_order_no');
  if(error){
    console.error('取得訂單編號失敗', error);
    throw error;
  }
  return data;
}
