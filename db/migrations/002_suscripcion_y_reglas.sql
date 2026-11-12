-- llm-gateway 002: modo suscripción (OAuth de Claude Code pasa sin tocarse) y reglas de uso arbitrarias.
-- Aplicar con psql sobre la base del gateway ANTES de desplegar el proxy de la rama feat/suscripcion.

-- ---------- Consumos: modo, costo equivalente y bloqueos ----------
alter table public.consumos add column if not exists modo text not null default 'api';
alter table public.consumos drop constraint if exists consumos_modo_check;
alter table public.consumos add constraint consumos_modo_check check (modo in ('api', 'suscripcion'));
-- En suscripción no hay gasto real: lo que costaría por API va aquí y no consume el presupuesto en USD.
alter table public.consumos add column if not exists costo_equivalente_usd numeric(14,6) not null default 0;
alter table public.consumos add column if not exists bloqueado boolean not null default false;
alter table public.consumos add column if not exists motivo text;
create index if not exists consumos_empresa_modo_ts_idx on public.consumos (empresa_id, modo, ts desc);

-- ---------- Reglas ----------
-- Se dispara cuando el consumo de la ventana (con sus filtros) llega al límite.
-- Límite 0 = se dispara siempre dentro del horario (bloquear franjas).
create table if not exists public.reglas (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        text not null references public.empresas(id),
  nombre            text not null,
  activa            boolean not null default true,
  metrica           text not null check (metrica in ('tokens', 'tokens_out', 'costo_usd', 'llamadas')),
  limite            numeric(18,6) not null check (limite >= 0),
  accion            text not null check (accion in ('avisar', 'cortar')),
  ventana_tipo      text not null check (ventana_tipo in ('movil', 'calendario')),
  ventana_minutos   integer check (ventana_minutos between 1 and 525600),
  ventana_periodo   text check (ventana_periodo in ('dia', 'semana', 'mes')),
  filtro_cliente_id uuid references public.clientes(id) on delete cascade,
  filtro_proveedor  text check (filtro_proveedor in ('openai', 'anthropic')),
  filtro_modo       text check (filtro_modo in ('api', 'suscripcion')),
  filtro_modelo     text,
  horario_dias      smallint[],                 -- 0 = domingo … 6 = sábado (hora de Chile)
  horario_desde     time,
  horario_hasta     time,
  creada            timestamptz not null default now(),
  actualizada       timestamptz not null default now(),
  check ((ventana_tipo = 'movil' and ventana_minutos is not null) or (ventana_tipo = 'calendario' and ventana_periodo is not null))
);
create index if not exists reglas_empresa_idx on public.reglas (empresa_id);

alter table public.reglas enable row level security;
drop policy if exists reglas_ver on public.reglas;
create policy reglas_ver on public.reglas for select to authenticated using (gw.puede_ver(empresa_id));
grant select on public.reglas to authenticated;
grant all on public.reglas to service_role;

-- Consumo actual de cada regla en su ventana. Lo usa el proxy cada pocos segundos (service_role).
-- tokens = entrada + salida + caché escrita; llamadas = respuestas con tokens; costo = real + equivalente.
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
$$;
revoke all on function public.consumo_reglas() from public, anon, authenticated;
grant execute on function public.consumo_reglas() to service_role;

-- ---------- Vistas: excluir bloqueos y agregar modo (columnas nuevas al final) ----------
create or replace view public.v_consumo_mes_cliente with (security_invoker = true) as
select c.id as cliente_id, c.empresa_id, c.nombre, c.presupuesto_usd_mensual, c.activo,
       coalesce(sum(k.costo_usd), 0)::numeric(14,6) as gastado_mes,
       count(k.id) as llamadas_mes,
       case when c.presupuesto_usd_mensual > 0
            then greatest(c.presupuesto_usd_mensual - coalesce(sum(k.costo_usd),0), 0) end as restante
from public.clientes c
left join public.consumos k on k.cliente_id = c.id and not k.bloqueado
  and k.ts >= date_trunc('month', now() at time zone 'America/Santiago') at time zone 'America/Santiago'
group by c.id;

create or replace view public.v_consumo_diario with (security_invoker = true) as
select (k.ts at time zone 'America/Santiago')::date as dia, k.empresa_id, k.cliente_id, k.proveedor, k.modelo,
       count(*) filter (where not k.bloqueado) as llamadas,
       sum(k.tokens_in) as tokens_in, sum(k.tokens_out) as tokens_out,
       sum(k.costo_usd)::numeric(14,6) as costo_usd,
       k.modo,
       sum(k.tokens_cache_write) as tokens_cache_write,
       sum(k.tokens_cache_read) as tokens_cache_read,
       sum(k.costo_equivalente_usd)::numeric(14,6) as costo_equivalente_usd,
       count(*) filter (where k.bloqueado) as bloqueos
from public.consumos k
group by 1,2,3,4,5, k.modo;

grant select on public.v_consumo_mes_cliente, public.v_consumo_diario to authenticated, service_role;

-- Consumos recientes de suscripción (últimas 48 h) para el panel.
create or replace view public.v_suscripcion_reciente with (security_invoker = true) as
select k.ts, k.empresa_id, k.cliente_id, c.nombre as cliente, k.modelo, k.tokens_in, k.tokens_out,
       k.tokens_cache_write, k.tokens_cache_read, k.costo_equivalente_usd, k.bloqueado, k.motivo
from public.consumos k join public.clientes c on c.id = k.cliente_id
where k.modo = 'suscripcion' and k.ts >= now() - interval '48 hours';
grant select on public.v_suscripcion_reciente to authenticated, service_role;
