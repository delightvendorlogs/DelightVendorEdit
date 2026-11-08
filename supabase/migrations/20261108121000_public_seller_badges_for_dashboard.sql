create or replace function public.get_public_seller_badges(p_seller_user_ids uuid[])
returns table(user_id uuid,business_name text,verification_level text,seller_award text)
language sql
stable
security definer
set search_path=''
as $function$
 select s.user_id,s.business_name,s.verification_level,s.seller_award
 from public.seller_profiles s
 where s.seller_status='approved'
   and s.user_id=any(coalesce(p_seller_user_ids,array[]::uuid[]));
$function$;
grant execute on function public.get_public_seller_badges(uuid[]) to anon,authenticated;