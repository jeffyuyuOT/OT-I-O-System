// ============================================================
// 分頁導覽——分頁排序(拖曳調整順序、存進資料庫)、畫分頁列
// (renderTabBar)、手機版選單首頁、切換主分頁(switchTab)跟
// 各主分頁底下的子分頁切換(switchXxxSubTab 系列)。
// ============================================================
// ===== 分頁排序 =====
// 邏輯跟分類排序(categoryOrder)一樣:存一份分頁 id 的順序陣列,存進資料庫,
// 畫分頁列時依這個順序排;新加入系統的分頁(TAB_DEFS 有但 tabOrder 還沒有的)自動補到最後。
function syncTabOrder(){
  const allIds = TAB_DEFS.map(d => d.id);
  if(!Array.isArray(tabOrder)) tabOrder = [];
  tabOrder = tabOrder.filter(id => allIds.includes(id));
  allIds.forEach(id => { if(!tabOrder.includes(id)) tabOrder.push(id); });
}

async function saveTabOrder(){
  try{ await dbSet('tabOrder', JSON.stringify(tabOrder)); }
  catch(e){ console.error('儲存分頁順序失敗', e); }
}

async function loadTabOrder(){
  try{
    const r = await dbGet('tabOrder');
    if(r && r.value){
      const stored = JSON.parse(r.value);
      if(Array.isArray(stored) && stored.length > 0) tabOrder = stored;
    }
  } catch(e){ /* 還沒存過順序,維持預設 */ }
  syncTabOrder();
}

function toggleTabOrderPanel(){
  const panel = document.getElementById('tabOrderPanel');
  if(!panel) return;
  if(panel.style.display === 'none'){
    syncTabOrder();
    renderTabOrderPanel();
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
  }
}

