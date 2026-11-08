create table if not exists private.referral_pending_profit (
  order_item_id uuid primary key references public.order_items(id) on delete cascade,
  provider_cost numeric(14,2) not null check (provider_cost >= 0),
  customer_price numeric(14,2) not null check (customer_price >= 0),
  created_at timestamptz not null default now()
);

revoke all on table private.referral_pending_profit from public, anon, authenticated;

create or replace function public.queue_referral_profit_for_order_item(
  p_order_item_id uuid,
  p_provider_cost numeric,
  p_customer_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order_status text;
  v_payment_status text;
  v_item_source text;
  v_existing private.referral_pending_profit%rowtype;
  v_result jsonb;
begin
  if p_order_item_id is null or p_provider_cost is null or p_customer_price is null
     or p_provider_cost < 0 or p_customer_price < 0 then
    raise exception 'Invalid provider profit record.';
  end if;

  select o.order_status,o.payment_status,oi.item_source
    into v_order_status,v_payment_status,v_item_source
  from public.order_items oi
  join public.orders o on o.id=oi.order_id
  where oi.id=p_order_item_id;

  if not found then raise exception 'Order item not found.'; end if;
  if v_item_source='seller_product' then
    raise exception 'Marketplace items use their recorded platform commission.';
  end if;

  if lower(coalesce(v_order_status,'')) in ('cancelled','canceled','failed','refunded','rejected') then
    delete from private.referral_pending_profit where order_item_id=p_order_item_id;
    return jsonb_build_object('ok',true,'status','not_eligible');
  end if;

  if lower(coalesce(v_order_status,''))='completed'
     and lower(coalesce(v_payment_status,'')) in ('verified','completed','paid','success') then
    v_result := public.record_referral_profit_for_order_item(p_order_item_id,p_provider_cost,p_customer_price);
    return coalesce(v_result,'{}'::jsonb)||jsonb_build_object('status','recorded');
  end if;

  insert into private.referral_pending_profit(order_item_id,provider_cost,customer_price)
  values(p_order_item_id,round(p_provider_cost,2),round(p_customer_price,2))
  on conflict(order_item_id) do nothing;

  select * into v_existing from private.referral_pending_profit where order_item_id=p_order_item_id;
  if not found then raise exception 'Could not queue referral profit.'; end if;
  if v_existing.provider_cost<>round(p_provider_cost,2)
     or v_existing.customer_price<>round(p_customer_price,2) then
    raise exception 'Referral profit was already queued with different cost values.';
  end if;

  return jsonb_build_object('ok',true,'status','pending');
end;
$function$;

revoke all on function public.queue_referral_profit_for_order_item(uuid,numeric,numeric) from public,anon,authenticated;
grant execute on function public.queue_referral_profit_for_order_item(uuid,numeric,numeric) to service_role;

create or replace function public.process_pending_referral_profit_for_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v record;
begin
  if lower(coalesce(new.order_status,''))='completed'
     and lower(coalesce(new.payment_status,'')) in ('verified','completed','paid','success') then
    for v in
      select p.order_item_id,p.provider_cost,p.customer_price
      from private.referral_pending_profit p
      join public.order_items oi on oi.id=p.order_item_id
      where oi.order_id=new.id
      for update of p
    loop
      perform public.record_referral_profit_for_order_item(v.order_item_id,v.provider_cost,v.customer_price);
      delete from private.referral_pending_profit where order_item_id=v.order_item_id;
    end loop;
  elsif lower(coalesce(new.order_status,'')) in ('cancelled','canceled','failed','refunded','rejected') then
    delete from private.referral_pending_profit p
    using public.order_items oi
    where oi.id=p.order_item_id and oi.order_id=new.id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_process_pending_referral_profit on public.orders;
create trigger trg_process_pending_referral_profit
after update of order_status,payment_status on public.orders
for each row execute function public.process_pending_referral_profit_for_order();
