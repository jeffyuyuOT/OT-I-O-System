// ============================================================
// 分頁定義(TAB_DEFS,含每個分頁底下的細項權限 capability)、
// 使用者帳號/身分權限——登入/登出、角色預設可看分頁、
// 使用者管理分頁(新增/編輯/刪除使用者、勾選分頁權限)。
// 分頁定義本身(TAB_DEFS)雖然畫分頁列(renderTabBar,還留在主程式)
// 也會用到,但它主要是拿來做權限判斷的資料結構,所以放在這裡。
// ============================================================
// ===== 分頁定義 =====

const TAB_DEFS = [
  { id: 'tab-master', labelKey: 'tabMaster' },
  { id: 'tab-warehouse-ops', labelKey: 'tabWarehouseOps' },
  { id: 'tab-overview', labelKey: 'tabOverview' },
  { id: 'tab-order', labelKey: 'tabOrder' },
  { id: 'tab-order-admin', labelKey: 'secOrderAdmin' },
  { id: 'tab-warehouse-admin', labelKey: 'tabWarehouseAdmin' },
  { id: 'tab-log', labelKey: 'tabLog' }
];

// ===== 使用者帳號 / 身分權限 =====

const ROLE_DEFS = [
  { id: 'admin', labelKey: 'roleAdmin' },
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
  { id: 'cap-edit-price', parentTab: null, labelKey: 'capEditPrice', special: 'price' }
];

// 「編輯價錢」權限(存在 restricted_capabilities 這個既有欄位裡,不用改資料表):
//   · 清單裡有 'allow:cap-edit-price' → 允許(管理者以外的人要被明確勾選才有)
//   · 管理者預設允許,除非清單裡有 'deny:cap-edit-price'(被明確取消勾選)
//   · 其他人(含倉庫管理員)預設不允許:只能看價錢,不能改
function canEditPriceFor(role, restrictedList){
  const list = Array.isArray(restrictedList) ? restrictedList : [];
  if(list.includes('allow:cap-edit-price')) return true;
  return role === 'admin' && !list.includes('deny:cap-edit-price');
}
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
  order: ['tab-order'],
  inventory: ['tab-warehouse-ops', 'tab-overview', 'tab-order-admin', 'tab-warehouse-admin', 'tab-log']
};

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
  return {
    id: authUser.id,
    username: data.username,
    role: data.role,
    tabPermissions: Array.isArray(data.tab_permissions) ? data.tab_permissions : [],
    assignedPartyIds: Array.isArray(data.assigned_party_ids) ? data.assigned_party_ids : [],
    restrictedCapabilities: Array.isArray(data.restricted_capabilities) ? data.restricted_capabilities : [],
    firstName: data.first_name || '',
    lastName: data.last_name || '',
    email: data.email || ''
  };
}

