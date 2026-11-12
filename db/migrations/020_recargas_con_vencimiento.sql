-- llm-gateway 020: recargas programadas con vencimiento propio.
-- Una recarga se suma al saldo recién desde su fecha (antes figura «por llegar») y, si tiene vencimiento,
-- lo que no se gastó hasta ese día se pierde. El gasto diario se descuenta primero del crédito que vence antes.
-- El vencimiento se anota aparte en cada recarga; no se calcula a partir de la fecha de llegada.

alter table public.movimientos_saldo add column if not exists vence date;
alter table public.movimientos_saldo drop constraint if exists movimientos_saldo_vence_check;
alter table public.movimientos_saldo add constraint movimientos_saldo_vence_check
  check (vence is null or (tipo = 'recarga' and vence >= fecha));

-- Saldo de una empresa y proveedor a la fecha «hoy» (hora de Chile por defecto).
create or replace function gw.saldo_creditos(p_empresa text, p_proveedor text,
                                             p_hoy date default (now() at time zone 'America/Santiago')::date)
returns table (saldo_desde date, saldo_inicial numeric, recargas numeric, gastado numeric, perdido numeric,
               saldo numeric, por_llegar numeric, proxima_recarga date, proximo_vencimiento date, monto_por_vencer numeric)
language plpgsql stable security invoker set search_path = public as $$
declare
  b record;
  desde date;
  inicial numeric := 0;
  -- lotes: saldo base (sin vencimiento) + recargas ya llegadas
  l_id uuid[] := '{}'; l_fecha date[] := '{}'; l_vence date[] := '{}'; l_resto numeric[] := '{}';
  m record; d date; costo numeric; i int; j int; tomar numeric;
  v_recargas numeric := 0; v_gastado numeric := 0; v_perdido numeric := 0; deuda numeric := 0;
begin
  select ms.fecha, ms.monto_usd into b from movimientos_saldo ms
   where ms.empresa_id = p_empresa and ms.proveedor = p_proveedor and ms.tipo = 'saldo' and ms.fecha <= p_hoy
   order by ms.fecha desc, ms.creado desc limit 1;
  if found then
    desde := b.fecha; inicial := b.monto_usd;
  else
    select min(ms.fecha) - 1 into desde from movimientos_saldo ms
     where ms.empresa_id = p_empresa and ms.proveedor = p_proveedor;
    if desde is null then return; end if;
  end if;

  l_id := array[null::uuid]; l_fecha := array[desde]; l_vence := array[null::date]; l_resto := array[inicial];

  for m in select ms.id, ms.fecha, ms.vence, ms.monto_usd from movimientos_saldo ms
            where ms.empresa_id = p_empresa and ms.proveedor = p_proveedor and ms.tipo = 'recarga'
              and ms.fecha > desde and ms.fecha <= p_hoy
            order by ms.fecha loop
    l_id := l_id || m.id; l_fecha := l_fecha || m.fecha; l_vence := l_vence || m.vence; l_resto := l_resto || m.monto_usd;
    v_recargas := v_recargas + m.monto_usd;
  end loop;

  d := desde + 1;
  while d <= p_hoy loop
    -- vence: lo no usado de un lote cuyo vencimiento ya pasó (vence el día anotado, inclusive)
    for i in 1..array_length(l_id, 1) loop
      if l_vence[i] is not null and l_vence[i] < d and l_resto[i] > 0 then
        v_perdido := v_perdido + l_resto[i]; l_resto[i] := 0;
      end if;
    end loop;
    select coalesce(sum(c.costo_usd), 0) into costo from costos_proveedor c
     where c.empresa_id = p_empresa and c.proveedor = p_proveedor and c.dia = d;
    v_gastado := v_gastado + costo;
    -- se gasta primero lo que vence antes (los lotes sin vencimiento, al final)
    while costo > 0 loop
      j := null;
      for i in 1..array_length(l_id, 1) loop
        if l_resto[i] > 0 and l_fecha[i] <= d and (l_vence[i] is null or l_vence[i] >= d) then
          if j is null or coalesce(l_vence[i], 'infinity'::date) < coalesce(l_vence[j], 'infinity'::date) then j := i; end if;
        end if;
      end loop;
      if j is null then deuda := deuda + costo; costo := 0;
      else tomar := least(costo, l_resto[j]); l_resto[j] := l_resto[j] - tomar; costo := costo - tomar; end if;
    end loop;
    d := d + 1;
  end loop;

  saldo_desde := desde; saldo_inicial := inicial; recargas := v_recargas; gastado := v_gastado; perdido := v_perdido;
  saldo := (select coalesce(sum(x), 0) from unnest(l_resto) x) - deuda;
  select coalesce(sum(ms.monto_usd), 0), min(ms.fecha) into por_llegar, proxima_recarga from movimientos_saldo ms
   where ms.empresa_id = p_empresa and ms.proveedor = p_proveedor and ms.tipo = 'recarga' and ms.fecha > p_hoy;
  proximo_vencimiento := null; monto_por_vencer := null;
  for i in 1..array_length(l_id, 1) loop
    if l_vence[i] is not null and l_resto[i] > 0 and (proximo_vencimiento is null or l_vence[i] < proximo_vencimiento) then
      proximo_vencimiento := l_vence[i]; monto_por_vencer := l_resto[i];
    end if;
  end loop;
  return next;
end $$;

drop view if exists public.v_saldo_proveedor;
create view public.v_saldo_proveedor with (security_invoker = true) as
select e.empresa_id, e.proveedor, s.saldo_desde, s.saldo_inicial, s.recargas, s.gastado, s.perdido, s.saldo,
       s.por_llegar, s.proxima_recarga, s.proximo_vencimiento, s.monto_por_vencer,
       (select max(c.leido) from public.costos_proveedor c where c.empresa_id = e.empresa_id and c.proveedor = e.proveedor) as actualizado
from (select distinct empresa_id, proveedor from public.movimientos_saldo) e
cross join lateral gw.saldo_creditos(e.empresa_id, e.proveedor) s;

grant execute on function gw.saldo_creditos(text, text, date) to authenticated, service_role;
grant select on public.v_saldo_proveedor to authenticated, service_role;
