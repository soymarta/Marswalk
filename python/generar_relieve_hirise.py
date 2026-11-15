"""
Relieve de detalle (DTM HiRISE de 1 m) para la zona de la EVA, usado por el modo astronauta.

El terreno 3D del planificador sale del DTM CTX de 20 m: desde la altura de los ojos el suelo queda liso.
Este script genera teselas de elevación (Terrain-RGB, codificación 'mapbox') hasta z16 (~1,2 m por píxel) con
el DTM HiRISE de USGS en la zona de la base y las paradas. En el borde de la zona el relieve HiRISE se funde con
el CTX para que no haya escalones, y donde HiRISE no tiene dato se usa el CTX.

Salida:
  tiles/jezero_relieve_hirise/{z}/{x}/{y}.png   z14-16
  data/ruta/jezero_relieve_hirise.json          fuente, zooms y rangos (lo lee js/ruta/astronauta.js)

Uso (con venv-marte activado):
  python python/generar_relieve_hirise.py --hirise RUTA_DTM_HIRISE.tif --ctx RUTA_DTM_CTX.tif

Fuentes (USGS Astrogeology, Mars 2020 Terrain Relative Navigation):
  JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif   (MRO HiRISE, 1 m)
  JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif           (MRO CTX, 20 m)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from preparar_terreno_jezero import R_MARTE, codificar_terrain_rgb, tesela_bounds, tesela_de
from generar_teselas_hirise import zona_eva

RAIZ = Path(__file__).resolve().parent.parent
TESELAS = RAIZ / "tiles" / "jezero_relieve_hirise"
Z_MIN, Z_MAX = 14, 16
FUNDIDO_M = 150.0   # anchura de la transición HiRISE → CTX en el borde de la zona


def leer_nan(ds, **kw):
    a = ds.read(1, **kw).astype(np.float32)
    if ds.nodata is not None:
        a[a == np.float32(ds.nodata)] = np.nan
    a[a < -1e30] = np.nan
    return a


def relieve_fundido(ruta_hirise: Path, ruta_ctx: Path):
    """DTM HiRISE de la zona de la EVA, fundido con el CTX en el borde. Devuelve (alturas, transform en metros)."""
    x0, y0, x1, y1 = zona_eva()
    with rasterio.open(ruta_hirise) as ds:
        win = from_bounds(x0, y0, x1, y1, ds.transform).round_offsets().round_lengths()
        h = leer_nan(ds, window=win)
        t = ds.window_transform(win)
        crs = ds.crs
    with rasterio.open(ruta_ctx) as ds:
        ctx = np.full(h.shape, np.nan, np.float32)
        reproject(leer_nan(ds), ctx, src_transform=ds.transform, src_crs=ds.crs, src_nodata=np.nan,
                  dst_transform=t, dst_crs=crs, dst_nodata=np.nan, resampling=Resampling.cubic)
    valido = np.isfinite(h)
    dif = np.where(valido, h - ctx, 0)
    print(f"  HiRISE − CTX en la zona: mediana {np.nanmedian(dif[valido]):+.2f} m, "
          f"p5 {np.percentile(dif[valido], 5):+.2f}, p95 {np.percentile(dif[valido], 95):+.2f}; "
          f"cobertura HiRISE {100 * valido.mean():.1f} %")
    # Peso: 0 en el borde de la zona y de los huecos, 1 a partir de FUNDIDO_M hacia dentro.
    dist = ndimage.distance_transform_edt(np.pad(valido, 1, constant_values=False))[1:-1, 1:-1] * abs(t.a)
    w = np.clip(dist / FUNDIDO_M, 0, 1).astype(np.float32)
    w = w * w * (3 - 2 * w)
    return (ctx + w * dif).astype(np.float32), t


def generar(ruta_hirise: Path, ruta_ctx: Path):
    os.environ.setdefault("PROJ_IGNORE_CELESTIAL_BODY", "YES")
    fundido, t = relieve_fundido(ruta_hirise, ruta_ctx)
    deg = 180.0 / math.pi / R_MARTE
    en_grados = lambda a: Affine(a.a * deg, 0, a.c * deg, 0, a.e * deg, a.f * deg)
    src_t = en_grados(t)
    lon_w, lat_n = t.c * deg, t.f * deg
    lon_e, lat_s = lon_w + fundido.shape[1] * t.a * deg, lat_n + fundido.shape[0] * t.e * deg
    with rasterio.open(ruta_ctx) as ds:
        ctx, ctx_t = leer_nan(ds), en_grados(ds.transform)
    total, rangos = 0, {}
    for z in range(Z_MIN, Z_MAX + 1):
        tx0, ty0 = tesela_de(lon_w, lat_n, z)
        tx1, ty1 = tesela_de(lon_e, lat_s, z)
        rangos[z] = [tx0, ty0, tx1, ty1]
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                minx, miny, maxx, maxy = tesela_bounds(z, tx, ty)
                dst_t = Affine((maxx - minx) / 256, 0, minx, 0, -(maxy - miny) / 256, maxy)
                # Base: CTX en toda la tesela (así las teselas del borde quedan completas).
                base = np.full((256, 256), np.nan, np.float32)
                reproject(ctx, base, src_transform=ctx_t, src_crs="EPSG:4326", src_nodata=np.nan,
                          dst_transform=dst_t, dst_crs="EPSG:3857", dst_nodata=np.nan, resampling=Resampling.cubic)
                fino = np.full((256, 256), np.nan, np.float32)
                reproject(fundido, fino, src_transform=src_t, src_crs="EPSG:4326", src_nodata=np.nan,
                          dst_transform=dst_t, dst_crs="EPSG:3857", dst_nodata=np.nan,
                          resampling=Resampling.bilinear if z == Z_MAX else Resampling.average)
                out = np.where(np.isfinite(fino), fino, base)
                if not np.isfinite(out).all():
                    continue  # fuera del DTM CTX: la tesela se resuelve desde el relieve general
                destino = TESELAS / str(z) / str(tx)
                destino.mkdir(parents=True, exist_ok=True)
                codificar_terrain_rgb(out).save(destino / f"{ty}.png", optimize=True)
                total += 1
        print(f"  z{z}: teselas x {tx0}-{tx1}, y {ty0}-{ty1}")
    meta = {
        "fuente": "USGS Mars 2020 TRN HiRISE DTM 1 m (JEZ_hirise_soc_006), teselado a ~1,2 m y fundido con el "
                  "DTM CTX de 20 m en el borde",
        "url": "tiles/jezero_relieve_hirise/{z}/{x}/{y}.png", "codificacion": "mapbox (-10000 + v*0.1)",
        "zoom_min": Z_MIN, "zoom_max": Z_MAX, "bounds": [lon_w, lat_s, lon_e, lat_n], "rangos": rangos,
    }
    (RAIZ / "data" / "ruta" / "jezero_relieve_hirise.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    peso = sum(f.stat().st_size for f in TESELAS.rglob("*.png")) / 1e6
    print(f"  ✓ {total} teselas en tiles/jezero_relieve_hirise (z{Z_MIN}-{Z_MAX}), {peso:.1f} MB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hirise", type=Path, required=True, help="DTM HiRISE de 1 m (USGS)")
    ap.add_argument("--ctx", type=Path, required=True, help="DTM CTX de 20 m (USGS)")
    args = ap.parse_args()
    generar(args.hirise, args.ctx)
