-- llm-gateway: estado de TODAS las suscripciones (Claude Max, ChatGPT/Codex, Antigravity…), una fila por cuenta.
-- ventanas: [{"clave":"7d","nombre":"Semanal","usado":0.77,"ventana_min":10080,"reset":1794376800}]  (usado 0..1, reset epoch s)
-- Claude lo llena el propio proxy (cabeceras de Anthropic); Codex y Antigravity, un colector en cada equipo.
create table if not exists public.suscripciones_estado (
  id          text primary key,                 -- p. ej. claude:alice, codex:correo, agy:perfil
  empresa_id  text not null references public.empresas(id),
  proveedor   text not null,                    -- claude | chatgpt | antigravity
  cuenta      text not null,
  plan        text,
  equipo      text,                             -- desde dónde llegó el último dato
  ventanas    jsonb not null default '[]',
  extra       jsonb not null default '{}',
  ts          timestamptz not null default now()
);
alter table public.suscripciones_estado enable row level security;
drop policy if exists suscripciones_estado_ver on public.suscripciones_estado;
create policy suscripciones_estado_ver on public.suscripciones_estado for select to authenticated using (gw.puede_ver(empresa_id));
grant select on public.suscripciones_estado to authenticated;
grant all on public.suscripciones_estado to service_role;
