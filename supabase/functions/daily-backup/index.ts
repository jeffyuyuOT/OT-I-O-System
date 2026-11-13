// 每日伺服器端備份:把 public schema 所有資料表倒成一個 gzip JSON,並把資料庫「結構」(資料表、函式/RPC、觸發器、RLS 政策、權限、排程等)
// 匯出成可重建空專案的 SQL(gzip),一起上傳到 Dropbox(App folder),並刪除超過保留天數的舊檔。
// 檔案:daily/YYYY-MM-DD.json.gz(資料)、daily/YYYY-MM-DD.schema.sql.gz(結構)。結構匯出失敗不影響資料備份,只記在 backup_log.error。
// 由 pg_cron 每天呼叫一次(見 sql/daily_backup_cron.sql)。
// 需要的 secrets:DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, BACKUP_SECRET;選用 RETENTION_DAYS(預設 90)、BACKUP_FOLDER(預設 /daily;測試專案要設成 /daily-test)。
// (SUPABASE_DB_URL 是 Supabase 自動提供的)。部署時要關掉 JWT 驗證(--no-verify-jwt),改用 x-backup-secret 驗證。
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const BATCH = 1000;
const FOLDER = Deno.env.get("BACKUP_FOLDER") || "/daily"; // 測試專案請設 BACKUP_FOLDER=/daily-test,避免覆蓋正式版備份
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

async function gzipText(text: string): Promise<Uint8Array> {
  // 標準寫法:Blob → pipeThrough → Response 讀取,不手動操作 writer(手動 write/close 沒等待完成會讓 Edge Runtime 出現 "stream is closing or is closed")
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function dropboxUpload(token: string, path: string, body: Uint8Array) {
  const up = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }),
    },
    body,
  });
  if (!up.ok) throw new Error(`Dropbox upload failed: ${up.status} ${await up.text()}`);
}

// 刪掉資料夾裡「檔名日期早於保留期限」的備份(只動符合 YYYY-MM-DD.json.gz / YYYY-MM-DD.schema.sql.gz 的檔案)
async function cleanupOld(token: string, retentionDays: number): Promise<number> {
  const cutoff = brisbaneDate(retentionDays);
  let deleted = 0;
  let list;
  try { list = await dropboxRpc(token, "files/list_folder", { path: FOLDER }); }
  catch (e) { if (String((e as Error).message).includes("not_found")) return 0; throw e; }
  for (;;) {
    for (const f of list.entries) {
      const m = f[".tag"] === "file" && /^(\d{4}-\d{2}-\d{2})\.(?:json|schema\.sql)\.gz$/.exec(f.name);
      if (m && m[1] < cutoff) { await dropboxRpc(token, "files/delete_v2", { path: f.path_lower }); deleted++; }
    }
    if (!list.has_more) break;
    list = await dropboxRpc(token, "files/list_folder/continue", { cursor: list.cursor });
  }
  return deleted;
}

