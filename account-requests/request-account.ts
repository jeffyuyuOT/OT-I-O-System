import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Orange Tea AU 庫存系統:客戶線上「申請訂貨帳號」(公開,不需要登入)。
//
// 部署時要關掉 Verify JWT(客戶還沒有帳號):
//   supabase functions deploy request-account --no-verify-jwt
//   (Dashboard:Edge Functions → request-account → 關閉「Verify JWT」)
//
// 需要的 Secrets(Dashboard → Edge Functions → Secrets):
//   RESEND_API_KEY      (跟 invite-user 同一把)
//   APP_URL             App 的網址,例如 https://xxx.workers.dev/ ——確認信的連結只會指向這個網址,
//                       不接受前端傳來的網址,避免有人拿我們的寄件網域寄釣魚連結。
//   TURNSTILE_SECRET    (選填)Cloudflare Turnstile 的 Secret key;有設才會驗證人機。
//
// 兩個動作(body.action):
//   submit  送出申請:驗證欄位 → 限制次數 → 存成 status='unconfirmed' → 寄「確認 Email」連結。
//           沒有點確認連結的申請不會出現在審核清單,3 天後自動清掉。
//   confirm 客戶點確認連結:unconfirmed → pending(進入審核清單)。
// 這裡完全不會建立登入帳號或出貨方,那些只在管理者/會計核准時才建立(approve-account)。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const APP_URL = (Deno.env.get("APP_URL") || "").replace(/[?#].*$/, "");
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET");
const FROM_ADDRESS = "Orange Tea Australia <noreply@orangetea.com.au>";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const LIMIT_IP_PER_HOUR = 5;
const LIMIT_EMAIL_PER_DAY = 3;
const LIMIT_GLOBAL_PER_HOUR = 150;
const CONFIRM_VALID_DAYS = 3;

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
async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
// ABN 檢查碼:11 碼數字,第一碼減 1,依權重 10,1,3,5,7,9,11,13,15,17,19 加權總和能被 89 整除
function validAbn(digits: string) {
  if (!/^\d{11}$/.test(digits)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const d = digits.split("").map(Number);
  d[0] -= 1;
  return d.reduce((s, x, i) => s + x * w[i], 0) % 89 === 0;
}
function clean(v: unknown, max: number) {
  return String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

async function sendMail(to: string, subject: string, html: string) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  if (!resp.ok) {
    console.error("Resend API error:", resp.status, await resp.text());
    return false;
  }
  return true;
}
function wrap(inner: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1e1e1b;">
    <h2 style="color:#e8751a;margin:0 0 12px;">Orange Tea AU</h2>${inner}</div>`;
}
function confirmMail(name: string, link: string) {
  return wrap(`<p>Hi ${esc(name)},</p>
    <p>Thanks for applying for an Orange Tea AU ordering account. Please confirm your email address to complete your application.</p>
    <p style="margin:24px 0;"><a href="${esc(link)}" style="background:#e8751a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block;">Confirm my email</a></p>
    <p style="font-size:12px;color:#666;">After you confirm, our team will review your application and email you once your account is ready. This link expires in ${CONFIRM_VALID_DAYS} days. If you did not apply, you can ignore this email.</p>
    <p style="font-size:12px;color:#666;">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(link)}</span></p>`);
}
function alreadyHasAccountMail(name: string) {
  return wrap(`<p>Hi ${esc(name)},</p>
    <p>We received an application for an Orange Tea AU ordering account using this email address, but an account already exists for it.</p>
    <p>If you forgot your password, use the "Forgot password?" link on the sign-in page. If you did not apply, you can ignore this email.</p>`);
}

async function verifyTurnstile(token: string, ip: string) {
  if (!TURNSTILE_SECRET) return true; // 沒設 Secret 就不驗證(只靠其他防護)
  if (!token) return false;
  const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = await r.json();
    return !!j.success;
  } catch (e) {
    console.error("turnstile error", e);
    return false;
  }
}

async function handleSubmit(req: Request, body: any) {
  if (!RESEND_API_KEY) return json({ error: "server_not_configured" }, 500);
  if (!/^https?:\/\//.test(APP_URL)) return json({ error: "server_not_configured" }, 500);

  // 蜜罐欄位:真人看不到這個欄位,機器人才會填。假裝成功,什麼都不做
  if (clean(body.website, 200)) return json({ ok: true });

  const company = clean(body.company, 120);
  const abn = String(body.abn ?? "").replace(/\D/g, "");
  const contactName = clean(body.contactName, 80);
  const phone = clean(body.phone, 40);
  const email = clean(body.email, 160).toLowerCase();
  const billTo = clean(body.billTo, 400);
  const shipTo = clean(body.shipTo, 400);
  if (!company || !contactName || !shipTo) return json({ error: "missing_fields" }, 400);
  if (!validAbn(abn)) return json({ error: "bad_abn" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "bad_email" }, 400);

  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  if (!(await verifyTurnstile(String(body.turnstileToken || ""), ip))) return json({ error: "captcha_failed" }, 400);
  const ipHash = await sha256Hex(`${ip}|${SUPABASE_URL}`);

  // ---- 次數限制 ----
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const { count: ipCount } = await admin.from("account_requests").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", hourAgo);
  if ((ipCount || 0) >= LIMIT_IP_PER_HOUR) return json({ error: "too_many" }, 429);
  const { count: emailCount } = await admin.from("account_requests").select("id", { count: "exact", head: true }).eq("email", email).gte("created_at", dayAgo);
  if ((emailCount || 0) >= LIMIT_EMAIL_PER_DAY) return json({ error: "too_many" }, 429);
  const { count: globalCount } = await admin.from("account_requests").select("id", { count: "exact", head: true }).gte("created_at", hourAgo);
  if ((globalCount || 0) >= LIMIT_GLOBAL_PER_HOUR) return json({ error: "too_many" }, 429);

  // ---- 這個 Email 已經有帳號:不建立申請,寄一封提示信(回應跟一般成功一樣,不洩漏哪些 Email 有帳號) ----
  const { data: existingProfile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (existingProfile) {
    await sendMail(email, "Your Orange Tea AU account", alreadyHasAccountMail(contactName));
    return json({ ok: true });
  }

  // ---- 同一個 ABN 已經有待處理 / 已核准的申請(不同 Email):直接提示 ----
  const { data: abnHits } = await admin.from("account_requests").select("id,email,status").eq("abn", abn).in("status", ["unconfirmed", "pending", "approved"]);
  if ((abnHits || []).some((r: any) => r.email !== email)) return json({ error: "duplicate_abn" }, 409);

  // ---- 同一個 Email 已有申請 ----
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const { data: mine } = await admin.from("account_requests").select("id,status").eq("email", email).in("status", ["unconfirmed", "pending"]).order("created_at", { ascending: false }).limit(1);
  let rowId: string;
  if (mine && mine.length && mine[0].status === "pending") {
    return json({ ok: true, alreadyPending: true }); // 已經在審核中,不用再申請
  } else if (mine && mine.length) {
    // 還沒確認:更新內容並重寄確認信
    rowId = mine[0].id;
    const { error } = await admin.from("account_requests").update({
      company_name: company, abn, contact_name: contactName, phone, bill_to: billTo, ship_to: shipTo,
      confirm_token_hash: tokenHash, created_at: new Date().toISOString(), ip_hash: ipHash,
    }).eq("id", rowId);
    if (error) { console.error(error); return json({ error: "save_failed" }, 500); }
  } else {
    const { data, error } = await admin.from("account_requests").insert({
      status: "unconfirmed", company_name: company, abn, contact_name: contactName, phone, email, bill_to: billTo, ship_to: shipTo,
      confirm_token_hash: tokenHash, ip_hash: ipHash,
    }).select("id").single();
    if (error || !data) { console.error(error); return json({ error: "save_failed" }, 500); }
    rowId = data.id;
  }

  const link = `${APP_URL}?confirm_request=${encodeURIComponent(token)}`;
  const sent = await sendMail(email, "Confirm your Orange Tea AU account application", confirmMail(contactName, link));
  if (!sent) return json({ error: "email_failed" }, 502);
  return json({ ok: true });
}

async function handleConfirm(body: any) {
  const token = String(body.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ ok: false, state: "invalid" });
  const tokenHash = await sha256Hex(token);
  const { data: row } = await admin.from("account_requests").select("id,status,created_at").eq("confirm_token_hash", tokenHash).maybeSingle();
  if (!row) return json({ ok: false, state: "invalid" });
  if (row.status === "pending" || row.status === "approved") return json({ ok: true, state: "already" });
  if (row.status !== "unconfirmed") return json({ ok: false, state: "invalid" });
  if (Date.now() - new Date(row.created_at).getTime() > CONFIRM_VALID_DAYS * 86400_000) return json({ ok: false, state: "expired" });
  const { error } = await admin.from("account_requests").update({ status: "pending", confirmed_at: new Date().toISOString() }).eq("id", row.id).eq("status", "unconfirmed");
  if (error) { console.error(error); return json({ ok: false, state: "error" }, 500); }
  return json({ ok: true, state: "confirmed" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  try {
    const body = await req.json();
    if (body.action === "submit") return await handleSubmit(req, body);
    if (body.action === "confirm") return await handleConfirm(body);
    return json({ error: "bad_request" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
