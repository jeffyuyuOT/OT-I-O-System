// 每日伺服器端備份:把 public schema 所有資料表倒成一個 gzip JSON,上傳到 Dropbox(App folder),並刪除超過保留天數的舊檔。
// 由 pg_cron 每天呼叫一次(見 sql/daily_backup_cron.sql)。
// 需要的 secrets:DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, BACKUP_SECRET;選用 RETENTION_DAYS(預設 90)。
// (SUPABASE_DB_URL 是 Supabase 自動提供的)。部署時要關掉 JWT 驗證(--no-verify-jwt),改用 x-backup-secret 驗證。
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const BATCH = 1000;
const FOLDER = "/daily";
const MAX_SIMPLE_UPLOAD = 140 * 1024 * 1024; // Dropbox 單次上傳上限 150MB

function brisbaneDate(offsetDays = 0): string {
  // 布里斯本沒有日光節約,固定 UTC+10
  return new Date(Date.now() + 10 * 3600 * 1000 - offsetDays * 86400 * 1000).toISOString().slice(0, 10);
}

async function dropboxToken(): Promise<string> {
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: Deno.env.get("DROPBOX_REFRESH_TOKEN")!,
      client_id: Deno.env.get("DROPBOX_APP_KEY")!,
      client_secret: Deno.env.get("DROPBOX_APP_SECRET")!,
    }),
  });
  if (!res.ok) throw new Error(`Dropbox token failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function dropboxRpc(token: string, endpoint: string, arg: unknown) {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(arg),
  });
  if (!res.ok) throw new Error(`Dropbox ${endpoint} failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// 刪掉資料夾裡「檔名日期早於保留期限」的備份(只動符合 YYYY-MM-DD.json.gz 的檔案)
async function cleanupOld(token: string, retentionDays: number): Promise<number> {
  const cutoff = brisbaneDate(retentionDays);
  let deleted = 0;
  let list;
  try { list = await dropboxRpc(token, "files/list_folder", { path: FOLDER }); }
  catch (e) { if (String((e as Error).message).includes("not_found")) return 0; throw e; }
  for (;;) {
    for (const f of list.entries) {
      const m = f[".tag"] === "file" && /^(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(f.name);
      if (m && m[1] < cutoff) { await dropboxRpc(token, "files/delete_v2", { path: f.path_lower }); deleted++; }
    }
    if (!list.has_more) break;
    list = await dropboxRpc(token, "files/list_folder/continue", { cursor: list.cursor });
  }
  return deleted;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("BACKUP_SECRET");
  if (!secret || req.headers.get("x-backup-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const file = `${brisbaneDate()}.json.gz`;
  let tableCount = 0, rowCount = 0, bytes = 0, deleted = 0;
  let error: string | null = null, note: string | null = null;
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
    if (bytes > MAX_SIMPLE_UPLOAD) throw new Error(`備份檔 ${bytes} bytes 超過單次上傳上限,需要改用分段上傳`);
    const body = new Uint8Array(bytes);
    let off = 0; for (const c of chunks) { body.set(c, off); off += c.length; }

    const token = await dropboxToken();
    const up = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path: `${FOLDER}/${file}`, mode: "overwrite", mute: true }),
      },
      body,
    });
    if (!up.ok) throw new Error(`Dropbox upload failed: ${up.status} ${await up.text()}`);

    // 上傳成功後才清舊檔;清理失敗不算備份失敗,只記在 error 欄(ok 仍為 true)
    try { deleted = await cleanupOld(token, Number(Deno.env.get("RETENTION_DAYS") || 90)); }
    catch (e) { note = "cleanup: " + String((e as Error)?.message || e); }
  } catch (e) {
    error = String((e as Error)?.message || e);
  }
  try {
    await sql`insert into public.backup_log (ok, file, bytes, tables, rows, error)
      values (${error === null}, ${`${FOLDER}/${file}`}, ${bytes}, ${tableCount}, ${rowCount}, ${error ?? note})`;
  } catch (_e) { /* 記錄失敗不影響回應 */ }
  await sql.end({ timeout: 5 });
  return new Response(JSON.stringify({ ok: error === null, file: `${FOLDER}/${file}`, bytes, tables: tableCount, rows: rowCount, deletedOld: deleted, error, note }),
    { status: error === null ? 200 : 500, headers: { "Content-Type": "application/json" } });
});
