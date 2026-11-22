// STP (Sales Trader Personal): cierre de BYMA (docs/data, lo regenera la Action cada día hábil) + puntas en vivo de data912 y BYMA Data.
// Comprar se mide a la punta vendedora (ask) y vender a la compradora (bid); para un bono que cobra CCL, la TIR de la
// línea D supone canje cero al cobro. La TIR de cierre nunca se mezcla con el precio vivo.
import { tir, vp, duration, convexidad, liquidacionHoy, alinear, dias, pase, fijarFeriados, habilDesde, flujosPrimaria, resolver, valorAl, redondearVN, vnValido } from "./calc.js?v=20261122h";
import { crearMotor } from "./pesos.js?v=20261122h";

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = (d) => new Intl.NumberFormat("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 2) => v == null || !isFinite(v) ? "—" : nf(d).format(v);
const pct = (v, d = 2) => v == null || !isFinite(v) ? "—" : nf(d).format(100 * v) + "%";
const pb = v => v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + nf(0).format(v);
// nominales a la punta, compactos (350 k, 1,2 M)
const cant = v => !(v > 0) ? "" : v >= 1e6 ? nf(1).format(v / 1e6) + " M" : v >= 1e3 ? nf(0).format(v / 1e3) + " k" : nf(0).format(v);
const conCant = (px, q, d = 2) => px == null ? "—" : `${num(px, d)}${q > 0 ? ` <small class="cant">${cant(q)}</small>` : ""}`;
const fecha = s => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "—";
const mas = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);
const hoyISO = () => new Date().toISOString().slice(0, 10);

