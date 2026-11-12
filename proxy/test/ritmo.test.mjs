// Pruebas del ritmo de créditos. Correr: node --test proxy/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { ritmo, gastoPorDia } from '../lib/ritmo-logica.mjs';

const lote = { saldo: 100, proximo_vencimiento: '2026-12-12', monto_por_vencer: 100, por_llegar: 0, proxima_recarga: null };

test('gastando poco, avisa cuánto vence y el ritmo para usarlo todo', () => {
  const r = ritmo(lote, 1, '2026-11-13');           // 30 días incluyendo el del vencimiento
  assert.equal(r.estado, 'se_pierde');
  assert.equal(r.dias_para_vencer, 30);
  assert.equal(Math.round(r.sobrante), 70);
  assert.equal(r.ideal_dia.toFixed(2), '3.33');
});

test('sin gasto, se pierde todo', () => {
  assert.equal(Math.round(ritmo(lote, 0, '2026-11-13').sobrante), 100);
});

test('al ritmo justo, en ritmo', () => {
  assert.equal(ritmo(lote, 100 / 30, '2026-11-13').estado, 'en_ritmo');
});

test('gastando de más, avisa cuándo se acaba antes de la próxima recarga', () => {
  const r = ritmo({ ...lote, proxima_recarga: '2026-12-13' }, 10, '2026-11-13');
  assert.equal(r.estado, 'se_acaba');
  assert.equal(r.se_acaba, '2026-11-23');
});

test('sobrante chico (menos de US$5 o 10 %) no se considera pérdida', () => {
  assert.notEqual(ritmo(lote, 3.2, '2026-11-13').estado, 'se_pierde');   // sobran 4
});

test('el último día todavía cuenta', () => {
  const r = ritmo(lote, 0, '2026-12-12');
  assert.equal(r.dias_para_vencer, 1);
  assert.equal(r.ideal_dia, 100);
});

test('promedio diario de los últimos 7 días completos, sin hoy', () => {
  const costos = [
    { empresa_id: 'acme', proveedor: 'anthropic', dia: '2026-11-12', costo_usd: 7 },
    { empresa_id: 'acme', proveedor: 'anthropic', dia: '2026-11-06', costo_usd: 7 },
    { empresa_id: 'acme', proveedor: 'anthropic', dia: '2026-11-05', costo_usd: 100 },   // fuera
    { empresa_id: 'acme', proveedor: 'anthropic', dia: '2026-11-13', costo_usd: 100 },   // hoy, fuera
  ];
  assert.equal(gastoPorDia(costos, '2026-11-13')['acme:anthropic'], 2);
});

test('sin recarga anotada, avisa si el saldo dura menos de 14 días', () => {
  const r = ritmo({ saldo: 62, proximo_vencimiento: null, monto_por_vencer: null, por_llegar: 0, proxima_recarga: null }, 8.84, '2026-11-09');
  assert.equal(r.estado, 'se_acaba');
  assert.equal(r.se_acaba, '2026-11-16');
  assert.equal(ritmo({ saldo: 500, por_llegar: 0 }, 8.84, '2026-11-09').estado, 'sin_datos');
});

test('antes de que llegue la recarga, dice cuánto llega y cuándo', () => {
  const r = ritmo({ saldo: 0, por_llegar: 100, proxima_recarga: '2026-11-13' }, 0, '2026-11-09');
  assert.equal(r.mensaje, 'Llegan US$ 100.00 el 2026-11-13.');
});
