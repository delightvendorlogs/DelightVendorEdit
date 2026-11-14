CREATE OR REPLACE FUNCTION public.seller_delete_listing(
  p_application_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_product uuid;
  v_product_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in.';
  END IF;

  IF p_application_id IS NOT NULL AND p_product_id IS NOT NULL THEN
    RAISE EXCEPTION 'Choose one listing to delete.';
  END IF;

  IF p_application_id IS NOT NULL THEN
    -- Keep an existing product row so all order, sales and payout history
    -- remains connected if the seller deletes its application.
    SELECT id, listing_status
      INTO v_product, v_product_status
      FROM public.products
     WHERE application_id = p_application_id
       AND seller_user_id = v_uid
     FOR UPDATE;

    IF FOUND THEN
      IF v_product_status = 'deleted' THEN
        RAISE EXCEPTION 'This listing has already been deleted.';
      END IF;

      UPDATE public.products
         SET listing_status = 'deleted',
             deleted_at = now(),
             updated_at = now()
       WHERE id = v_product
         AND seller_user_id = v_uid;

      RETURN jsonb_build_object(
        'ok', true,
        'deleted', true,
        'product_id', v_product,
        'sales_history_preserved', true
      );
    END IF;

    SELECT application_status
      INTO v_status
      FROM public.seller_applications
     WHERE id = p_application_id
       AND user_id = v_uid
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Listing not found.';
    END IF;

    DELETE FROM public.seller_applications
     WHERE id = p_application_id
       AND user_id = v_uid;

    RETURN jsonb_build_object('ok', true, 'deleted', true);
  END IF;

  IF p_product_id IS NOT NULL THEN
    SELECT listing_status
      INTO v_product_status
      FROM public.products
     WHERE id = p_product_id
       AND seller_user_id = v_uid
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Listing not found.';
    END IF;

    IF v_product_status = 'deleted' THEN
      RAISE EXCEPTION 'This listing has already been deleted.';
    END IF;

    -- Soft-delete sold and unsold listings alike. Do not hard-delete product
    -- rows because customer order and seller payout history references them.
    UPDATE public.products
       SET listing_status = 'deleted',
           deleted_at = now(),
           updated_at = now()
     WHERE id = p_product_id
       AND seller_user_id = v_uid;

    RETURN jsonb_build_object(
      'ok', true,
      'deleted', true,
      'product_id', p_product_id,
      'sales_history_preserved', true
    );
  END IF;

  RAISE EXCEPTION 'Choose a listing to delete.';
END;
$function$;

REVOKE ALL ON FUNCTION public.seller_delete_listing(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_delete_listing(uuid, uuid) TO authenticated;
