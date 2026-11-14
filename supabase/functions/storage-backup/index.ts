// 每日 Storage 檔案備份:把所有 bucket 的檔案「增量」複製到 Dropbox(App folder)/storage/<bucket>/<路徑>。
// 只上傳 Dropbox 上還沒有(或大小不同)的檔案;不會刪除 Dropbox 上的舊檔(即使 Storage 裡已被刪除,仍保留備份)。
// 同時處理 5 個檔案;下載用 service role(public / private bucket 都可)。每次最多處理 MAX_FILES 個檔案或約 TIME_BUDGET_MS 毫秒,沒做完的下次續做(首次 157 檔通常一次完成)。
// 由 pg_cron 每天呼叫(見 sql/storage_backup_cron.sql)。部署時關掉 JWT 驗證(--no-verify-jwt),改用 x-backup-secret 驗證。
// secrets:DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, BACKUP_SECRET(與 daily-backup 共用);
// 選用 STORAGE_BACKUP_FOLDER(預設 /storage;測試專案請設 /storage-test)。SUPABASE_DB_URL、SUPABASE_URL 由 Supabase 自動提供。
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const FOLDER = Deno.env.get("STORAGE_BACKUP_FOLDER") || "/storage";
const MAX_FILES = 200;
const CONCURRENCY = 5;
const TIME_BUDGET_MS = 100_000;
const MAX_FILE = 140 * 1024 * 1024; // Dropbox 單次上傳上限 150MB

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

// Dropbox 上已有的檔案:小寫路徑 → 大小
async function existingFiles(token: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let list;
  try { list = await dropboxRpc(token, "files/list_folder", { path: FOLDER, recursive: true, limit: 2000 }); }
  catch (e) { if (String((e as Error).message).includes("not_found")) return map; throw e; }
  for (;;) {
    for (const f of list.entries) if (f[".tag"] === "file") map.set(f.path_lower, f.size);
    if (!list.has_more) break;
    list = await dropboxRpc(token, "files/list_folder/continue", { cursor: list.cursor });
  }
  return map;
}

// Dropbox-API-Arg 標頭必須是純 ASCII,非 ASCII 字元要轉成 \uXXXX
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

async function dropboxUpload(token: string, path: string, body: Uint8Array) {
  const up = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": asciiJson({ path, mode: "overwrite", mute: true }),
    },
    body,
  });
  if (!up.ok) throw new Error(`Dropbox upload failed: ${up.status} ${await up.text()}`);
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("BACKUP_SECRET");
  if (!secret || req.headers.get("x-backup-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const started = Date.now();
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  let error: string | null = null;
  let note = "";
  let uploaded = 0, skipped = 0, failed = 0, pending = 0, bytes = 0, total = 0;
  try {
    const token = await dropboxToken();
    const have = await existingFiles(token);
    const objs = await sql`
      select bucket_id, name, coalesce((metadata->>'size')::bigint, 0)::float8 as size
      from storage.objects
      where name is not null and name not like '%/' and name <> '.emptyFolderPlaceholder' and name not like '%/.emptyFolderPlaceholder'
      order by created_at` as unknown as { bucket_id: string; name: string; size: number }[];
    total = objs.length;
    const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // Supabase 自動提供;用它下載,public / private bucket 都可以
    const todo: typeof objs = [];
    for (const o of objs) {
      const dbxPath = `${FOLDER}/${o.bucket_id}/${o.name}`;
      if (have.get(dbxPath.toLowerCase()) === o.size && o.size > 0) skipped++; else todo.push(o);
    }
    // 同時處理 CONCURRENCY 個檔案;超過檔數或時間上限的留給下次
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (next >= todo.length) return;
        if (uploaded + failed >= MAX_FILES || Date.now() - started > TIME_BUDGET_MS) return;
        const o = todo[next++];
        const dbxPath = `${FOLDER}/${o.bucket_id}/${o.name}`;
        try {
          if (o.size > MAX_FILE) throw new Error("file too large");
          const url = `${base}/storage/v1/object/${encodeURIComponent(o.bucket_id)}/${o.name.split("/").map(encodeURIComponent).join("/")}`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${svcKey}`, apikey: svcKey } });
          if (!r.ok) throw new Error(`download ${r.status}`);
          const buf = new Uint8Array(await r.arrayBuffer());
          await dropboxUpload(token, dbxPath, buf);
          uploaded++; bytes += buf.length;
        } catch (e) {
          failed++; console.error("[storage-backup] failed", dbxPath, String(e));
          note = note || `first failure: ${dbxPath}: ${String(e).slice(0, 120)}`;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    pending = todo.length - Math.min(next, todo.length);
    if (failed > 0) error = `${failed} file(s) failed; ${note}`;
    else if (pending > 0) note = `${pending} file(s) left for next run`;
    console.log(`[storage-backup] total=${total} uploaded=${uploaded} skipped=${skipped} failed=${failed} pending=${pending}`);
  } catch (e) {
    error = String(e).slice(0, 500);
    console.error("[storage-backup]", error);
  }
  try {
    await sql`insert into public.backup_log (ok, file, bytes, tables, rows, error)
      values (${error === null}, ${`${FOLDER}/ (storage files)`}, ${bytes}, ${0}, ${uploaded}, ${error ?? (note || `total ${total}, uploaded ${uploaded}, skipped ${skipped}`)})`;
  } catch (_e) { /* 記錄失敗不影響回應 */ }
  await sql.end({ timeout: 5 });
  return new Response(JSON.stringify({ ok: error === null, total, uploaded, skipped, failed, pending, bytes, error }), {
    status: error === null ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});
