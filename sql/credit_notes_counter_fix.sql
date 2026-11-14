-- 修正 Credit Note 編號重複(duplicate key credit_notes_cn_no_key):計數器落後於現有最大編號時,會撞到已存在的編號。
-- 1) 立刻把計數器調到現有最大編號 + 1;2) 建立 / 還原時自動取較大者。可重複執行。
update public.credit_note_counter set next_no = greatest(next_no, coalesce((select max(regexp_replace(cn_no, '\D', '', 'g')::bigint) from public.credit_notes), 0) + 1) where id = 1;

create or replace function public.credit_note_create(p_snapshot jsonb, p_invoice_id text, p_party_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n bigint; v_no text; v_id text := gen_random_uuid()::text; v_snap jsonb; v_who text; v_inv public.invoices%rowtype; v_status text := 'none';
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  if p_invoice_id is not null then
    select * into v_inv from public.invoices where id = p_invoice_id;
    if not found then raise exception 'invoice_not_found'; end if;
    -- 這張 Invoice 的 Credit Note 合計不能超過 Invoice 總額
    if coalesce(v_inv.credited, 0) + coalesce((p_snapshot->>'total')::numeric, 0) > v_inv.total + 0.004 then raise exception 'credit_exceeds'; end if;
  end if;
  select next_no into v_n from public.credit_note_counter where id = 1 for update;
  -- 計數器落後(例如還原備份後)時,往現有最大編號之後接,避免編號重複
  v_n := greatest(coalesce(v_n, 1), coalesce((select max(regexp_replace(cn_no, '\D', '', 'g')::bigint) from public.credit_notes), 0) + 1);
  v_no := 'CN' || lpad(v_n::text, 8, '0');
  update public.credit_note_counter set next_no = v_n + 1 where id = 1;
  v_snap := p_snapshot || jsonb_build_object('no', v_no, 'id', v_id, 'docType', 'credit_note');
  if exists (select 1 from jsonb_array_elements(coalesce(v_snap->'lines', '[]'::jsonb)) l where coalesce((l->>'ret')::boolean, false)) then v_status := 'pending'; end if;
  select username into v_who from public.profiles where id = auth.uid();
  insert into public.credit_notes (id, cn_no, invoice_id, invoice_no, party_id, customer, cn_date, before_tax, tax, total, currency, return_status, snapshot, created_by)
  values (v_id, v_no, p_invoice_id, v_inv.invoice_no, nullif(p_party_id, ''), v_snap #>> '{customer,name}', (v_snap->>'date')::date,
          (v_snap->>'beforeTax')::numeric, (v_snap->>'tax')::numeric, (v_snap->>'total')::numeric, v_snap->>'currency', v_status, v_snap, v_who);
  perform public.credit_note_recalc(p_invoice_id);
  return jsonb_build_object('id', v_id, 'cn_no', v_no);
end $$;

create or replace function public.credit_notes_restore_all(p_rows jsonb, p_next bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.credit_notes where true;
  insert into public.credit_notes select * from jsonb_populate_recordset(null::public.credit_notes, coalesce(p_rows, '[]'::jsonb));
  update public.credit_note_counter set next_no = greatest(coalesce(p_next, 1), 1, coalesce((select max(regexp_replace(cn_no, '\D', '', 'g')::bigint) from public.credit_notes), 0) + 1) where id = 1;
  update public.invoices i set credited = coalesce((select sum(total) from public.credit_notes c where c.invoice_id = i.id), 0) where true;
end $$;

revoke all on function public.credit_notes_restore_all(jsonb, bigint) from public, anon;
grant execute on function public.credit_note_create(jsonb, text, text) to authenticated;
grant execute on function public.credit_notes_restore_all(jsonb, bigint) to authenticated;
