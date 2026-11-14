import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Orange Tea AU 庫存系統：寤信通知(進貨單寤給會計，也共用給已簽收的已完成訂單寤給客戶/會計)
//
// 接收前端（sb.functions.invoke('send-purchase-email', ...)）傳來的資訊，去 Storage 把已經
// 上傳好的 Excel 檔案（必備）跟收據附件（選填，可以多個，只有進貨單會有，訂單沒有）拓下來，
// 透過 Resend 當附件一起寄出去。invoiceNo 這個欄位共用：進貨單傳真正的 Invoice 號碼，
// 訂單傳訂單編號，信件內文的標籤統一用中性的「Reference No.」，不寫死「Invoice No.」，兩種情境
// 共用同一支函式不會顯示錯欄位名稱。
//
// to/cc 現在都支援陣列(同時寤給好幾個收件人、外加副本),也向下相容舊版前端傳單一字串過來的情況。
// cc 是選填的,沒有的話就不帶這個欄位給 Resend。

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// orangetea.com.au 網域已經驗證通過,正式用公司信箱當寤件人。顯示名稱用 "Jeff Orange Tea"。
const FROM_ADDRESS = "Jeff Orange Tea <jeff@orangetea.com.au>";

function corsHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status}): ${url}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1] || fallback);
  } catch (_e) {
    return fallback;
  }
}

interface ReceiptFile {
  url: string;
  filename?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: corsHeaders(),
    });
  }
  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), {
      status: 500,
      headers: corsHeaders(),
    });
  }

  try {
    const body = await req.json();
    const {
      purchaseId,
      to,
      cc,
      excelUrl,
      excelFilename,
      receiptFiles, // 新格式：陣列，支援多個附件
      receiptUrl, // 舊格式（單一附件）向下相容，旧版前端沒重新部署時不會壞掉
      receiptFilename,
      date,
      supplier,
      invoiceNo,
      note, // 附註(選填)
    } = body || {};

    // to/cc 可以是陣列(新版前端)或單一字串(舊版前端),統一正規化成陣列。
    const toList: string[] = Array.isArray(to) ? to.filter(Boolean) : (to ? [to] : []);
    const ccList: string[] = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc] : []);

    if (toList.length === 0 || !excelUrl) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, excelUrl" }),
        { status: 400, headers: corsHeaders() },
      );
    }

    const attachments: { filename: string; content: string }[] = [];

    const excelBase64 = await fetchAsBase64(excelUrl);
    attachments.push({
      filename: excelFilename || filenameFromUrl(excelUrl, `export_${purchaseId || "order"}.xlsx`),
      content: excelBase64,
    });

    // 收集要附加的收據檔案清單:優先用新格式的 receiptFiles 陣列,沒有的話候備舊格式的單一 receiptUrl。
    const receiptList: ReceiptFile[] = Array.isArray(receiptFiles) && receiptFiles.length > 0
      ? receiptFiles
      : (receiptUrl ? [{ url: receiptUrl, filename: receiptFilename }] : []);

    for (const rf of receiptList) {
      if (!rf || !rf.url) continue;
      try {
        const receiptBase64 = await fetchAsBase64(rf.url);
        attachments.push({
          filename: rf.filename || filenameFromUrl(rf.url, `receipt_${purchaseId || "order"}`),
          content: receiptBase64,
        });
      } catch (e) {
        console.error("Failed to fetch a receipt attachment, skipping it:", rf.url, e);
      }
    }

    const subjectParts = ["Orange Tea AU"];
    if (supplier) subjectParts.push(`- ${supplier}`);
    if (date) subjectParts.push(`(${date})`);
    const subject = subjectParts.join(" ");

    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const noteText = typeof note === "string" ? note.trim() : "";

    const html = `
      ${noteText ? `<p style="margin:0 0 16px;"><strong>Note:</strong> ${escapeHtml(noteText).replace(/\n/g, "<br>")}</p>` : ""}
      <p>A document has been sent from the Orange Tea AU inventory system.</p>
      <table cellpadding="4" style="border-collapse:collapse;">
        <tr><td><strong>Date</strong></td><td>${date || ""}</td></tr>
        <tr><td><strong>Party</strong></td><td>${supplier || ""}</td></tr>
        <tr><td><strong>Reference No.</strong></td><td>${invoiceNo || ""}</td></tr>
      </table>
      <p>The item list is attached as an Excel file${receiptList.length > 0 ? `, along with ${receiptList.length > 1 ? "the receipts" : "the receipt"}.` : "."}</p>
    `;

    const resendBody: Record<string, unknown> = {
      from: FROM_ADDRESS,
      to: toList,
      subject,
      html,
      attachments,
    };
    if (ccList.length > 0) resendBody.cc = ccList;

    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(resendBody),
    });

    if (!resendResp.ok) {
      const errText = await resendResp.text();
      console.error("Resend API error:", resendResp.status, errText);
      return new Response(
        JSON.stringify({ error: "Resend API error", detail: errText }),
        { status: 502, headers: corsHeaders() },
      );
    }

    const resendData = await resendResp.json();
    return new Response(JSON.stringify({ success: true, id: resendData.id }), {
      status: 200,
      headers: corsHeaders(),
    });
  } catch (e) {
    console.error("send-purchase-email error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
});
