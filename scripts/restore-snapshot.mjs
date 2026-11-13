// 把每日備份(資料 .json.gz + 結構 .schema.sql.gz)還原到一個「空的」Supabase / Postgres 專案。
// 用法(在自己的電腦,先 npm i postgres):
//   node scripts/restore-snapshot.mjs --db-url "<連線字串>" --schema 2026-11-14.schema.sql.gz --data 2026-11-14.json.gz [--yes]
// 步驟:PART 1(型別/序列/資料表)→ 載入資料 → PART 2(外鍵/索引/函式/觸發器/視圖/RLS/政策/權限/序列值)。
// 每條語句獨立執行,失敗的會列在最後(不會中斷),請逐條檢查。
// 只用在「空專案」或測試專案;目標已有資料表時會中止,除非加 --yes。
import fs from "node:fs";
import zlib from "node:zlib";
import postgres from "postgres";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith("--")) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return a;
}, []));
if (!args["db-url"] || !args.schema || !args.data) {
  console.error('用法: node scripts/restore-snapshot.mjs --db-url "<連線字串>" --schema <x.schema.sql.gz> --data <x.json.gz> [--yes]');
  process.exit(2);
}
const readMaybeGz = (p) => { const b = fs.readFileSync(p); return (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString("utf8"); };

const schemaText = readMaybeGz(args.schema);
const dump = JSON.parse(readMaybeGz(args.data));
if (dump.format !== "ot-db-dump-v1") { console.error("資料檔格式不是 ot-db-dump-v1"); process.exit(2); }

const iPost = schemaText.indexOf("-- ======== PART 2");
if (iPost < 0) { console.error("結構檔找不到 PART 2 標記"); process.exit(2); }
const split = (t) => t.split("\n-- @@\n").map((x) => x.trim()).filter((x) => x && !x.split("\n").every((l) => l.startsWith("--")));
const preStmts = split(schemaText.slice(0, iPost));
const postStmts = split(schemaText.slice(iPost));

const sql = postgres(args["db-url"], { max: 1, prepare: false, onnotice: () => {} });
const failures = [];
const run = async (label, stmts) => {
  let ok = 0;
  for (const st of stmts) {
    try { await sql.unsafe(st); ok++; }
    catch (e) { failures.push({ part: label, error: String(e.message || e), stmt: st.slice(0, 300) }); }
  }
  console.log(`${label}: ${ok}/${stmts.length} 條成功`);
};

try {
  const existing = await sql`select count(*)::int as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`;
  if (existing[0].n > 0 && !args.yes) {
    console.error(`目標 public 已有 ${existing[0].n} 張資料表。這個腳本只用於空專案;確定要繼續請加 --yes。`);
    process.exit(3);
  }

  await run("PART 1(結構,資料前)", preStmts);

  // 載入資料:用 jsonb_populate_recordset,排除 generated 欄位;identity always 用 overriding system value
  let rowsLoaded = 0;
  for (const [table, rows] of Object.entries(dump.tables)) {
    if (!rows.length) continue;
    const cols = await sql`select column_name from information_schema.columns
      where table_schema='public' and table_name=${table} and is_generated='NEVER' order by ordinal_position`;
    if (!cols.length) { failures.push({ part: "data", error: "目標沒有這張表", stmt: table }); continue; }
    const names = cols.map((c) => c.column_name);
    for (let i = 0; i < rows.length; i += 500) {
      try {
        await sql`insert into public.${sql(table)} (${sql(names)}) overriding system value
          select ${sql(names)} from jsonb_populate_recordset(null::public.${sql(table)}, ${sql.json(rows.slice(i, i + 500))})`;
        rowsLoaded += Math.min(500, rows.length - i);
      } catch (e) { failures.push({ part: "data", error: String(e.message || e), stmt: `${table} rows ${i}-${i + 499}` }); }
    }
  }
  console.log(`資料: 載入 ${rowsLoaded} 列(備份內共 ${Object.values(dump.tables).reduce((s, r) => s + r.length, 0)} 列)`);

  await run("PART 2(結構,資料後)", postStmts);
} finally {
  await sql.end({ timeout: 5 });
}

if (failures.length) {
  console.log(`\n有 ${failures.length} 個項目失敗:`);
  for (const f of failures) console.log(`- [${f.part}] ${f.error}\n    ${f.stmt.replace(/\n/g, " ")}`);
  process.exitCode = 1;
} else console.log("\n全部成功");
