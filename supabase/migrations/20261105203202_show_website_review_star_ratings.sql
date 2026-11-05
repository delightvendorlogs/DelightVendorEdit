create or replace function public.get_public_website_reviews()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
 select jsonb_build_object(
  'enabled',coalesce((select website_reviews_enabled from public.review_display_settings where id=true),true),
  'reviews',case when coalesce((select website_reviews_enabled from public.review_display_settings where id=true),true)
   then coalesce((
    select jsonb_agg(jsonb_build_object(
      'display_name',display_name,
      'review_text',review_text,
      'rating',rating,
      'created_at',created_at
    ) order by created_at desc)
    from public.website_reviews where status='published'
   ),'[]'::jsonb)
   else '[]'::jsonb
  end
 );
$function$;
