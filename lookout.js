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
  { id: 'verify', icon: '✅', titleKey: 'lookoutVerify', descKey: 'lookoutVerifyDesc', tab: 'tab-warehouse-ops',
    show: function(){ return typeof canVerifyOrders === 'function' && canVerifyOrders(); },
    go: function(){
      switchTab('tab-warehouse-ops');
      switchWarehouseOpsSubTab('subtab-tx-verify');
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
  { id: 'tx-log', icon: '🧾', titleKey: 'lookoutTxLog', descKey: 'lookoutTxLogDesc', tab: 'tab-log',
    go: function(){
      switchTab('tab-log');
      switchLogSubTab('subtab-log-tx');
    } }
];

function lookoutVisibleCards(){
  return LOOKOUT_CARDS.filter(function(c){
    if(!lookoutTabAllowed(c.tab)) return false;
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
