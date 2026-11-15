#!/usr/bin/env python3
"""
Panorámicas 360° oficiales de Mastcam-Z (NASA/JPL-Caltech/ASU/MSSS) para las paradas de la demo.

Fuente: colección 360° del equipo de Mastcam-Z, https://mastcamz.asu.edu/mastcam-zs-360-panorama-collection/
Uso público con crédito «NASA/JPL-Caltech/ASU/MSSS» y cita de Bell et al., LPSC 2025, resumen #1719.
Proyección: cilíndrica simple, 360° en azimut, 0° (norte del sistema de sitio) en el centro.

El script descarga (si falta) la versión «natural» L0 de cada panorámica en data/raw/mastcamz/ (no se versiona),
la reduce a 8192 px de ancho para la web y escribe sus metadatos en data/ruta/panoramas/panoramas.json, con los
objetos de interés que el asistente de voz puede consultar (#15).

Elevaciones: la colección no da el rango vertical de estas panorámicas. Se estima con píxeles cuadrados
(vaov = 360 · alto / ancho) y el horizonte lejano a ≈ 0°. Es una aproximación y se indica en los metadatos.
Uso: python3 python/preparar_panoramas_oficiales.py
"""
import json
import subprocess
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None
RAIZ = Path(__file__).resolve().parent.parent
RAW = RAIZ / "data/raw/mastcamz"
SALIDA = RAIZ / "data/ruta/panoramas"
ANCHO_WEB = 8192
BASE = "https://mcz-images.sese.asu.edu/"
CREDITO = ("Panorámica oficial de Mastcam-Z: NASA/JPL-Caltech/ASU/MSSS. Cita: Bell et al., LPSC 2025, #1719. "
           "Elevación estimada a partir del horizonte")

FUENTES_WILDCAT = [
    "https://www.jpl.nasa.gov/news/nasas-perseverance-rover-investigates-geologically-rich-mars-terrain/",
    "https://science.nasa.gov/mission/mars-2020-perseverance/mars-rock-samples/",
    "https://mastcamz.asu.edu/sample-cores-part-2-the-delta-edition/",
]

