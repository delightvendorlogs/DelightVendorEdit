alter table public.seller_appeals add column if not exists evidence_path text;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('seller-appeal-evidence','seller-appeal-evidence',false,5242880,array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp']::text[];

drop policy if exists seller_appeal_evidence_owner_upload on storage.objects;
create policy seller_appeal_evidence_owner_upload on storage.objects for insert to authenticated
with check (bucket_id='seller-appeal-evidence' and (storage.foldername(name))[1]=(select auth.uid())::text);

drop policy if exists seller_appeal_evidence_owner_or_admin_read on storage.objects;
create policy seller_appeal_evidence_owner_or_admin_read on storage.objects for select to authenticated
using (bucket_id='seller-appeal-evidence' and ((storage.foldername(name))[1]=(select auth.uid())::text or (select public.is_admin())));

drop policy if exists seller_appeal_evidence_owner_delete on storage.objects;
create policy seller_appeal_evidence_owner_delete on storage.objects for delete to authenticated
using (bucket_id='seller-appeal-evidence' and (storage.foldername(name))[1]=(select auth.uid())::text);

create or replace function public.submit_seller_appeal(p_appeal_text text,p_evidence_path text)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare v_type text;
begin
 if auth.uid() is null then raise exception 'Please sign in to submit an appeal.'; end if;
 if length(trim(coalesce(p_appeal_text,'')))<10 then raise exception 'Please explain your appeal in at least 10 characters.'; end if;
 if p_evidence_path is not null and split_part(p_evidence_path,'/',1)<>auth.uid()::text then raise exception 'Invalid appeal evidence file.'; end if;
 select restriction_status into v_type from public.seller_profiles where user_id=auth.uid()
 and (restriction_status='blocked' or (restriction_status='suspended' and restriction_expires_at>now()));
 if v_type is null then raise exception 'There is no active seller restriction to appeal.'; end if;
 insert into public.seller_appeals(seller_user_id,restriction_type,appeal_text,evidence_path)
 values(auth.uid(),v_type,trim(p_appeal_text),p_evidence_path);
 return jsonb_build_object('ok',true,'message','Your appeal has been submitted.');
exception when unique_violation then raise exception 'You already have an appeal awaiting admin review.';
end;$function$;

create or replace function public.submit_seller_appeal(p_appeal_text text)
returns jsonb language sql security definer set search_path=''
as $function$ select public.submit_seller_appeal(p_appeal_text,null::text); $function$;

grant execute on function public.submit_seller_appeal(text,text) to authenticated;
grant execute on function public.submit_seller_appeal(text) to authenticated;
