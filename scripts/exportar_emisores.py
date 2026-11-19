#!/usr/bin/env python3
"""Emisores para la página: corre los notebooks 05 (pricing) y 06 (comparativo) sin pantalla y escribe
docs/data/emisores.json (sin cifrar desde el 5-nov-2026, a pedido de Ricardo).

Corre en la laptop, no en GitHub Actions: los notebooks leen Research Corporativos.xlsx. Se usa después de actualizar el Excel.
Por emisor: sector, las cinco cualidades y el promedio (0 a 100), las métricas del cuadro, PD y TIR exigida contra la de
mercado (05), el rango de puestos al sacar una cualidad por vez y si el orden es inestable; aparte, la lectura en HTML.
No modifica los notebooks: el 06 se ejecuta con una corrección en memoria (columna «x» del cuadro 7 como float).

Uso:
  python3 scripts/exportar_emisores.py               # exporta
  python3 scripts/exportar_emisores.py --publicar    # además commit y push de emisores.json y meta.json
"""
import argparse
import contextlib
import datetime as dt
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "docs/data"
SRC = Path(os.environ.get("MESA_SRC", "/Users/contr/myenv/src"))
# Regla del corte (por emisor): se usa el último período cuyo LTM esté completo: EBITDA, FCO e intereses pagados,
# los tres con su comparable. Si el 3T26 tiene saldos pero el LTM incompleto (formulario resumido de la CNV, comparable
# en otra base, falta de intereses), van los saldos del 3T26 sobre los flujos LTM a junio (2T26). Así se llenen celdas
# sueltas del 3T26 en el Excel, el emisor no salta de corte hasta tener el estado completo.
LTM_3T = ["ebitda_ltm", "cfo_ltm", "interest_paid", "ebitda_comparable", "cfo_comparable", "interest_paid_comparable"]
# en el balance del 05 y del 06, a esos emisores se les borran del 3T26 los LTM, comparables e intereses (quedan los de junio);
# el resto de la fila del 3T26 (saldos y flujos del trimestre) entra como antes
SIN_LTM = [*LTM_3T, "capex_comparable", "financial_costs"]
REGLA_3T = ("_b3 = rc.build_balances_from_master(period=\"3T26\")\n"
            f"_ok3 = _b3[{LTM_3T!r}].notna().all(axis=1)\n"
            "_full3 = list(_b3.index[_ok3]); _jn3 = list(_b3.index[~_ok3 & _b3.total_debt.notna()])\n")
# los emisores con LTM completo al 3T26 usan ese balance; los de _jn3, sin LTM; lo demás sigue en el corte del notebook
BAL_3T = ("bal = rc.build_balances_from_master(period=PERIODO)\n",
          "bal = rc.build_balances_from_master(period=PERIODO)\n" + REGLA_3T +
          "_con3 = _full3 + _jn3\n"
          "bal.loc[_full3] = _b3.loc[_full3].combine_first(bal.loc[_full3])\n"
          f"_b3.loc[_jn3, {SIN_LTM!r}] = float(\"nan\")\n"
          "bal.loc[_jn3] = _b3.loc[_jn3].combine_first(bal.loc[_jn3])\n")
