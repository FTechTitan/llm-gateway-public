-- llm-gateway 008: modelos de OpenAI por Amazon Bedrock (/openai/v1/chat/completions). Contrato: docs/bedrock.md.
-- Aplicar ANTES de desplegar el proxy de esta versión (el proxy lee empresas.ruta_openai y clientes.ruta_openai).
-- No cambia el comportamiento actual: todas las empresas quedan con ruta_openai 'directo'.

alter table public.empresas add column if not exists ruta_openai text not null default 'directo';
alter table public.empresas drop constraint if exists empresas_ruta_openai_check;
alter table public.empresas add constraint empresas_ruta_openai_check check (ruta_openai in ('directo', 'bedrock'));

alter table public.clientes add column if not exists ruta_openai text;   -- null = hereda de la empresa
alter table public.clientes drop constraint if exists clientes_ruta_openai_check;
alter table public.clientes add constraint clientes_ruta_openai_check check (ruta_openai in ('directo', 'bedrock'));

-- Traducción de nombres de OpenAI a ids de Bedrock (empresa_id null = todas). Los gpt-oss no tienen perfil con
-- región: van sin prefijo. Los gpt-5.x / gpt-6.x van con su perfil (us.openai.…). Verificar con:
--   aws bedrock list-foundation-models --by-provider openai --region us-east-1
insert into public.bedrock_modelos (empresa_id, modelo, bedrock_id) values
  (null, 'gpt-oss-120b', 'openai.gpt-oss-120b-1:0'),
  (null, 'gpt-oss-20b',  'openai.gpt-oss-20b-1:0'),
  (null, 'gpt-5.4',      'us.openai.gpt-5.4'),
  (null, 'gpt-5.5',      'us.openai.gpt-5.5'),
  (null, 'gpt-6-luna',   'us.openai.gpt-6-luna'),
  (null, 'gpt-6-sol',    'us.openai.gpt-6-sol'),
  (null, 'gpt-6.1-sol',  'us.openai.gpt-6.1-sol'),
  (null, 'gpt-6.1-terra','us.openai.gpt-6.1-terra')
on conflict do nothing;
