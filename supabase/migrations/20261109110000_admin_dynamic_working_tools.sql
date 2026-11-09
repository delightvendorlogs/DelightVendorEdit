create table if not exists public.admin_working_tools (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 2 and 180),
  description text not null default '',
  image_path text,
  video_path text,
  price numeric(14,2) not null check (price > 0),
  available_inventory integer not null default 0 check (available_inventory >= 0),
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_working_tools_one_media check ((image_path is not null) <> (video_path is not null))
);
create index if not exists admin_working_tools_public_order_idx
  on public.admin_working_tools (is_active, display_order, created_at desc);

create table if not exists public.admin_working_tool_inventory (
  id uuid primary key default gen_random_uuid(),
  tool_id uuid not null references public.admin_working_tools(id) on delete cascade,
  delivery_payload text not null check (length(trim(delivery_payload)) > 0),
  inventory_status text not null default 'available' check (inventory_status in ('available','sold')),
  purchased_by uuid references auth.users(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  sold_at timestamptz
);
create index if not exists admin_working_tool_inventory_available_idx
  on public.admin_working_tool_inventory (tool_id, created_at, id)
  where inventory_status = 'available';

create table if not exists public.admin_working_tool_purchase_requests (
  request_id uuid primary key,
  buyer_user_id uuid not null references auth.users(id) on delete cascade,
  tool_id uuid not null references public.admin_working_tools(id) on delete cascade,
  result jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_working_tools enable row level security;
alter table public.admin_working_tool_inventory enable row level security;
alter table public.admin_working_tool_purchase_requests enable row level security;
revoke all on public.admin_working_tool_inventory from anon, authenticated;
revoke all on public.admin_working_tool_purchase_requests from anon, authenticated;
grant all on public.admin_working_tool_inventory to service_role;
grant all on public.admin_working_tool_purchase_requests to service_role;
grant select on public.admin_working_tools to anon, authenticated;
grant insert, update, delete on public.admin_working_tools to authenticated;

drop policy if exists admin_working_tools_public_read on public.admin_working_tools;
create policy admin_working_tools_public_read on public.admin_working_tools
  for select to anon, authenticated using (is_active = true or public.is_admin());
drop policy if exists admin_working_tools_admin_manage on public.admin_working_tools;
create policy admin_working_tools_admin_manage on public.admin_working_tools
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.refresh_admin_working_tool_inventory_count()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare v_tool_id uuid;
begin
  v_tool_id := coalesce(new.tool_id, old.tool_id);
  update public.admin_working_tools t
  set available_inventory = (
    select count(*)::integer from public.admin_working_tool_inventory i
    where i.tool_id = v_tool_id and i.inventory_status = 'available'
  ), updated_at = now()
  where t.id = v_tool_id;
  if tg_op = 'UPDATE' and old.tool_id is distinct from new.tool_id then
    update public.admin_working_tools t
    set available_inventory = (
      select count(*)::integer from public.admin_working_tool_inventory i
      where i.tool_id = old.tool_id and i.inventory_status = 'available'
    ), updated_at = now()
    where t.id = old.tool_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function public.refresh_admin_working_tool_inventory_count() from public, anon, authenticated;

drop trigger if exists trg_refresh_admin_working_tool_inventory_count on public.admin_working_tool_inventory;
create trigger trg_refresh_admin_working_tool_inventory_count
after insert or update or delete on public.admin_working_tool_inventory
for each row execute function public.refresh_admin_working_tool_inventory_count();

create or replace function public.admin_add_working_tool_inventory(p_tool_id uuid, p_payloads text[])
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_payload text; v_added integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Admin access required.'; end if;
  if p_tool_id is null or not exists(select 1 from public.admin_working_tools where id=p_tool_id) then
    raise exception 'Working Tool not found.';
  end if;
  foreach v_payload in array coalesce(p_payloads, array[]::text[]) loop
    if length(trim(coalesce(v_payload,''))) > 0 then
      insert into public.admin_working_tool_inventory(tool_id,delivery_payload) values(p_tool_id,trim(v_payload));
      v_added := v_added + 1;
    end if;
  end loop;
  return jsonb_build_object('ok',true,'added',v_added);
end;
$function$;

create or replace function public.admin_list_working_tool_inventory(p_tool_id uuid default null)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_items jsonb;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Admin access required.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'tool_id',i.tool_id,'delivery_payload',i.delivery_payload,
    'inventory_status',i.inventory_status,'purchased_by',i.purchased_by,
    'order_id',i.order_id,'created_at',i.created_at,'sold_at',i.sold_at
  ) order by i.created_at desc),'[]'::jsonb)
  into v_items
  from public.admin_working_tool_inventory i
  where p_tool_id is null or i.tool_id=p_tool_id;
  return v_items;
end;
$function$;

