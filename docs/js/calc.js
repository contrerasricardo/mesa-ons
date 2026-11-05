// Cálculo de bonos: mismas convenciones que CEREBRO/scripts/calculadora_bonos.py.
// Flujos [días desde la liquidación, capital, renta, ajuste] por 100 de VN original; precio SUCIO.
// TIR efectiva anual: P = Σ CF / (1+TIR)^(d/365). Newton con bisección de respaldo.

const total = ([, c, r, a]) => c + r + a;

export function vp(flujos, y) {
  return flujos.reduce((s, f) => s + total(f) / (1 + y) ** (f[0] / 365), 0);
}

export function tir(flujos, precio) {
  if (!precio || !flujos.length) return null;
  let y = 0.1;
  for (let i = 0; i < 60; i++) {
    const v = vp(flujos, y) - precio;
    const dv = flujos.reduce((s, f) => s - (f[0] / 365) * total(f) * (1 + y) ** (-(f[0] / 365) - 1), 0);
    if (!isFinite(v) || !dv) break;
    const n = y - v / dv;
    if (!isFinite(n) || n <= -0.99) break;
    if (Math.abs(n - y) < 1e-10) return n;
    y = n;
  }
  let lo = -0.9, hi = 10;
  if ((vp(flujos, lo) - precio) * (vp(flujos, hi) - precio) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    (vp(flujos, m) - precio > 0) ? (lo = m) : (hi = m);
  }
  return (lo + hi) / 2;
}

export function duration(flujos, y) {
  const p = vp(flujos, y);
  const mac = flujos.reduce((s, f) => s + (f[0] / 365) * total(f) / (1 + y) ** (f[0] / 365), 0) / p;
  return { macaulay: mac, modificada: mac / (1 + y) };
}

// data912 cotiza a 24 hs: liquida el próximo día hábil, con los feriados de data/reference/supuestos-pesos.json (los mismos del
// motor de pesos). Un día no hábil opera el hábil siguiente y liquida el posterior.
let FERIADOS = new Set();
export const fijarFeriados = lista => { FERIADOS = new Set(lista); };
export const esHabil = iso => { const w = new Date(iso + "T12:00:00Z").getUTCDay(); return w !== 0 && w !== 6 && !FERIADOS.has(iso); };
export const habilDesde = iso => { let d = iso; while (!esHabil(d)) d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10); return d; };
const sig = iso => habilDesde(new Date(Date.parse(iso) + 864e5).toISOString().slice(0, 10));
export function liquidacionHoy(hoy = new Date()) {
  const h = new Date(hoy.getTime() - hoy.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  return sig(esHabil(h) ? h : habilDesde(h));
}

export const dias = (desde, hasta) => Math.round((Date.parse(hasta) - Date.parse(desde)) / 864e5);

// Los días del cierre cuentan desde su liquidación: se corren a la de hoy y se sacan los pagos ya hechos.
export function alinear(flujos, liqCierre, liq) {
  const k = dias(liqCierre, liq);
  return flujos.map(([d, c, r, a]) => [d - k, c, r, a]).filter(f => f[0] > 0);
}

// Pase con flujos exactos, medido al vencimiento del bono que se vende (A).
//   Quedarse: los flujos de A, reinvertidos a `reinv` hasta su vencimiento.
//   Pasar: se vende A a pA (neto de comisión), se compran nB nominales de B a pB (más comisión); los flujos de B hasta
//   el vencimiento de A se reinvierten a `reinv`, y lo que le queda a B se vende ese día a la TIR de salida.
// Si B vence después de A: TIR de salida de B que iguala las dos riquezas (quiebre) y cuántos pb puede ensancharse.
// Si B vence antes: no hay salida; se reinvierte todo a `reinv` y el quiebre es la tasa de reinversión que iguala.
export function pase({ fA, pA, fB, pB, comVenta, comCompra, reinv }) {
  const T = Math.max(...fA.map(f => f[0]));
  const fv = (fl, r) => fl.filter(f => f[0] <= T).reduce((s, f) => s + total(f) * (1 + r) ** ((T - f[0]) / 365), 0);
  const nB = (pA * (1 - comVenta)) / (pB * (1 + comCompra));
  const restoB = fB.filter(f => f[0] > T).map(([d, c, r, a]) => [d - T, c, r, a]);
  const quedarse = r => fv(fA, r);
  const pasar = (r, ySal) => nB * (fv(fB, r) + (restoB.length ? vp(restoB, ySal) : 0));
  const yB = tir(fB, pB);
  const out = { T, nB, yB, quedarse: quedarse(reinv), conSalidaHoy: pasar(reinv, yB), bVenceAntes: !restoB.length };
  out.mejora = out.conSalidaHoy / out.quedarse - 1;
  if (restoB.length) {
    // pasar(ySal) baja con ySal: bisección sobre la TIR de salida
    let lo = -0.5, hi = 5;
    const g = y => pasar(reinv, y) - out.quedarse;
    if (g(lo) * g(hi) <= 0) {
      for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; g(m) > 0 ? (lo = m) : (hi = m); }
      out.tirQuiebre = (lo + hi) / 2;
      out.ensanchePb = (out.tirQuiebre - yB) * 1e4;
    }
  } else {
    let lo = -0.5, hi = 5;
    const g = r => pasar(r, 0) / quedarse(r) - 1;
    if (g(lo) * g(hi) <= 0) {
      const s = g(lo) > 0;
      for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; (g(m) > 0) === s ? (lo = m) : (hi = m); }
      out.reinvQuiebre = (lo + hi) / 2;
    }
  }
  return out;
}

// Primaria: flujos por 100 de VN desde la liquidación de la emisión. Los pagos caen cada `meses` desde esa fecha (como en los
// prospectos) y el último al vencimiento; renta = cupón × meses/12 sobre el valor residual, el período corto final a días/365.
// Amortización al vencimiento o en `cuotas` partes iguales en los últimos pagos.
const masMeses = (iso, m) => {
  const [y, mo, d] = iso.split("-").map(Number), f = new Date(Date.UTC(y, mo - 1 + m, 1));
  const ult = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate();
  f.setUTCDate(Math.min(d, ult)); return f.toISOString().slice(0, 10);
};
export function flujosPrimaria({ liq, vencimiento, cupon, meses = 6, cuotas = 1 }) {
  const fechas = [];
  for (let k = 1; ; k++) { const f = masMeses(liq, k * meses); if (f >= vencimiento) break; fechas.push(f); }
  fechas.push(vencimiento);
  const n = Math.min(Math.max(1, Math.round(cuotas)), fechas.length);
  let vr = 100, previa = liq;
  return fechas.map((f, i) => {
    const completo = masMeses(previa, meses) === f;
    const renta = vr * cupon * (completo ? meses / 12 : dias(previa, f) / 365);
    const capital = i >= fechas.length - n ? 100 / n : 0;
    vr -= capital; previa = f;
    return [dias(liq, f), capital, renta, 0];
  });
}

// Bisección genérica sobre una función monótona en [lo, hi].
export function resolver(g, lo, hi) {
  if (!(g(lo) * g(hi) <= 0)) return null;
  const s = g(lo) > 0;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; (g(m) > 0) === s ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}
