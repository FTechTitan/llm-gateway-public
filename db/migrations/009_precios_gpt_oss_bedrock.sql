-- llm-gateway 009: precios de los gpt-oss en Bedrock (USD por millón de tokens, tarifa on-demand de AWS en us-east-1).
-- Sin estas filas el consumo se registraba con costo 0 (no hay precio de OpenAI directo para gpt-oss).
insert into public.precios (proveedor, modelo, usd_in_1m, usd_out_1m) values
  ('bedrock', 'openai.gpt-oss-120b', 0.15, 0.60),
  ('bedrock', 'openai.gpt-oss-20b',  0.07, 0.30)
on conflict (proveedor, modelo) do update set usd_in_1m = excluded.usd_in_1m, usd_out_1m = excluded.usd_out_1m, actualizado = now();
