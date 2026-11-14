-- 進貨方管理:新增「聯繫人」(contact)與「編號」(code)欄位,並允許進貨方名稱重複(用編號區分)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行,不影響既有資料。

alter table public.purchase_suppliers add column if not exists contact text;
alter table public.purchase_suppliers add column if not exists code    text;

-- 既有進貨方補上編號 S001、S002…(依名稱排序;已經有編號的不動)
with base as (
  select coalesce(max(nullif(regexp_replace(code, '^S', ''), '')::int), 0) as mx
  from public.purchase_suppliers where code ~ '^S[0-9]+$'
), todo as (
  select id, row_number() over (order by lower(name), id) as rn
  from public.purchase_suppliers where code is null or code = ''
)
update public.purchase_suppliers s
   set code = 'S' || lpad((base.mx + todo.rn)::text, 3, '0')
  from todo, base
 where s.id = todo.id;

-- 移除「名稱不能重複」的唯一限制(原本資料庫有擋,現在名稱可以重複,例如同一個商家、不同地址)
do $$
declare r record;
begin
  for r in
    select i.indexrelid::regclass::text as idx, c.conname
    from pg_index i
    left join pg_constraint c on c.conindid = i.indexrelid and c.contype = 'u'
    where i.indrelid = 'public.purchase_suppliers'::regclass
      and i.indisunique and not i.indisprimary
      and pg_get_indexdef(i.indexrelid) ~* '\mname\M'
      and pg_get_indexdef(i.indexrelid) !~* '\mcode\M'
  loop
    if r.conname is not null then
      execute format('alter table public.purchase_suppliers drop constraint %I', r.conname);
    else
      execute format('drop index if exists %s', r.idx);
    end if;
  end loop;
end $$;

-- 編號本身不能重複(允許空白,舊資料補號前)
create unique index if not exists purchase_suppliers_code_uq on public.purchase_suppliers (code) where code is not null and code <> '';
