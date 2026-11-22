#!/usr/bin/env python3
"""Z'' de Altman por emisor (versión para no manufactureras y mercados emergentes, sin capitalización bursátil)
y escribe docs/data/altman.json. Corre en la laptop: lee el panel de crédito cacheado de /Users/contr/myenv/src.

Z'' = 6,56·X1 + 3,26·X2 + 6,72·X3 + 1,05·X4
  X1 = capital de trabajo / activo   X2 = resultados no asignados / activo
  X3 = EBIT de los últimos 12 meses / activo   X4 = patrimonio neto contable / pasivo total
Zonas: > 2,60 segura · 1,10 a 2,60 gris · < 1,10 de riesgo. El EM score de Altman es Z'' + 3,25.

Corte por emisor: el último trimestre de 2026 con activo y pasivo cargados.
EBIT de 12 meses: EBITDA de 12 meses menos amortizaciones anualizadas (EBITDA − EBIT de los trimestres de 2026, × 4/n).
X2: en los estados argentinos los «resultados no asignados» se pasan a reservas en cada asamblea, así que X2 queda
corto y el Z'' sale conservador.

Uso: python3 scripts/exportar_altman.py
"""
import datetime as dt
import json
import math
import sys
from pathlib import Path

import pandas as pd

RAIZ = Path(__file__).resolve().parent.parent
SRC = Path("/Users/contr/myenv")
sys.path[:0] = [str(SRC), str(SRC / "src")]
from src.data_connector import load_panel  # noqa: E402

TRIM = ["1T26", "2T26", "3T26"]
panel = load_panel().apply(pd.to_numeric, errors="coerce")
cortes = {t: panel.xs(t, level="period") for t in TRIM}


def zona(z):
    return "segura" if z > 2.6 else "gris" if z >= 1.1 else "riesgo"


salida = {}
for em in cortes["3T26"].index:
    corte = next((t for t in reversed(TRIM) if pd.notna(cortes[t].loc[em, ["total_assets", "total_liabilities"]]).all()), None)
    if corte is None:
        continue
    b = cortes[corte].loc[em]
    usados = TRIM[: TRIM.index(corte) + 1]
    da = [cortes[t].loc[em, "ebitda"] - cortes[t].loc[em, "ebit"] for t in usados]
    da = [x for x in da if pd.notna(x)]
    if pd.isna(b.ebitda_ltm) or not da:
        continue
    ebit12 = b.ebitda_ltm - sum(da) * 4 / len(da)
    ta, tl = b.total_assets, b.total_liabilities
    x = {"X1": (b.current_assets - b.current_liabilities) / ta, "X2": b.retained_earnings / ta,
         "X3": ebit12 / ta, "X4": b.equity / tl}
    if any(pd.isna(v) or math.isinf(v) for v in x.values()):
        continue
    z = 6.56 * x["X1"] + 3.26 * x["X2"] + 6.72 * x["X3"] + 1.05 * x["X4"]
    salida[em] = {"z": round(z, 2), "zona": zona(z), "corte": corte, "ebit_12m": round(ebit12, 1),
                  **{k: round(v, 4) for k, v in x.items()}}

json.dump({"generado": dt.date.today().isoformat(), "modelo": "Z'' de Altman (no manufactureras, mercados emergentes)",
           "zonas": {"segura": 2.6, "gris": 1.1}, "emisores": salida},
          open(RAIZ / "docs/data/altman.json", "w"), ensure_ascii=False, indent=1)
for em, v in sorted(salida.items(), key=lambda kv: -kv[1]["z"]):
    print(f"{em:10} {v['z']:6.2f} {v['zona']:7} {v['corte']}  X1 {v['X1']:+.3f} X2 {v['X2']:+.3f} X3 {v['X3']:+.3f} X4 {v['X4']:.2f}")
