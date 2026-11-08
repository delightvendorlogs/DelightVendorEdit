create or replace function public.get_public_seller_profile(p_seller_user_id uuid)
returns table (
  user_id uuid,
  business_name text,
  verification_level text,
  seller_award text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    sp.user_id,
    coalesce(sp.business_name, 'Seller')::text,
    coalesce(sp.verification_level, 'none')::text,
    coalesce(sp.seller_award, 'none')::text
  from public.seller_profiles sp
  where sp.user_id = p_seller_user_id
    and sp.seller_status = 'approved'
    and not private.is_seller_restricted(sp.user_id);
$function$;

revoke all on function public.get_public_seller_profile(uuid) from public;
grant execute on function public.get_public_seller_profile(uuid) to anon, authenticated;