// <schema-export>
// 匯出資料庫結構成 SQL。每條語句後面接一行 "-- @@" 當分隔(函式內容含分號,不能用分號切)。
// 檔案分兩段:PART 1(資料前:型別、序列、資料表、儲存桶)→ 載入資料 → PART 2(資料後:外鍵、索引、函式、觸發器、視圖、RLS、政策、權限、序列值、排程)。
// 不含:資料本身、auth.users、Storage 檔案、Edge Function 與其 secrets。
const SEP = "\n-- @@\n";
// deno-lint-ignore no-explicit-any
async function exportSchemaSql(db: any): Promise<string> {
  // 用空的 search_path,讓輸出的型別、函式、資料表名稱都帶 schema 前綴(還原時不受 search_path 影響);每條查詢用 savepoint,單一段落失敗不影響其他段落
  return await db.begin(async (sql: any) => {
  await sql.unsafe("set local search_path = ''");
  const part = async (title: string, queries: string[]): Promise<string> => {
    let out = `\n-- ======== ${title} ========\n`;
    for (const q of queries) {
      try {
        const rows: { s: string }[] = await sql.savepoint((sp: any) => sp.unsafe(q));
        for (const r of rows) if (r.s) out += r.s + SEP;
      } catch (e) {
        out += `-- ERROR exporting a section: ${String((e as Error)?.message || e).replace(/\n/g, " ")}\n`;
      }
    }
    return out;
  };

  const pre = await part("PART 1 (run BEFORE loading data)", [
    // 不支援的物件先在檔案裡留警告,還原演練時才不會漏掉
    `select '-- WARNING unsupported: ' || kind || ' ' || name as s from (
       select 'materialized view' as kind, c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='m'
       union all select 'partitioned table', c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='p'
       union all select 'aggregate function', p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='a'
       union all select 'domain/composite/range type', t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and (t.typtype in ('d','r') or (t.typtype='c' and exists (select 1 from pg_class k where k.oid=t.typrelid and k.relkind='c')))
     ) u order by 1`,
    // 擴充套件(已存在就略過)
    `select format('create extension if not exists %I with schema %I;', e.extname, n.nspname) as s
       from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname <> 'plpgsql' order by e.extname`,
    // enum 型別
    `select format('create type %I.%I as enum (%s);', n.nspname, t.typname,
         (select string_agg(quote_literal(enumlabel), ', ' order by enumsortorder) from pg_enum where enumtypid=t.oid)) as s
       from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e' order by t.typname`,
    // 獨立序列(identity 欄位自帶的序列由資料表定義建立,這裡排除)
    `select format('create sequence if not exists %I.%I as %s start %s increment %s minvalue %s maxvalue %s cache %s %s;',
         q.schemaname, q.sequencename, q.data_type, q.start_value, q.increment_by, q.min_value, q.max_value, q.cache_size,
         case when q.cycle then 'cycle' else 'no cycle' end) as s
       from pg_sequences q
       where q.schemaname='public' and not exists (
         select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_depend d on d.objid=c.oid and d.classid='pg_class'::regclass and d.deptype='i'
         where n.nspname=q.schemaname and c.relname=q.sequencename and c.relkind='S')
       order by q.sequencename`,
    // 資料表(欄位、預設值、identity、generated、主鍵/唯一/check 約束;外鍵放 PART 2)
    `select format('create %stable %I.%I (%s%s%s);', case when c.relpersistence='u' then 'unlogged ' else '' end, n.nspname, c.relname, E'\n',
         array_to_string(
           array(select format('  %I %s%s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                   case a.attidentity when 'a' then ' generated always as identity' when 'd' then ' generated by default as identity' else '' end,
                   case when a.attgenerated = 's' then ' generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ') stored'
                        when d.adbin is not null and a.attidentity = '' then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end,
                   case when a.attnotnull then ' not null' else '' end)
                 from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
                 where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attnum)
           ||
           array(select format('  constraint %I %s', k.conname, pg_get_constraintdef(k.oid))
                 from pg_constraint k where k.conrelid=c.oid and k.contype in ('p','u','c','x') order by k.contype desc, k.conname),
           E',\n'),
         E'\n') as s
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' order by c.relname`,
    // serial 欄位的序列歸屬
    `select format('alter sequence %I.%I owned by %I.%I.%I;', sn.nspname, s.relname, tn.nspname, t.relname, a.attname) as s
       from pg_depend d
       join pg_class s on s.oid=d.objid and s.relkind='S' join pg_namespace sn on sn.oid=s.relnamespace
       join pg_class t on t.oid=d.refobjid join pg_namespace tn on tn.oid=t.relnamespace
       join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid
       where d.classid='pg_class'::regclass and d.refclassid='pg_class'::regclass and d.deptype='a' and sn.nspname='public' order by s.relname`,
    // Storage 儲存桶(收據等)
    `select format('insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (%L, %L, %L, %L, %L) on conflict (id) do nothing;',
         id, name, public, file_size_limit, allowed_mime_types) as s from storage.buckets order by id`,
  ]);

  const post = await part("PART 2 (run AFTER loading data)", [
    `select 'set check_function_bodies = off;' as s`,
    // 外鍵:指到其他 schema(如 auth.users)的用 not valid,因為 auth.users 不在備份內
    `select format('alter table %I.%I add constraint %I %s%s;', n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid),
         case when rn.nspname <> 'public' and pg_get_constraintdef(k.oid) not ilike '%not valid%' then ' not valid' else '' end) as s
       from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
       join pg_class rc on rc.oid=k.confrelid join pg_namespace rn on rn.oid=rc.relnamespace
       where k.contype='f' and n.nspname='public' order by c.relname, k.conname`,
    // 索引(約束自帶的索引除外)
    `select pg_get_indexdef(i.indexrelid) || ';' as s
       from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r'
         and not exists (select 1 from pg_constraint k where k.conindid=i.indexrelid and k.contype in ('p','u','x'))
       order by c.relname, i.indexrelid::regclass::text`,
    // 函式 / RPC / 程序(擴充套件自帶的除外)
    `select pg_get_functiondef(p.oid) || ';' as s
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.prokind in ('f','p')
         and not exists (select 1 from pg_depend d where d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e')
       order by p.proname, p.oid`,
    // 視圖(依建立順序,後建的可依賴先建的)
    `select format('create view %I.%I%s as %s', n.nspname, c.relname,
         case when c.reloptions is not null then ' with (' || array_to_string(c.reloptions, ', ') || ')' else '' end,
         regexp_replace(pg_get_viewdef(c.oid, true), ';\\s*$', '') || ';') as s
       from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' order by c.oid`,
    // 觸發器
    `select pg_get_triggerdef(t.oid) || ';' as s
       from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
       where not t.tgisinternal and n.nspname='public' order by c.relname, t.tgname`,
    // RLS 開關
    `select format('alter table %I.%I enable row level security;', n.nspname, c.relname) || case when c.relforcerowsecurity then format(' alter table %I.%I force row level security;', n.nspname, c.relname) else '' end as s
       from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity order by c.relname`,
    // RLS 政策(public 與 storage)
    `select format('create policy %I on %I.%I as %s for %s to %s%s%s;', policyname, schemaname, tablename, lower(permissive), cmd,
         (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(roles) r),
         case when qual is not null then ' using (' || qual || ')' else '' end,
         case when with_check is not null then ' with check (' || with_check || ')' else '' end) as s
       from pg_policies where schemaname in ('public','storage') order by schemaname, tablename, policyname`,
    // 資料表 / 視圖 / 序列權限(只處理有明確 ACL 的物件:先全部收回再依 ACL 授予)
    `select format('revoke all on %s %I.%I from public, anon, authenticated, service_role;', case when c.relkind='S' then 'sequence' else 'table' end, n.nspname, c.relname) as s
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','v','S') and c.relacl is not null order by c.relname`,
    `select format('grant %s on %s %I.%I to %s;', string_agg(x.privilege_type, ', ' order by x.privilege_type),
         case when c.relkind='S' then 'sequence' else 'table' end, n.nspname, c.relname,
         case when x.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(x.grantee)) end) as s
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       cross join lateral aclexplode(c.relacl) x
       where n.nspname='public' and c.relkind in ('r','v','S') and c.relacl is not null and x.grantee <> c.relowner
       group by n.nspname, c.relname, c.relkind, x.grantee order by c.relname, x.grantee`,
    // 函式權限(RPC 的安全性靠這個:誰能 execute)
    `select format('revoke all on function %I.%I(%s) from public, anon, authenticated, service_role;', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as s
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.prokind in ('f','p') and p.proacl is not null
         and not exists (select 1 from pg_depend d where d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e')
       order by p.proname, p.oid`,
    `select format('grant execute on function %I.%I(%s) to %s;', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
         case when x.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(x.grantee)) end) as s
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(p.proacl) x
       where n.nspname='public' and p.prokind in ('f','p') and p.proacl is not null and x.grantee <> p.proowner
         and not exists (select 1 from pg_depend d where d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e')
       order by p.proname, p.oid, x.grantee`,
    // 序列目前值(資料載入後才設定)
    `select format('select setval(%L, %s, true);', format('%I.%I', schemaname, sequencename), last_value) as s
       from pg_sequences where schemaname='public' and last_value is not null order by sequencename`,
    // Realtime
    `select format('alter publication %I add table %I.%I;', pubname, schemaname, tablename) as s
       from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' order by tablename`,
    // pg_cron 排程。含 x-backup-secret 的任務會遮蔽密碼並改成註解,需手動重建
    `select case when command ~ 'x-backup-secret' then
           '-- MANUAL (secret masked, fill in BACKUP_SECRET and PROJECT_REF yourself):' || E'\n-- ' ||
           replace(format('select cron.schedule(%L, %L, %L);', jobname, schedule,
             regexp_replace(command, '(x-backup-secret''\\s*,\\s*'')[^'']*', '\\1<BACKUP_SECRET>', 'g')), E'\n', E'\n-- ')
         else format('select cron.schedule(%L, %L, %L);', jobname, schedule, command) end as s
       from cron.job order by jobid`,
  ]);

  const header = `-- OT I/O database structure export\n-- exportedAt: ${new Date().toISOString()}\n-- format: ot-db-schema-v1\n` +
    `-- Statements are separated by a line "-- @@". Run PART 1, load the data snapshot, then run PART 2.\n` +
    `-- NOT included: table data, auth.users, Storage files, Edge Functions and their secrets.\n`;
  return header + pre + post;
  });
}
// </schema-export>

