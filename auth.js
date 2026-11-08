// ============================================================
// 分頁定義(TAB_DEFS,含每個分頁底下的細項權限 capability)、
// 使用者帳號/身分權限——登入/登出、角色預設可看分頁、
// 使用者管理分頁(新增/編輯/刪除使用者、勾選分頁權限)。
// 分頁定義本身(TAB_DEFS)雖然畫分頁列(renderTabBar,還留在主程式)
// 也會用到,但它主要是拿來做權限判斷的資料結構,所以放在這裡。
// ============================================================
// ===== 分頁定義 =====

const TAB_DEFS = [
  // Lookout:常用功能快捷入口(卡片),排第一;沒有自己的資料,卡片依其他分頁權限顯示
  { id: 'tab-lookout', labelKey: 'tabLookout' },
  { id: 'tab-master', labelKey: 'tabMaster' },
  { id: 'tab-warehouse-ops', labelKey: 'tabWarehouseOps' },
  { id: 'tab-overview', labelKey: 'tabOverview' },
  { id: 'tab-order', labelKey: 'tabOrder' },
  { id: 'tab-warehouse-admin', labelKey: 'tabWarehouseAdmin' },
  { id: 'tab-log', labelKey: 'tabLog' },
  // 會計:Invoices、定價管理、定價管理紀錄;只有管理者、會計預設看得到
  { id: 'tab-accounting', labelKey: 'tabAccounting' }
];

// ===== 使用者帳號 / 身分權限 =====

const ROLE_DEFS = [
  { id: 'admin', labelKey: 'roleAdmin' },
  { id: 'accountant', labelKey: 'roleAccountant' },
  { id: 'sales', labelKey: 'roleSales' },
  { id: 'order', labelKey: 'roleOrder' },
  { id: 'inventory', labelKey: 'roleInventory' }
];

// 細部功能權限(比「看不看得到分頁」更細):預設每個帳號都「允許」,
// 只有被明確勾掉才會受限。掛在某個分頁底下,那個分頁本身要先勾選,這個設定才有意義。
const CAPABILITY_DEFS = [
  { id: 'cap-manage-parties', parentTab: 'tab-warehouse-admin', labelKey: 'capManageParties' },
  { id: 'cap-edit-overview', parentTab: 'tab-overview', labelKey: 'capEditOverview' },
  { id: 'cap-manage-users', parentTab: 'tab-master', labelKey: 'capManageUsers' },
  // 編輯價錢:不掛在特定分頁底下(進貨單、登記進貨、收據掃描都會用到價錢),所以 parentTab 是 null,
  // 永遠顯示。跟其他細部權限相反,這個是「預設不允許」(管理者預設允許、其他身分預設不允許),
  // 所以不能用「沒被限制=允許」的邏輯,見下面 canEditPriceFor。
  { id: 'cap-edit-price', parentTab: null, labelKey: 'capEditPrice', special: 'price' },
  // 訂單顯示價錢:能不能在訂單畫面(新增訂單/待處理/已完成/登記進出貨)看到單價、金額、GST。會計、管理者預設允許,
  // 其他身分預設不允許(見 canViewPriceFor)。跟「編輯價錢」是兩回事:能看價錢不代表能改。
  { id: 'cap-view-price', parentTab: null, labelKey: 'capViewPrice', special: 'viewprice' },
  // 訂單核對:能不能使用「訂單核對」頁面、把待處理訂單載入核對。除了會計以外預設允許(會計預設不允許,
  // 需要時再個別勾選)。用 allow:/deny: 標記,見 canVerifyOrdersFor。
  { id: 'cap-order-verify', parentTab: 'tab-warehouse-ops', labelKey: 'capOrderVerify', special: 'verify' },
  // 倉庫作業台的子分頁權限(原本「訂貨後台管理」分頁已併進倉庫作業台):預設都允許,取消勾選 = 看不到那個子分頁
  { id: 'cap-tx-register', parentTab: 'tab-warehouse-ops', labelKey: 'capTxRegister' },
  { id: 'cap-orders-pending', parentTab: 'tab-warehouse-ops', labelKey: 'capOrdersPending' },
  { id: 'cap-orders-completed', parentTab: 'tab-warehouse-ops', labelKey: 'capOrdersCompleted' }
];

// 舊版權限遷移(「訂貨後台管理」tab-order-admin 併進倉庫作業台):
// restricted_capabilities 裡沒有 'perm-v2' 標記的帳號,載入時在記憶體裡轉換一次(不改資料庫;
// 管理者在使用者管理按儲存時會寫成新格式並加上標記)——
//   · 原本有 tab-order-admin、沒有 tab-warehouse-ops:給倉庫作業台,但關掉「登記進出貨」「訂單核對」,只留訂單子分頁
//   · 原本有 tab-warehouse-ops、沒有 tab-order-admin:關掉「待處理訂單」「已完成訂單」,維持原本看到的內容
//   · 兩個都有:全部開放
function migratePermsV2(tabPerms, restricted, role){
  const tabs = Array.isArray(tabPerms) ? tabPerms.slice() : [];
  let rc = Array.isArray(restricted) ? restricted.slice() : [];
  if(rc.includes('perm-v2')) return { tabPermissions: tabs.filter(id => id !== 'tab-order-admin'), restrictedCapabilities: rc };
  const hadAdmin = tabs.includes('tab-order-admin');
  const hadOps = tabs.includes('tab-warehouse-ops');
  const out = tabs.filter(id => id !== 'tab-order-admin');
  const add = id => { if(!rc.includes(id)) rc.push(id); };
  if(hadAdmin && !hadOps){
    out.push('tab-warehouse-ops');
    add('cap-tx-register');
    rc = rc.filter(x => x !== 'allow:cap-order-verify'); add('deny:cap-order-verify');
  } else if(hadOps && !hadAdmin){
    add('cap-orders-pending'); add('cap-orders-completed');
  }
  // 舊版「角色預設分頁會自動補進去」的行為,改成在這裡一次補齊;之後(有 perm-v2 標記)存檔的分頁清單就是準的,
  // 管理者在樹狀權限取消勾選的分頁不會再被補回來。
  const allIds = TAB_DEFS.map(d => d.id);
  (ROLE_DEFAULT_TABS[role] || []).forEach(id => { if(allIds.includes(id) && !out.includes(id)) out.push(id); });
  rc.push('perm-v2');
  return { tabPermissions: out, restrictedCapabilities: rc };
}

