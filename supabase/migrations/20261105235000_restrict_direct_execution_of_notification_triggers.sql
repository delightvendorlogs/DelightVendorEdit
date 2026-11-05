-- Trigger functions are invoked by PostgreSQL triggers, not directly through
-- the public RPC API. Remove direct execution from API roles.
REVOKE EXECUTE ON FUNCTION public.dispatch_customer_push_notification()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_seller_payout()
  FROM PUBLIC, anon, authenticated;