# IRSA y Cresud cierran ejercicio en junio y no entran al panel del desk: se leen de la hoja «FY26 jun» del Excel
# (anual = LTM; en la página el corte va en trimestre calendario: 30-jun = 2T26; la columna «CRESY ind.» da el Merton de Cresud individual) y se suman en memoria al balance, a la base de Merton (IRS y CRESY cotizan en NY) y al cruce de ONs.
# Supuestos: sector propio con pesos FSO parejos y alpha soberano por defecto (0,60, renta en pesos de mercado interno).
FY_JUN = ("bal = rc.build_balances_from_master(period=PERIODO)\n",
          "bal = rc.build_balances_from_master(period=PERIODO)\n"
          "import src.merton_kmv as _mk, tir_mercado as _tm, pandas as _pd\n"
          "_fy = rc.build_balances_from_master(\"/Users/contr/Documents/CEREBRO/Research Corporativos.xlsx\", period=\"FY26 jun\").apply(_pd.to_numeric, errors=\"coerce\")\n"
          "_ind = _fy.loc[\"CRESY ind.\"] if \"CRESY ind.\" in _fy.index else None; _fy = _fy.loc[[\"IRSA\", \"CRESY\"]]\n"
          "_fy[\"ebitda_ltm\"] = _fy.ebitda; _fy[\"cfo_ltm\"] = _fy.cfo\n"
          # 1T FY27 (30-sep = 3T26): si la columna del 3T26 trae el LTM completo (el Excel lo calcula contra «FY26 jun»), manda sobre el anual
          "_q3 = rc.build_balances_from_master(period=\"3T26\").apply(_pd.to_numeric, errors=\"coerce\").reindex(_fy.index)\n"
          f"_fy3 = list(_q3.index[_q3[{LTM_3T!r}].notna().all(axis=1)])\n"
          "_fy.loc[_fy3] = _q3.loc[_fy3].combine_first(_fy.loc[_fy3])\n"
          "_fy[\"sector\"] = _fy.index.map({\"IRSA\": \"Real Estate\", \"CRESY\": \"Agro\"})\n"
          "bal = _pd.concat([bal[~bal.index.isin(_fy.index)], _fy])\n"
          "_tm.PATRONES.update({\"IRSA\": [\"INVERSIONES Y REPRESENTACIONES\"], \"CRESY\": [\"CRESUD\"]})\n"
          "if \"IRSA\" not in _mk.US_LISTED_TICKERS: _mk.US_LISTED_TICKERS.append(\"IRSA\")\n"
          "_qdb = _mk.load_quant_database\n"
          "def _qdb_fy(_q=_qdb, _f=_fy):\n"
          "    b, m = _q()\n"
          "    extra = _pd.DataFrame({\"Ticker\": _f.index, \"STD\": _f.st_debt.values, \"LTD\": _f.lt_debt.values,\n"
          "                           \"Total_Liabilities\": _f.total_liabilities.values, \"Sector\": _f.sector.values})\n"
          "    if _ind is not None and _ind[[\"st_debt\", \"lt_debt\", \"total_liabilities\"]].notna().all():\n"
          "        extra.loc[extra.Ticker == \"CRESY\", [\"STD\", \"LTD\", \"Total_Liabilities\"]] = _ind[[\"st_debt\", \"lt_debt\", \"total_liabilities\"]].values\n"
          "    return (_pd.concat([b[~b.Ticker.isin(_f.index)], extra], ignore_index=True),\n"
          "            _pd.concat([m[m.Ticker != \"IRSA\"], m[m.Ticker == \"IRS\"].assign(Ticker=\"IRSA\")], ignore_index=True))\n"
          "_mk.load_quant_database = _qdb_fy\n")
# en el 06, la base LTM de los ratios y la liquidez: FY26 jun es el LTM (intereses en financiación: FCO antes de intereses)
LTM_JUN = ("bases, meta = L.construir_bases()\n",
           "bases, meta = L.construir_bases()\n"
           "import pandas as _pd\n"
           "_fl = rc.build_balances_from_master(\"/Users/contr/Documents/CEREBRO/Research Corporativos.xlsx\", period=\"FY26 jun\").apply(_pd.to_numeric, errors=\"coerce\")\n"
           "_fl = _fl.loc[[\"IRSA\", \"CRESY\"]]\n"
           "_fl[\"cfo_ai\"] = _fl.cfo - _fl.interest_paid\n"
           "bases[\"LTM\"] = _pd.concat([bases[\"LTM\"][~bases[\"LTM\"].index.isin(_fl.index)], _fl.reindex(columns=bases[\"LTM\"].columns)])\n"
           "meta[\"cortes\"].update({em: \"2T26\" for em in _fl.index})\n"
           # 1T FY27: LTM = FY26 jun − trimestre jul-sep 25 (fila «9M25 comparable» de su columna) + trimestre jul-sep 26;
           # EBITDA y FCO LTM vienen hechos del Excel; costos financieros, EBIT y ventas: 3/4 del anual + el trimestre
           "_q3 = rc.build_balances_from_master(period=\"3T26\").apply(_pd.to_numeric, errors=\"coerce\").reindex(_fl.index)\n"
           f"_fy3 = list(_q3.index[_q3[{LTM_3T!r}].notna().all(axis=1)])\n"
           "for _e in _fy3:\n"
           "    _a, _q, _T = _fl.loc[_e], _q3.loc[_e], bases[\"LTM\"]\n"
           "    for _k in L.STOCKS:\n"
           "        if _k in _q.index and _pd.notna(_q[_k]): _T.loc[_e, _k] = _q[_k]\n"
           "    _ip = _a.interest_paid - _q.interest_paid_comparable + _q.interest_paid\n"
           "    _T.loc[_e, [\"ebitda\", \"interest_paid\", \"capex\", \"cfo_ai\"]] = [_q.ebitda_ltm, _ip, _a.capex - _q.capex_comparable + _q.capex, _q.cfo_ltm - _ip]\n"
           "    for _k in (\"financial_costs\", \"ebit\", \"revenue\"):\n"
           "        if _k in _T.columns and _k in _q.index: _T.loc[_e, _k] = _a.get(_k) * 0.75 + _q[_k]\n"
           "meta[\"cortes\"].update({em: \"3T26\" for em in _fy3})\n"
           # LTM incompleto al 3T26: flujos LTM a junio y saldos del 3T26
           + REGLA_3T +
           "_jn = [e for e in _jn3 if e in bases[\"LTM\"].index]\n"
           "_l2 = L._ltm_al_corte(\"2T26\", L.DC.leer_fila)\n"
           "_cl = [k for k in bases[\"LTM\"].columns if k in _l2.columns]\n"
           "bases[\"LTM\"].loc[_jn, _cl] = _l2.loc[_jn, _cl].values\n"
           "meta[\"intereses_aprox\"] = sorted(set(meta[\"intereses_aprox\"]) - set(_jn) | set(_l2.index[_l2[\"interest_aprox\"]]) & set(_jn))\n"
           "for _k, _et in L.STOCKS.items():\n"
           "    bases[\"LTM\"].loc[_jn, _k] = L.DC.leer_fila(\"3T26\", _et).reindex(_jn).values\n"
           "meta[\"cortes\"].update({e: \"3T26\" for e in _jn})\n"
           "E.NOMBRE.update({\"CRESY\": \"Cresud\"})\n")