function renderTabOrderPanel(){
  const panel = document.getElementById('tabOrderPanel');
  if(!panel) return;
  panel.innerHTML = `
    <div class="cat-order-panel">
      <p style="font-size:12px;color:var(--ink-soft);margin:0 0 10px;">${t('tabOrderPanelDesc')}</p>
      ${tabOrder.map((id, i) => {
        const def = TAB_DEFS.find(d => d.id === id);
        if(!def) return '';
        return `
        <div class="cat-order-row">
          <span class="cat-order-name">${t(def.labelKey)}</span>
          <button onclick="moveTabOrder(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="${t('titleMoveUp')}">↑</button>
          <button onclick="moveTabOrder(${i}, 1)" ${i === tabOrder.length - 1 ? 'disabled' : ''} title="${t('titleMoveDown')}">↓</button>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

async function moveTabOrder(index, direction){
  const target = index + direction;
  if(target < 0 || target >= tabOrder.length) return;
  [tabOrder[index], tabOrder[target]] = [tabOrder[target], tabOrder[index]];
  await saveTabOrder();
  renderTabOrderPanel();
  renderTabBar();
}


// 依 TAB_DEFS 的固定順序畫出分頁按鈕列(僅依使用者權限篩選可見分頁)。
function renderTabBar(){
  const bar = document.getElementById('tabBar');
  if(!bar) return;
  const activeContent = document.querySelector('.tab-content.active-tab');
  const activeTabId = activeContent ? activeContent.id : null;
  const allowed = getCurrentUserTabPermissions();
  syncTabOrder();
  const visibleIds = tabOrder.filter(id => allowed.includes(id));
  bar.innerHTML = visibleIds.map(id => {
    const def = TAB_DEFS.find(d => d.id === id);
    if(!def) return '';
    return `<button class="tab-btn ${id === activeTabId ? 'active' : ''}" onclick="switchTab('${id}')" id="btn-${id}">${t(def.labelKey)}</button>`;
  }).join('');
  // 如果目前分頁不在使用者權限內(例如剛登入,或權限被調整了),自動切到第一個看得到的分頁
  if(visibleIds.length > 0 && !visibleIds.includes(activeTabId)){
    switchTab(visibleIds[0]);
  }
  renderMobileHomeMenu(visibleIds);
}

// 手機版「選單首頁」:把每個看得到的分頁變成一個一個大按鍵(顏色輪流用一組固定色盤,同一個分頁
// 每次顏色都一樣,方便使用者記憶),點了才切換進去那個分頁、同時關閉選單畫面。跟桌面版分頁列
// 共用同一份「使用者看得到哪些分頁」的清單(renderTabBar 呼叫時一併重畫),不用另外維護。
const MOBILE_MENU_COLORS = ['#2E75B6', '#C0392B', '#1F8A70', '#B8860B', '#6C5CE7', '#D2691E', '#008080', '#8E44AD'];
function renderMobileHomeMenu(visibleIds){
  const container = document.getElementById('mobileHomeMenu');
  if(!container) return;
  container.innerHTML = visibleIds.map((id, idx) => {
    const def = TAB_DEFS.find(d => d.id === id);
    if(!def) return '';
    const color = MOBILE_MENU_COLORS[idx % MOBILE_MENU_COLORS.length];
    return `<button class="mobile-menu-btn" style="background:${color};" onclick="selectMobileMenuTab('${id}')">${t(def.labelKey)}</button>`;
  }).join('');
}

// 從選單點一個分頁按鍵進去:正常切分頁,並關掉選單畫面。如果這個分頁底下有子分頁,
// 先只顯示子分頁按鍵、不顯示任何子分頁內容(見 mobile-subtab-menu-active),
// 等使用者點了某個子分頁按鍵才進去看那個子分頁的內容(在 switchXSubTab 那幾個函式裡切換到
// mobile-subtab-content-active,同時把子分頁按鍵本身也藏起來,見 CSS)。
// 沒有子分頁的分頁(例如庫存總覽)則直接顯示內容,沒有這個中間步驟。
function selectMobileMenuTab(tabId){
  document.body.classList.remove('mobile-menu-active');
  document.body.classList.remove('mobile-subtab-content-active');
  switchTab(tabId);
  const tabEl = document.getElementById(tabId);
  const hasSubtabs = !!(tabEl && tabEl.querySelector('.subtab-bar'));
  document.body.classList.toggle('mobile-subtab-menu-active', hasSubtabs);
}

// 手機版標頭的 🏠 按鈕:每按一次只退「一層」,不是每次都直接跳回最上層的選單首頁——
// 如果目前正在看某個子分頁的內容,先退回「子分頁選單」畫面(只看得到子分頁按鍵);
// 如果已經在子分頁選單、或這個分頁本來就沒有子分頁,才退到最上層的選單首頁。
// 直接算「看得到哪些分頁」重畫選單,不透過 renderTabBar()(它在權限跟目前分頁對不上時會自動
// 呼叫 switchTab,那樣反而會把剛蓋上去的選單又關掉)。
// 如果這個帳號本來就只看得到一個分頁(例如只有「訂貨」權限的訂貨用戶),不會有「只有一個按鍵
// 可選」的選單首頁這一層——退到底最多就是那個分頁自己的子分頁選單(如果有的話),
// 沒有子分頁的話就已經沒有更上層可退了,這時再按 🏠 不會有動作。
// 判斷目前是不是手機版寬度(跟 CSS 的 @media (max-width:768px) 用同一個斷點),給那些
// 「手機版要彈出視窗顯示、桌面版維持原本畫面內文字」的地方共用,不用每個地方各自重複判斷。
function isMobileViewport(){
  return window.matchMedia('(max-width:768px)').matches;
}

function showMobileHomeMenu(){
  const allowed = getCurrentUserTabPermissions();
  syncTabOrder();
  const visibleIds = tabOrder.filter(id => allowed.includes(id));

  if(document.body.classList.contains('mobile-subtab-content-active')){
    document.body.classList.remove('mobile-subtab-content-active');
    if(visibleIds.length === 1){
      const tabEl = document.getElementById(visibleIds[0]);
      const hasSubtabs = !!(tabEl && tabEl.querySelector('.subtab-bar'));
      if(hasSubtabs) document.body.classList.add('mobile-subtab-menu-active');
      // 沒有子分頁的話,這個分頁的內容本身就已經是最上層了,不用切去任何選單畫面
    } else {
      document.body.classList.add('mobile-subtab-menu-active');
    }
    return;
  }
  if(visibleIds.length === 1) return; // 只有一個分頁可選,已經在最上層了,🏠 不用再做任何事
  document.body.classList.add('mobile-menu-active');
  document.body.classList.remove('mobile-subtab-menu-active');
  renderMobileHomeMenu(visibleIds);
}

// 目前登入使用者可以看到的分頁 id 清單;沒有登入資訊時(理論上不會發生,防呆用)預設全部開放。
// 管理者(admin)這個身分,不管存檔裡的 tabPermissions 寫了什麼,一律直接給全部分頁——管理者
// 本來就該什麼都看得到,沒有理由讓管理者自己的帳號被一份可能過時的權限清單卡住看不到新分頁
// (這也是這次「倉庫作業台/倉庫後台管理」上線後,管理者帳號一度看不到新分頁的根本解法,比
// 下面「補新分頁」那個做法更直接、更不會有漏網之魚)。
// 非管理者身分(訂貨用戶、倉庫管理員)還是照存檔的 tabPermissions 走,但一樣要處理「存檔在
// 新分頁出現之前」的情況:只要是這個帳號的身分(role)原本預設就會給的分頁,但存檔的清單裡
// 沒有,視為「這個權限選項在存檔當下還不存在」,自動補進去,不會因為系統加了新分頁就讓舊
// 帳號的權限清單顯得比實際應該的還要窄。真的被管理者手動拿掉的分頁(角色預設沒有的),
// 不會被這裡補回來。
function getCurrentUserTabPermissions(){
  if(currentUser && currentUser.role === 'admin') return TAB_DEFS.map(d => d.id);
  if(currentUser && Array.isArray(currentUser.tabPermissions)){
    const roleDefaults = ROLE_DEFAULT_TABS[currentUser.role] || [];
    const allIds = TAB_DEFS.map(d => d.id);
    const missingNewTabs = roleDefaults.filter(id => allIds.includes(id) && !currentUser.tabPermissions.includes(id));
    return missingNewTabs.length > 0 ? [...currentUser.tabPermissions, ...missingNewTabs] : currentUser.tabPermissions;
  }
  return TAB_DEFS.map(d => d.id);
}

// 一登入(不管是剛輸入密碼,還是重新整理後自動恢復連線)就先把畫面上原本寫死顯示的
// tab-master 換成使用者實際看得到的第一個分頁,避免資料還在載入時先閃一下商品主檔。
function showOnlyAllowedTabImmediately(){
  const allowed = getCurrentUserTabPermissions();
  const visibleIds = TAB_DEFS.map(d => d.id).filter(id => allowed.includes(id));
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active-tab'));
  const firstId = visibleIds[0];
  if(firstId){
    const el = document.getElementById(firstId);
    if(el) el.classList.add('active-tab');
  }
}

function switchTab(tabId){
  const allowed = getCurrentUserTabPermissions();
  if(!allowed.includes(tabId)) return; // 防呆:使用者沒有這個分頁的權限
  document.body.classList.remove('mobile-menu-active'); // 不管從哪裡觸發切分頁,都順便關掉手機版選單畫面(如果有開著的話)
  if(tabId !== 'tab-order' && addingItemsToOrderId){
    // 使用者在「幫既有訂單新增商品」流程中途跑去別的分頁,視同放棄這次新增
    addingItemsToOrderId = null;
    orderQtyDraft = {};
    orderItemNoteDraft = {};
    const partySelect = document.getElementById('orderParty');
    if(partySelect) partySelect.disabled = false;
    const banner = document.getElementById('addToOrderBanner');
    if(banner) banner.style.display = 'none';
  }
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active-tab'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(tabId).classList.add('active-tab');
  const btn = document.getElementById('btn-' + tabId);
  if(btn) btn.classList.add('active');

  // some browsers don't reliably reflect <select> option updates made while the tab was
  // display:none, so re-render whichever tab just became visible
  if(tabId === 'tab-overview'){ populateCategoryDropdowns(); renderStockCards(); }
  if(tabId === 'tab-log'){ renderLog(); }
  if(tabId === 'tab-warehouse-ops'){ renderProductSelect(); renderTxBatchList(); }
  if(tabId === 'tab-order'){
    populatePartySelect(); renderOrderItemsTable(); renderOrderHistory();
    const cartSection = document.getElementById('orderCartSection');
    const formSection = document.getElementById('orderFormSection');
    if(cartSection && formSection){ cartSection.style.display = 'none'; formSection.style.display = ''; }
  }
  if(tabId === 'tab-order-admin'){
    populatePendingOrderPartyFilter(); renderPendingOrders();
    populateCompletedOrderPartyFilter(); renderOrders();
  }
  if(tabId === 'tab-warehouse-admin'){
    renderPartiesTable(); renderForecastTable(); populateExportPartySelect();
    renderSupplierManagementTable(); renderOcrDbProductSelect();
    // 「管理出貨方」子分頁需要 cap-manage-parties 這個權限才看得到——沒有這個權限的話,
    // 那個按鈕整個藏起來,而且如果剛好停在那個子分頁上,要導回第一個子分頁(出貨方管理
    // 這個按鈕本身就是要藏的目標,所以導去下一個「進貨方管理」)。
    const partiesBtn = document.getElementById('btn-subtab-order-parties');
    if(partiesBtn) partiesBtn.style.display = hasCapability('cap-manage-parties') ? '' : 'none';
    if(!hasCapability('cap-manage-parties')) switchWarehouseAdminSubTab('subtab-purchase-mgmt-suppliers');
    // 「收據掃描數據庫」是收據掃描模組(receipt-scan-module.js,選配)的一部分——沒有這個模組的話,
    // 這個按鈕整個藏起來,理由跟上面「管理出貨方」一樣:模組沒帶,底下的功能(掃描比對記憶表)
    // 根本沒有意義存在,藏起來比留著一個點了也沒用的按鈕清楚。
    const ocrDbBtn = document.getElementById('btn-subtab-purchase-mgmt-ocrdb');
    if(ocrDbBtn) ocrDbBtn.style.display = hasFeature('receiptScanModule') ? '' : 'none';
    if(!hasFeature('receiptScanModule')) switchWarehouseAdminSubTab('subtab-purchase-mgmt-suppliers');
  }
  if(tabId === 'tab-master'){
    loadUsers().then(renderUsersTab);
    const usersBtn = document.getElementById('btn-subtab-sys-users');
    if(usersBtn) usersBtn.style.display = hasCapability('cap-manage-users') ? '' : 'none';
    if(!hasCapability('cap-manage-users')) switchSystemSubTab('subtab-sys-settings');
  }
}


// 訂貨後台管理分頁(tab-order-admin)自己的子分頁切換,只在它自己的容器裡找
// .subtab-content/.subtab-btn,不會動到其他分頁(系統管理、庫存管理)那幾組子分頁的顯示狀態
// (幾組子分頁共用同一套 CSS class,但各自獨立)。
function switchOrderAdminSubTab(subtabId){
  if(subtabId === 'subtab-order-parties' && !hasCapability('cap-manage-parties')) return;
  const container = document.getElementById('tab-order-admin');
  if(!container) return;
  document.body.classList.remove('mobile-subtab-menu-active'); // 手機版:點了子分頁按鍵,離開「只顯示子分頁按鍵」的狀態
  document.body.classList.add('mobile-subtab-content-active'); // 改成「顯示內容、隱藏子分頁按鍵」的狀態
  container.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active-subtab'));
  container.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(subtabId).classList.add('active-subtab');
  document.getElementById('btn-' + subtabId).classList.add('active');
}

// 系統管理分頁(tab-master)自己的子分頁切換,只在它自己的容器裡找 .subtab-content/.subtab-btn,
// 不會動到其他分頁那幾組子分頁的顯示狀態(共用同一套 CSS class,但各自獨立)。
function switchSystemSubTab(subtabId){
  if(subtabId === 'subtab-sys-users' && !hasCapability('cap-manage-users')) return;
  const container = document.getElementById('tab-master');
  if(!container) return;
  document.body.classList.remove('mobile-subtab-menu-active');
  document.body.classList.add('mobile-subtab-content-active');
  container.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active-subtab'));
  container.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(subtabId).classList.add('active-subtab');
  document.getElementById('btn-' + subtabId).classList.add('active');
}

// 倉庫作業台分頁(tab-warehouse-ops)自己的子分頁切換,只在它自己的容器裡找 .subtab-content/.subtab-btn,
// 不會動到其他分頁那幾組子分頁的顯示狀態(共用同一套 CSS class,但各自獨立)。
function switchWarehouseOpsSubTab(subtabId){
  const container = document.getElementById('tab-warehouse-ops');
  if(!container) return;
  if(subtabId !== 'subtab-tx-register' && (registerOutFlowType || txBatchItems.length > 0)){
    // 使用者在「登記進出貨」流程中途(選了出貨類型,或已經加了商品到清單)跑去別的子分頁,
    // 視同放棄這次操作,把狀態重設乾淨,避免下次回來時殘留鎖住的出貨方欄位或舊的暫存品項。
    resetRegisterOutFlow();
    setTxOutFlowType('');
  }
  document.body.classList.remove('mobile-subtab-menu-active');
  document.body.classList.add('mobile-subtab-content-active');
  container.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active-subtab'));
  container.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));
  if(subtabId === 'subtab-tx-verify'){ renderVerifyPage(); renderVerifyPageProductSelect(); }
  document.getElementById(subtabId).classList.add('active-subtab');
  document.getElementById('btn-' + subtabId).classList.add('active');
}

