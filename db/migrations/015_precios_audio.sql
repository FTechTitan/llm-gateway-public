-- Audio: whisper-1 se cobra por minuto (usage.type = 'duration'); gpt-4o-transcribe y mini por tokens.
-- Precios públicos de OpenAI (USD). En los transcribe la entrada es casi todo audio: se usa el precio de audio.
alter table public.precios add column if not exists usd_minuto numeric(12,6);

insert into public.precios (proveedor, modelo, usd_in_1m, usd_out_1m, usd_minuto) values
  ('openai', 'whisper-1',              0,    0,     0.006),
  ('openai', 'gpt-4o-transcribe',      6.00, 10.00, null),
  ('openai', 'gpt-4o-mini-transcribe', 3.00, 5.00,  null)
on conflict (proveedor, modelo) do update
  set usd_in_1m = excluded.usd_in_1m, usd_out_1m = excluded.usd_out_1m, usd_minuto = excluded.usd_minuto, actualizado = now();
