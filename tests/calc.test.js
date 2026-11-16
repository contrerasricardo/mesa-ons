// Pruebas del motor de bonos (docs/js/calc.js). Correr: ~/.bun/bin/bun test (desde mesa-ons/).
import { test, expect } from "bun:test";
import { vp, tir, duration, fijarFeriados, esHabil, habilDesde, dias, alinear, valorAl,
         redondearVN, vnValido, pase, flujosPrimaria, resolver } from "../docs/js/calc.js";

const bullet = (anios, cupon) => Array.from({ length: anios }, (_, i) =>
  [365 * (i + 1), i === anios - 1 ? 100 : 0, cupon, 0]);

test("cupón cero: TIR y duration cerradas", () => {
  const fl = [[730, 100, 0, 0]], p = 100 / 1.1 ** 2;
  expect(tir(fl, p)).toBeCloseTo(0.1, 9);
  const d = duration(fl, 0.1);
  expect(d.macaulay).toBeCloseTo(2, 9);
  expect(d.modificada).toBeCloseTo(2 / 1.1, 9);
});

test("a la par la TIR es el cupón, y vp/tir son inversas", () => {
  const fl = bullet(5, 8);
  expect(tir(fl, 100)).toBeCloseTo(0.08, 9);
  for (const y of [-0.02, 0.03, 0.12, 0.45]) expect(tir(fl, vp(fl, y))).toBeCloseTo(y, 8);
});

test("tir sin precio o sin flujos devuelve null", () => {
  expect(tir([], 100)).toBeNull();
  expect(tir(bullet(3, 5), 0)).toBeNull();
});

test("duration modificada aproxima la variación de precio", () => {
  const fl = bullet(7, 6), y = 0.07, h = 1e-4;
  const md = duration(fl, y).modificada;
  const deriv = -(vp(fl, y + h) - vp(fl, y - h)) / (2 * h) / vp(fl, y);
  expect(md).toBeCloseTo(deriv, 5);
});

test("feriados y días hábiles", () => {
  fijarFeriados(["2026-11-23"]);
  expect(esHabil("2026-11-21")).toBe(false);            // sábado
  expect(esHabil("2026-11-23")).toBe(false);            // feriado
  expect(habilDesde("2026-11-21")).toBe("2026-11-24");  // sáb → salta dom y feriado
  expect(habilDesde("2026-11-24")).toBe("2026-11-24");
  fijarFeriados([]);
});

test("alinear corre los días y saca los pagos ya hechos", () => {
  expect(dias("2026-01-01", "2026-01-31")).toBe(30);
  const fl = [[10, 0, 4, 0], [375, 100, 4, 0]];
  expect(alinear(fl, "2026-01-01", "2026-01-21")).toEqual([[355, 100, 4, 0]]);
});

test("valorAl capitaliza solo lo cobrado hasta T", () => {
  const fl = [[365, 0, 10, 0], [730, 100, 10, 0]];
  expect(valorAl(fl, 365, 0.05)).toBeCloseTo(10, 9);
  expect(valorAl(fl, 730, 0.05)).toBeCloseTo(10 * 1.05 + 110, 9);
});

test("lámina mínima e incremento", () => {
  const r = { min: 1000, inc: 1 };
  expect(redondearVN(999.5, r)).toBe(0);
  expect(redondearVN(1234.9, r)).toBe(1234);
  expect(redondearVN(25000, { min: 10000, inc: 10000 })).toBe(20000);
  expect(vnValido(1234, r)).toBe(true);
  expect(vnValido(15000, { min: 10000, inc: 10000 })).toBe(false);
  expect(vnValido(500, r)).toBe(false);
});

test("pase contra sí mismo sin comisiones: mejora cero", () => {
  const fl = bullet(3, 7), p = vp(fl, 0.07);
  const r = pase({ fA: fl, pA: p, fB: fl, pB: p, comVenta: 0, comCompra: 0, reinv: 0.07 });
  expect(r.mejora).toBeCloseTo(0, 9);
  expect(r.bVenceAntes).toBe(true);
});

test("pase a un bono más largo: el quiebre deja la riqueza igual", () => {
  const fA = bullet(2, 6), fB = bullet(5, 9);
  const pA = vp(fA, 0.065), pB = vp(fB, 0.085);
  const r = pase({ fA, pA, fB, pB, comVenta: 0.005, comCompra: 0.005, reinv: 0.06 });
  expect(r.bVenceAntes).toBe(false);
  expect(r.yB).toBeCloseTo(0.085, 8);
  // con la TIR de salida en el quiebre, pasar rinde lo mismo que quedarse
  const restoB = fB.filter(f => f[0] > r.T).map(([d, c, x, a]) => [d - r.T, c, x, a]);
  const pasar = r.nB * (valorAl(fB, r.T, 0.06) + vp(restoB, r.tirQuiebre));
  expect(pasar).toBeCloseTo(r.quedarse, 6);
  expect(r.ensanchePb).toBeCloseTo((r.tirQuiebre - r.yB) * 1e4, 9);
});

test("comisiones bajan la mejora", () => {
  const fl = bullet(3, 7), p = vp(fl, 0.07);
  const r = pase({ fA: fl, pA: p, fB: fl, pB: p, comVenta: 0.01, comCompra: 0.01, reinv: 0.07 });
  expect(r.mejora).toBeLessThan(0);
});

test("primaria semestral: fechas, renta y amortización", () => {
  const fl = flujosPrimaria({ liq: "2026-01-15", vencimiento: "2028-01-15", cupon: 0.08 });
  expect(fl.length).toBe(4);
  expect(fl.map(f => f[2])).toEqual([4, 4, 4, 4]);
  expect(fl.reduce((s, f) => s + f[1], 0)).toBe(100);
  expect(fl[3][0]).toBe(dias("2026-01-15", "2028-01-15"));
  const amort = flujosPrimaria({ liq: "2026-01-15", vencimiento: "2028-01-15", cupon: 0.08, cuotas: 2 });
  expect(amort.map(f => f[1])).toEqual([0, 0, 50, 50]);
  expect(amort[3][2]).toBeCloseTo(2, 9);               // renta sobre el residual de 50
});

test("primaria: fin de mes no se corre", () => {
  const fl = flujosPrimaria({ liq: "2026-08-31", vencimiento: "2027-08-31", cupon: 0.1 });
  expect(fl[0][0]).toBe(dias("2026-08-31", "2027-02-28"));
});

test("resolver encuentra la raíz o devuelve null", () => {
  expect(resolver(x => x * x - 2, 0, 2)).toBeCloseTo(Math.SQRT2, 9);
  expect(resolver(x => x * x + 1, 0, 2)).toBeNull();
});

test("bono que cotiza por residual (tipo ARC1): escalar flujos = precio por original", () => {
  // VR 82,6: quedan 82,6 de capital en 2 cuotas, cupón 6% sobre residual
  const vr = 82.6, fl = [[180, 41.3, 2.478, 0], [365, 41.3, 1.239, 0]];
  const px = 101, esc = fl.map(([d, c, r, a]) => [d, c * 100 / vr, r * 100 / vr, a * 100 / vr]);
  expect(tir(fl, px)).toBeLessThan(0);                          // leído por original: absurdo
  expect(tir(esc, px)).toBeCloseTo(tir(fl, px * vr / 100), 9);  // escalar flujos ≡ bajar el precio
  expect(tir(esc, px)).toBeGreaterThan(0.01);
});
