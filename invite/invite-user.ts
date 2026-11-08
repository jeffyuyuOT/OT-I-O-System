import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Orange Tea AU 庫存系統:寄出「邀請 / 設定密碼」email。
//
// 前端(使用者管理 → 邀請使用者 / 編輯使用者 → 寄出邀請)用 sb.functions.invoke('invite-user', ...) 呼叫。
// 這支函式用 service role 做三件事(前端本身沒有權限做):
//   1. 驗證呼叫的人是管理者(或有「使用者管理」權限)。
//   2. 建立新的登入帳號,或把「現有帳號」換成真正的 email(合併:profile id 不變,所以原本的
//      出貨/進貨/訂單等所有紀錄都還在),並把舊密碼作廢,密碼以對方自己設定的為主。
//   3. 產生一次性連結,用 Resend 以「Orange Tea Australia」名義寄給對方。
// 連結指向 App 本身(?token_hash=...&type=invite|recovery),App 會先顯示「設定密碼」頁面,
// 設好密碼才進登入狀態。用 token_hash 而不是 Supabase 預設連結,是因為有些信箱/聊天軟體會
// 先「預覽」連結導致一次性連結失效,token_hash 版本要等 App 頁面自己去驗證才會用掉。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_ADDRESS = "Orange Tea Australia <noreply@orangetea.com.au>";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function cors(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors() });
}
function esc(s: string) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function randomPassword() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function findAuthUserByEmail(email: string) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 1000) break;
  }
  return null;
}

function canManageUsers(profile: any) {
  if (!profile) return false;
  if (profile.role === "admin") return true;
  const tabs = Array.isArray(profile.tab_permissions) ? profile.tab_permissions : [];
  const restricted = Array.isArray(profile.restricted_capabilities) ? profile.restricted_capabilities : [];
  return tabs.includes("tab-master") && !restricted.includes("cap-manage-users");
}