create or replace function public.admin_remove_working_tool_inventory(p_inventory_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare v_deleted integer;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Admin access required.'; end if;
  delete from public.admin_working_tool_inventory where id=p_inventory_id and inventory_status='available';
  get diagnostics v_deleted = row_count;
  if v_deleted=0 then raise exception 'Only available inventory can be removed.'; end if;
  return jsonb_build_object('ok',true);
end;
$function$;

create or replace function public.purchase_admin_working_tool(p_tool_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_request public.admin_working_tool_purchase_requests%rowtype;
  v_tool public.admin_working_tools%rowtype;
  v_inventory public.admin_working_tool_inventory%rowtype;
  v_wallet public.wallets%rowtype;
  v_order uuid; v_order_number text; v_item uuid; v_tx uuid; v_reference text; v_result jsonb;
begin
  if v_uid is null then raise exception 'Please sign in to purchase.'; end if;
  if p_tool_id is null or p_request_id is null then raise exception 'A Working Tool and request ID are required.'; end if;
  insert into public.admin_working_tool_purchase_requests(request_id,buyer_user_id,tool_id)
  values(p_request_id,v_uid,p_tool_id) on conflict(request_id) do nothing;
  select * into v_request from public.admin_working_tool_purchase_requests
  where request_id=p_request_id for update;
  if not found or v_request.buyer_user_id<>v_uid or v_request.tool_id<>p_tool_id then
    raise exception 'This purchase request is invalid.';
  end if;
  if v_request.result is not null then return v_request.result; end if;
  select * into v_tool from public.admin_working_tools where id=p_tool_id and is_active=true for update;
  if not found then raise exception 'This Working Tool is unavailable.'; end if;
  select * into v_inventory from public.admin_working_tool_inventory
  where tool_id=p_tool_id and inventory_status='available'
  order by created_at,id for update skip locked limit 1;
  if not found then
    v_result:=jsonb_build_object('ok',false,'reason','This Working Tool is sold out. No inventory remains.');
    update public.admin_working_tool_purchase_requests set result=v_result where request_id=p_request_id;
    return v_result;
  end if;
  select * into v_wallet from public.wallets where user_id=v_uid and wallet_type='shopping' for update;
  if not found then raise exception 'Shopping wallet not found. Please contact support.'; end if;
  if v_wallet.available_balance<v_tool.price then raise exception 'Insufficient funds in your shopping wallet.'; end if;
  v_reference:='DVE-WT-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,18));
  insert into public.orders(customer_user_id,order_status,payment_status,subtotal,fees,total,currency,payment_provider,payment_reference,paid_at,completed_at)
  values(v_uid,'completed','verified',v_tool.price,0,v_tool.price,'NGN','wallet',v_reference,now(),now())
  returning id,order_number into v_order,v_order_number;
  insert into public.order_items(order_id,item_source,provider_section,provider_item_reference,item_title_snapshot,quantity,unit_price,platform_commission,seller_net_amount,fulfillment_status,delivery_payload)
  values(v_order,'admin_working_tool','working-tools',p_tool_id::text,v_tool.title,1,v_tool.price,0,0,'delivered',
    jsonb_build_object('delivery_info',v_inventory.delivery_payload,'admin_working_tool_id',p_tool_id,'title',v_tool.title))
  returning id into v_item;
  update public.admin_working_tool_inventory set inventory_status='sold',purchased_by=v_uid,order_id=v_order,sold_at=now() where id=v_inventory.id;
  update public.wallets set available_balance=available_balance-v_tool.price,updated_at=now() where id=v_wallet.id;
  insert into public.wallet_transactions(wallet_id,user_id,transaction_type,status,amount,currency,reference,description,related_order_id,metadata,created_at,completed_at)
  values(v_wallet.id,v_uid,'purchase','completed',v_tool.price,'NGN',v_reference,
    'DelightVendorEdit Working Tools purchase: '||v_tool.title,v_order,
    jsonb_build_object('category','working-tools','admin_working_tool',true,'tool_id',p_tool_id,'title',v_tool.title,'order_item_id',v_item),now(),now())
  returning id into v_tx;
  v_result:=jsonb_build_object('ok',true,'order_id',v_order,'order_number',v_order_number,'order_item_id',v_item,
    'transaction_id',v_tx,'price',v_tool.price,'delivery_info',v_inventory.delivery_payload,
    'inventory_remaining',greatest(v_tool.available_inventory-1,0),'reference',v_reference);
  update public.admin_working_tool_purchase_requests set result=v_result where request_id=p_request_id;
  return v_result;
end;
$function$;

revoke all on function public.admin_add_working_tool_inventory(uuid,text[]) from public,anon;
revoke all on function public.admin_list_working_tool_inventory(uuid) from public,anon;
revoke all on function public.admin_remove_working_tool_inventory(uuid) from public,anon;
revoke all on function public.purchase_admin_working_tool(uuid,uuid) from public,anon;
grant execute on function public.admin_add_working_tool_inventory(uuid,text[]) to authenticated;
grant execute on function public.admin_list_working_tool_inventory(uuid) to authenticated;
grant execute on function public.admin_remove_working_tool_inventory(uuid) to authenticated;
grant execute on function public.purchase_admin_working_tool(uuid,uuid) to authenticated;

alter table public.order_items drop constraint if exists order_items_item_source_check;
alter table public.order_items add constraint order_items_item_source_check
check (item_source = any (array['seller_product','thegiftunc_service','logsplug_log','xclusiveplugs_tool','admin_working_tool']::text[]));

update storage.buckets set file_size_limit=52428800,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime']
where id='seller-product-images';
