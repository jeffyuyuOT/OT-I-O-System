import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Orange Tea AU 庫存系統:核准「訂貨帳號申請」。
//
// 前端(出貨方管理 → 待審申請 → 核准)先在 App 裡建立或選好對應的出貨方(出貨方資料存在 app_data,
// 不是資料表),再用 sb.functions.invoke('approve-account', { requestId, partyId, appUrl }) 呼叫這支函式。
// 這支函式用 service role 做:
//   1. 驗證呼叫的人是管理者或會計。
//   2. 讀取申請單(必須是 pending)。
//   3. 建立訂貨帳號(role=order,只能看到指定的出貨方),或在上次寄信失敗時重用同一個帳號。
//   4. 產生一次性「設定密碼」連結,用 Resend 寄歡迎信。
//   5. 把申請單標記為 approved。
// 正常部署(開啟 Verify JWT)。需要的 Secrets:RESEND_API_KEY(跟 invite-user 同一把)。

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  try {
    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not configured" }, 500);

    // 1. 驗證呼叫者:管理者或會計
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
    if (callerErr || !callerData?.user) return json({ error: "Not signed in" }, 401);
    const { data: caller } = await admin.from("profiles").select("id,username,email,role").eq("id", callerData.user.id).maybeSingle();
    if (!caller || !["admin", "accountant"].includes(caller.role)) return json({ error: "Not allowed" }, 403);

    const body = await req.json();
    const requestId = String(body.requestId || "");
    const partyId = String(body.partyId || "").trim();
    const appUrl = String(body.appUrl || "").replace(/[?#].*$/, "");
    if (!requestId || !partyId) return json({ error: "Missing requestId or partyId" }, 400);
    if (!/^https?:\/\//.test(appUrl)) return json({ error: "Missing appUrl" }, 400);

    // 2. 申請單
    const { data: reqRow } = await admin.from("account_requests").select("*").eq("id", requestId).maybeSingle();
    if (!reqRow) return json({ error: "Request not found" }, 404);
    if (reqRow.status === "approved") return json({ error: "Request already approved" }, 409);
    if (reqRow.status !== "pending") return json({ error: "Request is not pending (status: " + reqRow.status + ")" }, 409);
    const email = String(reqRow.email).toLowerCase();

    // 3. 建立帳號(或重用上次建立到一半的帳號)
    const existing = await findAuthUserByEmail(email);
    let userId: string;
    let linkType: "invite" | "recovery" = "invite";
    if (existing) {
      if (!(reqRow.user_id && reqRow.user_id === existing.id)) {
        return json({ error: "This email already has an account. Reject this request, or use User Management to give that account access." }, 409);
      }
      userId = existing.id; // 上次建好帳號但寄信失敗:重用,只重寄連結
      const confirmed = !!((existing as any).email_confirmed_at || (existing as any).confirmed_at);
      linkType = (existing.last_sign_in_at || confirmed) ? "recovery" : "invite";
    } else {
      const base = email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "") || "user";
      let username = base;
      for (let i = 2; i < 100; i++) {
        const { data: clash } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
        if (!clash) break;
        username = base + i;
      }
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, email_confirm: false, password: randomPassword(), user_metadata: { username, role: "order" },
      });
      if (createErr || !created?.user) return json({ error: createErr?.message || "Could not create user" }, 500);
      userId = created.user.id;
      const parts = String(reqRow.contact_name || "").trim().split(/\s+/);
      const firstName = parts.shift() || null;
      const lastName = parts.join(" ") || null;
      const { error: profErr } = await admin.from("profiles").upsert({
        id: userId, username, role: "order", email,
        first_name: firstName, last_name: lastName,
        tab_permissions: ["tab-order"], restricted_capabilities: [],
        assigned_party_ids: [partyId],
      });
      if (profErr) {
        await admin.auth.admin.deleteUser(userId);
        return json({ error: "Profile save failed: " + profErr.message }, 500);
      }
    }
    // 先記下帳號 id 和出貨方,寄信失敗時重試才能接著做
    await admin.from("account_requests").update({ user_id: userId, party_id: partyId }).eq("id", requestId);

    // 4. 歡迎信 + 設定密碼連結
    let { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: linkType, email } as any);
    if (linkErr && linkType === "invite" && /already been registered|email_exists/i.test(String((linkErr as any).message || "") + String((linkErr as any).code || ""))) {
      linkType = "recovery";
      ({ data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email } as any));
    }
    if (linkErr || !linkData?.properties?.hashed_token) return json({ error: linkErr?.message || "Could not generate link" }, 500);
    const link = `${appUrl}?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=${linkType}`;

    const first = String(reqRow.contact_name || "").trim().split(/\s+/)[0] || "";
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1e1e1b;">
        <h2 style="color:#e8751a;margin:0 0 12px;">Orange Tea AU</h2>
        <p>Hi ${esc(first)},</p>
        <p>Welcome! Your ordering account for <b>${esc(reqRow.company_name)}</b> has been approved. Please set a password to start ordering.</p>
        <p style="margin:24px 0;"><a href="${esc(link)}" style="background:#e8751a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block;">Set your password</a></p>
        <p style="font-size:12px;color:#666;">This link can only be used once and expires after a short time. If it has expired, use "Forgot password?" on the sign-in page with this email address.<br>After setting your password, sign in with this email address.</p>
        <p style="font-size:12px;color:#666;">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(link)}</span></p>
      </div>`;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [email], subject: "Your Orange Tea AU ordering account is ready", html }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Resend API error:", resp.status, detail);
      return json({ error: "Email sending failed (account was created; press Approve again to resend)", detail }, 502);
    }

    // 5. 標記已核准
    await admin.from("account_requests").update({
      status: "approved", reviewed_by: caller.username || caller.email || "", reviewed_at: new Date().toISOString(),
    }).eq("id", requestId);
    return json({ ok: true, userId });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
