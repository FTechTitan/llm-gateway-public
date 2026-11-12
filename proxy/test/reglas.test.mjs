// Pruebas de la lógica de reglas de uso. Correr: node --test proxy/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { validarRegla, enHorario, coincide, valorDeFila, evaluar, momentoChile } from '../lib/reglas-logica.mjs';

const base = (extra = {}) => ({
  id: 'r1', empresa_id: 'acme', activa: true, ...validarRegla({
    nombre: 'tope', metrica: 'tokens', limite: 100, accion: 'cortar', ventana_tipo: 'movil', ventana_minutos: 60, ...extra,
  }),
});
const ctx = { empresa_id: 'acme', cliente_id: 'c1', proveedor: 'anthropic', modo: 'suscripcion', modelo: 'claude-opus-5-5' };
// 2026-11-13 es viernes. En noviembre Chile está en UTC-3.
const chile = (dia, h, m = 0) => new Date(Date.UTC(2026, 10, dia, h + 3, m));

test('validarRegla rechaza datos inválidos con mensajes claros', () => {
  assert.throws(() => base({ metrica: 'x' }), /metrica/);
  assert.throws(() => base({ accion: 'borrar' }), /accion/);
  assert.throws(() => base({ limite: -1 }), /limite/);
  assert.throws(() => base({ ventana_minutos: 0 }), /ventana_minutos/);
  assert.throws(() => base({ ventana_tipo: 'calendario' }), /ventana_periodo/);
  assert.throws(() => base({ filtro_cliente_id: 'no-uuid' }), /filtro_cliente_id/);
  assert.throws(() => base({ horario_dias: [8], horario_desde: '23:00', horario_hasta: '07:00' }), /horario_dias/);
  assert.throws(() => base({ filtro_modo: 'gratis' }), /filtro_modo/);
  assert.throws(() => base({ filtro_modelo: 'gpt_4' }), /filtro_modelo/);
});

test('validarRegla normaliza: filtros vacíos a null y hora de la base (HH:MM:SS) a HH:MM', () => {
  const r = base({ filtro_modelo: '', horario_dias: [5, 1, 5], horario_desde: '23:00:00', horario_hasta: '07:00:00' });
  assert.equal(r.filtro_modelo, null);
  assert.deepEqual(r.horario_dias, [1, 5]);
  assert.deepEqual(base({ horario_dias: [6, 0, 10 - 9], horario_desde: '01:00', horario_hasta: '02:00' }).horario_dias, [0, 1, 6]);
  assert.equal(r.horario_desde, '23:00');
});

test('momentoChile usa la zona de Chile, no la del servidor', () => {
  assert.deepEqual(momentoChile(chile(13, 23, 30)), { dia: 5, minuto: 23 * 60 + 30 });
});

test('enHorario: franja que cruza medianoche pertenece al día en que empieza', () => {
  const r = base({ horario_dias: [5], horario_desde: '23:00', horario_hasta: '07:00' });
  assert.equal(enHorario(r, chile(13, 23, 30)), true);   // viernes 23:30
  assert.equal(enHorario(r, chile(14, 3)), true);        // sábado 03:00
  assert.equal(enHorario(r, chile(14, 23, 30)), false);  // sábado 23:30
  assert.equal(enHorario(r, chile(13, 12)), false);      // viernes 12:00
  assert.equal(enHorario(base(), chile(13, 12)), true);  // sin horario: siempre
});

test('coincide respeta empresa y filtros', () => {
  assert.equal(coincide(base(), ctx), true);
  assert.equal(coincide(base(), { ...ctx, empresa_id: 'globex' }), false);
  assert.equal(coincide(base({ filtro_modelo: 'OPUS' }), ctx), true);
  assert.equal(coincide(base({ filtro_modelo: 'haiku' }), ctx), false);
  assert.equal(coincide(base({ filtro_modo: 'api' }), ctx), false);
});

test('valorDeFila: igual que consumo_reglas() en SQL', () => {
  const f = { tokens_in: 2, tokens_out: 60, tokens_cache_write: 1000, tokens_cache_read: 5000, costo_usd: 0, costo_equivalente_usd: 0.5 };
  assert.equal(valorDeFila(base(), f), 1062);
  assert.equal(valorDeFila(base({ metrica: 'tokens_out' }), f), 60);
  assert.equal(valorDeFila(base({ metrica: 'costo_usd' }), f), 0.5);
  assert.equal(valorDeFila(base({ metrica: 'llamadas' }), f), 1);
  assert.equal(valorDeFila(base({ metrica: 'llamadas' }), { tokens_in: 0 }), 0);   // count_tokens, errores
  assert.equal(valorDeFila(base(), { ...f, bloqueado: true }), 0);
});

test('evaluar: corta al llegar al límite, avisar no corta, inactivas no cuentan', () => {
  const corta = base();
  const avisa = { ...base({ accion: 'avisar' }), id: 'r2' };
  const apagada = { ...base(), id: 'r3', activa: false };
  assert.equal(evaluar([corta], () => 99, ctx, chile(13, 12)).permitido, true);
  const d = evaluar([avisa, apagada, corta], () => 100, ctx, chile(13, 12));
  assert.equal(d.permitido, false);
  assert.match(d.motivo, /100 de 100/);
  assert.equal(d.avisos.length, 1);
});

test('evaluar: límite 0 bloquea solo dentro del horario', () => {
  const noche = base({ limite: 0, horario_dias: [0, 1, 2, 3, 4, 5, 6], horario_desde: '01:00', horario_hasta: '07:00' });
  assert.equal(evaluar([noche], () => 0, ctx, chile(13, 3)).permitido, false);
  assert.equal(evaluar([noche], () => 0, ctx, chile(13, 12)).permitido, true);
});