const guardado = {
  leer(k, def) { try { const v = localStorage.getItem("mesa." + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  escribir(k, v) { try { v == null ? localStorage.removeItem("mesa." + k) : localStorage.setItem("mesa." + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const E = { meta: null, ons: [], soberanos: [], pesos: [], pagos: [], vivo: new Map(), vivoCI: new Map(), horaVivo: null, errorVivo: null,
  liq: liquidacionHoy(), lista: new Set(guardado.leer("lista", [])), orden: guardado.leer("orden", {}), emisores: null };

// ---------- instrumentos ----------
function lineasON(tk) { const b = tk.slice(0, -1); return { D: b + "D", C: b + "C" }; }
// Provinciales: el ticker de la base es la especie en pesos; las líneas en dólares tienen otro código de BYMA
// (verificado contra el precio del cierre; data912 lista estas y no las que derivaría la regla general).
const ALIAS_SOB = { BA37D: "BA7D", BB37D: "BB7D", BC37D: "BC7D", SA24D: "S24D", ERM33: "EM33", NDG34: "NDG4", NDT25: "NDT5", PMM29: "PM29", PUA36: "PUA6", SFD34: "SFD4" };
function lineasSob(tk, x) {
  // manda el nombre que publica BYMA para cada línea (docs/data/soberanos.json, `lineas_byma`); el alias y la regla quedan de respaldo
  const lb = x && x.lineas_byma;
  if (lb && lb.D) return lb.C ? { D: lb.D, C: lb.C } : { D: lb.D };
  if (ALIAS_SOB[tk]) return { D: ALIAS_SOB[tk] + "D", C: ALIAS_SOB[tk] + "C" };
  return tk.endsWith("D") ? { D: tk, C: tk.slice(0, -1) + "C" } : { D: tk + "D", C: tk + "C" };
}

function normalizar(x, tipo) {
  const lineas = tipo === "on" ? lineasON(x.tk) : tipo === "sob" ? lineasSob(x.tk, x) : { ARS: x.tk };
  const cobra = tipo === "on" ? x.cobra : tipo === "sob" ? (x.ley === "NY" ? "CCL" : "MEP") : "ARS";
  const b = { ...x, tipo, lineas, cobra, px: x.cierre.px, ytm: x.cierre.ytm == null ? null : x.cierre.ytm / 100,
    dm: x.cierre.dm, vol: x.cierre.adtv_usd, calculable: ["fix", "cap"].includes(x.tipo_flujos) && x.flujos.length > 0 };
  if (porResidual(b, b.px)) { b.residual = true; b.ytm = tir(escalar(b.flujos, b), b.px); }
  return b;
}

// Algunas ONs amortizables cotizan por 100 de VN RESIDUAL (p. ej. ARC1), no por 100 de VN original como el resto: leído por
// original, el precio pagaría más que todo lo que le queda al bono (TIR < 0,5%) y leído por residual da una TIR razonable.
// En esas, los flujos se pasan a 100 de residual, así el precio de pantalla (y el que escribas) se usa tal cual.
function porResidual(b, px) {
  if (!(b.vr < 99.9) || !b.calculable || !(px > 0)) return false;
  const t1 = tir(b.flujos, px), t2 = tir(b.flujos, px * b.vr / 100);
  return (t1 == null || t1 < 0.005) && t2 != null && t2 > 0.01 && t2 < 0.4;
}
const escalar = (fl, b) => b.residual ? fl.map(([d, c, r, a]) => [d, c * 100 / b.vr, r * 100 / b.vr, a * 100 / b.vr]) : fl;
const flujosHoy = b => escalar(alinear(b.flujos, b.liq, E.liq), b);
// TIR fuera de lo posible (negativa o de más de 40%): punta vieja, vencimiento de días o flujos dudosos
const dudosa = t => t != null && (t < 0 || t > 0.4);
const TIRV = t => dudosa(t) ? `<span class="aviso" title="TIR imposible: punta vieja, vencimiento de días o flujos dudosos; no usar sin revisar">${pct(t)} ⚠</span>` : pct(t);

function enLista(b) {
  if (E.lista.has(b.tk)) return true;
  return Object.values(b.lineas).some(s => E.lista.has(s)) || (b.tipo === "on" && E.lista.has(b.tk.slice(0, -1)));
}

// Puntas en vivo de una línea, con TIR a cada punta sobre los flujos corridos a la liquidación de hoy.
const memo = new Map();
function enVivo(b, linea) {
  const k = b.tipo + b.tk + linea;
  if (!memo.has(k)) memo.set(k, calcularVivo(b, linea));
  return memo.get(k);
}
function calcularVivo(b, linea) {
  const q = E.vivo.get(b.lineas[linea]);
  if (!q) return null;
  // en una línea en dólares, un precio de miles es la especie en pesos mal rotulada: no sirve
  if ((linea === "D" || linea === "C") && (q.px_ask > 1000 || q.px_bid > 1000)) return null;
  if (!b.residual && porResidual(b, q.px_ask > 0 ? q.px_ask : q.px_bid)) b.residual = true;
  const fl = b.calculable ? flujosHoy(b) : [];
  const ask = q.px_ask > 0 ? q.px_ask : null, bid = q.px_bid > 0 ? q.px_bid : null;
  const tAsk = fl.length && ask ? tir(fl, ask) : null, tBid = fl.length && bid ? tir(fl, bid) : null;
  return { ask, bid, qAsk: ask ? q.q_ask : null, qBid: bid ? q.q_bid : null, ultimo: q.c || null, tAsk, tBid, vol: q.v, ancho: ask && bid ? ask / bid - 1 : null, fuente: q.fuente,
    dm: tAsk != null ? duration(fl, tAsk).modificada : null, flujos: fl };
}

// Sin ninguna punta en vivo (data912 y BYMA caídos): el cierre como precio de referencia, solo si cotizó en la misma
// moneda que la línea elegida (D = MEP, C = CCL), para que el canje no ensucie la comparación. Nunca se mezcla con vivo.
function deCierre(b, linea) {
  if (!(b.px > 0) || !b.calculable || b.cierre?.fxr !== ({ D: "MEP", C: "CCL" })[linea]) return null;
  const fl = flujosHoy(b), t = tir(fl, b.px);
  return t == null ? null : { ask: b.px, bid: b.px, tAsk: t, tBid: t, ancho: null, dm: duration(fl, t).modificada, flujos: fl, fuente: "cierre" };
}

function canje(b) {
  const d = E.vivo.get(b.lineas.D), c = E.vivo.get(b.lineas.C);
  if (!d || !c || !(d.px_bid > 0 && d.px_ask > 0 && c.px_bid > 0 && c.px_ask > 0) || c.px_ask / c.px_bid > 1.02) return null;
  return ((d.px_bid + d.px_ask) / 2) / ((c.px_bid + c.px_ask) / 2) - 1;
}

// ---------- carga ----------
async function cargar() {
  const leer = n => fetch(`data/${n}.json`, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(n); return r.json(); });
  const [meta, ons, sob, pesos, pagos] = await Promise.all(["meta", "ons", "soberanos", "pesos", "pagos"].map(leer));
  E.meta = meta;
  // universo: solo las ONs de chamomberg (lo que distribuye Balanz), en todas las pestañas
  E.ons = ons.filter(x => x.chamomberg).map(x => normalizar(x, "on"));
  E.soberanos = sob.map(x => normalizar(x, "sob"));
  E.pesos = pesos.map(x => normalizar(x, "ars"));
  try { E.motor_meta = await leer("motor_pesos"); fijarFeriados(E.motor_meta.feriados); E.motor = crearMotor(pesos, E.motor_meta, meta); } catch (e) { console.error(e); E.motor = null; }
  E.liq = liquidacionHoy();
  // el pago que cae en sábado, domingo o feriado se cobra el hábil siguiente
  const fuera = new Set(ons.filter(x => !x.chamomberg).map(x => x.tk));
  E.pagos = pagos.filter(p => !fuera.has(p.tk)).map(p => ({ ...p, cobro: habilDesde(p.fecha) }));
}

// Puntas de dos fuentes a 24 hs: data912 (al momento) y BYMA Data abierto (oficial, con 20 minutos de demora).
// Manda data912; BYMA completa la especie que data912 no trae o trae sin puntas, y queda sola si data912 no responde.
// Cada fuente tiene 10 s: BYMA a veces deja la conexión colgada sin error, y sin tope tapaba también a data912.
const BYMA_LIBRE = "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/";
const conPuntas = q => q && (q.px_bid > 0 || q.px_ask > 0);
function pedirBYMA(panel, ci = false) {
  const cuerpo = { excludeZeroPxAndQty: true, T0: ci, T1: !ci, T2: false, page_number: 1, page_size: 5000, "Content-Type": "application/json" };
  return fetch(BYMA_LIBRE + panel, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo), cache: "no-store", signal: AbortSignal.timeout(10000) })
    .then(x => x.json()).then(d => (d.data || d).map(r => ({ symbol: r.symbol, px_bid: r.bidPrice, px_ask: r.offerPrice, q_bid: r.quantityBid,
      q_ask: r.quantityOffer, c: r.trade, v: r.volume, fuente: "BYMA" })));
}
let pidiendo = false;
async function pedirVivo() {
  if (pidiendo) return;
  pidiendo = true;
  try { await pedirVivo1(); } finally { pidiendo = false; }
}
async function pedirVivo1() {
  const d912 = ["arg_corp", "arg_bonds", "arg_notes"], byma = ["negociable-obligations", "public-bonds"];
  $("#btn-vivo").disabled = true;
  const [a, b, ci] = await Promise.all([
    Promise.allSettled(d912.map(f => fetch(`https://data912.com/live/${f}`, { cache: "no-store", signal: AbortSignal.timeout(10000) }).then(x => {
      if (f === "arg_corp") E.lmD912 = Date.parse(x.headers.get("last-modified")) || null;
      return x.json();
    }))),
    Promise.allSettled(byma.map(p => pedirBYMA(p))),
    pedirBYMA("public-bonds", true).catch(() => null)]);
  $("#btn-vivo").disabled = false;
  // contado inmediato: solo BYMA lo publica (para el pase de monedas)
  if (ci) E.vivoCI = new Map(ci.map(q => [q.symbol, q]));
  const okA = a.filter(x => x.status === "fulfilled"), okB = b.filter(x => x.status === "fulfilled");
  if (okA.length || okB.length) {
    const vivo = new Map(okB.flatMap(x => x.value.map(q => [q.symbol, q])));
    for (const q of okA.flatMap(x => x.value)) if (conPuntas(q) || !conPuntas(vivo.get(q.symbol))) vivo.set(q.symbol, { ...q, fuente: "data912" });
    E.vivo = vivo;
    memo.clear();
    E.horaVivo = new Date();
    const faltan = [okA.length < d912.length && "data912", okB.length < byma.length && "BYMA"].filter(Boolean);
    E.errorVivo = faltan.length ? `parcial: sin ${faltan.join(" ni ")}` : null;
    E.liq = liquidacionHoy();
  } else E.errorVivo = "sin conexión con data912 ni BYMA";
  estado();
  // si estás escribiendo en un campo, repintar sin sacarte de él
  const foco = document.activeElement;
  pintar(foco?.name && (foco.tagName === "TEXTAREA" || ["text", "search"].includes(foco.type)) && foco.closest(`#p-${actual}`) ? foco : undefined);
}

function estado() {
  const m = E.meta;
  let s = m ? `Cierre ${fecha(m.cierre)}` : "";
  if (E.horaVivo) s += ` · <span class="vivo">${enHorario() ? "● " : ""}puntas ${E.horaVivo.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span> · liq. ${fecha(E.liq).slice(0, 5)}`;
  if (E.errorVivo) s += ` · <span class="error">${esc(E.errorVivo)}</span>`;
  $("#estado").innerHTML = s;
}

// ---------- tablas ----------
function tabla(id, filas, cols, { alClick, clase, grupo } = {}) {
  const o = E.orden[id] || {};
  const col = cols.find(c => c.k === o.k);
  if (col) {
    const v = col.v || (f => f[col.k]);
    filas = [...filas].sort((a, b) => {
      const x = v(a), y = v(b);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * (o.asc ? 1 : -1);
    });
  }
  const th = cols.map(c => `<th data-k="${c.k}" class="${c.n ? "n " : ""}${c.cls || ""}${o.k === c.k ? " ord" + (o.asc ? " asc" : "") : ""}" ${c.titulo ? `title="${esc(c.titulo)}"` : ""}>${c.t}</th>`).join("");
  let previo = null;
  const tr = filas.map((f, i) => {
    let g = "";
    if (grupo && !col) { const gg = grupo(f); if (gg !== previo) { g = `<tr class="grupo"><td colspan="${cols.length}">${esc(gg)}</td></tr>`; previo = gg; } }
    return g + `<tr data-i="${i}" class="${clase ? clase(f) : ""}">` + cols.map(c => `<td class="${c.n ? "n " : ""}${c.cls || ""}">${c.f(f)}</td>`).join("") + "</tr>";
  }).join("");
  const caja = document.createElement("div");
  caja.className = "tabla-caja";
  caja.innerHTML = `<table><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${cols.length}" class="suave">Nada con estos filtros.</td></tr>`}</tbody></table>`;
  caja.querySelectorAll("th").forEach(h => h.onclick = () => {
    const k = h.dataset.k, a = E.orden[id];
    E.orden[id] = a?.k === k ? (a.asc ? null : { k, asc: true }) : { k, asc: false };
    guardado.escribir("orden", E.orden); pintar();
  });
  if (alClick) caja.querySelectorAll("tbody tr[data-i]").forEach(r => r.onclick = () => alClick(filas[+r.dataset.i]));
  return caja;
}

const filtros = {};
function filtro(id, def) { return filtros[id] ??= { ...def, ...guardado.leer("f." + id, {}) }; }
function barraFiltros(id, def, controles) {
  const f = filtro(id, def);
  const el = document.createElement("div");
  el.className = "filtros";
  el.innerHTML = controles;
  el.querySelectorAll("[name]").forEach(c => {
    if (c.type === "checkbox") c.checked = !!f[c.name]; else c.value = f[c.name] ?? "";
    c.addEventListener(c.type === "search" ? "input" : "change", () => {
      f[c.name] = c.type === "checkbox" ? c.checked : c.value;
      const { q, ...resto } = f; guardado.escribir("f." + id, resto);
      pintar(c.name === "q" ? c : null);
    });
  });
  el.querySelector("[data-lista]")?.addEventListener("click", editarLista);
  return el;
}

const buscar = (q, ...campos) => !q || campos.some(c => String(c ?? "").toLowerCase().includes(q.toLowerCase()));
const selLey = `<select name="ley"><option value="">Ley: todas</option><option>NY</option><option>ARG</option></select>`;
const selCobra = `<select name="cobra"><option value="">Cobra: todas</option><option>MEP</option><option>CCL</option></select>`;
const chipLista = `<label class="chip"><input type="checkbox" name="lista"> Mi lista</label><button class="btn chico" type="button" data-lista>Editar lista</button>`;

// columnas comunes de bonos en dólares
function colsDolares() {
  const v = b => enVivo(b, "D");
  return [
    { k: "tk", t: "Ticker", f: b => `<span class="tk">${esc(b.tk)}</span>`, v: b => b.tk },
    { k: "emisor", t: "Emisor", cls: "emisor", f: b => esc(b.segmento === "sob" ? b.clase : b.emisor), v: b => b.emisor },
    { k: "ley", t: "Ley", f: b => b.ley, v: b => b.ley },
    { k: "cobra", t: "Cobra", f: b => b.cobra, v: b => b.cobra },
    { k: "vencimiento", t: "Vto.", f: b => fecha(b.vencimiento), v: b => b.vencimiento },
    { k: "ask", t: "Compra D", n: 1, f: b => num(v(b)?.ask), v: b => v(b)?.ask, titulo: "Punta vendedora de la línea D (MEP): a cuánto compras" },
    { k: "tAsk", t: "TIR compra", n: 1, f: b => TIRV(v(b)?.tAsk) + (v(b) && b.residual ? ' <small class="cant" title="Cotiza por 100 de VN residual">resid.</small>' : ""), v: b => v(b)?.tAsk },
    { k: "bid", t: "Venta D", n: 1, f: b => num(v(b)?.bid), v: b => v(b)?.bid, titulo: "Punta compradora de la línea D (MEP): a cuánto vendes" },
    { k: "tBid", t: "TIR venta", n: 1, f: b => TIRV(v(b)?.tBid), v: b => v(b)?.tBid },
    { k: "ancho", t: "Puntas", n: 1, f: b => { const a = v(b)?.ancho; return a == null ? "—" : `<span class="${a > 0.01 ? "aviso" : ""}">${pct(a)}</span>`; }, v: b => v(b)?.ancho, titulo: "Ancho de puntas D: más de 1% pide orden límite" },
    { k: "volD", t: "Vol. negociado", n: 1, f: b => v(b)?.vol > 0 ? num(v(b).vol, 0) : "—", v: b => v(b)?.vol, titulo: "Nominales operados hoy en la línea D" },
  ];
}

// ---------- pestañas ----------
// ONs, soberanos y provinciales en una sola tabla: cupón, cierre, TIR y DM de BYMA quedan en la ficha
const TIPOS = { on: "ONs", sob: "Soberanos", pro: "Provinciales" };
const tipoDe = b => b.tipo === "on" ? "on" : b.segmento;
function pDolares() {
  const id = "dolares", f = filtro(id, { q: "", tipo: "", ley: "", cobra: "", lista: false, vivo: false });
  const todos = [...E.ons, ...E.soberanos];
  const filas = todos.filter(b => buscar(f.q, b.tk, b.emisor, b.clase) && (!f.tipo || tipoDe(b) === f.tipo)
    && (!f.ley || b.ley === f.ley) && (!f.cobra || b.cobra === f.cobra)
    && (!f.lista || enLista(b)) && (!f.vivo || enVivo(b, "D")?.ask));
  $("#p-dolares").replaceChildren(
    barraFiltros(id, f, `<input type="search" name="q" placeholder="Ticker o emisor">
      <select name="tipo"><option value="">Todos</option>${Object.entries(TIPOS).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>
      ${selLey}${selCobra}${chipLista}
      <label class="chip"><input type="checkbox" name="vivo"> Con punta</label>`),
    nota(`${filas.length} de ${todos.length} bonos hard dollar · vol. negociado = nominales operados hoy (lo que hay a cada punta, en la ficha) · la línea D de un bono que cobra CCL supone canje cero`),
    tabla(id, filas, colsDolares(), { alClick: ficha, clase: b => enLista(b) ? "mia" : "",
      grupo: b => b.tipo === "on" ? b.emisor : TIPOS[b.segmento] }));
}

function pPesos() { $("#p-pesos").replaceChildren(calculadoraPesos()); }

// Calculadora por fecha objetivo: el motor de Finanzas computacionales/calc_pesos.ipynb (Bloque 8) traducido en pesos.js, con la
// curva y las fichas del cierre de BYMA, CER y TAMAR del BCRA, el REM y la punta vendedora de data912.
const CALC_DEF = { objetivo: "", ventana: "30", monto: "1000000", caucion: "", modo: "rem", infl: "2", comBaja: "0,1", comStd: "0,5", comCau: "2" };
E.calc = { ...CALC_DEF, ...guardado.leer("calc", {}) };
const COLOR = { LECAP: "#3fa66a", BONCAP: "#4a7ebb", CER: "#d99a2b", TAMAR: "#d9534f", Dual: "#8e5fd6", "Caución": "#8a8a8a" };
const MEDALLA = ["🥇", "🥈", "🥉", "4º", "5º"];
const plata = v => v == null || !isFinite(v) ? "—" : "$ " + nf(0).format(v);
const DIAS_SEM = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// dd/mm/aaaa (también d/m/aa, con - o .) a ISO; nunca mes primero
function leerFecha(t) {
  const m = String(t).trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (!m) return null;
  const d = +m[1], mes = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const f = new Date(Date.UTC(y, mes - 1, d));
  return f.getUTCDate() === d && f.getUTCMonth() === mes - 1 ? f.toISOString().slice(0, 10) : null;
}
const fechaLarga = iso => { const f = new Date(iso + "T12:00:00Z"); return `${DIAS_SEM[f.getUTCDay()]} ${f.getUTCDate()} de ${MESES[f.getUTCMonth()]} de ${f.getUTCFullYear()}`; };
const etqTipo = t => `<span class="tipo" style="--c:${COLOR[t] || "#8a8a8a"}">${esc(t)}</span>`;

function paramsCalc(C) {
  const pc = v => { const x = dec(v); return x == null || !isFinite(x) ? undefined : x / 100; };
  const monto = +String(C.monto).replace(/[\s.$]/g, "").replace(",", ".");
  return { objetivo: C.objetivo, ventana: +C.ventana || 0, monto: isFinite(monto) ? monto : 0, vivo: E.vivo,
    inflMensual: C.modo === "fija" ? (pc(C.infl) ?? 0.02) : null, tnaCaucion: pc(C.caucion) ?? null,
    com: { baja: pc(C.comBaja), std: pc(C.comStd), cau: pc(C.comCau) } };
}

function calculadoraPesos() {
  const C = E.calc;
  if (!C.objetivo) C.objetivo = mas(E.liq, 60);
  const el = document.createElement("div");
  el.className = "tarjeta calc";
  if (!E.motor) { el.innerHTML = `<h4>¿Para cuándo necesitas la plata?</h4><p class="nota aviso">No cargó motor_pesos.json (CER, TAMAR y REM): la calculadora no puede correr.</p>`; return el; }
  const cau = E.meta.caucion_tna;
  el.innerHTML = `<h4>¿Para cuándo necesitas la plata?</h4>
    <div class="form-calc">
      <label class="campo">Fecha objetivo (dd/mm/aaaa)<input name="objetivo" inputmode="numeric" autocomplete="off" value="${fecha(C.objetivo)}"><small class="eco"></small></label>
      <label class="campo">Ventana ± días<input name="ventana" inputmode="numeric" value="${esc(C.ventana)}"></label>
      <label class="campo">Plata a invertir ($, con comisión)<input name="monto" inputmode="decimal" value="${esc(C.monto)}"></label>
      <label class="campo">TNA caución %<input name="caucion" inputmode="decimal" value="${esc(C.caucion)}" placeholder="${cau != null ? `${num(100 * cau)} (cierre)` : "sin dato"}"></label>
      <label class="campo">Inflación (CER)<select name="modo"><option value="rem">REM</option><option value="fija">Fija mensual</option></select></label>
      <label class="campo" data-infl>Inflación mensual %<input name="infl" inputmode="decimal" value="${esc(C.infl)}"></label>
    </div>
    <details class="mas-campos"><summary>Comisiones</summary><div class="form-calc">
      <label class="campo">LECAP y CER «X» %<input name="comBaja" inputmode="decimal" value="${esc(C.comBaja)}"></label>
      <label class="campo">Resto %<input name="comStd" inputmode="decimal" value="${esc(C.comStd)}"></label>
      <label class="campo">Caución % anual<input name="comCau" inputmode="decimal" value="${esc(C.comCau)}"></label>
    </div></details>
    <div id="res-calc"></div>`;
  const eco = el.querySelector(".eco"), inF = el.querySelector("[name=objetivo]");
  const verFecha = () => {
    const iso = leerFecha(inF.value);
    eco.textContent = iso ? fechaLarga(iso) : "escribe dd/mm/aaaa";
    eco.className = "eco" + (iso ? "" : " aviso");
    return iso;
  };
  const verModo = () => el.querySelector("[data-infl]").hidden = C.modo !== "fija";
  el.querySelector("[name=modo]").value = C.modo;
  el.querySelectorAll("[name]").forEach(c => c.addEventListener(c.name === "objetivo" ? "input" : "change", () => {
    if (c.name === "objetivo") { const iso = verFecha(); if (!iso) return; C.objetivo = iso; }
    else C[c.name] = c.value.trim();
    guardado.escribir("calc", C); verModo();
    el.querySelector("#res-calc").innerHTML = resultadoCalc(C);
  }));
  verFecha(); verModo();
  el.querySelector("#res-calc").innerHTML = resultadoCalc(C);
  return el;
}

function resultadoCalc(C) {
  const P = paramsCalc(C);
  const R = E.motor.recomendar(P);
  if (!R) return `<p class="nota aviso">La fecha objetivo tiene que ser posterior a hoy.</p>`;
  if (!R.ok.length) {
    const prox = E.motor.universo.filter(u => u.venc > Date.now() / 864e5)
      .sort((a, b) => Math.abs(a.venc - Date.parse(C.objetivo) / 864e5) - Math.abs(b.venc - Date.parse(C.objetivo) / 864e5))[0];
    return `<p class="nota aviso">Nada calculable vence dentro de ±${esc(C.ventana)} días del ${fecha(C.objetivo)}${prox ? `; el más cercano es ${esc(prox.tk)} (${fecha(prox.b.vencimiento)})` : ""}. Agranda la ventana.</p>`;
  }
  const top = R.ok.slice(0, 5), maxG = Math.max(...top.map(r => r.gananciaNeta), 1);
  const [g1, g2] = R.ok;
  const filaTop = (r, i) => `<div class="rk${i === 0 ? " primero" : ""}" style="--c:${COLOR[r.tipo] || "#8a8a8a"}">
      <div class="rk-med">${MEDALLA[i]}</div>
      <div class="rk-tit"><span class="tk">${esc(r.tk)}</span> ${etqTipo(r.tipo)}
        <small>${r.tipo === "Caución" ? `${R.D} d · ${esc(r.trat)}` : `${r.dias} d · ${esc(r.trat)}`}</small></div>
      <div class="rk-dato"><span>TEA a su vto.</span><b>${pct(r.tea)}</b><small>TNA ${pct(r.tna)}</small></div>
      <div class="rk-dato"><span>Rend. bruto</span><b>${pct(r.bruto)}</b></div>
      <div class="rk-dato"><span>Rend. neto</span><b class="pos">${pct(r.neto)}</b><small>com. ${pct(r.comision, 2)}</small></div>
      <div class="rk-gan"><span>Ganancia neta</span><b>${plata(r.gananciaNeta)}</b><i style="width:${Math.max(2, 100 * r.gananciaNeta / maxG)}%"></i></div>
      <div class="rk-dato"><span>Cobras el ${fecha(R.objetivo).slice(0, 5)}</span><b>${plata(r.finalNeto)}</b></div>
    </div>`;
  const veredicto = `<b>${esc(g1.tk)}</b> encabeza con <b>${plata(g1.gananciaNeta)}</b> de ganancia neta sobre ${plata(R.monto)}
    (${pct(g1.neto)} en ${R.D} días, TEA neta ${pct(g1.teaNeta)})${g1.vn ? `: ${nf(0).format(Math.floor(g1.vn))} VN a $ ${num(g1.precio, 2)}` : ""}.
    ${g2 ? `Le saca <b>${plata(g1.gananciaNeta - g2.gananciaNeta)}</b> a ${esc(g2.tk)}.` : ""}`;

  const completo = R.ok.map((r, i) => `<tr${i === 0 ? ' class="mia"' : ""}>
      <td><span class="tk">${esc(r.tk)}</span> ${etqTipo(r.tipo)}</td>
      <td>${r.tipo === "Caución" ? "—" : fecha(r.venc)}</td>
      <td class="n">${r.precio ? num(r.precio, 2) : "—"}${r.fuente === "cierre BYMA" ? ' <span class="etq">cierre</span>' : r.fuente === "último operado" ? ' <span class="etq">último</span>' : ""}${r.alerta ? ` <span class="aviso" title="${esc(r.alerta)}">⚠</span>` : ""}</td>
      <td class="n">${pct(r.tea)}</td><td class="n ocultar-movil">${pct(r.bruto)}</td><td class="n ocultar-movil">${pct(r.comision)}</td>
      <td class="n"><b>${pct(r.neto)}</b></td><td class="n">${plata(r.gananciaNeta)}</td>
      <td class="ocultar-movil suave nota-celda">${esc(r.trat)}<br>${esc(r.nota)}</td></tr>`).join("");

  const Q = E.motor.robustez(P, R);
  const podio = (lista, col) => `<div class="tabla-caja"><table><thead><tr><th>${col}</th><th>1º</th><th>2º</th><th>3º</th></tr></thead><tbody>
      ${lista.map(x => `<tr><td>${esc(x.e)}${x.t != null ? ` <span class="suave">(${pct(x.t)})</span>` : ""}</td>${[0, 1, 2].map(i => `<td>${x.top[i] ? `<span class="tk">${esc(x.top[i].tk)}</span> <span class="suave">${plata(x.top[i].gananciaNeta)}</span>` : "—"}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>`;
  const firme = l => l.length && l.every(x => x.top[0]?.tk === l[0].top[0]?.tk);
  const robusto = `<details class="robustez"><summary>Robustez: ¿cambia el podio?
      <span class="${firme(Q.podioCau) && firme(Q.podioInfl) ? "pos" : "aviso"}">${firme(Q.podioCau) && firme(Q.podioInfl) ? `${esc(g1.tk)} gana en todos los escenarios` : "el ganador cambia según el escenario"}</span></summary>
    ${Q.empate.length ? `<p class="nota">Caución de empate: TNA a la que lo que vence antes y reinvierte empata con ${esc(Q.empate[0].ref)}, que no depende de ella.</p>
      <div class="tabla-caja"><table><thead><tr><th>Título</th><th class="n">Días en caución</th><th class="n">TNA de empate</th></tr></thead><tbody>
      ${Q.empate.map(e => `<tr><td class="tk">${esc(e.tk)}</td><td class="n">${e.n}</td><td class="n">${e.tna < 0 ? `<span class="pos">gana aun con caución a 0</span>` : `<b>${pct(e.tna)}</b>`}</td></tr>`).join("")}</tbody></table></div>` : ""}
    ${Q.podioCau.length ? podio(Q.podioCau, "Caución futura") : ""}
    ${podio(Q.podioInfl, "Inflación (CER)")}
  </details>`;

  const avisos = [];
  if (R.ok.some(r => r.fuente === "último operado")) avisos.push("Los marcados «último» no tienen punta vendedora: usan el último operado de data912.");
  if (R.ok.some(r => r.fuente === "cierre BYMA")) avisos.push("Los marcados «cierre» no tienen precio en data912: usan el cierre de BYMA.");
  if (R.ok.some(r => r.alerta)) avisos.push("⚠ Precio con ajuste de unidad o a más de 8% del cierre: revisa la punta antes de usarlo.");
  if (R.ok.some(r => r.reinv < 0)) avisos.push("Lo que vence después se vende en la fecha a TIR constante y paga comisión otra vez: es un supuesto.");
  if (R.ok.some(r => r.tipo === "CER")) avisos.push(`CER proyectado con ${R.modo === "rem" ? esc(E.motor_meta.rem_fecha) : `${pct(R.inflMensual, 1)} mensual fijo`}; TAMAR con el sendero del REM.`);
  return `<div class="veredicto">${veredicto}</div>
    <div class="ranking">${top.map(filaTop).join("")}</div>
    <p class="nota">Liquida ${fecha(R.liq)} · ${R.D} días al ${fecha(R.objetivo)} · caución ${pct(R.tnaCau)} TNA (neta ${pct(R.tnaCauN)}) · precios: punta vendedora de data912 (sin punta, último operado)</p>
    <details><summary>Ranking completo (${R.ok.length})</summary><div class="tabla-caja"><table>
      <thead><tr><th>Título</th><th>Vto.</th><th class="n">Precio</th><th class="n">TEA a vto.</th><th class="n ocultar-movil">Bruto</th><th class="n ocultar-movil">Comisión</th><th class="n">Neto</th><th class="n">Ganancia</th><th class="ocultar-movil">Cómo llega · cálculo</th></tr></thead>
      <tbody>${completo}</tbody></table></div></details>
    ${robusto}
    ${R.sin.length ? `<details><summary>Sin cálculo (${R.sin.length})</summary><ul class="nota">${R.sin.map(r => `<li><span class="tk">${esc(r.tk)}</span>: ${esc(r.nota)}</li>`).join("")}</ul></details>` : ""}
    ${avisos.map(a => `<p class="nota">${a}</p>`).join("")}
    <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>`;
}

function pPagos() {
  const id = "pagos", f = filtro(id, { q: "", h: "90", tipo: "", lista: false, ley: "", cobra: "" });
  const desde = hoyISO(), hasta = f.h ? mas(desde, +f.h) : "9999";
  const porTk = new Map([...E.ons, ...E.soberanos].map(b => [b.tk, b]));
  const filas = E.pagos.filter(p => p.cobro >= desde && p.cobro <= hasta && buscar(f.q, p.tk, p.emisor) && (!f.tipo || (p.tipo || "on") === f.tipo)
    && (!f.ley || p.ley === f.ley) && (!f.cobra || p.cobra === f.cobra) && (!f.lista || (porTk.has(p.tk) && enLista(porTk.get(p.tk)))));
  const mes = p => new Date(p.cobro + "T12:00").toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  const cols = [
    { k: "cobro", t: "Cobro", f: p => fecha(p.cobro) + (p.cobro !== p.fecha ? ` <small class="suave" title="Fecha de pago del prospecto: no hábil, cobra el hábil siguiente">(${fecha(p.fecha).slice(0, 5)})</small>` : ""), v: p => p.cobro },
    { k: "tk", t: "Ticker", f: p => `<span class="tk">${esc(p.tk)}</span>`, v: p => p.tk },
    { k: "emisor", t: "Emisor", cls: "emisor", f: p => esc(p.emisor), v: p => p.emisor },
    { k: "ley", t: "Ley", f: p => p.ley, v: p => p.ley },
    { k: "cobra", t: "Cobra", f: p => p.cobra, v: p => p.cobra },
    { k: "renta", t: "Renta", n: 1, f: p => num(p.renta, 4), v: p => p.renta },
    { k: "amortizacion", t: "Amort.", n: 1, f: p => p.amortizacion ? num(p.amortizacion, 4) : "—", v: p => p.amortizacion },
    { k: "total", t: "Total", n: 1, f: p => num(p.total, 4), v: p => p.total },
  ];
  $("#p-pagos").replaceChildren(
    barraFiltros(id, f, `<input type="search" name="q" placeholder="Ticker o emisor">
      <select name="tipo"><option value="">Todos</option>${Object.entries(TIPOS).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>
      <select name="h"><option value="7">7 días</option><option value="30">30 días</option><option value="90">90 días</option><option value="180">6 meses</option><option value="365">12 meses</option><option value="">Todo</option></select>
      ${selLey}${selCobra}${chipLista}`),
    nota(`${filas.length} pagos · por 100 de VN original, en dólares · la fecha de corte de cupón todavía no está en la base`),
    tabla(id, filas, cols, { alClick: p => porTk.has(p.tk) && ficha(porTk.get(p.tk)), clase: p => porTk.has(p.tk) && enLista(porTk.get(p.tk)) ? "mia" : "", grupo: mes }));
}

// ---------- ficha ----------
function ficha(b) {
  const dlg = $("#ficha");
  const lineas = Object.keys(b.lineas).filter(l => !(l === "C" && b.cobra === "MEP"));
  const vivos = lineas.map(l => [l, enVivo(b, l)]);
  const fl = b.calculable ? alinear(b.flujos, b.liq, E.liq) : b.flujos;
  const base = b.calculable ? E.liq : b.liq;
  const cj = b.tipo !== "ars" ? canje(b) : null;
  const usd = b.tipo !== "ars";
  dlg.innerHTML = `<div class="dlg">
    <div class="cab-ficha"><div><h3>${esc(b.tk)} <span class="etq">${esc(b.ley)}</span> <span class="etq">cobra ${esc(b.cobra)}</span></h3>
      <div class="suave">${esc(b.emisor)}${b.clase ? " · " + esc(b.clase) : ""}</div></div>
      <button class="btn chico" data-cerrar type="button">Cerrar</button></div>
    <div class="datos">
      ${dato("Vencimiento", fecha(b.vencimiento))}${dato("Cupón", pct(b.cupon))}${dato("Frecuencia", esc(b.frecuencia || "—"))}
      ${dato("Valor residual", num(b.vr))}${dato("Cierre", num(b.px, usd ? 2 : 3))}${dato("TIR cierre", pct(b.ytm))}
      ${dato("DM cierre", num(b.dm))}${cj != null ? dato("Canje D/C", pct(cj, 1)) : ""}
      ${b.calificacion ? dato("Calificación", esc(b.calificacion)) : ""}${b.fuente_flujos && b.fuente_flujos !== "BYMA" ? dato("Flujos", esc(b.fuente_flujos)) : ""}
    </div>
    <div class="tabla-caja"><table><thead><tr><th>Línea</th><th class="n">Compra</th><th class="n">VN oferta</th><th class="n">TIR</th><th class="n">Venta</th><th class="n">VN demanda</th><th class="n">TIR</th><th class="n">Puntas</th><th class="n">DM</th><th class="n">Vol. negociado</th></tr></thead><tbody>
      ${vivos.map(([l, v]) => `<tr><td>${esc(b.lineas[l])}${v?.fuente === "BYMA" ? ` <span class="etq" title="Sin puntas en data912: puntas de BYMA, con 20 minutos de demora">BYMA</span>` : ""}</td><td class="n">${num(v?.ask, usd ? 2 : 3)}</td><td class="n">${v?.qAsk > 0 ? num(v.qAsk, 0) : "—"}</td><td class="n">${pct(v?.tAsk)}</td><td class="n">${num(v?.bid, usd ? 2 : 3)}</td><td class="n">${v?.qBid > 0 ? num(v.qBid, 0) : "—"}</td><td class="n">${pct(v?.tBid)}</td><td class="n ${v?.ancho > 0.01 ? "aviso" : ""}">${pct(v?.ancho)}</td><td class="n">${num(v?.dm)}</td><td class="n">${num(v?.vol, 0)}</td></tr>`).join("")}
    </tbody></table></div>
    ${b.cobra === "CCL" ? `<p class="nota">Cobra cable: la TIR de la línea D supone canje cero al cobro (piso del comprador en MEP).</p>` : ""}
    ${/revisar/.test(b.fuente_cobro || "") ? `<p class="nota aviso">Cobra ${esc(b.cobra)} · fuente: ${esc(b.fuente_cobro)}</p>` : ""}
    ${vivos.some(([, v]) => v?.ancho > 0.01) ? `<p class="nota aviso">Puntas de más de 1%: la TIR de la punta no es ejecutable, hace falta orden límite.</p>` : ""}
    <div class="acciones">
      <button class="btn" data-lista type="button">${enLista(b) ? "Quitar de mi lista" : "Agregar a mi lista"}</button>
      ${usd && b.calculable ? `<button class="btn" data-vendo type="button">Vendo en el pase</button><button class="btn" data-compro type="button">Compro en el pase</button>` : ""}
    </div>
    ${usd ? ticketHTML(b, lineas) : ""}
    <h4 style="margin:4px 0 0">Flujos por 100 de VN original</h4>
    <div class="tabla-caja"><table><thead><tr><th>Fecha</th><th class="n">Renta</th><th class="n">Amortización</th><th class="n">Total</th></tr></thead><tbody>
      ${fl.length ? fl.map(([d, c, r, a]) => `<tr><td>${fecha(mas(base, d))}</td><td class="n">${num(r + a, 4)}</td><td class="n">${c ? num(c, 4) : "—"}</td><td class="n">${num(c + r + a, 4)}</td></tr>`).join("")
        : `<tr><td colspan="4" class="suave">Sin flujos en la base.</td></tr>`}
    </tbody></table></div>
    ${b.tipo_flujos === "cer" ? `<p class="nota">CER: flujos de BYMA con el CER de hoy, sin proyectar inflación.</p>` : ""}
  </div>`;
  dlg.querySelector("[data-cerrar]").onclick = () => dlg.close();
  dlg.querySelector("[data-lista]").onclick = () => {
    const s = enLista(b) ? [...E.lista].filter(t => t !== b.tk && !Object.values(b.lineas).includes(t) && t !== b.tk.slice(0, -1)) : [...E.lista, b.tk];
    E.lista = new Set(s); guardado.escribir("lista", s); ficha(b); pintar();
  };
  dlg.querySelector("[data-vendo]")?.addEventListener("click", () => { E.pase.vendo = b.tk; E.pase.pv = ""; dlg.close(); ir("pase"); });
  dlg.querySelector("[data-compro]")?.addEventListener("click", () => { E.pase.compro = b.tk; E.pase.pc = ""; dlg.close(); ir("pase"); });
  if (usd) atarTicket(dlg, b);
  if (!dlg.open) dlg.showModal();
}
const dato = (t, v) => `<div class="dato"><span>${t}</span><b>${v}</b></div>`;
const grupo = (t, filas) => `<div class="grupo"><h5>${t}</h5>${filas.map(([k, v, clave]) => `<div class="fila${clave ? " clave" : ""}"><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;
const nota = t => Object.assign(document.createElement("p"), { className: "nota", innerHTML: t });
$("#ficha").addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function editarLista() {
  const dlg = $("#dlg-lista");
  $("#txt-lista").value = [...E.lista].join(", ");
  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    const s = [...new Set($("#txt-lista").value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];
    E.lista = new Set(s); guardado.escribir("lista", s); pintar();
  };
  dlg.showModal();
}

// ---------- ticket ----------
// Orden en dólares: con el monto, el VN redondeado hacia abajo a la lámina mínima, la comisión y lo que sobra; con el VN a vender,
// lo que entra neto. Regla de negociación (mínimo y de ahí de a `inc`): la escrita a mano (guardada por ticker) > la de la base
// (prospecto, ficha técnica de BYMA o chamomberg; solo el prospecto trae el incremento). Sin incremento se infiere de las órdenes:
// cada orden es mínimo + k·inc, así que el MCD entre el mínimo y las cantidades en las puntas es siempre un paso válido.
E.ticket = { lado: "compro", monto: "10000", vn: "", com: "0,5", ...guardado.leer("ticket", {}) };
E.laminas = guardado.leer("laminas", {});
const mcd = (a, b) => { a = Math.round(a); b = Math.round(b); while (b) [a, b] = [b, a % b]; return a; };
function cantidadesPuntas(b) {
  return [...new Set(Object.values(b.lineas || {}))].flatMap(t => { const q = E.vivo.get(t); return q ? [q.q_bid, q.q_ask] : []; }).filter(q => q > 0);
}
function reglaDe(b) {
  let m = E.laminas[b.tk];
  if (typeof m === "number") m = { min: m, inc: null };
  const min = m?.min || b.lamina, fuente = m?.min ? "a mano" : b.lamina ? b.lamina_fuente || "base" : "sin dato";
  if (!min) return { min: 1, inc: 1, fuente, supuesto: true, sinDato: true };
  const inc = m?.min ? m.inc : b.incremento;
  if (inc) return { min, inc, fuente, incFuente: m?.min ? "a mano" : "prospecto" };
  if (min === 1) return { min, inc: 1, fuente, incFuente: "de a 1" };
  const qs = cantidadesPuntas(b), menor = qs.filter(q => q + 1e-9 < min);
  const g = qs.filter(q => q + 1e-9 >= min).reduce(mcd, min);
  return { min, inc: g, fuente, incFuente: g < min ? "inferido de las puntas" : "supuesto = mínimo", supuesto: true, menor };
}
function avisosRegla(b, L) {
  const a = [];
  if (L.incFuente === "supuesto = mínimo") a.push(`${b.tk}: incremento supuesto igual al mínimo (las puntas no muestran cantidades que lo contradigan); si el prospecto permite de a menos, escríbelo.`);
  if (L.incFuente === "inferido de las puntas") a.push(`${b.tk}: incremento de ${num(L.inc, 0)} inferido de las cantidades en las puntas (siempre un paso válido; el real puede ser menor).`);
  if (L.menor?.length) a.push(`${b.tk}: hay puntas con menos que el mínimo de ${num(L.min, 0)} (${L.menor.map(q => num(q, 0)).join(", ")} VN): o el mínimo es menor, o son restos de tenencias.`);
  return a;
}
const textoRegla = L => L.min === L.inc ? `de ${num(L.min, 0)} en ${num(L.inc, 0)}` : `mínimo ${num(L.min, 0)} y de a ${num(L.inc, 0)}`;
const guardarRegla = (b, minTxt, incTxt) => {
  const min = dec(minTxt), inc = dec(incTxt), L = reglaDe(b);
  if (min === L.min && inc === L.inc) return;
  if (min) E.laminas[b.tk] = { min, inc: inc || null }; else delete E.laminas[b.tk];
  guardado.escribir("laminas", E.laminas);
};
function ticketHTML(b, lineas) {
  const T = E.ticket, L = reglaDe(b);
  return `<div class="tarjeta ticket"><h4>Ticket</h4>
    <div class="form-calc">
      <label class="campo">Línea<select name="t-linea">${lineas.map(l => `<option value="${l}">${esc(b.lineas[l])}</option>`).join("")}</select></label>
      <label class="campo">Operación<select name="t-lado"><option value="compro">Compro</option><option value="vendo">Vendo</option></select></label>
      <label class="campo" data-solo="compro">Monto US$<input name="t-monto" inputmode="decimal" value="${esc(T.monto)}"></label>
      <label class="campo" data-solo="vendo">VN a vender<input name="t-vn" inputmode="decimal" value="${esc(T.vn)}"></label>
      <label class="campo">Precio (vacío = punta)<input name="t-px" inputmode="decimal" placeholder=""></label>
      <label class="campo">Comisión %<input name="t-com" inputmode="decimal" value="${esc(T.com)}"></label>
      <label class="campo">Lámina mínima (${esc(L.fuente)})<input name="t-lam" inputmode="decimal" value="${L.sinDato ? "" : L.min}"></label>
      <label class="campo">Incremento (${esc(L.sinDato ? "sin dato" : L.incFuente)})<input name="t-inc" inputmode="decimal" value="${L.sinDato ? "" : L.inc}"></label>
    </div>
    <div class="t-res"></div></div>`;
}
function atarTicket(dlg, b) {
  const caja = dlg.querySelector(".ticket"), T = E.ticket;
  const c = n => caja.querySelector(`[name="t-${n}"]`);
  c("lado").value = T.lado;
  const calcular = () => {
    T.lado = c("lado").value; T.monto = c("monto").value; T.vn = c("vn").value; T.com = c("com").value;
    guardado.escribir("ticket", T);
    const lamTxt = c("lam").value.trim(), incTxt = c("inc").value.trim();
    guardarRegla(b, lamTxt, incTxt);
    const L = reglaDe(b);
    caja.querySelectorAll("[data-solo]").forEach(l => l.hidden = l.dataset.solo !== T.lado);
    const linea = c("linea").value, v = enVivo(b, linea), compro = T.lado === "compro";
    const punta = compro ? v?.ask : v?.bid, cant = compro ? v?.qAsk : v?.qBid;
    c("px").placeholder = punta ? num(punta) : "sin punta";
    caja.querySelector(".t-res").innerHTML = resultadoTicket(b, { compro, px: dec(c("px").value) ?? punta, punta, cant,
      com: (dec(T.com) ?? 0) / 100, L, monto: dec(String(T.monto).replace(/\./g, "")), vn: dec(String(T.vn).replace(/\./g, "")),
      flujos: v?.flujos ?? [], moneda: linea === "C" ? "US$ cable" : "US$ MEP" });
  };
  caja.querySelectorAll("input, select").forEach(e => e.addEventListener("input", calcular));
  calcular();
}
function resultadoTicket(b, o) {
  if (!o.px) return `<p class="nota aviso">Sin precio: escríbelo o actualiza las puntas.</p>`;
  const x = o.px / 100, avisos = [];
  let filas, vn;
  if (o.compro) {
    if (!(o.monto > 0)) return `<p class="nota">Escribe el monto.</p>`;
    vn = redondearVN(o.monto / (x * (1 + o.com)), o.L);
    if (!vn) return `<p class="nota aviso">No alcanza para una lámina: el mínimo es ${num(o.L.min, 0)} VN, unos ${o.moneda} ${num(o.L.min * x * (1 + o.com))}.</p>`;
    const bruto = vn * x, com = bruto * o.com, y = o.flujos.length ? tir(o.flujos, o.px * (1 + o.com)) : null;
    filas = [["VN a comprar", num(vn, 0)], ["Bruto", num(bruto)], ["Comisión", num(com)], ["Total a pagar", `<b>${num(bruto + com)}</b>`],
      ["Sobra", num(o.monto - bruto - com)], ["TIR neta", pct(y)]];
  } else {
    if (!(o.vn > 0)) return `<p class="nota">Escribe el VN a vender.</p>`;
    vn = o.vn;
    if (!vnValido(vn, o.L)) avisos.push(`${num(vn, 0)} VN no respeta la regla (${textoRegla(o.L)}); salvo que sea toda la tenencia, lo más cercano es ${num(redondearVN(vn, o.L), 0)}.`);
    const bruto = vn * x, com = bruto * o.com;
    filas = [["VN a vender", num(vn, 0)], ["Bruto", num(bruto)], ["Comisión", num(com)], ["Neto a cobrar", `<b>${num(bruto - com)}</b>`]];
  }
  if (o.cant > 0 && vn > o.cant && o.px === o.punta) avisos.push(`La punta ${o.compro ? "vendedora" : "compradora"} tiene ${num(o.cant, 0)} VN: el resto queda en el libro a otro precio.`);
  if (o.L.sinDato) avisos.push("Sin lámina mínima en la base: calculado de a 1 VN; confírmala antes de cargar la orden.");
  else avisos.push(...avisosRegla(b, o.L));
  return `<div class="datos">${filas.map(([t, v]) => dato(t, v)).join("")}</div>
    <p class="nota">En ${o.moneda}, a ${num(o.px)} por 100 de VN original · regla ${textoRegla(o.L)}.</p>
    ${avisos.map(a => `<p class="nota aviso">${esc(a)}</p>`).join("")}
    <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>`;
}

// ---------- primaria ----------
// Primaria contra secundario, los dos netos de la comisión del cliente: la TIR neta de la emisión contra la curva del emisor
// a la punta vendedora, interpolada a la misma duration. Si la primaria pierde, la orden sale con tasa mínima (o precio máximo).
E.prim = { emisor: "", ley: "ARG", cobra: "MEP", liq: "", vto: "", cupon: "", precio: "100", meses: "6", cuotas: "1", com: "0,5",
  extras: "", mismaLey: true, ...guardado.leer("prim", {}) };
function pPrimaria() {
  const P = E.prim;
  const emisores = [...new Set(E.ons.map(b => b.emisor))].sort();
  const eco = t => { const iso = leerFecha(t); return t ? (iso ? fechaLarga(iso) : "escribe dd/mm/aaaa") : ""; };
  const el = $("#p-primaria");
  el.innerHTML = `
    <datalist id="dl-emisores">${emisores.map(e => `<option value="${esc(e)}">`).join("")}</datalist>
    <div class="form-pase calc">
      <div class="tarjeta"><h4>La emisión</h4>
        <label class="campo">Emisor<input name="emisor" list="dl-emisores" value="${esc(P.emisor)}" placeholder="p. ej. YPF S.A."></label>
        <div class="fila"><label class="campo">Ley<select name="ley"><option>ARG</option><option>NY</option></select></label>
          <label class="campo">Cobra<select name="cobra"><option>MEP</option><option>CCL</option></select></label></div>
        <div class="fila"><label class="campo">Liquidación<input name="liq" inputmode="numeric" value="${esc(P.liq)}" placeholder="${fecha(E.liq)}"><span class="eco">${eco(P.liq)}</span></label>
          <label class="campo">Vencimiento<input name="vto" inputmode="numeric" value="${esc(P.vto)}" placeholder="dd/mm/aaaa"><span class="eco">${eco(P.vto)}</span></label></div>
      </div>
      <div class="tarjeta"><h4>Condiciones</h4>
        <div class="fila"><label class="campo">Cupón o tasa de corte % TNA<input name="cupon" inputmode="decimal" value="${esc(P.cupon)}" placeholder="p. ej. 8"></label>
          <label class="campo">Precio de suscripción<input name="precio" inputmode="decimal" value="${esc(P.precio)}"></label></div>
        <div class="fila"><label class="campo">Paga<select name="meses"><option value="1">Mensual</option><option value="3">Trimestral</option><option value="6">Semestral</option><option value="12">Anual</option></select></label>
          <label class="campo">Amortiza en (cuotas finales)<input name="cuotas" inputmode="numeric" value="${esc(P.cuotas)}"></label></div>
      </div>
      <div class="tarjeta"><h4>Contra el secundario</h4>
        <label class="campo">Comisión del cliente % (en los dos)<input name="com" inputmode="decimal" value="${esc(P.com)}"></label>
        <label class="campo">Comparables extra (tickers)<input name="extras" autocapitalize="characters" value="${esc(P.extras)}" placeholder="p. ej. TLCPO, VSCVO"></label>
        <label class="chip"><input type="checkbox" name="mismaLey"${P.mismaLey ? " checked" : ""}> Del emisor, solo la misma ley</label>
      </div>
    </div>
    <div id="res-prim"></div>`;
  el.querySelector("[name=ley]").value = P.ley; el.querySelector("[name=cobra]").value = P.cobra; el.querySelector("[name=meses]").value = P.meses;
  el.querySelectorAll("[name]").forEach(c => c.addEventListener("change", () => {
    P[c.name] = c.type === "checkbox" ? c.checked : c.value.trim();
    if (c.name === "emisor") { const b = E.ons.find(x => x.emisor === P.emisor); if (b) { P.ley = b.ley; P.cobra = b.cobra; } }
    guardado.escribir("prim", P); pPrimaria();
  }));
  $("#res-prim").innerHTML = resultadoPrimaria();
}

function resultadoPrimaria() {
  const P = E.prim;
  const liq = leerFecha(P.liq) || E.liq, vto = leerFecha(P.vto), cupon = dec(P.cupon), precio = dec(P.precio) || 100;
  const com = (dec(P.com) ?? 0) / 100, meses = +P.meses || 6, cuotas = +P.cuotas || 1;
  if (!vto || cupon == null || vto <= liq) return `<p class="nota">Completa vencimiento (dd/mm/aaaa, posterior a la liquidación) y cupón o tasa de corte para calcular.</p>`;
  const flujos = c => flujosPrimaria({ liq, vencimiento: vto, cupon: c, meses, cuotas });
  const fl = flujos(cupon / 100);
  const yBruta = tir(fl, precio), yNeta = tir(fl, precio * (1 + com));
  if (yNeta == null) return `<p class="nota aviso">No pude calcular la TIR de la emisión con esas condiciones.</p>`;
  const dmP = duration(fl, yNeta).modificada;

  // comparables: ONs del emisor (calculables) y los tickers extra, a la punta vendedora de la línea D más la comisión
  const todos = [...E.ons, ...E.soberanos].filter(b => b.calculable);
  const extras = P.extras.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  const comps = todos.filter(b => (P.emisor && b.emisor === P.emisor && (!P.mismaLey || b.ley === P.ley)) || extras.includes(b.tk))
    .map(b => { const v = enVivo(b, "D"); const y = v?.ask ? tir(v.flujos, v.ask * (1 + com)) : null;
      return { b, v, y, dm: y != null ? duration(v.flujos, y).modificada : null }; })
    .sort((a, b) => (a.dm ?? 99) - (b.dm ?? 99));
  // la curva de referencia usa los que cobran en la misma moneda que la emisión, si los hay (canje cero distorsiona la línea D)
  const conPunta = comps.filter(c => c.y != null), misma = conPunta.filter(c => c.b.cobra === P.cobra);
  const curva = misma.length ? misma : conPunta;
  const faltan = extras.filter(t => !todos.some(b => b.tk === t));

  // lineal en DM entre los dos vecinos; fuera de la curva, la recta de los dos más cercanos de ese lado (o plano si hay uno)
  let yRef = null, base = "", fuera = false, usados = [];
  if (curva.length) {
    const antes = curva.filter(c => c.dm <= dmP), despues = curva.filter(c => c.dm > dmP);
    usados = antes.length && despues.length ? [antes.at(-1), despues[0]] : antes.length ? antes.slice(-2) : despues.slice(0, 2);
    fuera = !(antes.length && despues.length);
    const [a, b] = usados;
    yRef = b && b.dm !== a.dm ? a.y + (dmP - a.dm) / (b.dm - a.dm) * (b.y - a.y) : a.y;
    base = (fuera ? (b ? "extrapolado de " : "plano desde ") : "entre ") + usados.map(c => c.b.tk).join(" y ");
  }
  const ref = new Set(usados.map(c => c.b.tk));

  let veredicto, orden = "";
  if (yRef == null) veredicto = `La emisión rinde <b>${pct(yNeta)}</b> neto de comisión (DM ${num(dmP)}). Sin comparables con punta: elige el emisor o agrega tickers.`;
  else {
    const dif = (yNeta - yRef) * 1e4, gana = dif >= 0;
    veredicto = `La primaria rinde <b>${pct(yNeta)}</b> neto; el secundario a la misma duration (${num(dmP)}) rinde <b>${pct(yRef)}</b> neto (${esc(base)}):
      la primaria <b class="${gana ? "pos" : "neg"}">${gana ? "paga" : "pierde"} ${num(Math.abs(dif), 0)} pb</b> ${gana ? "más" : "contra el secundario"}.`;
    const cMin = resolver(c => tir(flujos(c), precio * (1 + com)) - yRef, 0, 1);
    const pMax = vp(fl, yRef) / (1 + com);
    orden = `<p class="nota">Para empatar el secundario: tasa de corte mínima <b>${pct(cMin)}</b> a precio ${num(precio)}, o precio máximo <b>${num(pMax)}</b> con cupón ${pct(cupon / 100)}.${gana ? "" : " La orden sale con ese límite, no sin precio."}</p>`;
  }

  const avisos = [];
  if (fuera) avisos.push(`La emisión cae fuera de la curva del emisor (DM ${num(curva[0].dm)} a ${num(curva.at(-1).dm)}): la referencia está extrapolada, tómala con cuidado.`);
  if (misma.length && misma.length < conPunta.length) avisos.push(`La referencia usa solo los que cobran ${P.cobra}; los demás quedan a la vista sin entrar en la curva.`);
  if (P.cobra === "CCL" || curva.some(c => c.b.cobra === "CCL")) avisos.push("Los que cobran cable se miden en la línea D con canje cero al cobro.");
  if (curva.some(c => c.v.ancho > 0.01)) avisos.push(`Puntas de más de 1% en ${curva.filter(c => c.v.ancho > 0.01).map(c => c.b.tk).join(", ")}: su TIR no es ejecutable sin orden límite.`);
  if (faltan.length) avisos.push(`Sin flujos de tasa fija en la base: ${faltan.join(", ")}.`);
  if (P.emisor && P.mismaLey && !comps.some(c => c.b.emisor === P.emisor) && E.ons.some(b => b.emisor === P.emisor))
    avisos.push(`${P.emisor} no tiene ONs ley ${P.ley} con flujos: destilda «solo la misma ley» o agrega comparables.`);

  const filas = comps.map(c => `<tr><td><span class="tk">${esc(c.b.tk)}</span>${ref.has(c.b.tk) ? ' <span class="etq">ref.</span>' : ""}</td><td>${c.b.ley}</td><td>${c.b.cobra}</td>
    <td>${fecha(c.b.vencimiento)}</td><td class="n">${conCant(c.v?.ask, c.v?.qAsk)}</td><td class="n">${pct(c.y)}</td><td class="n">${num(c.dm)}</td>
    <td class="n ${c.v?.ancho > 0.01 ? "aviso" : ""}">${pct(c.v?.ancho)}</td></tr>`).join("");
  return `
    <div class="tarjeta">
      <div class="datos">
        ${dato("TIR bruta", pct(yBruta))}${dato("TIR neta", pct(yNeta))}${dato("DM", num(dmP))}
        ${yRef != null ? dato("Secundario neto", pct(yRef)) + dato("Diferencia", pb((yNeta - yRef) * 1e4) + " pb") : ""}
      </div>
      <div class="veredicto">${veredicto}</div>
      ${orden}
      ${comps.length ? `<div class="tabla-caja"><table><thead><tr><th>Comparable</th><th>Ley</th><th>Cobra</th><th>Vto.</th><th class="n">Compra D</th><th class="n">TIR neta</th><th class="n">DM</th><th class="n">Puntas</th></tr></thead><tbody>${filas}</tbody></table></div>` : ""}
      <p class="nota">Emisión: liquida ${fecha(liq)}, ${fl.length} pagos, renta sobre valor residual (período corto final a días/365; confirmar la convención en el prospecto). Secundario: liquida ${fecha(E.liq)}, a la punta vendedora más ${pct(com)}.</p>
      ${avisos.map(a => `<p class="nota aviso">${esc(a)}</p>`).join("")}
      <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>
    </div>`;
}

// ---------- pase ----------
E.pase = { vendo: "", compro: "", linea: "D", pv: "", pc: "", cv: "0.5", cc: "0.5", reinv: "", vn: "10000", colchon: "50", rtipo: "", rcobra: "", rancho: "2", ...guardado.leer("pase", {}) };
function pPase() {
  const P = E.pase;
  const universo = [...E.ons, ...E.soberanos].filter(b => b.calculable);
  const porTk = new Map(universo.map(b => [b.tk, b]));
  const A = porTk.get(P.vendo.toUpperCase()), B = porTk.get(P.compro.toUpperCase());
  const vA = A && enVivo(A, P.linea), vB = B && enVivo(B, P.linea);
  const el = $("#p-pase");
  el.innerHTML = `
    <datalist id="dl-bonos">${universo.map(b => `<option value="${esc(b.tk)}">${esc(b.emisor)}</option>`).join("")}</datalist>
    <div class="form-pase">
      <div class="tarjeta"><h4>Vendo</h4>
        <label class="campo">Ticker<input name="vendo" list="dl-bonos" autocapitalize="characters" value="${esc(P.vendo)}" placeholder="p. ej. YM34O"></label>
        <label class="campo">Precio (punta compradora${vA?.bid ? ": " + num(vA.bid) : ""})<input name="pv" inputmode="decimal" value="${esc(P.pv)}" placeholder="${vA?.bid ?? ""}"></label>
        <label class="campo">VN que vendo${A ? ` (${textoRegla(reglaDe(A))})` : ""}<input name="vn" inputmode="decimal" value="${esc(P.vn)}"></label>
        <div class="suave">${A ? esc(A.emisor) + " · vence " + fecha(A.vencimiento) + " · cobra " + A.cobra : ""}</div>
      </div>
      <div class="tarjeta"><h4>Compro</h4>
        <label class="campo">Ticker<input name="compro" list="dl-bonos" autocapitalize="characters" value="${esc(P.compro)}" placeholder="p. ej. TLCPO"></label>
        <label class="campo">Precio (punta vendedora${vB?.ask ? ": " + num(vB.ask) : ""})<input name="pc" inputmode="decimal" value="${esc(P.pc)}" placeholder="${vB?.ask ?? ""}"></label>
        <div class="suave">${B ? esc(B.emisor) + " · vence " + fecha(B.vencimiento) + " · cobra " + B.cobra : ""}</div>
        ${B ? `<div class="fila"><label class="campo">Lámina mínima (${esc(reglaDe(B).fuente)})<input name="lamB" inputmode="decimal" value="${reglaDe(B).sinDato ? "" : reglaDe(B).min}"></label>
          <label class="campo">Incremento (${esc(reglaDe(B).sinDato ? "sin dato" : reglaDe(B).incFuente)})<input name="incB" inputmode="decimal" value="${reglaDe(B).sinDato ? "" : reglaDe(B).inc}"></label></div>` : ""}
      </div>
      <div class="tarjeta"><h4>Supuestos</h4>
        <label class="campo">Línea<select name="linea"><option value="D">D (MEP)</option><option value="C">C (cable)</option></select></label>
        <div class="fila"><label class="campo">Comisión venta %<input name="cv" inputmode="decimal" value="${esc(P.cv)}"></label>
          <label class="campo">Comisión compra %<input name="cc" inputmode="decimal" value="${esc(P.cc)}"></label></div>
        <label class="campo">Reinversión de cupones % (vacío = TIR de venta)<input name="reinv" inputmode="decimal" value="${esc(P.reinv)}"></label>
      </div>
    </div>
    <div id="res-pase"></div>
    <div id="rot-pase"></div>
    <h3 class="sub">Pase de monedas</h3>
    <div id="pase-mon"></div>`;
  el.querySelector("[name=linea]").value = P.linea;
  el.querySelectorAll(".form-pase [name]").forEach(c => c.addEventListener("change", () => {
    if (c.name === "lamB" || c.name === "incB") guardarRegla(B, el.querySelector("[name=lamB]").value.trim(), el.querySelector("[name=incB]").value.trim());
    else P[c.name] = c.value.trim();
    if (c.name === "vendo") P.pv = ""; if (c.name === "compro") P.pc = "";
    guardado.escribir("pase", { vendo: P.vendo, compro: P.compro, linea: P.linea, cv: P.cv, cc: P.cc, reinv: P.reinv, vn: P.vn, colchon: P.colchon, rtipo: P.rtipo, rcobra: P.rcobra, rancho: P.rancho });
    pPase();
  }));
  $("#res-pase").innerHTML = resultadoPase(A, B, vA, vB);
  rotaciones(A, vA, universo);
  paseMonedas();
}

const dec = s => s === "" || s == null ? null : +String(s).replace(",", ".");
function resultadoPase(A, B, vA, vB) {
  const P = E.pase;
  if (!A || !B) return `<p class="nota">Elige el bono que vendes y el que compras (ONs y bonos en dólares con flujos de tasa fija). Toca una fila de Bonos para mandarla acá.</p>`;
  const pA = dec(P.pv) ?? vA?.bid, pB = dec(P.pc) ?? vB?.ask;
  if (!pA || !pB) return `<p class="nota aviso">Falta precio: ${!pA ? A.tk + " sin punta compradora" : ""} ${!pB ? B.tk + " sin punta vendedora" : ""} en la línea ${P.linea}. Escríbelo a mano o actualiza las puntas.</p>`;
  const fA = flujosHoy(A), fB = flujosHoy(B);
  const yA = tir(fA, pA), yB = tir(fB, pB);
  if (yA == null || yB == null) return `<p class="nota aviso">No pude calcular la TIR con esos precios.</p>`;
  const reinv = dec(P.reinv) != null ? dec(P.reinv) / 100 : yA;
  const r = pase({ fA, pA, fB, pB, comVenta: (dec(P.cv) ?? 0) / 100, comCompra: (dec(P.cc) ?? 0) / 100, reinv });
  const dA = duration(fA, yA), dB = duration(fB, yB);
  const vtoA = mas(E.liq, r.T);
  const rapida = (yB - yA) * (r.T / 365) - ((dec(P.cv) ?? 0) + (dec(P.cc) ?? 0)) / 100;
  const avisos = [];
  if (P.linea === "D" && (A.cobra === "CCL" || B.cobra === "CCL")) { const c = [A, B].filter(b => b.cobra === "CCL").map(b => b.tk); avisos.push(`${c.join(" y ")} ${c.length > 1 ? "cobran" : "cobra"} cable: en la línea D su TIR supone canje cero al cobro.`); }
  if (A.cobra !== B.cobra) avisos.push(`Cambia la moneda de cobro (${A.cobra} → ${B.cobra}): el canje entra en la cuenta.`);
  [[A, vA], [B, vB]].forEach(([b, v]) => v?.ancho > 0.01 && avisos.push(`${b.tk}: puntas de ${pct(v.ancho)}, hace falta orden límite.`));
  const bueno = r.bVenceAntes ? r.mejora > 0 : r.ensanchePb > 0;
  const nom = nominalesPase(A, B, fA, fB, pA, pB, r, reinv, avisos);
  return `
    <div class="tarjeta">
      <div class="datos">
        ${dato(`TIR venta ${esc(A.tk)}`, pct(yA))}${dato(`TIR compra ${esc(B.tk)}`, pct(yB))}${dato("Diferencia", pb((yB - yA) * 1e4) + " pb")}
        ${dato(`DM ${esc(A.tk)}`, num(dA.modificada))}${dato(`DM ${esc(B.tk)}`, num(dB.modificada))}${dato(`VN de ${esc(B.tk)} por 100 de ${esc(A.tk)}`, num(100 * r.nB))}
      </div>
      <div class="veredicto">
        ${r.bVenceAntes
          ? `${esc(B.tk)} vence antes que ${esc(A.tk)}: reinvirtiendo todo al ${pct(reinv)} hasta el ${fecha(vtoA)}, el pase <b class="${r.mejora > 0 ? "pos" : "neg"}">${r.mejora > 0 ? "suma" : "resta"} ${pct(Math.abs(r.mejora))}</b> neto de comisiones.
             ${r.reinvQuiebre != null ? `Tasa de reinversión que iguala las dos opciones: <b>${pct(r.reinvQuiebre)}</b>.` : ""}`
          : `Al vencimiento de ${esc(A.tk)} (${fecha(vtoA)}), si ${esc(B.tk)} mantiene su TIR el pase <b class="${r.mejora > 0 ? "pos" : "neg"}">${r.mejora > 0 ? "suma" : "resta"} ${pct(Math.abs(r.mejora))}</b> neto de comisiones.
             ${r.tirQuiebre == null ? (r.mejora > 0 ? `<b class="pos">Aguanta cualquier ensanchamiento</b>: casi todo el flujo de ${esc(B.tk)} cae antes de esa fecha.` : "")
               : `TIR de quiebre de ${esc(B.tk)} ese día: <b>${pct(r.tirQuiebre)}</b> → <b class="${bueno ? "pos" : "neg"}">${bueno ? "aguanta" : "ya pierde con"} ${pb(Math.abs(r.ensanchePb))} pb ${bueno ? "de ensanchamiento" : "de compresión necesaria"}</b>.`}`}
      </div>
      ${nom}
      <p class="nota">Flujos exactos de los dos bonos, cupones reinvertidos al ${pct(reinv)}. Regla rápida: (TIR compra − TIR venta) × vida de ${esc(A.tk)} (${num(r.T / 365, 1)} años) − comisiones = ${pct(rapida)}.</p>
      ${avisos.map(a => `<p class="nota aviso">${esc(a)}</p>`).join("")}
      <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>
    </div>`;
}

// Calificación: la columna de chamomberg mezcla escalas; se pasa a la escala S&P y se separa en internacional (BB+ o peor:
// ningún corporativo argentino califica más arriba afuera) y local (lo de arriba, o con «(arg)»/«.ar»). Si el bono no trae
// la internacional, hereda la peor del emisor. La internacional ordena; la local solo desempata.
const ESCALA = ["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "BB-", "B+", "B", "B-", "CCC+", "CCC", "CCC-", "CC", "C", "D"];
const MOODYS = { Aaa: "AAA", Aa1: "AA+", Aa2: "AA", Aa3: "AA-", A1: "A+", A2: "A", A3: "A-", Baa1: "BBB+", Baa2: "BBB", Baa3: "BBB-", Ba1: "BB+", Ba2: "BB", Ba3: "BB-", B1: "B+", B2: "B", B3: "B-", Caa1: "CCC+", Caa2: "CCC", Caa3: "CCC-", Ca: "CC" };
function leerCalif(txt) {
  const out = { int: null, loc: null };
  for (let t of String(txt || "").split("/")) {
    t = t.trim(); const local = /\(arg\)|\.ar$/i.test(t); t = t.replace(/\(arg\)|\.ar$/i, "").trim();
    const sp = MOODYS[t] || t.toUpperCase(), i = ESCALA.indexOf(sp);
    if (i < 0) continue;
    const k = !local && i >= ESCALA.indexOf("BB+") ? "int" : "loc";
    if (out[k] == null || i > out[k]) out[k] = i;
  }
  return out;
}
let califEmisor = null;
function calif(b) {
  if (!califEmisor) {
    califEmisor = new Map();
    for (const o of E.ons) {
      const c = leerCalif(o.calificacion), e = califEmisor.get(o.emisor) || { int: null, loc: null };
      for (const k of ["int", "loc"]) if (c[k] != null && (e[k] == null || c[k] > e[k])) e[k] = c[k];
      califEmisor.set(o.emisor, e);
    }
  }
  const c = leerCalif(b.calificacion), e = califEmisor.get(b.emisor) || {};
  return { int: c.int ?? e.int ?? null, loc: c.loc ?? e.loc ?? null, heredada: c.int == null && e.int != null };
}
const nCalif = c => (c.int ?? 99) * 100 + (c.loc ?? 99);
const grupoCalif = c => c.int != null ? `Internacional ${ESCALA[c.int]}` : c.loc != null ? `Sin internacional · local ${ESCALA[c.loc]}` : "Sin calificación cargada";

// Rotaciones: el bono que vendo contra todos los que tienen punta vendedora en la línea, con el mismo cálculo del pase
// (flujos exactos, comisiones, reinversión). Excelente = suma, aguanta el colchón y no alarga la duration modificada;
// buena = suma y aguanta el colchón, pero alarga; fina = suma pero con poco margen.
function rotaciones(A, vA, universo) {
  const P = E.pase, cont = $("#rot-pase");
  const cierre = !E.vivo.size;
  const pA = A && (dec(P.pv) ?? vA?.bid ?? (cierre ? deCierre(A, P.linea)?.bid : null));
  if (!A || !pA) { cont.innerHTML = ""; return; }
  const fA = flujosHoy(A), yA = tir(fA, pA);
  if (yA == null) { cont.innerHTML = ""; return; }
  const dmA = duration(fA, yA).modificada;
  const cv = (dec(P.cv) ?? 0) / 100, cc = (dec(P.cc) ?? 0) / 100, reinv = dec(P.reinv) != null ? dec(P.reinv) / 100 : yA;
  const umbral = dec(P.colchon) ?? 0, anchoMax = (dec(P.rancho) ?? 100) / 100;
  const filas = [];
  let raras = 0;
  for (const B of universo) {
    if (B.tk === A.tk || (P.rtipo && B.tipo !== P.rtipo) || (P.rcobra && B.cobra !== P.rcobra)) continue;
    const v = cierre ? deCierre(B, P.linea) : enVivo(B, P.linea);
    if (!v?.ask || v.tAsk == null) continue;
    // puntas sin compradora, muy abiertas o TIR absurda: precio que no sirve para rotar
    if (!v.bid || v.ancho > anchoMax || v.tAsk > 0.3 || v.tAsk < 0) { raras++; continue; }
    const r = pase({ fA, pA, fB: v.flujos, pB: v.ask, comVenta: cv, comCompra: cc, reinv });
    // colchón: pb que puede ensancharse B (o bajar la reinversión, si B vence antes) antes de que el pase pierda
    // sin quiebre y sumando: gana con cualquier ensanche (casi todo el flujo cae antes del vencimiento del vendido)
    let colchon = r.bVenceAntes ? (r.reinvQuiebre != null ? (reinv - r.reinvQuiebre) * 1e4 : null) : r.ensanchePb ?? null;
    if (colchon == null && r.mejora > 0) colchon = Infinity;
    const dMd = v.dm != null ? v.dm - dmA : null;
    filas.push({ B, v, r, colchon, dMd, dif: (v.tAsk - yA) * 1e4, c: calif(B) });
  }
  // cuánto paga el mercado por cada año de MD: pendiente TIR~MD de los mismos candidatos, dentro de cada calificación
  // internacional (con 6 o más bonos) o la conjunta dentro de cada calificación. Alargar solo «paga» si la diferencia supera lo que da la curva.
  const pendiente = xs => {
    const ok = xs.filter(f => f.v.dm != null);
    if (ok.length < 6) return null;
    const mx = ok.reduce((s, f) => s + f.v.dm, 0) / ok.length, my = ok.reduce((s, f) => s + f.v.tAsk, 0) / ok.length;
    const sxx = ok.reduce((s, f) => s + (f.v.dm - mx) ** 2, 0);
    return sxx > 0 ? ok.reduce((s, f) => s + (f.v.dm - mx) * (f.v.tAsk - my), 0) / sxx * 1e4 : null;
  };
  // respaldo para escalones con menos de 6 bonos: pendiente conjunta DENTRO de cada calificación (efectos fijos), que no
  // confunde crédito con plazo como la pendiente de todo el universo junto
  const dentro = (() => {
    const ok = filas.filter(f => f.v.dm != null), m = new Map();
    for (const f of ok) { const g = f.c.int ?? "x", a = m.get(g) || { n: 0, x: 0, y: 0 }; a.n++; a.x += f.v.dm; a.y += f.v.tAsk; m.set(g, a); }
    let sxx = 0, sxy = 0;
    for (const f of ok) { const a = m.get(f.c.int ?? "x"), dx = f.v.dm - a.x / a.n; sxx += dx * dx; sxy += dx * (f.v.tAsk - a.y / a.n); }
    return sxx > 0 ? sxy / sxx * 1e4 : 0;
  })();
  const pGlobal = dentro, porGrupo = new Map();
  for (const f of filas) { const g = f.c.int ?? "x"; porGrupo.has(g) || porGrupo.set(g, pendiente(filas.filter(h => (h.c.int ?? "x") === g)) ?? pGlobal); }
  for (const f of filas) {
    f.pend = porGrupo.get(f.c.int ?? "x");
    f.exceso = f.dMd == null ? null : f.dif - Math.max(0, f.pend) * Math.max(0, f.dMd);
    f.ver = !(f.r.mejora > 0) ? "pierde" : !(f.colchon != null && f.colchon >= umbral) ? "fina"
      : f.dMd != null && f.dMd <= 0 ? "excelente" : f.exceso != null && f.exceso <= 0 ? "fina" : "buena";
  }
  const n = { excelente: 0, buena: 0, fina: 0, pierde: 0 }; filas.forEach(f => n[f.ver]++);
  // sin orden elegido: por calificación (internacional, después local) y, dentro de cada escalón, por lo que suma
  const vista = filas.filter(f => P.rver === "todas" || f.ver !== "pierde").sort((a, b) => nCalif(a.c) - nCalif(b.c) || b.r.mejora - a.r.mejora);
  const ETQ = { excelente: '<span class="pos tk">Excelente</span>', buena: '<span class="pos">Buena</span>', fina: '<span class="aviso tk">Fina</span>', pierde: '<span class="neg">Pierde</span>' };
  const cols = [
    { k: "tk", t: "Compro", f: x => `<span class="tk">${esc(x.B.tk)}</span>`, v: x => x.B.tk },
    { k: "ver", t: "Rotación", f: x => ETQ[x.ver], v: x => ({ excelente: 3, buena: 2, fina: 1, pierde: 0 })[x.ver] },
    { k: "emisor", t: "Emisor", cls: "emisor ocultar-movil", f: x => esc(x.B.emisor), v: x => x.B.emisor },
    { k: "calif", t: "Calif.", f: x => (x.c.int != null ? `<b>${ESCALA[x.c.int]}</b>${x.c.heredada ? ' <small class="cant">emisor</small>' : ""}` : "—") + (x.c.loc != null ? ` <small class="cant">${ESCALA[x.c.loc]} local</small>` : ""), v: x => -nCalif(x.c), titulo: "Internacional en negrita (manda); local al lado. «emisor»: el bono no la trae y hereda la peor del emisor" },
    { k: "vto", t: "Vence", f: x => fecha(x.B.vencimiento), v: x => x.B.vencimiento },
    { k: "cobra", t: "Cobra", cls: "ocultar-movil", f: x => esc(x.B.cobra), v: x => x.B.cobra },
    { k: "tir", t: "TIR", n: 1, f: x => pct(x.v.tAsk), v: x => x.v.tAsk },
    { k: "dif", t: "Dif.", n: 1, f: x => pb(x.dif) + " pb", v: x => x.dif, titulo: `TIR de compra − TIR de venta de ${A.tk}` },
    { k: "dmd", t: "Δ MD", n: 1, f: x => x.dMd == null ? "—" : `<span class="${x.dMd <= 0 ? "pos" : x.exceso <= 0 ? "aviso" : ""}">${x.dMd > 0 ? "+" : ""}${num(x.dMd, 2)}</span>`, v: x => x.dMd, titulo: `Duration modificada del comprado − la de ${A.tk} (${num(dmA, 2)}): negativo recorta, positivo alarga` },
    { k: "exceso", t: "vs curva", n: 1, f: x => x.exceso == null ? "—" : x.dMd <= 0 ? `<span class="suave">recorta</span>` : `<span class="${x.exceso > 0 ? "pos" : "aviso"}">${pb(x.exceso)} pb</span>`, v: x => x.dMd <= 0 ? Infinity : x.exceso, titulo: "Dif. de TIR menos lo que la curva de su misma calificación paga por la MD que se agrega (pendiente TIR~MD × Δ MD). Positivo: el alargue está bien pagado" },
    { k: "mejora", t: "Suma neto", n: 1, f: x => `<span class="${x.r.mejora > 0 ? "pos" : "neg"}">${pct(x.r.mejora)}</span>`, v: x => x.r.mejora, titulo: `Al vencimiento de ${A.tk}, neto de comisiones, si el bono comprado mantiene su TIR` },
    { k: "colchon", t: "Colchón", n: 1, f: x => x.colchon == null ? "—" : x.colchon > 2000 ? "sin quiebre" : `${pb(x.colchon)} pb${x.r.bVenceAntes ? ' <small class="cant">reinv.</small>' : ""}`, v: x => x.colchon, titulo: "Cuánto puede ensancharse el bono comprado (o bajar la reinversión, si vence antes) sin que el pase pierda" },
    { k: "ancho", t: "Puntas", n: 1, cls: "ocultar-movil", f: x => x.v.ancho == null ? "—" : `<span class="${x.v.ancho > 0.01 ? "aviso" : ""}">${pct(x.v.ancho)}</span>`, v: x => x.v.ancho },
  ];
  const tipos = [...new Set(universo.map(b => b.tipo))], cobras = [...new Set(universo.map(b => b.cobra))].filter(Boolean);
  const op = (vals, sel, nom) => `<option value="">Todos</option>` + vals.map(t => `<option value="${esc(t)}"${t === sel ? " selected" : ""}>${esc(nom(t))}</option>`).join("");
  cont.innerHTML = `<h3 class="sub">Rotaciones para ${esc(A.tk)}</h3>
    <div class="filtros">
      <label class="campo">Colchón para «buena» (pb)<input name="colchon" inputmode="decimal" value="${esc(P.colchon)}"></label>
      <label class="campo">Puntas máx. %<input name="rancho" inputmode="decimal" value="${esc(P.rancho)}"></label>
      <label class="campo">Tipo<select name="rtipo">${op(tipos, P.rtipo, t => ({ on: "ONs", sob: "Soberanos" })[t] || t)}</select></label>
      <label class="campo">Cobra en<select name="rcobra">${op(cobras, P.rcobra, t => t)}</select></label>
      <label class="chip"><input type="checkbox" name="rver"${P.rver === "todas" ? " checked" : ""}> Ver también las que pierden</label>
    </div>
    ${cierre ? `<p class="nota aviso">Sin puntas en vivo: se usan los precios del cierre del ${fecha(E.meta?.cierre ?? "")} (solo bonos que cerraron en ${P.linea === "C" ? "cable" : "MEP"}), como referencia. Antes de operar, actualiza las puntas.</p>` : ""}<p class="nota">Vendo ${esc(A.tk)} a ${num(pA)} (TIR ${pct(yA)}, MD ${num(dmA, 2)}) en la línea ${esc(P.linea)} · comisiones ${pct(cv)} venta + ${pct(cc)} compra · cupones al ${pct(reinv)} · <span class="pos">${n.excelente} excelentes, ${n.buena} buenas</span>, <span class="aviso">${n.fina} finas</span>, ${n.pierde} pierden${raras ? ` · ${raras} sin compradora, con puntas de más del ${pct(anchoMax, 1)} o TIR de más de 30%, afuera` : ""}. Agrupadas por calificación internacional (la local solo desempata); toca un encabezado para otro orden y una fila para verla arriba con los nominales.</p>`;
  cont.append(tabla("rot", vista, cols, { grupo: x => grupoCalif(x.c), alClick: x => { P.compro = x.B.tk; P.pc = ""; guardado.escribir("pase", { ...guardado.leer("pase", {}), compro: P.compro }); pPase(); scrollTo({ top: 0, behavior: "smooth" }); } }));
  cont.insertAdjacentHTML("beforeend", `<p class="nota">Excelente: suma neto de comisiones, aguanta al menos ${num(umbral, 0)} pb en contra y recorta (o iguala) la duration modificada: más tasa con menos riesgo de tasa. Buena: lo mismo, pero alargando la MD y cobrando por ese alargue más de lo que paga la curva de su calificación («vs curva» positivo). Fina: suma, pero con menos colchón o con un alargue que la curva paga mejor. «Sin quiebre»: gana aunque el bono comprado se ensanche cualquier cosa, porque casi todo su flujo cae antes. La diferencia de TIR también es diferencia de crédito: pasar a otro emisor cambia el riesgo. Con monedas de cobro distintas, el canje entra aparte. Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>`);
  cont.querySelectorAll(".filtros [name]").forEach(c => c.addEventListener("change", () => {
    P[c.name] = c.type === "checkbox" ? (c.checked ? "todas" : "") : c.value.trim();
    guardado.escribir("pase", { ...guardado.leer("pase", {}), colchon: P.colchon, rtipo: P.rtipo, rcobra: P.rcobra, rancho: P.rancho });
    rotaciones(A, vA, universo);
  }));
}

// Pase con nominales reales: lo que entra al vender A, el VN de B redondeado a su regla de negociación, lo que sobra en caja
// y los dos cashflows lado a lado, fecha por fecha de cobro.
// semáforo del pase: verde si conviene, rojo si no, amarillo si da casi igual: la diferencia no paga ni la comisión de una punta
// (lo que costaría deshacer el pase), con piso de 0,25% del monto o 1 dólar
const semaforo = (x, base) => {
  const com = Math.max((dec(E.pase?.cv) ?? 0) / 100, (dec(E.pase?.cc) ?? 0) / 100, 0.0025);
  return Math.abs(x) <= Math.max(1, Math.abs(base) * com) ? "aviso" : x > 0 ? "pos" : "neg";
};
const VEREDICTO = { pos: "conviene", neg: "no conviene", aviso: "da casi igual" };
function nominalesPase(A, B, fA, fB, pA, pB, r, reinv, avisos) {
  const P = E.pase, vnA = dec(String(P.vn).replace(/\./g, "")), LA = reglaDe(A), LB = reglaDe(B);
  if (!(vnA > 0)) return `<p class="nota">Escribe el VN que vendes para ver los nominales y los cashflows.</p>`;
  const cv = (dec(P.cv) ?? 0) / 100, cc = (dec(P.cc) ?? 0) / 100;
  const neto = vnA * pA / 100 * (1 - cv);
  const vnB = redondearVN(neto / (pB / 100 * (1 + cc)), LB), costo = vnB * pB / 100 * (1 + cc), sobra = neto - costo;
  if (!vnValido(vnA, LA)) avisos.push(`${num(vnA, 0)} VN de ${A.tk} no respeta su regla (${textoRegla(LA)}): solo vale si es toda la tenencia.`);
  if (LB.sinDato) avisos.push(`${B.tk} sin lámina en la base: calculado de a 1 VN; confírmala antes de cargar la orden.`);
  else avisos.push(...avisosRegla(B, LB));
  if (!vnB) return `<p class="nota aviso">Con ${num(neto)} netos no alcanza para la lámina mínima de ${B.tk} (${num(LB.min, 0)} VN, unos ${num(LB.min * pB / 100 * (1 + cc))}).</p>`;
  // al vencimiento de A: quedarse con A contra B + la caja que sobra, todo reinvertido a la misma tasa (B valuado a su TIR de hoy si sigue vivo)
  const restoB = fB.filter(f => f[0] > r.T).map(([d, c, x, a]) => [d - r.T, c, x, a]);
  const quedarse = vnA / 100 * valorAl(fA, r.T, reinv);
  const pasar = vnB / 100 * (valorAl(fB, r.T, reinv) + (restoB.length ? vp(restoB, r.yB) : 0)) + sobra * (1 + reinv) ** (r.T / 365);
  // cashflows por fecha de cobro (día hábil)
  const filas = new Map(), sumar = (fl, vn, lado) => fl.forEach(f => {
    const d = habilDesde(mas(E.liq, f[0])), x = filas.get(d) || { d, a: 0, b: 0 };
    x[lado] += vn / 100 * (f[1] + f[2] + (f[3] || 0)); filas.set(d, x);
  });
  sumar(fA, vnA, "a"); sumar(fB, vnB, "b");
  const vtoA = habilDesde(mas(E.liq, r.T));
  let acA = 0, acB = sobra;
  const tb = [...filas.values()].sort((x, y) => x.d < y.d ? -1 : 1).map(x => {
    acA += x.a; acB += x.b;
    const desp = x.d > vtoA;
    return `<tr class="${desp ? "suave" : ""}"><td>${fecha(x.d)}</td><td class="n">${x.a ? num(x.a) : "—"}</td><td class="n">${x.b ? num(x.b) : "—"}</td>
      <td class="n ${desp ? "" : semaforo(x.b - x.a, Math.max(x.a, x.b))}">${num(x.b - x.a)}</td><td class="n">${num(acA)}</td><td class="n ${desp ? "" : semaforo(acB - acA, acA)}">${num(acB)}</td></tr>`;
  }).join("");
  const hastaA = (fl, vn) => vn / 100 * fl.filter(f => f[0] <= r.T).reduce((s, f) => s + f[1] + f[2] + (f[3] || 0), 0);
  const dif = pasar - quedarse, sem = semaforo(dif, quedarse);
  const difCaja = hastaA(fB, vnB) + sobra - hastaA(fA, vnA);
  // si B sigue vivo después del vencimiento de A, la caja cobrada hasta ahí no compara: a B le falta el capital
  const semCaja = restoB.length ? "" : semaforo(difCaja, hastaA(fA, vnA)), valeB = restoB.length ? vnB / 100 * vp(restoB, r.yB) : 0;
  return `
      <div class="datos">
        ${dato(`Vendo ${esc(A.tk)}`, num(vnA, 0) + " VN")}${dato("Neto de la venta", num(neto))}
        ${dato(`Compro ${esc(B.tk)}`, num(vnB, 0) + " VN")}${dato("Costo con comisión", num(costo))}${dato("Sobra en caja", num(sobra))}
        ${dato(`Al ${fecha(vtoA)}`, `<span class="${sem}">${dif > 0 ? "+" : "−"}${num(Math.abs(dif))}</span>`)}
      </div>
      <p class="veredicto"><b class="${sem}">El pase ${VEREDICTO[sem]}</b> al ${fecha(vtoA)}: ${dif > 0 ? "+" : "−"}${num(Math.abs(dif))} contra quedarse con ${esc(A.tk)}, con cupones y caja reinvertidos${restoB.length ? ` y ${esc(B.tk)} valuado a su TIR de hoy` : ""}. ${restoB.length ? `En caja cobrada hasta esa fecha ${esc(B.tk)} da ${difCaja > 0 ? "+" : "−"}${num(Math.abs(difCaja))}, pero no es pérdida: todavía le queda por cobrar ${num(valeB)} a su TIR de hoy.` : `Solo por caja cobrada hasta esa fecha, sin reinvertir: <b class="${semCaja}">${difCaja > 0 ? "+" : "−"}${num(Math.abs(difCaja))} (${VEREDICTO[semCaja]})</b>${semCaja !== sem ? "; la diferencia la hace la reinversión" : ""}.`}</p>
      <p class="nota">Reglas: ${esc(A.tk)} ${textoRegla(LA)} · ${esc(B.tk)} ${textoRegla(LB)} (mínimo: ${esc(LB.fuente)}; incremento: ${esc(LB.sinDato ? "sin dato" : LB.incFuente)}). Al ${fecha(vtoA)}: quedarse vale ${num(quedarse)}, pasar ${num(pasar)} (cupones y caja al ${pct(reinv)}${restoB.length ? `, ${esc(B.tk)} a su TIR de hoy` : ""}).</p>
      <details open><summary>Cashflows en dólares, fecha por fecha</summary>
      <div class="tabla-caja"><table><thead><tr><th>Cobro</th><th class="n">${esc(A.tk)}</th><th class="n">${esc(B.tk)}</th><th class="n">${esc(B.tk)} − ${esc(A.tk)}</th><th class="n">Acum. ${esc(A.tk)}</th><th class="n">Acum. ${esc(B.tk)} + caja</th></tr></thead>
      <tbody><tr><td>${fecha(E.liq)} (pase)</td><td class="n">—</td><td class="n">—</td><td class="n">${num(sobra)}</td><td class="n">—</td><td class="n">${num(sobra)}</td></tr>${tb}</tbody>
      <tfoot><tr><td><b>Hasta ${fecha(vtoA)}</b></td><td class="n"><b>${num(hastaA(fA, vnA))}</b></td><td class="n"><b>${num(hastaA(fB, vnB) + sobra)}</b></td><td class="n ${semCaja}"><b>${num(difCaja)}</b></td><td></td><td></td></tr></tfoot></table></div>
      <p class="nota">Sin descontar ni reinvertir; en gris, lo que ${esc(B.tk)} paga después del vencimiento de ${esc(A.tk)}. El total de ${esc(B.tk)} incluye la caja que sobra. Colores: <span class="pos">verde</span> ${esc(B.tk)} paga más (o vas adelante en el acumulado), <span class="neg">rojo</span> paga menos (o vas atrás), <span class="aviso">amarillo</span> casi igual (la diferencia no paga ni la comisión de una punta, con piso de 0,25% o 1 dólar). Que un cobro salga en rojo no hace malo el pase: manda el veredicto de arriba.</p></details>`;
}

// Pase de monedas con un bono de las tres líneas: compro en la moneda que tengo (punta vendedora + comisión)
// y vendo en la que quiero (punta compradora − comisión). 24 hs: puntas de data912/BYMA; CI: BYMA (20 min de demora).
const MON = { ARS: { lin: "", nombre: "Pesos", sim: "$" }, MEP: { lin: "D", nombre: "Dólar MEP", sim: "US$ MEP" }, CCL: { lin: "C", nombre: "Dólar cable", sim: "US$ CCL" } };
E.mon = { de: "ARS", a: "MEP", plazo: "24", bono: "AL30", monto: "1000000", cc: "0.5", cv: "0.5", pc: "", pv: "", ...guardado.leer("mon", {}) };
function paseMonedas() {
  const M = E.mon, cont = $("#pase-mon");
  const libro = M.plazo === "CI" ? E.vivoCI : E.vivo;
  const qC = libro.get(M.bono + MON[M.de].lin), qV = libro.get(M.bono + MON[M.a].lin);
  const opc = sel => Object.entries(MON).map(([k, m]) => `<option value="${k}"${k === sel ? " selected" : ""}>${m.nombre}</option>`).join("");
  cont.innerHTML = `
    <div class="form-pase">
      <div class="tarjeta"><h4>Tengo</h4>
        <label class="campo">Moneda<select name="de">${opc(M.de)}</select></label>
        <label class="campo">Monto en ${MON[M.de].sim}<input name="monto" inputmode="decimal" value="${esc(M.monto)}"></label>
        <label class="campo">Compro ${esc(M.bono + MON[M.de].lin)} a, c/100 VN (punta vendedora${qC?.px_ask > 0 ? ": " + num(qC.px_ask, M.de === "ARS" ? 2 : 3) : ""})<input name="pc" inputmode="decimal" value="${esc(M.pc)}" placeholder="${qC?.px_ask > 0 ? qC.px_ask : ""}"></label>
      </div>
      <div class="tarjeta"><h4>Quiero</h4>
        <label class="campo">Moneda<select name="a">${opc(M.a)}</select></label>
        <label class="campo">Vendo ${esc(M.bono + MON[M.a].lin)} a, c/100 VN (punta compradora${qV?.px_bid > 0 ? ": " + num(qV.px_bid, M.a === "ARS" ? 2 : 3) : ""})<input name="pv" inputmode="decimal" value="${esc(M.pv)}" placeholder="${qV?.px_bid > 0 ? qV.px_bid : ""}"></label>
        <label class="campo">Quiero recibir en ${MON[M.a].sim} (opcional: cuánto necesito)<input name="quiero" inputmode="decimal" value="${esc(M.quiero ?? "")}" placeholder="vacío = uso normal"></label>
      </div>
      <div class="tarjeta"><h4>Supuestos</h4>
        <div class="fila"><label class="campo">Bono<select name="bono">${["AL30", "GD30"].map(b => `<option${b === M.bono ? " selected" : ""}>${b}</option>`).join("")}</select></label>
          <label class="campo">Plazo<select name="plazo"><option value="CI"${M.plazo === "CI" ? " selected" : ""}>CI</option><option value="24"${M.plazo === "24" ? " selected" : ""}>24 hs</option></select></label></div>
        <div class="fila"><label class="campo">Comisión compra %<input name="cc" inputmode="decimal" value="${esc(M.cc)}"></label>
          <label class="campo">Comisión venta %<input name="cv" inputmode="decimal" value="${esc(M.cv)}"></label></div>
      </div>
    </div>
    <div class="tarjeta">${resultadoMonedas(qC, qV)}</div>`;
  cont.querySelectorAll("[name]").forEach(c => c.addEventListener("change", () => {
    M[c.name] = c.value.trim();
    if (["de", "bono", "plazo"].includes(c.name)) M.pc = "";
    if (["a", "bono", "plazo"].includes(c.name)) M.pv = "";
    guardado.escribir("mon", { de: M.de, a: M.a, plazo: M.plazo, bono: M.bono, monto: M.monto, cc: M.cc, cv: M.cv });
    paseMonedas();
  }));
}
function resultadoMonedas(qC, qV) {
  const M = E.mon, de = MON[M.de], a = MON[M.a], tkC = M.bono + de.lin, tkV = M.bono + a.lin;
  if (M.de === M.a) return `<p class="nota">Elige dos monedas distintas.</p>`;
  const pc = dec(M.pc) ?? (qC?.px_ask > 0 ? qC.px_ask : null), pv = dec(M.pv) ?? (qV?.px_bid > 0 ? qV.px_bid : null);
  const fuente = M.plazo === "CI" ? "BYMA, contado inmediato, 20 min de demora" : "24 hs, data912 o BYMA";
  if (!pc || !pv) return `<p class="nota aviso">Falta precio: ${!pc ? tkC + " sin punta vendedora" : ""} ${!pv ? tkV + " sin punta compradora" : ""} en ${M.plazo === "CI" ? "CI" : "24 hs"} (${fuente}). Actualiza las puntas o escríbelo a mano.</p>`;
  const monto = dec(String(M.monto).replace(/\./g, "")), cc = (dec(M.cc) ?? 0) / 100, cv = (dec(M.cv) ?? 0) / 100;
  // modo inverso: cuánto de lo que tengo necesito para recibir un monto neto, con comisiones y VN de a 1
  const quiero = dec(String(M.quiero ?? "").replace(/\./g, "")), inverso = quiero > 0;
  if (!inverso && !(monto > 0)) return `<p class="nota">Escribe el monto que tienes.</p>`;
  const vn = inverso ? Math.ceil(quiero / (pv / 100 * (1 - cv)) - 1e-9) : redondearVN(monto / (pc / 100 * (1 + cc)), { min: 1, inc: 1 });
  if (!inverso && !vn) return `<p class="nota aviso">Con ${de.sim} ${num(monto)} no alcanza para 1 VN de ${tkC} (${num(pc / 100 * (1 + cc), 3)}).</p>`;
  const costo = vn * pc / 100 * (1 + cc), sobra = monto - costo, recibo = vn * pv / 100 * (1 - cv), bruto = vn * pv / 100;
  const tasa = recibo / costo, tasaSin = pv / pc;
  // cotización legible: pesos por dólar si hay pesos de por medio; si no, el canje (dólares MEP por cada cable − 1)
  const ars = M.de === "ARS" || M.a === "ARS";
  const tc = t => M.de === "ARS" ? 1 / t : t;
  const cj = t => M.de === "MEP" ? 1 / t - 1 : t - 1;
  const en = (v, m, d = 2) => `${num(v, d)} <small class="cant">${m.sim}</small>`;
  const cot = ars ? dato(`$ por US$ ${M.a === "ARS" ? M.de : M.a}`, num(tc(tasa), 2)) + dato("Sin comisión", num(tc(tasaSin), 2))
    : dato("Canje", pct(cj(tasa))) + dato("Canje sin comisión", pct(cj(tasaSin)));
  return `
      ${inverso ? `<div class="recibo">Necesitas <b class="pos">${num(costo, 2)} ${de.sim}</b> <span class="suave">para recibir ${num(quiero, 2)} ${a.sim} netos · ${num(vn, 0)} VN de ${esc(tkV)}; recibes ${num(recibo, 2)} (${num(recibo - quiero, 2)} de más por redondear a 1 VN)</span></div>`
        : `<div class="recibo">Recibes <b class="pos">${num(recibo, 2)} ${a.sim}</b> <span class="suave">netos, por ${num(monto, 2)} ${de.sim} · vendiendo ${num(vn, 0)} VN de ${esc(tkV)}</span></div>`}
      <div class="datos mon">
        ${dato(`1 ${de.sim} =`, en(tasa, a, M.a === "ARS" ? 2 : M.de === "ARS" ? 6 : 4))}${dato(`1 ${a.sim} =`, en(1 / tasa, de, M.de === "ARS" ? 2 : M.a === "ARS" ? 6 : 4))}${cot}
      </div>
      <div class="datos mon">
        ${dato(`Compro ${esc(tkC)}`, `${num(vn, 0)} <small class="cant">VN a ${num(pc / 100, M.de === "ARS" ? 2 : 4)}</small>`)}${dato("Pago", en(costo, de))}${!(monto > 0) ? "" : sobra >= 0 ? dato("Sobra", en(sobra, de)) : dato(`Te falta (tienes ${num(monto, 2)})`, `<span class="neg">${en(-sobra, de)}</span>`)}
        ${dato("Comisiones", en(bruto * (cc + cv), a))}
      </div>
      <p class="nota">${esc(tkC)} a ${num(pc, M.de === "ARS" ? 2 : 3)} + ${pct(cc)} · ${esc(tkV)} a ${num(pv, M.a === "ARS" ? 2 : 3)} − ${pct(cv)} · precios por 100 VN, de a 1 VN · pago y recibo con comisión${ars ? "" : "; canje = MEP por cada cable − 1"} · ${esc(fuente)}${dec(M.pc) != null || dec(M.pv) != null ? " (con precio a mano)" : ""}.</p>
      <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>`;
}

// ---------- emisores ----------
const APROX = t => ` <span class="aprox" title="${esc(t)}">≈</span>`;
const CORTO = { "Solidez de balance": "Balance", "Cobertura de intereses": "Cobertura", "Caja después de invertir": "Caja post-inv.", "Liquidez": "Liquidez", "Lo que dicen los modelos": "Modelos", "Capacidad de pago": "Cap. de pago", "Promedio": "Promedio" };
// ---------- crédito por emisor (C11: calidad × duration, nota contra PD, paga de más contra liquidez, techo del país) ----------
// ons.json trae la razón social; el modelo de Emisores usa códigos cortos
const CODIGO_EM = [[/^YPF S\.A\./, "YPF"], [/^PAN AMERICAN/, "PAE"], [/^VISTA/, "VIST"], [/^PAMPA/, "PAM"], [/^TRANSPORTADORA DE GAS DEL SUR/, "TGS"],
  [/^CENTRAL PUERTO/, "CEPU"], [/^TECPETROL/, "TECP"], [/^PLUSPETROL/, "PLC"], [/^TELECOM/, "TEO"], [/^EDENOR/, "EDN"], [/^COMPA.IA GENERAL DE COMBUSTIBLES/, "CGC"],
  [/^PETROQUIMICA COMODORO/, "PCR"], [/^AEROPUERTOS/, "AA2000"], [/^ARCOR/, "ARCOR"], [/^LOMA NEGRA/, "LOMA"], [/^GENNEIA/, "GENN"],
  [/^INVERSIONES Y REPRESENTACIONES/, "IRSA"], [/^CRESUD/, "CRESY"], [/^CNH/, "CNH"], [/^MSU GREEN/, "MSU GREEN"], [/^MSU ENERGY/, "MSU"]];
const codigoEm = n => CODIGO_EM.find(([r]) => r.test(n || ""))?.[1] || null;
// punta vendedora de la línea en la que cobra (D = MEP, C = cable); sin puntas, el cierre de BYMA
function cotizar(b) {
  const linea = b.cobra === "CCL" ? "C" : "D", v = enVivo(b, linea) || deCierre(b, linea);
  const t = v?.tAsk ?? b.ytm;
  return { px: v?.ask ?? b.px, t, tb: v?.tBid ?? null, dm: v?.dm ?? b.dm, vivo: !!v && v.fuente !== "cierre",
    fl: v?.flujos?.length ? v.flujos : b.calculable ? flujosHoy(b) : [] };
}
// tramos de duration de la matriz de C11
const TRAMOS = [["corto", "Corto (DM ≤ 3)"], ["intermedio", "Intermedio (3 a 6,5)"], ["largo", "Largo (DM > 6,5)"]];
const tramoDe = dm => dm == null ? null : dm <= 3 ? "corto" : dm <= 6.5 ? "intermedio" : "largo";
// calidad del emisor (promedio de cualidades de 0 a 100)
const NIVELES = [["alta", "Calidad alta (≥ 70)"], ["media", "Calidad media (55 a 70)"], ["baja", "Calidad baja (< 55)"]];
const nivelDe = q => q == null ? null : q >= 70 ? "alta" : q >= 55 ? "media" : "baja";
// default a un año por nota, matriz de transición de S&P (C11, lámina 9)
const PD_NOTA = [["AAA", 0, 0], ["AA", 3, 0], ["A", 6, 0], ["BBB", 9, 0.001], ["BB", 12, 0.009], ["B", 15, 0.048], ["CCC/C", 99, 0.274]];
const pdNota = i => i == null ? null : PD_NOTA.find(([, hasta]) => i <= hasta);
// techo del país que usa el modelo de Emisores: la nota del soberano en escala global
const TECHO = ESCALA.indexOf("B-");
const POCA_LIQUIDEZ = 50000;   // US$ por día sumando todas sus ONs
const VOL_MIN = 20000;   // US$ por día: debajo de eso la TIR suele ser de un cierre viejo

// ---------- valuación bono por bono: caro o barato ----------
// Todo se mide en una sola escala, el dólar cable, para que la TIR de cada bono se pueda comparar con la del Tesoro y la
// de cualquier otro. Un bono que cobra cable usa su línea C. Uno que cobra MEP usa su propia línea C si cotiza con puntas
// sanas; si no, su precio MEP pasado a cable con el canje de mercado (precio C ≈ precio D ÷ (1 + canje)), con los mismos
// flujos: es la convención de la línea C (supone canje cero al cobro) y es una estimación, no un precio operable.
// La referencia soberana es la de su misma ley, también en cable: ley Nueva York contra los Globales, ley argentina contra
// los Bonares pasados a cable con el mismo canje; se usa para el spread y el α. Dos varas de caro o barato:
// (1) Calidad: TIR justa = la curva corporativa del mercado en cable, con un nivel por ley y pendientes comunes por calidad
//     del emisor y por ln(DM). No se ancla al soberano: hoy su curva está invertida y los corporativos rinden por debajo.
// (2) Curva: la TIR contra la curva del propio emisor ajustada SIN el bono que se mide (misma ley si alcanza); sin curva
//     propia, contra la mediana de sus pares de la misma celda de la matriz y la misma ley.
const TESORO = 0.0368;   // respaldo si meta.json no trae la curva: el T-bill manual del modelo de Emisores
// Tesoro de EE.UU. a la duration del bono: curva par oficial del cierre (meta.tesoro, ya en efectiva anual), lineal entre plazos
function tesoroA(dm) {
  const c = E.meta?.tesoro?.curva;
  if (!c?.length || dm == null) return TESORO;
  if (dm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) if (dm <= c[i][0]) return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * (dm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
  return c.at(-1)[1];
}
const ALPHA_SECTOR = { "O&G": 0.35, "Infraestructura": 0.45, "Telco": 0.55 };   // α que supone el modelo de Emisores; resto 0,60
const alphaDe = s => ALPHA_SECTOR[s] ?? 0.60;
const DM_MIN = 0.5;   // debajo, el precio va a la par al vencimiento y la TIR no mide valor
const BANDA_PB = 25;  // en precio dentro de ±25 pb, o de media punta si las puntas están más abiertas
const SOB_DE = { NY: "Globales", ARG: "Bonares" };
const mediana = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
// t = a + b·ln(DM) por mínimos cuadrados; fuera del rango de los puntos queda plana (no se extrapola la pendiente)
function ajusteLog(pts) {
  if (pts.length < 2) return null;
  const xs = pts.map(p => Math.log(p.dm)), ys = pts.map(p => p.t), n = pts.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  const sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0), sxy = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0);
  const b = sxx > 1e-6 ? sxy / sxx : 0, a = my - b * mx, lo = Math.min(...pts.map(p => p.dm)), hi = Math.max(...pts.map(p => p.dm));
  return { n, lo, hi, f: dm => a + b * Math.log(Math.min(hi, Math.max(lo, dm))) };
}
// robusto: ajusta, saca una vez los puntos a más de 3 desvíos medianos y reajusta
// curva corporativa del mercado: t = a[ley] + bq·(100 − calidad) + bd·ln(DM) + bc·conversión, con un nivel por ley y
// pendientes comunes. «conversión» es lo que suma a la TIR pasar un bono MEP a cable con canje cero al cobro (TIR cable −
// TIR MEP; cero si cobra cable): bc es la parte de ese canje que el mercado espera que siga, así la conversión no vuelve
// barato a un bono por sí sola. Mínimos cuadrados con las variables centradas dentro de cada ley.
function curvaMercado(pts) {
  const k = 3;
  if (pts.length < 8) return null;
  const g = {}, prom = a => a.reduce((s, v) => s + v, 0) / a.length;
  for (const p of pts) (g[p.ley] ||= []).push(p);
  const m = Object.fromEntries(Object.entries(g).map(([l, a]) => [l, { x: [0, 1, 2].map(i => prom(a.map(p => p.x[i]))), y: prom(a.map(p => p.y)), n: a.length }]));
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  for (const p of pts) {
    const c = m[p.ley], d = p.x.map((v, i) => v - c.x[i]), dy = p.y - c.y;
    for (let i = 0; i < k; i++) { B[i] += d[i] * dy; for (let j = 0; j < k; j++) A[i][j] += d[i] * d[j]; }
  }
  // eliminación de Gauss con pivoteo parcial
  for (let i = 0; i < k; i++) {
    const piv = [i, i + 1, i + 2].filter(r => r < k).reduce((a, r) => Math.abs(A[r][i]) > Math.abs(A[a][i]) ? r : a, i);
    [A[i], A[piv]] = [A[piv], A[i]]; [B[i], B[piv]] = [B[piv], B[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let r = i + 1; r < k; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < k; c++) A[r][c] -= f * A[i][c]; B[r] -= f * B[i]; }
  }
  const b = [0, 0, 0];
  for (let i = k - 1; i >= 0; i--) b[i] = (B[i] - [0, 1, 2].filter(j => j > i).reduce((s, j) => s + A[i][j] * b[j], 0)) / A[i][i];
  const a = Object.fromEntries(Object.entries(m).map(([l, c]) => [l, c.y - b.reduce((s, v, i) => s + v * c.x[i], 0)]));
  return { a, bq: b[0], bd: b[1], bc: b[2], n: pts.length, nLey: Object.fromEntries(Object.entries(m).map(([l, c]) => [l, c.n])),
    f: (ley, q, dm, conv = 0) => a[ley] == null ? null : a[ley] + b[0] * (100 - q) + b[1] * Math.log(dm) + b[2] * conv };
}
function robusto(pts, ajustar, resid) {
  const c = ajustar(pts);
  if (!c || pts.length < 5) return c && { ...c, fuera: [] };
  const r = pts.map(p => Math.abs(resid(c, p))), lim = Math.max(3 * mediana(r), 0.005);
  const quedan = pts.filter((p, i) => r[i] <= lim), fuera = pts.filter((p, i) => r[i] > lim);
  return fuera.length && quedan.length >= 3 ? { ...ajustar(quedan), fuera } : { ...c, fuera: [] };
}
const leyDe = b => b.tipo === "sob" ? (b.ley === "NY" ? "NY" : "ARG") : b.isin?.startsWith("AR") ? "ARG" : "NY";
// canje de mercado (dólares MEP por cada cable − 1): mediana del canje D/C de los bonos con las dos líneas con puntas;
// sin puntas, el cociente de los tipos de cambio CCL y MEP del cierre de BYMA
function canjeMercado() {
  const todos = [...E.ons, ...E.soberanos], vivos = todos.map(canje).filter(c => c != null && c > -0.05 && c < 0.3);
  if (vivos.length >= 5) return { c: mediana(vivos), n: vivos.length, fuente: "vivo" };
  const fx = r => todos.find(b => b.cierre?.fxr === r && b.cierre.fx > 0)?.cierre.fx, m = fx("MEP"), c = fx("CCL");
  return m && c ? { c: c / m - 1, fuente: "cierre", mep: m, ccl: c } : null;
}
// la cotización del bono expresada en cable: t (TIR cable), via (de dónde sale) y tLinea (la TIR en la línea en que cobra).
// Primero la línea C (en vivo con puntas sanas, o el cierre si cerró en cable); si no, el precio de la línea D pasado a
// cable con el canje. Para un bono que cobra cable eso es arbitraje; para uno que cobra MEP supone canje cero al cobro.
function enCable(b, cj) {
  const r = cotizar(b), base = { ...r, tLinea: r.t }, propia = b.cobra === "CCL" ? "cable" : "línea C";
  const v = enVivo(b, "C");
  if (v?.tAsk != null && !dudosa(v.tAsk) && (b.cobra === "CCL" || (v.ancho != null && v.ancho < 0.02)))
    return { ...base, px: v.ask, t: v.tAsk, tb: v.tBid, dm: v.dm, via: propia };
  const c = deCierre(b, "C");
  if (c) return { ...base, px: c.ask, t: c.tAsk, tb: null, dm: c.dm, via: propia };
  const d = enVivo(b, "D") || deCierre(b, "D");
  if (!cj || !d?.ask || !d.flujos?.length) return { ...base, t: null, via: "sin canje" };
  const px = d.ask / (1 + cj.c), t = tir(d.flujos, px), tb = d.bid ? tir(d.flujos, d.bid / (1 + cj.c)) : null;
  return { ...base, px, fl: d.flujos, t, tb: d.fuente === "cierre" ? null : tb, dm: t != null ? duration(d.flujos, t).modificada : r.dm, via: b.cobra === "CCL" ? "canje cable" : "canje" };
}
// sensibilidad al canje: la TIR en cable que sale del canje, si el canje fuera la mitad del de hoy
const conMedioCanje = (e, cj) => (e?.via === "canje" || e?.via === "canje cable") && cj?.c > 0 && e.px && e.fl?.length
  ? tir(e.fl, e.px * (1 + cj.c) / (1 + cj.c / 2)) : null;
const valido = r => r.fl.length && r.t != null && !dudosa(r.t) && r.dm >= DM_MIN && r.b.vol >= VOL_MIN;
// contexto de una pasada: canje, curva soberana por ley en cable, calibración por calidad, bonos y celdas de la matriz
// castigado por el mercado: perdió 8 puntos de paridad o más en la ventana del tablero (~21 ruedas), o subió su TIR
// 300 pb con al menos 4 puntos de caída. Su calidad sale de balances al 3T26 y el precio ya descuenta algo más nuevo.
const CASTIGO_PAR = -8, CASTIGO_PB = 300;
const castigado = b => !!b?.hist && (b.hist.dpar <= CASTIGO_PAR || (b.hist.dtir_pb >= CASTIGO_PB && b.hist.dpar <= -4));
function contextoValuacion(d) {
  const cj = canjeMercado(), pts = {};
  for (const s of E.soberanos) {
    if (s.segmento !== "sob" || !s.calculable) continue;
    const r = { b: s, ...enCable(s, cj) };
    if (valido(r)) (pts[leyDe(s)] ||= []).push({ dm: r.dm, t: r.t, tk: s.tk, via: r.via });
  }
  const sob = Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, { ...robusto(p, ajusteLog, (c, q) => q.t - c.f(q.dm)), pts: p }]));
  const bonos = [];
  for (const b of E.ons) {
    const em = codigoEm(b.emisor), x = em && d.emisores[em];
    if (x) bonos.push({ b, em, x, ley: leyDe(b), q: x.cualidades?.Promedio, ...enCable(b, cj) });
  }
  const ok = bonos.filter(valido), celdas = {};
  for (const r of ok) { const k = r.ley + nivelDe(r.q) + tramoDe(r.dm); (celdas[k] ||= []).push(r); }
  const conv = r => r.b.cobra === "CCL" || r.tLinea == null || dudosa(r.tLinea) ? 0 : r.t - r.tLinea;
  for (const r of bonos) r.conv = conv(r);
  const p = ok.filter(r => r.q != null && !castigado(r.b)).map(r => ({ x: [100 - r.q, Math.log(r.dm), r.conv], y: r.t, tk: r.b.tk, ley: r.ley }));
  const c = robusto(p, curvaMercado, (c, q) => q.y - c.f(q.ley, 100 - q.x[0], Math.exp(q.x[1]), q.x[2]));
  return { cj, sob, cal: c && { ...c, total: p.length }, bonos, ok, celdas };
}
// TIR al peor con rescate a la par: la base no trae los cronogramas de rescate, así que se calcula la cota inferior de
// un bono sobre la par si el emisor pudiera rescatarlo al 100% en cualquier fecha de pago desde dentro de un año (el período
// sin rescate habitual; antes, la tasa anualizada de un rescate de meses no tiene sentido). Si el bono
// no es rescatable o su rescate tiene prima, la TIR real queda entre esta y la de vencimiento.
function tirAlPeor(fl, px, t) {
  const cap = fl.reduce((a, f) => a + f[1], 0);
  if (!fl?.length || !(px > cap) || t == null) return null;
  let peor = null, resto = cap;
  for (let k = 0; k < fl.length - 1; k++) {
    resto -= fl[k][1];
    if (fl[k][0] < 365 || resto <= 0) continue;
    const y = tir([...fl.slice(0, k), [fl[k][0], fl[k][1] + resto, fl[k][2], fl[k][3] || 0]], px);
    if (y != null && (peor == null || y < peor.t)) peor = { t: y, dias: fl[k][0] };
  }
  return peor && peor.t < t - 0.0025 ? peor : null;
}
function valorar(r, ctx) {
  r = ctx.bonos.find(o => o.b.tk === r.b.tk) || r;
  const { b, x } = r;
  if (!r.fl.length || r.t == null || dudosa(r.t)) return { motivo: r.via === "sin canje" ? "sin canje para pasarlo a cable" : "sin TIR confiable" };
  if (r.dm < DM_MIN) return { motivo: "vence pronto: va a la par" };
  if (!(b.vol >= VOL_MIN)) return { motivo: "poco volumen: precio viejo" };
  const ley = leyDe(b), sob = ctx.sob[ley], cal = ctx.cal, q = x.cualidades?.Promedio, v = { ley, via: r.via, t: r.t, tLinea: r.tLinea, px: r.px };
  const medio = r.tb != null && r.tb > r.t ? (r.tb - r.t) / 2 * 1e4 : 0;
  v.banda = Math.max(BANDA_PB, medio);
  v.peor = tirAlPeor(r.fl, r.px, r.t);
  const medio_ = conMedioCanje(r, ctx.cj);
  if (medio_ != null) v.alt = `Con el canje a la mitad (${pct(ctx.cj.c / 2, 1)}), la TIR en cable sería ${pct(medio_)} (${pb((medio_ - r.t) * 1e4)} pb)`;
  // (1) contra lo que el mercado paga, en cable, por un bono de su calidad, su ley y su duration
  if (cal?.a[ley] != null && q != null) {
    v.tj = cal.f(ley, q, r.dm, r.conv || 0);
    v.pj = r.px * vp(r.fl, v.tj) / vp(r.fl, r.t);
    v.vsCal = (r.t - v.tj) * 1e4; v.vsPx = v.pj / r.px - 1;
  }
  if (sob?.f) {
    v.sob = sob.f(r.dm); v.s = r.t - v.sob;
    // α: qué parte del riesgo país (soberano de su ley sobre el Tesoro, en cable) le cobra el mercado
    v.ust = tesoroA(r.dm); v.sUst = r.t - v.ust;
    if (v.sob - v.ust > 0.002) v.aImpl = (Math.round((r.t - v.ust) / (v.sob - v.ust) * 100) / 100) || 0;
  }
  // (2) contra su curva, sin el bono que se mide
  const otros = ctx.ok.filter(o => o.em === r.em && o.b.tk !== b.tk), misma = otros.filter(o => o.ley === ley);
  const base = misma.length >= 3 ? [misma, `la curva del emisor con sus otros bonos de ley ${ley === "NY" ? "Nueva York" : "argentina"}, en cable`]
    : otros.length >= 3 ? [otros, `la curva del emisor con todos sus otros bonos, en cable`] : null;
  if (base) { const c = ajusteLog(base[0]); v.vsCurva = (r.t - c.f(r.dm)) * 1e4; v.ref = "su curva"; v.refLargo = base[1]; }
  else {
    const pares = (ctx.celdas[ley + nivelDe(q) + tramoDe(r.dm)] || []).filter(o => o.em !== r.em);
    if (pares.length >= 3) { v.vsCurva = (r.t - mediana(pares.map(o => o.t))) * 1e4; v.ref = "sus pares"; v.refLargo = `la mediana de ${pares.length} bonos de otros emisores de su misma celda de la matriz y su misma ley, en cable`; }
  }
  const lado = y => y == null ? null : y > v.banda ? "barato" : y < -v.banda ? "caro" : "en precio";
  const rel = lado(v.vsCurva), cal_ = lado(v.vsCal);
  v.lado = cal_ === rel ? rel : rel === "en precio" ? cal_ : cal_ === "en precio" ? rel : rel ? "mixto" : cal_;
  v.lectura = rel && cal_ ? (rel === cal_ ? (rel === "en precio" ? "en precio en las dos" : `${rel} en las dos`) : `${cal_} por su calidad; ${rel} contra ${v.ref}`)
    : cal_ ? `${cal_} por su calidad` : rel ? `${rel} contra ${v.ref}` : "—";
  if (castigado(b)) {
    const h = b.hist;
    v.castigo = h; v.ladoModelo = v.lado; v.lado = "castigado";
    v.lectura = `castigado por el mercado: ${num(h.dpar, 1)} pts de paridad${h.dtir_pb != null ? ` y ${h.dtir_pb > 0 ? "+" : ""}${num(h.dtir_pb, 0)} pb de TIR` : ""} desde el ${fecha(h.desde)}. El modelo lo daría ${v.ladoModelo || "—"}, pero su calidad es del balance al 3T26: el precio ya descuenta algo más nuevo`;
  }
  return v;
}
const ladoCls = y => y == null ? "" : y > 0 ? "pos" : "neg";
const VIA = { cable: "cobra cable: su línea C", "línea C": "cobra MEP: precio de su propia línea C", canje: "cobra MEP: precio MEP pasado a cable con el canje (estimado, supone canje cero al cobro)", "canje cable": "cobra cable pero hoy solo hay precio en MEP: pasado a cable con el canje" };
const TIRC = v => v.t == null ? "—" : `<span title="${esc(VIA[v.via] || "")}${v.via !== "cable" && v.tLinea != null ? ` · TIR en MEP ${pct(v.tLinea)}` : ""}${v.peor ? ` · Sobre la par: si fuera rescatable a la par desde dentro de un año, la TIR al peor sería ${pct(v.peor.t)} (rescate en ${num(v.peor.dias / 365, 1)} años); la base no trae el cronograma de rescate` : ""}${v.alt ? ` · ${v.alt}` : ""}">${TIRV(v.t)}${v.via === "canje" ? "<small class=\"suave\">*</small>" : ""}${v.peor ? "<small class=\"aviso\">↓</small>" : ""}</span>`;
const VAL_PB = v => v.vsCurva == null ? "—" : `<span class="${Math.abs(v.vsCurva) > v.banda ? ladoCls(v.vsCurva) : "suave"}" title="TIR contra ${esc(v.refLargo)}: positivo = rinde más = barato. Banda: ±${num(v.banda, 0)} pb">${pb(v.vsCurva)} pb</span>`;
const VAL_CAL = v => v.vsCal == null ? "—" : `<span class="${Math.abs(v.vsCal) > v.banda ? ladoCls(v.vsCal) : "suave"}" title="TIR contra la TIR justa por su calidad (${pct(v.tj)}): positivo = barato. En precio: ${v.vsPx > 0 ? "+" : ""}${pct(v.vsPx, 1)}">${pb(v.vsCal)} pb</span>`;
const VAL_LEC = v => v.motivo ? `<span class="suave">${esc(v.motivo)}</span>` : `<span class="${v.lado === "barato" ? "pos" : v.lado === "caro" ? "neg" : v.lado === "castigado" ? "aviso" : "suave"}">${esc(v.lectura)}</span>`;

function fichaCredito(x) {
  const bonos = E.ons.filter(b => codigoEm(b.emisor) === x.em).map(b => ({ b, ...cotizar(b), c: calif(b) }))
    .sort((a, b) => (a.b.vencimiento || "").localeCompare(b.b.vencimiento || ""));
  if (!bonos.length) return `<p class="nota">Sin ONs hard dollar de ${esc(x.em)} en el universo de Balanz.</p>`;
  const notas = bonos.map(r => r.c.int).filter(i => i != null), nota = notas.length ? Math.max(...notas) : null;
  const q = x.cualidades?.Promedio, niv = nivelDe(q), z = x.altman?.zona, vol = bonos.reduce((s, r) => s + (r.b.vol || 0), 0);
  const dif = x.pricing?.["Dif. mercado - exigida"], pdM = x.pricing?.PD_1y, pn = pdNota(nota);
  const L = [];
  // posición en la matriz
  const tramos = [...new Set(bonos.map(r => tramoDe(r.dm)).filter(Boolean))];
  L.push(`En la matriz calidad × duration: <b>${esc((NIVELES.find(([k]) => k === niv) || [, "sin calidad medida"])[1].toLowerCase())}</b>, con bonos en el tramo ${tramos.map(t => TRAMOS.find(([k]) => k === t)[1].split(" (")[0].toLowerCase()).join(", ") || "—"}.`);
  // nota contra PD del modelo
  if (pn) L.push(`Nota internacional ${esc(ESCALA[nota])}: la matriz de S&P le asigna <b>${pct(pn[2], 1)}</b> de default a un año a la categoría ${pn[0]}. El Merton propio da ${pct(pdM)}${pdM != null && pn[2] > 0 && pdM < pn[2] / 5 ? ": el modelo ve a la firma bastante mejor que su nota, que está atada al riesgo del país y no a los números de la empresa" : pdM != null && pdM > pn[2] ? ": el modelo ve a la firma peor que su nota" : ""}.`);
  else L.push("Sin nota internacional cargada: no se puede comparar con la matriz de S&P.");
  // techo del país: rising star o caída
  if (nota != null) {
    const buena = niv === "alta" || z === "segura";
    L.push(nota < TECHO ? `Califica por encima del techo del país (${esc(ESCALA[nota])} contra ${ESCALA[TECHO]}): la nota ya le reconoce dólares propios o estructura que no dependen del MLC.`
      : nota === TECHO ? (buena ? `Está en el techo del país con números de primer escalón: es candidato a subir de nota si sube el soberano. Esa mejora viene del país, no de la empresa.` : `Está en el techo del país y sus números no sostienen por sí solos una nota mayor.`)
      : (niv !== "baja" && z !== "riesgo" ? `Está por debajo del país (${esc(ESCALA[nota])}) con números que no son los de un crédito débil: es candidato a una mejora propia.` : `Está por debajo del país (${esc(ESCALA[nota])}) y con números débiles: el riesgo es que la nota siga bajando.`));
  }
  // paga de más: ¿crédito o liquidez?
  // el modelo de Emisores cobra solo la pérdida esperada del Merton más α × riesgo país: no incluye prima por liquidez ni por riesgo
  if (dif != null) L.push((dif > 0 ? (vol < POCA_LIQUIDEZ ? `Paga <b>${pb(dif * 1e4)} pb</b> más de lo que exige el modelo, pero sus ONs suman US$ ${num(vol / 1e3, 0)} k por día: parte puede ser prima por liquidez y no una ineficiencia de crédito.` : `Paga <b>${pb(dif * 1e4)} pb</b> más de lo que exige el modelo, con US$ ${num(vol / 1e3, 0)} k por día de volumen: si el modelo está bien, el mercado lo ve peor que sus números (ineficiencia de crédito, no de liquidez).`)
    : `Paga <b>${pb(dif * 1e4)} pb</b> respecto de lo que exige el modelo: el mercado lo ve mejor que sus números, o paga escasez de papel.`) + ` <span class="suave">El modelo exige solo la pérdida esperada (Merton) más una parte fija del riesgo país por sector; no cobra prima por liquidez ni por riesgo, así que en casi todos los emisores el mercado «paga de más». Para caro o barato vale más la valuación por calidad de la tabla de abajo.</span>`);
  if (z === "riesgo") L.push("Z'' en zona de riesgo: mirar los cuatro cocientes antes de leer la TIR como premio.");
  // valuación de cada bono: contra el modelo y contra su curva o sus pares
  const ctx = E.emisores ? contextoValuacion(E.emisores) : null;
  for (const r of bonos) r.v = ctx ? valorar({ ...r, em: x.em, x }, ctx) : { motivo: "—" };
  const imp = bonos.map(r => r.v.aImpl).filter(a => a != null).sort((p, q) => p - q);
  if (imp.length) L.push(`Riesgo país que el mercado le traslada, en cable y contra el soberano de la misma ley: <b>${pct(imp[Math.floor(imp.length / 2)], 0)}</b> en la mediana de sus bonos, contra ${pct(alphaDe(x.sector), 0)} que supone el modelo para ${esc(x.sector)}. ${imp[Math.floor(imp.length / 2)] > alphaDe(x.sector) + 0.1 ? "El mercado lo trata más pegado al país que el modelo: por eso el modelo lo ve barato. Si el modelo tiene razón, el premio se cobra cuando el mercado lo despegue del soberano." : imp[Math.floor(imp.length / 2)] < alphaDe(x.sector) - 0.1 ? "El mercado ya lo despega del país más de lo que supone el modelo." : "Mercado y modelo coinciden en cuánto del país carga."}`);
  const filas = bonos.map(r => `<tr><td><span class="tk">${esc(r.b.tk)}</span></td><td>${leyDe(r.b)}</td><td>${r.b.cobra === "CCL" ? "cable" : "MEP"}</td><td>${fecha(r.b.vencimiento)}</td><td class="n">${num(r.dm)}</td><td>${esc(tramoDe(r.dm) || "—")}</td><td class="n">${TIRV(r.t)}</td><td class="n">${TIRC(r.v)}</td><td class="n">${pct(r.v.tj)}</td><td class="n">${num(r.v.px)}</td><td class="n">${num(r.v.pj)}</td><td class="n">${VAL_CAL(r.v)}</td><td class="n">${VAL_PB(r.v)}</td><td>${VAL_LEC(r.v)}</td><td>${r.c.int == null ? "—" : esc(ESCALA[r.c.int]) + (r.c.heredada ? ' <small class="suave">del emisor</small>' : "")}</td><td class="n">${r.b.vol > 0 ? num(r.b.vol / 1e3, 0) + " k" : "—"}</td></tr>`).join("");
  return `<h4>Análisis de crédito</h4>${L.map(t => `<p class="nota">${t}</p>`).join("")}
    <div class="tabla-caja"><table><thead><tr><th>ON</th><th>Ley</th><th>Cobra</th><th>Vence</th><th class="n">DM</th><th>Tramo</th><th class="n" title="TIR en la línea en la que cobra">TIR</th><th class="n" title="TIR en dólar cable: la escala en la que se valúa. * = estimada con el canje">TIR cable</th><th class="n" title="Lo que el mercado paga en cable por un bono de su calidad, su ley y su duration">TIR justa</th><th class="n" title="Precio en cable">Precio C</th><th class="n">Precio justo</th><th class="n" title="TIR contra la TIR justa por su calidad, en pb: positivo = barato">Vs. calidad</th><th class="n" title="TIR contra su curva o sus pares: positivo = barato">Vs. curva</th><th>Lectura</th><th>Nota</th><th class="n">Vol. diario</th></tr></thead><tbody>${filas}</tbody></table></div>
    <p class="nota suave">TIR cable con * = precio MEP pasado a cable con el canje de mercado, con los mismos flujos (supone canje cero al cobro): es una estimación, no un precio operable. La TIR es al vencimiento: en una ON rescatable sobreestima lo que paga si el emisor la rescata antes (falta el OAS, y la base no trae las fechas de rescate). La matriz de S&P es global y de largo plazo; la nota de un corporativo argentino suele estar limitada por la del país. Cómo se valúa cada bono: ver la nota de «Valuación bono por bono» en Emisores.</p>`;
}

// matriz calidad × duration de todo el universo de Balanz (C11): filas calidad del emisor, columnas tramo de duration
function matrizCalidadDuration(d) {
  const celdas = {};
  for (const b of E.ons) {
    const em = codigoEm(b.emisor), x = em && d.emisores[em];
    if (!x) continue;
    const r = cotizar(b), niv = nivelDe(x.cualidades?.Promedio), tr = tramoDe(r.dm);
    if (!niv || !tr || r.t == null || dudosa(r.t) || !(b.vol >= VOL_MIN)) continue;
    (celdas[niv + tr] ||= []).push({ em, t: r.t });
  }
  const celda = c => {
    if (!c?.length) return `<span class="suave">—</span>`;
    const ts = c.map(r => r.t).sort((a, b) => a - b), med = ts[Math.floor(ts.length / 2)];
    const ems = [...new Set(c.map(r => r.em))];
    return `<b>${pct(med)}</b> <small class="suave">${c.length} ON · ${pct(ts[0])} a ${pct(ts.at(-1))}</small><br><small>${ems.map(esc).join(" · ")}</small>`;
  };
  return `<div class="tabla-caja"><table><thead><tr><th>Calidad × duration · TIR mediana</th>${TRAMOS.map(([, t]) => `<th>${t}</th>`).join("")}</tr></thead><tbody>${
    NIVELES.map(([k, t]) => `<tr><td><b>${t}</b></td>${TRAMOS.map(([j]) => `<td>${celda(celdas[k + j])}</td>`).join("")}</tr>`).join("")
  }</tbody></table></div>`;
}

async function pEmisores() {
  const el = $("#p-emisores");
  if (!E.emisores || !E.altman) {
    el.innerHTML = `<p class="nota">Cargando emisores…</p>`;
    const leer = n => fetch(`data/${n}.json`, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(n); return r.json(); });
    try { [E.emisores, E.altman] = await Promise.all([E.emisores || leer("emisores"), E.altman || leer("altman")]); }
    catch (e) { el.innerHTML = `<p class="nota neg">No se pudo cargar data/${esc(e.message)}.json.</p>`; return; }
    if (actual !== "emisores") return;
  }
  const d = E.emisores, filas = Object.entries(d.emisores).map(([em, x]) => ({ em, ...x, altman: E.altman.emisores[em] }));
  const nombres = Object.keys(filas[0]?.cualidades || {});
  const cols = [
    { k: "em", t: "Emisor", f: x => `<span class="tk">${esc(x.em)}</span>${x.inestable ? ' <span class="aviso" title="El orden cambia mucho al sacar una cualidad">⚠</span>' : ""}`, v: x => x.em },
    { k: "sector", t: "Sector", cls: "ocultar-movil", f: x => esc(x.sector), v: x => x.sector },
    { k: "corte", t: "Corte", f: x => x.corte === "3T26" ? `<span class="etq">3T26</span>` : `<span class="suave">${esc(x.corte || d.corte)}</span>`, v: x => x.corte, titulo: "Último trimestre del balance usado" },
    ...nombres.map(q => ({ k: "q:" + q, t: CORTO[q] || q, titulo: q, n: 1, f: x => `<span class="${q === "Promedio" ? "tk" : ""}">${num(x.cualidades[q], 0)}</span>${q === "Promedio" && x.estimados?.length ? APROX("Hay insumos del balance estimados: ver la ficha") : ""}`, v: x => x.cualidades[q] })),
    { k: "z", t: "Z''", n: 1, titulo: "Z'' de Altman: verde más de 2,6 (zona segura), gris de 1,1 a 2,6, rojo menos de 1,1 (crédito de riesgo). Abre la ficha para ver los cuatro cocientes", f: x => zAltman(x.altman), v: x => x.altman?.z },
    { k: "exig", t: "TIR exigida", n: 1, f: x => pct(x.pricing["TIR exigida"]) + (x.metricas.estimado ? APROX("Sin acciones que coticen: el valor de los activos del Merton es estimado") : ""), v: x => x.pricing["TIR exigida"], titulo: "Merton + spread soberano" },
    { k: "merc", t: "TIR mercado", n: 1, f: x => pct(x.pricing["TIR mercado"]) + (x.metricas["TIR lejana"] ? APROX(x.metricas["TIR equivalente"] ? "TIR de un bono equivalente, no del emisor" : "TIR de un bono de plazo lejano al horizonte") : ""), v: x => x.pricing["TIR mercado"] },
    { k: "dif", t: "Paga de más", n: 1, f: x => { const v = x.pricing["Dif. mercado - exigida"]; return v == null ? "—" : `<span class="${v > 0 ? "pos" : "neg"}">${pb(v * 1e4)} pb</span>`; }, v: x => x.pricing["Dif. mercado - exigida"], titulo: "TIR de mercado − TIR exigida: positivo = barato" },
    { k: "pd", t: "PD 1 año", n: 1, cls: "ocultar-movil", f: x => pct(x.pricing.PD_1y), v: x => x.pricing.PD_1y },
    { k: "puesto", t: "Puesto", n: 1, f: x => x.puestos ? `${num(x.puestos.base, 0)} <span class="suave">(${num(x.puestos.min, 0)}–${num(x.puestos.max, 0)})</span>` : "—", v: x => x.puestos?.base, titulo: "Puesto base y rango al sacar una cualidad por vez" },
  ];
  if (!E.orden.emisores) E.orden.emisores = { k: "q:Promedio", asc: false };
  el.replaceChildren(
    nota(`${filas.length} emisores · corte ${esc(d.corte)} · horizonte ${num(d.horizonte_anios, 0)} años · orden por calidad (promedio de cualidades), valor en «paga de más» · <span class="aprox">≈</span> = el número se apoya en un dato estimado (pasa el mouse o abre la ficha). Ojo: los emisores con corte distinto se comparan con balances de trimestres distintos`),
    tabla("emisores", filas, cols, { alClick: fichaEmisor }),
    nota("Matriz calidad × duration: las dos primeras palancas de la renta fija activa. Las filas son la calidad del emisor (promedio de cualidades) y las columnas el tramo de duration de cada ON hard dollar del universo de Balanz que opera al menos US$ 20 k por día. Bajar de fila es tomar crédito y moverse a la derecha es tomar duration: lo que se cobra por cada uno es la diferencia de TIR entre celdas."),
    Object.assign(document.createElement("div"), { innerHTML: matrizCalidadDuration(d) }),
    ...tablaValuacion(d, filas),
    Object.assign(document.createElement("div"), { className: "lectura", innerHTML: d.lectura_html }));
}

// valuación bono por bono de todo el universo, agrupada por emisor y ordenada por calidad
function tablaValuacion(d, emisores) {
  const ctx = contextoValuacion(d), porEm = new Map(emisores.map(x => [x.em, x]));
  const todas = ctx.bonos.map(r => ({ ...r, v: valorar(r, ctx) }));
  const filas = todas.filter(r => !r.v.motivo).sort((a, b) => (b.q ?? -1) - (a.q ?? -1) || a.em.localeCompare(b.em) || a.dm - b.dm);
  const fuera = todas.length - filas.length, cal = ctx.cal, cj = ctx.cj;
  const via = k => filas.filter(r => r.v.via === k).length;
  const sobTxt = Object.entries(ctx.sob).map(([k, c]) => `${SOB_DE[k]} para ley ${k === "NY" ? "Nueva York" : "argentina"} (${c.pts.filter(p => !c.fuera.includes(p)).map(p => p.tk).join(", ")}; DM ${num(c.lo, 1)} a ${num(c.hi, 1)}${c.fuera.length ? `; afuera por desalineados: ${c.fuera.map(p => p.tk).join(", ")}` : ""})`).join(" y ");
  const calTxt = cal ? Object.keys(cal.a).map(l => `ley ${l === "NY" ? "Nueva York" : "argentina"} ${pct(cal.f(l, 70, 3))} (${cal.nLey[l]} bonos)`).join(" y ") : "";
  const cols = [
    { k: "em", t: "Emisor", f: r => `<span class="tk">${esc(r.em)}</span> <small class="suave">${num(r.q, 0)}</small>`, v: r => r.em },
    { k: "tk", t: "ON", f: r => `${esc(r.b.tk)} <small class="suave">${r.ley} · ${r.b.cobra === "CCL" ? "cable" : "MEP"}</small>`, v: r => r.b.tk },
    { k: "dm", t: "DM", n: 1, f: r => num(r.dm), v: r => r.dm },
    { k: "t", t: "TIR cable", n: 1, f: r => TIRC(r.v), v: r => r.t, titulo: "TIR en dólar cable; * = precio MEP pasado a cable con el canje (estimado). Pasa el mouse para ver la TIR en MEP" },
    { k: "tj", t: "TIR justa", n: 1, cls: "ocultar-movil", f: r => pct(r.v.tj), v: r => r.v.tj, titulo: "Lo que el mercado paga en cable por un bono de su calidad, su ley y su duration" },
    { k: "cal", t: "Vs. calidad", n: 1, f: r => VAL_CAL(r.v), v: r => r.v.vsCal, titulo: "TIR contra la TIR justa por su calidad, en pb: positivo = barato" },
    { k: "aimp", t: "α mercado", n: 1, cls: "ocultar-movil", f: r => r.v.aImpl == null ? "—" : `${pct(r.v.aImpl, 0)} <small class="suave">vs ${pct(alphaDe(r.x.sector), 0)}</small>`, v: r => r.v.aImpl, titulo: "Qué parte del riesgo país (soberano de su ley sobre el Tesoro, en cable) le cobra el mercado, contra la que supone el modelo de Emisores para su sector" },
    { k: "cur", t: "Vs. curva", n: 1, f: r => VAL_PB(r.v), v: r => r.v.vsCurva, titulo: "TIR contra su curva o sus pares, en pb: positivo = barato" },
    { k: "lec", t: "Lectura", f: r => VAL_LEC(r.v), v: r => r.v.lado },
  ];
  return [
    nota(`Valuación bono por bono (${filas.length} ON; ${fuera} quedan afuera por vencer en menos de medio año de duration, operar menos de US$ 20 k por día o no tener TIR confiable). <b>Todo en dólar cable</b>, la moneda del Tesoro, para que las TIR se puedan comparar entre sí: ${via("cable")} cobran cable y usan su línea C; ${via("canje cable")} cobran cable pero hoy solo tienen precio en MEP, que se pasa a cable con el canje (arbitraje: sus flujos ya son cable); ${via("línea C")} cobran MEP y usan el precio de su propia línea C; ${via("canje")} cobran MEP y su precio se pasa a cable con el canje de mercado (${cj ? `${pct(cj.c, 1)}, ${cj.fuente === "vivo" ? `mediana de ${cj.n} bonos con las dos líneas en vivo` : `CCL ${num(cj.ccl, 2)} sobre MEP ${num(cj.mep, 2)} del cierre de BYMA`}` : "sin dato"}), marcados con *: misma convención que la línea C (supone que cada dólar MEP que paga vale un cable al cobro), así que es una estimación y no un precio operable; sobre la TIR se ve cuánto daría con el canje a la mitad, para medir cuánto depende de ese supuesto. <b>Referencia soberana de la misma ley</b>, también en cable: ${sobTxt}; fuera de ese rango la curva queda plana. El soberano se usa para el spread y el α, no para la TIR justa: hoy su curva está invertida y los corporativos rinden por debajo del país. <b>Vs. calidad</b>: la TIR justa es lo que el mercado paga en cable por un bono de su calidad, su ley y su duration, según una curva corporativa ajustada a todo el universo: ${cal ? `para un emisor de calidad 70 a DM 3, ${calTxt}; ${pb(cal.bq * 1e5)} pb más por cada 10 puntos menos de calidad y ${pb(cal.bd * Math.log(2) * 1e4)} pb cada vez que se duplica la duration; y de lo que suma a la TIR pasar un bono MEP a cable con canje cero al cobro, el mercado ya descuenta ${pct(cal.bc, 0)} (la parte del canje que espera que siga), así que esa conversión no lo vuelve barato por sí sola (regresión de ${cal.n} bonos con un nivel por ley y pendientes comunes${cal.fuera?.length ? `; ${cal.fuera.length} afuera por desalineados: ${cal.fuera.map(p => p.tk).join(", ")}` : ""})` : "sin calibración"}. Con esa TIR se revalúan sus flujos y sale el precio justo. <b>Vs. curva</b>: contra una curva ajustada a los otros bonos del mismo emisor (sin el que se mide; misma ley si tiene tres), o contra la mediana de sus pares de la misma celda y ley. Positivo es barato; en precio dentro de ±${BANDA_PB} pb o de media punta si las puntas están más abiertas. La primera vara dice si el emisor rinde lo que corresponde a su calidad; la segunda, cuál de sus bonos conviene. <b>Castigados por el mercado</b>: los que perdieron ${-CASTIGO_PAR} puntos de paridad o más en el último mes del tablero (o subieron ${CASTIGO_PB} pb de TIR con al menos 4 puntos de caída) no se leen como baratos: la calidad del modelo sale de balances al 3T26 y una caída así suele descontar algo posterior (deuda nueva, una norma, un evento del emisor). Quedan fuera de la calibración de la curva de calidad. <b>α mercado</b>: qué parte del riesgo país (soberano sobre el Tesoro de EE.UU. a la misma duration, ${E.meta?.tesoro ? `curva par oficial del ${fecha(E.meta.tesoro.fecha)} pasada a efectiva anual: ${E.meta.tesoro.curva.filter(p => [1, 3, 5, 10].includes(p[0])).map(p => `${p[0]} año${p[0] > 1 ? "s" : ""} ${pct(p[1])}`).join(", ")}` : `sin curva, ${pct(TESORO)} plano`}) le cobra el mercado, contra la que supone el modelo de Emisores para su sector. Las amortizables se comparan por duration; en las rescatables la TIR al vencimiento sobreestima (la base no trae las fechas de rescate): con ↓, los bonos sobre la par, cuya TIR caería si el emisor los rescatara a la par en una fecha de pago desde dentro de un año (el período sin rescate habitual); pasa el mouse para ver esa TIR al peor, que es una cota inferior.`),
    tabla("valuacion", filas, cols, { alClick: r => porEm.get(r.em) && fichaEmisor(porEm.get(r.em)), grupo: r => r.em }),
  ];
}

// El color del número dice la zona: verde segura, gris, rojo riesgo (cortes de altman.json).
const zClase = z => z == null ? "" : z > (E.altman?.zonas?.segura ?? 2.6) ? "pos" : z < (E.altman?.zonas?.gris ?? 1.1) ? "neg" : "suave";
const zNombre = { pos: "zona segura", suave: "zona gris", neg: "zona de riesgo" };
const zDeZona = { segura: "pos", gris: "suave", riesgo: "neg" };
const zColor = (z, c = zClase(z)) => z == null ? "—" : `<span class="${c}" title="${zNombre[c]}">${num(z)}</span>`;
const zAltman = a => a ? zColor(a.z, zDeZona[a.zona] || zClase(a.z)) : "—";
const ALTMAN = { X1: "Capital de trabajo / activo (× 6,56)", X2: "Resultados no asignados / activo (× 3,26)", X3: "EBIT 12 meses / activo (× 6,72)", X4: "Patrimonio / pasivo total (× 1,05)" };
function fichaAltman(a) {
  if (!a) return "";
  const pesos = { X1: 6.56, X2: 3.26, X3: 6.72, X4: 1.05 };
  return `<div class="tabla-caja"><table><thead><tr><th>Z'' de Altman · ${zAltman(a)}</th><th class="n">Cociente</th><th class="n">Aporte</th></tr></thead><tbody>${
    Object.entries(ALTMAN).map(([k, t]) => `<tr><td>${esc(t)}</td><td class="n">${num(a[k], 3)}</td><td class="n">${num(a[k] * pesos[k], 2)}</td></tr>`).join("")
  }</tbody></table></div><p class="nota">Balance ${esc(a.corte)}. EBIT de 12 meses aproximado: EBITDA de 12 meses menos amortizaciones anualizadas. En estados argentinos los resultados no asignados pasan a reservas en cada asamblea, así que X2 sale corto y el Z'' es conservador.</p>`;
}

// banderas internas del modelo: van como nota, no como fila
const BANDERAS = { estimado: "spread estimado", "TIR lejana": "TIR de un bono lejano", "TIR equivalente": "TIR de un bono equivalente", "Spread externo": "spread de fuente externa" };
const EN_PCT = /^(PD|TIR|Spread soberano|Dif\.|P iliquidez|P sin mercado)/;
function valorFicha(k, v) {
  if (v == null || v === "") return `<span class="suave">n/d</span>`;
  if (typeof v !== "number") return esc(v);
  if (EN_PCT.test(k)) return k.startsWith("Dif.") ? `${pb(v * 1e4)} pb` : pct(v);
  if (k === "Spread") return `${pb(v)} pb`;
  if (k.includes("/") || k === "Cobertura ONs") return `${num(v, 2)}x`;
  return num(v, Math.abs(v) < 10 ? 2 : 1);
}
function fichaEmisor(x) {
  const dlg = $("#ficha");
  const fila = o => Object.entries(o).filter(([k]) => !(k in BANDERAS)).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${valorFicha(k, v)}</td></tr>`).join("");
  const banderas = Object.keys(BANDERAS).filter(k => x.metricas[k] === true).map(k => BANDERAS[k]);
  const sinEbitda = x.metricas["EBITDA LTM"] == null;
  const aviso = sinEbitda ? `<p class="nota aviso">Sin EBITDA ${x.sector === "Financieras" ? "(financiera)" : ""}: cobertura, caja después de invertir, liquidez, promedio y TIR exigida no se calculan con este modelo.</p>` : "";
  const pricing = Object.keys(x.pricing).length ? `<div class="tabla-caja"><table><thead><tr><th>Pricing</th><th class="n">Valor</th></tr></thead><tbody>${fila(x.pricing)}</tbody></table></div>`
    : `<p class="nota">Sin pricing: el modelo necesita EBITDA para valuar los activos. TIR de mercado ${valorFicha("TIR", x.metricas["TIR mercado"])}.</p>`;
  dlg.innerHTML = `<div class="dlg"><div class="cab-ficha"><div><h3>${esc(x.em)}</h3><div class="suave">${esc(x.sector)} · corte ${esc(x.corte || "")}</div></div><button class="btn chico" data-cerrar type="button">Cerrar</button></div>
    ${aviso}
    <div class="datos">${Object.entries(x.cualidades).map(([k, v]) => dato(esc(k), v == null ? "n/d" : num(v, 0))).join("")}</div>
    ${pricing}
    ${fichaAltman(x.altman)}
    ${fichaCredito(x)}
    <div class="tabla-caja"><table><thead><tr><th>Métrica</th><th class="n">Valor</th></tr></thead><tbody>${fila(x.metricas)}</tbody></table></div>
    ${banderas.length ? `<p class="nota">Ojo: ${banderas.join(" · ")}.</p>` : ""}
    ${(x.estimados || []).map(t => `<p class="nota aviso"><span class="aprox">≈</span> ${esc(t)}</p>`).join("")}</div>`;
  dlg.querySelector("[data-cerrar]").onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
}

// ---------- carteras modelo ----------
// Definición fija en docs/data/carteras.json (bonos y pesos); los números se recalculan acá: punta vendedora en vivo
// de la línea en la que cobra cada bono (D = MEP, C = cable) y, sin puntas, el cierre de BYMA.
// la base trae a veces la escala local junto a la global ("AA+/B-"): queda solo la global
const global = s => (s || "").split("/").map(x => x.trim()).filter(x => x && !/^A/.test(x)).join(" / ");
async function pCarteras() {
  const el = $("#p-carteras");
  if (!E.carteras || !E.emisores || !E.altman) {
    el.innerHTML = `<p class="nota">Cargando carteras…</p>`;
    try {
      const leer = n => fetch(`data/${n}.json`, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(n); return r.json(); });
      [E.carteras, E.emisores, E.altman] = await Promise.all([E.carteras || leer("carteras"), E.emisores || leer("emisores"), E.altman || leer("altman")]);
    } catch (e) { el.innerHTML = `<p class="nota neg">No se pudo cargar data/${esc(e.message)}.json.</p>`; return; }
    if (actual !== "carteras") return;
  }
  const d = E.carteras, porTk = new Map(E.ons.map(b => [b.tk, b])), cal = E.emisores.emisores, alt = E.altman.emisores;
  const DEF = { monto: "100000", estructura: "bullet", arrastre: "100", objetivo: "", fecha: "", piso: "" };
  const SECTOR = { "O&G": "Petróleo y gas", Utilities: "Generación y distribución", Telco: "Telecomunicaciones" };
  const leerMonto = s => +String(s ?? "").replace(/\./g, "").replace(",", ".") || 0, leerTasa = s => +String(s ?? "").replace(",", ".") || 0;
  const f = filtro("carteras", DEF), monto = leerMonto(f.monto);
  const est = ["barbell", "escalera"].includes(f.estructura) ? f.estructura : "bullet";
  const arrastre = String(f.arrastre ?? "").trim() === "" ? 100 : leerTasa(f.arrastre);
  const barra = barraFiltros("carteras", DEF,
    `<label class="campo">Estructura<select name="estructura"><option value="bullet">Bullet</option><option value="barbell">Barbell</option><option value="escalera">Escalera</option></select></label>
     <label class="campo">Monto a simular (US$)<input name="monto" type="text" inputmode="decimal" placeholder="100000"></label>
     <label class="campo" title="Supuesto declarado, no estimado: cuántos pb se mueve el riesgo país por cada 100 pb que se mueve el Tesoro">Arrastre del riesgo país (pb por 100 del Tesoro)<input name="arrastre" type="text" inputmode="decimal" placeholder="100"></label>
     <label class="campo">Objetivo a cubrir (US$)<input name="objetivo" type="text" inputmode="decimal" placeholder="p. ej. 50000"></label>
     <label class="campo">Fecha del objetivo<input name="fecha" type="date"></label>
     <label class="campo" title="Inmunización contingente: la TIR mínima que se quiere asegurar">Tasa piso (%)<input name="piso" type="text" inputmode="decimal" placeholder="opcional"></label>`);
  // una variante con sus números
  // TIR en las dos escalas: cable (la guía internacional, comparable con el Tesoro) y MEP
  const cj = canjeMercado();
  const tirMep = (b, r, e) => {
    if (b.cobra !== "CCL") return r.t;
    const d = enVivo(b, "D") || deCierre(b, "D");
    if (d?.ask && d.flujos?.length) return tir(d.flujos, d.ask);
    return cj && e?.px && r.fl?.length ? tir(r.fl, e.px * (1 + cj.c)) : null;
  };
  // precio y flujos de cada escala, para la TIR de la cartera con los flujos juntos
  const enMep = (b, r, e) => {
    if (b.cobra !== "CCL") return { px: r.px, fl: r.fl };
    const d = enVivo(b, "D") || deCierre(b, "D");
    if (d?.ask && d.flujos?.length) return { px: d.ask, fl: d.flujos };
    return cj && e?.px ? { px: e.px * (1 + cj.c), fl: r.fl } : null;
  };
  const dosTir = (b, r) => {
    const e = enCable(b, cj), ok = t => t != null && !dudosa(t) ? t : null;
    const m = conMedioCanje(e, cj);
    return { tC: ok(e.t), tM: ok(tirMep(b, r, e)), viaC: e.via, tCmedio: m != null && !dudosa(m) ? m : null, pfC: e.px && e.fl?.length ? { px: e.px, fl: e.fl } : null, pfM: enMep(b, r, e) };
  };
  // TIR de la cartera: se invierte el peso de cada bono a su precio, se suman sus flujos día por día y se saca una sola TIR.
  // Es la tasa que rinde la plata de la cartera; el promedio por peso de las TIR es solo una aproximación (pesa igual un
  // bono que devuelve en meses que uno que paga por años).
  const tirCartera = (filas, k) => {
    const con = filas.filter(r => r[k]?.px > 0 && r[k].fl?.length), W = con.reduce((s, r) => s + r.peso, 0);
    if (!W) return null;
    const por = new Map();
    for (const r of con) {
      const n = 100 * r.peso / W / r[k].px;
      for (const [dd, c, x, a] of r[k].fl) { const q = por.get(dd) || [dd, 0, 0, 0]; q[1] += c * n; q[2] += x * n; q[3] += (a || 0) * n; por.set(dd, q); }
    }
    const t = tir([...por.values()].sort((p, q) => p[0] - q[0]), 100);
    return t == null || dudosa(t) ? null : { t, cubre: W };
  };
  const armar = bonos => {
    const filas = bonos.map(x => {
      const b = porTk.get(x.tk);
      if (!b) return { ...x, falta: true };
      const r = cotizar(b), { px, t, dm, fl, vivo } = r;
      return { ...x, b, px, t, dm, fl, vivo, ...dosTir(b, r), q: cal[x.em]?.cualidades?.Promedio,
        cx: fl.length && t != null && !dudosa(t) ? convexidad(fl, t) : null,
        ley: b.isin?.startsWith("AR") ? "ARG" : "NY", cc: b.cupon != null && px > 0 ? b.cupon * 100 / px : null,
        z: alt[x.em]?.z, zona: alt[x.em]?.zona,
        sec: SECTOR[cal[x.em]?.sector] || cal[x.em]?.sector || "—", ing: d.ingresos?.[x.em] || "—",
        dias: monto > 0 && b.vol > 0 ? monto * x.peso / 100 / (0.2 * b.vol) : null };
    });
    const ok = filas.filter(r => !r.falta), P = ok.reduce((s, r) => s + r.peso, 0) || 1;
    const prom = k => { const z = ok.filter(r => r[k] != null && isFinite(r[k]) && !(k === "t" && dudosa(r[k]))), w = z.reduce((s, r) => s + r.peso, 0); return w ? z.reduce((s, r) => s + r.peso * r[k], 0) / w : null; };
    const parte = g => ok.filter(g).reduce((s, r) => s + r.peso, 0) / P;
    const pC = tirCartera(ok, "pfC"), pM = tirCartera(ok, "pfM");
    return { filas, t: prom("t"), tC: pC?.t ?? prom("tC"), tM: pM?.t ?? prom("tM"), tCprom: prom("tC"), tMprom: prom("tM"), cubreC: pC ? pC.cubre / P : 0, dm: prom("dm"), cx: prom("cx"), cc: prom("cc"), q: prom("q"), z: prom("z"),
      zriesgo: parte(r => r.zona === "riesgo"),
      ny: parte(r => r.ley === "NY"), cable: parte(r => r.b.cobra === "CCL"), corto: parte(r => r.dm != null && r.dm < 1.5),
      dol: parte(r => r.ing === "dólares"), pesos: parte(r => r.ing === "pesos"),
      sectores: Object.entries(ok.reduce((m, r) => (m[r.sec] = (m[r.sec] || 0) + r.peso / P, m), {})).sort((a, b) => b[1] - a[1]),
      lento: ok.filter(r => r.dias != null).sort((a, b) => b.dias - a.dias)[0] };
  };
  // escalera: un bono por año de vencimiento con los emisores del perfil, el más barato contra su calidad (vs. calidad de
  // Emisores, en pb) de cada año, tope 25% por emisor; sin valuación ese año, el de mayor TIR en cable. Castigados, afuera.
  let ctxV = null;
  const valDe = b => { try { ctxV ||= contextoValuacion(E.emisores); const v = valorar({ b }, ctxV); return v.motivo ? null : v; } catch { return null; } };
  const ESCALONES = { defensiva: [2027, 2030], conservadora: [2027, 2032], moderada: [2027, 2034], arriesgada: [2027, 2036] };
  const escalera = c => {
    const [a, z] = ESCALONES[c.id] || [2027, 2032];
    const ems = new Set(Object.values(c.variantes).flatMap(v => v.bonos.map(x => x.em)));
    const cand = E.ons.map(b => ({ b, em: codigoEm(b.emisor), anio: +(b.vencimiento || "").slice(0, 4), ...cotizar(b), tc: enCable(b, cj).t }))
      .filter(r => ems.has(r.em) && r.anio >= a && r.anio <= z && r.fl.length && r.t != null && !dudosa(r.t) && r.b.vol >= VOL_MIN && !castigado(r.b))
      .map(r => ({ ...r, rv: valDe(r.b)?.vsCal ?? null }));
    const orden = (p, q) => (q.rv != null) - (p.rv != null) || (q.rv ?? 0) - (p.rv ?? 0) || (q.tc ?? q.t) - (p.tc ?? p.t);
    const anios = [...new Set(cand.map(r => r.anio))].sort(), tope = Math.max(1, Math.floor(anios.length / 4 + 1e-9)), uso = {}, bonos = [];
    for (const y of anios) {
      const r = cand.filter(r => r.anio === y && (uso[r.em] || 0) < tope).sort(orden)[0];
      if (r) { uso[r.em] = (uso[r.em] || 0) + 1; bonos.push({ tk: r.b.tk, em: r.em }); }
    }
    const anios2 = bonos.map(x => porTk.get(x.tk).vencimiento.slice(0, 4));
    return { bonos: bonos.map(x => ({ ...x, peso: 100 / bonos.length })),
      lectura: bonos.length ? `Escalera armada sola con los emisores de este perfil: un bono por año de ${anios2[0]} a ${anios2.at(-1)}, el más barato contra su calidad de cada año (el que más rinde por encima de lo que el mercado paga en cable por un emisor de su calidad, su ley y su duration; si ese año ninguno tiene valuación, el de mayor TIR en cable) entre los que operan al menos US$ 20 k por día y no vienen castigados por el mercado, con el mismo peso (${num(100 / bonos.length, 1)}%) y tope de 25% por emisor. Cada año vence un escalón y se reinvierte en el más largo: no apuesta a la forma de la curva y reparte el riesgo de reinversión en el tiempo.` : "No hay bonos para armar la escalera en este rango de años." };
  };
  // escenarios: la TIR de una ON es Tesoro + riesgo país + spread propio. El Tesoro mueve al riesgo país (arrastre, supuesto
  // declarado) y el riesgo país tiene choques propios; en estrés la curva argentina se invierte (el corto sube más).
  const pendiente = dm => Math.min(1, Math.max(0, ((dm ?? 0) - 1) / 6));   // 0 en DM 1 o menos, 1 en DM 7 o más
  const ESCENARIOS = [
    ["Tesoro +100 pb, sin arrastre", () => 0.01],
    [`Tesoro +100 pb y riesgo país +${num(arrastre, 0)} pb de arrastre`, () => 0.01 + arrastre / 1e4],
    [`Tesoro −100 pb y riesgo país −${num(arrastre, 0)} pb`, () => -0.01 - arrastre / 1e4],
    ["Tesoro se empina: corto −50, largo +50", dm => -0.005 + 0.01 * pendiente(dm)],
    ["Tesoro se aplana: corto +50, largo −50", dm => 0.005 - 0.01 * pendiente(dm)],
    ["Riesgo país +300 con curva invertida: corto +450, largo +200", dm => 0.045 - 0.025 * pendiente(dm)],
    ["Riesgo país −200, comprime más el corto: corto −300, largo −150", dm => -0.03 + 0.015 * pendiente(dm)],
  ];
  const choque = (x, g) => {
    let s = 0, w = 0;
    for (const r of x.filas) {
      if (r.falta || !r.fl?.length || r.t == null || dudosa(r.t)) continue;
      s += r.peso * (vp(r.fl, Math.max(-0.5, r.t + g(r.dm))) / vp(r.fl, r.t) - 1); w += r.peso;
    }
    return w ? s / w : null;
  };
  const cols = [
    { k: "em", t: "Emisor", f: r => `<span class="tk">${esc(r.em)}</span>`, v: r => r.em },
    { k: "tk", t: "ON", f: r => r.falta ? `${esc(r.tk)} <span class="aviso" title="No está en la base de hoy">⚠</span>` : esc(r.tk), v: r => r.tk },
    { k: "peso", t: "Peso", n: 1, f: r => `${num(r.peso, r.peso % 1 ? 1 : 0)}%`, v: r => r.peso },
    { k: "z", t: "Z''", n: 1, titulo: "Z'' de Altman del emisor: verde más de 2,6 (zona segura), gris de 1,1 a 2,6, rojo menos de 1,1 (crédito de riesgo)", f: r => zAltman(alt[r.em]), v: r => r.z },
    { k: "sec", t: "Sector", cls: "ocultar-movil", f: r => esc(r.sec || "—"), v: r => r.sec },
    { k: "ing", t: "Ingresos", cls: "ocultar-movil", titulo: "Moneda de los ingresos del emisor (lectura de CEREBRO)", f: r => esc(r.ing || "—"), v: r => r.ing },
    { k: "q", t: "Calidad", n: 1, titulo: "Promedio de cualidades del emisor (pestaña Emisores)", f: r => num(r.q, 0), v: r => r.q },
    { k: "ley", t: "Ley", f: r => r.falta ? "—" : esc(r.ley), v: r => r.ley },
    { k: "cobra", t: "Cobra", f: r => r.falta ? "—" : esc(r.b.cobra === "CCL" ? "cable" : "MEP"), v: r => r.b?.cobra },
    { k: "vto", t: "Vence", cls: "ocultar-movil", f: r => r.falta ? "—" : fecha(r.b.vencimiento), v: r => r.b?.vencimiento },
    { k: "px", t: "Precio", n: 1, f: r => r.falta ? "—" : `${num(r.px)}${r.vivo ? "" : ' <small class="suave">cierre</small>'}`, v: r => r.px },
    { k: "tC", t: "TIR cable", n: 1, titulo: "TIR en cable: precio de la línea C si opera; si no, el de MEP pasado a cable con el canje (*)", f: r => r.falta ? "—" : r.tC == null ? (r.dm != null && r.dm < 0.5 ? '<span title="Vence muy pronto: el canje pasado a tasa anual da un número sin sentido; queda fuera del promedio en cable">—</span>' : "—") : (r.tCmedio != null ? `<span title="Sale del canje de ${pct(cj.c, 1)}. Con el canje a la mitad, ${pct(r.tCmedio)}">${pct(r.tC)}*</span>` : pct(r.tC) + (r.viaC === "canje" || r.viaC === "canje cable" ? "*" : "")), v: r => r.tC },
    { k: "tM", t: "TIR MEP", n: 1, titulo: "TIR en MEP: la de la línea D; para los que cobran cable, su precio en MEP", f: r => r.falta ? "—" : pct(r.tM), v: r => r.tM },
    { k: "dm", t: "DM", n: 1, f: r => r.falta ? "—" : num(r.dm), v: r => r.dm },
    { k: "cx", t: "Convex.", n: 1, cls: "ocultar-movil", titulo: "Convexidad en años²", f: r => num(r.cx, 1), v: r => r.cx },
    { k: "cc", t: "Cupón corr.", n: 1, cls: "ocultar-movil", titulo: "Cupón anual sobre el precio", f: r => pct(r.cc), v: r => r.cc },
    { k: "cal", t: "Rating", cls: "ocultar-movil", titulo: "Solo escala global (la escala local AA o AAA no se muestra)", f: r => esc(global(r.b?.calificacion) || "—"), v: r => global(r.b?.calificacion) },
    { k: "vol", t: "Vol. diario", n: 1, cls: "ocultar-movil", titulo: "Volumen diario promedio en US$ (BYMA)", f: r => r.falta || !(r.b.vol > 0) ? "—" : num(r.b.vol / 1e3, 0) + " k", v: r => r.b?.vol },
    ...(monto > 0 ? [{ k: "dias", t: "Días", n: 1, titulo: "Días para armar la posición sin pasar del 20% del volumen diario", f: r => r.dias == null ? "—" : num(r.dias, 1), v: r => r.dias }] : []),
    ...(monto > 0 ? [{ k: "vn", t: "VN aprox.", n: 1, titulo: "Valor nominal para el monto simulado, al precio de la tabla, sin comisiones ni lámina", f: r => r.falta || !(r.px > 0) ? "—" : num(monto * r.peso / 100 / (r.px / 100), 0), v: r => r.px > 0 ? r.peso / r.px : null }] : []),
  ];
  const NOMBRE = { bullet: "Bullet", barbell: "Barbell", escalera: "Escalera" }, EST = ["bullet", "barbell", "escalera"];
  const bloques = d.carteras.map(c => {
    const esca = escalera(c);
    const V = { ...Object.fromEntries(Object.entries(c.variantes).map(([k, v]) => [k, armar(v.bonos)])), escalera: armar(esca.bonos) }, x = V[est];
    const lectura = est === "escalera" ? esca.lectura : c.variantes[est].lectura;
    const fila = k => `<tr${k === est ? ' class="ord"' : ""}><td><b>${NOMBRE[k]}</b></td><td class="n">${pct(V[k].tC)}</td><td class="n">${pct(V[k].tM)}</td><td class="n">${num(V[k].dm)}</td><td class="n">${num(V[k].cx, 1)}</td><td class="n">${num(V[k].q, 0)}</td><td class="n">${pct(V[k].corto, 0)}</td></tr>`;
    const dif = V.barbell.t != null && V.bullet.t != null ? (V.barbell.t - V.bullet.t) * 1e4 : null;
    // escenarios: cambio de precio instantáneo, revaluando los flujos de cada bono
    const R = ESCENARIOS.map(([t, g]) => [t, Object.fromEntries(EST.map(k => [k, choque(V[k], g)]))]);
    const gana = o => { const m = EST.filter(k => o[k] != null).sort((a, b) => o[b] - o[a]); return m.length ? NOMBRE[m[0]] : "—"; };
    const celda = v => v == null ? "—" : `<span class="${v >= 0 ? "pos" : "neg"}">${pct(v)}</span>${monto > 0 ? ` <small class="suave">${v >= 0 ? "+" : "−"}US$ ${num(Math.abs(v) * monto, 0)}</small>` : ""}`;
    const bb = (i) => R[i][1].bullet != null && R[i][1].barbell != null ? (R[i][1].bullet > R[i][1].barbell ? "bullet" : "barbell") : null;
    const emp = bb(3), apl = bb(4), est5 = bb(5);
    const teoria = `Teoría (C11, láminas 34 a 36): el bullet gana si la curva se empina y el barbell si se aplana o en movimientos paralelos grandes, por su convexidad. Con estos bonos: en el empinamiento gana el <b>${emp || "—"}</b>${emp === "bullet" ? ", como dice la teoría" : emp ? ", al revés de la teoría" : ""}; en el aplanamiento gana el <b>${apl || "—"}</b>${apl === "barbell" ? ", como dice la teoría" : apl ? ", al revés de la teoría" : ""}. En los paralelos manda la diferencia de duration (${num(V.bullet.dm)} contra ${num(V.barbell.dm)}) más que la convexidad. El riesgo país no se mueve como el Tesoro: en estrés la curva argentina se invierte (el corto sube más que el largo), que es un aplanamiento brusco, y ahí gana el <b>${est5 || "—"}</b>${est5 === "barbell" ? ": el ala corta sufre, pero el ala larga sube menos de TIR y la convexidad compensa" : est5 ? ": el ala corta del barbell absorbe la suba más fuerte" : ""}; en la compresión pasa lo contrario.`;
    const caja = document.createElement("section");
    caja.className = "tarjeta";
    caja.innerHTML = `<h4>${esc(c.nombre)} · ${esc(c.objetivo)} · ${NOMBRE[est]}</h4>
      <div class="resumen">${grupo("Rendimiento", [
          ["TIR cable", `<span title="TIR de los flujos juntos de la cartera. Promedio por peso de las TIR: ${pct(x.tCprom)}">${pct(x.tC)}</span>`, 1],
          ["TIR MEP", `<span title="TIR de los flujos juntos de la cartera. Promedio por peso de las TIR: ${pct(x.tMprom)}">${pct(x.tM)}</span>`, 1],
          ["Cupón corriente", pct(x.cc)]])}${grupo("Tasa y liquidez", [
          ["Duration modificada", num(x.dm)],
          ["Convexidad", num(x.cx, 1)],
          ...(x.lento ? [["Posición más lenta", `<span title="Días de volumen para desarmarla">${esc(x.lento.tk)} · ${num(x.lento.dias, 1)} d</span>`]] : [])])}${grupo("Crédito", [
          ["Calidad promedio", num(x.q, 0)],
          ["Z'' ponderado", zColor(x.z)],
          ["En zona de riesgo", pct(x.zriesgo, 0)]])}${grupo("Moneda y ley", [
          ["Ley NY", pct(x.ny, 0)],
          ["Cobra en cable", pct(x.cable, 0)],
          ["Ingresos en dólares", pct(x.dol, 0)],
          ["Ingresos en pesos", pct(x.pesos, 0)]])}</div>
      <p class="nota">${esc(lectura)}</p>
      <p class="nota">Por sector: ${x.sectores.map(([k, w]) => `${esc(k)} ${pct(w, 0)}`).join(" · ")}.</p>
      <div class="tabla-caja"><table><thead><tr><th>Estructura</th><th class="n">TIR cable</th><th class="n">TIR MEP</th><th class="n">DM</th><th class="n">Convex.</th><th class="n">Calidad</th><th class="n" title="Peso en bonos de duration menor a 1,5">Corto</th></tr></thead><tbody>${EST.map(fila).join("")}</tbody></table></div>
      ${dif == null ? "" : `<p class="nota">El barbell rinde <b>${num(Math.abs(dif), 0)} pb ${dif < 0 ? "menos" : "más"}</b> de TIR que el bullet con ${num(V.barbell.dm)} contra ${num(V.bullet.dm)} de duration, a cambio de ${num(V.barbell.cx - V.bullet.cx, 1)} de convexidad ${V.barbell.cx >= V.bullet.cx ? "extra" : "(menos)"}.${V.barbell.q != null && V.bullet.q != null && Math.abs(V.barbell.q - V.bullet.q) >= 2 ? ` La calidad promedio también cambia (${num(V.barbell.q, 0)} contra ${num(V.bullet.q, 0)}): parte de esa diferencia es riesgo de crédito, no solo convexidad.` : ""}</p>`}
      <div class="tabla-caja"><table><thead><tr><th>Escenario de tasas · cambio de precio</th>${EST.map(k => `<th class="n">${NOMBRE[k]}</th>`).join("")}<th>Pierde menos o gana más</th></tr></thead><tbody>${
        R.map(([t, o]) => `<tr><td>${esc(t)}</td>${EST.map(k => `<td class="n">${celda(o[k])}</td>`).join("")}<td>${gana(o)}</td></tr>`).join("")
      }</tbody></table></div>
      <p class="nota">${teoria}</p>`;
    caja.append(tabla("cartera-" + c.id + "-" + est, x.filas, cols));
    return caja;
  });
  el.replaceChildren(barra,
    nota(`Armadas el ${fecha(d.armado)} · ${esc(d.reglas)} ${esc(d.base)} La TIR de la cartera sale de juntar los flujos de todos sus bonos (el peso de cada uno invertido a su precio) y sacar una sola TIR: es lo que rinde la plata, no el promedio de las tasas (pasa el mouse sobre la TIR para ver ese promedio). Va en las dos escalas: en cable, que es la guía internacional y la que se compara con el Tesoro, y en MEP. Cada bono usa el precio de la línea donde se mide si opera; si no, se pasa con el canje (${cj ? pct(cj.c, 1) + (cj.fuente === "vivo" ? ", de las puntas" : ", del cierre") : "sin canje"}) con los mismos flujos, que es una estimación: supone que el canje no cambia hasta cada pago. Con asterisco, la TIR cable que sale del canje; pasa el mouse para ver cuánto daría con el canje a la mitad, que es la sensibilidad de esa estimación. Es la convención de la línea C: el precio en cable con los flujos nominales, así que en un bono corto el canje pesa mucho en la tasa anual: en la tabla los que vencen en menos de medio año no muestran TIR cable, y en la TIR de la cartera pesan por su plazo y no por esa tasa.`),
    nota(esc(d.estructuras)),
    nota(`${esc(d.lectura_sector || "")} ${esc(d.lectura_ingresos || "")} ${esc(d.liquidez || "")}`),
    nota(esc(d.lectura_altman || "")),
    nota(`Escenarios de tasas: la TIR de una ON hard dollar es la tasa del Tesoro de Estados Unidos más el riesgo país más el spread propio del emisor. Un movimiento del Tesoro llega dos veces: directo y por el riesgo país, que tiende a ampliarse cuando sube la tasa de Estados Unidos y a comprimirse cuando baja. El arrastre (${num(arrastre, 0)} pb de riesgo país por cada 100 pb del Tesoro) es un supuesto declarado, no una estimación: cámbialo arriba. Cada bono se revalúa con sus flujos a la TIR nueva; el cambio es instantáneo, sin el cupón que se cobra mientras tanto ni cambios en el spread propio del emisor.`),
    calce(),
    ...bloques,
    nota(`<b>${esc(d.aviso)}</b>`));

  // calce por objetivo (C11): inmunización con dos bonos del primer escalón cuya duration de Macaulay promedio iguala el plazo,
  // contra el calce de flujos con un solo bono que vence antes de la fecha; con tasa piso, el colchón de la inmunización contingente
  function calce() {
    const caja = document.createElement("section");
    caja.className = "tarjeta";
    const obj = leerMonto(f.objetivo), H = f.fecha ? dias(E.liq, f.fecha) / 365 : null;
    if (!(obj > 0) || !(H > 0.25)) {
      caja.innerHTML = `<h4>Calce por objetivo</h4><p class="nota">Escribe arriba un objetivo en dólares y una fecha (a más de tres meses) para armar la cobertura con ONs de los emisores de las carteras defensiva y conservadora: inmunización (duration igual al plazo), calce de flujos y, con tasa piso, inmunización contingente.</p>`;
      return caja;
    }
    const ems = new Set(d.carteras.filter(c => ["defensiva", "conservadora"].includes(c.id)).flatMap(c => Object.values(c.variantes).flatMap(v => v.bonos.map(x => x.em))));
    const cand = E.ons.map(b => { const r = cotizar(b); return { b, em: codigoEm(b.emisor), ...r, D: r.fl.length && r.t != null && !dudosa(r.t) && r.px > 0 ? duration(r.fl, r.t).macaulay : null }; })
      .filter(r => ems.has(r.em) && r.D != null && r.b.vol >= VOL_MIN);
    // las dos patas de emisores distintos, para no poner todo el objetivo en un solo crédito
    const A = cand.filter(r => r.D <= H).sort((p, q) => q.D - p.D)[0], B = cand.filter(r => r.D > H && r.em !== A?.em).sort((p, q) => p.D - q.D)[0];
    const pata = A && B ? [[A, (B.D - H) / (B.D - A.D)], [B, (H - A.D) / (B.D - A.D)]] : [[A || B, 1]];
    if (!pata[0][0]) { caja.innerHTML = `<h4>Calce por objetivo</h4><p class="nota">No hay ONs del primer escalón con flujos para ese plazo.</p>`; return caja; }
    const y = pata.reduce((s, [r, w]) => s + w * r.t, 0), D = pata.reduce((s, [r, w]) => s + w * r.D, 0), C = obj / (1 + y) ** H;
    const filas = pata.map(([r, w]) => `<tr><td><span class="tk">${esc(r.em)}</span> ${esc(r.b.tk)}</td><td>${fecha(r.b.vencimiento)}</td><td class="n">${num(r.D)}</td><td class="n">${TIRV(r.t)}</td><td class="n">${pct(w, 0)}</td><td class="n">${num(C * w, 0)}</td><td class="n">${num(C * w / (r.px / 100), 0)}</td></tr>`).join("");
    // calce de flujos: el bono del primer escalón que vence más cerca antes de la fecha, cupones guardados sin reinvertir
    const M = cand.filter(r => r.b.vencimiento && r.b.vencimiento <= f.fecha).sort((p, q) => q.b.vencimiento.localeCompare(p.b.vencimiento))[0];
    const cobra = M ? M.fl.reduce((s, x) => s + x[1] + x[2] + x[3], 0) : null, vnM = M ? obj / (cobra / 100) : null, costoM = M ? vnM * M.px / 100 : null;
    const piso = leerTasa(f.piso) / 100;
    const cont = piso > 0 ? (piso < y ? `<p class="nota"><b>Inmunización contingente</b> con piso de ${pct(piso)}: con ${num(C, 0)} invertidos, el piso asegura ${num(C * (1 + piso) ** H, 0)} al ${fecha(f.fecha)}. Hoy alcanzaría con ${num(C * ((1 + piso) / (1 + y)) ** H, 0)} inmunizados para llegar a ese piso, así que hay un colchón de <b>US$ ${num(C * (1 - ((1 + piso) / (1 + y)) ** H), 0)}</b> (${pct(1 - ((1 + piso) / (1 + y)) ** H, 1)} del capital) para gestionar en forma activa. El gatillo: si el valor de la cartera cae hasta el valor presente del piso a las tasas de ese momento, se pasa a inmunizar lo que queda.</p>`
      : `<p class="nota aviso">La tasa piso (${pct(piso)}) es igual o mayor que la TIR del calce (${pct(y)}): no hay colchón para gestión activa.</p>`) : "";
    caja.innerHTML = `<h4>Calce por objetivo · US$ ${num(obj, 0)} al ${fecha(f.fecha)} (${num(H, 1)} años)</h4>
      <div class="datos">${dato("Hay que invertir hoy", "US$ " + num(C, 0))}${dato("TIR del calce", pct(y))}${dato("Duration de Macaulay", num(D))}${dato("Plazo", num(H, 2) + " años")}</div>
      <div class="tabla-caja"><table><thead><tr><th>Inmunización</th><th>Vence</th><th class="n">D Macaulay</th><th class="n">TIR</th><th class="n">Peso</th><th class="n">US$</th><th class="n">VN aprox.</th></tr></thead><tbody>${filas}</tbody></table></div>
      <p class="nota">Inmunizar es igualar la duration de Macaulay al plazo y el valor presente de lo invertido al del objetivo: si las tasas suben, los bonos valen menos pero los cupones se reinvierten a más, y las dos cosas se compensan en la fecha. Solo cubre movimientos paralelos chicos; con cambios de pendiente o del riesgo país queda riesgo, menor cuanto más cerca del plazo estén las dos patas. La duration baja más lento que el plazo, así que hay que rebalancear con cada cupón o cuando cambian mucho las tasas.${pata.length === 1 ? " Solo hay bonos de un lado del plazo: la duration no queda igual al plazo." : ""}</p>
      ${M ? `<p class="nota"><b>Calce de flujos</b>: ${esc(M.em)} ${esc(M.b.tk)}, que vence el ${fecha(M.b.vencimiento)}, paga ${num(cobra, 1)} por cada 100 de VN entre cupones y capital. Para juntar ${num(obj, 0)} sin reinvertir nada hacen falta ${num(vnM, 0)} de VN, que cuestan hoy <b>US$ ${num(costoM, 0)}</b>, ${num(Math.abs(costoM - C), 0)} ${costoM >= C ? "más" : "menos"} que inmunizar. No tiene riesgo de tasa ni de reinversión; el costo es no cobrar intereses sobre los cupones${M.b.vencimiento < f.fecha ? " y quedar con la caja parada hasta la fecha" : ""}.</p>` : `<p class="nota">Ningún bono del primer escalón vence antes de la fecha: no hay calce de flujos con un solo bono.</p>`}
      ${cont}`;
    return caja;
  }
}

// ---------- navegación ----------
const PANELES = { dolares: pDolares, primaria: pPrimaria, pagos: pPagos, pesos: pPesos, pase: pPase, emisores: pEmisores, carteras: pCarteras };
let actual = "dolares";
function ir(p) {
  if (!PANELES[p]) p = "dolares";   // también las viejas #ons y #soberanos
  actual = p;
  document.querySelectorAll("dialog[open]").forEach(d => d.close());
  document.querySelectorAll(".pestanas button").forEach(b => b.setAttribute("aria-selected", b.dataset.p === p));
  document.querySelectorAll(".panel").forEach(s => s.hidden = s.id !== "p-" + p);
  if (location.hash !== "#" + p) history.replaceState(null, "", "#" + p);
  pintar();
}
function pintar(foco) {
  if (!E.meta) return;
  const pos = foco ? [foco.name, foco.selectionStart] : null;
  PANELES[actual]();
  if (pos) { const c = $(`#p-${actual} [name="${pos[0]}"]`); c?.focus(); c?.setSelectionRange(pos[1], pos[1]); }
}
document.querySelectorAll(".pestanas button").forEach(b => b.onclick = () => ir(b.dataset.p));
$("#btn-vivo").onclick = pedirVivo;
window.addEventListener("hashchange", () => ir(location.hash.slice(1)));
// puntas solas en horario de mercado (10:30 a 17, lun a vie, hora de Buenos Aires) y con la página a la vista.
// data912 sale por una caché de 30 s: se pide 1 s después de que vence la copia actual (last-modified + 30 s)
const AUTO_MS = 20e3, CACHE_D912 = 30e3;
function enHorario() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const m = +p.hour * 60 + +p.minute;
  return !["Sat", "Sun"].includes(p.weekday) && m >= 630 && m <= 1020;
}
function proximaEspera() {
  if (!E.lmD912) return AUTO_MS;
  const t = E.lmD912 + CACHE_D912 + 1e3 - Date.now();
  return t < 2e3 || t > CACHE_D912 + 5e3 ? AUTO_MS : t;
}
async function ciclo() {
  if (!document.hidden && enHorario()) await pedirVivo();
  setTimeout(ciclo, proximaEspera());
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !E.horaVivo) return;
  if (Date.now() - E.horaVivo > (enHorario() ? AUTO_MS : 5 * 60e3)) pedirVivo();
});

cargar().then(async () => { estado(); ir(location.hash.slice(1) || "dolares"); await pedirVivo(); setTimeout(ciclo, proximaEspera()); })
  .catch(e => { $("#estado").innerHTML = `<span class="error">No pude leer los datos (${esc(e.message)})</span>`; });
