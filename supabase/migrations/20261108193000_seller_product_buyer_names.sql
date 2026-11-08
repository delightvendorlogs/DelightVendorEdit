create or replace function public.seller_product_buyer_names()
returns table (
  product_id uuid,
  buyer_name text,
  purchased_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    oi.product_id,
    coalesce(nullif(btrim(bp.display_name), ''), 'Customer')::text,
    oi.created_at
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.profiles bp on bp.id = o.customer_user_id
  where oi.seller_user_id = (select auth.uid())
    and oi.item_source = 'seller_product'
    and oi.product_id is not null
  order by oi.created_at desc;
$function$;

revoke all on function public.seller_product_buyer_names() from public;
grant execute on function public.seller_product_buyer_names() to authenticated;
