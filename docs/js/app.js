// STP (Sales Trader Personal): cierre de BYMA (docs/data, lo regenera la Action cada día hábil) + puntas en vivo de data912.
// Comprar se mide a la punta vendedora (ask) y vender a la compradora (bid); para un bono que cobra CCL, la TIR de la
// línea D supone canje cero al cobro. La TIR de cierre nunca se mezcla con el precio vivo.
import { tir, duration, liquidacionHoy, alinear, dias, pase } from "./calc.js";
import { descifrar } from "./descifrar.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = (d) => new Intl.NumberFormat("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 2) => v == null || !isFinite(v) ? "—" : nf(d).format(v);
const pct = (v, d = 2) => v == null || !isFinite(v) ? "—" : nf(d).format(100 * v) + "%";
const pb = v => v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + nf(0).format(v);
const fecha = s => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "—";
const mas = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);
const hoyISO = () => new Date().toISOString().slice(0, 10);

const guardado = {
  leer(k, def) { try { const v = localStorage.getItem("mesa." + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  escribir(k, v) { try { v == null ? localStorage.removeItem("mesa." + k) : localStorage.setItem("mesa." + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const E = { meta: null, ons: [], soberanos: [], pesos: [], pagos: [], vivo: new Map(), horaVivo: null, errorVivo: null,
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
  return { ask, bid, ultimo: q.c || null, tAsk, tBid, vol: q.v, ancho: ask && bid ? ask / bid - 1 : null,
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
  E.ons = ons.map(x => normalizar(x, "on"));
  E.soberanos = sob.map(x => normalizar(x, "sob"));
  E.pesos = pesos.map(x => normalizar(x, "ars"));
  E.pagos = pagos;
}

async function pedirVivo() {
  const fuentes = ["arg_corp", "arg_bonds", "arg_notes"];
  $("#btn-vivo").disabled = true;
  const r = await Promise.allSettled(fuentes.map(f => fetch(`https://data912.com/live/${f}`, { cache: "no-store" }).then(x => x.json())));
  $("#btn-vivo").disabled = false;
  const ok = r.filter(x => x.status === "fulfilled");
  if (ok.length) {
    E.vivo = new Map(ok.flatMap(x => x.value.map(q => [q.symbol, q])));
    memo.clear();
    E.horaVivo = new Date(); E.errorVivo = ok.length < fuentes.length ? "parcial" : null;
    E.liq = liquidacionHoy();
  } else E.errorVivo = "sin conexión con data912";
  estado(); pintar();
}

function estado() {
  const m = E.meta;
  let s = m ? `Cierre ${fecha(m.cierre)}` : "";
  if (E.horaVivo) s += ` · <span class="vivo">puntas ${E.horaVivo.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</span> · liq. ${fecha(E.liq).slice(0, 5)}`;
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
function colsDolares(conEmisor) {
  return [
    { k: "tk", t: "Ticker", f: b => `<span class="tk">${esc(b.tk)}</span>`, v: b => b.tk },
    ...(conEmisor ? [{ k: "emisor", t: "Emisor", cls: "emisor", f: b => esc(b.emisor), v: b => b.emisor }] : []),
    { k: "ley", t: "Ley", f: b => b.ley, v: b => b.ley },
    { k: "cobra", t: "Cobra", f: b => b.cobra, v: b => b.cobra },
    { k: "vencimiento", t: "Vto.", f: b => fecha(b.vencimiento), v: b => b.vencimiento },
    { k: "cupon", t: "Cupón", n: 1, cls: "ocultar-movil", f: b => pct(b.cupon), v: b => b.cupon },
    { k: "px", t: "Cierre", n: 1, cls: "ocultar-movil", f: b => num(b.px), v: b => b.px },
    { k: "ytm", t: "TIR cierre", n: 1, f: b => pct(b.ytm), v: b => b.ytm, titulo: "TIR de BYMA al cierre" },
    { k: "dm", t: "DM", n: 1, cls: "ocultar-movil", f: b => num(b.dm), v: b => b.dm, titulo: "Duration modificada de BYMA" },
    { k: "ask", t: "Compra D", n: 1, f: b => num(enVivo(b, "D")?.ask), v: b => enVivo(b, "D")?.ask, titulo: "Punta vendedora de la línea D (MEP)" },
    { k: "tAsk", t: "TIR compra", n: 1, f: b => pct(enVivo(b, "D")?.tAsk), v: b => enVivo(b, "D")?.tAsk },
    { k: "tBid", t: "TIR venta", n: 1, cls: "ocultar-movil", f: b => pct(enVivo(b, "D")?.tBid), v: b => enVivo(b, "D")?.tBid },
    { k: "ancho", t: "Puntas", n: 1, f: b => { const a = enVivo(b, "D")?.ancho; return a == null ? "—" : `<span class="${a > 0.01 ? "aviso" : ""}">${pct(a)}</span>`; }, v: b => enVivo(b, "D")?.ancho, titulo: "Ancho de puntas D: más de 1% pide orden límite" },
    { k: "volD", t: "Vol. D", n: 1, cls: "ocultar-movil", f: b => num(enVivo(b, "D")?.vol, 0), v: b => enVivo(b, "D")?.vol, titulo: "Nominales operados hoy en la línea D" },
  ];
}

// ---------- pestañas ----------
function pON() {
  const id = "ons", f = filtro(id, { q: "", ley: "", cobra: "", lista: false, chamo: false, vivo: false });
  const filas = E.ons.filter(b => buscar(f.q, b.tk, b.emisor, b.clase) && (!f.ley || b.ley === f.ley) && (!f.cobra || b.cobra === f.cobra)
    && (!f.lista || enLista(b)) && (!f.chamo || b.chamomberg) && (!f.vivo || enVivo(b, "D")?.ask));
  const el = $("#p-ons"); el.replaceChildren(
    barraFiltros(id, f, `<input type="search" name="q" placeholder="Ticker o emisor">${selLey}${selCobra}${chipLista}
      <label class="chip"><input type="checkbox" name="chamo"> Universo chamomberg</label>
      <label class="chip"><input type="checkbox" name="vivo"> Con punta</label>`),
    nota(`${filas.length} de ${E.ons.length} ONs hard dollar · flujos de BYMA (chamomberg o manuales donde BYMA no los trae) · la línea D de un bono que cobra CCL supone canje cero`),
    tabla(id, filas, colsDolares(true), { alClick: ficha, clase: b => enLista(b) ? "mia" : "", grupo: b => b.emisor }));
}

function pSoberanos() {
  const id = "soberanos", f = filtro(id, { q: "", seg: "", lista: false });
  const filas = E.soberanos.filter(b => buscar(f.q, b.tk, b.emisor, b.clase) && (!f.seg || b.segmento === f.seg) && (!f.lista || enLista(b)));
  const cols = colsDolares(false);
  cols.splice(1, 0, { k: "emisor", t: "Emisor", cls: "emisor", f: b => esc(b.segmento === "sob" ? b.clase : b.emisor), v: b => b.emisor });
  $("#p-soberanos").replaceChildren(
    barraFiltros(id, f, `<input type="search" name="q" placeholder="Ticker o emisor">
      <select name="seg"><option value="">Todos</option><option value="sob">Soberanos</option><option value="pro">Provinciales</option></select>${chipLista}`),
    nota(`${filas.length} bonos en dólares · ley NY cobra cable, ley argentina MEP`),
    tabla(id, filas, cols, { alClick: ficha, clase: b => enLista(b) ? "mia" : "" }));
}

const SEG = { lec: "LECAP / BONCAP", fija: "Tasa fija", cer: "CER", tam: "TAMAR", dua: "Duales" };
const tem = y => y == null ? null : (1 + y) ** (30 / 365) - 1;
function pPesos() {
  const id = "pesos", f = filtro(id, { q: "", seg: "" });
  const filas = E.pesos.filter(b => buscar(f.q, b.tk, b.clase) && (!f.seg || b.segmento === f.seg))
    .sort((a, b) => (Object.keys(SEG).indexOf(a.segmento) - Object.keys(SEG).indexOf(b.segmento)) || a.vencimiento.localeCompare(b.vencimiento));
  const v = b => enVivo(b, "ARS");
  const cols = [
    { k: "tk", t: "Ticker", f: b => `<span class="tk">${esc(b.tk)}</span>`, v: b => b.tk },
    { k: "vencimiento", t: "Vto.", f: b => fecha(b.vencimiento), v: b => b.vencimiento },
    { k: "dias", t: "Días", n: 1, f: b => num(dias(E.liq, b.vencimiento), 0), v: b => b.vencimiento },
    { k: "px", t: "Cierre", n: 1, cls: "ocultar-movil", f: b => num(b.px, 3), v: b => b.px },
    { k: "ytm", t: "TIR cierre", n: 1, f: b => pct(b.ytm), v: b => b.ytm, titulo: "BYMA: en CER es TIR real; en TAMAR y duales, con el supuesto de tasa de BYMA" },
    { k: "tem", t: "TEM cierre", n: 1, f: b => ["lec", "fija"].includes(b.segmento) ? pct(tem(b.ytm)) : "—", v: b => tem(b.ytm) },
    { k: "ask", t: "Compra", n: 1, f: b => num(v(b)?.ask, 3), v: b => v(b)?.ask },
    { k: "tAsk", t: "TIR compra", n: 1, f: b => pct(v(b)?.tAsk), v: b => v(b)?.tAsk, titulo: "Solo tasa fija: el resto necesita proyectar CER o TAMAR" },
    { k: "temAsk", t: "TEM compra", n: 1, f: b => pct(tem(v(b)?.tAsk)), v: b => tem(v(b)?.tAsk) },
    { k: "ancho", t: "Puntas", n: 1, cls: "ocultar-movil", f: b => { const a = v(b)?.ancho; return a == null ? "—" : `<span class="${a > 0.01 ? "aviso" : ""}">${pct(a)}</span>`; }, v: b => v(b)?.ancho },
    { k: "dm", t: "DM", n: 1, cls: "ocultar-movil", f: b => num(b.dm), v: b => b.dm },
  ];
  $("#p-pesos").replaceChildren(
    barraFiltros(id, f, `<input type="search" name="q" placeholder="Ticker"><select name="seg"><option value="">Todos</option>${Object.entries(SEG).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>`),
    nota("TIR en vivo solo para tasa fija (LECAP, BONCAP, bonos a tasa fija). CER: TIR real de BYMA al cierre."),
    tabla(id, filas, cols, { alClick: ficha, grupo: b => SEG[b.segmento] }));
}

function pPagos() {
  const id = "pagos", f = filtro(id, { q: "", h: "90", lista: false, ley: "", cobra: "" });
  const desde = hoyISO(), hasta = f.h ? mas(desde, +f.h) : "9999";
  const porTk = new Map(E.ons.map(b => [b.tk, b]));
  const filas = E.pagos.filter(p => p.fecha >= desde && p.fecha <= hasta && buscar(f.q, p.tk, p.emisor)
    && (!f.ley || p.ley === f.ley) && (!f.cobra || p.cobra === f.cobra) && (!f.lista || (porTk.has(p.tk) && enLista(porTk.get(p.tk)))));
  const mes = p => new Date(p.fecha + "T12:00").toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  const cols = [
    { k: "fecha", t: "Fecha", f: p => fecha(p.fecha), v: p => p.fecha },
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
      ${vivos.map(([l, v]) => `<tr><td>${esc(b.lineas[l])}</td><td class="n">${num(v?.ask, usd ? 2 : 3)}</td><td class="n">${pct(v?.tAsk)}</td><td class="n">${num(v?.bid, usd ? 2 : 3)}</td><td class="n">${pct(v?.tBid)}</td><td class="n ${v?.ancho > 0.01 ? "aviso" : ""}">${pct(v?.ancho)}</td><td class="n">${num(v?.dm)}</td><td class="n">${num(v?.vol, 0)}</td></tr>`).join("")}
    </tbody></table></div>
    ${b.cobra === "CCL" ? `<p class="nota">Cobra cable: la TIR de la línea D supone canje cero al cobro (piso del comprador en MEP).</p>` : ""}
    ${vivos.some(([, v]) => v?.ancho > 0.01) ? `<p class="nota aviso">Puntas de más de 1%: la TIR de la punta no es ejecutable, hace falta orden límite.</p>` : ""}
    <div class="acciones">
      <button class="btn" data-lista type="button">${enLista(b) ? "Quitar de mi lista" : "Agregar a mi lista"}</button>
      ${usd && b.calculable ? `<button class="btn" data-vendo type="button">Vendo en el pase</button><button class="btn" data-compro type="button">Compro en el pase</button>` : ""}
    </div>
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

// ---------- pase ----------
E.pase = { vendo: "", compro: "", linea: "D", pv: "", pc: "", cv: "0.5", cc: "0.5", reinv: "", ...guardado.leer("pase", {}) };
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
        <div class="suave">${A ? esc(A.emisor) + " · vence " + fecha(A.vencimiento) + " · cobra " + A.cobra : ""}</div>
      </div>
      <div class="tarjeta"><h4>Compro</h4>
        <label class="campo">Ticker<input name="compro" list="dl-bonos" autocapitalize="characters" value="${esc(P.compro)}" placeholder="p. ej. TLCPO"></label>
        <label class="campo">Precio (punta vendedora${vB?.ask ? ": " + num(vB.ask) : ""})<input name="pc" inputmode="decimal" value="${esc(P.pc)}" placeholder="${vB?.ask ?? ""}"></label>
        <div class="suave">${B ? esc(B.emisor) + " · vence " + fecha(B.vencimiento) + " · cobra " + B.cobra : ""}</div>
      </div>
      <div class="tarjeta"><h4>Supuestos</h4>
        <label class="campo">Línea<select name="linea"><option value="D">D (MEP)</option><option value="C">C (cable)</option></select></label>
        <div class="fila"><label class="campo">Comisión venta %<input name="cv" inputmode="decimal" value="${esc(P.cv)}"></label>
          <label class="campo">Comisión compra %<input name="cc" inputmode="decimal" value="${esc(P.cc)}"></label></div>
        <label class="campo">Reinversión de cupones % (vacío = TIR de venta)<input name="reinv" inputmode="decimal" value="${esc(P.reinv)}"></label>
      </div>
    </div>
    <div id="res-pase"></div>`;
  el.querySelector("[name=linea]").value = P.linea;
  el.querySelectorAll("[name]").forEach(c => c.addEventListener("change", () => {
    P[c.name] = c.value.trim();
    if (c.name === "vendo") P.pv = ""; if (c.name === "compro") P.pc = "";
    guardado.escribir("pase", { vendo: P.vendo, compro: P.compro, linea: P.linea, cv: P.cv, cc: P.cc, reinv: P.reinv });
    pPase();
  }));
  $("#res-pase").innerHTML = resultadoPase(A, B, vA, vB);
}

const dec = s => s === "" || s == null ? null : +String(s).replace(",", ".");
function resultadoPase(A, B, vA, vB) {
  const P = E.pase;
  if (!A || !B) return `<p class="nota">Elige el bono que vendes y el que compras (ONs y bonos en dólares con flujos de tasa fija). Toca una fila de ONs o Soberanos para mandarla acá.</p>`;
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
      <p class="nota">Flujos exactos de los dos bonos, cupones reinvertidos al ${pct(reinv)}. Regla rápida: (TIR compra − TIR venta) × vida de ${esc(A.tk)} (${num(r.T / 365, 1)} años) − comisiones = ${pct(rapida)}.</p>
      ${avisos.map(a => `<p class="nota aviso">${esc(a)}</p>`).join("")}
      <p class="nota">Diagnóstico: la ejecución queda sujeta a la autorización del cliente.</p>
    </div>`;
}

// ---------- emisores ----------
const CORTO = { "Solidez de balance": "Balance", "Cobertura de intereses": "Cobertura", "Caja después de invertir": "Caja post-inv.", "Liquidez": "Liquidez", "Lo que dicen los modelos": "Modelos", "Capacidad de pago": "Cap. de pago", "Promedio": "Promedio" };
async function pEmisores() {
  const el = $("#p-emisores");
  if (!E.emisores) {
    const clave = guardado.leer("clave", null);
    if (clave && await abrirEmisores(clave, true)) return pEmisores();
    el.innerHTML = `<form class="tarjeta candado" id="f-clave">
      <h4>Emisores · corte ${esc(E.meta?.emisores?.corte || "")}</h4>
      <p class="nota">El análisis de emisores está cifrado. Escribe la contraseña de la página.</p>
      <input type="password" name="clave" autocomplete="current-password" required class="campo" style="padding:8px 10px;border:1px solid var(--linea);border-radius:8px;background:var(--fondo)">
      <label class="chip"><input type="checkbox" name="recordar" checked> Recordar en este dispositivo</label>
      <button class="btn primario">Abrir</button><p class="nota" id="msg-clave"></p></form>`;
    $("#f-clave").onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      $("#msg-clave").textContent = "Descifrando…";
      if (await abrirEmisores(fd.get("clave"), fd.get("recordar"))) pEmisores();
      else $("#msg-clave").textContent = "Contraseña incorrecta.";
    };
    return;
  }
  const d = E.emisores, filas = Object.entries(d.emisores).map(([em, x]) => ({ em, ...x }));
  const nombres = Object.keys(filas[0]?.cualidades || {});
  const cols = [
    { k: "em", t: "Emisor", f: x => `<span class="tk">${esc(x.em)}</span>${x.inestable ? ' <span class="aviso" title="El orden cambia mucho al sacar una cualidad">⚠</span>' : ""}`, v: x => x.em },
    { k: "sector", t: "Sector", cls: "ocultar-movil", f: x => esc(x.sector), v: x => x.sector },
    ...nombres.map(q => ({ k: "q:" + q, t: CORTO[q] || q, titulo: q, n: 1, f: x => `<span class="${q === "Promedio" ? "tk" : ""}">${num(x.cualidades[q], 0)}</span>`, v: x => x.cualidades[q] })),
    { k: "exig", t: "TIR exigida", n: 1, f: x => pct(x.pricing["TIR exigida"]), v: x => x.pricing["TIR exigida"], titulo: "Merton + spread soberano" },
    { k: "merc", t: "TIR mercado", n: 1, f: x => pct(x.pricing["TIR mercado"]), v: x => x.pricing["TIR mercado"] },
    { k: "dif", t: "Paga de más", n: 1, f: x => { const v = x.pricing["Dif. mercado - exigida"]; return v == null ? "—" : `<span class="${v > 0 ? "pos" : "neg"}">${pb(v * 1e4)} pb</span>`; }, v: x => x.pricing["Dif. mercado - exigida"], titulo: "TIR de mercado − TIR exigida: positivo = barato" },
    { k: "pd", t: "PD 1 año", n: 1, cls: "ocultar-movil", f: x => pct(x.pricing.PD_1y), v: x => x.pricing.PD_1y },
    { k: "puesto", t: "Puesto", n: 1, f: x => x.puestos ? `${num(x.puestos.base, 0)} <span class="suave">(${num(x.puestos.min, 0)}–${num(x.puestos.max, 0)})</span>` : "—", v: x => x.puestos?.base, titulo: "Puesto base y rango al sacar una cualidad por vez" },
  ];
  if (!E.orden.emisores) E.orden.emisores = { k: "q:Promedio", asc: false };
  el.replaceChildren(
    nota(`${filas.length} emisores · corte ${esc(d.corte)} · horizonte ${num(d.horizonte_anios, 0)} años · orden por calidad (promedio de cualidades), valor en «paga de más» · <a href="#" id="olvidar">olvidar contraseña</a>`),
    tabla("emisores", filas, cols, { alClick: fichaEmisor }),
    Object.assign(document.createElement("div"), { className: "lectura", innerHTML: d.lectura_html }));
  $("#olvidar").onclick = e => { e.preventDefault(); guardado.escribir("clave", null); E.emisores = null; pEmisores(); };
}

async function abrirEmisores(clave, recordar) {
  try {
    const sobre = await fetch("data/emisores.json", { cache: "no-cache" }).then(r => r.json());
    E.emisores = await descifrar(sobre, clave);
    if (recordar) guardado.escribir("clave", clave);
    return true;
  } catch { if (recordar === true) guardado.escribir("clave", null); return false; }
}

function fichaEmisor(x) {
  const dlg = $("#ficha");
  const fila = o => Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${typeof v === "number" ? num(v, Math.abs(v) < 10 ? 3 : 1) : esc(v)}</td></tr>`).join("");
  dlg.innerHTML = `<div class="dlg"><div class="cab-ficha"><div><h3>${esc(x.em)}</h3><div class="suave">${esc(x.sector)}</div></div><button class="btn chico" data-cerrar type="button">Cerrar</button></div>
    <div class="datos">${Object.entries(x.cualidades).map(([k, v]) => dato(esc(k), num(v, 0))).join("")}</div>
    <div class="tabla-caja"><table><thead><tr><th>Pricing</th><th class="n">Valor</th></tr></thead><tbody>${fila(x.pricing)}</tbody></table></div>
    <div class="tabla-caja"><table><thead><tr><th>Métrica</th><th class="n">Valor</th></tr></thead><tbody>${fila(x.metricas)}</tbody></table></div></div>`;
  dlg.querySelector("[data-cerrar]").onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
}

// ---------- navegación ----------
const PANELES = { ons: pON, pagos: pPagos, soberanos: pSoberanos, pesos: pPesos, pase: pPase, emisores: pEmisores };
let actual = "ons";
function ir(p) {
  if (!PANELES[p]) p = "ons";
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
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && E.horaVivo && Date.now() - E.horaVivo > 5 * 60e3) pedirVivo();
});

cargar().then(() => { estado(); ir(location.hash.slice(1) || "ons"); pedirVivo(); })
  .catch(e => { $("#estado").innerHTML = `<span class="error">No pude leer los datos (${esc(e.message)})</span>`; });
