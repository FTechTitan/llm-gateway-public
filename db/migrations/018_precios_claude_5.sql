-- Precios de Claude 5 / 5.5 / Fable (USD por millón de tokens), de las páginas de modelos de Anthropic (2026-11-09):
--   https://platform.claude.com/docs/en/models/opus-5-5/overview
--   https://platform.claude.com/docs/en/models/sonnet-5-5/overview
--   https://platform.claude.com/docs/en/models/haiku-5-5/overview
-- Escritura de caché = la de 5 minutos. Haiku 5.5 usa el precio de prompts de hasta 100K tokens.
-- Sin estas filas, el consumo de esos modelos quedaba en 0 (gateway, suscripción y consumo por llave).
insert into public.precios (proveedor, modelo, usd_in_1m, usd_out_1m, usd_cache_read_1m, usd_cache_write_1m) values
  ('anthropic', 'claude-opus-5-5',   4.00, 20.00, 0.20,  5.00),
  ('anthropic', 'claude-opus-5',     5.00, 25.00, 0.50,  6.25),
  ('anthropic', 'claude-sonnet-5-5', 2.00, 10.00, 0.10,  2.50),
  ('anthropic', 'claude-haiku-5-5',  0.10,  0.50, 0.01,  0.125),
  ('anthropic', 'claude-fable-5-1', 10.00, 50.00, null,  null)
on conflict (proveedor, modelo) do update
  set usd_in_1m = excluded.usd_in_1m, usd_out_1m = excluded.usd_out_1m,
      usd_cache_read_1m = excluded.usd_cache_read_1m, usd_cache_write_1m = excluded.usd_cache_write_1m, actualizado = now();

-- Recalcula lo ya registrado sin precio de esos modelos (en el gateway).
update public.consumos k set
  costo_usd = case when k.modo = 'api' then v.usd else 0 end,
  costo_equivalente_usd = case when k.modo = 'suscripcion' then v.usd else 0 end,
  precio_conocido = true
from (
  select k2.id, round((k2.tokens_in * p.usd_in_1m + k2.tokens_out * p.usd_out_1m
           + k2.tokens_cache_read * coalesce(p.usd_cache_read_1m, p.usd_in_1m)
           + k2.tokens_cache_write * coalesce(p.usd_cache_write_1m, p.usd_in_1m)) / 1e6, 6) as usd
  from public.consumos k2
  join lateral (
    select * from public.precios p where p.proveedor = 'anthropic' and lower(k2.modelo) like lower(p.modelo) || '%'
    order by length(p.modelo) desc limit 1
  ) p on true
  where k2.proveedor = 'anthropic' and k2.precio_conocido = false
    and k2.modelo ~* '^claude-(opus|sonnet|haiku|fable)-5'
) v
where k.id = v.id;