// 「編輯價錢」權限(存在 restricted_capabilities 這個既有欄位裡,不用改資料表):
//   · 清單裡有 'allow:cap-edit-price' → 允許(管理者以外的人要被明確勾選才有)
//   · 管理者預設允許,除非清單裡有 'deny:cap-edit-price'(被明確取消勾選)
//   · 其他人(含倉庫管理員)預設不允許:只能看價錢,不能改
function canEditPriceFor(role, restrictedList){
  const list = Array.isArray(restrictedList) ? restrictedList : [];
  if(list.includes('allow:cap-edit-price')) return true;
  return (role === 'admin' || role === 'accountant' || role === 'sales') && !list.includes('deny:cap-edit-price');
}
// 「訂單顯示價錢」權限:清單裡有 'allow:cap-view-price' → 允許;管理者、會計預設允許,除非有 'deny:cap-view-price';其他身分預設不允許
function canViewPriceFor(role, restrictedList){
  const list = Array.isArray(restrictedList) ? restrictedList : [];
  if(list.includes('allow:cap-view-price')) return true;
  return (role === 'admin' || role === 'accountant' || role === 'sales') && !list.includes('deny:cap-view-price');
}
// 「訂單核對」權限:'allow:cap-order-verify' → 允許;會計預設不允許;其他身分預設允許,除非有 'deny:cap-order-verify'
function canVerifyOrdersFor(role, restrictedList){
  const list = Array.isArray(restrictedList) ? restrictedList : [];
  if(list.includes('allow:cap-order-verify')) return true;
  if(role === 'accountant' || role === 'sales') return false;
  return !list.includes('deny:cap-order-verify');
}
function canVerifyOrders(){
  return !!currentUser && canVerifyOrdersFor(currentUser.role, currentUser.restrictedCapabilities);
}
function canViewPrice(){
  return !!currentUser && canViewPriceFor(currentUser.role, currentUser.restrictedCapabilities);
}
// 會計(accountant)身分:跟管理者差不多,但不預設帶系統管理分頁(幣種、定價設定、Invoice 格式、匯入資料在「會計」分頁的「會計設定」)
function isAccountantUser(){ return !!currentUser && currentUser.role === 'accountant'; }
// 開 Invoice 的權限:管理者、會計
// 商品視窗的「會計」分頁(GST…)只有會計與管理者看得到;倉管員看不到
function canSeeProductAcct(){ return !!currentUser && (currentUser.role === 'admin' || currentUser.role === 'accountant'); }
// 沒有「訂單顯示價錢」權限的人(倉管員等):批次頁的成本 / 售價 / 庫存價值欄用 CSS 隱藏
function applyCostVisibility(){ try{ document.body.classList.toggle('no-cost-view', !(typeof canViewPrice === 'function' && canViewPrice())); }catch(e){} }
function isInvoiceRole(){ return !!currentUser && (currentUser.role === 'admin' || currentUser.role === 'accountant' || currentUser.role === 'sales'); }
// Invoice 功能的總開關:身分是管理者/會計,而且沒有在系統設置勾選「隱藏 Invoice 功能」
function canCreateInvoice(){ return isInvoiceRole() && !(typeof hideInvoiceEnabled !== 'undefined' && hideInvoiceEnabled); }
function canEditPrice(){
  return !!currentUser && canEditPriceFor(currentUser.role, currentUser.restrictedCapabilities);
}

// 使用者清單/標題上顯示的名字:有填 First/Last name 就用姓名,沒有就用登入帳號。
function userDisplayName(u){
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.username || '';
}

// 各主要身分預設可看的分頁,新增使用者時會依身分帶入,之後可再針對個別帳號自行調整(不受身分限制)。
// 三種身分預設分別是:
//   - 管理者(admin):全部分頁。
//   - 倉庫管理員(inventory):倉庫作業台、庫存總覽、訂貨後台管理、倉庫後台管理、歷史紀錄。
//   - 訂貨用戶(order):只有訂貨分頁。
// 注意:tab-master(系統管理)現在包含使用者管理、商品主檔匯入,以及完整資料備份/還原/還原預設,
// 所以「倉庫管理員」預設不帶這個分頁;如果倉庫管理員也需要這些功能,可以再手動幫個別帳號
// 打開 tab-master,並用上面的 cap-manage-users 限制他們碰不到使用者管理。
const ROLE_DEFAULT_TABS = {
  admin: TAB_DEFS.map(d => d.id),
  accountant: TAB_DEFS.map(d => d.id).filter(id => id !== 'tab-master' && id !== 'tab-order'),   // 不帶訂貨(那是出貨方下單用的頁面;會計從訂貨後台管理看訂單)、不帶系統管理(會計用的設定在「會計」分頁的「會計設定」);倉庫作業台要帶(會計要登記進貨、出貨),但「訂單核對」預設隱藏(cap-order-verify)
  order: ['tab-order'],   // 訂貨用戶只有訂貨分頁(不帶 Lookout)
  sales: ['tab-lookout', 'tab-warehouse-ops', 'tab-warehouse-admin', 'tab-log'],   // 業務(Sales Rep):細到子分頁的限制見 ROLE_DEFAULT_RESTRICTED
  inventory: ['tab-lookout', 'tab-warehouse-ops', 'tab-overview', 'tab-warehouse-admin', 'tab-log']
};
// 新帳號 / 切換身分時的預設細部限制(清單裡的 = 取消勾選)。倉庫管理員:歷史紀錄的「匯出紀錄」預設不開。
// 價錢相關(編輯價錢、訂單顯示價錢)倉庫管理員本來就預設不允許,不用列在這裡。
const ROLE_DEFAULT_RESTRICTED = {
  inventory: ['sub:subtab-log-exports'],
  // 業務(Sales Rep):倉庫作業台全開但沒有「訂單核對」(cap-order-verify 預設不允許);倉庫後台管理只留「供應與清單管理」;
  // 歷史紀錄只留「已完成訂單」「進出貨紀錄」「非銷售出庫單」;全域的編輯價錢、訂單顯示價錢預設允許(見 canEditPriceFor / canViewPriceFor)。
  sales: [
    'sub:subtab-tx-forecast', 'sub:subtab-tx-data', 'sub:subtab-purchase-mgmt-ocrdb',
    'sub:subtab-log-purchases', 'sub:subtab-log-forecast', 'sub:subtab-log-delivery', 'sub:subtab-log-convert',
    'sub:subtab-log-location', 'sub:subtab-log-exports', 'sub:subtab-log-inventory'
  ]
};
function roleDefaultRestricted(role){ return (ROLE_DEFAULT_RESTRICTED[role] || []).slice(); }

// Turn a plain username into the placeholder email Supabase Auth needs.
function usernameToEmail(username){
  return `${username}@${EMAIL_DOMAIN}`;
}
function emailToUsername(email){
  return (email || '').split('@')[0];
}

// Fetch this logged-in person's profile (role + tabPermissions) from Supabase.
async function fetchProfileForUser(authUser){
  const { data, error } = await sb.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
  if(error || !data) return null;
  const mig = migratePermsV2(data.tab_permissions, data.restricted_capabilities, data.role);
  return {
    id: authUser.id,
    username: data.username,
    role: data.role,
    tabPermissions: mig.tabPermissions,
    assignedPartyIds: Array.isArray(data.assigned_party_ids) ? data.assigned_party_ids : [],
    restrictedCapabilities: mig.restrictedCapabilities,
    firstName: data.first_name || '',
    lastName: data.last_name || '',
    email: data.email || ''
  };
}