// 「倉庫後台管理」底下的子分頁切換(出貨方管理/進貨方管理/進貨預估/資料維護/掃描收據數據庫),
// 只在它自己的容器裡找 .subtab-content/.subtab-btn。
function switchWarehouseAdminSubTab(subtabId){
  const container = document.getElementById('tab-warehouse-admin');
  if(!container) return;
  document.body.classList.remove('mobile-subtab-menu-active');
  document.body.classList.add('mobile-subtab-content-active');
  container.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active-subtab'));
  container.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));
  if(subtabId === 'subtab-order-parties') renderPartiesTable();
  else if(subtabId === 'subtab-purchase-mgmt-suppliers') renderSupplierManagementTable();
  else if(subtabId === 'subtab-tx-forecast') renderForecastTable();
  else if(subtabId === 'subtab-tx-data') populateExportPartySelect();
  else if(subtabId === 'subtab-purchase-mgmt-ocrdb') renderOcrDbProductSelect();
  document.getElementById(subtabId).classList.add('active-subtab');
  document.getElementById('btn-' + subtabId).classList.add('active');
}

// 歷史紀錄分頁(tab-log)自己的子分頁切換(進出貨紀錄/切換紀錄/Delivery Note紀錄/後台紀錄),
// 只在它自己的容器裡找 .subtab-content/.subtab-btn,不會動到其他分頁那幾組子分頁的顯示狀態。
function switchLogSubTab(subtabId){
  const container = document.getElementById('tab-log');
  if(!container) return;
  document.body.classList.remove('mobile-subtab-menu-active');
  document.body.classList.add('mobile-subtab-content-active');
  container.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active-subtab'));
  container.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));
  if(subtabId === 'subtab-log-tx'){ renderLog(); }
  if(subtabId === 'subtab-log-purchases'){ renderPurchaseLog(); }
  if(subtabId === 'subtab-log-convert'){ renderConvertHistoryTable(); }
  if(subtabId === 'subtab-log-inventory'){ loadInventoryLog().then(renderInventoryLog); }
  document.getElementById(subtabId).classList.add('active-subtab');
  document.getElementById('btn-' + subtabId).classList.add('active');
}