PARCHES = {"05_pricing.py": [BAL_3T, FY_JUN],
           "06_comparativo.py": [('d7["x"] = d7["Escalón"]\n', 'd7["x"] = d7["Escalón"].astype(float)\n'), LTM_JUN, BAL_3T, FY_JUN]}


def correr(nombre):
    src = (SRC / nombre).read_text()
    for viejo, nuevo in PARCHES.get(nombre, []):
        # si el notebook cambió y el parche ya no encaja, se corta acá: publicar sin IRSA/Cresud o sin el 3T26 sería peor
        if viejo not in src:
            raise SystemExit(f"{nombre}: no encontré la línea a parchear ({viejo.strip()[:60]!r}); revisar PARCHES antes de exportar")
        src = src.replace(viejo, nuevo, 1)
    g = {"__name__": "__exportar__"}
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(src, str(SRC / nombre), "exec"), g)
    return g


MAESTRO = "/Users/contr/Documents/CEREBRO/Research Corporativos.xlsx"
# insumos del Excel que no son dato reportado sino estimación propia (van a la ficha y marcan la fila con ≈).
# Al llegar el dato reportado, se borra la entrada. El detalle del método vive en la hoja Fuentes del maestro.
ESTIMADOS = {
    "MSU GREEN": "Intereses pagados del 3T26 estimados con los cupones del contrato (el 9M no los separa por trimestre); "
                 "el 2T26 sale como residual para que 1T+2T+3T sume el 9M reportado.",
    "AA2000": "LTM a septiembre aproximado: la CNV solo publica el formulario resumido del 3T26, sin comparativos. "
              "EBITDA, FCO, CAPEX e intereses del 9M25 son estimaciones, igual que los costos financieros y los intereses pagados del 3T26.",
    "CGC": "Intereses pagados del 3T26 estimados por estructura de cupones (rango 10,6-15,5). EBITDA y costos financieros del 3T26 "
           "también son estimados: el formulario de la CNV no trae D&A y sus costos financieros incluyen la diferencia de cambio. "
           "Los comparables del 9M25 se llevaron a pesos de dic-25 (TC 1.455).",
    "PAE": "Flujos del 3T26 y comparables del 3T25 llevados a dólares con un TC promedio estimado del trimestre (1.500 en 3T26, 1.310 en 3T25); el 1S25 queda a 1.098,8, la base de la hoja 2T26.",
    "CRESY": "Costos financieros sin los intereses de arrendamientos; la parte de arrendamientos del trimestre jul-sep 26 es estimada.",
    "CEPU": "Comparables del 9M25 (EBITDA, FCO, CAPEX e intereses pagados) llevados a dólares con un TC promedio ene-sep 2025 estimado (1.168); los intereses pagados salen del consolidado, no del separado que usó el 2T26.",
}


def sin_recalcular(path):
    """Fórmulas sin valor cacheado: pasa cuando la planilla se escribió con openpyxl y nadie la abrió en Excel."""
    import openpyxl
    f, v = openpyxl.load_workbook(path), openpyxl.load_workbook(path, data_only=True)
    return sum(1 for ws in f.worksheets for fila in ws.iter_rows() for c in fila
               if isinstance(c.value, str) and c.value.startswith("=") and v[ws.title][c.coordinate].value is None)


