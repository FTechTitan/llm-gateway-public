-- llm-gateway 006: trazas a Langfuse por cliente (opcional).
-- {"activo": bool, "host": "https://langfuse.example.com", "public_key": "pk-lf-…", "secret_cifrado": "v1:…"}
alter table public.clientes add column if not exists langfuse jsonb;
-- El panel no debe leer la configuración (trae la llave secreta cifrada).
revoke select on public.clientes from authenticated;
grant select (id, empresa_id, nombre, presupuesto_usd_mensual, activo, metadata, creado) on public.clientes to authenticated;
