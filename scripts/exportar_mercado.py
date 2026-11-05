#!/usr/bin/env python3
"""Datos de mercado para la página: cierre del tablero de BYMA (tablero.bymaeduca.com.ar) a JSON en docs/data/.

Escribe:
  ons.json        ONs hard dollar (segmento «hd»; las de chamomberg que BYMA no trae, con los flujos de chamomberg.com): ley del ISIN, moneda de cobro (chamomberg > ISIN > BYMA), marca de
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
MANUALES = RAIZ / "data/reference/flujos-manuales.csv"  # ONs que no están en BYMA ni en chamomberg
URL = "https://tablero.bymaeduca.com.ar/"
CHAMO_WEB = "https://chamomberg.com/"


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


def flujos_chamomberg():
    """ONs de los datos de chamomberg.com (on-arg-data y on_ny_data): {prefijo del ticker: objeto con `flows` por fecha}.
    Sirve para las ONs que distribuye Balanz y que el tablero de BYMA no trae."""
    principal = urllib.request.urlopen(urllib.request.Request(CHAMO_WEB, headers={"User-Agent": "Mozilla/5.0"}),
                                       timeout=60).read().decode("utf-8", "ignore")
    scripts = re.findall(r'src="/?((?:on-arg-data|on_ny_data)[^"]*\.js[^"]*)"', principal)
    out = {}
    for s in scripts:
        texto = urllib.request.urlopen(urllib.request.Request(CHAMO_WEB + s, headers={"User-Agent": "Mozilla/5.0"}),
                                       timeout=60).read().decode("utf-8", "ignore")
        for m in re.finditer(r'"ticker":\s*"([A-Z0-9]+)"', texto):
            i, prof = texto.rfind("{", 0, m.start()), 0
            for j in range(i, len(texto)):
                prof += (texto[j] == "{") - (texto[j] == "}")
                if prof == 0:
                    break
            try:
                o = json.loads(texto[i:j + 1])
            except ValueError:
                continue
            if o.get("flows"):
                out.setdefault(m.group(1)[:-1], o)
    return out


def desde_chamomberg(tk, o, fila, liq):
    """ON armada con los flujos de chamomberg (fechas → días desde la liquidación del cierre de BYMA); sin precio de cierre."""
    d0 = dt.date.fromisoformat(liq)
    flujos = [[(dt.date.fromisoformat(f["date"]) - d0).days, f["amortization"], f["interest"], 0.0]
              for f in o["flows"] if dt.date.fromisoformat(f["date"]) > d0]
    return {"tk": tk, "emisor": o.get("company"), "clase": None, "isin": "",
            "ley": "NY" if fila.get("tabla_chamomberg") == "Ley NY" else "ARG",
            "moneda": "USD", "estructura": o.get("type"), "cupon": o.get("coupon"), "frecuencia": o.get("coupons"),
            "vencimiento": o.get("maturity"), "vr": o.get("currentResidual"),
            "cierre": {"px": None, "ytm": None, "dm": None, "adtv_usd": None, "fx": None, "fxr": None},
            "tipo_flujos": "fix", "liq": liq, "flujos": redondear(flujos), "fuente_flujos": "chamomberg"}


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
        o["fuente_flujos"] = "BYMA" if o["flujos"] else None
        ons.append(o)
    en_byma = {o["tk"] for o in ons}
    faltan = [tk for tk in chamo if tk not in en_byma]
    sin_dato = []
    # chamomberg trae también la lámina mínima (`min`); se pide siempre, y si no responde las ONs quedan sin lámina
    try:
        extra = flujos_chamomberg()
    except Exception as e:
        print(f"⚠ chamomberg no respondió ({type(e).__name__}: {e}): sin lámina mínima ni flujos de chamomberg.")
        extra = {}
    if faltan:
        for tk in faltan:
            o = extra.get(tk[:-1])
            if not o:
                sin_dato.append(tk)
                continue
            fila = chamo[tk]
            ons.append(desde_chamomberg(tk, o, fila, liq) | {
                "sector": None, "cobra": fila.get("paga_chamomberg") or None, "fuente_cobro": "chamomberg",
                "cobra_byma": None, "chamomberg": True, "calificacion": fila.get("calificacion_chamomberg") or None,
                "emitido": None})
    en_base = {o["tk"] for o in ons}
    manuales = {}
    for f in csv.DictReader(open(MANUALES)) if MANUALES.exists() else []:
        if f["ticker"] not in en_base:
            manuales.setdefault(f["ticker"], []).append(f)
    d0 = dt.date.fromisoformat(liq)
    for tk, filas in manuales.items():
        f = filas[0]
        flujos = [[(dt.date.fromisoformat(x["fecha"]) - d0).days, float(x["amortizacion"]), float(x["renta"]), 0.0]
                  for x in filas if dt.date.fromisoformat(x["fecha"]) > d0]
        ons.append({"tk": tk, "emisor": f["emisor"], "clase": f["clase"] or None, "isin": "", "ley": f["ley"],
                    "moneda": "USD", "estructura": "Tasa Fija", "cupon": float(f["cupon"]), "frecuencia": f["frecuencia"],
                    "vencimiento": f["vencimiento"], "vr": 100.0,
                    "cierre": {"px": None, "ytm": None, "dm": None, "adtv_usd": None, "fx": None, "fxr": None},
                    "tipo_flujos": "fix", "liq": liq, "flujos": redondear(flujos), "fuente_flujos": f["fuente"],
                    "sector": None, "cobra": f["cobra"], "fuente_cobro": f["fuente_cobro"], "cobra_byma": None,
                    "chamomberg": tk in chamo, "calificacion": None, "emitido": None})
    # las que no vienen de BYMA traen el nombre corto de chamomberg: se usa el de BYMA del mismo prefijo de ticker
    nombres = {}
    for o in ons:
        if o["fuente_flujos"] == "BYMA":
            for n in (3, 2):
                nombres.setdefault(o["tk"][:n], set()).add(o["emisor"])
    for o in ons:
        if o["fuente_flujos"] != "BYMA":
            for n in (3, 2):
                cand = nombres.get(o["tk"][:n], set())
                if len(cand) == 1:
                    o["emisor"] = next(iter(cand))
                    break
    for o in ons:
        o["lamina"] = (extra.get(o["tk"][:-1]) or {}).get("min")
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
    pesos = [instrumento(r, ins.get(r["tk"])) | {"segmento": r["seg"], "emision": r.get("fe"), "pxa": r.get("pxa"), "par": r.get("par")}
             for r in tp if r["me"] == "ARS" and r["seg"] in ("lec", "fija", "cer", "tam", "dua")]

    SALIDA.mkdir(parents=True, exist_ok=True)
    archivos = {"ons.json": ons, "pagos.json": pagos, "soberanos.json": soberanos, "pesos.json": pesos}
    for nombre, datos in archivos.items():
        (SALIDA / nombre).write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")))
    cau = [x for x in d["din"]["cau"]["c"] if x is not None]
    meta = {"cierre": fecha, "liquidacion": liq, "caucion_tna": cau[-1] / 100 if cau else None, "generado": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "fuente": {"mercado": URL, "cobro": "chamomberg.com > ISIN > BYMA", "vivo": "data912.com (lo pide el navegador)"},
            "conteos": {k: len(v) for k, v in archivos.items()},
            "ons_chamomberg": sum(o["chamomberg"] for o in ons),
            "sin_flujos": [o["tk"] for o in ons if not o["flujos"]],
            "flujos_chamomberg": [o["tk"] for o in ons if o.get("fuente_flujos") == "chamomberg"],
            "flujos_manuales": sorted(manuales),
            "chamomberg_sin_dato": sin_dato}
    meta_previa = SALIDA / "meta.json"
    if meta_previa.exists():  # emisores.json lo escribe otro script: no pisar su fecha
        previa = json.loads(meta_previa.read_text())
        if "emisores" in previa:
            meta["emisores"] = previa["emisores"]
    meta_previa.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"cierre {fecha} · " + " · ".join(f"{k} {v}" for k, v in meta["conteos"].items())
          + f" · chamomberg {meta['ons_chamomberg']} (flujos de chamomberg: {len(meta['flujos_chamomberg'])})"
          + f" · sin flujos {meta['sin_flujos']} · chamomberg sin dato {sin_dato}")


if __name__ == "__main__":
    main()
