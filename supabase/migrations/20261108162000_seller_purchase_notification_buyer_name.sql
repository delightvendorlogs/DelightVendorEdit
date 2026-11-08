-- Include the buyer's profile display name in the seller's existing purchase notification.
-- No email address or account ID is included in the notification message.
CREATE OR REPLACE FUNCTION public.purchase_seller_product(p_product_id uuid, p_request_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_request uuid := coalesce(p_request_id, gen_random_uuid());
  v_request_row private.seller_purchase_requests%rowtype;
  p public.products%rowtype;
  w public.wallets%rowtype;
  v_inventory public.product_inventory_items%rowtype;
  v_order uuid;
  v_item uuid;
  v_tx uuid;
  v_payout uuid;
  v_fee numeric;
  v_net numeric;
  v_delivery text;
  v_account uuid;
  v_reference text;
  v_result jsonb;
  v_remaining integer := 0;
  v_buyer_name text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Please sign in to purchase.'; END IF;
  IF p_product_id IS NULL THEN RAISE EXCEPTION 'Choose a product to purchase.'; END IF;

  INSERT INTO private.seller_purchase_requests(request_id,buyer_user_id,product_id)
  VALUES(v_request,v_uid,p_product_id) ON CONFLICT(request_id) DO NOTHING;
  SELECT * INTO v_request_row FROM private.seller_purchase_requests WHERE request_id=v_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase request could not be initialized. Please try again.'; END IF;
  IF v_request_row.buyer_user_id<>v_uid OR v_request_row.product_id<>p_product_id THEN RAISE EXCEPTION 'This purchase request is invalid.'; END IF;
  IF v_request_row.result IS NOT NULL THEN RETURN v_request_row.result; END IF;

  SELECT * INTO p FROM public.products WHERE id=p_product_id FOR UPDATE;
  IF NOT FOUND OR p.listing_status<>'published' THEN RAISE EXCEPTION 'This product is no longer available.'; END IF;
  IF p.seller_user_id=v_uid THEN RAISE EXCEPTION 'You cannot purchase your own product.'; END IF;

  SELECT coalesce(nullif(btrim(display_name),''),'A customer') INTO v_buyer_name
  FROM public.profiles WHERE id=v_uid;
  v_buyer_name := coalesce(v_buyer_name,'A customer');

  IF p.delivery_mode='unique' THEN
    SELECT * INTO v_inventory FROM public.product_inventory_items
    WHERE product_id=p.id AND inventory_status='available'
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN
      UPDATE public.products SET listing_status='sold_out',inventory_quantity=0,updated_at=now() WHERE id=p.id;
      v_result:=jsonb_build_object('ok',false,'reason','This product is sold out. No inventory remains.');
      UPDATE private.seller_purchase_requests SET result=v_result WHERE request_id=v_request;
      RETURN v_result;
    END IF;
    v_delivery:=coalesce(v_inventory.private_delivery_payload->>'delivery_info','');
  ELSE
    SELECT delivery_info INTO v_delivery FROM public.seller_product_delivery
    WHERE product_id=p.id AND seller_user_id=p.seller_user_id;
  END IF;

  IF v_delivery IS NULL OR length(trim(v_delivery))=0 THEN RAISE EXCEPTION 'Delivery information is not available. Please contact support.'; END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id=v_uid AND wallet_type='shopping' FOR UPDATE;
  IF NOT FOUND OR w.available_balance<p.price THEN RAISE EXCEPTION 'Insufficient fund, please fund wallet.'; END IF;

  v_fee:=round(p.price*0.10,2);
  v_net:=p.price-v_fee;
  SELECT id INTO v_account FROM public.seller_payout_accounts
  WHERE seller_user_id=p.seller_user_id AND is_default=true ORDER BY created_at DESC LIMIT 1;
  IF v_account IS NULL THEN RAISE EXCEPTION 'Seller payout account is not available. Please contact support.'; END IF;

  v_reference:='DVS-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,14));
  INSERT INTO public.orders(order_number,customer_user_id,order_status,payment_status,subtotal,fees,total,currency,payment_provider,payment_reference,paid_at,completed_at)
  VALUES(v_reference,v_uid,'completed','verified',p.price,0,p.price,'NGN','wallet',v_reference,now(),now())
  RETURNING id INTO v_order;

  INSERT INTO public.order_items(order_id,item_source,product_id,item_title_snapshot,quantity,unit_price,seller_user_id,platform_commission,seller_net_amount,fulfillment_status,delivery_payload)
  VALUES(v_order,'seller_product',p.id,p.title,1,p.price,p.seller_user_id,v_fee,v_net,'delivered',
    jsonb_build_object('delivery_info',v_delivery,'product_id',p.id,'seller_user_id',p.seller_user_id,'sale_mode',p.sale_mode,'delivery_mode',p.delivery_mode))
  RETURNING id INTO v_item;

  IF p.delivery_mode='unique' THEN
    UPDATE public.product_inventory_items
    SET inventory_status='delivered',reserved_for_order_id=v_order,delivered_at=now()
    WHERE id=v_inventory.id;
    SELECT count(*) INTO v_remaining FROM public.product_inventory_items
    WHERE product_id=p.id AND inventory_status='available';
  END IF;

  UPDATE public.wallets SET available_balance=available_balance-p.price,updated_at=now() WHERE id=w.id;

  INSERT INTO public.wallet_transactions(wallet_id,user_id,transaction_type,status,amount,currency,reference,description,related_user_id,related_order_id,metadata,created_at,completed_at)
  VALUES(w.id,v_uid,'purchase','completed',p.price,'NGN',v_reference,'DelightVendorEdit seller marketplace purchase: '||p.title,
    p.seller_user_id,v_order,jsonb_build_object('seller_marketplace',true,'product_id',p.id,'order_item_id',v_item,'platform_fee',v_fee,'seller_payout',v_net),now(),now())
  RETURNING id INTO v_tx;

  INSERT INTO public.seller_payouts(seller_user_id,order_item_id,gross_amount,commission_rate,commission_amount,net_amount,status,payout_account_id)
  VALUES(p.seller_user_id,v_item,p.price,10,v_fee,v_net,'pending',v_account)
  RETURNING id INTO v_payout;

  IF p.sale_mode='single' OR (p.delivery_mode='unique' AND v_remaining=0) THEN
    UPDATE public.products SET listing_status='sold_out',inventory_quantity=CASE WHEN p.delivery_mode='unique' THEN v_remaining ELSE inventory_quantity END,updated_at=now() WHERE id=p.id;
  ELSIF p.delivery_mode='unique' THEN
    UPDATE public.products SET inventory_quantity=v_remaining,updated_at=now() WHERE id=p.id;
  END IF;

  INSERT INTO public.notifications(recipient_user_id,sender_user_id,title,message,category)
  VALUES(v_uid,p.seller_user_id,'Purchase successful','You purchased "'||p.title||'". Open Purchases to view your delivery information.','purchase');
  INSERT INTO public.notifications(recipient_user_id,sender_user_id,title,message,category)
  VALUES(p.seller_user_id,v_uid,'New product sale',v_buyer_name||' just bought your product "'||p.title||'". A payout of ₦'||v_net::text||' is pending.','seller');

  v_result:=jsonb_build_object('ok',true,'order_id',v_order,'order_item_id',v_item,'transaction_id',v_tx,'payout_id',v_payout,
    'price',p.price,'platform_fee',v_fee,'seller_payout',v_net,'delivery_info',v_delivery,'sale_mode',p.sale_mode,
    'delivery_mode',p.delivery_mode,'inventory_remaining',v_remaining,
    'listing_status',CASE WHEN p.sale_mode='single' OR (p.delivery_mode='unique' AND v_remaining=0) THEN 'sold_out' ELSE 'published' END,
    'order_reference',v_reference);
  UPDATE private.seller_purchase_requests SET result=v_result WHERE request_id=v_request;
  RETURN v_result;
END
$function$;