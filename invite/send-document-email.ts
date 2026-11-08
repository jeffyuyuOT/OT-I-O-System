import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Orange Tea AU 庫存系統:把 Invoice / Credit Note 的 PDF 用 email 寄給出貨方(客戶)。
//
// 前端(Invoice 清單 / Credit Note 清單 最左邊的 ✉ 圖示)用 sb.functions.invoke('send-document-email', ...) 呼叫。
// 這支函式用 service role 做:
//   1. 驗證呼叫的人是 admin / accountant。
//   2. 用 Resend 寄出(附上 PDF)。
//        寄件者 = 前端帶來的「會計 Email(主要)」,但 Resend 只允許「已驗證網域」的地址當 From,
//        所以:
//          · 會計 Email 的網域在已驗證網域清單(環境變數 DOC_EMAIL_DOMAINS,預設 orangetea.com.au)→ From 直接用它;
//          · 否則 From 退回 noreply@orangetea.com.au,但顯示名稱照用、Reply-To 仍設成會計 Email。
//        兩種情況客戶按「回覆」都會回到會計 Email。
//   3. 寫入 document_emails(誰、幾時、寄給誰),前端的「寄送紀錄」和清單上的「已寄」標記就是讀這張表。
// 需要的 secret:RESEND_API_KEY(跟 send-purchase-email / invite-user 同一個)。

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FALLBACK_FROM = "noreply@orangetea.com.au";
const VERIFIED_DOMAINS = (Deno.env.get("DOC_EMAIL_DOMAINS") || "orangetea.com.au")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

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
const EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;
function cleanList(v: unknown): string[] {
  const a = Array.isArray(v) ? v : String(v ?? "").split(",");
  return a.map((x) => String(x).trim()).filter(Boolean);
}
function safeName(s: string) {
  return String(s ?? "").replace(/[\r\n<>"]/g, " ").trim().slice(0, 80) || "Orange Tea Australia";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY 尚未設定" }, 500);

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
    if (callerErr || !callerData?.user) return json({ error: "not_signed_in" }, 401);
    const { data: profile } = await admin.from("profiles").select("*").eq("id", callerData.user.id).maybeSingle();
    if (!profile || !["admin", "accountant"].includes(profile.role)) return json({ error: "forbidden" }, 403);

    const b = await req.json();
    const docType = b.docType === "credit_note" ? "credit_note" : "invoice";
    const to = cleanList(b.to), cc = cleanList(b.cc);
    const sender = String(b.senderEmail || "").trim();
    if (!to.length || to.some((e) => !EMAIL_RE.test(e))) return json({ error: "invalid_to" }, 400);
    if (cc.some((e) => !EMAIL_RE.test(e))) return json({ error: "invalid_cc" }, 400);
    if (!EMAIL_RE.test(sender)) return json({ error: "invalid_sender" }, 400);
    if (!b.pdfBase64 || !b.docId) return json({ error: "missing_pdf" }, 400);

    const name = safeName(b.senderName);
    const domain = sender.split("@")[1].toLowerCase();
    const fromAddr = VERIFIED_DOMAINS.includes(domain) ? sender : FALLBACK_FROM;
    const from = `${name} <${fromAddr}>`;
    const subject = String(b.subject || "").replace(/[\r\n]+/g, " ").slice(0, 300) || (docType === "credit_note" ? "Credit Note" : "Invoice");
    const text = String(b.body || "");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">${esc(text).replace(/\n/g, "<br>")}</div>`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to, cc: cc.length ? cc : undefined, reply_to: sender, subject, text, html,
        attachments: [{ filename: String(b.pdfFilename || "document.pdf"), content: String(b.pdfBase64) }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error("Resend error", r.status, detail);
      return json({ error: "send_failed", detail: detail.slice(0, 300) }, 502);
    }

    const sentBy = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.username || profile.email || "";
    const { error: logErr } = await admin.from("document_emails").insert({
      doc_type: docType, doc_id: String(b.docId), doc_no: String(b.docNo || ""),
      to_email: to.join(", "), cc_email: cc.join(", "), subject, body: text,
      from_email: fromAddr, reply_to: sender, sent_by_id: profile.id, sent_by: sentBy,
    });
    if (logErr) console.error("log insert failed", logErr);
    return json({ ok: true, from: fromAddr, replyTo: sender, sentBy, sentAt: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
