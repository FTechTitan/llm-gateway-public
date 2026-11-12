-- llm-gateway: en un equipo compartido una misma sesión puede cambiar de autor (Alice la abre y después la toma
-- Bob), así que el usuario entra en la clave del histórico. '' = sin usuario (equipos personales).
update public.consumo_historico_suscripcion set usuario = '' where usuario is null;
alter table public.consumo_historico_suscripcion alter column usuario set default '';
alter table public.consumo_historico_suscripcion alter column usuario set not null;
alter table public.consumo_historico_suscripcion drop constraint if exists consumo_historico_suscripcion_pkey;
alter table public.consumo_historico_suscripcion add primary key (cliente_id, hora, modelo, sesion, usuario);
