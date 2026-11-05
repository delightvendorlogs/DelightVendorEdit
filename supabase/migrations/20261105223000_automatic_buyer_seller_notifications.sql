-- Automatic buyer, seller, payout, application, support and verification notifications.
alter table public.notifications add column if not exists event_key text;
create unique index if not exists notifications_event_key_unique on public.notifications(event_key) where event_key is not null;
create or replace function public.dve_create_event_notification(p_recipient uuid,p_sender uuid,p_title text,p_message text,p_category text,p_event_key text)
returns void language plpgsql security definer set search_path=''
as $$
begin
 if p_recipient is null or nullif(btrim(coalesce(p_title,'')),'') is null or nullif(btrim(coalesce(p_message,'')),'') is null then return; end if;
 insert into public.notifications(recipient_user_id,sender_user_id,title,message,category,event_key,is_read)
 values(p_recipient,p_sender,left(btrim(p_title),180),left(btrim(p_message),4000),p_category,p_event_key,false)
 on conflict(event_key) where event_key is not null do nothing;
end $$;
create or replace function public.dve_notify_order_event()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_item record;
begin
 if new.payment_status='verified' and (tg_op='INSERT' or old.payment_status is distinct from new.payment_status) then
  perform public.dve_create_event_notification(new.customer_user_id,null,'Payment confirmed','Payment for order '||coalesce(new.order_number,new.id::text)||' has been confirmed.','payment','order:'||new.id::text||':payment_verified');
  for v_item in select distinct seller_user_id from public.order_items where order_id=new.id and item_source='seller_product' and seller_user_id is not null loop
   perform public.dve_create_event_notification(v_item.seller_user_id,new.customer_user_id,'New customer order','You have received a new order. Open your seller dashboard to review it.','order','order:'||new.id::text||':seller:'||v_item.seller_user_id::text||':paid');
  end loop;
 end if;
 if new.order_status='processing' and (tg_op='INSERT' or old.order_status is distinct from new.order_status) then
  perform public.dve_create_event_notification(new.customer_user_id,null,'Order processing','Your order '||coalesce(new.order_number,new.id::text)||' is being processed.','order','order:'||new.id::text||':processing');
 elsif new.order_status='completed' and (tg_op='INSERT' or old.order_status is distinct from new.order_status) then
  perform public.dve_create_event_notification(new.customer_user_id,null,'Order completed','Your order '||coalesce(new.order_number,new.id::text)||' has been completed.','order','order:'||new.id::text||':completed');
 elsif new.order_status in ('cancelled','refunded','failed') and (tg_op='INSERT' or old.order_status is distinct from new.order_status) then
  perform public.dve_create_event_notification(new.customer_user_id,null,'Order update','Your order '||coalesce(new.order_number,new.id::text)||' status is now '||replace(new.order_status,'_',' ')||'. Open My Purchases for details.','order','order:'||new.id::text||':'||new.order_status);
 end if;
 return new;
end $$;
create trigger dve_order_notification_trigger after insert or update of payment_status,order_status on public.orders for each row execute function public.dve_notify_order_event();
create or replace function public.dve_notify_order_item_event()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_customer uuid;v_order_number text;
begin
 if new.fulfillment_status in ('delivered','completed') and (tg_op='INSERT' or old.fulfillment_status is distinct from new.fulfillment_status) then
  select customer_user_id,order_number into v_customer,v_order_number from public.orders where id=new.order_id;
  perform public.dve_create_event_notification(v_customer,null,'Order item delivered',coalesce(new.item_title_snapshot,'An item')||' from order '||coalesce(v_order_number,new.order_id::text)||' has been delivered.','order','order-item:'||new.id::text||':delivered');
 end if;
 return new;
