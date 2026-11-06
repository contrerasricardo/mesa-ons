// STP (Sales Trader Personal): cierre de BYMA (docs/data, lo regenera la Action cada día hábil) + puntas en vivo de data912 y BYMA Data.
// Comprar se mide a la punta vendedora (ask) y vender a la compradora (bid); para un bono que cobra CCL, la TIR de la
// línea D supone canje cero al cobro. La TIR de cierre nunca se mezcla con el precio vivo.
import { tir, vp, duration, liquidacionHoy, alinear, dias, pase, fijarFeriados, habilDesde, flujosPrimaria, resolver, valorAl, redondearVN, vnValido } from "./calc.js?v=20261106b";
import { crearMotor } from "./pesos.js?v=20261106b";

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
function lineasSob(tk) { return tk.endsWith("D") ? { D: tk, C: tk.slice(0, -1) + "C" } : { D: tk + "D", C: tk + "C" }; }

function normalizar(x, tipo) {
  const lineas = tipo === "on" ? lineasON(x.tk) : tipo === "sob" ? lineasSob(x.tk) : { ARS: x.tk };
  const cobra = tipo === "on" ? x.cobra : tipo === "sob" ? (x.ley === "NY" ? "CCL" : "MEP") : "ARS";
  return { ...x, tipo, lineas, cobra, px: x.cierre.px, ytm: x.cierre.ytm == null ? null : x.cierre.ytm / 100,
    dm: x.cierre.dm, vol: x.cierre.adtv_usd, calculable: ["fix", "cap"].includes(x.tipo_flujos) && x.flujos.length > 0 };
}

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
  const fl = b.calculable ? alinear(b.flujos, b.liq, E.liq) : [];
  const ask = q.px_ask > 0 ? q.px_ask : null, bid = q.px_bid > 0 ? q.px_bid : null;
  const tAsk = fl.length && ask ? tir(fl, ask) : null, tBid = fl.length && bid ? tir(fl, bid) : null;
  return { ask, bid, qAsk: ask ? q.q_ask : null, qBid: bid ? q.q_bid : null, ultimo: q.c || null, tAsk, tBid, vol: q.v, ancho: ask && bid ? ask / bid - 1 : null, fuente: q.fuente,
    dm: tAsk != null ? duration(fl, tAsk).modificada : null, flujos: fl };
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
const BYMA_LIBRE = "https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/";
const conPuntas = q => q && (q.px_bid > 0 || q.px_ask > 0);
function pedirBYMA(panel, ci = false) {
  const cuerpo = { excludeZeroPxAndQty: true, T0: ci, T1: !ci, T2: false, page_number: 1, page_size: 5000, "Content-Type": "application/json" };
  return fetch(BYMA_LIBRE + panel, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo), cache: "no-store" })
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
    Promise.allSettled(d912.map(f => fetch(`https://data912.com/live/${f}`, { cache: "no-store" }).then(x => {
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
    { k: "ask", t: "Compra D", n: 1, f: b => conCant(v(b)?.ask, v(b)?.qAsk), v: b => v(b)?.ask, titulo: "Punta vendedora de la línea D (MEP) y nominales ofrecidos" },
    { k: "tAsk", t: "TIR compra", n: 1, f: b => pct(v(b)?.tAsk), v: b => v(b)?.tAsk },
    { k: "bid", t: "Venta D", n: 1, cls: "ocultar-movil", f: b => conCant(v(b)?.bid, v(b)?.qBid), v: b => v(b)?.bid, titulo: "Punta compradora de la línea D y nominales pedidos" },
    { k: "tBid", t: "TIR venta", n: 1, cls: "ocultar-movil", f: b => pct(v(b)?.tBid), v: b => v(b)?.tBid },
    { k: "ancho", t: "Puntas", n: 1, f: b => { const a = v(b)?.ancho; return a == null ? "—" : `<span class="${a > 0.01 ? "aviso" : ""}">${pct(a)}</span>`; }, v: b => v(b)?.ancho, titulo: "Ancho de puntas D: más de 1% pide orden límite" },
    { k: "volD", t: "Vol. D", n: 1, cls: "ocultar-movil", f: b => num(v(b)?.vol, 0), v: b => v(b)?.vol, titulo: "Nominales operados hoy en la línea D" },
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
    nota(`${filas.length} de ${todos.length} bonos hard dollar · la cifra chica es el nominal a la punta · la línea D de un bono que cobra CCL supone canje cero`),
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
    <div class="tabla-caja"><table><thead><tr><th>Línea</th><th class="n">Compra</th><th class="n">TIR</th><th class="n">Venta</th><th class="n">TIR</th><th class="n">Puntas</th><th class="n">DM</th><th class="n">Vol.</th></tr></thead><tbody>
      ${vivos.map(([l, v]) => `<tr><td>${esc(b.lineas[l])}${v?.fuente === "BYMA" ? ` <span class="etq" title="Sin puntas en data912: puntas de BYMA, con 20 minutos de demora">BYMA</span>` : ""}</td><td class="n">${conCant(v?.ask, v?.qAsk, usd ? 2 : 3)}</td><td class="n">${pct(v?.tAsk)}</td><td class="n">${conCant(v?.bid, v?.qBid, usd ? 2 : 3)}</td><td class="n">${pct(v?.tBid)}</td><td class="n ${v?.ancho > 0.01 ? "aviso" : ""}">${pct(v?.ancho)}</td><td class="n">${num(v?.dm)}</td><td class="n">${num(v?.vol, 0)}</td></tr>`).join("")}
    </tbody></table></div>
    ${b.cobra === "CCL" ? `<p class="nota">Cobra cable: la TIR de la línea D supone canje cero al cobro (piso del comprador en MEP).</p>` : ""}
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
E.pase = { vendo: "", compro: "", linea: "D", pv: "", pc: "", cv: "0.5", cc: "0.5", reinv: "", vn: "10000", ...guardado.leer("pase", {}) };
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
    <h3 class="sub">Pase de monedas</h3>
    <div id="pase-mon"></div>`;
  el.querySelector("[name=linea]").value = P.linea;
  el.querySelectorAll(".form-pase [name]").forEach(c => c.addEventListener("change", () => {
    if (c.name === "lamB" || c.name === "incB") guardarRegla(B, el.querySelector("[name=lamB]").value.trim(), el.querySelector("[name=incB]").value.trim());
    else P[c.name] = c.value.trim();
    if (c.name === "vendo") P.pv = ""; if (c.name === "compro") P.pc = "";
    guardado.escribir("pase", { vendo: P.vendo, compro: P.compro, linea: P.linea, cv: P.cv, cc: P.cc, reinv: P.reinv, vn: P.vn });
    pPase();
  }));
  $("#res-pase").innerHTML = resultadoPase(A, B, vA, vB);
  paseMonedas();
}

const dec = s => s === "" || s == null ? null : +String(s).replace(",", ".");
function resultadoPase(A, B, vA, vB) {
  const P = E.pase;
  if (!A || !B) return `<p class="nota">Elige el bono que vendes y el que compras (ONs y bonos en dólares con flujos de tasa fija). Toca una fila de Dólares para mandarla acá.</p>`;
  const pA = dec(P.pv) ?? vA?.bid, pB = dec(P.pc) ?? vB?.ask;
  if (!pA || !pB) return `<p class="nota aviso">Falta precio: ${!pA ? A.tk + " sin punta compradora" : ""} ${!pB ? B.tk + " sin punta vendedora" : ""} en la línea ${P.linea}. Escríbelo a mano o actualiza las puntas.</p>`;
  const fA = alinear(A.flujos, A.liq, E.liq), fB = alinear(B.flujos, B.liq, E.liq);
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
             TIR de quiebre de ${esc(B.tk)} ese día: <b>${pct(r.tirQuiebre)}</b> → <b class="${bueno ? "pos" : "neg"}">${bueno ? "aguanta" : "ya pierde con"} ${pb(Math.abs(r.ensanchePb))} pb ${bueno ? "de ensanchamiento" : "de compresión necesaria"}</b>.`}
      </div>
      ${nom}
      <p class="nota">Flujos exactos de los dos bonos, cupones reinvertidos al ${pct(reinv)}. Regla rápida: (TIR compra − TIR venta) × vida de ${esc(A.tk)} (${num(r.T / 365, 1)} años) − comisiones = ${pct(rapida)}.</p>
      ${avisos.map(a => `<p class="nota aviso">${esc(a)}</p>`).join("")}
      <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>
    </div>`;
}

// Pase con nominales reales: lo que entra al vender A, el VN de B redondeado a su regla de negociación, lo que sobra en caja
// y los dos cashflows lado a lado, fecha por fecha de cobro.
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
    return `<tr class="${x.d > vtoA ? "suave" : ""}"><td>${fecha(x.d)}</td><td class="n">${x.a ? num(x.a) : "—"}</td><td class="n">${x.b ? num(x.b) : "—"}</td>
      <td class="n ${x.b - x.a > 0 ? "pos" : x.b - x.a < 0 ? "neg" : ""}">${num(x.b - x.a)}</td><td class="n">${num(acA)}</td><td class="n">${num(acB)}</td></tr>`;
  }).join("");
  const hastaA = (fl, vn) => vn / 100 * fl.filter(f => f[0] <= r.T).reduce((s, f) => s + f[1] + f[2] + (f[3] || 0), 0);
  const dif = pasar - quedarse;
  return `
      <div class="datos">
        ${dato(`Vendo ${esc(A.tk)}`, num(vnA, 0) + " VN")}${dato("Neto de la venta", num(neto))}
        ${dato(`Compro ${esc(B.tk)}`, num(vnB, 0) + " VN")}${dato("Costo con comisión", num(costo))}${dato("Sobra en caja", num(sobra))}
        ${dato(`Al ${fecha(vtoA)}`, `<span class="${dif > 0 ? "pos" : "neg"}">${dif > 0 ? "+" : "−"}${num(Math.abs(dif))}</span>`)}
      </div>
      <p class="nota">Reglas: ${esc(A.tk)} ${textoRegla(LA)} · ${esc(B.tk)} ${textoRegla(LB)} (mínimo: ${esc(LB.fuente)}; incremento: ${esc(LB.sinDato ? "sin dato" : LB.incFuente)}). Al ${fecha(vtoA)}: quedarse vale ${num(quedarse)}, pasar ${num(pasar)} (cupones y caja al ${pct(reinv)}${restoB.length ? `, ${esc(B.tk)} a su TIR de hoy` : ""}).</p>
      <details open><summary>Cashflows en dólares, fecha por fecha</summary>
      <div class="tabla-caja"><table><thead><tr><th>Cobro</th><th class="n">${esc(A.tk)}</th><th class="n">${esc(B.tk)}</th><th class="n">${esc(B.tk)} − ${esc(A.tk)}</th><th class="n">Acum. ${esc(A.tk)}</th><th class="n">Acum. ${esc(B.tk)} + caja</th></tr></thead>
      <tbody><tr><td>${fecha(E.liq)} (pase)</td><td class="n">—</td><td class="n">—</td><td class="n">${num(sobra)}</td><td class="n">—</td><td class="n">${num(sobra)}</td></tr>${tb}</tbody>
      <tfoot><tr><td><b>Hasta ${fecha(vtoA)}</b></td><td class="n"><b>${num(hastaA(fA, vnA))}</b></td><td class="n"><b>${num(hastaA(fB, vnB) + sobra)}</b></td><td class="n"><b>${num(hastaA(fB, vnB) + sobra - hastaA(fA, vnA))}</b></td><td></td><td></td></tr></tfoot></table></div>
      <p class="nota">Sin descontar ni reinvertir; en gris, lo que ${esc(B.tk)} paga después del vencimiento de ${esc(A.tk)}. El total de ${esc(B.tk)} incluye la caja que sobra.</p></details>`;
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
  if (!(monto > 0)) return `<p class="nota">Escribe el monto que tienes.</p>`;
  const vn = redondearVN(monto / (pc / 100 * (1 + cc)), { min: 1, inc: 1 });
  if (!vn) return `<p class="nota aviso">Con ${de.sim} ${num(monto)} no alcanza para 1 VN de ${tkC} (${num(pc / 100 * (1 + cc), 3)}).</p>`;
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
      <div class="recibo">Recibes <b class="pos">${num(recibo, 2)} ${a.sim}</b> <span class="suave">netos, por ${num(monto, 2)} ${de.sim} · vendiendo ${num(vn, 0)} VN de ${esc(tkV)}</span></div>
      <div class="datos mon">
        ${dato(`1 ${de.sim} =`, en(tasa, a, M.a === "ARS" ? 2 : M.de === "ARS" ? 6 : 4))}${dato(`1 ${a.sim} =`, en(1 / tasa, de, M.de === "ARS" ? 2 : M.a === "ARS" ? 6 : 4))}${cot}
      </div>
      <div class="datos mon">
        ${dato(`Compro ${esc(tkC)}`, `${num(vn, 0)} <small class="cant">VN a ${num(pc / 100, M.de === "ARS" ? 2 : 4)}</small>`)}${dato("Pago", en(costo, de))}${dato("Sobra", en(sobra, de))}
        ${dato("Comisiones", en(bruto * (cc + cv), a))}
      </div>
      <p class="nota">${esc(tkC)} a ${num(pc, M.de === "ARS" ? 2 : 3)} + ${pct(cc)} · ${esc(tkV)} a ${num(pv, M.a === "ARS" ? 2 : 3)} − ${pct(cv)} · precios por 100 VN, de a 1 VN · pago y recibo con comisión${ars ? "" : "; canje = MEP por cada cable − 1"} · ${esc(fuente)}${dec(M.pc) != null || dec(M.pv) != null ? " (con precio a mano)" : ""}.</p>
      <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>`;
}

// ---------- emisores ----------
const CORTO = { "Solidez de balance": "Balance", "Cobertura de intereses": "Cobertura", "Caja después de invertir": "Caja post-inv.", "Liquidez": "Liquidez", "Lo que dicen los modelos": "Modelos", "Capacidad de pago": "Cap. de pago", "Promedio": "Promedio" };
async function pEmisores() {
  const el = $("#p-emisores");
  if (!E.emisores) {
    el.innerHTML = `<p class="nota">Cargando emisores…</p>`;
    try { E.emisores = await fetch("data/emisores.json", { cache: "no-cache" }).then(r => r.json()); }
    catch { el.innerHTML = `<p class="nota neg">No se pudo cargar data/emisores.json.</p>`; return; }
    if (actual !== "emisores") return;
  }
  const d = E.emisores, filas = Object.entries(d.emisores).map(([em, x]) => ({ em, ...x }));
  const nombres = Object.keys(filas[0]?.cualidades || {});
  const cols = [
    { k: "em", t: "Emisor", f: x => `<span class="tk">${esc(x.em)}</span>${x.inestable ? ' <span class="aviso" title="El orden cambia mucho al sacar una cualidad">⚠</span>' : ""}`, v: x => x.em },
    { k: "sector", t: "Sector", cls: "ocultar-movil", f: x => esc(x.sector), v: x => x.sector },
    { k: "corte", t: "Corte", f: x => x.corte === "3T26" ? `<span class="etq">3T26</span>` : `<span class="suave">${esc(x.corte || d.corte)}</span>`, v: x => x.corte, titulo: "Último trimestre del balance usado" },
    ...nombres.map(q => ({ k: "q:" + q, t: CORTO[q] || q, titulo: q, n: 1, f: x => `<span class="${q === "Promedio" ? "tk" : ""}">${num(x.cualidades[q], 0)}</span>`, v: x => x.cualidades[q] })),
    { k: "exig", t: "TIR exigida", n: 1, f: x => pct(x.pricing["TIR exigida"]), v: x => x.pricing["TIR exigida"], titulo: "Merton + spread soberano" },
    { k: "merc", t: "TIR mercado", n: 1, f: x => pct(x.pricing["TIR mercado"]), v: x => x.pricing["TIR mercado"] },
    { k: "dif", t: "Paga de más", n: 1, f: x => { const v = x.pricing["Dif. mercado - exigida"]; return v == null ? "—" : `<span class="${v > 0 ? "pos" : "neg"}">${pb(v * 1e4)} pb</span>`; }, v: x => x.pricing["Dif. mercado - exigida"], titulo: "TIR de mercado − TIR exigida: positivo = barato" },
    { k: "pd", t: "PD 1 año", n: 1, cls: "ocultar-movil", f: x => pct(x.pricing.PD_1y), v: x => x.pricing.PD_1y },
    { k: "puesto", t: "Puesto", n: 1, f: x => x.puestos ? `${num(x.puestos.base, 0)} <span class="suave">(${num(x.puestos.min, 0)}–${num(x.puestos.max, 0)})</span>` : "—", v: x => x.puestos?.base, titulo: "Puesto base y rango al sacar una cualidad por vez" },
  ];
  if (!E.orden.emisores) E.orden.emisores = { k: "q:Promedio", asc: false };
  el.replaceChildren(
    nota(`${filas.length} emisores · corte ${esc(d.corte)} · horizonte ${num(d.horizonte_anios, 0)} años · orden por calidad (promedio de cualidades), valor en «paga de más»`),
    tabla("emisores", filas, cols, { alClick: fichaEmisor }),
    Object.assign(document.createElement("div"), { className: "lectura", innerHTML: d.lectura_html }));
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
    <div class="tabla-caja"><table><thead><tr><th>Métrica</th><th class="n">Valor</th></tr></thead><tbody>${fila(x.metricas)}</tbody></table></div>
    ${banderas.length ? `<p class="nota">Ojo: ${banderas.join(" · ")}.</p>` : ""}</div>`;
  dlg.querySelector("[data-cerrar]").onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
}

// ---------- navegación ----------
const PANELES = { dolares: pDolares, primaria: pPrimaria, pagos: pPagos, pesos: pPesos, pase: pPase, emisores: pEmisores };
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
