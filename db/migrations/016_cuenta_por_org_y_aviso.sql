-- llm-gateway: (1) la cuenta de suscripción se identifica por la organización de Anthropic de cada llamada
-- (cabecera anthropic-organization-id), no por el equipo: así cambiar de cuenta en un equipo no arrastra reglas.
-- (2) reglas con umbral de aviso (limite_aviso) además del límite de corte.
create table if not exists public.suscripcion_cuentas (
  org_id     text primary key,
  cuenta     text not null,
  empresa_id text not null references public.empresas(id)
);
alter table public.suscripcion_cuentas enable row level security;
drop policy if exists suscripcion_cuentas_ver on public.suscripcion_cuentas;
create policy suscripcion_cuentas_ver on public.suscripcion_cuentas for select to authenticated using (gw.puede_ver(empresa_id));
grant select on public.suscripcion_cuentas to authenticated;
grant all on public.suscripcion_cuentas to service_role;
-- Ejemplo (cargar con tus propios org_id):
-- insert into public.suscripcion_cuentas values ('<anthropic-organization-id>', 'alice@example.com', 'acme')
--   on conflict (org_id) do update set cuenta = excluded.cuenta;

alter table public.reglas add column if not exists limite_aviso numeric(18,6) check (limite_aviso >= 0);
