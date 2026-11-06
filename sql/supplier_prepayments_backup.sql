-- 預付款納入「完整資料備份 / 還原 / 還原預設」。先執行 supplier_prepayments.sql,再執行這支。
-- 還原順序:備份還原會先還原進貨付款(purchase_payments),這會連帶清掉抵扣紀錄;之後再呼叫這裡把預付款和抵扣紀錄整批寫回。

create or replace function public.prepayments_restore_all(p_prepayments jsonb, p_applications jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.prepayment_applications where true;
  delete from public.supplier_prepayments where true;
  insert into public.supplier_prepayments (id, party_id, party_name, pay_date, amount, method, note, forecast_id, forecast_name, created_by, created_at)
  select r->>'id', r->>'party_id', r->>'party_name', (r->>'pay_date')::date, (r->>'amount')::numeric, r->>'method', r->>'note',
         r->>'forecast_id', r->>'forecast_name', r->>'created_by', coalesce(nullif(r->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_prepayments, '[]'::jsonb)) r;
  -- 抵扣紀錄綁著進貨付款(purchase_payment_id):只寫回對應的進貨付款還在的那些
  insert into public.prepayment_applications (id, prepayment_id, purchase_id, purchase_payment_id, apply_date, amount, created_by, created_at)
  select r->>'id', r->>'prepayment_id', r->>'purchase_id', r->>'purchase_payment_id', (r->>'apply_date')::date, (r->>'amount')::numeric,
         r->>'created_by', coalesce(nullif(r->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_applications, '[]'::jsonb)) r
   where exists (select 1 from public.purchase_payments pp where pp.id = r->>'purchase_payment_id');
end $$;

create or replace function public.prepayments_clear_all()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.prepayment_applications where true;
  delete from public.supplier_prepayments where true;
end $$;

grant execute on function public.prepayments_restore_all(jsonb, jsonb) to authenticated;
grant execute on function public.prepayments_clear_all() to authenticated;
