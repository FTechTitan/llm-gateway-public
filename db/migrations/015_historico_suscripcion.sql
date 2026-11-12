-- llm-gateway: consumo histórico de Claude Code (suscripción) anterior al gateway, sacado de los transcripts
-- de un hub propio (importación opcional). Agregado por equipo (cliente), hora y modelo.
-- No entra en las reglas de uso ni en la vista API: solo en la vista Suscripciones.
create table if not exists public.consumo_historico_suscripcion (
  cliente_id          uuid not null references public.clientes(id) on delete cascade,
  empresa_id          text not null references public.empresas(id),
  hora                timestamptz not null,
  modelo              text not null,
  llamadas            integer not null,
  tokens_in           bigint not null default 0,
  tokens_out          bigint not null default 0,
  tokens_cache_read   bigint not null default 0,
  tokens_cache_write  bigint not null default 0,
  fuente              text not null default 'transcripts',
  primary key (cliente_id, hora, modelo)
);
alter table public.consumo_historico_suscripcion enable row level security;
drop policy if exists historico_suscripcion_ver on public.consumo_historico_suscripcion;
create policy historico_suscripcion_ver on public.consumo_historico_suscripcion for select to authenticated using (gw.puede_ver(empresa_id));
grant select on public.consumo_historico_suscripcion to authenticated;
grant all on public.consumo_historico_suscripcion to service_role;

-- La vista del panel suma lo registrado por el gateway y el histórico (120 días).
create or replace view public.v_suscripcion_tokens_dia with (security_invoker = true) as
with todo as (
  select k.ts, k.empresa_id, k.cliente_id, k.modelo, (not k.bloqueado)::int as llamadas, k.bloqueado::int as bloqueos,
         k.tokens_in, k.tokens_out, k.tokens_cache_read, k.tokens_cache_write
  from public.consumos k
  where k.modo = 'suscripcion' and k.ts >= now() - interval '120 days'
  union all
  select h.hora, h.empresa_id, h.cliente_id, h.modelo, h.llamadas, 0, h.tokens_in, h.tokens_out, h.tokens_cache_read, h.tokens_cache_write
  from public.consumo_historico_suscripcion h
  where h.hora >= now() - interval '120 days'
)
select (t.ts at time zone 'America/Santiago')::date as dia, t.empresa_id, t.cliente_id, c.nombre as cliente, t.modelo,
       sum(t.llamadas)::bigint as llamadas, sum(t.bloqueos)::bigint as bloqueos,
       coalesce(sum(t.tokens_in), 0)::bigint as tokens_in, coalesce(sum(t.tokens_out), 0)::bigint as tokens_out,
       coalesce(sum(t.tokens_cache_read), 0)::bigint as tokens_cache_read, coalesce(sum(t.tokens_cache_write), 0)::bigint as tokens_cache_write,
       max(t.ts) as ultimo
from todo t join public.clientes c on c.id = t.cliente_id
group by 1, 2, 3, 4, 5;
grant select on public.v_suscripcion_tokens_dia to authenticated, service_role;
