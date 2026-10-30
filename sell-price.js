// ============================================================
// Sell price(售價)
//
// 批次的 Total price(進貨底價 + 分攤的其他支出)× (1 + margin%) = Sell price。
// - margin 是「每個批次」一個數字(batches.margin_pct),新批次建立時先帶入預設值(系統預設 margin,
//   app_data 'batchDefaultMargin'),之後可以在批次頁手動改;沒設定過的舊批次用目前的預設值。
// - 訂單商品的售價 = 用到的批次 Sell price 依用量加權平均 × (1 − 出貨方 Discount%)。
// - 「訂單顯示 Sell price」開關(系統設置,app_data 'showSellPrice')決定新增訂單 / 待處理訂單 / 已完成訂單
//   要不要顯示售價;批次頁的 margin / Sell price 不受這個開關影響。
// 依賴:batch-tracking.js(批次資料與分配預覽)。
// ============================================================
let spShowSellPrice = false;
let spDefaultMarginPct = 0;

async function loadSellPriceSettings(){
  try{
    const r = await dbGet('showSellPrice');
    spShowSellPrice = !!(r && String(r.value) === 'true');
  } catch(e){}
  try{
    const r = await dbGet('batchDefaultMargin');
    const n = r && r.value !== undefined && r.value !== null ? Number(r.value) : NaN;
    if(Number.isFinite(n) && n >= 0) spDefaultMarginPct = n;
  } catch(e){}
}
function spDefaultMargin(){ return spDefaultMarginPct; }
// 要不要在訂單畫面顯示售價(開關打開、而且批次追蹤可用)
function spEnabled(){ return spShowSellPrice && typeof batchActive === 'function' && batchActive(); }

function spRound2(n){ return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function spMarginOf(item){
  const m = item && item.marginPct;
  return (m === null || m === undefined || !Number.isFinite(Number(m))) ? spDefaultMarginPct : Number(m);
}
// 這個批次商品行的 Total price(單價)/ Sell price(單價);沒有成本資料回傳 null
function spTotalUnit(item){
  const c = (typeof batchUnitCost === 'function') ? batchUnitCost(item) : null;
  return (c === null || c === undefined || !Number.isFinite(Number(c))) ? null : Number(c);
}
function spSellUnit(item){
  const c = spTotalUnit(item);
  return c === null ? null : spRound2(c * (1 + spMarginOf(item) / 100));
}
function spMoney(n){ return (n === null || n === undefined) ? '–' : ((typeof batchFmtMoney === 'function') ? batchFmtMoney(n) : spRound2(n).toFixed(2)); }

// ---- 批次頁:margin 與預設值 ----
async function spSaveBatchMargin(batchId, raw){
  const v = String(raw).trim();
  const n = Number(v);
  if(v === '' || !Number.isFinite(n) || n < 0 || n > 1000){ showInfoModal(t('spMarginInvalid')); renderBatchTracker(); return; }
  try{
    await batchRpc('batch_set_margin', { p_batch_id: batchId, p_margin: n, p_only_if_null: false });
    batchData.items.forEach(i => { if(i.batchId === batchId) i.marginPct = n; });
  } catch(e){
    console.error('儲存 margin 失敗', e);
    showInfoModal(/batch_set_margin|margin_pct/i.test((e && e.message) || '') ? t('spMarginNeedSql') : t('spMarginSaveFailed'));
  }
  renderBatchTracker();
}
function spOpenDefaultMarginModal(){
  const old = document.getElementById('spDefaultMarginOverlay'); if(old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'spDefaultMarginOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  ov.innerHTML = `<div class="modal-box" style="max-width:min(420px,92vw);">
    <div class="section-title" style="margin-top:0;">${t('spDefaultMarginTitle')}</div>
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 10px;">${t('spDefaultMarginHint')}</p>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;"><input id="spDefaultMarginInput" type="number" min="0" step="any" value="${spDefaultMarginPct}" style="width:110px;" /><span>%</span></div>
    <div id="spDefaultMarginMsg" class="msg"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('spDefaultMarginOverlay').remove()">${t('btnCancel')}</button><button class="btn" onclick="spSaveDefaultMargin()">${t('btnSave')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}
async function spSaveDefaultMargin(){
  const el = document.getElementById('spDefaultMarginInput'), msg = document.getElementById('spDefaultMarginMsg');
  const n = Number(el.value);
  if(el.value.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1000){ msg.className = 'msg error'; msg.textContent = t('spMarginInvalid'); return; }
  spDefaultMarginPct = n;
  try{ await dbSet('batchDefaultMargin', String(n)); } catch(e){ console.error('儲存預設 margin 失敗', e); msg.className = 'msg error'; msg.textContent = t('spMarginSaveFailed'); return; }
  document.getElementById('spDefaultMarginOverlay').remove();
  renderBatchTracker();
}

// ---- 單價欄:顯示 Total price,點擊看 Base price / 其他支出分攤 / Total price / Margin / Sell price ----
function spPriceCellHtml(i){
  const total = spTotalUnit(i);
  if(total === null) return '–';
  return `<span class="batch-link" title="${batchEsc(t('spPriceClickHint'))}" onclick="spShowPricePopup('${i.id}')">${spMoney(total)}</span>`;
}
function spShowPricePopup(itemId){
  const i = batchData.items.find(x => x.id === itemId);
  if(!i) return;
  const old = document.getElementById('spPriceOverlay'); if(old) old.remove();
  const base = (i.unitCostBase === null || i.unitCostBase === undefined) ? null : Number(i.unitCostBase);
  const total = spTotalUnit(i);
  const extra = (total !== null && base !== null) ? total - base : null;
  const margin = spMarginOf(i);
  const ov = document.createElement('div');
  ov.id = 'spPriceOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  ov.onclick = e => { if(e.target === ov) ov.remove(); };
  const row = (label, val, strong) => `<tr><td>${label}</td><td class="num" ${strong ? 'style="font-weight:700;"' : ''}>${val}</td></tr>`;
  ov.innerHTML = `<div class="modal-box" style="max-width:min(420px,92vw);">
    <div class="section-title" style="margin-top:0;">${batchEsc(batchProductName(i.productId))} · ${batchEsc(i.batchNo)}</div>
    <table class="stock-table"><tbody>
      ${row(t('spBasePrice'), spMoney(base))}
      ${row(t('spExtraCosts'), extra === null ? '–' : spMoney(extra))}
      ${row(t('spTotalPrice'), spMoney(total), true)}
      ${row('Margin', margin + '%')}
      ${row('Sell price', spMoney(spSellUnit(i)), true)}
    </tbody></table>
    <p style="font-size:11.5px;color:var(--ink-soft);margin:8px 0 0;">Sell price = Total price × (1 + Margin%)</p>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('spPriceOverlay').remove()">${t('btnClose')}</button></div>
  </div>`;
  document.body.appendChild(ov);
}

// ---- 系統設置:訂單顯示 Sell price ----
function renderSellPriceSetting(){
  const box = document.getElementById('showSellPriceToggle');
  if(box) box.checked = spShowSellPrice;
  const card = document.getElementById('sellPriceSettingCard');
  if(card) card.style.display = (typeof batchFeatureOn === 'function' && batchFeatureOn()) ? '' : 'none';
}
async function applyShowSellPrice(checked){
  spShowSellPrice = !!checked;
  try{ await dbSet('showSellPrice', checked ? 'true' : 'false'); } catch(e){ console.error('儲存失敗', e); }
  try{ if(typeof renderAll === 'function') renderAll(); }catch(e){}
}