// 預設每個功能都允許,只有出現在 restrictedCapabilities 清單裡才會被擋下。
function hasCapability(capId){
  if(!currentUser) return false;
  if(capId === 'cap-edit-price') return canEditPrice();
  if(capId === 'cap-view-price') return canViewPrice();
  if(capId === 'cap-order-verify') return canVerifyOrders();
  if(capId === 'cap-manage-users' && (currentUser.role === 'accountant' || currentUser.role === 'sales')) return false;   // 會計不能管理使用者
  if(currentUser.role === 'admin') return true;
  const restricted = Array.isArray(currentUser.restrictedCapabilities) ? currentUser.restrictedCapabilities : [];
  return !restricted.includes(capId);
}

// Load the full account list for the Users tab (admins only see/edit this meaningfully,
// but everyone can read it — enforced by Supabase RLS, not just this JS).
async function loadUsers(){
  const { data, error } = await sb.from('profiles').select('*').order('username');
  if(error){ console.error('讀取使用者清單失敗', error); users = []; return; }
  users = (data || []).map(row => ({
    id: row.id,
    username: row.username,
    role: row.role,
    tabPermissions: migratePermsV2(row.tab_permissions, row.restricted_capabilities, row.role).tabPermissions,
    assignedPartyIds: Array.isArray(row.assigned_party_ids) ? row.assigned_party_ids : [],
    restrictedCapabilities: migratePermsV2(row.tab_permissions, row.restricted_capabilities, row.role).restrictedCapabilities,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || ''
  }));
}

function renderCurrentUserBadge(){
  const el = document.getElementById('currentUserBadge');
  if(!el || !currentUser) return;
  const roleDef = ROLE_DEFS.find(r => r.id === currentUser.role);
  const roleLabel = roleDef ? t(roleDef.labelKey) : currentUser.role;
  el.textContent = `${userDisplayName(currentUser)}(${roleLabel})`;
}

// 標頭那行大標題:訂貨用戶(role='order')登入後改顯示比較短的「Order Hub」版本,不含
// 「Inventory」——因為這種帳號本來就只看得到訂貨相關的分頁,看不到庫存管理的東西,標題寫
// 「Inventory & Order Hub」名不符實。登入畫面(還不知道是誰登入)維持完整版,不受影響。
function updateAppHeaderTitle(){
  const el = document.getElementById('appHeaderTitle');
  if(!el) return;
  el.textContent = (currentUser && currentUser.role === 'order') ? t('appTitleSubtitleOrderOnly') : t('appTitleSubtitle');
}

async function handleLogout(){
  await sb.auth.signOut();
  currentUser = null;
  document.getElementById('appRoot').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginUsernameInput').value = '';
  document.getElementById('loginPasswordInput').value = '';
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginUsernameInput').focus();
}

async function handleLoginSubmit(e){
  if(e) e.preventDefault();
  const username = document.getElementById('loginUsernameInput').value.trim();
  const password = document.getElementById('loginPasswordInput').value;
  const errEl = document.getElementById('loginError');
  const submitBtn = document.querySelector('#loginForm button[type="submit"]');
  if(submitBtn) submitBtn.disabled = true;

  // 可以輸入帳號名稱(舊的方式),也可以直接輸入 Email(被邀請的帳號用 Email 登入)
  const loginEmail = username.includes('@') ? username.toLowerCase() : usernameToEmail(username);
  const { data, error } = await sb.auth.signInWithPassword({ email: loginEmail, password });
  if(error || !data.user){
    errEl.textContent = t('loginErrorBadCredentials');
    errEl.style.display = 'block';
    if(submitBtn) submitBtn.disabled = false;
    return false;
  }
  const profile = await fetchProfileForUser(data.user);
  if(!profile){
    errEl.textContent = t('loginErrorNoProfile');
    errEl.style.display = 'block';
    await sb.auth.signOut();
    if(submitBtn) submitBtn.disabled = false;
    return false;
  }
  errEl.style.display = 'none';
  if(submitBtn) submitBtn.disabled = false;
  currentUser = profile;
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appLoadingOverlay').style.display = 'flex';
  if(typeof applyCostVisibility === 'function') applyCostVisibility();
  showOnlyAllowedTabImmediately();
  await startApp();
  document.getElementById('appLoadingOverlay').style.display = 'none';
  document.getElementById('appRoot').style.display = '';
  return false;
}

// ===== 使用者管理分頁 =====

function tabPermCheckboxesHtml(idPrefix, selectedIds){
  return TAB_DEFS.map(def => `
    <label>
      <input type="checkbox" data-tab-id="${def.id}" id="${idPrefix}_${def.id}" ${selectedIds.includes(def.id) ? 'checked' : ''} />
      ${t(def.labelKey)}
    </label>
  `).join('');
}

function populateRoleSelect(selectEl, selectedRole){
  selectEl.innerHTML = ROLE_DEFS.map(r => `<option value="${r.id}">${t(r.labelKey)}</option>`).join('');
  if(selectedRole) selectEl.value = selectedRole;
}

// 使用者清單的篩選狀態(出貨方 / 身分 / 搜尋)
let userFilterParty = 'all';   // 'all' | 'unassigned'(沒有指定任何出貨方) | 出貨方 id
let userFilterRole = 'all';
let userFilterSearch = '';

function onUserFilterChange(){
  userFilterParty = document.getElementById('userFilterParty').value;
  userFilterRole = document.getElementById('userFilterRole').value;
  userFilterSearch = (document.getElementById('userFilterSearch').value || '').trim().toLowerCase();
  renderUsersTab();
}

function populateUserFilterBar(){
  const partySel = document.getElementById('userFilterParty');
  const roleSel = document.getElementById('userFilterRole');
  if(!partySel || !roleSel) return;
  partySel.innerHTML = `<option value="all">${t('userFilterAllParties')}</option><option value="unassigned">${t('userFilterUnassigned')}</option>` +
    shippingParties.map(sp => `<option value="${sp.id}">${sp.name.replace(/</g,'&lt;')}</option>`).join('');
  if(![...partySel.options].some(o => o.value === userFilterParty)) userFilterParty = 'all';
  partySel.value = userFilterParty;
  roleSel.innerHTML = `<option value="all">${t('userFilterAllRoles')}</option>` + ROLE_DEFS.map(r => `<option value="${r.id}">${t(r.labelKey)}</option>`).join('');
  roleSel.value = userFilterRole;
}