PANORAMAS = {
    "wildcat-ridge": {
        # Rover aparcado en site 26, drive 1222 (sol 502); no hay trayectos registrados hasta el sol 535.
        "lon": 77.40592, "lat": 18.45865, "nombreCorto": "Wildcat Ridge",
        "archivo_raw": "Mastcam-Z_360_Wildcat_Ridge_Sols518-534_L0_natural.jpg",
        "titulo": "Panorámica 360° n.º 20 «Wildcat Ridge»", "soles": [518, 534], "elevSup": 25.0,
        "objetos": [{
            "id": "roca-wildcat-ridge", "nombre": "Roca Wildcat Ridge (parche de abrasión y dos taladros)",
            # Localizada en la panorámica a resolución completa: parche de abrasión circular junto a dos taladros,
            # como describe la tabla de muestras de NASA para Bearwallow («two drill holes and an abrasion patch»).
            "xPx": 6542, "yPx": 6581,
            "que": "Roca de aproximadamente 1 m que probablemente se formó hace miles de millones de años cuando lodo y arena fina se depositaron en un lago salado que se evaporaba.",
            "minerales": "SHERLOC detectó moléculas orgánicas correlacionadas espacialmente con minerales de sulfato; según el equipo de Mastcam-Z, PIXL y SHERLOC indican material de sulfato y moléculas orgánicas simples en una roca de grano muy fino.",
            "muestras": "Testigos Hazeltop (sol 509) y Bearwallow (sol 516); parche de abrasión Berry Hollow.",
            "porque": "Son las detecciones orgánicas más abundantes de la misión hasta 2022, en un ambiente donde la vida podría haber prosperado. Las moléculas orgánicas no son prueba de vida.",
            "fuentes": FUENTES_WILDCAT,
            "precision": "Posición localizada a ojo en la panorámica (parche y taladros visibles); pendiente de revisión de Ciencia.",
        }],
    },
    "three-forks": {
        # Rover en site 32, drive 672 (sol 670).
        "lon": 77.40824, "lat": 18.45281, "nombreCorto": "Three Forks",
        "archivo_raw": "Mastcam-Z_360_Three_Forks_Depot_1_Sol670_L0_natural.jpg",
        "titulo": "Panorámica 360° n.º 23 «Three Forks Sample Depot #1»", "soles": [670], "elevSup": 13.0,
        "objetos": [],   # los tubos no están localizados en la imagen: no se marca ninguno
    },
    "rockytop": {
        # Rover en site 26, drive 756 (sol 464) hasta el trayecto del sol 474: a ~16 m de Wildcat Ridge y a 180 m de
        # la parada Hawksbill Gap. Es un mirador propio, no la panorámica de Hawksbill Gap.
        "lon": 77.40601, "lat": 18.45879, "nombreCorto": "Rockytop",
        "archivo_raw": "Mastcam-Z_360_Rockytop_Scarp_Sols466-474_L0_natural_2x.jpg",
        "titulo": "Panorámica 360° n.º 18 «Rockytop Scarp» (frente del delta)", "soles": [466, 474], "elevSup": 25.0,
        "objetos": [],
    },
}


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    SALIDA.mkdir(parents=True, exist_ok=True)
    meta = {"credito": CREDITO, "paradas": {}, "miradores": {}}
    puntos = json.loads((RAIZ / "data/ruta/puntos_eva.json").read_text())
    for pid, cfg in PANORAMAS.items():
        raw = RAW / cfg["archivo_raw"]
        if not raw.exists():
            subprocess.run(["curl", "-s", "-L", "-m", "3600", "-o", str(raw), BASE + cfg["archivo_raw"]], check=True)
        im = Image.open(raw)
        W, H = im.size
        im.draft("RGB", (ANCHO_WEB, int(ANCHO_WEB * H / W)))
        im = im.convert("RGB").resize((ANCHO_WEB, round(ANCHO_WEB * H / W)), Image.LANCZOS)
        archivo = f"oficial-{pid}.jpg"
        im.save(SALIDA / archivo, quality=86, progressive=True, optimize=True)
        px_grado = W / 360.0
        vaov = H / px_grado
        sup = cfg["elevSup"]
        objetos = []
        for o in cfg["objetos"]:
            o = dict(o)
            o["yaw"] = round(o.pop("xPx") / px_grado - 180, 2)
            o["pitch"] = round(sup - o.pop("yPx") / px_grado, 2)
            objetos.append(o)
        meta["miradores"][pid] = {
            "oficial": True, "archivo": archivo, "titulo": cfg["titulo"], "nombre": cfg["titulo"],
            "soles": cfg["soles"], "camara": "Mastcam-Z", "credito": CREDITO,
            "fuente": "https://mastcamz.asu.edu/mastcam-zs-360-panorama-collection/",
            "nota": "Las zonas negras son la cubierta del rover enmascarada por el equipo de Mastcam-Z.",
            "haov": 360, "vaov": round(vaov, 2), "vOffset": round(sup - vaov / 2, 2),
            "anchoOriginalPx": W, "altoOriginalPx": H, "objetos": objetos,
            "lon": cfg["lon"], "lat": cfg["lat"], "nombreCorto": cfg["nombreCorto"],
        }
        print(f"{pid}: {W}×{H} → {archivo} {ANCHO_WEB}×{im.size[1]}, vaov {vaov:.1f}°, "
              f"elevación {sup:+.0f}° a {sup - vaov:+.0f}°, {len(objetos)} objetos")
    # Cada parada usa el mirador más cercano si está a menos de 50 m (si no, no tiene panorámica).
    import math
    def dist(a, b):
        return math.hypot((a["lon"] - b["lon"]) * 59274 * math.cos(math.radians(b["lat"])), (a["lat"] - b["lat"]) * 59274)
    for parada in puntos["paradas"]:
        mid, m = min(meta["miradores"].items(), key=lambda kv: dist(kv[1], parada))
        if dist(m, parada) <= 50:
            meta["paradas"][parada["id"]] = mid
            print(f"parada {parada['id']} → mirador {mid} ({dist(m, parada):.0f} m)")
    (SALIDA / "panoramas.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
