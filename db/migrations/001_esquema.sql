-- llm-gateway: esquema base
-- Empresas (Globex, Initech, Acme) -> clientes -> llaves. Cada llamada queda en consumos.

create schema if not exists gw;

-- ---------- Tablas ----------
create table if not exists public.empresas (
  id          text primary key,                 -- 'globex', 'initech', 'acme'
  nombre      text not null,
  creada      timestamptz not null default now()
);

-- Llaves reales de OpenAI/Anthropic. Valor cifrado por el proxy (AES-256-GCM).
-- Solo service_role puede leer esta tabla.
create table if not exists public.credenciales_proveedor (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  text not null references public.empresas(id),
  proveedor   text not null check (proveedor in ('openai','anthropic')),
  tipo        text not null check (tipo in ('api','admin')),
  valor_cifrado text not null,
  huella      text not null,                    -- últimos 4 caracteres, para reconocerla
  activa      boolean not null default true,
  creada      timestamptz not null default now(),
  unique (empresa_id, proveedor, tipo)
);

create table if not exists public.clientes (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  text not null references public.empresas(id),
  nombre      text not null,
  presupuesto_usd_mensual numeric(12,2) not null default 0,  -- 0 = sin tope
  activo      boolean not null default true,
  metadata    jsonb not null default '{}'::jsonb,
  creado      timestamptz not null default now(),
  unique (empresa_id, nombre)
);

create table if not exists public.llaves (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  empresa_id  text not null references public.empresas(id),
  prefijo     text not null,                    -- primeros caracteres visibles: tfk_ab12…
  hash        text not null unique,             -- sha256 de la llave completa
  nombre      text,
  activa      boolean not null default true,
  creada      timestamptz not null default now(),
  ultimo_uso  timestamptz
);

-- Llaves de administración por API (superadmin o admin de una empresa).
create table if not exists public.llaves_admin (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  text references public.empresas(id),   -- null = superadmin
  prefijo     text not null,
  hash        text not null unique,
  nombre      text,
  activa      boolean not null default true,
  creada      timestamptz not null default now()
);

-- Precios por millón de tokens. El modelo se busca por prefijo más largo.
create table if not exists public.precios (
  proveedor   text not null check (proveedor in ('openai','anthropic')),
  modelo      text not null,                    -- prefijo: 'gpt-4.1-mini', 'claude-sonnet-4'
  usd_in_1m   numeric(12,4) not null,
  usd_out_1m  numeric(12,4) not null,
  usd_cache_read_1m  numeric(12,4),
  usd_cache_write_1m numeric(12,4),
  actualizado timestamptz not null default now(),
  primary key (proveedor, modelo)
);

create table if not exists public.consumos (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  empresa_id  text not null references public.empresas(id),
  cliente_id  uuid not null references public.clientes(id),
  llave_id    uuid references public.llaves(id),
  proveedor   text not null,
  modelo      text,
  endpoint    text not null,
  stream      boolean not null default false,
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0,
  tokens_cache_read  integer not null default 0,
  tokens_cache_write integer not null default 0,
  costo_usd   numeric(14,6) not null default 0,
  precio_conocido boolean not null default true,
  status      integer,
  latencia_ms integer
);
create index if not exists consumos_ts_idx on public.consumos (ts desc);
create index if not exists consumos_cliente_ts_idx on public.consumos (cliente_id, ts desc);
create index if not exists consumos_empresa_ts_idx on public.consumos (empresa_id, ts desc);

-- Costo real informado por el proveedor (se llena con las admin keys).
create table if not exists public.costos_proveedor (
  empresa_id  text not null references public.empresas(id),
  proveedor   text not null,
  dia         date not null,
  costo_usd   numeric(14,6) not null,
  leido       timestamptz not null default now(),
  primary key (empresa_id, proveedor, dia)
);

-- Quién entra al panel. empresa_id null = superadmin (ve todo).
create table if not exists public.perfiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  empresa_id  text references public.empresas(id),
  nombre      text,
  creado      timestamptz not null default now()
);

-- ---------- Funciones de acceso ----------
create or replace function gw.mi_empresa() returns text
language sql stable security definer set search_path = public as $$
  select empresa_id from public.perfiles where user_id = auth.uid()
$$;

create or replace function gw.es_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where user_id = auth.uid() and empresa_id is null)
$$;

create or replace function gw.puede_ver(e text) returns boolean
language sql stable as $$
  select auth.uid() is not null and (gw.es_superadmin() or gw.mi_empresa() = e)
$$;

grant usage on schema gw to authenticated, service_role;
grant execute on all functions in schema gw to authenticated, service_role;