function renderUsersTab(){
  const container = document.getElementById('usersTable');
  if(!container) return;
  populateUserFilterBar();
  if(users.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noUsersYet')}</div>`;
    return;
  }
  const partyNameById = id => { const sp = shippingParties.find(x => x.id === id); return sp ? sp.name : id; };
  const list = users.filter(u => {
    const partyIds = Array.isArray(u.assignedPartyIds) ? u.assignedPartyIds : [];
    if(userFilterParty === 'unassigned' && partyIds.length > 0) return false;
    if(userFilterParty !== 'all' && userFilterParty !== 'unassigned' && !partyIds.includes(userFilterParty)) return false;
    if(userFilterRole !== 'all' && u.role !== userFilterRole) return false;
    if(userFilterSearch){
      const hay = [u.firstName, u.lastName, u.username, u.email].join(' ').toLowerCase();
      if(!hay.includes(userFilterSearch)) return false;
    }
    return true;
  }).sort((a, b) => userDisplayName(a).localeCompare(userDisplayName(b)));
  if(list.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noUsersMatchFilter')}</div>`;
    return;
  }
  container.innerHTML = `
    <table class="users">
      <thead>
        <tr>
          <th>${t('colUserName')}</th>
          <th>${t('userRole')}</th>
          <th>${t('userTabPermDesc')}</th>
          <th>${t('colRestrictedParty')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${list.map(u => {
          const roleDef = ROLE_DEFS.find(r => r.id === u.role);
          const partyIds = Array.isArray(u.assignedPartyIds) ? u.assignedPartyIds : [];
          const hasName = !!(u.firstName || u.lastName);
          const sub = [hasName ? u.username : '', u.email].filter(Boolean).join(' · ');
          return `
          <tr>
            <td class="u-name">${userDisplayName(u).replace(/</g,'&lt;')}${sub ? `<div style="font-size:11px;font-weight:400;color:var(--ink-soft);">${sub.replace(/</g,'&lt;')}</div>` : ''}</td>
            <td class="u-role"><span class="td-mobile-label">${t('userRole')}</span>${roleDef ? t(roleDef.labelKey) : u.role}</td>
            <td class="u-tabs" style="font-size:12px;color:var(--ink-soft);"><span class="td-mobile-label">${t('userTabPermDesc')}</span>${(u.tabPermissions||[]).length} ${t('tabCountSuffix')}</td>
            <td class="u-party" style="font-size:12px;color:var(--ink-soft);"><span class="td-mobile-label">${t('colRestrictedParty')}</span>${partyIds.length === 0 ? t('partyUnrestricted') : partyIds.map(partyNameById).join('、')}</td>
            <td class="u-actions" style="white-space:nowrap;">
              <button class="btn ghost" style="padding:6px 10px;font-size:11px;" onclick="openUserEditModal('${u.id}')">${t('btnEdit')}</button>
              <button class="btn ghost" style="padding:6px 10px;font-size:11px;color:var(--crit);" onclick="deleteUserRow('${u.id}')">${t('btnDelete')}</button>
            </td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
  `;
}

// ---- 編輯使用者:彈出視窗 ----
let editingUserModalId = null;

// 樹狀權限:主分頁(勾選 = 看得到)→ 底下的子分頁 / 細部功能(父分頁沒勾就灰掉不能勾);
// 不屬於任何分頁的功能(編輯價錢、訂單顯示價錢)放在最下面「全域功能」。
// 資料格式沒變:分頁 id 存 tab_permissions,細部功能存 restricted_capabilities(沒勾 = 被限制,
// 編輯價錢 / 顯示價錢 / 訂單核對是 allow:/deny: 標記),另外固定加上 'perm-v2' 標記(見 migratePermsV2)。
function capCheckedFor(c, restrictedCapabilities, role){
  return c.special === 'price' ? canEditPriceFor(role, restrictedCapabilities)
    : (c.special === 'viewprice' ? canViewPriceFor(role, restrictedCapabilities)
    : (c.special === 'verify' ? canVerifyOrdersFor(role, restrictedCapabilities) : !restrictedCapabilities.includes(c.id)));
}
function capRowHtml(userId, c, restrictedCapabilities, role, disabled, depth){
  const label = c.label != null ? c.label : t(c.labelKey);
  return `
    <label style="display:flex;align-items:flex-start;gap:6px;max-width:100%;font-size:12.5px;margin-left:${(depth || 0) * 18}px;${disabled ? 'opacity:.45;' : ''}">
      <input type="checkbox" data-cap-id="${c.id}" id="modalCap_${userId}_${c.id.replace(/[^\w-]/g, '_')}" ${capCheckedFor(c, restrictedCapabilities, role) ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span>${label.replace(/</g, '&lt;')}</span>
    </label>`;
}
// 子分頁 / 下拉選項節點 → 權限列(遞迴,「供應與清單管理」底下的出貨方 / 進貨方 / 快捷清單縮排一層)
function subtabRowsHtml(userId, nodes, restrictedCapabilities, role, disabled, depth){
  return nodes.map(n => {
    const key = subTabPermKey(n.id);
    const def = CAPABILITY_DEFS.find(c => c.id === key) || { id: key };
    return capRowHtml(userId, Object.assign({}, def, { label: n.label }), restrictedCapabilities, role, disabled, depth)
      + subtabRowsHtml(userId, n.children || [], restrictedCapabilities, role, disabled, (depth || 0) + 1);
  }).join('');
}
function countNodes(nodes){ return nodes.reduce((a, n) => a + 1 + countNodes(n.children || []), 0); }
// 主分頁底下的項目:子分頁 / 下拉選項,再加上不是子分頁的細部功能(例如庫存總覽的編輯商品)
function tabKidsHtml(userId, def, restrictedCapabilities, role, disabled){
  const nodes = getTabSubtabNodes(def.id);
  const used = new Set(Object.values(SUBTAB_PERM_KEY_OVERRIDE));
  const extras = CAPABILITY_DEFS.filter(c => c.parentTab === def.id && !used.has(c.id));
  const html = subtabRowsHtml(userId, nodes, restrictedCapabilities, role, disabled, 0)
    + extras.map(c => capRowHtml(userId, c, restrictedCapabilities, role, disabled, 0)).join('');
  return { html, count: countNodes(nodes) + extras.length };
}
function togglePermNode(el){
  const node = el.closest('.perm-node');
  const kids = node && node.querySelector('.perm-kids');
  if(!kids) return;
  const open = kids.style.display === 'none';
  kids.style.display = open ? 'flex' : 'none';
  const arrow = node.querySelector('.perm-arrow');
  if(arrow) arrow.textContent = open ? '▾' : '▸';
}
function permTreeHtml(userId, tabPermissions, restrictedCapabilities, role){
  const tabsHtml = TAB_DEFS.map(def => {
    const on = tabPermissions.includes(def.id);
    const kids = tabKidsHtml(userId, def, restrictedCapabilities, role, !on);
    return `
    <div class="perm-node" style="margin:0 0 8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" data-tab-id="${def.id}" id="modalPerm_${userId}_${def.id}" ${on ? 'checked' : ''} />
        <span style="font-weight:700;${kids.count ? 'cursor:pointer;' : ''}flex:1;user-select:none;" ${kids.count ? 'onclick="togglePermNode(this)"' : ''}>
          ${t(def.labelKey)}${kids.count ? ` <span class="perm-arrow" style="color:var(--ink-soft);font-weight:400;">▸</span> <span style="color:var(--ink-soft);font-weight:400;font-size:11.5px;" class="perm-count">(${kids.count})</span>` : ''}
        </span>
      </div>
      ${kids.count ? `<div class="perm-kids" data-parent-tab="${def.id}" style="display:none;margin:6px 0 2px 22px;padding-left:10px;border-left:2px solid var(--line);flex-direction:column;gap:5px;">
        ${kids.html}
      </div>` : ''}
    </div>`;
  }).join('');
  const globals = CAPABILITY_DEFS.filter(c => !c.parentTab);
  const globalHtml = globals.length ? `
    <div class="perm-node" style="margin:12px 0 0;padding-top:10px;border-top:1px solid var(--line);">
      <div style="font-weight:700;margin-bottom:6px;">${t('permGlobalGroup')}</div>
      <div style="margin-left:22px;display:flex;flex-direction:column;gap:5px;">
        ${globals.map(c => capRowHtml(userId, c, restrictedCapabilities, role, false, 0)).join('')}
      </div>
    </div>` : '';
  return tabsHtml + globalHtml;
}

// 從細部功能權限區塊讀出目前要存的 restricted_capabilities 清單:
// 一般功能是「沒勾 = 被限制」;「編輯價錢」是 allow:/deny: 標記(見 canEditPriceFor)。
function collectRestrictedCapabilities(capsWrap){
  if(!capsWrap) return [];
  const out = [];
  // 父分頁沒勾的細部功能是灰掉的(disabled),不收集(= 預設允許,之後重新勾選分頁時回到預設)
  capsWrap.querySelectorAll('input[data-cap-id]:not(:disabled)').forEach(el => {
    const def = CAPABILITY_DEFS.find(c => c.id === el.dataset.capId);
    if(def && def.special === 'price'){
      out.push(el.checked ? 'allow:cap-edit-price' : 'deny:cap-edit-price');
    } else if(def && def.special === 'viewprice'){
      out.push(el.checked ? 'allow:cap-view-price' : 'deny:cap-view-price');
    } else if(def && def.special === 'verify'){
      out.push(el.checked ? 'allow:cap-order-verify' : 'deny:cap-order-verify');
    } else if(!el.checked){
      out.push(el.dataset.capId);
    }
  });
  out.push('perm-v2');
  return out;
}

function renderUserEditModalBody(u){
  const tabPermissions = u.role === 'admin' ? TAB_DEFS.map(d => d.id) : (u.tabPermissions || []);   // 管理者一律看得到全部分頁
  const restrictedCapabilities = u.restrictedCapabilities || [];
  const partyIds = u.assignedPartyIds || [];
  const q = s => (s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field-block" style="margin:0;">
        <label>${t('fieldFirstName')}</label>
        <input type="text" id="modalUserFirstName" value="${q(u.firstName)}" style="width:100%;" />
      </div>
      <div class="field-block" style="margin:0;">
        <label>${t('fieldLastName')}</label>
        <input type="text" id="modalUserLastName" value="${q(u.lastName)}" style="width:100%;" />
      </div>
    </div>
    <div class="field-hint" style="margin-bottom:12px;">${t('userNameHint')}</div>
    <div class="field-block">
      <label>${t('loginUsername')}</label>
      <input type="text" value="${q(u.username)}" disabled title="${t('usernameDisabledTitle')}" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('fieldUserEmail')}</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input type="email" id="modalUserEmail" value="${q(u.email)}" placeholder="name@example.com" style="flex:1;min-width:200px;" />
        <button type="button" class="btn ghost" id="modalUserInviteBtn" onclick="sendInviteForEditingUser()">${u.email ? t('btnResendInvite') : t('btnSendInviteLink')}</button>
      </div>
      <div class="field-hint">${u.email ? t('userEmailHintLinked') : t('userEmailHintMerge')}</div>
    </div>
    <div class="field-block">
      <label>${t('userRole')}</label>
      <select id="modalUserRole" onchange="onModalRoleChange('${u.id}')"></select>
    </div>
    <div class="field-block">
      <label>${t('userTabPermDesc')}</label>
      <div class="field-hint">${t('permTreeHint')}</div>
      <div id="modalCapabilitiesWrap" style="border:1px solid var(--line);border-radius:6px;padding:12px;background:var(--panel);">${permTreeHtml(u.id, tabPermissions, restrictedCapabilities, u.role)}</div>
    </div>
    <div class="field-block">
      <label>${t('fieldRestrictedParties')}</label>
      <div class="field-hint">${t('restrictedPartiesHint')}</div>
      <div class="user-perm-checks" id="modalPartyChecks">
        ${shippingParties.length === 0 ? `<span style="color:var(--ink-soft);font-size:11px;">${t('noPartiesForUser')}</span>` : shippingParties.map(sp => `
          <label style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;">
            <input type="checkbox" data-party-id="${sp.id}" ${partyIds.includes(sp.id) ? 'checked' : ''} />
            ${sp.name.replace(/"/g,'&quot;')}
          </label>
        `).join('')}
      </div>
    </div>
  `;
}

function openUserEditModal(userId){
  const u = users.find(x => x.id === userId);
  if(!u) return;
  editingUserModalId = userId;
  document.getElementById('userEditModalTitle').textContent = `${t('editUserModalTitlePrefix')} — ${userDisplayName(u)}`;
  document.getElementById('userEditModalBody').innerHTML = renderUserEditModalBody(u);
  document.getElementById('userEditModalMsg').textContent = '';
  populateRoleSelect(document.getElementById('modalUserRole'), u.role);
  attachModalTabPermListeners(userId);
  document.getElementById('userEditModalOverlay').style.display = 'flex';
}

function closeUserEditModal(){
  editingUserModalId = null;
  document.getElementById('userEditModalOverlay').style.display = 'none';
}

// 身分下拉改變時,把分頁勾選重新帶入該身分的預設值,並跟著刷新細部功能權限區塊(因為它取決於目前勾選了哪些分頁)。
function onModalRoleChange(userId){
  const role = document.getElementById('modalUserRole').value;
  const perms = (ROLE_DEFAULT_TABS[role] || []).slice();
  const wrap = document.getElementById('modalCapabilitiesWrap');
  if(wrap) wrap.innerHTML = permTreeHtml(userId, perms, roleDefaultRestricted(role).concat('perm-v2'), role); // 換身分 → 分頁與細部權限(含編輯價錢)回到該身分的預設值
  attachModalTabPermListeners(userId);
}

// 分頁勾選一改變,細部功能權限清單也要跟著增減(因為某個功能是掛在某個分頁底下的)。
// 每個主分頁旁的 (x/y):y = 底下子分頁/選項/細部功能總數,x = 目前勾選的數量(主分頁沒勾 = 全部不能用,x 顯示 0)。
function updatePermCounts(wrap){
  if(!wrap) return;
  wrap.querySelectorAll('.perm-node').forEach(node => {
    const kids = node.querySelector('.perm-kids');
    const badge = node.querySelector('.perm-count');
    if(!kids || !badge) return;
    const boxes = kids.querySelectorAll('input[type="checkbox"]');
    const top = node.querySelector('input[data-tab-id]');
    const on = top ? top.checked : true;
    let x = 0; boxes.forEach(b => { if(on && b.checked) x++; });
    badge.textContent = '(' + x + '/' + boxes.length + ')';
  });
}
function attachModalTabPermListeners(userId){
  const wrap = document.getElementById('modalCapabilitiesWrap');
  if(!wrap) return;
  wrap.querySelectorAll('input[data-tab-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const kids = wrap.querySelector(`.perm-kids[data-parent-tab="${cb.dataset.tabId}"]`);
      if(!kids) return;
      kids.querySelectorAll('input[data-cap-id]').forEach(k => { k.disabled = !cb.checked; k.closest('label').style.opacity = cb.checked ? '' : '.45'; });
    });
  });
  wrap.addEventListener('change', () => updatePermCounts(wrap));
  updatePermCounts(wrap);
}