async function pickUsernameAndRole(email: string, body: any) {
  const base = email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "") || "user";
  let username = base;
  for (let i = 2; i < 100; i++) {
    const { data: clash } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
    if (!clash) break;
    username = base + i;
  }
  const role = ["admin", "accountant", "sales", "order", "inventory"].includes(body.role) ? body.role : "order";
  return { username, role };
}
async function newProfileRow(userId: string, email: string, body: any, firstName: string, lastName: string, username?: string, role?: string) {
  if (!username || !role) ({ username, role } = await pickUsernameAndRole(email, body));
  return {
    id: userId,
    username,
    role,
    email,
    first_name: firstName || null,
    last_name: lastName || null,
    tab_permissions: Array.isArray(body.tabPermissions) ? body.tabPermissions : [],
    restricted_capabilities: Array.isArray(body.restrictedCapabilities) ? body.restrictedCapabilities : [],
    assigned_party_ids: Array.isArray(body.assignedPartyIds) && body.assignedPartyIds.length ? body.assignedPartyIds : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  try {
    // 1. 驗證呼叫者
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
    if (callerErr || !callerData?.user) return json({ error: "Not signed in" }, 401);
    const { data: callerProfile } = await admin.from("profiles").select("*").eq("id", callerData.user.id).maybeSingle();
    if (!canManageUsers(callerProfile)) return json({ error: "Not allowed" }, 403);

    const body = await req.json();

    // 刪除使用者:連登入帳號一起清掉(前端只能刪 profile,登入帳號要 service role)。
    if (body.action === "delete") {
      const targetId = String(body.userId || "");
      if (!targetId) return json({ error: "Missing userId" }, 400);
      if (targetId === callerData.user.id) return json({ error: "Cannot delete the signed-in account" }, 400);
      await admin.from("profiles").delete().eq("id", targetId);
      const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
      // 登入帳號本來就不存在(例如之前刪過)不算失敗
      if (delErr && !/not found|user_not_found/i.test(String((delErr as any).message || "") + String((delErr as any).code || ""))) {
        return json({ error: "Could not delete the login account: " + delErr.message }, 500);
      }
      return json({ ok: true, deleted: targetId });
    }

    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not configured" }, 500);
    const email = String(body.email || "").trim().toLowerCase();
    const appUrl = String(body.appUrl || "").replace(/[?#].*$/, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email address" }, 400);
    if (!/^https?:\/\//.test(appUrl)) return json({ error: "Missing appUrl" }, 400);
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const mergeUserId: string | null = body.mergeUserId || null;

    let userId: string;
    let linkType: "invite" | "recovery";
    let isNew = false;
    let neverSignedIn = false;

    const existingByEmail = await findAuthUserByEmail(email);

    const alreadyLinked = !!(mergeUserId && existingByEmail && existingByEmail.id === mergeUserId);

    if (mergeUserId && !alreadyLinked) {
      // ---- 合併:把現有帳號換成真正的 email ----
      const { data: targetProfile } = await admin.from("profiles").select("*").eq("id", mergeUserId).maybeSingle();
      if (!targetProfile) return json({ error: "Existing user not found" }, 404);
      if (existingByEmail && existingByEmail.id !== mergeUserId) {
        // 這個 email 已經被另一個帳號用了。只有「從來沒登入過的邀請帳號」才能被併掉,
        // 登入過的帳號可能已經有資料,不自動刪除。
        if (existingByEmail.last_sign_in_at) {
          return json({ error: "This email already belongs to an active user who has signed in. Remove that account first." }, 409);
        }
        await admin.from("profiles").delete().eq("id", existingByEmail.id);
        const { error: delErr } = await admin.auth.admin.deleteUser(existingByEmail.id);
        if (delErr) return json({ error: "Could not remove the pending invited account: " + delErr.message }, 500);
      }
      const { error: updErr } = await admin.auth.admin.updateUserById(mergeUserId, {
        email,
        email_confirm: true,
        password: randomPassword(), // 舊密碼作廢,以對方自己設定的為主
      });
      if (updErr) return json({ error: updErr.message }, 500);
      userId = mergeUserId;
      linkType = "recovery";
      const patch: Record<string, unknown> = { email };
      if (firstName) patch.first_name = firstName;
      if (lastName) patch.last_name = lastName;
      await admin.from("profiles").update(patch).eq("id", userId);
    } else if (existingByEmail) {
      // ---- 這個 email 已經有帳號:重寄邀請(沒登入過)或重設密碼連結(已登入過) ----
      userId = existingByEmail.id;
      // generateLink(type:"invite") 對「已確認」的帳號會回 "A user with this email address has already been
      // registered"。所以只有「還沒確認 email、也沒登入過」的帳號才用 invite;其餘(包含點過邀請連結但
      // 還沒設好密碼、或合併時已設為確認的帳號)一律用 recovery 連結。
      const confirmed = !!((existingByEmail as any).email_confirmed_at || (existingByEmail as any).confirmed_at);
      linkType = (existingByEmail.last_sign_in_at || confirmed) ? "recovery" : "invite";
      neverSignedIn = !existingByEmail.last_sign_in_at;
      const patch: Record<string, unknown> = { email };
      if (firstName) patch.first_name = firstName;
      if (lastName) patch.last_name = lastName;
      const { data: hasProfile } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
      if (hasProfile) {
        await admin.from("profiles").update(patch).eq("id", userId);
      } else {
        // 登入帳號存在、但 profile 不見了(例如之前在使用者管理刪掉使用者、登入帳號卻留著):重建 profile,
        // 否則對方設好密碼登入時會顯示「這個帳號還沒有設定權限」,使用者管理也看不到這個人。
        const { error: pErr } = await admin.from("profiles").upsert(await newProfileRow(userId, email, body, firstName, lastName));
        if (pErr) return json({ error: "Profile save failed: " + pErr.message }, 500);
      }
    } else {
      // ---- 全新帳號 ----
      isNew = true;
      linkType = "invite";
      const { username, role } = await pickUsernameAndRole(email, body);
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        email_confirm: false,
        password: randomPassword(),
        user_metadata: { username, role },
      });
      if (createErr || !created?.user) return json({ error: createErr?.message || "Could not create user" }, 500);
      userId = created.user.id;
      const { error: profErr } = await admin.from("profiles").upsert(await newProfileRow(userId, email, body, firstName, lastName, username, role));
      if (profErr) return json({ error: "Profile save failed: " + profErr.message }, 500);
    }

    // 2. 產生一次性連結(token_hash 版本)
    let { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: linkType === "invite" ? "invite" : "recovery",
      email,
    } as any);
    if (linkErr && linkType === "invite" && /already been registered|email_exists/i.test(String((linkErr as any).message || "") + String((linkErr as any).code || ""))) {
      // 保險:帳號其實已確認,invite 不能用 → 改發 recovery 連結
      linkType = "recovery";
      neverSignedIn = true;
      ({ data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email } as any));
    }
    if (linkErr || !linkData?.properties?.hashed_token) {
      return json({ error: linkErr?.message || "Could not generate link" }, 500);
    }
    const link = `${appUrl}?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=${linkType}`;

    // 3. 用 Resend 寄出
    const name = [firstName, lastName].filter(Boolean).join(" ");
    const greeting = name ? `Hi ${esc(name)},` : "Hi,";
    const intro = (mergeUserId && !alreadyLinked)
      ? "Your Orange Tea AU Inventory &amp; Order Hub account has been linked to this email address. Please set a password to continue."
      : (linkType === "invite" || neverSignedIn)
        ? "You have been invited to the Orange Tea AU Inventory &amp; Order Hub. Please set a password to get started."
        : "Use the button below to set a new password for the Orange Tea AU Inventory &amp; Order Hub.";
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1e1e1b;">
        <h2 style="color:#e8751a;margin:0 0 12px;">Orange Tea AU</h2>
        <p>${greeting}</p>
        <p>${intro}</p>
        <p style="margin:24px 0;">
          <a href="${esc(link)}" style="background:#e8751a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block;">Set your password</a>
        </p>
        <p style="font-size:12px;color:#666;">This link can only be used once and expires after a short time. If it has expired, ask your administrator to send a new invitation.<br>After setting your password, sign in with this email address.</p>
        <p style="font-size:12px;color:#666;">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(link)}</span></p>
      </div>`;
    const subject = linkType === "invite" || neverSignedIn || (mergeUserId && !alreadyLinked)
      ? "Set up your Orange Tea AU Inventory & Order Hub account"
      : "Reset your Orange Tea AU Inventory & Order Hub password";
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [email], subject, html }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Resend API error:", resp.status, detail);
      return json({ error: "Email sending failed", detail }, 502);
    }
    return json({ ok: true, userId, isNew, merged: !!(mergeUserId && !alreadyLinked) });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});