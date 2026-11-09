
create or replace function public.refresh_admin_working_tool_inventory_count()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare v_tool_id uuid;
begin
  v_tool_id := coalesce(new.tool_id, old.tool_id);
  update public.admin_working_tools t
  set available_inventory = (
    select count(*)::integer from public.admin_working_tool_inventory i
    where i.tool_id = v_tool_id and i.inventory_status = 'available'
  ), updated_at = now()
  where t.id = v_tool_id;
  if tg_op = 'UPDATE' and old.tool_id is distinct from new.tool_id then
    update public.admin_working_tools t
    set available_inventory = (
      select count(*)::integer from public.admin_working_tool_inventory i
      where i.tool_id = old.tool_id and i.inventory_status = 'available'
    ), updated_at = now()
    where t.id = old.tool_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function public.refresh_admin_working_tool_inventory_count() from public, anon, authenticated;

drop policy if exists admin_working_tool_inventory_admin_manage on public.admin_working_tool_inventory;
create policy admin_working_tool_inventory_admin_manage
on public.admin_working_tool_inventory for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists admin_working_tool_purchase_requests_admin_manage on public.admin_working_tool_purchase_requests;
create policy admin_working_tool_purchase_requests_admin_manage
on public.admin_working_tool_purchase_requests for all to authenticated
using (public.is_admin()) with check (public.is_admin());
