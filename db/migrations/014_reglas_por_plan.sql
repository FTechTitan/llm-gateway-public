-- llm-gateway: reglas según el uso del PLAN de una suscripción (dato de Anthropic / colectores, tabla suscripciones_estado).
--  pct_plan   : se dispara cuando el % usado de la ventana del plan (5h o 7d) llega al límite (ej. 90).
--  ritmo_plan : se dispara cuando vas N puntos por sobre el ritmo del tiempo: % usado − % de la ventana transcurrido >= límite.
--               Ej. límite 10 en la ventana semanal: con 3 de 7 días pasados (43 %), corta al llegar a 53 % usado.
-- Para estas métricas ventana_tipo = 'plan', filtro_plan = id en suscripciones_estado y plan_ventana = '5h' | '7d'.
alter table public.reglas add column if not exists filtro_plan text;
alter table public.reglas add column if not exists plan_ventana text;

alter table public.reglas drop constraint if exists reglas_metrica_check;
alter table public.reglas add constraint reglas_metrica_check
  check (metrica in ('tokens', 'tokens_out', 'costo_usd', 'llamadas', 'pct_plan', 'ritmo_plan'));
alter table public.reglas drop constraint if exists reglas_ventana_tipo_check;
alter table public.reglas add constraint reglas_ventana_tipo_check check (ventana_tipo in ('movil', 'calendario', 'plan'));
alter table public.reglas drop constraint if exists reglas_plan_ventana_check;
alter table public.reglas add constraint reglas_plan_ventana_check check (plan_ventana in ('5h', '7d'));
alter table public.reglas drop constraint if exists reglas_check;
alter table public.reglas add constraint reglas_check check (
  (ventana_tipo = 'movil' and ventana_minutos is not null)
  or (ventana_tipo = 'calendario' and ventana_periodo is not null)
  or (ventana_tipo = 'plan' and metrica in ('pct_plan', 'ritmo_plan') and filtro_plan is not null and plan_ventana is not null));

-- consumo_reglas() solo calcula las reglas de consumo; las del plan las evalúa el proxy con el dato en vivo.
create or replace function public.consumo_reglas()
returns table (regla_id uuid, consumo numeric)
language sql stable security definer set search_path = public as $$
  select r.id,
    coalesce((
      select case r.metrica
               when 'llamadas'   then count(*) filter (where k.tokens_in + k.tokens_out + k.tokens_cache_read + k.tokens_cache_write > 0)::numeric
               when 'tokens_out' then sum(k.tokens_out)::numeric
               when 'costo_usd'  then sum(k.costo_usd + k.costo_equivalente_usd)
               else sum(k.tokens_in + k.tokens_out + k.tokens_cache_write)::numeric
             end
      from public.consumos k
      where k.empresa_id = r.empresa_id
        and not k.bloqueado
        and k.ts >= case
              when r.ventana_tipo = 'movil' then now() - make_interval(mins => r.ventana_minutos)
              else date_trunc(case r.ventana_periodo when 'dia' then 'day' when 'semana' then 'week' else 'month' end,
                              now() at time zone 'America/Santiago') at time zone 'America/Santiago'
            end
        and (r.filtro_cliente_id is null or k.cliente_id = r.filtro_cliente_id)
        and (r.filtro_proveedor is null or k.proveedor = r.filtro_proveedor)
        and (r.filtro_modo is null or k.modo = r.filtro_modo)
        and (r.filtro_modelo is null or k.modelo ilike '%' || r.filtro_modelo || '%')
    ), 0)
  from public.reglas r
  where r.ventana_tipo <> 'plan'
$$;
revoke all on function public.consumo_reglas() from public, anon, authenticated;
grant execute on function public.consumo_reglas() to service_role;