async function saveUserEditModal(){
  const userId = editingUserModalId;
  if(!userId) return;
  const u = users.find(x => x.id === userId);
  if(!u) return;
  const msg = document.getElementById('userEditModalMsg');
  const role = document.getElementById('modalUserRole').value;
  const tabPermissions = collectCheckedTabIds('modalPerm_' + userId);
  if(tabPermissions.length === 0){
    msg.className = 'msg error';
    msg.textContent = '至少要勾選一個可以看到的分頁';
    return;
  }
  const capsWrap = document.getElementById('modalCapabilitiesWrap');
  const restrictedCapabilities = collectRestrictedCapabilities(capsWrap);
  const wouldStillHaveUserManagement = users.some(x => {
    const role_ = x.id === userId ? role : x.role;
    const perms = x.id === userId ? tabPermissions : x.tabPermissions;
    const restrictedCaps = x.id === userId ? restrictedCapabilities : x.restrictedCapabilities;
    return canManageUsers(role_, perms, restrictedCaps);
  });
  if(!wouldStillHaveUserManagement){
    showInfoModal('至少要留一個帳號能進到「系統管理 → 使用者管理」,不然之後沒有人可以再管理帳號了。');
    return;
  }
  const partyBox = document.getElementById('modalPartyChecks');
  const assignedPartyIds = partyBox
    ? Array.from(partyBox.querySelectorAll('input[type="checkbox"]:checked')).map(el => el.dataset.partyId)
    : [];

  const firstName = (document.getElementById('modalUserFirstName').value || '').trim();
  const lastName = (document.getElementById('modalUserLastName').value || '').trim();
  const { error } = await sb.from('profiles').update({
    first_name: firstName || null,
    last_name: lastName || null,
    role,
    tab_permissions: tabPermissions,
    restricted_capabilities: restrictedCapabilities,
    assigned_party_ids: assignedPartyIds.length ? assignedPartyIds : null
  }).eq('id', userId);
  if(error){
    msg.className = 'msg error';
    msg.textContent = '更新失敗:' + error.message;
    return;
  }
  u.firstName = firstName;
  u.lastName = lastName;
  u.role = role;
  u.tabPermissions = tabPermissions;
  u.restrictedCapabilities = restrictedCapabilities;
  u.assignedPartyIds = assignedPartyIds;
  if(currentUser && currentUser.id === userId){
    currentUser = u;
    renderCurrentUserBadge();
  updateAppHeaderTitle();
    renderTabBar();
  }
  closeUserEditModal();
  renderUsersTab();
}