Deno.serve(async (req) => {
  const secret = Deno.env.get("BACKUP_SECRET");
  if (!secret || req.headers.get("x-backup-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const file = `${brisbaneDate()}.json.gz`;
  const schemaFile = `${brisbaneDate()}.schema.sql.gz`;
  let schemaBytes = 0;
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
      // 用 for await 逐批讀取:postgres.js 的 cursor(n, 回呼) 寫法不會等最後一批回呼跑完,會讓資料寫在串流關閉之後(JSON 損壞、Edge Runtime 當掉)
      for await (const rows of sql`select to_jsonb(t) as r from public.${sql(table_name)} t`.cursor(BATCH)) {
        for (const { r } of rows as { r: unknown }[]) { await w((firstRow ? "" : ",") + JSON.stringify(r)); firstRow = false; rowCount++; }
      }
      await w("]");
      tableCount++;
    }
    await w("}}");
    await writer.close();
    await pump;
    console.log(`[backup] data dumped: ${tableCount} tables, ${rowCount} rows`);

    bytes = chunks.reduce((s, c) => s + c.length, 0);
    if (bytes > MAX_SIMPLE_UPLOAD) throw new Error(`備份檔 ${bytes} bytes 超過單次上傳上限,需要改用分段上傳`);
    const body = new Uint8Array(bytes);
    let off = 0; for (const c of chunks) { body.set(c, off); off += c.length; }

    const token = await dropboxToken();
    await dropboxUpload(token, `${FOLDER}/${file}`, body);
    console.log(`[backup] data uploaded to ${FOLDER}/${file} (${bytes} bytes)`);

    // 結構匯出:失敗不影響資料備份(資料已上傳),只在 note 留記錄
    try {
      const schemaGz = await gzipText(await exportSchemaSql(sql));
      await dropboxUpload(token, `${FOLDER}/${schemaFile}`, schemaGz);
      schemaBytes = schemaGz.length;
      console.log(`[backup] schema uploaded (${schemaBytes} bytes)`);
    } catch (e) { note = "schema: " + String((e as Error)?.message || e); }

    // 上傳成功後才清舊檔;清理失敗不算備份失敗,只記在 error 欄(ok 仍為 true)
    try { deleted = await cleanupOld(token, Number(Deno.env.get("RETENTION_DAYS") || 90)); }
    catch (e) { note = (note ? note + "; " : "") + "cleanup: " + String((e as Error)?.message || e); }
  } catch (e) {
    error = String((e as Error)?.message || e);
    console.error(`[backup] failed: ${error}`);
  }
  try {
    await sql`insert into public.backup_log (ok, file, bytes, tables, rows, error)
      values (${error === null}, ${`${FOLDER}/${file}`}, ${bytes}, ${tableCount}, ${rowCount}, ${error ?? note})`;
  } catch (_e) { /* 記錄失敗不影響回應 */ }
  await sql.end({ timeout: 5 });
  return new Response(JSON.stringify({ ok: error === null, file: `${FOLDER}/${file}`, bytes, schemaFile: `${FOLDER}/${schemaFile}`, schemaBytes, tables: tableCount, rows: rowCount, deletedOld: deleted, error, note }),
    { status: error === null ? 200 : 500, headers: { "Content-Type": "application/json" } });
});
