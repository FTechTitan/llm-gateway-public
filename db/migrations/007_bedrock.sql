-- llm-gateway 007: Claude por Amazon Bedrock (contrato en docs/bedrock.md).
-- Aplicar ANTES de desplegar el proxy de esta versión (el proxy lee empresas.ruta_anthropic y bedrock_modelos).
-- No cambia el comportamiento actual: todas las empresas quedan con ruta 'directo'.

-- ---------- Proveedor 'bedrock' en credenciales y precios ----------
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tabla, c.conname
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in ('public.credenciales_proveedor'::regclass, 'public.precios'::regclass)
      and pg_get_constraintdef(c.oid) ilike '%proveedor%openai%anthropic%'
  loop
    execute format('alter table %s drop constraint %I', r.tabla, r.conname);
  end loop;
end $$;
alter table public.credenciales_proveedor add constraint credenciales_proveedor_proveedor_check
  check (proveedor in ('openai', 'anthropic', 'bedrock'));
alter table public.precios add constraint precios_proveedor_check
  check (proveedor in ('openai', 'anthropic', 'bedrock'));

-- ---------- Ruta de Claude por empresa y por cliente ----------
alter table public.empresas add column if not exists ruta_anthropic text not null default 'directo';
alter table public.empresas drop constraint if exists empresas_ruta_anthropic_check;
alter table public.empresas add constraint empresas_ruta_anthropic_check check (ruta_anthropic in ('directo', 'bedrock'));

alter table public.clientes add column if not exists ruta_anthropic text;   -- null = hereda de la empresa
alter table public.clientes drop constraint if exists clientes_ruta_anthropic_check;
alter table public.clientes add constraint clientes_ruta_anthropic_check check (ruta_anthropic in ('directo', 'bedrock'));

-- Por dónde salió cada llamada (proveedor sigue siendo 'anthropic' para que reglas y filtros no cambien).
alter table public.consumos add column if not exists via text not null default 'directo';
alter table public.consumos drop constraint if exists consumos_via_check;
alter table public.consumos add constraint consumos_via_check check (via in ('directo', 'bedrock'));

-- ---------- Traducción de modelos: nombre de Anthropic -> id de Bedrock ----------
-- bedrock_id sin prefijo geográfico (anthropic.…) recibe el "perfil" de la credencial (us., eu., global.).
-- Con prefijo (us.anthropic.…) o ARN se usa tal cual. empresa_id null = vale para todas.
create table if not exists public.bedrock_modelos (
  id          bigserial primary key,
  empresa_id  text references public.empresas(id) on delete cascade,
  modelo      text not null,
  bedrock_id  text not null,
  creado      timestamptz not null default now(),
  unique nulls not distinct (empresa_id, modelo)
);
alter table public.bedrock_modelos enable row level security;
drop policy if exists bedrock_modelos_ver on public.bedrock_modelos;
create policy bedrock_modelos_ver on public.bedrock_modelos for select to authenticated
  using (empresa_id is null or gw.puede_ver(empresa_id));
grant select on public.bedrock_modelos to authenticated;
grant all on public.bedrock_modelos to service_role;
grant usage, select on sequence public.bedrock_modelos_id_seq to service_role;

-- Alias sin fecha. Los nombres con fecha (claude-x-AAAAMMDD) se traducen solos a anthropic.claude-x-AAAAMMDD-v1:0.
-- Verificar con: aws bedrock list-foundation-models --by-provider anthropic --region <región>
insert into public.bedrock_modelos (empresa_id, modelo, bedrock_id) values
  (null, 'claude-haiku-4-5',  'anthropic.claude-haiku-4-5-20251001-v1:0'),
  (null, 'claude-sonnet-4-5', 'anthropic.claude-sonnet-4-5-20250929-v1:0'),
  (null, 'claude-sonnet-4-0', 'anthropic.claude-sonnet-4-20250514-v1:0'),
  (null, 'claude-sonnet-4',   'anthropic.claude-sonnet-4-20250514-v1:0'),
  (null, 'claude-opus-4-1',   'anthropic.claude-opus-4-1-20250805-v1:0'),
  (null, 'claude-opus-4-5',   'anthropic.claude-opus-4-5-20251101-v1:0'),
  (null, 'claude-3-5-haiku-latest', 'anthropic.claude-3-5-haiku-20241022-v1:0')
on conflict do nothing;
