// ============================================================
// Price Setting(售價設定)頁面 + 歷史紀錄 → Price record
//
// - 頁面放在「倉庫後台管理」的子分頁。可以設定每個商品的 Sell price,旁邊顯示「正在出貨的批次」的成本價,
//   以及目前 Sell price 相對成本價多出的 margin(%);margin 低於系統設置的「警示 margin」會顯示 ⚠。
// - 「Apply margin」:把目前篩選到的商品的 Sell price 設成 (正在出貨批次的成本價) × (1 + margin%)(先放進草稿,按儲存才生效)。
// - 儲存:Price Setting 的價格存在 app_data 'priceSettings'({ 商品id: 價格 }),同時存一筆 Price record:
//     app_data 'priceRecordIndex' = [{ id, ts, by, source, note, count, changed }](清單,新的在前)
//     app_data 'priceRecord_<id>' = { id, ts, by, source, note, items:[{ p, n, u, c, s, k, b }] }
//       p 商品id、n 名稱、u 單位、c 分類、s Sell price、k 當時成本價(正在出貨批次)、b 批次號
// - 「Sell price 依據」(系統設置)是 batch 時,這一頁鎖住(只能看):Sell price 由批次成本 + 批次 margin 決定。
// 依賴:sell-price.js、batch-tracking.js、quick-lists.js
// ============================================================
let psDraft = {};            // 還沒儲存的修改:{ 商品id: 數字 或 null(清空) }
let psFilters = { type: '', val: '' };   // 篩選方式 type:''(不篩選)/ 'cat' / 'sup' / 'ql',val = 選到的分類/供應商/快捷清單
let psMarginInput = null;    // 頁面上 Apply margin 輸入框的值(字串);null = 用系統預設 margin
let psPageMsg = '';          // 頁面上方的提示訊息(例如已套用到幾個商品)
let psPageMsgType = '';
let psRecordIndex = null;    // Price record 清單(快取)
let psRecView = null;        // 正在看的某一筆紀錄:{ rec, f:{cat,sup,ql,q} }
let psRecDateFrom = '', psRecDateTo = '';

const psEsc = s => (typeof batchEsc === 'function') ? batchEsc(s) : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ---------- 共用:商品、成本、margin ----------
function psAllProducts(){ return (products || []).filter(p => !p.hidden); }
function psSortProducts(list){
  const order = (typeof categoryOrder !== 'undefined' && Array.isArray(categoryOrder)) ? categoryOrder : [];
  const idx = c => { const k = order.indexOf(c || '未分類'); return k === -1 ? 9999 : k; };
  return list.slice().sort((a, b) => (idx(a.category) - idx(b.category)) || String(a.name || '').localeCompare(String(b.name || '')));
}
// 正在出貨的批次 = 這個商品還有庫存的批次裡,出貨順序最前面的(期初批次 → 先到期先出 → 進貨日 FIFO)
function psCurrentBatchItem(pid){
  if(typeof batchActive !== 'function' || !batchActive()) return null;
  const arr = batchItemsOfProduct(pid);
  return arr.length ? arr[0] : null;
}
// 回傳 { cost, batchNo, isOpening }(沒有批次回傳 null;批次沒有成本資料 cost 為 null)
function psCostInfo(pid){
  const it = psCurrentBatchItem(pid);
  if(!it) return null;
  return { cost: spTotalUnit(it), batchNo: it.batchNo, isOpening: !!it.isOpening, item: it };
}
function psMarginOf(sell, cost){
  if(sell === null || sell === undefined || cost === null || cost === undefined) return null;
  if(!(Number(cost) > 0)) return null;
  return spRound2((Number(sell) / Number(cost) - 1) * 100);
}
function psMarginHtml(m){
  if(m === null || m === undefined) return '–';
  const warn = m < spWarnMargin();
  return `<span style="${warn ? 'color:var(--crit,#c0392b);font-weight:700;' : ''}">${m}%</span>${warn ? ` <span title="${psEsc(tf('psWarnTitle', { w: spWarnMargin() }))}" style="cursor:help;">⚠️</span>` : ''}`;
}

