alter table public.admin_working_tools
  add column if not exists inventory_mode text not null default 'tracked';

alter table public.admin_working_tools
  drop constraint if exists admin_working_tools_inventory_mode_check;
alter table public.admin_working_tools
  add constraint admin_working_tools_inventory_mode_check
  check (inventory_mode in ('tracked','unlimited'));

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
  v_delivery text;
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

  select * into v_tool from public.admin_working_tools
  where id=p_tool_id and is_active=true for update;
  if not found then raise exception 'This Working Tool is unavailable.'; end if;

  if v_tool.inventory_mode='unlimited' then
    -- Reusable listing: charge every buyer, but never consume or mark inventory as sold.
    v_delivery := coalesce(nullif(trim(v_tool.description),''),'This is a reusable Working Tool. Its tutorial remains available on the Working Tools page.');
  else
    select * into v_inventory from public.admin_working_tool_inventory
    where tool_id=p_tool_id and inventory_status='available'
    order by created_at,id for update skip locked limit 1;
    if not found then
      v_result:=jsonb_build_object('ok',false,'reason','This Working Tool is sold out. No inventory remains.');
      update public.admin_working_tool_purchase_requests set result=v_result where request_id=p_request_id;
      return v_result;
    end if;
    v_delivery:=v_inventory.delivery_payload;
  end if;

  select * into v_wallet from public.wallets
  where user_id=v_uid and wallet_type='shopping' for update;
  if not found then raise exception 'Shopping wallet not found. Please contact support.'; end if;
  if v_wallet.available_balance<v_tool.price then raise exception 'Insufficient funds in your shopping wallet.'; end if;

  v_reference:='DVE-WT-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,18));
  insert into public.orders(customer_user_id,order_status,payment_status,subtotal,fees,total,currency,payment_provider,payment_reference,paid_at,completed_at)
  values(v_uid,'completed','verified',v_tool.price,0,v_tool.price,'NGN','wallet',v_reference,now(),now())
  returning id,order_number into v_order,v_order_number;

  insert into public.order_items(order_id,item_source,provider_section,provider_item_reference,item_title_snapshot,quantity,unit_price,platform_commission,seller_net_amount,fulfillment_status,delivery_payload)
  values(v_order,'admin_working_tool','working-tools',p_tool_id::text,v_tool.title,1,v_tool.price,0,0,'delivered',
    jsonb_build_object('delivery_info',v_delivery,'admin_working_tool_id',p_tool_id,'title',v_tool.title,'inventory_mode',v_tool.inventory_mode))
  returning id into v_item;

  if v_tool.inventory_mode='tracked' then
    update public.admin_working_tool_inventory
    set inventory_status='sold',purchased_by=v_uid,order_id=v_order,sold_at=now()
    where id=v_inventory.id;
  end if;

  update public.wallets
  set available_balance=available_balance-v_tool.price,updated_at=now()
  where id=v_wallet.id;

  insert into public.wallet_transactions(wallet_id,user_id,transaction_type,status,amount,currency,reference,description,related_order_id,metadata,created_at,completed_at)
  values(v_wallet.id,v_uid,'purchase','completed',v_tool.price,'NGN',v_reference,
    'DelightVendorEdit Working Tools purchase: '||v_tool.title,v_order,
    jsonb_build_object('category','working-tools','admin_working_tool',true,'tool_id',p_tool_id,'title',v_tool.title,'order_item_id',v_item,'inventory_mode',v_tool.inventory_mode),now(),now())
  returning id into v_tx;

  v_result:=jsonb_build_object('ok',true,'order_id',v_order,'order_number',v_order_number,'order_item_id',v_item,
    'transaction_id',v_tx,'price',v_tool.price,'delivery_info',v_delivery,
    'inventory_remaining',case when v_tool.inventory_mode='unlimited' then null else greatest(v_tool.available_inventory-1,0) end,
    'inventory_mode',v_tool.inventory_mode,'reference',v_reference);
  update public.admin_working_tool_purchase_requests set result=v_result where request_id=p_request_id;
  return v_result;
end;
$function$;

revoke all on function public.purchase_admin_working_tool(uuid,uuid) from public,anon;
grant execute on function public.purchase_admin_working_tool(uuid,uuid) to authenticated;
