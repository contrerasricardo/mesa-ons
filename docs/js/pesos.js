// Motor de la calculadora de pesos: traducción de recomendar() de Finanzas computacionales/calc_pesos.ipynb (Bloque 8), función por
// función. Insumos: pesos.json (curva, ficha y flujos del cierre de BYMA), motor_pesos.json (CER y TAMAR del BCRA, REM, comisiones,
// feriados, márgenes) y el precio en vivo de data912 (punta vendedora; sin punta, último operado: el notebook usa el último), anclado contra el cierre de BYMA.
//
// Ranking al MISMO horizonte (la fecha objetivo): lo que vence antes se REINVIERTE en caución hasta ahí; lo que vence después se VENDE
// ese día a TIR constante (y paga comisión otra vez). Compra con comisión del mismo bolsillo: (1 + neto) = (1 + bruto)/(1 + c).

// ---------- fechas: número de día (UTC) ----------
const dn = s => Math.round(Date.parse(s) / 864e5);
export const ds = n => new Date(n * 864e5).toISOString().slice(0, 10);
const diasMes = n => { const d = new Date(n * 864e5); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); };
const mesDe = n => ds(n).slice(0, 7);

export function crearMotor(pesos, M, meta) {
  const FER = new Set(M.feriados.map(dn));
  const habil = n => { const w = (n + 4) % 7; return w !== 0 && w !== 6 && !FER.has(n); };
  const sigHabil = n => { do n++; while (!habil(n)); return n; };
  const menosHab = (n, k) => { while (k > 0) { n--; if (habil(n)) k--; } return n; };       // fecha − DIAS_HAB(k)
  const liquidacion = hoy => sigHabil(habil(hoy) ? hoy : sigHabil(hoy));                    // T+1 hábil
  const d30360 = (a, b) => {
    const x = new Date(a * 864e5), y = new Date(b * 864e5);
    const d1 = Math.min(30, x.getUTCDate()), d2 = d1 === 30 ? Math.min(30, y.getUTCDate()) : y.getUTCDate();
    return 360 * (y.getUTCFullYear() - x.getUTCFullYear()) + 30 * (y.getUTCMonth() - x.getUTCMonth()) + (d2 - d1);
  };

  // series del BCRA: asof = último valor publicado a esa fecha
  const serie = s => s.map(([f, v]) => [dn(f), v]);
  const CER = serie(M.cer), TAM = serie(M.tamar).map(([d, v]) => [d, v / 100]);
  const asof = (s, n) => {
    if (!s.length || n < s[0][0]) return NaN;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; s[m][0] <= n ? (lo = m) : (hi = m - 1); }
    return s[lo][1];
  };
  const remMax = Object.keys(M.rem_tamar_tna).sort().at(-1);
  const liqCierre = dn(meta.liquidacion);

  // universo: patrones de ticker del notebook (solo Tesoro Nacional; dollar linked y duales en dólares fuera)
  const TIPOS = [["LECAP", /^S\d{2}[A-Z]\d$/], ["BONCAP", /^T\d{2}[A-Z]\d$/],
    ["CER", /^X\d{2}[A-Z]\d$|^TZX[A-Z0-9]+$|^TX\d{2}$|^DICP$|^PARP$|^CUAP$/], ["TAMAR", /^TM[A-Z]\d{2}$/], ["Dual", /^TT[S|D]\d{2}$|^TXM[A-Z0-9]+$/]];
  const FUERA = /^D\d{2}[A-Z]\d$|^TZV[A-Z0-9]+$|^TV\d{2}$|^TMVE\d+$/;
  const SIN_BASE_100 = new Set(["DICP", "PARP", "CUAP"]);
  const base100 = (p, tk) => SIN_BASE_100.has(tk) || p > 10 ? p : p * 100;
  const universo = pesos.filter(b => ["lec", "cer", "tam", "dua"].includes(b.segmento) && !FUERA.test(b.tk)).map(b => {
    const tipo = TIPOS.find(([, re]) => re.test(b.tk))?.[0];
    if (!tipo) return null;
    const f = M.fichas[b.tk] || {}, fl = b.flujos;
    let cupon = null;
    if (b.segmento === "cer") cupon = b.cupon != null ? b.cupon : fl.length && fl.every(x => !x[2]) ? 0 : null;
    return { b, tk: b.tk, tipo, venc: dn(b.vencimiento), emision: b.emision ? dn(b.emision) : NaN, fl, pxa: b.pxa,
      tem: b.segmento === "lec" ? b.cupon : null, cupon, cuotas: fl.filter(x => x[1] > 0).length > 1,
      margen: f.margen_tamar || M.margen_inferido[b.tk] || null, temFija: f.tem_fija_dual ?? null, dualCer: f.dual_cer ?? b.tk.startsWith("TXM") };
  }).filter(Boolean);

  // Precio: comprar es a la punta vendedora de data912 (el notebook usa el último operado); sin punta, el último operado; sin
  // precio en vivo, el último cierre de BYMA. Contra el cierre en pesos (`pxa`): un cociente ≈ ×100, ×1000, ×0,01 es un error de ESCALA y se corrige; más de 8% de desvío se marca.
  function precio(u, vivo) {
    const q = vivo?.get(u.tk);
    let p = q?.px_ask > 0 ? q.px_ask : q?.c > 0 ? q.c : null, fuente = q?.px_ask > 0 ? "punta vendedora" : "último operado", alerta = "";
    if (!p) return u.pxa > 0 ? { p: u.pxa, fuente: "cierre BYMA", alerta: "solo cierre" } : { p: null, fuente: "—", alerta: "" };
    p = base100(p, u.tk);
    if (u.pxa > 0) {
      let r = p / u.pxa;
      for (const k of [100, 0.01, 1000, 0.001]) if (Math.abs(r / k - 1) < 0.15) { p /= k; r /= k; alerta = `unidad ajustada ×${k}`; break; }
      if (Math.abs(r - 1) > 0.08) alerta = [alerta, `se aparta ${(r - 1 > 0 ? "+" : "") + (100 * (r - 1)).toFixed(1)}% del cierre`].filter(Boolean).join("; ");
    }
    return { p, fuente, alerta };
  }

  function recomendar({ objetivo, ventana = 45, monto = 1e6, inflMensual = null, tnaCaucion = null, vivo = null, hoy = null, com = {} }) {
    const modo = inflMensual != null ? "fija" : "rem";
    const HOY = hoy ?? dn(new Date().toLocaleDateString("en-CA"));
    const obj = dn(objetivo);
    if (obj - HOY <= 0) return null;
    const liq = liquidacion(HOY), D = Math.max(obj - liq, 1);
    const cB = com.baja ?? M.comision_baja, cS = com.std ?? M.comision_std, cCau = com.cau ?? M.caucion_comision_anual;
    const tamar = TAM.length ? TAM.at(-1)[1] : NaN;
    const inflAnual = (1 + (inflMensual ?? 0.02)) ** 12 - 1;

    const factorCer = (f0, f1) => {
      if (f1 <= f0) return 1;
      let f = 1, ini = f0;
      if (CER.length && CER[0][0] <= f0 && f0 <= CER.at(-1)[0]) { ini = Math.min(f1, CER.at(-1)[0]); f = asof(CER, ini) / asof(CER, f0); }
      if (ini >= f1) return f;
      if (modo === "rem") {
        // el IPC del mes M−1 rige del 16 de M al 15 de M+1; donde el REM no da el mes, el largo plazo
        for (let d = ini; d < f1; d++) {
          const ref = new Date((d - 14) * 864e5), y = ref.getUTCFullYear(), m = ref.getUTCMonth() + 1;
          const clave = `${y - (m === 1 ? 1 : 0)}-${String(((m - 2 + 12) % 12) + 1).padStart(2, "0")}`;
          f *= (1 + (M.rem_ipc_mensual[clave] ?? M.rem_ipc_largo_mensual)) ** (1 / diasMes(d - 14));
        }
        return f;
      }
      return f * (1 + inflAnual) ** ((f1 - ini) / 365);
    };
    const cerDesdeCierre = () => asof(CER, menosHab(liq, 10)) / asof(CER, menosHab(liqCierre, 10));
    const tnaTamar = d => mesDe(d) <= mesDe(HOY) ? tamar : (M.rem_tamar_tna[mesDe(d)] ?? M.rem_tamar_tna[remMax]);
    const vtTamar = (fe, m) => {
      if (!TAM.length || isNaN(fe) || fe < TAM[0][0]) return NaN;
      let vt = 100;
      for (let d = fe; d < liq; d++) vt *= (1 + (asof(TAM, d) + m) * 30 / 360) ** (1 / diasMes(d));
      return vt;
    };
    const factorTamar = (f0, f1, m) => { let f = 1; for (let d = f0; d < f1; d++) f *= (1 + (tnaTamar(d) + m) * 30 / 360) ** (1 / diasMes(d)); return f; };
    const vtCer = fe => {
      if (!CER.length || isNaN(fe)) return NaN;
      const e = asof(CER, menosHab(fe, 10)), c = asof(CER, menosHab(liq, 10));
      return isNaN(e) || isNaN(c) || !e ? NaN : c / e * 100;
    };
    const irr = (fl, p, ajuste) => {
      const k = liq - liqCierre;
      const x = fl.map(([d, c, r, a]) => [d - k, (c + r + a) * (ajuste ? ajuste(d - k) : 1)]).filter(([d]) => d > 0);
      if (!x.length) return null;
      const f = y => x.reduce((s, [d, cf]) => s + cf / (1 + y) ** (d / 365), 0) - p;
      let lo = -0.95, hi = 20;
      if (f(lo) * f(hi) > 0) return null;
      for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; f(lo) * f(m) > 0 ? (lo = m) : (hi = m); }
      return (lo + hi) / 2;
    };

    const tasas = (rd, dias) => ({ rd, tna: rd * 365 / dias, tea: (1 + rd) ** (365 / dias) - 1 });
    const nada = nota => ({ rd: NaN, tna: NaN, tea: NaN, nota });
    function metricas(u, p100) {
      const dias = Math.max(u.venc - liq, 1);
      if (u.tipo === "LECAP" || u.tipo === "BONCAP") {
        if (isNaN(u.emision) || u.tem == null) return nada("sin ficha BYMA");
        const vtV = 100 * (1 + u.tem) ** (d30360(u.emision, u.venc) / 30);
        return { ...tasas(vtV / p100 - 1, dias), vtV, nota: `VT $${vtV.toFixed(2)} / P $${p100.toFixed(2)}` };
      }
      if (u.tipo === "CER") {
        if (!CER.length) return nada("falta BCRA/CER");
        const fl = u.fl;
        if (fl.length && (u.cuotas || fl.length > 1 || fl.some(x => x[2] > 0))) {
          // paga cupón o amortiza en cuotas: TIR NOMINAL con el flujo de BYMA llevado a pesos del día de pago
          const obs = cerDesdeCierre();
          if (isNaN(obs)) return nada("sin CER del BCRA para actualizar el flujo de BYMA");
          const y = irr(fl, p100, d => obs * factorCer(menosHab(liq, 10), menosHab(liq + d, 10)));
          if (y == null) return nada("sin TIR con el flujo de BYMA (precio fuera de rango)");
          const rd = (1 + y) ** (dias / 365) - 1;
          return { rd, tna: rd * 365 / dias, tea: y, nota: `TIR nominal con el flujo de BYMA y CER proyectado (${modo === "rem" ? "REM" : "fija"})` };
        }
        if (u.cuotas) return nada("paga cupón en cuotas — sin flujo de BYMA en el cierre");
        if (u.cupon == null) return nada("BYMA no publica la tasa del cupón para este título");
        const [vt, origen] = fl.length ? [fl[0][1] * cerDesdeCierre(), "VT BYMA"] : [vtCer(u.emision), "VT serie BCRA"];
        if (isNaN(vt)) return nada("sin valor técnico: ni flujo de BYMA ni CER de emisión en la serie del BCRA");
        const vtV = vt * factorCer(menosHab(liq, 10), menosHab(u.venc, 10));
        return { ...tasas(vtV / p100 - 1 + u.cupon * dias / 365, dias), vtH: vt, vtV,
          nota: `${origen} $${vt.toFixed(2)} · paridad ${(100 * p100 / vt).toFixed(1)}% · CER proyectado ×${(vtV / vt).toFixed(3)}` };
      }
      if (u.tipo === "TAMAR") {
        if (!TAM.length) return nada("falta TAMAR");
        let m = u.margen, origen = M.margen_inferido[u.tk] != null && !M.fichas[u.tk]?.margen_tamar ? "inferido" : "ficha";
        if (m == null) {
          if (u.b.cupon == null) return nada("sin margen: ni ficha ni cupón de BYMA");
          m = Math.max(u.b.cupon * 12 - tamar, 0); origen = "implícito en el cupón de BYMA";
        }
        const vtH = vtTamar(u.emision, m);
        if (isNaN(vtH)) return nada("sin TAMAR del BCRA desde la emisión");
        const vtV = vtH * factorTamar(liq, u.venc, m);
        return { ...tasas(vtV / p100 - 1, dias), vtH, vtV,
          nota: `VT $${vtH.toFixed(2)} · paridad ${(100 * p100 / vtH).toFixed(1)}% · margen ${(100 * m).toFixed(2)}% (${origen})` };
      }
      if (u.tipo === "Dual") {
        if (!TAM.length) return nada("falta BCRA");
        const m = u.margen ?? 0;
        const vtT = vtTamar(u.emision, m);
        if (isNaN(vtT)) return nada("sin TAMAR del BCRA desde la emisión");
        const vtTV = vtT * factorTamar(liq, u.venc, m);
        let vtO, etq;
        if (u.dualCer === true) {
          const c = vtCer(u.emision);
          if (isNaN(c)) return nada("sin CER de emisión para la pata CER");
          vtO = c * factorCer(menosHab(liq, 10), menosHab(u.venc, 10)); etq = "CER";
        } else if (u.temFija != null) { vtO = 100 * (1 + u.temFija) ** (d30360(u.emision, u.venc) / 30); etq = "fija"; }
        else return nada("la ficha no informa la otra pata del dual");
        const vtV = Math.max(vtTV, vtO);
        return { ...tasas(vtV / p100 - 1, dias), vtV,
          nota: `paga pata ${vtO > vtTV ? etq : "TAMAR"}: ${etq} $${vtO.toFixed(2)} · TAMAR + ${(100 * m).toFixed(2)}% $${vtTV.toFixed(2)}` };
      }
      return nada("sin metodología");
    }

    const comision = (tipo, tk) => tipo === "Caución" ? cCau * D / 365 : (tipo === "LECAP" || (tipo === "CER" && tk.startsWith("X"))) ? cB : cS;
    const hayCau = tnaCaucion != null || meta.caucion_tna != null;
    const tnaCau = tnaCaucion ?? meta.caucion_tna, tnaCauN = hayCau ? Math.max(tnaCau - cCau, 0) : NaN;

    const filas = [];
    for (const u of universo) {
      if (u.venc - HOY <= 0 || Math.abs(u.venc - obj) > ventana) continue;
      const px = precio(u, vivo);
      let m = px.p > 0 ? metricas(u, base100(px.p, u.tk)) : nada("sin precio de mercado en ninguna fuente");
      if (!isNaN(m.tea) && !(m.tea > -0.5 && m.tea < 2)) m = nada(`TEA fuera de rango plausible (${(100 * m.tea).toFixed(0)}%) — precio probablemente inconsistente`);
      const c = comision(u.tipo, u.tk);
      const r = { tk: u.tk, tipo: u.tipo, venc: ds(u.venc), dias: Math.max(u.venc - liq, 1), precio: px.p, fuente: px.fuente, alerta: px.alerta,
        rdVenc: m.rd, tna: m.tna, tea: m.tea, vtH: m.vtH ?? NaN, vtV: m.vtV ?? NaN, nota: m.nota ?? "", comision: c, reinv: 0 };
      if (isNaN(m.rd)) { r.bruto = r.neto = NaN; r.trat = ""; }
      else if (u.venc <= obj) {
        const n = obj - u.venc;
        if (hayCau && n > 0) {
          r.bruto = (1 + m.rd) * (1 + tnaCau / 365) ** n - 1; r.netoReinv = (1 + m.rd) * (1 + tnaCauN / 365) ** n - 1;
          r.trat = `vence el ${ds(u.venc).slice(8)}/${ds(u.venc).slice(5, 7)} y reinvierte ${n} d en caución`; r.reinv = n;
        } else { r.bruto = r.netoReinv = m.rd; r.trat = n > 0 ? `vence el ${ds(u.venc).slice(8)}/${ds(u.venc).slice(5, 7)}, sin reinversión (${n} d)` : "vence en la fecha objetivo"; }
      } else {
        const h = (1 + m.tea) ** (D / 365) - 1;
        r.bruto = h; r.netoReinv = (1 + h) * (1 - c) - 1;          // la venta paga comisión otra vez
        r.trat = `vence el ${ds(u.venc).slice(8)}/${ds(u.venc).slice(5, 7)}; se vende el ${objetivo.slice(8)}/${objetivo.slice(5, 7)} a TIR constante`; r.reinv = -(u.venc - obj);
      }
      if (!isNaN(r.bruto)) r.neto = (1 + r.netoReinv) / (1 + c) - 1;
      filas.push(r);
    }
    if (hayCau) {
      const bruto = (1 + tnaCau / 365) ** D - 1, neto = (1 + tnaCauN / 365) ** D - 1;
      filas.push({ tk: "Caución", tipo: "Caución", venc: objetivo, dias: D, precio: null, fuente: tnaCaucion != null ? "supuesto" : "caución al cierre", alerta: "",
        rdVenc: bruto, tna: tnaCau, tea: (1 + tnaCau / 365) ** 365 - 1, bruto, neto, comision: (1 + bruto) / (1 + neto) - 1, reinv: 0,
        trat: "renueva a diario hasta el objetivo", nota: `TNA ${(100 * tnaCau).toFixed(2)}% · comisión ${100 * cCau}% anual · TNA neta ${(100 * tnaCauN).toFixed(2)}%` });
    }
    for (const r of filas) {
      r.teaNeta = (1 + r.neto) ** (365 / D) - 1;
      r.ganancia = monto * r.bruto; r.final = monto + r.ganancia;
      r.gananciaNeta = monto * r.neto; r.finalNeto = monto + r.gananciaNeta;
      r.vn = r.precio ? monto / (1 + r.comision) / base100(r.precio, r.tk) * 100 : null;
    }
    filas.sort((a, b) => (isNaN(a.gananciaNeta) ? -Infinity : a.gananciaNeta) < (isNaN(b.gananciaNeta) ? -Infinity : b.gananciaNeta) ? 1 : -1);
    return { objetivo, liq: ds(liq), D, monto, ventana, modo, inflMensual, tnaCau: hayCau ? tnaCau : null, tnaCauN, cCau, filas,
      ok: filas.filter(r => !isNaN(r.neto)), sin: filas.filter(r => isNaN(r.neto)) };
  }

  // Robustez (Bloque 10 del notebook): caución de empate, podio por caución futura y podio por inflación.
  function robustez(p, R) {
    const obj = dn(p.objetivo);
    const sinReinv = R.ok.filter(r => r.tipo !== "Caución" && dn(r.venc) >= obj), conReinv = R.ok.filter(r => r.tipo !== "Caución" && dn(r.venc) < obj);
    const empate = [];
    if (sinReinv.length && conReinv.length) {
      const ref = sinReinv[0];
      for (const r of conReinv) {
        const n = obj - dn(r.venc);
        const diaria = ((1 + ref.neto) * (1 + r.comision) / (1 + r.rdVenc)) ** (1 / n) - 1;
        empate.push({ tk: r.tk, n, ref: ref.tk, tna: diaria * 365 + R.cCau });
      }
    }
    const top3 = q => recomendar({ ...p, ...q }).ok.slice(0, 3);
    const cau = R.tnaCau;
    const podioCau = cau == null ? [] : [["caución hoy", cau], ["caución −5 pts", cau - 0.05], ["caución −10 pts", cau - 0.10], ["caución +5 pts", cau + 0.05]]
      .map(([e, t]) => ({ e, t, top: top3({ tnaCaucion: t }) }));
    const podioInfl = [[M.rem_fecha.split(" (")[0], null], ["fija 1,5% mensual", 0.015], ["fija 2,0% mensual", 0.02], ["fija 2,5% mensual", 0.025]]
      .map(([e, i]) => ({ e, top: top3({ inflMensual: i }) }));
    return { empate, podioCau, podioInfl };
  }

  return { recomendar, robustez, universo, liquidacion: hoy => ds(liquidacion(dn(hoy))) };
}