// ---------- 共用:篩選(分類 / 供應商 / 快捷清單)----------
// 供應商 → 商品:這個供應商進過貨的商品(批次資料裡的供應商 + 進貨紀錄的對象),以「商品家族主商品」為單位
function psSupplierMap(){
  const map = new Map();   // 小寫名稱 -> { name, anchors:Set }
  const add = (name, pid) => {
    const n = String(name || '').trim(); if(!n) return;
    const k = n.toLowerCase();
    let e = map.get(k); if(!e){ e = { name: n, anchors: new Set() }; map.set(k, e); }
    const a = (typeof normalizeToAnchorId === 'function') ? normalizeToAnchorId(pid) : pid;
    if(a) e.anchors.add(a);
  };
  (typeof purchaseSuppliers !== 'undefined' ? purchaseSuppliers : []).forEach(s => { const n = String(s.name || '').trim(); if(n && !map.has(n.toLowerCase())) map.set(n.toLowerCase(), { name: n, anchors: new Set() }); });
  try{ if(typeof batchData !== 'undefined' && batchData.items) batchData.items.forEach(i => add(i.supplier, i.productId)); }catch(e){}
  try{ (transactions || []).forEach(x => { if(x.type === 'in') add(x.party, x.productId); }); }catch(e){}
  return map;
}
function psUsedCategories(list){
  if(typeof syncCategoryOrder === 'function') syncCategoryOrder();
  const order = (typeof categoryOrder !== 'undefined' && Array.isArray(categoryOrder)) ? categoryOrder : [];
  return order.filter(c => list.some(p => (p.category || '未分類') === c));
}
function psFilterProducts(list, f, supMap){
  let out = list;
  f = { cat: f.type === 'cat' ? f.val : '', sup: f.type === 'sup' ? f.val : '', ql: f.type === 'ql' ? f.val : '', q: f.q || '' };
  if(f.cat) out = out.filter(p => (p.category || '未分類') === f.cat);
  if(f.sup){
    const e = (supMap || psSupplierMap()).get(String(f.sup).toLowerCase());
    const set = e ? e.anchors : new Set();
    out = out.filter(p => set.has((typeof normalizeToAnchorId === 'function' ? normalizeToAnchorId(p.id) : p.id)));
  }
  if(f.ql){
    const set = (typeof getQuickListAnchorIds === 'function') ? getQuickListAnchorIds(f.ql) : new Set();
    out = out.filter(p => set.has((typeof normalizeToAnchorId === 'function' ? normalizeToAnchorId(p.id) : p.id)));
  }
  if(f.q){
    const q = String(f.q).trim().toLowerCase();
    if(q) out = out.filter(p => String(p.name || '').toLowerCase().includes(q) || String(p.sku || '').toLowerCase().includes(q));
  }
  return out;
}
// 篩選:先用下拉選擇篩選方式(依分類 / 依供應商 / 依快捷清單),選了之後才會出現後面對應的下拉欄
function psFilterSelectsHtml(prefix, f, supMap, list, onchangeJs){
  const opt = (v, label, cur) => `<option value="${psEsc(v)}"${v === cur ? ' selected' : ''}>${psEsc(label)}</option>`;
  let valHtml = '';
  if(f.type === 'cat'){
    valHtml = `<div class="field"><label>${t('psFilterByCat')}</label><select id="${prefix}Val" onchange="${onchangeJs}">${opt('', t('catFilterAll'), f.val)}${psUsedCategories(list).map(c => opt(c, catLabel(c), f.val)).join('')}</select></div>`;
  } else if(f.type === 'sup'){
    const sups = Array.from(supMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    valHtml = `<div class="field"><label>${t('psFilterSupplier')}</label><select id="${prefix}Val" onchange="${onchangeJs}">${opt('', t('psSupplierAll'), f.val)}${sups.map(s => opt(s.name, s.name, f.val)).join('')}</select></div>`;
  } else if(f.type === 'ql'){
    const qls = (typeof quickLists !== 'undefined' ? quickLists : []).slice().sort((a, b) => a.name.localeCompare(b.name));
    valHtml = `<div class="field"><label>${t('psFilterQuickList')}</label><select id="${prefix}Val" onchange="${onchangeJs}">${opt('', t('quickListFilterAll'), f.val)}${qls.map(q => opt(q.id, q.name, f.val)).join('')}</select></div>`;
  }
  return `<div class="field"><label>${t('psFilterBy')}</label>
      <select id="${prefix}Type" onchange="${onchangeJs}">${opt('', t('psFilterNone'), f.type)}${opt('cat', t('psFilterByCat'), f.type)}${opt('sup', t('psFilterBySup'), f.type)}${opt('ql', t('psFilterByQl'), f.type)}</select></div>${valHtml}`;
}
function psReadFilters(prefix, f){
  const ty = document.getElementById(prefix + 'Type'), va = document.getElementById(prefix + 'Val');
  const newType = ty ? ty.value : '';
  if(newType !== f.type){ f.type = newType; f.val = ''; }
  else f.val = va ? va.value : '';
}

// ---------- 儲存 Price Setting + Price record ----------
function psWho(){
  try{ return (typeof userDisplayName === 'function' && currentUser) ? (userDisplayName(currentUser) || currentUser.email || '') : ''; }catch(e){ return ''; }
}
function psBuildRecord(map, source, note){
  const items = [];
  psAllProducts().forEach(p => {
    const s = (map[p.id] === undefined || map[p.id] === null) ? null : Number(map[p.id]);
    const ci = psCostInfo(p.id);
    const k = ci && ci.cost !== null ? ci.cost : null;
    if(s === null && k === null) return;
    items.push({ p: p.id, n: p.name || '', u: p.unit || '', c: p.category || '未分類', s, k, b: ci ? ci.batchNo : '' });
  });
  return { id: genId(), ts: new Date().toISOString(), by: psWho(), source: source || 'manual', note: note || '', items };
}
async function psLoadIndex(force){
  if(psRecordIndex && !force) return psRecordIndex;
  let idx = [];
  try{
    const r = await dbGet('priceRecordIndex');
    const arr = r && r.value ? JSON.parse(r.value) : [];
    if(Array.isArray(arr)) idx = arr.filter(x => x && x.id && x.ts);
  }catch(e){ console.warn('讀取 Price record 清單失敗', e); }
  psRecordIndex = idx;
  return idx;
}
// 存新的 Price Setting 價格(next = 完整的 { 商品id: 價格 })並新增一筆 Price record;失敗會丟出錯誤
async function psSavePriceMap(next, source, note){
  try{ if(typeof ensureBatchDataLoaded === 'function') await ensureBatchDataLoaded(); }catch(e){}
  const old = spPriceMap || {};
  let changed = 0;
  new Set([...Object.keys(old), ...Object.keys(next)]).forEach(k => { if((old[k] === undefined ? null : old[k]) !== (next[k] === undefined ? null : next[k])) changed++; });
  const rec = psBuildRecord(next, source, note);
  await dbSet('priceRecord_' + rec.id, JSON.stringify(rec));
  await dbSet('priceSettings', JSON.stringify(next));
  spPriceMap = next;
  try{
    const idx = (await psLoadIndex(true)).slice();
    idx.unshift({ id: rec.id, ts: rec.ts, by: rec.by, source: rec.source, note: rec.note, count: rec.items.filter(i => i.s !== null).length, changed });
    await dbSet('priceRecordIndex', JSON.stringify(idx));
    psRecordIndex = idx;
  }catch(e){ console.error('更新 Price record 清單失敗(價格已儲存)', e); throw e; }
  return rec;
}

// ============================================================
// Price Setting 頁面
// ============================================================
async function psOpenPage(){
  const root = document.getElementById('priceSettingRoot');
  if(root && typeof batchData !== 'undefined' && !batchData.loaded) root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  try{ if(typeof ensureBatchDataLoaded === 'function') await ensureBatchDataLoaded(); }catch(e){}
  psRenderPage();
}
function psCanEdit(){ return spIsSettingBasis() && canEditPrice(); }
function psSavedSell(pid){ return spSettingPrice(pid); }
// 這個商品目前在畫面上的 Sell price(草稿優先;依批次成本計價時是算出來的)
function psShownSell(pid, ci){
  if(spIsSettingBasis()){
    if(Object.prototype.hasOwnProperty.call(psDraft, pid)) return psDraft[pid];
    return psSavedSell(pid);
  }
  return ci && ci.item ? spSellUnit(ci.item) : null;
}
function psRenderPage(){
  const root = document.getElementById('priceSettingRoot');
  if(!root) return;
  if(typeof batchFeatureOn !== 'function' || !batchFeatureOn()){ root.innerHTML = `<div class="empty-note">${t('psFeatureOff')}</div>`; return; }
  const all = psAllProducts();
  const supMap = psSupplierMap();
  // 篩選條件失效(例如快捷清單被刪)就退回「全部」
  if(psFilters.type === 'ql' && psFilters.val && !(quickLists || []).some(q => q.id === psFilters.val)) psFilters.val = '';
  const list = psSortProducts(psFilterProducts(all, psFilters, supMap));
  const setting = spIsSettingBasis();
  const editable = psCanEdit();
  const dirtyCount = Object.keys(psDraft).filter(pid => (psDraft[pid] === undefined ? null : psDraft[pid]) !== psSavedSell(pid)).length;
  const marginVal = psMarginInput === null ? String(spDefaultMarginPct) : psMarginInput;

  const banner = !setting ? `<div class="ps-lock-banner" style="border:1px solid var(--warn,#B8860B);background:var(--warn-bg,#FFF8E1);padding:10px 14px;margin-bottom:12px;font-size:12.5px;line-height:1.6;">🔒 ${t('psLockedBanner')}</div>`
    : (!canEditPrice() ? `<div style="border:1px solid var(--line);padding:8px 12px;margin-bottom:12px;font-size:12.5px;color:var(--ink-soft);">${t('psNoEditPermission')}</div>` : '');

  const rows = list.map(p => {
    const ci = psCostInfo(p.id);
    const cost = ci ? ci.cost : null;
    const sell = psShownSell(p.id, ci);
    const m = psMarginOf(sell, cost);
    const edited = setting && Object.prototype.hasOwnProperty.call(psDraft, p.id) && (psDraft[p.id] === undefined ? null : psDraft[p.id]) !== psSavedSell(p.id);
    const sellCell = (setting && editable)
      ? `<input type="number" min="0" step="0.01" id="psSell_${psEsc(p.id)}" value="${sell === null || sell === undefined ? '' : sell}" oninput="psOnSellInput('${psEsc(p.id)}', this.value)" style="width:100px;text-align:right;${edited ? 'background:#FFF8E1;' : ''}" />`
      : `<span>${sell === null || sell === undefined ? '–' : spMoney(sell)}</span>`;
    const costCell = ci ? (cost === null ? `<span title="${psEsc(t('psNoCostHint'))}">–</span>` : spMoney(cost)) + `<div style="font-size:10.5px;color:var(--ink-soft);">${ci.isOpening ? psEsc(t('batchOpening')) : psEsc(ci.batchNo)}</div>` : '–';
    const bw = setting ? psBatchMarginWarn(p.id, sell) : null;
    const bwHtml = bw ? ` <span class="batch-link" title="${psEsc(t('psBatchWarnTitle'))}" style="cursor:pointer;" onclick="psShowBatchMarginInfo('${psEsc(p.id)}')">🏷️⚠️</span>` : '';
    return `<tr>
      <td>${psEsc(p.name || '')}${bwHtml}${p.parentId ? ' <span style="color:var(--ink-soft);font-size:11px;">⧉</span>' : ''}<div style="font-size:10.5px;color:var(--ink-soft);">${psEsc(p.sku || '')}${p.unit ? ' · ' + psEsc(p.unit) : ''}</div></td>
      <td class="num">${sellCell}</td>
      <td class="num">${costCell}</td>
      <td class="num" id="psMargin_${psEsc(p.id)}">${psMarginHtml(m)}</td>
    </tr>`;
  }).join('');

  root.innerHTML = `
    ${banner}
    <div class="filter-row" style="margin-bottom:10px;">
      ${psFilterSelectsHtml('psF', psFilters, supMap, all, 'psOnFilterChange()')}
      <button class="btn ghost" onclick="psClearFilters()" style="align-self:flex-end;">${t('btnClearFilter')}</button>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 10px;padding:10px 12px;border:1px solid var(--line);">
      <strong style="font-size:12.5px;">Margin</strong>
      <input id="psMarginInput" type="number" min="0" step="any" value="${psEsc(marginVal)}" oninput="psMarginInput=this.value" style="width:90px;" ${editable ? '' : 'disabled'} /><span>%</span>
      <button class="btn" onclick="psApplyMargin()" ${editable ? '' : 'disabled'}>${t('psBtnApplyMargin')}</button>
      <span style="font-size:11.5px;color:var(--ink-soft);">${tf('psApplyHint', { n: list.length })}</span>
      <span style="flex:1;"></span>
      <button class="btn ghost" id="psDiscardBtn" onclick="psDiscard()" ${editable && dirtyCount > 0 ? '' : 'disabled'}>${t('psBtnDiscard')}</button>
      <button class="btn" id="psSaveBtn" onclick="psSave()" ${editable && dirtyCount > 0 ? '' : 'disabled'}>${t('btnSave')}${dirtyCount > 0 ? ' (' + dirtyCount + ')' : ''}</button>
    </div>
    <div id="psPageMsg" class="msg ${psPageMsgType}">${psEsc(psPageMsg)}</div>
    <div style="font-size:11.5px;color:var(--ink-soft);margin:0 0 8px;">${t('psColumnsHint')}</div>
    ${list.length === 0 ? `<div class="empty-note">${t('psNoProducts')}</div>` : `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('lblProduct')}</th><th class="num">Sell price</th><th class="num">${t('psColCost')}</th><th class="num">Margin</th></tr></thead><tbody>${rows}</tbody></table></div>`}`;
}
// 這個商品正在出貨的批次有手動設定 margin,而且算出來的售價跟目前 Price Setting 的價格不同 → 回傳 { item, margin, suggested, cost }
function psBatchMarginWarn(pid, shownSell){
  if(!spIsSettingBasis()) return null;
  const ci = psCostInfo(pid);
  if(!ci || ci.cost === null || ci.isOpening) return null;
  const m = spManualMargins[ci.item.batchId];
  if(m === undefined || m === null) return null;
  const suggested = spRound2(ci.cost * (1 + m / 100));
  if(shownSell !== null && shownSell !== undefined && Math.abs(Number(shownSell) - suggested) < 0.005) return null;
  return { item: ci.item, margin: m, suggested, cost: ci.cost };
}
function psShowBatchMarginInfo(pid){
  const bw = psBatchMarginWarn(pid, psShownSell(pid, psCostInfo(pid)));
  if(!bw) return;
  const p = products.find(x => x.id === pid);
  const old = document.getElementById('psBatchInfoOverlay'); if(old) old.remove();
  const cur = psShownSell(pid, psCostInfo(pid));
  const row = (l, v) => `<tr><td>${l}</td><td class="num">${v}</td></tr>`;
  const ov = document.createElement('div');
  ov.id = 'psBatchInfoOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  ov.onclick = e => { if(e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="modal-box" style="max-width:min(420px,92vw);">
    <div class="section-title" style="margin-top:0;">${psEsc(p ? p.name : pid)} · ${psEsc(bw.item.batchNo)}</div>
    <p style="font-size:12.5px;margin:0 0 8px;">${t('psBatchInfoHint')}</p>
    <table class="stock-table"><tbody>
      ${row(t('psInfoCost'), spMoney(bw.cost))}
      ${row(t('psInfoBatchMargin'), bw.margin + '%')}
      ${row(t('psInfoBatchSell'), spMoney(bw.suggested))}
      ${row(t('psInfoCurrentSell'), cur === null || cur === undefined ? '–' : spMoney(cur))}
    </tbody></table>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('psBatchInfoOverlay').remove()">${t('btnClose')}</button>${psCanEdit() ? `<button class="btn" onclick="psApplyBatchSuggested('${psEsc(pid)}')">${t('psBtnApplySuggested')}</button>` : ''}</div>
  </div>`;
  document.body.appendChild(ov);
}
function psApplyBatchSuggested(pid){
  const bw = psBatchMarginWarn(pid, psShownSell(pid, psCostInfo(pid)));
  const ov = document.getElementById('psBatchInfoOverlay'); if(ov) ov.remove();
  if(!bw || !psCanEdit()) return;
  psDraft[pid] = bw.suggested;
  psSetMsg(t('psSuggestedApplied'), 'ok');
  psRenderPage();
}
function psSetMsg(msg, type){ psPageMsg = msg || ''; psPageMsgType = type || ''; }
function psOnFilterChange(){ psReadFilters('psF', psFilters); psSetMsg(''); psRenderPage(); }
function psClearFilters(){ psFilters = { type: '', val: '' }; psSetMsg(''); psRenderPage(); }
// 輸入 Sell price:只更新同一列的 margin 與儲存按鈕,不重畫整頁(避免輸入框失去游標)
function psOnSellInput(pid, raw){
  const v = String(raw).trim();
  const n = Number(v);
  if(v === '') psDraft[pid] = null;
  else if(Number.isFinite(n) && n >= 0) psDraft[pid] = n;
  else return;
  const ci = psCostInfo(pid);
  const cell = document.getElementById('psMargin_' + pid);
  if(cell) cell.innerHTML = psMarginHtml(psMarginOf(psDraft[pid], ci ? ci.cost : null));
  const dirty = Object.keys(psDraft).filter(k => (psDraft[k] === undefined ? null : psDraft[k]) !== psSavedSell(k)).length;
  const sb2 = document.getElementById('psSaveBtn'), db2 = document.getElementById('psDiscardBtn');
  if(sb2){ sb2.disabled = dirty === 0; sb2.textContent = t('btnSave') + (dirty > 0 ? ' (' + dirty + ')' : ''); }
  if(db2) db2.disabled = dirty === 0;
  const inp = document.getElementById('psSell_' + pid);
  if(inp) inp.style.background = (psDraft[pid] === undefined ? null : psDraft[pid]) !== psSavedSell(pid) ? '#FFF8E1' : '';
}
function psApplyMargin(){
  if(!psCanEdit()) return;
  const el = document.getElementById('psMarginInput');
  const raw = el ? el.value : String(spDefaultMarginPct);
  psMarginInput = raw;
  const m = Number(String(raw).trim());
  if(String(raw).trim() === '' || !Number.isFinite(m) || m < 0 || m > 1000){ psSetMsg(t('spMarginInvalid'), 'error'); psRenderPage(); return; }
  const list = psFilterProducts(psAllProducts(), psFilters, psSupplierMap());
  let done = 0, skipped = 0;
  list.forEach(p => {
    const ci = psCostInfo(p.id);
    if(!ci || ci.cost === null || !(ci.cost > 0)){ skipped++; return; }
    psDraft[p.id] = spRound2(ci.cost * (1 + m / 100));
    done++;
  });
  psSetMsg(tf('psApplied', { n: done, m }) + (skipped ? ' ' + tf('psAppliedSkipped', { n: skipped }) : ''), done > 0 ? 'ok' : 'error');
  psRenderPage();
}
function psDiscard(){
  psDraft = {}; psSetMsg(''); psRenderPage();
}
async function psSave(){
  if(!psCanEdit()) return;
  const next = Object.assign({}, spPriceMap);
  let changes = 0;
  Object.keys(psDraft).forEach(pid => {
    const v = psDraft[pid] === undefined ? null : psDraft[pid];
    if(v === psSavedSell(pid)) return;
    changes++;
    if(v === null) delete next[pid]; else next[pid] = spRound2(v);
  });
  if(changes === 0){ psSetMsg(t('psNoChanges'), 'error'); psRenderPage(); return; }
  try{
    await psSavePriceMap(next, 'manual', '');
    psDraft = {};
    psSetMsg(tf('psSaved', { n: changes }), 'ok');
  }catch(e){
    console.error('儲存 Price Setting 失敗', e);
    psSetMsg(t('spMarginSaveFailed'), 'error');
  }
  psRenderPage();
  try{ if(typeof renderAll === 'function') renderAll(); }catch(e){}
}

// ============================================================
// 歷史紀錄 → Price record
// ============================================================
async function psOpenRecordList(){
  psRecView = null;
  const root = document.getElementById('priceRecordRoot');
  if(root) root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  await psLoadIndex(true);
  psRenderRecordList();
}
function psSourceLabel(r){ return r.source === 'batchMargin' ? t('psRecBatchMargin') : (r.source === 'import' ? t('psRecImport') : t('psRecManual')); }
function psFmtTime(iso){
  const d = new Date(iso); if(isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function psLocalDate(iso){
  const d = new Date(iso); if(isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function psRenderRecordList(){
  const root = document.getElementById('priceRecordRoot');
  if(!root) return;
  if(psRecView){ psRenderRecordDetail(); return; }
  const idx = (psRecordIndex || []).filter(r => (!psRecDateFrom || psLocalDate(r.ts) >= psRecDateFrom) && (!psRecDateTo || psLocalDate(r.ts) <= psRecDateTo));
  const rows = idx.map(r => `<tr style="cursor:pointer;" onclick="psOpenRecord('${psEsc(r.id)}')">
      <td style="white-space:nowrap;"><span class="batch-link">${psEsc(psFmtTime(r.ts))}</span></td>
      <td>${psEsc(psSourceLabel(r))}${r.note ? `<div style="font-size:11px;color:var(--ink-soft);">${psEsc(r.note)}</div>` : ''}</td>
      <td>${psEsc(r.by || '')}</td>
      <td class="num">${r.changed === undefined ? '–' : r.changed}</td>
      <td class="num">${r.count === undefined ? '–' : r.count}</td>
    </tr>`).join('');
  root.innerHTML = `
    <div class="filter-row" style="margin-bottom:10px;">
      <div class="field"><label>${t('lblFromDate')}</label><input type="date" id="psRecFrom" value="${psEsc(psRecDateFrom)}" onchange="psOnRecDateChange()" /></div>
      <div class="field"><label>${t('lblToDate')}</label><input type="date" id="psRecTo" value="${psEsc(psRecDateTo)}" onchange="psOnRecDateChange()" /></div>
      <button class="btn ghost" onclick="psRecDateFrom='';psRecDateTo='';psRenderRecordList()" style="align-self:flex-end;">${t('btnClearFilter')}</button>
    </div>
    ${idx.length === 0 ? `<div class="empty-note">${t('psRecEmpty')}</div>` : `<div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">${t('psRecClickHint')}</div>
    <div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('psRecColTime')}</th><th>${t('psRecColType')}</th><th>${t('psRecColBy')}</th><th class="num">${t('psRecColChanged')}</th><th class="num">${t('psRecColCount')}</th></tr></thead><tbody>${rows}</tbody></table></div>`}`;
}
function psOnRecDateChange(){
  psRecDateFrom = (document.getElementById('psRecFrom') || {}).value || '';
  psRecDateTo = (document.getElementById('psRecTo') || {}).value || '';
  psRenderRecordList();
}
async function psOpenRecord(id){
  const root = document.getElementById('priceRecordRoot');
  if(root) root.innerHTML = `<div class="empty-note">${t('batchLoading')}</div>`;
  let rec = null;
  try{
    const r = await dbGet('priceRecord_' + id);
    rec = r && r.value ? JSON.parse(r.value) : null;
  }catch(e){ console.warn('讀取 Price record 失敗', e); }
  if(!rec || !Array.isArray(rec.items)){ psRecView = null; psRenderRecordList(); showInfoModal(t('psRecLoadFailed')); return; }
  psRecView = { rec, f: { type: '', val: '', q: '' } };
  psRenderRecordDetail();
}
function psRecBack(){ psRecView = null; psRenderRecordList(); }
function psRenderRecordDetail(){
  const root = document.getElementById('priceRecordRoot');
  if(!root || !psRecView) return;
  const rec = psRecView.rec, f = psRecView.f;
  const supMap = psSupplierMap();
  // 篩選用的商品清單:紀錄裡的商品(用紀錄當時的名稱/分類)
  const pseudo = rec.items.map(i => ({ id: i.p, name: i.n, unit: i.u, category: i.c, sku: ((products || []).find(x => x.id === i.p) || {}).sku || '' }));
  root.innerHTML = `
    <div style="margin:0 0 10px;"><button class="btn ghost" onclick="psRecBack()">← ${t('batchBackPrev')}</button></div>
    <div class="section-title" style="margin-top:0;">${psEsc(psFmtTime(rec.ts))} · ${psEsc(psSourceLabel(rec))}${rec.by ? ' · ' + psEsc(rec.by) : ''}</div>
    ${rec.note ? `<div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">${psEsc(rec.note)}</div>` : ''}
    <div class="filter-row" style="margin-bottom:10px;">
      ${psFilterSelectsHtml('psR', f, supMap, pseudo, 'psOnRecFilterChange()')}
      <div class="field" style="min-width:200px;"><label>${t('psSearchProduct')}</label><input type="search" id="psRQ" value="${psEsc(f.q)}" oninput="psOnRecSearch(this.value)" placeholder="${psEsc(t('psSearchProduct'))}" /></div>
    </div>
    <div id="psRecTable"></div>`;
  psRenderRecordTable();
}
function psOnRecFilterChange(){ psReadFilters('psR', psRecView.f); psRenderRecordTable(); }
function psOnRecSearch(v){ psRecView.f.q = v; psRenderRecordTable(); }
function psRenderRecordTable(){
  const box = document.getElementById('psRecTable');
  if(!box || !psRecView) return;
  const f = psRecView.f;
  const items = psRecView.rec.items;
  const pseudo = items.map(i => ({ id: i.p, name: i.n, unit: i.u, category: i.c, sku: ((products || []).find(x => x.id === i.p) || {}).sku || '' }));
  const keep = new Set(psFilterProducts(pseudo, f, psSupplierMap()).map(p => p.id));
  const order = (typeof categoryOrder !== 'undefined' && Array.isArray(categoryOrder)) ? categoryOrder : [];
  const idx = c => { const k = order.indexOf(c || '未分類'); return k === -1 ? 9999 : k; };
  const rows = items.filter(i => keep.has(i.p)).sort((a, b) => (idx(a.c) - idx(b.c)) || String(a.n).localeCompare(String(b.n))).map(i => {
    const m = psMarginOf(i.s, i.k);
    return `<tr>
      <td>${psEsc(i.n)}<div style="font-size:10.5px;color:var(--ink-soft);">${psEsc(catLabel(i.c || '未分類'))}${i.u ? ' · ' + psEsc(i.u) : ''}</div></td>
      <td class="num">${i.s === null || i.s === undefined ? '–' : spMoney(i.s)}</td>
      <td class="num">${i.k === null || i.k === undefined ? '–' : spMoney(i.k)}${i.b ? `<div style="font-size:10.5px;color:var(--ink-soft);">${psEsc(i.b)}</div>` : ''}</td>
      <td class="num">${psMarginHtml(m)}</td>
    </tr>`;
  }).join('');
  box.innerHTML = rows ? `<div style="overflow-x:auto;"><table class="stock-table"><thead><tr><th>${t('lblProduct')}</th><th class="num">Sell price</th><th class="num">${t('psRecColCostThen')}</th><th class="num">Margin</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-note">${t('psNoProducts')}</div>`;
}