// 預設每個功能都允許,只有出現在 restrictedCapabilities 清單裡才會被擋下。
function hasCapability(capId){
  if(!currentUser) return false;
  if(capId === 'cap-edit-price') return canEditPrice();
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
    tabPermissions: Array.isArray(row.tab_permissions) ? row.tab_permissions : [],
    assignedPartyIds: Array.isArray(row.assigned_party_ids) ? row.assigned_party_ids : [],
    restrictedCapabilities: Array.isArray(row.restricted_capabilities) ? row.restricted_capabilities : [],
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

function capabilityCheckboxesHtml(userId, tabPermissions, restrictedCapabilities, role){
  const relevant = CAPABILITY_DEFS.filter(c => !c.parentTab || tabPermissions.includes(c.parentTab));
  if(relevant.length === 0) return '';
  return `
    <div class="field-block">
      <label>${t('fieldCapabilities')}</label>
      <div class="field-hint">${t('capabilitiesHint')}</div>
      <div class="user-perm-checks">
        ${relevant.map(c => {
          const checked = c.special === 'price' ? canEditPriceFor(role, restrictedCapabilities) : !restrictedCapabilities.includes(c.id);
          return `
          <label style="display:flex;align-items:flex-start;gap:6px;max-width:100%;">
            <input type="checkbox" data-cap-id="${c.id}" id="modalCap_${userId}_${c.id}" ${checked ? 'checked' : ''} />
            <span>${t(c.labelKey)}</span>
          </label>`;
        }).join('')}
      </div>
    </div>
  `;
}

// 從細部功能權限區塊讀出目前要存的 restricted_capabilities 清單:
// 一般功能是「沒勾 = 被限制」;「編輯價錢」是 allow:/deny: 標記(見 canEditPriceFor)。
function collectRestrictedCapabilities(capsWrap){
  if(!capsWrap) return [];
  const out = [];
  capsWrap.querySelectorAll('input[type="checkbox"]').forEach(el => {
    const def = CAPABILITY_DEFS.find(c => c.id === el.dataset.capId);
    if(def && def.special === 'price'){
      out.push(el.checked ? 'allow:cap-edit-price' : 'deny:cap-edit-price');
    } else if(!el.checked){
      out.push(el.dataset.capId);
    }
  });
  return out;
}

function renderUserEditModalBody(u){
  const tabPermissions = u.tabPermissions || [];
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
      <div class="user-perm-checks" id="modalTabPerms">${tabPermCheckboxesHtml('modalPerm_' + u.id, tabPermissions)}</div>
    </div>
    <div id="modalCapabilitiesWrap">${capabilityCheckboxesHtml(u.id, tabPermissions, restrictedCapabilities, u.role)}</div>
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
  const box = document.getElementById('modalTabPerms');
  if(box) box.innerHTML = tabPermCheckboxesHtml('modalPerm_' + userId, perms);
  const capsWrap = document.getElementById('modalCapabilitiesWrap');
  if(capsWrap) capsWrap.innerHTML = capabilityCheckboxesHtml(userId, perms, [], role); // 換身分 → 細部權限(含編輯價錢)回到該身分的預設值
  attachModalTabPermListeners(userId);
}

// 分頁勾選一改變,細部功能權限清單也要跟著增減(因為某個功能是掛在某個分頁底下的)。
function attachModalTabPermListeners(userId){
  const box = document.getElementById('modalTabPerms');
  if(!box) return;
  box.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const currentPerms = collectCheckedTabIds('modalPerm_' + userId);
      const capsWrap = document.getElementById('modalCapabilitiesWrap');
      if(capsWrap){
        // 保留使用者目前已經勾好的功能狀態,只是重新決定要顯示哪些功能區塊
        const roleNow = document.getElementById('modalUserRole').value;
        capsWrap.innerHTML = capabilityCheckboxesHtml(userId, currentPerms, collectRestrictedCapabilities(capsWrap), roleNow);
      }
    });
  });
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
  showConfirmModal(`確定要移除使用者「${u.username}」的權限嗎?(這只會移除他在這個 App 的權限資料,若要完全刪除登入帳號,還要到 Supabase 後台的 Authentication → Users 一併刪除)`, async () => {
    const { error } = await sb.from('profiles').delete().eq('id', userId);
    const msg = document.getElementById('userMsg');
    if(error){
      msg.className = 'msg error';
      msg.textContent = '刪除失敗:' + error.message;
      return;
    }
    users = users.filter(x => x.id !== userId);
    msg.className = 'msg ok';
    msg.textContent = `✓ 已移除使用者「${u.username}」的權限`;
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
    restrictedCapabilities: [], // 編輯價錢:管理者預設允許、其他身分預設不允許(見 canEditPriceFor)
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

function showSetPasswordState(state){
  document.getElementById('setPasswordChecking').style.display = state === 'checking' ? '' : 'none';
  document.getElementById('setPasswordForm').style.display = state === 'ready' ? '' : 'none';
  document.getElementById('setPasswordInvalid').style.display = state === 'invalid' ? '' : 'none';
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
