-- llm-gateway 003: fecha de expiración obligatoria y descripción opcional en TODAS las llaves
-- (clientes tfk_, administración tfa_ y llaves reales de OpenAI/Anthropic).
-- Las llaves que ya existían quedan venciendo en un año; se puede cambiar desde el panel o gw.py.

alter table public.llaves add column if not exists expira timestamptz;
alter table public.llaves add column if not exists descripcion text;
update public.llaves set expira = now() + interval '1 year' where expira is null;
alter table public.llaves alter column expira set not null;

alter table public.llaves_admin add column if not exists expira timestamptz;
alter table public.llaves_admin add column if not exists descripcion text;
update public.llaves_admin set expira = now() + interval '1 year' where expira is null;
alter table public.llaves_admin alter column expira set not null;

alter table public.credenciales_proveedor add column if not exists expira timestamptz;
alter table public.credenciales_proveedor add column if not exists descripcion text;
update public.credenciales_proveedor set expira = now() + interval '1 year' where expira is null;
alter table public.credenciales_proveedor alter column expira set not null;

alter table public.llaves drop constraint if exists llaves_descripcion_largo;
alter table public.llaves add constraint llaves_descripcion_largo check (char_length(descripcion) <= 300);
alter table public.llaves_admin drop constraint if exists llaves_admin_descripcion_largo;
alter table public.llaves_admin add constraint llaves_admin_descripcion_largo check (char_length(descripcion) <= 300);
alter table public.credenciales_proveedor drop constraint if exists credenciales_descripcion_largo;
alter table public.credenciales_proveedor add constraint credenciales_descripcion_largo check (char_length(descripcion) <= 300);

-- Corrección: en 001 se hizo «revoke select (hash)» pero con permiso de tabla completa no surte efecto.
-- El panel puede leer las llaves de su empresa, nunca el hash.
revoke select on public.llaves from authenticated;
grant select (id, cliente_id, empresa_id, prefijo, nombre, descripcion, activa, creada, ultimo_uso, expira)
  on public.llaves to authenticated;
