// ============================================================
// Lookout 分頁:常用功能的快捷入口(卡片)。
// 每張卡片只是「跳到某個分頁的某個子分頁」;沒有該分頁權限、
// 或該功能沒開(例如批次追蹤)的卡片自動不顯示。
// 要加新的快捷:在 LOOKOUT_CARDS 加一筆(id、icon、titleKey、descKey、
// tab 所需分頁、可選 show() 額外條件、go() 跳轉動作),再到 i18n.js 補中英文字串。
// ============================================================
function lookoutTabAllowed(tabId){
  const allowed = (typeof getCurrentUserTabPermissions === 'function') ? getCurrentUserTabPermissions() : [];
  return allowed.includes(tabId);
}

const LOOKOUT_CARDS = [
  { id: 'new-order', icon: '🛒', titleKey: 'lookoutNewOrder', descKey: 'lookoutNewOrderDesc', tab: 'tab-warehouse-ops',
    go: function(){
      switchTab('tab-warehouse-ops');
      switchWarehouseOpsSubTab('subtab-tx-register');
      setTxType('out');
      const ft = document.getElementById('txOutFlowType');
      if(ft) ft.value = 'new-order';
      setTxOutFlowType('new-order');
    } },
  { id: 'receive', icon: '📥', titleKey: 'lookoutReceive', descKey: 'lookoutReceiveDesc', tab: 'tab-warehouse-ops',
    go: function(){
      switchTab('tab-warehouse-ops');
      switchWarehouseOpsSubTab('subtab-tx-register');
      setTxType('in');
    } },
  { id: 'parties', icon: '🏪', titleKey: 'lookoutParties', descKey: 'lookoutPartiesDesc', tab: 'tab-warehouse-admin',
    show: function(){ return typeof hasCapability === 'function' && hasCapability('cap-manage-parties'); },
    go: function(){
      switchTab('tab-warehouse-admin');
      switchWarehouseAdminSubTab('subtab-order-parties');
    } },
  { id: 'suppliers', icon: '🚚', titleKey: 'lookoutSuppliers', descKey: 'lookoutSuppliersDesc', tab: 'tab-warehouse-admin',
    go: function(){
      switchTab('tab-warehouse-admin');
      switchWarehouseAdminSubTab('subtab-purchase-mgmt-suppliers');
    } },
  { id: 'pending-orders', icon: '📋', titleKey: 'lookoutPending', descKey: 'lookoutPendingDesc', tab: 'tab-order-admin',
    go: function(){
      switchTab('tab-order-admin');
      switchOrderAdminSubTab('subtab-order-pending');
    } },
  { id: 'stock-location', icon: '📍', titleKey: 'lookoutStockLocation', descKey: 'lookoutStockLocationDesc', tab: 'tab-overview',
    go: function(){
      switchTab('tab-overview');
      switchOverviewSubTab('subtab-overview-location');
    } },
  { id: 'batch', icon: '🏷️', titleKey: 'lookoutBatch', descKey: 'lookoutBatchDesc', tab: 'tab-overview',
    show: function(){ return typeof hasFeature === 'function' && hasFeature('batchTracking'); },
    go: function(){
      switchTab('tab-overview');
      switchOverviewSubTab('subtab-overview-batch');
    } },
  { id: 'create-doc', icon: '📄', titleKey: 'subtabAccCreateInvoice', descKey: 'lookoutCreateDocDesc', tab: 'tab-accounting',
    show: function(){ return typeof canCreateInvoice === 'function' && canCreateInvoice(); },
    go: function(){
      switchTab('tab-accounting');
      switchAccountingSubTab('subtab-acc-create-invoice');
    } },
  { id: 'forecast', icon: '🔮', titleKey: 'subtabTxForecast', descKey: 'lookoutForecastDesc', tab: ['tab-warehouse-admin', 'tab-log'],
    go: function(){ lookoutOpenForecastChoice(); } },
  { id: 'tx-log', icon: '🧾', titleKey: 'lookoutTxLog', descKey: 'lookoutTxLogDesc', tab: 'tab-log',
    go: function(){
      switchTab('tab-log');
      switchLogSubTab('subtab-log-tx');
    } }
];