function collectCheckedTabIds(idPrefix){
  return TAB_DEFS
    .filter(def => {
      const el = document.getElementById(`${idPrefix}_${def.id}`);
      return el && el.checked;
    })
    .map(def => def.id);
}

// 判斷某個帳號(依 role/tabPermissions/restrictedCapabilities)是否真的能進到「系統管理→使用者管理」
// 子分頁操作帳號:admin 一定可以;其他身分要同時「看得到 tab-master 這個分頁」而且「沒有被限制
// cap-manage-users 這個細部功能權限」才算數。
function canManageUsers(role, tabPermissions, restrictedCapabilities){
  if(role === 'admin') return true;
  if(role === 'accountant' || role === 'sales') return false;
  if(!Array.isArray(tabPermissions) || !tabPermissions.includes('tab-master')) return false;
  const restricted = Array.isArray(restrictedCapabilities) ? restrictedCapabilities : [];
  return !restricted.includes('cap-manage-users');
}

// Note: creating a brand-new login account now happens in the Supabase
// Dashboard (Authentication → Users), not here — see supabase_setup.sql
// for the exact steps. Editing an existing account (role / tabs / capabilities
// / supplier restriction) happens via the "編輯" button, which opens a modal
// (see openUserEditModal / saveUserEditModal above).

function deleteUserRow(userId){
  const u = users.find(x => x.id === userId);
  if(!u) return;
  if(currentUser && currentUser.id === userId){
    showInfoModal('不能刪除目前登入中的帳號,請先用別的帳號登入再刪除。');
    return;
  }
  const wouldStillHaveUserManagement = users.some(x => x.id !== userId && canManageUsers(x.role, x.tabPermissions, x.restrictedCapabilities));
  if(!wouldStillHaveUserManagement){
    showInfoModal('至少要留一個帳號能進到「系統管理 → 使用者管理」,不然之後沒有人可以再管理帳號了。');
    return;
  }
  showConfirmModal(`確定要刪除使用者「${u.username}」嗎?(會一併刪除他的登入帳號,刪除後不能復原;他過去的出貨、進貨、訂單紀錄不受影響)`, async () => {
    const msg = document.getElementById('userMsg');
    // 先請 Edge Function 一起刪登入帳號 + profile;函式還是舊版(沒有刪除功能)或失敗時,退回只刪 profile 並提醒
    let loginRemoved = false, fnErr = '';
    try{ await callInviteFunction({ action: 'delete', userId }); loginRemoved = true; }
    catch(e){ fnErr = (e && e.message) || String(e); }
    if(!loginRemoved){
      const { error } = await sb.from('profiles').delete().eq('id', userId);
      if(error){
        msg.className = 'msg error';
        msg.textContent = '刪除失敗:' + error.message;
        return;
      }
    }
    users = users.filter(x => x.id !== userId);
    msg.className = loginRemoved ? 'msg ok' : 'msg error';
    msg.textContent = loginRemoved
      ? `✓ 已刪除使用者「${u.username}」(含登入帳號)`
      : `已移除使用者「${u.username}」的權限資料,但登入帳號沒有刪掉(${fnErr})。請確認 invite-user 函式已更新,或到 Supabase 的 Authentication → Users 手動刪除。`;
    renderUsersTab();
  });
}

// ============================================================
// Email 邀請 / 設定密碼
// ------------------------------------------------------------
// 管理者在「使用者管理」按「邀請使用者」(或在編輯使用者視窗按「寄出邀請」),會呼叫
// Edge Function invite-user(見 invite/invite-user.ts):它用 service role 建立/更新帳號,
// 再以「Orange Tea Australia」名義寄出含一次性連結的 email。連結點開會回到這個 App
// (?token_hash=...&type=invite|recovery),先顯示「設定密碼」頁面,設好密碼才登入。
// 現有帳號(舊的「帳號名稱@inventory.local」那種)可以「合併」:帳號本身不變(所有紀錄都還在),
// 只是登入 email 換成真實 email,舊密碼作廢,密碼以對方自己設定的為主。
// ============================================================

function appBaseUrl(){
  return window.location.origin + window.location.pathname;
}

async function callInviteFunction(payload){
  const { data, error } = await sb.functions.invoke('invite-user', { body: Object.assign({ appUrl: appBaseUrl() }, payload) });
  if(error){
    // functions.invoke 對非 2xx 回應只給泛用訊息,盡量把函式回傳的真正原因拿出來
    let detail = '';
    try{ const j = await error.context.json(); detail = j && j.error ? j.error : ''; } catch(e){}
    throw new Error(detail || error.message || 'Invite failed');
  }
  if(data && data.error) throw new Error(data.error);
  return data;
}

