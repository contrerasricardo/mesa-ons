#!/usr/bin/env python3
"""Datos de mercado para la página: cierre del tablero de BYMA (tablero.bymaeduca.com.ar) a JSON en docs/data/.

Escribe:
  ons.json        ONs hard dollar (segmento «hd»): ley del ISIN, moneda de cobro (chamomberg > ISIN > BYMA), marca de
                  universo chamomberg (lo que distribuye Balanz), cupón, vencimiento, cierre y flujos por 100 de VN original.
  pagos.json      calendario de pagos de esas ONs (fecha, renta, amortización); `corte` queda reservado para la fecha de
                  corte de cupón, que BYMA no publica.
  soberanos.json  soberanos y provinciales en dólares, con sus flujos.
  pesos.json      curva en pesos (LECAP, BONCAP, CER, TAMAR, duales), con sus flujos.
  meta.json       fecha de cierre, liquidación, fuente y conteos.
Flujos: [días desde la liquidación del cierre, capital, renta, ajuste]. Precio de cierre `px`: sucio, en la moneda de los flujos.
Las dollar-linked (pagan en pesos) quedan afuera. Solo BYMA y la lista de chamomberg: corre en GitHub Actions sin la laptop.

Uso: python3 scripts/exportar_mercado.py
"""
import csv
import datetime as dt
import json
import re
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "docs/data"
CHAMO = RAIZ / "data/reference/ons-chamomberg.csv"
URL = "https://tablero.bymaeduca.com.ar/"


def cargar():
    pedido = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(pedido, timeout=90).read().decode("utf-8", "ignore")
    return json.loads(re.search(r'<script id="payload" type="application/json">(.*?)</script>', html, re.S).group(1))


def chamomberg():
    return {r["ticker"]: r for r in csv.DictReader(open(CHAMO))}


def cobra_en(ticker, isin, byma, chamo):
    # misma regla que CEREBRO/scripts/calculadora_bonos.cobra_en
    c = chamo.get(ticker, {}).get("paga_chamomberg")
    if c in ("MEP", "CCL"):
        return c, "chamomberg"
    if isin and not isin.startswith("AR"):
        return "CCL", "ISIN"
    return byma, "BYMA"


def redondear(flujos):
    return [[d, round(c, 6), round(r, 6), round(a, 6)] for d, c, r, a in flujos]


def instrumento(r, i):
    """Campos comunes a todos los bonos."""
    return {
        "tk": r["tk"], "emisor": r["em"], "clase": r["de"], "isin": r.get("isin") or "",
        "ley": "ARG" if (r.get("isin") or "AR").startswith("AR") else "NY",
        "moneda": r["me"], "estructura": r["est"], "cupon": r.get("cup"), "frecuencia": r.get("fc"),
        "vencimiento": r["fv"], "vr": r.get("vr"),
        "cierre": {"px": i["px"] if i else r.get("px"), "ytm": r.get("ytm"), "dm": r.get("dm"),
                   "adtv_usd": r.get("adtvu"), "fx": r.get("fx"), "fxr": r.get("fxr")},
        "tipo_flujos": i["k"] if i else None,
        "liq": i["liq"] if i else None,
        "flujos": redondear(i["f"]) if i else [],
    }


def main():
    d = cargar()
    chamo = chamomberg()
    ins = {i["tk"]: i for i in d["calc"]["ins"]}
    fecha, liq = d["on"]["fecha"], d["on"]["fecha_liq"]

    ons = []
    for r in d["on"]["rows"]:
        if r["seg"] != "hd":
            continue
        o = instrumento(r, ins.get(r["tk"]))
        cobro, fuente = cobra_en(r["tk"], o["isin"], r.get("mp"), chamo)
        o |= {"sector": r.get("sec"), "cobra": cobro, "fuente_cobro": fuente, "cobra_byma": r.get("mp"),
              "chamomberg": r["tk"] in chamo,
              "calificacion": (chamo.get(r["tk"]) or {}).get("calificacion_chamomberg") or None,
              "emitido": r.get("mto")}
        ons.append(o)
    ons.sort(key=lambda o: (o["emisor"], o["vencimiento"], o["tk"]))

    pagos = []
    for o in ons:
        d0 = dt.date.fromisoformat(o["liq"]) if o["liq"] else None
        for dias, cap, renta, _ in o["flujos"]:
            pagos.append({"fecha": (d0 + dt.timedelta(days=dias)).isoformat(), "tk": o["tk"], "emisor": o["emisor"],
                          "ley": o["ley"], "cobra": o["cobra"], "renta": renta, "amortizacion": cap,
                          "total": round(renta + cap, 6), "corte": None})
    pagos.sort(key=lambda p: (p["fecha"], p["emisor"], p["tk"]))

    tp = d["tp"]["rows"]
    soberanos = [instrumento(r, ins.get(r["tk"])) | {"segmento": r["seg"]}
                 for r in tp if r["me"] == "USD" and r["seg"] in ("sob", "pro")]
    pesos = [instrumento(r, ins.get(r["tk"])) | {"segmento": r["seg"]}
             for r in tp if r["me"] == "ARS" and r["seg"] in ("lec", "fija", "cer", "tam", "dua")]

    SALIDA.mkdir(parents=True, exist_ok=True)
    archivos = {"ons.json": ons, "pagos.json": pagos, "soberanos.json": soberanos, "pesos.json": pesos}
    for nombre, datos in archivos.items():
        (SALIDA / nombre).write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")))
    meta = {"cierre": fecha, "liquidacion": liq, "generado": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "fuente": {"mercado": URL, "cobro": "chamomberg.com > ISIN > BYMA", "vivo": "data912.com (lo pide el navegador)"},
            "conteos": {k: len(v) for k, v in archivos.items()},
            "ons_chamomberg": sum(o["chamomberg"] for o in ons),
            "sin_flujos": [o["tk"] for o in ons if not o["flujos"]]}
    meta_previa = SALIDA / "meta.json"
    if meta_previa.exists():  # emisores.json lo escribe otro script: no pisar su fecha
        previa = json.loads(meta_previa.read_text())
        if "emisores" in previa:
            meta["emisores"] = previa["emisores"]
    meta_previa.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"cierre {fecha} · " + " · ".join(f"{k} {v}" for k, v in meta["conteos"].items())
          + f" · chamomberg {meta['ons_chamomberg']} · sin flujos {meta['sin_flujos']}")


if __name__ == "__main__":
    main()