// ============================================================
// 備份 / 還原 / 清除全部資料
// 備份檔的 priceData = { priceSettings, batchMarginManual, records:[完整的售價紀錄], index }
// ============================================================
async function psExportForBackup(){
  const idx = await psLoadIndex(true);
  const records = [];
  for(const m of idx){
    const r = await dbGet('priceRecord_' + m.id);
    if(r && r.value){ try{ records.push(JSON.parse(r.value)); }catch(e){} }
  }
  return { priceSettings: spPriceMap || {}, batchMarginManual: spManualMargins || {}, index: idx, records };
}
async function psDeleteKeys(keys){
  for(let i = 0; i < keys.length; i += 50){
    const { error } = await sb.from('app_data').delete().in('key', keys.slice(i, i + 50).map(id => 'priceRecord_' + id));
    if(error) throw error;
  }
}
// 還原備份:備份檔有 priceData 才覆蓋(舊版備份沒有這個欄位,就維持目前的 Price Setting 與售價紀錄不動)
async function psRestoreFromBackup(backup){
  const d = backup && backup.priceData;
  if(!d || typeof d !== 'object') return;
  const oldIdx = await psLoadIndex(true);
  const recs = Array.isArray(d.records) ? d.records.filter(r => r && r.id && Array.isArray(r.items)) : [];
  const keep = new Set(recs.map(r => r.id));
  await psDeleteKeys(oldIdx.map(m => m.id).filter(id => !keep.has(id)));
  for(const r of recs) await dbSet('priceRecord_' + r.id, JSON.stringify(r));
  const idx = (Array.isArray(d.index) ? d.index : []).filter(m => m && keep.has(m.id));
  await dbSet('priceRecordIndex', JSON.stringify(idx));
  const ps = (d.priceSettings && typeof d.priceSettings === 'object') ? d.priceSettings : {};
  const mm = (d.batchMarginManual && typeof d.batchMarginManual === 'object') ? d.batchMarginManual : {};
  await dbSet('priceSettings', JSON.stringify(ps));
  await dbSet('batchMarginManual', JSON.stringify(mm));
  psRecordIndex = idx; spPriceMap = {}; spManualMargins = {}; psDraft = {};
  Object.keys(ps).forEach(k => { const v = Number(ps[k]); if(Number.isFinite(v) && v >= 0) spPriceMap[k] = v; });
  Object.keys(mm).forEach(k => { const v = Number(mm[k]); if(Number.isFinite(v)) spManualMargins[k] = v; });
}
// 清除全部資料:Price Setting 價格、批次 margin 記錄、售價紀錄全部清空
async function psClearAll(){
  const idx = await psLoadIndex(true);
  await psDeleteKeys(idx.map(m => m.id));
  await dbSet('priceRecordIndex', '[]');
  await dbSet('priceSettings', '{}');
  await dbSet('batchMarginManual', '{}');
  psRecordIndex = []; spPriceMap = {}; spManualMargins = {}; psDraft = {};
}