// ---- 編輯使用者視窗裡的「寄出邀請 / 重寄」(把這個現有帳號連到 email) ----
async function sendInviteForEditingUser(){
  const userId = editingUserModalId;
  const u = users.find(x => x.id === userId);
  if(!u) return;
  const msg = document.getElementById('userEditModalMsg');
  const email = (document.getElementById('modalUserEmail').value || '').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ msg.className = 'msg error'; msg.textContent = t('errInvalidEmailAddress'); return; }
  const doSend = async () => {
    const btn = document.getElementById('modalUserInviteBtn');
    if(btn) btn.disabled = true;
    msg.className = 'msg'; msg.textContent = t('sendingEmailMsg');
    try{
      await callInviteFunction({
        email, mergeUserId: userId,
        firstName: (document.getElementById('modalUserFirstName').value || '').trim(),
        lastName: (document.getElementById('modalUserLastName').value || '').trim()
      });
      u.email = email;
      msg.className = 'msg ok'; msg.textContent = tf('inviteSentMsg', { email });
      await loadUsers(); renderUsersTab();
    } catch(e){
      msg.className = 'msg error'; msg.textContent = '⚠ ' + (e.message || '');
    } finally {
      if(btn) btn.disabled = false;
    }
  };
  // 第一次把現有帳號連到 email(合併)會讓舊密碼失效,先跟管理者確認;已經連過、只是重寄就不用問。
  if(u.email && u.email.toLowerCase() === email) await doSend();
  else showConfirmModal(tf('confirmMergeInvite', { name: userDisplayName(u), email }), doSend);
}

