alter table public.seller_applications
  add column if not exists product_video_path text;

alter table public.products
  add column if not exists product_video_path text;

create table if not exists public.working_tool_inventory (
  tool_id text primary key,
  tool_name text not null,
  provider_price numeric(14,2) not null check (provider_price >= 0),
  delivery_payload jsonb not null,
  inventory_status text not null default 'available' check (inventory_status in ('available','disabled')),
  source_transaction_id uuid,
  purchased_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.working_tool_inventory enable row level security;
revoke all on table public.working_tool_inventory from anon, authenticated;
grant all on table public.working_tool_inventory to service_role;

create or replace function public.submit_seller_product_with_video(
  p_name text,
  p_email text,
  p_product_name text,
  p_description text,
  p_image_path text,
  p_delivery_info text,
  p_price numeric,
  p_bank_name text,
  p_account_name text,
  p_account_number text,
  p_requested_sale_mode text,
  p_delivery_mode text default 'reusable',
  p_video_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_application_id uuid;
begin
  if v_uid is null then
    raise exception 'Please sign in to submit a product.';
  end if;
  if nullif(trim(coalesce(p_video_path,'')),'') is not null
     and left(p_video_path,length(v_uid::text)+1) <> v_uid::text || '/' then
    raise exception 'Invalid product video path.';
  end if;

  v_result := public.submit_seller_product(
    p_name,p_email,p_product_name,p_description,p_image_path,p_delivery_info,
    p_price,p_bank_name,p_account_name,p_account_number,p_requested_sale_mode,p_delivery_mode
  );
  v_application_id := nullif(v_result->>'application_id','')::uuid;
  if v_application_id is null then
    raise exception 'The product application could not be saved.';
  end if;

  update public.seller_applications
  set product_video_path = nullif(trim(coalesce(p_video_path,'')),''),
      updated_at = now()
  where id = v_application_id and user_id = v_uid;

  return v_result;
end;
$function$;

revoke all on function public.submit_seller_product_with_video(text,text,text,text,text,text,numeric,text,text,text,text,text,text) from public;
grant execute on function public.submit_seller_product_with_video(text,text,text,text,text,text,numeric,text,text,text,text,text,text) to authenticated;

create or replace function public.copy_seller_application_video_to_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.application_id is not null and new.product_video_path is null then
    select a.product_video_path
      into new.product_video_path
    from public.seller_applications a
    where a.id = new.application_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_copy_seller_application_video_to_product on public.products;
create trigger trg_copy_seller_application_video_to_product
before insert on public.products
for each row execute function public.copy_seller_application_video_to_product();

update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array[
      'image/jpeg','image/png','image/webp',
      'video/mp4','video/webm','video/quicktime'
    ]
where id = 'seller-product-images';
