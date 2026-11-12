-- llm-gateway: límites de la suscripción (Claude Max) leídos de las cabeceras anthropic-ratelimit-* de cada respuesta.
-- Una fila por cliente (equipo) con la última foto; el plan es por cuenta, así que la foto más nueva vale para todos.
create table if not exists public.suscripcion_limites (
  cliente_id  uuid primary key references public.clientes(id) on delete cascade,
  empresa_id  text not null references public.empresas(id),
  ts          timestamptz not null default now(),
  cabeceras   jsonb not null
);
alter table public.suscripcion_limites enable row level security;
drop policy if exists suscripcion_limites_ver on public.suscripcion_limites;
create policy suscripcion_limites_ver on public.suscripcion_limites for select to authenticated using (gw.puede_ver(empresa_id));
grant select on public.suscripcion_limites to authenticated;
grant all on public.suscripcion_limites to service_role;
