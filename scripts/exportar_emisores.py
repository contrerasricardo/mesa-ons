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
import subprocess
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "docs/data"
SRC = Path(os.environ.get("MESA_SRC", "/Users/contr/myenv/src"))
# los emisores que ya publicaron 3T26 usan ese balance (los demás siguen en el corte del notebook)
BAL_3T = ("bal = rc.build_balances_from_master(period=PERIODO)\n",
          "bal = rc.build_balances_from_master(period=PERIODO)\n"
          "_b3 = rc.build_balances_from_master(period=\"3T26\"); _con3 = list(_b3.index[_b3.ebitda_ltm.notna()])\n"
          "bal.loc[_con3] = _b3.loc[_con3].combine_first(bal.loc[_con3])\n")
PARCHES = {"05_pricing.py": [BAL_3T],
           "06_comparativo.py": [('d7["x"] = d7["Escalón"]\n', 'd7["x"] = d7["Escalón"].astype(float)\n'), BAL_3T]}


def correr(nombre):
    src = (SRC / nombre).read_text()
    for viejo, nuevo in PARCHES.get(nombre, []):
        if viejo in src:
            src = src.replace(viejo, nuevo)
    g = {"__name__": "__exportar__"}
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(src, str(SRC / nombre), "exec"), g)
    return g


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
            "corte": "3T26" if em in con3 else str(c["PERIODO"]),
        }
    return {"corte": f'{c["PERIODO"]} · 3T26: {", ".join(sorted(con3))}' if con3 else str(c["PERIODO"]), "horizonte_anios": limpio(c["T_HORIZONTE"]),
            "generado": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "emisores": emisores, "lectura_html": c["_html_lectura"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--publicar", action="store_true")
    a = ap.parse_args()
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
