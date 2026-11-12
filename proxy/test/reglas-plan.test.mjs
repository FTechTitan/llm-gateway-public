import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluar, validarRegla, valorPlan } from '../lib/reglas-logica.mjs';

const ahora = Date.parse('2026-11-09T12:00:00Z');
const seg = (ms) => Math.floor(ms / 1000);
// Semana que empezó hace 3 días (quedan 4): 3/7 = 42,86 % transcurrido.
const plan = { ventanas: [
  { clave: '7d', usado: 0.6, ventana_min: 10080, reset: seg(ahora + 4 * 864e5) },
  { clave: '5h', usado: 0.2, ventana_min: 300, reset: seg(ahora + 4 * 3600e3) },
] };
const base = { id: 'r', empresa_id: 'e', activa: true, accion: 'cortar', filtro_plan: 'claude:x', nombre: 'n' };

test('pct_plan devuelve el % usado de la ventana pedida', () => {
  assert.equal(valorPlan({ ...base, metrica: 'pct_plan', plan_ventana: '7d' }, plan, ahora), 60);
  assert.equal(valorPlan({ ...base, metrica: 'pct_plan', plan_ventana: '5h' }, plan, ahora), 20);
});

test('ritmo_plan devuelve puntos sobre el tiempo transcurrido', () => {
  const v = valorPlan({ ...base, metrica: 'ritmo_plan', plan_ventana: '7d' }, plan, ahora);
  assert.ok(Math.abs(v - (60 - 300 / 7)) < 1e-9);          // 60 − 42,86 = 17,14
  const v5 = valorPlan({ ...base, metrica: 'ritmo_plan', plan_ventana: '5h' }, plan, ahora);
  assert.ok(Math.abs(v5 - 0) < 1e-9);                      // 20 % usado con 1 h de 5 pasada = justo al ritmo
});

test('una ventana ya reiniciada o sin dato vale 0', () => {
  const viejo = { ventanas: [{ clave: '7d', usado: 0.99, ventana_min: 10080, reset: seg(ahora - 1000) }] };
  assert.equal(valorPlan({ ...base, metrica: 'pct_plan', plan_ventana: '7d' }, viejo, ahora), 0);
  assert.equal(valorPlan({ ...base, metrica: 'pct_plan', plan_ventana: '7d' }, undefined, ahora), 0);
});

test('evaluar corta cuando el plan pasa el límite', () => {
  const r = { ...base, metrica: 'pct_plan', plan_ventana: '7d', limite: 50 };
  const res = evaluar([r], (x) => valorPlan(x, plan, ahora), { empresa_id: 'e', cliente_id: 'c', proveedor: 'anthropic', modo: 'suscripcion', plan: 'claude:x' }, new Date(ahora));
  assert.equal(res.permitido, false);
  assert.match(res.motivo, /% del plan/);
});

test('validarRegla arma una regla del plan y rechaza datos malos', () => {
  const r = validarRegla({ nombre: 'tope', metrica: 'ritmo_plan', limite: 10, accion: 'cortar', filtro_plan: 'claude:a@b.cl', plan_ventana: '7d' });
  assert.equal(r.ventana_tipo, 'plan');
  assert.equal(r.filtro_plan, 'claude:a@b.cl');
  assert.throws(() => validarRegla({ nombre: 't', metrica: 'pct_plan', limite: 120, accion: 'cortar', filtro_plan: 'claude:a', plan_ventana: '7d' }));
  assert.throws(() => validarRegla({ nombre: 't', metrica: 'pct_plan', limite: 90, accion: 'cortar', plan_ventana: '7d' }));
  assert.throws(() => validarRegla({ nombre: 't', metrica: 'pct_plan', limite: 90, accion: 'cortar', filtro_plan: 'claude:a', plan_ventana: '3d' }));
});

test('una regla del plan solo frena las llamadas de esa cuenta', () => {
  const r = { ...base, metrica: 'pct_plan', plan_ventana: '7d', limite: 50 };
  const ctx = { empresa_id: 'e', cliente_id: 'c', proveedor: 'anthropic', modo: 'suscripcion' };
  const valor = (x) => valorPlan(x, plan, ahora);
  assert.equal(evaluar([r], valor, { ...ctx, plan: 'claude:x' }, new Date(ahora)).permitido, false);
  assert.equal(evaluar([r], valor, { ...ctx, plan: 'claude:otra' }, new Date(ahora)).permitido, true);
  assert.equal(evaluar([r], valor, { ...ctx, modo: 'api', plan: null }, new Date(ahora)).permitido, true);
});

test('umbral de aviso: avisa sin cortar y corta solo al llegar al límite', () => {
  const r = { ...base, metrica: 'pct_plan', plan_ventana: '7d', limite: 80, limite_aviso: 50 };
  const ctx = { empresa_id: 'e', cliente_id: 'c', proveedor: 'anthropic', modo: 'suscripcion', plan: 'claude:x' };
  const res = evaluar([r], () => 60, ctx, new Date(ahora));
  assert.equal(res.permitido, true);
  assert.equal(res.avisos.length, 1);
  assert.equal(evaluar([r], () => 85, ctx, new Date(ahora)).permitido, false);
  assert.equal(evaluar([r], () => 40, ctx, new Date(ahora)).avisos.length, 0);
  assert.throws(() => validarRegla({ nombre: 't', metrica: 'pct_plan', limite: 50, limite_aviso: 60, accion: 'cortar', filtro_plan: 'claude:a', plan_ventana: '7d' }));
});
