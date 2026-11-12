-- llm-gateway: quién escribió cada llamada de Claude Code de un equipo compartido, en vivo.
-- 1) El proxy guarda la sesión de Claude Code de cada llamada (consumos.sesion).
-- 2) Un colector externo (opcional) sube un registro de autoría:
--    una fila por mensaje con su autor.
-- 3) v_consumo_autor asigna cada llamada al autor del ÚLTIMO mensaje anterior de esa sesión (respeta los traspasos
--    de sesión: si Alice la abre y después la toma Bob, lo que sigue es de Bob). Misma regla que el histórico.
alter table public.consumos add column if not exists sesion text;
create index if not exists consumos_sesion_idx on public.consumos (sesion, ts) where sesion is not null;

create table if not exists public.autoria_mensajes (
  sesion      text not null,
  ts          timestamptz not null,
  empresa_id  text not null references public.empresas(id),
  equipo      text not null default 'default',
  autor       text not null,           -- bob | carol | … | 'carol/bob (sesión compartida)' | 'automático (…)'
  certeza     text,
  cwd         text,
  primary key (sesion, ts, autor)
);
alter table public.autoria_mensajes enable row level security;
drop policy if exists autoria_mensajes_ver on public.autoria_mensajes;
create policy autoria_mensajes_ver on public.autoria_mensajes for select to authenticated using (gw.puede_ver(empresa_id));
grant select on public.autoria_mensajes to authenticated;
grant all on public.autoria_mensajes to service_role;

create or replace view public.v_consumo_autor with (security_invoker = true) as
select k.id, k.ts, k.empresa_id, k.cliente_id, k.modelo, k.sesion, k.bloqueado,
       k.tokens_in, k.tokens_out, k.tokens_cache_read, k.tokens_cache_write,
       coalesce(a.autor, case when c.metadata ? 'equipo_autoria' then 'automático (agente)' end) as usuario,
       a.cwd, c.metadata ->> 'equipo' as equipo
from public.consumos k
join public.clientes c on c.id = k.cliente_id
left join lateral (
  select m.autor, m.cwd from public.autoria_mensajes m
  where m.sesion = k.sesion and m.ts <= k.ts
  order by m.ts desc limit 1
) a on true
where k.modo = 'suscripcion' and k.sesion is not null;
grant select on public.v_consumo_autor to authenticated, service_role;

-- Equipo de cada cliente: clientes.metadata ->> 'equipo' (y 'equipo_autoria' si tiene registro de autoría). Ejemplo:
--   update public.clientes set metadata = metadata || '{"equipo":"laptop-alice"}' where id = '<cliente_id>';

-- La tabla del panel (por equipo, proyecto y usuario) suma el histórico y lo registrado en vivo por el gateway.
create or replace view public.v_suscripcion_historico_proyecto with (security_invoker = true) as
with todo as (
  select h.hora as ts, h.empresa_id, h.cliente_id, h.equipo, coalesce(h.proyecto, h.carpeta) as proyecto,
         nullif(h.usuario, '') as usuario, h.modelo, h.sesion, h.llamadas, h.subagente,
         h.tokens_in, h.tokens_out, h.tokens_cache_read, h.tokens_cache_write
  from public.consumo_historico_suscripcion h
  where h.hora >= now() - interval '120 days'
  union all
  select v.ts, v.empresa_id, v.cliente_id, v.equipo, regexp_replace(v.cwd, '^.*[/\\]', ''),
         v.usuario, v.modelo, v.sesion, (not v.bloqueado)::int, 0,
         v.tokens_in, v.tokens_out, v.tokens_cache_read, v.tokens_cache_write
  from public.v_consumo_autor v
  where v.ts >= now() - interval '120 days'
)
select (t.ts at time zone 'America/Santiago')::date as dia, t.empresa_id, t.cliente_id, c.nombre as cliente,
       coalesce(t.equipo, c.metadata ->> 'equipo', c.nombre) as equipo, coalesce(t.proyecto, 'sin proyecto') as proyecto,
       coalesce(t.usuario, '¿?') as usuario, t.modelo,
       count(distinct t.sesion)::bigint as sesiones, sum(t.llamadas)::bigint as llamadas, sum(t.subagente)::bigint as subagente,
       sum(t.tokens_in)::bigint as tokens_in, sum(t.tokens_out)::bigint as tokens_out,
       sum(t.tokens_cache_read)::bigint as tokens_cache_read, sum(t.tokens_cache_write)::bigint as tokens_cache_write,
       max(t.ts) as ultimo
from todo t join public.clientes c on c.id = t.cliente_id
group by 1, 2, 3, 4, 5, 6, 7, 8;
grant select on public.v_suscripcion_historico_proyecto to authenticated, service_role;
