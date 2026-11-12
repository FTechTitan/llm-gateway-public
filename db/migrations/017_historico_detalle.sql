-- llm-gateway: el histórico de suscripción pasa a una fila por equipo, hora, modelo y SESIÓN, con proyecto,
-- usuario (según el hub), subagente y carpeta. Las filas antiguas (sin sesión) se reemplazan al recargar.
alter table public.consumo_historico_suscripcion add column if not exists sesion text not null default '';
alter table public.consumo_historico_suscripcion add column if not exists equipo text;
alter table public.consumo_historico_suscripcion add column if not exists proyecto text;
alter table public.consumo_historico_suscripcion add column if not exists proyecto_nombre text;
alter table public.consumo_historico_suscripcion add column if not exists usuario text;
alter table public.consumo_historico_suscripcion add column if not exists titulo text;
alter table public.consumo_historico_suscripcion add column if not exists carpeta text;
alter table public.consumo_historico_suscripcion add column if not exists subagente integer not null default 0;
alter table public.consumo_historico_suscripcion drop constraint if exists consumo_historico_suscripcion_pkey;
alter table public.consumo_historico_suscripcion add primary key (cliente_id, hora, modelo, sesion);

-- Resumen por día, equipo, proyecto, usuario y modelo para la tabla del panel (120 días).
create or replace view public.v_suscripcion_historico_proyecto with (security_invoker = true) as
select (h.hora at time zone 'America/Santiago')::date as dia, h.empresa_id, h.cliente_id, c.nombre as cliente,
       coalesce(h.equipo, c.nombre) as equipo, coalesce(h.proyecto, h.carpeta, 'sin proyecto') as proyecto,
       coalesce(nullif(h.usuario, ''), '¿?') as usuario, h.modelo,
       count(distinct h.sesion)::bigint as sesiones, sum(h.llamadas)::bigint as llamadas, sum(h.subagente)::bigint as subagente,
       sum(h.tokens_in)::bigint as tokens_in, sum(h.tokens_out)::bigint as tokens_out,
       sum(h.tokens_cache_read)::bigint as tokens_cache_read, sum(h.tokens_cache_write)::bigint as tokens_cache_write,
       max(h.hora) as ultimo
from public.consumo_historico_suscripcion h join public.clientes c on c.id = h.cliente_id
where h.hora >= now() - interval '120 days'
group by 1, 2, 3, 4, 5, 6, 7, 8;
grant select on public.v_suscripcion_historico_proyecto to authenticated, service_role;