def recalcular_copia():
    """Si el maestro trae fórmulas sin calcular, Excel recalcula una COPIA temporal (el original no se toca) y todas
    las lecturas del maestro se desvían a esa copia. Devuelve la ruta usada."""
    faltan = sin_recalcular(MAESTRO)
    if not faltan:
        return MAESTRO
    copia = Path(tempfile.mkdtemp(prefix="mesa-ons-")) / "maestro.xlsx"
    shutil.copy2(MAESTRO, copia)
    guion = (f'tell application "Microsoft Excel"\n open (POSIX file "{copia}")\n delay 3\n set wb to active workbook\n'
             ' calculate full\n save wb\n close wb saving no\nend tell')
    subprocess.run(["osascript", "-e", guion], check=True, capture_output=True)
    if (quedan := sin_recalcular(copia)):
        raise SystemExit(f"Excel no recalculó la copia: siguen {quedan} fórmulas sin valor")
    import openpyxl
    import openpyxl.reader.excel as lector
    original = openpyxl.load_workbook

    def desviar(f, *a, **k):
        return original(copia if str(f) == MAESTRO else f, *a, **k)
    openpyxl.load_workbook = lector.load_workbook = desviar
    print(f"maestro sin recalcular ({faltan} fórmulas): se usó una copia recalculada en Excel")
    return str(copia)


def limpio(v):
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return round(v, 6) if isinstance(v, float) else v


def armar():
    import matplotlib
    matplotlib.use("Agg")
    cwd = os.getcwd()
    os.chdir(SRC)
    try:
        p = correr("05_pricing.py")
        c = correr("06_comparativo.py")
    finally:
        os.chdir(cwd)
    datos, uni, rangos = c["datos"], p["uni"], c["rangos"]
    cualidades = [*c["CUALIDADES"], "Capacidad de pago", "Promedio"]
    pricing = ["PD_T", "PD_1y", "TIR Merton", "Spread soberano", "TIR exigida", "TIR mercado", "Dif. mercado - exigida"]
    con3 = set(p["_con3"]) & set(c["_con3"])
    jun = set(c["_fy"].index) - (set(p["_fy3"]) & set(c["_fy3"]))   # IRSA y Cresud: anual a junio salvo que ya tengan el 1T FY27
    emisores = {}
    for em in datos.index:
        fila = datos.loc[em]
        emisores[em] = {
            "sector": fila["sector"],
            "cualidades": {q: limpio(fila[q]) for q in cualidades if q in fila},
            "metricas": {k: limpio(v) for k, v in fila.items() if k not in cualidades and k != "sector"},
            "pricing": {k: limpio(uni.loc[em, k]) for k in pricing if em in uni.index},
            "puestos": ({"min": limpio(rangos[em][0]), "max": limpio(rangos[em][1]),
                         "base": limpio(c["puestos"].loc[em, "base"])} if em in rangos else None),
            "inestable": em in c["inestables"],
            "corte": "2T26" if em in jun else ("3T26 · LTM jun" if em in p["_jn3"] else "3T26") if em in con3 else str(c["PERIODO"]),
            "estimados": [ESTIMADOS[em]] if em in ESTIMADOS else [],
        }
    return {"corte": f'{c["PERIODO"]} · 3T26: {", ".join(sorted(con3))}' if con3 else str(c["PERIODO"]), "horizonte_anios": limpio(c["T_HORIZONTE"]),
            "generado": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "emisores": emisores, "lectura_html": c["_html_lectura"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--publicar", action="store_true")
    a = ap.parse_args()
    recalcular_copia()
    import sys
    sys.path[:0] = [str(SRC.parent), str(SRC)]
    import base_credito
    base_credito.update_credit_database()   # el parquet que leen los notebooks, desde el maestro ya calculado
    datos = armar()
    SALIDA.mkdir(parents=True, exist_ok=True)
    (SALIDA / "emisores.json").write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")))
    ruta_meta = SALIDA / "meta.json"
    meta = json.loads(ruta_meta.read_text()) if ruta_meta.exists() else {}
    meta["emisores"] = {"corte": datos["corte"].split(" · ")[0] + (" / 3T26" if " · " in datos["corte"] else ""), "generado": datos["generado"], "n": len(datos["emisores"])}
    ruta_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"emisores.json: {len(datos['emisores'])} emisores, corte {datos['corte']}, sin cifrar")
    if a.publicar:
        subprocess.run(["git", "-C", str(RAIZ), "add", "docs/data/emisores.json", "docs/data/meta.json"], check=True)
        subprocess.run(["git", "-C", str(RAIZ), "commit", "-m", f"emisores: corte {datos['corte']}"], check=True)
        subprocess.run(["git", "-C", str(RAIZ), "pull", "--rebase"], check=True)
        subprocess.run(["git", "-C", str(RAIZ), "push"], check=True)


if __name__ == "__main__":
    main()