// ============================================================
// 系統設置 → 資料維護 → 匯入資料:Price setting 範本下載 / 匯入
// 範本欄位:SKU、Name、Price(Sell price)。匯入以 SKU 對應商品(Name 只供對照,不用來比對);
// Price 空白 = 不動;有填就覆蓋 Price Setting 的價格,並新增一筆售價紀錄(類型:檔案匯入)。
// ============================================================
function psDownloadTemplate(){
  if(typeof XLSX === 'undefined'){ showInfoModal(t('psImportNoXlsx')); return; }
  const rows = psSortProducts(psAllProducts()).map(p => [p.sku || '', p.name || '', spSettingPrice(p.id) === null ? '' : spSettingPrice(p.id)]);
  const ws = XLSX.utils.aoa_to_sheet([['SKU', 'Name', 'Price'], ...rows]);
  ws['!cols'] = [{ wch: 16 }, { wch: 40 }, { wch: 12 }];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const guide = [['欄位 / Column', '說明 / Notes'],
    ['SKU', '必填。用 SKU 對應系統裡的商品(Name 只供對照,不用來比對)。 / Required. Matches products by SKU (Name is for reference only).'],
    ['Name', '商品名稱,僅供對照。 / Product name, reference only.'],
    ['Price', 'Sell price(單價)。空白 = 不動;填數字 = 覆蓋 Price Setting 的價格。 / Sell price per unit. Blank = unchanged; a number overwrites the Price Setting price.']];
  const wsG = XLSX.utils.aoa_to_sheet(guide); wsG['!cols'] = [{ wch: 16 }, { wch: 100 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Price');
  XLSX.utils.book_append_sheet(wb, wsG, 'Guide');
  XLSX.writeFile(wb, `price_setting_template_${todayISO()}.xlsx`);
}
function psReadFileRows(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read'));
    r.onload = e => {
      try{
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        resolve(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }));
      }catch(err){ reject(err); }
    };
    r.readAsArrayBuffer(file);
  });
}
async function psImportFiles(files){
  const msg = document.getElementById('priceImportMsg');
  const say = (txt, cls) => { if(msg){ msg.className = 'msg ' + (cls || ''); msg.textContent = txt; } };
  if(typeof XLSX === 'undefined'){ say(t('psImportNoXlsx'), 'error'); return; }
  if(!canEditPrice()){ say(t('psNoEditPermission'), 'error'); return; }
  say(t('psImportParsing'));
  const bySku = new Map();
  (products || []).forEach(p => { const k = String(p.sku || '').trim().toLowerCase(); if(k && !bySku.has(k)) bySku.set(k, p); });
  const updates = {};     // 商品id -> 價格
  const problems = [];
  let okRows = 0;
  for(const f of files){
    let rows;
    try{ rows = await psReadFileRows(f); }catch(e){ problems.push(`${f.name}: ${t('psImportReadFail')}`); continue; }
    if(!rows || rows.length === 0){ problems.push(`${f.name}: ${t('psImportEmpty')}`); continue; }
    const head = rows[0];
    const cSku = findColumnIndex(head, ['SKU', '商品編號', '貨號']);
    const cPrice = findColumnIndex(head, ['Price', 'Sell price', 'SellPrice', '價格', '售價']);
    if(cSku === -1 || cPrice === -1){ problems.push(`${f.name}: ${t('psImportNoColumns')}`); continue; }
    for(let i = 1; i < rows.length; i++){
      const row = rows[i] || [];
      const sku = String(row[cSku] == null ? '' : row[cSku]).trim();
      const raw = row[cPrice];
      if(!sku && (raw === null || raw === '')) continue;
      if(raw === null || raw === undefined || String(raw).trim() === '') continue;           // 價格空白 = 不動
      const p = bySku.get(sku.toLowerCase());
      if(!p){ problems.push(`${f.name} #${i + 1}: ${tf('psImportSkuUnknown', { sku })}`); continue; }
      const n = Number(String(raw).replace(/[$,\s]/g, ''));
      if(!Number.isFinite(n) || n < 0){ problems.push(`${f.name} #${i + 1}: ${tf('psImportBadPrice', { sku, v: raw })}`); continue; }
      updates[p.id] = spRound2(n); okRows++;
    }
  }
  const changed = Object.keys(updates).filter(pid => spSettingPrice(pid) !== updates[pid]);
  const problemText = problems.length ? '\n' + problems.slice(0, 15).join('\n') + (problems.length > 15 ? '\n… (+' + (problems.length - 15) + ')' : '') : '';
  if(changed.length === 0){ say(t('psImportNothing') + problemText, problems.length ? 'error' : ''); return; }
  say('');
  showConfirmModal(tf('psImportConfirm', { n: changed.length, skipped: problems.length }) + (spIsSettingBasis() ? '' : '\n\n' + t('psImportBasisNote')), async () => {
    try{
      const next = Object.assign({}, spPriceMap);
      changed.forEach(pid => { next[pid] = updates[pid]; });
      await psSavePriceMap(next, 'import', files.map(f => f.name).join(', '));
      say(tf('psImportDone', { n: changed.length }) + problemText, 'ok');
      try{ if(typeof psRenderPage === 'function') psRenderPage(); }catch(e){}
      try{ if(typeof renderAll === 'function') renderAll(); }catch(e){}
    }catch(e){ console.error('匯入 Price setting 失敗', e); say(t('spMarginSaveFailed'), 'error'); }
  });
}
