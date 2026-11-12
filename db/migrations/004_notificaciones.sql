-- llm-gateway 004: notificaciones push del panel (PWA).

create table if not exists public.push_suscripciones (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  endpoint  text not null unique,
  p256dh    text not null,
  auth      text not null,
  agente    text,                                -- navegador/dispositivo, para reconocerla
  creada    timestamptz not null default now()
);
create index if not exists push_suscripciones_user_idx on public.push_suscripciones (user_id);

-- Un aviso por clave (p. ej. «presupuesto80:<cliente>:2026-11»), para no repetirlo.
create table if not exists public.avisos_enviados (
  clave     text primary key,
  enviado   timestamptz not null default now()
);

alter table public.push_suscripciones enable row level security;
alter table public.avisos_enviados enable row level security;
-- Sin políticas: solo service_role (el proxy) las lee y escribe.
grant all on public.push_suscripciones, public.avisos_enviados to service_role;