-- ---------- RLS ----------
alter table public.empresas enable row level security;
alter table public.credenciales_proveedor enable row level security;
alter table public.clientes enable row level security;
alter table public.llaves enable row level security;
alter table public.llaves_admin enable row level security;
alter table public.precios enable row level security;
alter table public.consumos enable row level security;
alter table public.costos_proveedor enable row level security;
alter table public.perfiles enable row level security;

create policy empresas_ver on public.empresas for select to authenticated using (gw.puede_ver(id));
create policy clientes_ver on public.clientes for select to authenticated using (gw.puede_ver(empresa_id));
create policy llaves_ver on public.llaves for select to authenticated using (gw.puede_ver(empresa_id));
create policy consumos_ver on public.consumos for select to authenticated using (gw.puede_ver(empresa_id));
create policy costos_ver on public.costos_proveedor for select to authenticated using (gw.puede_ver(empresa_id));
create policy precios_ver on public.precios for select to authenticated using (true);
create policy perfiles_ver on public.perfiles for select to authenticated using (user_id = auth.uid() or gw.es_superadmin());
-- credenciales_proveedor y llaves_admin: sin políticas -> solo service_role.

grant select on public.empresas, public.clientes, public.llaves, public.consumos,
  public.costos_proveedor, public.precios, public.perfiles to authenticated;
-- No exponer el hash de las llaves al panel.
revoke select (hash) on public.llaves from authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------- Vistas para el panel (respetan RLS: security_invoker) ----------
create or replace view public.v_consumo_mes_cliente with (security_invoker = true) as
select c.id as cliente_id, c.empresa_id, c.nombre, c.presupuesto_usd_mensual, c.activo,
       coalesce(sum(k.costo_usd), 0)::numeric(14,6) as gastado_mes,
       count(k.id) as llamadas_mes,
       case when c.presupuesto_usd_mensual > 0
            then greatest(c.presupuesto_usd_mensual - coalesce(sum(k.costo_usd),0), 0) end as restante
from public.clientes c
left join public.consumos k on k.cliente_id = c.id
  and k.ts >= date_trunc('month', now() at time zone 'America/Santiago') at time zone 'America/Santiago'
group by c.id;

create or replace view public.v_consumo_diario with (security_invoker = true) as
select (k.ts at time zone 'America/Santiago')::date as dia, k.empresa_id, k.cliente_id, k.proveedor, k.modelo,
       count(*) as llamadas, sum(k.tokens_in) as tokens_in, sum(k.tokens_out) as tokens_out,
       sum(k.costo_usd)::numeric(14,6) as costo_usd
from public.consumos k
group by 1,2,3,4,5;

grant select on public.v_consumo_mes_cliente, public.v_consumo_diario to authenticated, service_role;

-- ---------- Datos iniciales ----------
insert into public.empresas (id, nombre) values
  ('acme','Acme'), ('globex','Globex'), ('initech','Initech')
on conflict do nothing;

-- Precios de referencia (USD por millón de tokens). Revisar y editar desde el panel o SQL.
insert into public.precios (proveedor, modelo, usd_in_1m, usd_out_1m, usd_cache_read_1m, usd_cache_write_1m) values
  ('openai','gpt-4.1',        2.00,  8.00, 0.50, null),
  ('openai','gpt-4.1-mini',   0.40,  1.60, 0.10, null),
  ('openai','gpt-4.1-nano',   0.10,  0.40, 0.025, null),
  ('openai','gpt-4o',         2.50, 10.00, 1.25, null),
  ('openai','gpt-4o-mini',    0.15,  0.60, 0.075, null),
  ('openai','gpt-5',          1.25, 10.00, 0.125, null),
  ('openai','gpt-5-mini',     0.25,  2.00, 0.025, null),
  ('openai','gpt-5-nano',     0.05,  0.40, 0.005, null),
  ('openai','o4-mini',        1.10,  4.40, 0.275, null),
  ('openai','text-embedding-3-small', 0.02, 0, null, null),
  ('openai','text-embedding-3-large', 0.13, 0, null, null),
  ('anthropic','claude-opus-4',    15.00, 75.00, 1.50, 18.75),
  ('anthropic','claude-opus-4-5',   5.00, 25.00, 0.50,  6.25),
  ('anthropic','claude-sonnet-4',   3.00, 15.00, 0.30,  3.75),
  ('anthropic','claude-3-7-sonnet', 3.00, 15.00, 0.30,  3.75),
  ('anthropic','claude-haiku-4',    1.00,  5.00, 0.10,  1.25),
  ('anthropic','claude-3-5-haiku',  0.80,  4.00, 0.08,  1.00)
on conflict do nothing;
