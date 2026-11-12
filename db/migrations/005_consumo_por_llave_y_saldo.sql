-- llm-gateway 005: consumo diario por llave del proveedor (leído con las admin keys) y saldo de créditos.

create table if not exists public.consumo_proveedor (
  empresa_id   text not null references public.empresas(id),
  proveedor    text not null check (proveedor in ('openai','anthropic')),
  dia          date not null,
  llave_id     text not null,            -- id de la llave en OpenAI/Anthropic ('sin-llave' si no viene)
  llave_nombre text,
  proyecto     text,                     -- proyecto de OpenAI o workspace de Anthropic
  modelo       text not null,
  llamadas     bigint not null default 0,
  tokens_in    bigint not null default 0,
  tokens_out   bigint not null default 0,
  cache_read   bigint not null default 0,
  cache_write  bigint not null default 0,
  usd_estimado numeric(14,6),            -- null si el modelo no tiene precio en la tabla precios
  leido        timestamptz not null default now(),
  primary key (empresa_id, proveedor, dia, llave_id, modelo)
);
create index if not exists consumo_proveedor_dia_idx on public.consumo_proveedor (empresa_id, proveedor, dia desc);

-- Saldo de créditos: los proveedores no lo entregan por API. Se anota un saldo de partida
-- (lo que muestra la consola) y cada recarga; el gateway descuenta el costo real diario.
create table if not exists public.movimientos_saldo (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  text not null references public.empresas(id),
  proveedor   text not null check (proveedor in ('openai','anthropic')),
  tipo        text not null check (tipo in ('saldo','recarga')),
  monto_usd   numeric(14,2) not null check (monto_usd >= 0),
  fecha       date not null,             -- 'saldo': saldo al cierre de ese día; 'recarga': día de la carga
  nota        text check (char_length(nota) <= 300),
  creado      timestamptz not null default now()
);

-- Saldo = último 'saldo' anotado + recargas posteriores - costo real posterior.
create or replace view public.v_saldo_proveedor with (security_invoker = true) as
with base as (
  select distinct on (empresa_id, proveedor) empresa_id, proveedor, monto_usd, fecha
  from public.movimientos_saldo where tipo = 'saldo'
  order by empresa_id, proveedor, fecha desc, creado desc
)
select b.empresa_id, b.proveedor, b.fecha as saldo_desde, b.monto_usd as saldo_inicial,
  coalesce((select sum(m.monto_usd) from public.movimientos_saldo m
            where m.empresa_id = b.empresa_id and m.proveedor = b.proveedor and m.tipo = 'recarga' and m.fecha > b.fecha), 0) as recargas,
  coalesce((select sum(c.costo_usd) from public.costos_proveedor c
            where c.empresa_id = b.empresa_id and c.proveedor = b.proveedor and c.dia > b.fecha), 0) as gastado,
  b.monto_usd
    + coalesce((select sum(m.monto_usd) from public.movimientos_saldo m
                where m.empresa_id = b.empresa_id and m.proveedor = b.proveedor and m.tipo = 'recarga' and m.fecha > b.fecha), 0)
    - coalesce((select sum(c.costo_usd) from public.costos_proveedor c
                where c.empresa_id = b.empresa_id and c.proveedor = b.proveedor and c.dia > b.fecha), 0) as saldo,
  (select max(c.leido) from public.costos_proveedor c where c.empresa_id = b.empresa_id and c.proveedor = b.proveedor) as actualizado
from base b;

alter table public.consumo_proveedor enable row level security;
alter table public.movimientos_saldo enable row level security;
create policy consumo_proveedor_ver on public.consumo_proveedor for select to authenticated using (gw.puede_ver(empresa_id));
create policy movimientos_saldo_ver on public.movimientos_saldo for select to authenticated using (gw.puede_ver(empresa_id));
grant select on public.consumo_proveedor, public.movimientos_saldo, public.v_saldo_proveedor to authenticated;
grant all on public.consumo_proveedor, public.movimientos_saldo to service_role;
grant select on public.v_saldo_proveedor to service_role;
