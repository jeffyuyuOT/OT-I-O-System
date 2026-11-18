// ============================================================
// nb-cost.js — 不做批次追蹤(商品設定「批次追蹤」關閉)的商品:移動加權平均成本
//   依日期重播這個商品的進出貨:每次「有價錢」的進貨,新平均 = (現有數量 × 目前平均 + 新貨總金額) ÷ (現有數量 + 新貨數量);
//   出貨/調整/耗損只改數量,不改平均;沒價錢的進貨只增加數量;庫存歸零後再進貨,平均從新貨成本重新開始。
//   算兩組:base(底價,會計資產用)與 total(含其他支出分攤,Price setting 的成本用)。
//   不需要新資料表:進貨單的品項金額 + transactions 重播即可。
// ============================================================
let nbIdx = null, nbIdxAt = 0;
function nbInvalidate(){ nbIdx = null; }
function nbIsUntracked(pid){
  if(typeof batchActive !== 'function' || !batchActive()) return false;
  const p = (typeof products !== 'undefined') ? products.find(x => x.id === pid) : null;
  return !!p && p.batchTrack === false;
}
function nbBuildIndex(){
  const now = Date.now();
  if(nbIdx && now - nbIdxAt < 1500) return nbIdx;
  const untracked = new Set(((typeof products !== 'undefined') ? products : []).filter(p => p.batchTrack === false).map(p => p.id));
  const ev = {}, price = {};
  (typeof purchases !== 'undefined' ? purchases : []).forEach(p => {
    (p.items || []).forEach(it => {
      if(!untracked.has(it.productId) || it.docType === 'credit_note' || it.docType === 'others' || it.noAcct) return;
      const q = Number(it.qty) || 0, a = Number(it.amount) || 0;
      if(!(q > 0) || !(a > 0)) return;
      const tot = (it.totalAmount !== undefined && it.totalAmount !== null) ? Number(it.totalAmount) : a;
      const k = p.id + '|' + it.productId;
      const g = price[k] = price[k] || { q: 0, base: 0, total: 0 };
      g.q += q; g.base += a; g.total += tot;
    });
  });
  (typeof transactions !== 'undefined' ? transactions : []).forEach((tx, i) => {
    if(!untracked.has(tx.productId)) return;
    const g = (tx.type === 'in' && tx.purchaseId) ? price[tx.purchaseId + '|' + tx.productId] : null;
    (ev[tx.productId] = ev[tx.productId] || []).push({ date: tx.date || '', ord: i, dir: tx.type === 'out' ? -1 : 1, qty: Number(tx.qty) || 0,
      ub: g ? g.base / g.q : null, ut: g ? g.total / g.q : null });
  });
  Object.keys(ev).forEach(k => ev[k].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord)));
  nbIdx = ev; nbIdxAt = now;
  return nbIdx;
}
// 回傳 { base, total, qty(重播算出的庫存量) };不是不追批次的商品或沒有任何有價錢的進貨 → null。asOf = 'YYYY-MM-DD'(含當天)
function nbCost(pid, asOf){
  if(!nbIsUntracked(pid)) return null;
  const evs = nbBuildIndex()[pid] || [];
  let on = 0, raw = 0, ab = null, at = null;
  evs.forEach(e => {
    if(asOf && e.date > asOf) return;
    if(e.dir > 0){
      raw += e.qty;
      if(e.ub !== null && e.ub !== undefined){
        if(on > 0 && ab !== null){ ab = (on * ab + e.qty * e.ub) / (on + e.qty); at = (on * at + e.qty * e.ut) / (on + e.qty); }
        else { ab = e.ub; at = e.ut; }
      }
      on = Math.max(0, on) + e.qty;
    } else { raw -= e.qty; on = Math.max(0, on - e.qty); }
  });
  if(ab === null) return null;
  const r2 = x => Math.round(x * 100) / 100;
  return { base: ab, total: at, qty: Math.max(0, raw), cost2: r2(at) };
}
// 某日(含)的庫存量:現在 = 庫存快取;過去 = 當天以前的進出貨加總
function nbOnHand(pid, asOf){
  if(!asOf) return Number((typeof productStockMap !== 'undefined' && productStockMap[pid]) || 0);
  let s = 0;
  (typeof transactions !== 'undefined' ? transactions : []).forEach(tx => { if(tx.productId === pid && (tx.date || '') <= asOf) s += tx.type === 'out' ? -tx.qty : tx.qty; });
  return s;
}

// ---- 不追批次 → 改成追批次:把「還沒有批次的庫存量」轉成一個起始批次(成本 = 轉換當下的平均成本)----
// 庫存量 − 這個商品現有批次的剩餘量 > 0 的部分才轉(曾經追過批次、剩餘批次還在的,不會重複算)。
function nbCarryPlan(pid){
  if(!nbIsUntracked(pid)) return null;
  const stock = nbOnHand(pid, null);
  const inBatches = (typeof batchItemsOfProduct === 'function' ? batchItemsOfProduct(pid) : []).reduce((s, i) => s + (Number(i.remaining) || 0), 0);
  const qty = Math.round((stock - inBatches) * 1e6) / 1e6;
  if(!(qty > 0)) return null;
  const c = nbCost(pid);
  return { pid, qty, base: c ? c.base : null, total: c ? c.total : null };
}
async function nbCarryRun(plan){
  await batchRpc('batch_carry_over', { p_product_id: plan.pid, p_qty: plan.qty, p_base: plan.base, p_total: plan.total });
  try{ batchMarkStale(); await ensureBatchDataLoaded(true); }catch(e){}
  nbInvalidate();
}
