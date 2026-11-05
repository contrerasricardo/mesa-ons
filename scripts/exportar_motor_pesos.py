#!/usr/bin/env python3
"""Insumos del motor de la calculadora de pesos (docs/js/pesos.js), el mismo de calc_pesos.ipynb, a docs/data/motor_pesos.json.

  · Series del BCRA (API v4.0 Monetarias): CER (id 30) y TAMAR bancos privados (id 44), desde 2024. Si el BCRA no responde,
    se conservan las series del archivo anterior: el motor sigue andando con lo último publicado.
  · Supuestos de data/reference/supuestos-pesos.json: REM (IPC y TAMAR), comisiones, feriados y lo que el tablero de BYMA no trae
    (margen sobre TAMAR y la otra pata de los duales).
La curva, las fichas del tablero y los flujos salen de pesos.json (scripts/exportar_mercado.py); los precios, de data912 en vivo.

Uso: python3 scripts/exportar_motor_pesos.py
"""
import json
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SUPUESTOS = RAIZ / "data/reference/supuestos-pesos.json"
SALIDA = RAIZ / "docs/data/motor_pesos.json"
BCRA = "https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias/{}?Desde={}&Limit=3000"
DESDE = "2024-01-01"


def serie(id_variable):
    pedido = urllib.request.Request(BCRA.format(id_variable, DESDE), headers={"User-Agent": "Mozilla/5.0"})
    js = json.loads(urllib.request.urlopen(pedido, timeout=30).read())
    det = js["results"][0]["detalle"]
    return sorted([x["fecha"][:10], x["valor"]] for x in det)


def main():
    sup = {k: v for k, v in json.loads(SUPUESTOS.read_text()).items() if not k.startswith("_")}
    previo = json.loads(SALIDA.read_text()) if SALIDA.exists() else {}
    out = dict(sup)
    for nombre, id_variable in (("cer", 30), ("tamar", 44)):
        try:
            out[nombre] = serie(id_variable)
        except Exception as e:
            print(f"⚠ BCRA serie {id_variable} no respondió ({type(e).__name__}: {e}); se conserva la anterior.")
            out[nombre] = previo.get(nombre, [])
    SALIDA.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"motor_pesos.json: CER al {out['cer'][-1][0] if out['cer'] else '—'}, TAMAR al {out['tamar'][-1][0] if out['tamar'] else '—'}")


if __name__ == "__main__":
    main()
