"""Sube la versión anti-caché (?v=AAAAMMDDx) en index.html y en los imports de los módulos, y corre las pruebas.

Uso, antes de cada publicación que toque js o css:  python3 scripts/version.py
Hoy con otra versión del mismo día pasa a la letra siguiente (…16a → …16b); un día nuevo arranca en «a».
"""
import datetime, pathlib, re, shutil, subprocess, sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARCHIVOS = [RAIZ / "docs/index.html", *sorted((RAIZ / "docs/js").glob("*.js"))]
PATRON = re.compile(r"\?v=(\d{8})([a-z])")


def main():
    hoy = datetime.date.today().strftime("%Y%m%d")
    vistas = {m.groups() for f in ARCHIVOS for m in PATRON.finditer(f.read_text())}
    if not vistas:
        sys.exit("no encontré ningún ?v= que subir")
    ult = max(vistas)
    nueva = hoy + (chr(ord(ult[1]) + 1) if ult[0] == hoy else "a")
    if ult[0] > hoy or nueva[-1] > "z":
        sys.exit(f"versión actual {''.join(ult)}: revisar a mano")
    for f in ARCHIVOS:
        t = f.read_text()
        n = PATRON.sub(f"?v={nueva}", t)
        if n != t:
            f.write_text(n)
            print(f"{f.relative_to(RAIZ)}: {len(PATRON.findall(t))} → v={nueva}")
    bun = shutil.which("bun") or str(pathlib.Path.home() / ".bun/bin/bun")
    if pathlib.Path(bun).exists():
        r = subprocess.run([bun, "test"], cwd=RAIZ, capture_output=True, text=True)
        print((r.stdout + r.stderr).strip().splitlines()[-4] if r.returncode == 0 else r.stdout + r.stderr)
        if r.returncode:
            sys.exit("pruebas en rojo: no publicar")


if __name__ == "__main__":
    main()
