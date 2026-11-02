-- DelightVendorEdit dashboard promotional banners
create table if not exists public.dashboard_banners (
 id uuid primary key default gen_random_uuid(),
 image_url text not null,
 storage_path text not null,
 destination_url text not null,
 button_text text,
 alt_text text,
 is_active boolean not null default true,
 display_order integer not null default 0,
 deleted_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.dashboard_banners enable row level security;
grant select on public.dashboard_banners to anon, authenticated;
grant insert, update, delete on public.dashboard_banners to authenticated;
drop policy if exists "Public can view active dashboard banners" on public.dashboard_banners;
create policy "Public can view active dashboard banners" on public.dashboard_banners for select to anon, authenticated using (is_active = true and deleted_at is null);
drop policy if exists "Admins can manage dashboard banners" on public.dashboard_banners;
create policy "Admins can manage dashboard banners" on public.dashboard_banners for all to authenticated using (public.is_admin()) with check (public.is_admin());
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('dashboard-banners','dashboard-banners',true,8388608,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=true,file_size_limit=8388608,allowed_mime_types=array['image/jpeg','image/png','image/webp'];
drop policy if exists "Public can view dashboard banner images" on storage.objects;
create policy "Public can view dashboard banner images" on storage.objects for select to public using (bucket_id='dashboard-banners');
drop policy if exists "Admins can upload dashboard banner images" on storage.objects;
create policy "Admins can upload dashboard banner images" on storage.objects for insert to authenticated with check (bucket_id='dashboard-banners' and public.is_admin());
drop policy if exists "Admins can update dashboard banner images" on storage.objects;
create policy "Admins can update dashboard banner images" on storage.objects for update to authenticated using (bucket_id='dashboard-banners' and public.is_admin()) with check (bucket_id='dashboard-banners' and public.is_admin());
drop policy if exists "Admins can delete dashboard banner images" on storage.objects;
create policy "Admins can delete dashboard banner images" on storage.objects for delete to authenticated using (bucket_id='dashboard-banners' and public.is_admin());
