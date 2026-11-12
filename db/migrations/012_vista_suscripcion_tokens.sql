-- llm-gateway: tokens de la suscripción por día, equipo (cliente) y modelo, para la vista «Suscripciones» del panel.
create or replace view public.v_suscripcion_tokens_dia with (security_invoker = true) as
select (k.ts at time zone 'America/Santiago')::date as dia, k.empresa_id, k.cliente_id, c.nombre as cliente, k.modelo,
       count(*) filter (where not k.bloqueado) as llamadas,
       count(*) filter (where k.bloqueado) as bloqueos,
       coalesce(sum(k.tokens_in), 0)::bigint as tokens_in,
       coalesce(sum(k.tokens_out), 0)::bigint as tokens_out,
       coalesce(sum(k.tokens_cache_read), 0)::bigint as tokens_cache_read,
       coalesce(sum(k.tokens_cache_write), 0)::bigint as tokens_cache_write,
       max(k.ts) as ultimo
from public.consumos k join public.clientes c on c.id = k.cliente_id
where k.modo = 'suscripcion' and k.ts >= now() - interval '35 days'
group by 1, 2, 3, 4, 5;
grant select on public.v_suscripcion_tokens_dia to authenticated, service_role;