// ---- 邀請使用者(新增)視窗 ----
function openUserInviteModal(){
  const body = document.getElementById('userInviteModalBody');
  const mergeOptions = users.map(u => `<option value="${u.id}">${userDisplayName(u).replace(/</g,'&lt;')}${u.email ? ' · ' + u.email.replace(/</g,'&lt;') : ''}</option>`).join('');
  body.innerHTML = `
    <div class="field-block">
      <label>${t('fieldUserEmail')}</label>
      <input type="email" id="inviteEmail" placeholder="name@example.com" style="width:100%;" />
    </div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px;">
      <div class="field-block" style="margin:0;"><label>${t('fieldFirstName')}</label><input type="text" id="inviteFirstName" style="width:100%;" /></div>
      <div class="field-block" style="margin:0;"><label>${t('fieldLastName')}</label><input type="text" id="inviteLastName" style="width:100%;" /></div>
    </div>
    <div class="field-block" style="margin-top:12px;">
      <label>${t('userRole')}</label>
      <select id="inviteRole"></select>
      <div class="field-hint">${t('inviteRoleHint')}</div>
    </div>
    <div class="field-block">
      <label>${t('fieldRestrictedParties')}</label>
      <div class="field-hint">${t('restrictedPartiesHint')}</div>
      <div class="user-perm-checks" id="invitePartyChecks">
        ${shippingParties.length === 0 ? `<span style="color:var(--ink-soft);font-size:11px;">${t('noPartiesForUser')}</span>` : shippingParties.map(sp => `
          <label style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;"><input type="checkbox" data-party-id="${sp.id}" /> ${sp.name.replace(/</g,'&lt;')}</label>`).join('')}
      </div>
    </div>
    <div class="field-block">
      <label>${t('fieldMergeWithExisting')}</label>
      <select id="inviteMergeUser"><option value="">${t('optMergeNone')}</option>${mergeOptions}</select>
      <div class="field-hint">${t('mergeWithExistingHint')}</div>
    </div>`;
  populateRoleSelect(document.getElementById('inviteRole'), 'order');
  document.getElementById('userInviteModalMsg').textContent = '';
  document.getElementById('userInviteModalOverlay').style.display = 'flex';
}
function closeUserInviteModal(){
  document.getElementById('userInviteModalOverlay').style.display = 'none';
}
async function confirmUserInvite(){
  const msg = document.getElementById('userInviteModalMsg');
  const email = (document.getElementById('inviteEmail').value || '').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ msg.className = 'msg error'; msg.textContent = t('errInvalidEmailAddress'); return; }
  const role = document.getElementById('inviteRole').value;
  const mergeUserId = document.getElementById('inviteMergeUser').value || null;
  const payload = {
    email, role, mergeUserId,
    firstName: (document.getElementById('inviteFirstName').value || '').trim(),
    lastName: (document.getElementById('inviteLastName').value || '').trim(),
    tabPermissions: (ROLE_DEFAULT_TABS[role] || []).slice(),
    restrictedCapabilities: roleDefaultRestricted(role).concat('perm-v2'), // 帶 perm-v2 才不會在第一次登入被當成舊帳號重新遷移;價錢權限:管理者預設允許、其他身分預設不允許(見 canEditPriceFor)
    assignedPartyIds: Array.from(document.querySelectorAll('#invitePartyChecks input:checked')).map(el => el.dataset.partyId)
  };
  const btn = document.getElementById('btnConfirmUserInvite');
  const run = async () => {
    if(btn) btn.disabled = true;
    msg.className = 'msg'; msg.textContent = t('sendingEmailMsg');
    try{
      await callInviteFunction(payload);
      msg.className = 'msg ok'; msg.textContent = tf('inviteSentMsg', { email });
      await loadUsers(); renderUsersTab();
      setTimeout(closeUserInviteModal, 1200);
    } catch(e){
      msg.className = 'msg error'; msg.textContent = '⚠ ' + (e.message || '');
    } finally {
      if(btn) btn.disabled = false;
    }
  };
  if(mergeUserId){
    const target = users.find(x => x.id === mergeUserId);
    showConfirmModal(tf('confirmMergeInvite', { name: target ? userDisplayName(target) : '', email }), run);
  } else {
    await run();
  }
}

// ---- 設定密碼頁面(擋在登入頁之前) ----
// 從邀請/重設密碼 email 的連結進來時顯示。連結可能是 ?token_hash=...&type=invite|recovery
// (我們自己寄的信),也可能是 Supabase 預設格式 #access_token=...&type=invite|recovery;
// 過期/已用過的連結會帶 error / error_code。回傳 null 表示這不是 email 連結(正常開啟)。
function detectAuthEmailLink(){
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(window.location.search);
  const type = hashParams.get('type') || searchParams.get('type');
  const linkError = hashParams.get('error') || searchParams.get('error') || hashParams.get('error_code') || searchParams.get('error_code');
  const isLink = (type === 'invite' || type === 'recovery') || !!linkError;
  if(!isLink) return null;
  return { type, tokenHash: searchParams.get('token_hash'), hasHashToken: !!hashParams.get('access_token'), error: !!linkError };
}

// ---- 忘記密碼 / 連結過期後重寄(參照 OT portal 的 ResetEmailForm) ----
// 輸入 email → Supabase 內建的 resetPasswordForEmail:該 email 有帳號就自動寄出設定密碼連結,沒有帳號就不寄。
// Supabase 兩種情況都回「成功」(避免被人探測哪些 email 有帳號),所以訊息用中性說法。
// 連結點開後回到這個 App(#access_token=...&type=recovery),走原本的「設定密碼」頁面。
// 每個 email 每 60 秒只能要一次,所以送出後按鈕鎖 60 秒。
const RESET_COOLDOWN_SECONDS = 60;
let resetCooldownTimer = null;
let resetCooldownLeft = 0;

function renderResetEmailForm(hostId, opts){
  const host = document.getElementById(hostId);
  if(!host) return;
  const o = opts || {};
  const prefill = (o.prefill || '').replace(/"/g, '&quot;');
  host.innerHTML = `
    <form onsubmit="return submitResetEmail(event, '${hostId}')">
      <div id="resetEmailSent_${hostId}" class="msg ok" style="display:none;"></div>
      <div class="field">
        <label>${t('resetEmailLabel')}</label>
        <input type="email" id="resetEmailInput_${hostId}" autocomplete="email" required value="${prefill}" />
      </div>
      <div id="resetEmailError_${hostId}" class="msg error" style="display:none;"></div>
      <button type="submit" class="btn" id="resetEmailBtn_${hostId}" data-label="${o.submitKey || 'btnSendResetEmail'}">${t(o.submitKey || 'btnSendResetEmail')}</button>
      ${o.cancelFn ? `<button type="button" class="btn ghost" style="margin-top:10px;" onclick="${o.cancelFn}">${t('btnBackToSignIn')}</button>` : ''}
    </form>`;
}

function updateResetEmailButton(hostId, sent){
  const btn = document.getElementById('resetEmailBtn_' + hostId);
  if(!btn) return;
  const key = sent ? 'btnSendAgain' : (btn.dataset.label || 'btnSendResetEmail');
  if(resetCooldownLeft > 0){ btn.disabled = true; btn.textContent = t(key) + ' (' + resetCooldownLeft + 's)'; }
  else { btn.disabled = false; btn.textContent = t(key); }
}

function startResetCooldown(hostId, sent){
  resetCooldownLeft = RESET_COOLDOWN_SECONDS;
  if(resetCooldownTimer) clearInterval(resetCooldownTimer);
  updateResetEmailButton(hostId, sent);
  resetCooldownTimer = setInterval(() => {
    resetCooldownLeft--;
    if(resetCooldownLeft <= 0){ clearInterval(resetCooldownTimer); resetCooldownTimer = null; resetCooldownLeft = 0; }
    updateResetEmailButton(hostId, sent);
  }, 1000);
}

async function submitResetEmail(e, hostId){
  if(e) e.preventDefault();
  const emailEl = document.getElementById('resetEmailInput_' + hostId);
  const errEl = document.getElementById('resetEmailError_' + hostId);
  const sentEl = document.getElementById('resetEmailSent_' + hostId);
  const btn = document.getElementById('resetEmailBtn_' + hostId);
  errEl.style.display = 'none';
  const email = (emailEl.value || '').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ errEl.textContent = t('errResetNeedsEmail'); errEl.style.display = 'block'; return false; }
  if(resetCooldownLeft > 0) return false;
  if(btn){ btn.disabled = true; btn.textContent = t('sendingResetMsg'); }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appBaseUrl() });
  if(error){
    if(error.status === 429 || /rate limit|security purposes|too many/i.test(error.message || '')){
      errEl.textContent = t('resetEmailRateLimit');
      errEl.style.display = 'block';
      startResetCooldown(hostId, false);
    } else {
      errEl.textContent = error.message || 'Failed';
      errEl.style.display = 'block';
      if(btn){ btn.disabled = false; btn.textContent = t(btn.dataset.label || 'btnSendResetEmail'); }
    }
    return false;
  }
  sentEl.textContent = tf('resetEmailSent', { email });
  sentEl.style.display = 'block';
  startResetCooldown(hostId, true);
  return false;
}

function showForgotPassword(){
  const emailGuess = (document.getElementById('loginUsernameInput').value || '').trim();
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('forgotPasswordBox').style.display = '';
  renderResetEmailForm('forgotPasswordFormHost', { prefill: /@/.test(emailGuess) ? emailGuess : '', cancelFn: 'hideForgotPassword()' });
}
function hideForgotPassword(){
  document.getElementById('forgotPasswordBox').style.display = 'none';
  document.getElementById('loginForm').style.display = '';
}

function showSetPasswordState(state){
  document.getElementById('setPasswordChecking').style.display = state === 'checking' ? '' : 'none';
  document.getElementById('setPasswordForm').style.display = state === 'ready' ? '' : 'none';
  document.getElementById('setPasswordInvalid').style.display = state === 'invalid' ? '' : 'none';
  if(state === 'invalid') renderResetEmailForm('setPasswordInvalidFormHost', { submitKey: 'btnSendNewLink', cancelFn: 'backToSignInFromSetPassword()' });
  document.getElementById('setPasswordDone').style.display = state === 'done' ? '' : 'none';
}

function clearAuthLinkFromUrl(){
  try{ window.history.replaceState(null, '', window.location.pathname); } catch(e){}
}

async function runSetPasswordFlow(link){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('setPasswordScreen').style.display = 'flex';
  showSetPasswordState('checking');
  if(link.error){ showSetPasswordState('invalid'); return; }
  let ok = false;
  if(link.tokenHash && link.type){
    // 一律先驗證連結本身(會換成連結對應那個人的 session),不要沿用瀏覽器裡原本登入的別人帳號
    const { error } = await sb.auth.verifyOtp({ type: link.type, token_hash: link.tokenHash });
    ok = !error;
  } else if(link.hasHashToken){
    const { data } = await sb.auth.getSession();
    ok = !!(data && data.session);
  }
  showSetPasswordState(ok ? 'ready' : 'invalid');
}

async function handleSetPasswordSubmit(e){
  if(e) e.preventDefault();
  const pw = document.getElementById('setPasswordInput').value;
  const confirm = document.getElementById('setPasswordConfirmInput').value;
  const errEl = document.getElementById('setPasswordError');
  errEl.style.display = 'none';
  if(pw.length < 8){ errEl.textContent = t('errPasswordTooShort'); errEl.style.display = 'block'; return false; }
  if(pw !== confirm){ errEl.textContent = t('errPasswordMismatch'); errEl.style.display = 'block'; return false; }
  const btn = document.getElementById('btnSetPassword');
  if(btn) btn.disabled = true;
  const { error } = await sb.auth.updateUser({ password: pw });
  if(btn) btn.disabled = false;
  if(error){
    errEl.textContent = /session missing/i.test(error.message) ? t('errSetPasswordSessionLost') : error.message;
    errEl.style.display = 'block';
    return false;
  }
  showSetPasswordState('done');
  clearAuthLinkFromUrl();
  // 重新載入:這時瀏覽器已經有登入狀態,開機流程會直接帶他進 App
  setTimeout(() => window.location.reload(), 1500);
  return false;
}

function backToSignInFromSetPassword(){
  clearAuthLinkFromUrl();
  window.location.reload();
}