end $$;
create trigger dve_order_item_notification_trigger after insert or update of fulfillment_status on public.order_items for each row execute function public.dve_notify_order_item_event();
create or replace function public.dve_notify_seller_application_event()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_admin record;
begin
 if tg_op='INSERT' and new.application_status='pending' then
  for v_admin in select user_id from public.user_roles where lower(role)='admin' loop
   perform public.dve_create_event_notification(v_admin.user_id,new.user_id,'New seller application','A new seller application is waiting for review. Open Seller Control to review it.','seller_application','seller-application:'||new.id::text||':pending:'||v_admin.user_id::text);
  end loop;
 elsif tg_op='UPDATE' and old.application_status is distinct from new.application_status and new.application_status in ('approved','rejected') then
  perform public.dve_create_event_notification(new.user_id,null,case when new.application_status='approved' then 'Seller application approved' else 'Seller application update' end,case when new.application_status='approved' then 'Your seller application has been approved. You can continue setting up your store.' else 'Your seller application was not approved. Check your seller dashboard for the admin note.' end,'seller_application','seller-application:'||new.id::text||':'||new.application_status);
 end if;
 return new;
end $$;
create trigger dve_seller_application_notification_trigger after insert or update of application_status on public.seller_applications for each row execute function public.dve_notify_seller_application_event();
create or replace function public.dve_notify_seller_payout_event()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_admin record;
begin
 if tg_op='INSERT' and new.status='pending' then
  for v_admin in select user_id from public.user_roles where lower(role)='admin' loop
   perform public.dve_create_event_notification(v_admin.user_id,new.seller_user_id,'Seller payout awaiting review','A seller payout request is waiting for admin review.','payout','seller-payout:'||new.id::text||':pending:'||v_admin.user_id::text);
  end loop;
 elsif tg_op='UPDATE' and old.status is distinct from new.status and new.status in ('approved','paid','rejected','failed') then
  perform public.dve_create_event_notification(new.seller_user_id,null,'Seller payout update','Your seller payout status is now '||new.status||'. Open your seller dashboard for details.','payout','seller-payout:'||new.id::text||':'||new.status);
 end if;
 return new;
end $$;
create trigger dve_seller_payout_notification_trigger after insert or update of status on public.seller_payouts for each row execute function public.dve_notify_seller_payout_event();
create or replace function public.dve_notify_support_reply()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_customer uuid;v_preview text;
begin
 if new.sender_role not in ('admin','bot') then return new;end if;
 select customer_user_id into v_customer from public.support_chat_conversations where id=new.conversation_id;
 if v_customer is null then return new;end if;
 v_preview:=nullif(btrim(coalesce(new.message_text,'')),'');
 if v_preview is null then v_preview:='You have a new support message.';else v_preview:=left(v_preview,220);end if;
 perform public.dve_create_event_notification(v_customer,null,case when new.sender_role='bot' then 'Support assistant replied' else 'Support replied' end,v_preview||' Open Live Chat to continue.','support','support-message:'||new.id::text);
 return new;
end $$;
create trigger dve_support_reply_notification_trigger after insert on public.support_chat_messages for each row execute function public.dve_notify_support_reply();
create or replace function public.dve_notify_seller_verification_event()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if old.verification_level is distinct from new.verification_level then
  perform public.dve_create_event_notification(new.user_id,null,'Seller badge updated',case new.verification_level when 'verified' then 'Your store is now marked as a Verified Seller.' when 'trusted' then 'Your store has received the Trusted Seller badge.' when 'top_seller' then 'Your store has received the Top Seller badge.' else 'Your seller verification badge has been removed.' end,'seller','seller-verification:'||new.user_id::text||':'||new.verification_level||':'||coalesce(new.verification_updated_at::text,now()::text));
 end if;
 return new;
end $$;
create trigger dve_seller_verification_notification_trigger after update of verification_level on public.seller_profiles for each row execute function public.dve_notify_seller_verification_event();
revoke all on function public.dve_create_event_notification(uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.dve_notify_order_event() from public,anon,authenticated;
revoke all on function public.dve_notify_order_item_event() from public,anon,authenticated;
revoke all on function public.dve_notify_seller_application_event() from public,anon,authenticated;
revoke all on function public.dve_notify_seller_payout_event() from public,anon,authenticated;
revoke all on function public.dve_notify_support_reply() from public,anon,authenticated;
revoke all on function public.dve_notify_seller_verification_event() from public,anon,authenticated;
