#!/usr/bin/env python3
"""Emisores para la página: corre los notebooks 05 (pricing) y 06 (comparativo) sin pantalla y escribe
docs/data/emisores.json CIFRADO (AES-256-GCM, clave derivada con PBKDF2-SHA256 de la contraseña de la página).

Corre en la laptop, no en GitHub Actions: los notebooks leen Research Corporativos.xlsx. Se usa después de actualizar el Excel.
La contraseña: variable MESA_CLAVE, o el Llavero de macOS (servicio mesa-ons); la primera vez, una ventana la pide y la guarda ahí.
Por emisor: sector, las cinco cualidades y el promedio (0 a 100), las métricas del cuadro, PD y TIR exigida contra la de
mercado (05), el rango de puestos al sacar una cualidad por vez y si el orden es inestable; aparte, la lectura en HTML.
No modifica los notebooks: el 06 se ejecuta con una corrección en memoria (columna «x» del cuadro 7 como float).

Uso:
  python3 scripts/exportar_emisores.py               # exporta y cifra
  python3 scripts/exportar_emisores.py --publicar    # además commit y push de emisores.json y meta.json
"""
import argparse
import base64
import contextlib
import datetime as dt
import getpass
import io
import json
import math
import os
import secrets
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "docs/data"
SRC = Path(os.environ.get("MESA_SRC", "/Users/contr/myenv/src"))
ITERACIONES = 600_000
PARCHES = {"06_comparativo.py": [('d7["x"] = d7["Escalón"]\n', 'd7["x"] = d7["Escalón"].astype(float)\n')]}


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
        }
    return {"corte": str(c["PERIODO"]), "horizonte_anios": limpio(c["T_HORIZONTE"]),
            "generado": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "emisores": emisores, "lectura_html": c["_html_lectura"]}


def cifrar(texto, clave):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    sal, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    k = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=sal, iterations=ITERACIONES).derive(clave.encode())
    ct = AESGCM(k).encrypt(iv, texto.encode(), None)   # el tag de 16 bytes va al final, como lo espera WebCrypto
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITERACIONES, "alg": "AES-256-GCM", "sal": b(sal), "iv": b(iv), "ct": b(ct)}


def descifrar(sobre, clave):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    d = lambda x: base64.b64decode(x)
    k = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=d(sobre["sal"]), iterations=sobre["iter"]).derive(clave.encode())
    return AESGCM(k).decrypt(d(sobre["iv"]), d(sobre["ct"]), None).decode()


LLAVERO = ["-s", "mesa-ons", "-a", "pagina"]


def ventana(texto):
    """Ventana de macOS con campo oculto; None si se cancela."""
    guion = (f'text returned of (display dialog "{texto}" default answer "" with hidden answer '
             'with title "mesa-ons" buttons {"Cancelar", "OK"} default button "OK")')
    r = subprocess.run(["osascript", "-e", guion], capture_output=True, text=True)
    return r.stdout.rstrip("\n") if r.returncode == 0 else None


def obtener_clave():
    """MESA_CLAVE > Llavero de macOS > ventana para crearla (dos veces) y guardarla en el Llavero."""
    if os.environ.get("MESA_CLAVE"):
        return os.environ["MESA_CLAVE"]
    r = subprocess.run(["security", "find-generic-password", *LLAVERO, "-w"], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout.rstrip("\n")
    if sys.platform != "darwin":
        return getpass.getpass("Contraseña de la página: ")
    aviso = "Inventa la contraseña de la página (12 caracteres o más)."
    while True:
        clave = ventana(aviso)
        if clave is None:
            sys.exit("Cancelado: no se exportó nada.")
        if len(clave) < 12:
            aviso = "Muy corta: tiene que tener 12 caracteres o más."
            continue
        if ventana("Escríbela otra vez para confirmar.") != clave:
            aviso = "No coincidieron. Inventa la contraseña otra vez (12 caracteres o más)."
            continue
        subprocess.run(["security", "add-generic-password", "-U", *LLAVERO, "-w", clave], check=True)
        print("Contraseña guardada en el Llavero de macOS (mesa-ons); las próximas veces no se pide.")
        return clave


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--publicar", action="store_true")
    a = ap.parse_args()
    clave = obtener_clave()
    datos = armar()
    texto = json.dumps(datos, ensure_ascii=False, separators=(",", ":"))
    sobre = cifrar(texto, clave)
    assert descifrar(sobre, clave) == texto
    SALIDA.mkdir(parents=True, exist_ok=True)
    (SALIDA / "emisores.json").write_text(json.dumps(sobre))
    ruta_meta = SALIDA / "meta.json"
    meta = json.loads(ruta_meta.read_text()) if ruta_meta.exists() else {}
    meta["emisores"] = {"corte": datos["corte"], "generado": datos["generado"], "n": len(datos["emisores"]), "cifrado": sobre["alg"]}
    ruta_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"emisores.json: {len(datos['emisores'])} emisores, corte {datos['corte']}, cifrado y verificado")
    if a.publicar:
        subprocess.run(["git", "-C", str(RAIZ), "add", "docs/data/emisores.json", "docs/data/meta.json"], check=True)
        subprocess.run(["git", "-C", str(RAIZ), "commit", "-m", f"emisores: corte {datos['corte']}"], check=True)
        subprocess.run(["git", "-C", str(RAIZ), "pull", "--rebase"], check=True)
        subprocess.run(["git", "-C", str(RAIZ), "push"], check=True)


if __name__ == "__main__":
    main()