// 卡片順序:系統設置 → 調整分頁順序 → Lookout 展開後可排,存在 subTabOrder['tab-lookout'](key = 'lookout:' + 卡片 id)。
// 存檔裡沒有的新卡片,插在預設順序中它前一張卡片的後面。
function lookoutOrderedCards(){
  const saved = (typeof subTabOrder !== 'undefined' && subTabOrder && Array.isArray(subTabOrder['tab-lookout'])) ? subTabOrder['tab-lookout'] : [];
  const items = LOOKOUT_CARDS.map(function(c){ return { key: 'lookout:' + c.id, card: c }; });
  if(saved.length === 0 || typeof orderSubTabItems !== 'function') return LOOKOUT_CARDS.slice();
  return orderSubTabItems(items, saved).map(function(i){ return i.card; });
}
function lookoutCardKeys(){ return lookoutOrderedCards().map(function(c){ return 'lookout:' + c.id; }); }
function lookoutCardLabel(key){
  const c = LOOKOUT_CARDS.find(function(x){ return 'lookout:' + x.id === key; });
  return c ? t(c.titleKey) : null;
}

function lookoutVisibleCards(){
  return lookoutOrderedCards().filter(function(c){
    const tabs = Array.isArray(c.tab) ? c.tab : [c.tab];
    if(!tabs.some(lookoutTabAllowed)) return false;
    return typeof c.show === 'function' ? !!c.show() : true;
  });
}

function lookoutGo(cardId){
  const c = LOOKOUT_CARDS.find(function(x){ return x.id === cardId; });
  if(!c) return;
  try{ c.go(); }catch(e){ console.error('Lookout 跳轉失敗', cardId, e); }
}

function renderLookout(){
  const root = document.getElementById('lookoutRoot');
  if(!root) return;
  const cards = lookoutVisibleCards();
  if(cards.length === 0){
    root.innerHTML = '<div class="lookout-empty">' + t('lookoutEmpty') + '</div>';
    return;
  }
  root.innerHTML = cards.map(function(c){
    return '<button type="button" class="lookout-card" onclick="lookoutGo(\'' + c.id + '\')">' +
      '<span class="lookout-card-icon">' + c.icon + '</span>' +
      '<span class="lookout-card-body">' +
        '<span class="lookout-card-title">' + t(c.titleKey) + '</span>' +
        '<span class="lookout-card-desc">' + t(c.descKey) + '</span>' +
      '</span>' +
    '</button>';
  }).join('');
}

// 進貨預估:點進去先選「新增進貨預估」(倉庫後台管理 → 進貨預估)或「進貨預估紀錄」(歷史紀錄),
// 沒有對應分頁權限的選項不顯示。
function lookoutOpenForecastChoice(){
  const old = document.getElementById('lookoutForecastOverlay'); if(old) old.remove();
  const opts = [];
  if(lookoutTabAllowed('tab-warehouse-admin')) opts.push({ label: t('lookoutForecastNew'), go: function(){
    switchTab('tab-warehouse-admin');
    switchWarehouseAdminSubTab('subtab-tx-forecast');
  } });
  if(lookoutTabAllowed('tab-log')) opts.push({ label: t('subtabLogForecast'), go: function(){
    switchTab('tab-log');
    switchLogSubTab('subtab-log-forecast');
  } });
  if(opts.length === 0) return;
  window.__lookoutForecastOpts = opts;
  const ov = document.createElement('div');
  ov.id = 'lookoutForecastOverlay'; ov.className = 'modal-overlay'; ov.style.display = 'flex'; ov.style.zIndex = '1150';
  ov.onclick = function(e){ if(e.target === ov) ov.remove(); };
  ov.innerHTML = '<div class="modal-box" style="max-width:min(420px,92vw);">' +
    '<div class="section-title" style="margin-top:0;">' + t('subtabTxForecast') + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:10px;margin-top:6px;">' +
    opts.map(function(o, i){ return '<button class="btn" onclick="lookoutForecastPick(' + i + ')">' + o.label + '</button>'; }).join('') +
    '</div>' +
    '<div class="modal-actions"><button class="btn ghost" onclick="document.getElementById(\'lookoutForecastOverlay\').remove()">' + t('btnCancel') + '</button></div>' +
    '</div>';
  document.body.appendChild(ov);
}
function lookoutForecastPick(i){
  const o = (window.__lookoutForecastOpts || [])[i];
  const ov = document.getElementById('lookoutForecastOverlay'); if(ov) ov.remove();
  if(o) try{ o.go(); }catch(e){ console.error('Lookout 跳轉失敗', e); }
}
