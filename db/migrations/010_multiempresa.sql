-- llm-gateway: usuarios del panel con acceso a varias empresas.
-- perfiles.empresa_id sigue siendo la empresa principal (null = superadmin); empresas_extra suma otras.
alter table public.perfiles add column if not exists empresas_extra text[] not null default '{}';

create or replace function gw.mis_empresas() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_remove(array[empresa_id] || empresas_extra, null), '{}') from public.perfiles where user_id = auth.uid()
$$;

create or replace function gw.puede_ver(e text) returns boolean
language sql stable as $$
  select auth.uid() is not null and (gw.es_superadmin() or e = any(coalesce(gw.mis_empresas(), '{}')))
$$;
grant execute on function gw.mis_empresas() to authenticated, service_role;
