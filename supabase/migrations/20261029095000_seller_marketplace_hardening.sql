-- DelightVendorEdit seller marketplace hardening
-- Applied to Supabase project genlmqzkjouinofkitqt on 2026-10-29.
-- Prevents a payout from being marked successful more than once and limits
-- marketplace action RPCs to authenticated callers. Admin RPCs still enforce
-- public.is_admin() inside their SECURITY DEFINER function bodies.

CREATE OR REPLACE FUNCTION public.admin_mark_seller_payout_paid(p_payout_id uuid, p_admin_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  p public.seller_payouts%rowtype;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required.';
  END IF;

  SELECT * INTO p
  FROM public.seller_payouts
  WHERE id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout not found.';
  END IF;

  IF p.paid_at IS NOT NULL OR p.status IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'This payout has already been marked successful.';
  END IF;

  IF p.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'This payout is not awaiting payment.';
  END IF;

  UPDATE public.seller_payouts
  SET status = 'approved',
      processed_by = auth.uid(),
      processed_at = now(),
      paid_at = now(),
      admin_note = nullif(trim(p_admin_note), '')
  WHERE id = p.id;

  INSERT INTO public.notifications(recipient_user_id, sender_user_id, title, message, category)
  VALUES (
    p.seller_user_id,
    auth.uid(),
    'Seller payout approved',
    'Your payout of ₦' || p.net_amount::text || ' has been marked paid by the admin.',
    'seller'
  );

  RETURN jsonb_build_object('ok', true, 'status', 'approved');
END
$function$;

REVOKE ALL ON FUNCTION public.admin_mark_seller_payout_paid(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_seller_payout_paid(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_review_seller_application(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_seller_application(uuid,text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_review_seller_payout_change(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_seller_payout_change(uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_seller_product_status(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_seller_product_status(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.purchase_seller_product(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_seller_product(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.request_seller_payout_change(text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_seller_payout_change(text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.seller_delete_listing(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_delete_listing(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.seller_sales_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_sales_orders() TO authenticated;
REVOKE ALL ON FUNCTION public.submit_seller_product(text,text,text,text,text,text,numeric,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_seller_product(text,text,text,text,text,text,numeric,text,text,text,text) TO authenticated;
