// Pruebas de la fecha de expiración obligatoria. Correr: node --test proxy/test/vencimientos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { descripcionValida, diasParaVencer, expiraValida } from '../lib/vencimientos.mjs';

const AHORA = Date.parse('2026-11-08T12:00:00-03:00');

test('sin fecha se rechaza: es obligatoria', () => {
  for (const v of [undefined, null, '']) assert.throws(() => expiraValida(v, AHORA), /Falta expira/);
});

test('AAAA-MM-DD vence al final de ese día en Chile', () => {
  assert.equal(expiraValida('2026-12-31', AHORA), new Date('2026-12-31T23:59:59-03:00').toISOString());
});

test('fechas pasadas, inválidas o a más de 5 años se rechazan', () => {
  assert.throws(() => expiraValida('2026-11-07', AHORA), /futura/);
  assert.throws(() => expiraValida('31-12-2026', AHORA), /no es una fecha válida/);
  assert.throws(() => expiraValida('2032-01-01', AHORA), /5 años/);
});

test('hoy mismo todavía sirve porque vence a las 23:59', () => {
  assert.ok(expiraValida('2026-11-08', AHORA));
});

test('descripción opcional, recortada y con largo máximo', () => {
  assert.equal(descripcionValida(undefined), null);
  assert.equal(descripcionValida('   '), null);
  assert.equal(descripcionValida('  bot n8n '), 'bot n8n');
  assert.throws(() => descripcionValida('x'.repeat(301)), /300/);
});

test('días para vencer', () => {
  assert.equal(diasParaVencer('2026-11-18T12:00:00-03:00', AHORA), 10);
  assert.ok(diasParaVencer('2026-11-01T12:00:00-03:00', AHORA) < 0);
});
