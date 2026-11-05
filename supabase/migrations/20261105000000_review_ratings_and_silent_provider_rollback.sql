alter table public.website_reviews add column if not exists rating smallint not null default 5;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.website_reviews'::regclass and conname='website_reviews_rating_check') then
  alter table public.website_reviews add constraint website_reviews_rating_check check(rating between 1 and 5);
 end if;
end $$;

create or replace function public.submit_website_review(p_order_item_id uuid,p_rating integer,p_review_text text)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_uid uuid:=auth.uid(); i public.order_items%rowtype; o public.orders%rowtype; v_id uuid; v_name text;
begin
 if v_uid is null then raise exception 'Please sign in first.'; end if;
 if p_rating not between 1 and 5 then raise exception 'Choose a rating from 1 to 5 stars.'; end if;
 if length(trim(coalesce(p_review_text,''))) not between 3 and 1200 then raise exception 'Write between 3 and 1,200 characters.'; end if;
 select * into i from public.order_items where id=p_order_item_id and coalesce(item_source,'')<>'seller_product' for share;
 if not found then raise exception 'Website purchase item not found.'; end if;
 select * into o from public.orders where id=i.order_id and customer_user_id=v_uid and payment_status in ('verified','paid','completed') and order_status in ('completed','success','successful') and paid_at is not null;
 if not found or i.fulfillment_status not in ('delivered','completed','success','successful') then raise exception 'Only a successfully completed purchase can be reviewed.'; end if;
 select coalesce(nullif(trim(display_name),''),nullif(split_part(email,'@',1),''),'Customer') into v_name from public.profiles where id=v_uid;
 insert into public.website_reviews(order_id,order_item_id,customer_user_id,display_name,rating,review_text) values(i.order_id,i.id,v_uid,coalesce(v_name,'Customer'),p_rating,trim(p_review_text)) on conflict(order_item_id) do nothing returning id into v_id;
 if v_id is null then raise exception 'A review has already been submitted for this purchase.'; end if;
 return jsonb_build_object('ok',true,'review_id',v_id,'status','pending');
end $function$;

create or replace function public.submit_website_transaction_review(p_transaction_id uuid,p_rating integer,p_review_text text)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare v_uid uuid:=auth.uid(); t public.wallet_transactions%rowtype; v_id uuid; v_name text;
begin
 if v_uid is null then raise exception 'Please sign in first.'; end if;
 if p_rating not between 1 and 5 then raise exception 'Choose a rating from 1 to 5 stars.'; end if;
 if length(trim(coalesce(p_review_text,''))) not between 3 and 1200 then raise exception 'Write between 3 and 1,200 characters.'; end if;
 select * into t from public.wallet_transactions where id=p_transaction_id and user_id=v_uid and transaction_type='purchase' and status='completed' for share;
 if not found then raise exception 'Only a successfully completed website purchase can be reviewed.'; end if;
 if coalesce((t.metadata->>'seller_marketplace')::boolean,false) then raise exception 'Seller marketplace purchases use seller reviews.'; end if;
 select coalesce(nullif(trim(display_name),''),nullif(split_part(email,'@',1),''),'Customer') into v_name from public.profiles where id=v_uid;
 insert into public.website_reviews(wallet_transaction_id,customer_user_id,display_name,rating,review_text) values(t.id,v_uid,coalesce(v_name,'Customer'),p_rating,trim(p_review_text)) on conflict(wallet_transaction_id) where wallet_transaction_id is not null do nothing returning id into v_id;
 if v_id is null then raise exception 'A review has already been submitted for this purchase.'; end if;
 return jsonb_build_object('ok',true,'review_id',v_id,'status','pending');
end $function$;

create or replace function public.submit_website_review(p_order_item_id uuid,p_review_text text)
returns jsonb language sql security definer set search_path to ''
as $function$ select public.submit_website_review(p_order_item_id,5,p_review_text); $function$;
create or replace function public.submit_website_transaction_review(p_transaction_id uuid,p_review_text text)
returns jsonb language sql security definer set search_path to ''
as $function$ select public.submit_website_transaction_review(p_transaction_id,5,p_review_text); $function$;

create or replace function public.discard_failed_product_wallet_purchase(p_transaction_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare t public.wallet_transactions%rowtype; changed integer;
begin
 select * into t from public.wallet_transactions where id=p_transaction_id and transaction_type='purchase' for update;
 if not found then return jsonb_build_object('ok',false,'reason','transaction_missing'); end if;
 if t.status<>'processing' then return jsonb_build_object('ok',false,'reason','already_finalized','status',t.status); end if;
 update public.wallets set available_balance=available_balance+t.amount,updated_at=now() where id=t.wallet_id;
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'The shopping wallet could not be restored.'; end if;
 delete from public.wallet_transactions where id=t.id and status='processing';
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'The pending purchase record could not be safely removed.'; end if;
 return jsonb_build_object('ok',true,'status','rolled_back','amount',t.amount);
end $function$;
revoke all on function public.discard_failed_product_wallet_purchase(uuid) from public,anon,authenticated;
grant execute on function public.discard_failed_product_wallet_purchase(uuid) to service_role;
revoke all on function public.submit_website_review(uuid,integer,text) from public,anon;
grant execute on function public.submit_website_review(uuid,integer,text) to authenticated;
revoke all on function public.submit_website_transaction_review(uuid,integer,text) from public,anon;
grant execute on function public.submit_website_transaction_review(uuid,integer,text) to authenticated;
