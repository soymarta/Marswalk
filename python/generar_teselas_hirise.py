"""
Teselas de la ortoimagen HiRISE (25 cm) para la zona de la EVA, usadas por el modo astronauta y la navegación.

La ortoimagen CTX de 6 m (tiles/jezero_orto) se ve borrosa desde la altura de los ojos. Este script recorta la
ortoimagen HiRISE de USGS a la zona de la base y las paradas y genera teselas XYZ hasta z17 (~0,6 m por píxel),
con el mismo tinte marciano que la CTX para que las dos imágenes casen.

Salida:
  tiles/jezero_hirise/{z}/{x}/{y}.webp   z15-17
  data/ruta/jezero_hirise.json           fuente, zooms y límites (lo lee js/ruta/astronauta.js)

Uso (con venv-marte activado y GDAL instalado):
  python python/generar_teselas_hirise.py                 # descarga el recorte (~1,4 GB de lectura remota) y tesela
  python python/generar_teselas_hirise.py --recorte RUTA  # usa un recorte ya descargado

Fuente: USGS Astrogeology, Mars 2020 Terrain Relative Navigation HiRISE Orthorectified Image Mosaic
  JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif (MRO HiRISE, 25 cm, pancromática)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from preparar_terreno_jezero import R_MARTE, tesela_bounds, tesela_de, tintar  # mismo tinte y misma malla que la CTX

RAIZ = Path(__file__).resolve().parent.parent
URL = ("https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/"
       "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif")
TESELAS = RAIZ / "tiles" / "jezero_hirise"
Z_MIN, Z_MAX = 15, 17
MARGEN_M = 500          # alrededor de la base y las paradas
RES_RECORTE_M = 0.5     # el recorte se guarda a 0,5 m (z17 son ~0,6 m por píxel)


def zona_eva() -> tuple[float, float, float, float]:
    """Rectángulo (x_min, y_min, x_max, y_max) en metros del DTM que cubre la base y las paradas, con margen."""
    p = json.loads((RAIZ / "data" / "ruta" / "puntos_eva.json").read_text())
    pts = [(p["habitat"]["lon"], p["habitat"]["lat"])] + [(s["lon"], s["lat"]) for s in p["paradas"]]
    xs = [math.radians(lon) * R_MARTE for lon, _ in pts]
    ys = [math.radians(lat) * R_MARTE for _, lat in pts]
    return min(xs) - MARGEN_M, min(ys) - MARGEN_M, max(xs) + MARGEN_M, max(ys) + MARGEN_M


def descargar_recorte(destino: Path) -> Path:
    """Lee por HTTP solo las filas de la zona (no los 7,4 GB completos) y las guarda a 0,5 m."""
    if destino.exists():
        return destino
    x0, y0, x1, y1 = zona_eva()
    destino.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", CPL_VSIL_CURL_CHUNK_SIZE="10485760",
               GDAL_HTTP_MAX_RETRY="5", GDAL_HTTP_RETRY_DELAY="3")
    print(f"  Leyendo el recorte HiRISE de USGS ({(y1 - y0) / 0.25 * 85600 / 1e9:.1f} GB de lectura remota)...")
    subprocess.run(["gdal_translate", "-q", "-projwin", str(x0), str(y1), str(x1), str(y0),
                    "-tr", str(RES_RECORTE_M), str(RES_RECORTE_M), "-r", "average",
                    "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", f"/vsicurl/{URL}", str(destino)], check=True, env=env)
    return destino


def generar(recorte: Path):
    with rasterio.open(recorte) as ds:
        img = ds.read(1).astype(np.float32)
        t = ds.transform
    validos = img > 0
    # Mismo ajuste de tono que la CTX: percentiles 0,5-99,5 y gamma 0,9.
    lo, hi = np.percentile(img[validos], [0.5, 99.5])
    norm = np.where(validos, np.clip((img - lo) / (hi - lo), 0, 1) ** 0.9, np.nan).astype(np.float32)
    deg = 180.0 / math.pi / R_MARTE
    src_t = Affine(t.a * deg, 0, t.c * deg, 0, t.e * deg, t.f * deg)
    lon_w, lat_n = t.c * deg, t.f * deg
    lon_e, lat_s = lon_w + img.shape[1] * t.a * deg, lat_n + img.shape[0] * t.e * deg
    total, rangos = 0, {}
    for z in range(Z_MIN, Z_MAX + 1):
        x0, y0 = tesela_de(lon_w, lat_n, z)
        x1, y1 = tesela_de(lon_e, lat_s, z)
        rangos[z] = [x0, y0, x1, y1]
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                minx, miny, maxx, maxy = tesela_bounds(z, tx, ty)
                dst_t = Affine((maxx - minx) / 256, 0, minx, 0, -(maxy - miny) / 256, maxy)
                out = np.full((256, 256), np.nan, np.float32)
                reproject(norm, out, src_transform=src_t, src_crs="EPSG:4326", src_nodata=np.nan,
                          dst_transform=dst_t, dst_crs="EPSG:3857", dst_nodata=np.nan,
                          resampling=Resampling.cubic if z == Z_MAX else Resampling.average)
                alfa = np.isfinite(out)
                if not alfa.any():
                    continue
                rgba = np.zeros((256, 256, 4), np.uint8)
                rgba[..., :3] = tintar(np.nan_to_num(out))
                rgba[..., 3] = np.where(alfa, 255, 0)
                destino = TESELAS / str(z) / str(tx)
                destino.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgba, "RGBA").save(destino / f"{ty}.webp", quality=80, method=5)
                total += 1
        print(f"  z{z}: teselas x {x0}-{x1}, y {y0}-{y1}")
    meta = {
        "fuente": "USGS Mars 2020 TRN HiRISE orthoMosaic 25 cm (JEZ_hirise_soc_006), teselado a ~0,6 m; "
                  "tinte marciano sobre escala de grises",
        "url": "tiles/jezero_hirise/{z}/{x}/{y}.webp", "zoom_min": Z_MIN, "zoom_max": Z_MAX,
        "bounds": [lon_w, lat_s, lon_e, lat_n], "rangos": rangos,
    }
    (RAIZ / "data" / "ruta" / "jezero_hirise.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    peso = sum(f.stat().st_size for f in TESELAS.rglob("*.webp")) / 1e6
    print(f"  ✓ {total} teselas en tiles/jezero_hirise (z{Z_MIN}-{Z_MAX}), {peso:.1f} MB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recorte", type=Path, default=RAIZ / "data" / "raw" / "jezero_hirise_orto_eva_50cm.tif",
                    help="recorte de la ortoimagen HiRISE (si no existe, se descarga)")
    args = ap.parse_args()
    generar(descargar_recorte(args.recorte))
