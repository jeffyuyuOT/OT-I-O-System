// 每日伺服器端備份:把 public schema 所有資料表倒成一個 gzip JSON,上傳到 Cloudflare R2(外部空間)。
// 由 pg_cron 每天呼叫一次(見 sql/daily_backup_cron.sql)。保留期限(90 天)用 R2 的 Lifecycle 規則自動刪,不在這裡處理。
// 需要的 secrets:R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, BACKUP_SECRET
// (SUPABASE_DB_URL 是 Supabase 自動提供的)。部署時要關掉 JWT 驗證(--no-verify-jwt),改用 x-backup-secret 驗證。
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const BATCH = 1000;

function brisbaneDate(): string {
  // 布里斯本沒有日光節約,固定 UTC+10
  return new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-backup-secret") !== Deno.env.get("BACKUP_SECRET") || !Deno.env.get("BACKUP_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const key = `daily/${brisbaneDate()}.json.gz`;
  let tableCount = 0, rowCount = 0, bytes = 0, error: string | null = null;
  try {
    const tables = await sql`select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`;

    // 邊讀邊壓縮,避免整份資料同時放在記憶體裡
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    const pump = (async () => {
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    })();
    const enc = new TextEncoder();
    const w = (s: string) => writer.write(enc.encode(s));

    await w(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"format":"ot-db-dump-v1","tables":{`);
    let firstTable = true;
    for (const { table_name } of tables) {
      await w((firstTable ? "" : ",") + JSON.stringify(table_name) + ":[");
      firstTable = false;
      let firstRow = true;
      await sql`select to_jsonb(t) as r from public.${sql(table_name)} t`.cursor(BATCH, async (rows: { r: unknown }[]) => {
        for (const { r } of rows) { await w((firstRow ? "" : ",") + JSON.stringify(r)); firstRow = false; rowCount++; }
      });
      await w("]");
      tableCount++;
    }
    await w("}}");
    await writer.close();
    await pump;

    bytes = chunks.reduce((s, c) => s + c.length, 0);
    const body = new Uint8Array(bytes);
    let off = 0; for (const c of chunks) { body.set(c, off); off += c.length; }

    const r2 = new AwsClient({
      accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID")!,
      secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!,
      service: "s3", region: "auto",
    });
    const url = `https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com/${Deno.env.get("R2_BUCKET")}/${key}`;
    const res = await r2.fetch(url, { method: "PUT", body, headers: { "Content-Type": "application/gzip" } });
    if (!res.ok) throw new Error(`R2 upload failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    error = String((e as Error)?.message || e);
  }
  try {
    await sql`insert into public.backup_log (ok, file, bytes, tables, rows, error)
      values (${error === null}, ${key}, ${bytes}, ${tableCount}, ${rowCount}, ${error})`;
  } catch (_e) { /* 記錄失敗不影響回應 */ }
  await sql.end({ timeout: 5 });
  return new Response(JSON.stringify({ ok: error === null, file: key, bytes, tables: tableCount, rows: rowCount, error }),
    { status: error === null ? 200 : 500, headers: { "Content-Type": "application/json" } });
});
