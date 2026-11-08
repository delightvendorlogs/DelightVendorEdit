-- Allow seller reviews in half-star increments (1.0 through 5.0).
alter table public.seller_reviews
  alter column rating type numeric(2,1)
  using rating::numeric(2,1);

alter table public.seller_reviews
  drop constraint if exists seller_reviews_rating_check;

alter table public.seller_reviews
  add constraint seller_reviews_rating_check
  check (rating >= 1 and rating <= 5 and rating * 2 = trunc(rating * 2));

drop function if exists public.submit_seller_review(uuid, integer, text);

create function public.submit_seller_review(
  p_order_item_id uuid,
  p_rating numeric,
  p_review_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  i public.order_items%rowtype;
  o public.orders%rowtype;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Please sign in first.';
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 or p_rating * 2 <> trunc(p_rating * 2) then
    raise exception 'Choose a rating from 1 to 5 stars in half-star steps.';
  end if;

  if length(trim(coalesce(p_review_text, ''))) not between 3 and 1500 then
    raise exception 'Write between 3 and 1,500 characters.';
  end if;

  select * into i
  from public.order_items
  where id = p_order_item_id and item_source = 'seller_product'
  for share;

  if not found then
    raise exception 'Seller purchase not found.';
  end if;

  select * into o
  from public.orders
  where id = i.order_id
    and customer_user_id = v_uid
    and payment_status in ('verified', 'paid', 'completed')
    and order_status in ('completed', 'success', 'successful')
    and paid_at is not null;

  if not found or i.fulfillment_status not in ('delivered', 'completed', 'success', 'successful') then
    raise exception 'Only a successfully completed purchase can be reviewed.';
  end if;

  if i.seller_user_id is null then
    raise exception 'Seller details are unavailable.';
  end if;

  insert into public.seller_reviews(
    order_item_id, order_id, product_id, seller_user_id,
    customer_user_id, rating, review_text
  )
  values (
    i.id, i.order_id, i.product_id, i.seller_user_id,
    v_uid, p_rating, trim(p_review_text)
  )
  on conflict (order_item_id) do nothing
  returning id into v_id;

  if v_id is null then
    raise exception 'A review has already been submitted for this purchase.';
  end if;

  return jsonb_build_object('ok', true, 'review_id', v_id, 'status', 'pending');
end
$function$;

revoke all on function public.submit_seller_review(uuid, numeric, text) from public, anon;
grant execute on function public.submit_seller_review(uuid, numeric, text) to authenticated;

notify pgrst, 'reload schema';
