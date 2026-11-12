-- Precios de gpt-5.5 y gpt-5.2 (USD por millón), de https://developers.openai.com/api/docs/pricing (2026-11-09, tier
-- estándar, contexto ≤ 272K). Sin estas filas el gateway los cobraba con el precio de 'gpt-5' (prefijo más largo):
-- gpt-5.5 quedaba en 1/4 del costo real de entrada y 1/3 del de salida (Ledlight: US$10 estimado vs ~US$37 real en 30 días).
insert into public.precios (proveedor, modelo, usd_in_1m, usd_out_1m, usd_cache_read_1m, usd_cache_write_1m) values
  ('openai', 'gpt-5.5', 5.00, 30.00, 0.50,  null),
  ('openai', 'gpt-5.2', 1.75, 14.00, 0.175, null)
on conflict (proveedor, modelo) do update
  set usd_in_1m = excluded.usd_in_1m, usd_out_1m = excluded.usd_out_1m,
      usd_cache_read_1m = excluded.usd_cache_read_1m, usd_cache_write_1m = excluded.usd_cache_write_1m, actualizado = now();

-- Recalcula lo registrado en el gateway con esos modelos (OpenAI directo).
update public.consumos k set
  costo_usd = case when k.modo = 'api' then v.usd else 0 end,
  costo_equivalente_usd = case when k.modo = 'suscripcion' then v.usd else 0 end,
  precio_conocido = true
from (
  select k2.id, round((k2.tokens_in * p.usd_in_1m + k2.tokens_out * p.usd_out_1m
           + k2.tokens_cache_read * coalesce(p.usd_cache_read_1m, p.usd_in_1m)
           + k2.tokens_cache_write * coalesce(p.usd_cache_write_1m, p.usd_in_1m)) / 1e6, 6) as usd
  from public.consumos k2
  join public.precios p on p.proveedor = 'openai'
   and p.modelo = case when k2.modelo ilike 'gpt-5.5%' then 'gpt-5.5' else 'gpt-5.2' end
  where k2.proveedor = 'openai' and (k2.modelo ilike 'gpt-5.5%' or k2.modelo ilike 'gpt-5.2%')
) v
where k.id = v.id;

-- Recalcula el consumo por llave que informa OpenAI (estimado con la tabla de precios).
update public.consumo_proveedor c set
  usd_estimado = round((c.tokens_in * p.usd_in_1m + c.tokens_out * p.usd_out_1m
                 + c.cache_read * coalesce(p.usd_cache_read_1m, p.usd_in_1m)
                 + c.cache_write * coalesce(p.usd_cache_write_1m, p.usd_in_1m)) / 1e6, 6)
from public.precios p
where c.proveedor = 'openai' and p.proveedor = 'openai'
  and p.modelo = case when c.modelo ilike 'gpt-5.5%' then 'gpt-5.5' else 'gpt-5.2' end
  and (c.modelo ilike 'gpt-5.5%' or c.modelo ilike 'gpt-5.2%');
