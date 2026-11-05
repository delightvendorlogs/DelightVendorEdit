-- Seller verification badges and safe public seller profile data.
alter table public.seller_profiles
 add column if not exists verification_level text not null default 'none',
 add column if not exists verification_note text,
 add column if not exists verification_updated_at timestamptz,
 add column if not exists verification_updated_by uuid references auth.users(id);
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.seller_profiles'::regclass and conname='seller_profiles_verification_level_check') then
  alter table public.seller_profiles add constraint seller_profiles_verification_level_check check(verification_level in ('none','verified','trusted','top_seller'));
 end if;
end $$;
create or replace function public.get_public_seller_profile(p_seller_user_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
 select case when sp.user_id is null then null else jsonb_build_object('user_id',sp.user_id,'business_name',sp.business_name,'verification_level',sp.verification_level,'approved_at',sp.approved_at) end
 from public.seller_profiles sp where sp.user_id=p_seller_user_id and sp.seller_status='approved';
$$;
create or replace function public.dv_admin_set_seller_verification(p_seller_user_id uuid,p_level text,p_note text default null)
returns jsonb language plpgsql security definer set search_path=''
as $$
begin
 if auth.uid() is null or coalesce((select public.is_admin()),false) is not true then raise exception 'Administrator access required.'; end if;
 if p_level not in ('none','verified','trusted','top_seller') then raise exception 'Choose a valid seller badge.'; end if;
 update public.seller_profiles set verification_level=p_level,verification_note=nullif(btrim(coalesce(p_note,'')),''),verification_updated_at=now(),verification_updated_by=auth.uid()
 where user_id=p_seller_user_id and seller_status='approved';
 if not found then raise exception 'Approved seller not found.'; end if;
 return jsonb_build_object('ok',true,'verification_level',p_level);
end $$;
revoke all on function public.get_public_seller_profile(uuid) from public;
grant execute on function public.get_public_seller_profile(uuid) to anon,authenticated;
revoke all on function public.dv_admin_set_seller_verification(uuid,text,text) from public,anon;
grant execute on function public.dv_admin_set_seller_verification(uuid,text,text) to authenticated;