// 訂貨分頁(tab-order)自己的子分頁切換(訂貨 / 訂購記錄),只在它自己的容器裡找
// .subtab-content/.subtab-btn,不會動到其他分頁那幾組子分頁的顯示狀態。
function switchOverviewSubTab(subtabId){
  const container = document.getElementById('tab-overview');
  if(!container) return;
  document.body.classList.remove('mobile-subtab-menu-active');
  document.body.classList.add('mobile-subtab-content-active');
  container.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active-subtab'));
  container.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(subtabId).classList.add('active-subtab');
  document.getElementById('btn-' + subtabId).classList.add('active');
  if(subtabId === 'subtab-overview-location'){
    renderStockLocationProductSelect();
  }
}

function switchOrderSubTab(subtabId){
  const container = document.getElementById('tab-order');
  if(!container) return;
  document.body.classList.remove('mobile-subtab-menu-active');
  document.body.classList.add('mobile-subtab-content-active');
  container.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active-subtab'));
  container.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));
  if(subtabId === 'subtab-order-history'){
    renderOrderHistory();
    // 離開訂貨頁面回到訂購記錄:如果「幫既有訂單新增商品」的狀態還沒清掉(例如使用者中途直接
    // 切回訂購記錄、沒有走完購物車流程),順便收尾,恢復出貨方選單、隱藏提示橫幅。
    addingItemsToOrderId = null;
    orderQtyDraft = {};
    orderItemNoteDraft = {};
    const partySelect = document.getElementById('orderParty');
    if(partySelect) partySelect.disabled = false;
    const banner = document.getElementById('addToOrderBanner');
    if(banner) banner.style.display = 'none';
  }
  document.getElementById(subtabId).classList.add('active-subtab');
  document.getElementById('btn-' + subtabId).classList.add('active');
}
