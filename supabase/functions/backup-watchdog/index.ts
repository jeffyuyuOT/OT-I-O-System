// 備份監看:每天檢查 backup_log,資料備份(daily-backup)或 Storage 備份(storage-backup)最近 26 小時內沒有成功紀錄,就用 Resend 寄信通知。
// 涵蓋「函式報錯」與「排程根本沒呼叫到函式」兩種情況(後者函式自己無法通知,所以要由獨立的監看來檢查)。
// 另外,資料備份成功但結構檔匯出失敗(backup_log.error 以 "schema:" 開頭)也會通知。
// 由 pg_cron 每天 23:50 布里斯本時間呼叫(見 sql/backup_watchdog_cron.sql)。部署時關掉 JWT 驗證(--no-verify-jwt),用 x-backup-secret 驗證。
// secrets:BACKUP_SECRET(與其他備份函式共用)、RESEND_API_KEY(與寄信函式共用)、ALERT_EMAIL(收通知的信箱,可用逗號分隔多個);
// 選用 BACKUP_FOLDER(預設 /daily)、STORAGE_BACKUP_FOLDER(預設 /storage),測試專案要跟其他函式設成一樣的值。SUPABASE_DB_URL 由 Supabase 自動提供。
// 測試寄信:POST body {"test":true} 會直接寄一封測試信(不管備份是否正常)。
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const MAX_AGE_HOURS = 26;
const FROM_ADDRESS = "Jeff Orange Tea <jeff@orangetea.com.au>";
const DAILY = Deno.env.get("BACKUP_FOLDER") || "/daily";
const STORAGE = Deno.env.get("STORAGE_BACKUP_FOLDER") || "/storage";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function sendMail(to: string[], subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("BACKUP_SECRET");
  if (!secret || req.headers.get("x-backup-secret") !== secret) return new Response("unauthorized", { status: 401 });

  const to = (Deno.env.get("ALERT_EMAIL") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0 || !Deno.env.get("RESEND_API_KEY")) {
    return new Response(JSON.stringify({ ok: false, error: "ALERT_EMAIL or RESEND_API_KEY not configured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  let body: { test?: boolean } = {};
  try { body = await req.json(); } catch (_e) { /* 沒有 body 也可以 */ }

  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const problems: string[] = [];
  try {
    const checks: [string, string][] = [["資料庫備份(daily-backup)", DAILY], ["Storage 檔案備份(storage-backup)", STORAGE]];
    for (const [label, folder] of checks) {
      const rows = await sql`
        select ok, error, ran_at from public.backup_log
        where file like ${folder + "/%"} order by id desc limit 20` as unknown as { ok: boolean; error: string | null; ran_at: Date }[];
      const okRow = rows.find((r) => r.ok);
      const ageH = okRow ? (Date.now() - new Date(okRow.ran_at).getTime()) / 3600000 : Infinity;
      if (!okRow || ageH > MAX_AGE_HOURS) {
        const last = rows[0];
        problems.push(`${label}:最近 ${MAX_AGE_HOURS} 小時內沒有成功紀錄。` +
          (last ? `最新一筆是 ${new Date(last.ran_at).toISOString()}(ok=${last.ok}${last.error ? `,錯誤:${last.error.slice(0, 200)}` : ""})。` : "backup_log 裡完全沒有這個備份的紀錄。") +
          "若沒有任何新紀錄,通常是排程沒有觸發或 BACKUP_SECRET 不一致(401)。");
      } else if (okRow.error && /^schema:/.test(okRow.error)) {
        problems.push(`${label}:資料備份成功,但結構檔匯出失敗(${okRow.error.slice(0, 200)})。`);
      }
    }
    if (problems.length > 0 || body.test) {
      const subject = problems.length > 0 ? "⚠ Orange Tea 備份異常" : "Orange Tea 備份監看:測試信";
      const html = problems.length > 0
        ? `<p>Orange Tea 庫存系統的備份檢查發現問題:</p><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul><p>請到 Supabase 查看 <code>select * from public.backup_log order by id desc limit 10;</code> 與 <code>cron.job_run_details</code>。</p>`
        : "<p>這是備份監看的測試信。收到代表通知設定正常;目前兩項備份都在最近 26 小時內成功。</p>";
      await sendMail(to, subject, html);
    }
    return new Response(JSON.stringify({ ok: problems.length === 0, problems, notified: problems.length > 0 || !!body.test }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[backup-watchdog]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }), { status: 500, headers: { "Content-Type": "application/json" } });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
