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
  { id: 'cap-manage-users', parentTab: 'tab-master', labelKey: 'capManageUsers' }
];

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
    restrictedCapabilities: Array.isArray(data.restricted_capabilities) ? data.restricted_capabilities : []
  };
}

// 預設每個功能都允許,只有出現在 restrictedCapabilities 清單裡才會被擋下。
function hasCapability(capId){
  if(!currentUser) return false;
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
    restrictedCapabilities: Array.isArray(row.restricted_capabilities) ? row.restricted_capabilities : []
  }));
}

function renderCurrentUserBadge(){
  const el = document.getElementById('currentUserBadge');
  if(!el || !currentUser) return;
  const roleDef = ROLE_DEFS.find(r => r.id === currentUser.role);
  const roleLabel = roleDef ? t(roleDef.labelKey) : currentUser.role;
  el.textContent = `${currentUser.username}(${roleLabel})`;
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

  const { data, error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
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

function renderUsersTab(){
  const container = document.getElementById('usersTable');
  if(!container) return;
  if(users.length === 0){
    container.innerHTML = `<div class="empty-note">${t('noUsersYet')}</div>`;
    return;
  }
  const partyNameById = id => { const sp = shippingParties.find(x => x.id === id); return sp ? sp.name : id; };
  container.innerHTML = `
    <table class="users">
      <thead>
        <tr>
          <th>${t('loginUsername')}</th>
          <th>${t('userRole')}</th>
          <th>${t('userTabPermDesc')}</th>
          <th>${t('colRestrictedParty')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${users.map(u => {
          const roleDef = ROLE_DEFS.find(r => r.id === u.role);
          const partyIds = Array.isArray(u.assignedPartyIds) ? u.assignedPartyIds : [];
          return `
          <tr>
            <td class="u-name">${(u.username||'').replace(/</g,'&lt;')}</td>
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

function capabilityCheckboxesHtml(userId, tabPermissions, restrictedCapabilities){
  const relevant = CAPABILITY_DEFS.filter(c => tabPermissions.includes(c.parentTab));
  if(relevant.length === 0) return '';
  return `
    <div class="field-block">
      <label>${t('fieldCapabilities')}</label>
      <div class="field-hint">${t('capabilitiesHint')}</div>
      <div class="user-perm-checks">
        ${relevant.map(c => `
          <label style="display:flex;align-items:flex-start;gap:6px;max-width:100%;">
            <input type="checkbox" data-cap-id="${c.id}" id="modalCap_${userId}_${c.id}" ${restrictedCapabilities.includes(c.id) ? '' : 'checked'} />
            <span>${t(c.labelKey)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `;
}

function renderUserEditModalBody(u){
  const tabPermissions = u.tabPermissions || [];
  const restrictedCapabilities = u.restrictedCapabilities || [];
  const partyIds = u.assignedPartyIds || [];
  return `
    <div class="field-block">
      <label>${t('loginUsername')}</label>
      <input type="text" value="${(u.username||'').replace(/"/g,'&quot;')}" disabled title="${t('usernameDisabledTitle')}" style="width:100%;" />
    </div>
    <div class="field-block">
      <label>${t('userRole')}</label>
      <select id="modalUserRole" onchange="onModalRoleChange('${u.id}')"></select>
    </div>
    <div class="field-block">
      <label>${t('userTabPermDesc')}</label>
      <div class="user-perm-checks" id="modalTabPerms">${tabPermCheckboxesHtml('modalPerm_' + u.id, tabPermissions)}</div>
    </div>
    <div id="modalCapabilitiesWrap">${capabilityCheckboxesHtml(u.id, tabPermissions, restrictedCapabilities)}</div>
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
  document.getElementById('userEditModalTitle').textContent = `${t('editUserModalTitlePrefix')} — ${u.username}`;
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
  if(capsWrap) capsWrap.innerHTML = capabilityCheckboxesHtml(userId, perms, []);
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
        const currentlyUnchecked = Array.from(capsWrap.querySelectorAll('input[type="checkbox"]:not(:checked)')).map(el => el.dataset.capId);
        capsWrap.innerHTML = capabilityCheckboxesHtml(userId, currentPerms, currentlyUnchecked);
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
  const restrictedCapabilities = capsWrap
    ? Array.from(capsWrap.querySelectorAll('input[type="checkbox"]:not(:checked)')).map(el => el.dataset.capId)
    : [];
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

  const { error } = await sb.from('profiles').update({
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
