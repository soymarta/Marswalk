#!/usr/bin/env python3
"""
Preparación del terreno de alta resolución de Jezero para el planificador de rutas EVA (módulo 5).

Fuentes (todas públicas, NASA/USGS):
  * DTM CTX 20 m de la Terrain-Relative Navigation de Mars 2020 (USGS Astrogeology):
    JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif
    El mismo modelo con el que aterrizó Perseverance. Esfera IAU Mars 2000 (R = 3 396 190 m),
    alturas respecto al areoide de MOLA (comparables con `elev_geoid` de la traza del rover).
  * Teselas MOLA del propio repositorio (tiles/marte_xyz, Terrain-RGB con base -12000) como relleno
    fuera de la huella del DTM.
  * Traza de Perseverance (MMGIS de la misión M20, mars.nasa.gov).

Salidas:
  data/ruta/jezero_dem.png          Rejilla del planificador: PNG RGB sin pérdida, 16 bits en R(alto)+G(bajo):
                                    elev_m = (R*256 + G) / 10 - 3000   (0,1 m de precisión). Fila 0 = norte.
  data/ruta/jezero_meta.json        Georreferencia de la rejilla + metadatos de las teselas.
  tiles/jezero_dem/{z}/{x}/{y}.png  Terrain-RGB estándar (encoding 'mapbox': -10000 + v*0,1), z7-13,
                                    DTM de 20 m fundido con MOLA mediante un borde suavizado de 1 km.
  tiles/jezero_orto/{z}/{x}/{y}.webp  Ortoimagen CTX 6 m (escala de grises con tinte marciano), z7-14.
  data/ruta/m20_traverse.geojson    Recorridos (por sol) y localizaciones de Perseverance dentro del DTM.

Uso:
  source venv-marte/bin/activate
  python python/preparar_terreno_jezero.py            # descarga lo que falte y genera todo
  python python/preparar_terreno_jezero.py --solo-rejilla
  python python/preparar_terreno_jezero.py --solo-capas   # tras dejar pendiente/rugosidad/peligro.tif en data/terreno/
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from PIL import Image
from scipy import ndimage

RAIZ = Path(__file__).resolve().parent.parent
RAW = RAIZ / "data" / "raw"
SALIDA = RAIZ / "data" / "ruta"
TESELAS = RAIZ / "tiles" / "jezero_dem"
TESELAS_ORTO = RAIZ / "tiles" / "jezero_orto"
TERRENO_EXTERNO = RAIZ / "data" / "terreno"   # entregas del módulo 2 (terreno): pendiente/rugosidad/peligro.tif

# Contrato de capas externas → PNG de 16 bits que decodifica js/ruta/terreno.js:
#   valor = (v / 10 − offset) · escala      (v = R·256 + G; 65535 = sin dato → intransitable)
CAPAS_EXTERNAS = {
    "pendiente": {"escala": 1.0, "unidad": "grados (Horn 3×3)", "rango": (0, 90)},
    "rugosidad": {"escala": 0.1, "unidad": "metros (σ residuo 5×5)", "rango": (0, 600)},
    "peligro": {"escala": 0.001, "unidad": "fracción 0-1 (1 = prohibido)", "rango": (0, 1)},
    # 1 = verificado con HiRISE 1 m, 0 = solo CTX 20 m. El planificador penaliza levemente lo no verificado.
    "confianza": {"escala": 0.001, "unidad": "fracción 0-1 (1 = HiRISE 1 m)", "rango": (0, 1)},
}
MOLA_TILES = RAIZ / "tiles" / "marte_xyz"

URL_DTM = ("https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
           "JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif")
URL_ORTO = ("https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
            "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif")
URL_TRAZA = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json"
URL_WAYPOINTS = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"

R_MARTE = 3_396_190.0           # radio de la esfera IAU Mars 2000 usada por el DTM
OFFSET_REJILLA = 3000.0         # elev_m + 3000 >= 0 en todo Jezero (mín. ≈ -2711 m)
MOLA_BASE = -12000.0            # base con la que rio rgbify generó tiles/marte_xyz
MAPBOX_BASE = -10000.0          # base estándar que MapLibre asume con encoding 'mapbox'
Z_MIN, Z_MAX = 7, 13
BORDE_FUNDIDO_M = 1000.0
WEB_MERC = 20037508.342789244   # semieje de EPSG:3857


def descargar(url: str, destino: Path) -> Path:
    if destino.exists() and destino.stat().st_size > 0:
        return destino
    destino.parent.mkdir(parents=True, exist_ok=True)
    print(f"  ↓ {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "marswalk-planner/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(destino.with_suffix(".part"), "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    destino.with_suffix(".part").rename(destino)
    return destino


# ───────────────────────── DTM → rejilla del planificador ─────────────────────────

def leer_dtm(ruta: Path):
    with rasterio.open(ruta) as ds:
        elev = ds.read(1, masked=True).astype(np.float32)
        t = ds.transform
        nodata = ds.nodata
    if np.ma.is_masked(elev):
        # Rellena huecos (no suele haberlos) con el vecino válido más cercano.
        mask = np.ma.getmaskarray(elev)
        idx = ndimage.distance_transform_edt(mask, return_distances=False, return_indices=True)
        elev = elev.data[tuple(idx)]
    else:
        elev = np.asarray(elev)
    elev[~np.isfinite(elev)] = np.nan
    if nodata is not None:
        elev[elev == nodata] = np.nan
    # Proyección equirectangular con lat_ts = 0 → grados = metros / R.
    deg = 180.0 / math.pi / R_MARTE
    meta = {
        "fuente": "USGS Mars 2020 TRN CTX DTM 20 m (JEZ_ctx_B_soc_008, areoide MOLA)",
        "url": URL_DTM,
        "radio_m": R_MARTE,
        "ancho": int(elev.shape[1]),
        "alto": int(elev.shape[0]),
        "lon0": t.c * deg,              # borde oeste
        "lat0": t.f * deg,              # borde norte
        "dlon": t.a * deg,
        "dlat": -t.e * deg,
        "res_m": float(t.a),
        "elev_min": float(np.nanmin(elev)),
        "elev_max": float(np.nanmax(elev)),
        "codificacion": "png RGB: elev_m = (R*256+G)/10 - 3000; fila 0 = norte",
        "offset": OFFSET_REJILLA,
    }
    return elev, meta


def escribir_rejilla(elev: np.ndarray, meta: dict):
    SALIDA.mkdir(parents=True, exist_ok=True)
    v = np.round((elev + OFFSET_REJILLA) * 10.0)
    if np.nanmin(v) < 0 or np.nanmax(v) > 65535:
        sys.exit("Elevación fuera del rango codificable de la rejilla")
    v = np.nan_to_num(v, nan=0).astype(np.uint16)
    rgb = np.zeros((*v.shape, 3), np.uint8)
    rgb[..., 0] = v >> 8
    rgb[..., 1] = v & 255
    Image.fromarray(rgb, "RGB").save(SALIDA / "jezero_dem.png", optimize=True)
    print(f"  ✓ data/ruta/jezero_dem.png ({(SALIDA / 'jezero_dem.png').stat().st_size / 1e6:.1f} MB)")


# ───────────────────────── Teselas Terrain-RGB fundidas ─────────────────────────

def lonlat_a_merc(lon, lat):
    x = lon * WEB_MERC / 180.0
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * WEB_MERC / math.pi
    return x, y


def tesela_bounds(z, x, y):
    n = 2 ** z
    size = 2 * WEB_MERC / n
    minx = -WEB_MERC + x * size
    maxy = WEB_MERC - y * size
    return minx, maxy - size, minx + size, maxy


def tesela_de(lon, lat, z):
    n = 2 ** z
    xt = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    yt = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
    return int(xt), int(yt)


def mosaico_mola(tx0, ty0, tx1, ty1, z=6):
    """Decodifica (con la base correcta, -12000) un bloque de teselas MOLA."""
    filas = []
    for ty in range(ty0, ty1 + 1):
        fila = []
        for tx in range(tx0, tx1 + 1):
            p = MOLA_TILES / str(z) / str(tx) / f"{ty}.png"
            a = np.asarray(Image.open(p).convert("RGB")).astype(np.float64)
            fila.append(MOLA_BASE + (a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]) * 0.1)
        filas.append(np.hstack(fila))
    mos = np.vstack(filas).astype(np.float32)
    minx, _, _, maxy = tesela_bounds(z, tx0, ty0)
    size = 2 * WEB_MERC / 2 ** z / 256
    return mos, Affine(size, 0, minx, 0, -size, maxy)


def codificar_terrain_rgb(h: np.ndarray) -> Image.Image:
    v = np.clip(np.round((h - MAPBOX_BASE) * 10.0), 0, 2 ** 24 - 1).astype(np.uint32)
    rgb = np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")


def generar_teselas(elev: np.ndarray, meta: dict):
    # El DTM se georreferencia en grados (lon/lat marcianos tratados como EPSG:4326, igual que
    # hace el resto del proyecto con PROJ_IGNORE_CELESTIAL_BODY) para reproyectarlo a EPSG:3857.
    os.environ.setdefault("PROJ_IGNORE_CELESTIAL_BODY", "YES")
    src_t = Affine(meta["dlon"], 0, meta["lon0"], 0, -meta["dlat"], meta["lat0"])
    # Peso de fundido: 1 en el interior, rampa hasta 0 en el borde (1 km).
    dist_px = ndimage.distance_transform_edt(np.pad(np.ones_like(elev, bool), 1, constant_values=False))[1:-1, 1:-1]
    peso = np.clip((dist_px - 1) / (BORDE_FUNDIDO_M / meta["res_m"]), 0, 1).astype(np.float32)
    peso = peso * peso * (3 - 2 * peso)  # smoothstep

    lon_w, lat_n = meta["lon0"], meta["lat0"]
    lon_e = lon_w + meta["ancho"] * meta["dlon"]
    lat_s = lat_n - meta["alto"] * meta["dlat"]
    mx0, mx1 = tesela_de(lon_w, lat_n, 6)[0] - 1, tesela_de(lon_e, lat_s, 6)[0] + 1
    my0, my1 = tesela_de(lon_w, lat_n, 6)[1] - 1, tesela_de(lon_e, lat_s, 6)[1] + 1
    mola, mola_t = mosaico_mola(mx0, my0, mx1, my1)

    listado = {}
    total = 0
    for z in range(Z_MIN, Z_MAX + 1):
        x0, y0 = tesela_de(lon_w, lat_n, z)
        x1, y1 = tesela_de(lon_e, lat_s, z)
        listado[z] = [x0, y0, x1, y1]
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                minx, miny, maxx, maxy = tesela_bounds(z, tx, ty)
                dst_t = Affine((maxx - minx) / 256, 0, minx, 0, -(maxy - miny) / 256, maxy)
                h_dtm = np.full((256, 256), np.nan, np.float32)
                w = np.zeros((256, 256), np.float32)
                h_mola = np.zeros((256, 256), np.float32)
                comun = dict(src_crs="EPSG:4326", dst_transform=dst_t, dst_crs="EPSG:3857")
                reproject(elev, h_dtm, src_transform=src_t, src_nodata=np.nan, dst_nodata=np.nan,
                          resampling=Resampling.bilinear, **comun)
                reproject(peso, w, src_transform=src_t, src_nodata=None, dst_nodata=0,
                          resampling=Resampling.bilinear, **comun)
                reproject(mola, h_mola, src_transform=mola_t, src_crs="EPSG:3857",
                          dst_transform=dst_t, dst_crs="EPSG:3857", resampling=Resampling.cubic)
                w = np.where(np.isfinite(h_dtm), w, 0)
                h = w * np.nan_to_num(h_dtm) + (1 - w) * h_mola
                destino = TESELAS / str(z) / str(tx)
                destino.mkdir(parents=True, exist_ok=True)
                codificar_terrain_rgb(h).save(destino / f"{ty}.png", optimize=True)
                total += 1
    meta["teselas"] = {
        "url": "tiles/jezero_dem/{z}/{x}/{y}.png",
        "codificacion": "mapbox (-10000 + v*0.1)",
        "zoom_min": Z_MIN, "zoom_max": Z_MAX,
        "rangos": listado,
        "bounds": [lon_w, lat_s, lon_e, lat_n],
    }
    print(f"  ✓ {total} teselas en tiles/jezero_dem (z{Z_MIN}-{Z_MAX})")


# ───────────────────────── Capas del módulo de terreno (data/terreno/*.tif) ─────────────────────────

def integrar_capas_externas(meta: dict):
    """Lee data/terreno/{pendiente,rugosidad,peligro}.tif, comprueba/ajusta la rejilla y las codifica."""
    from rasterio.warp import reproject as _reproject
    deg = 180.0 / math.pi / R_MARTE
    W, H = meta["ancho"], meta["alto"]
    dst_t = Affine(meta["res_m"], 0, meta["lon0"] / deg, 0, -meta["res_m"], meta["lat0"] / deg)
    capas = {}
    leidas = {}
    for nombre, cfg in CAPAS_EXTERNAS.items():
        ruta = TERRENO_EXTERNO / f"{nombre}.tif"
        if not ruta.exists():
            continue
        with rasterio.open(ruta) as ds:
            a = ds.read(1, masked=True).astype(np.float64).filled(np.nan)
            alineada = ds.width == W and ds.height == H and all(
                abs(x - y) < 1e-3 for x, y in zip(ds.transform[:6], dst_t[:6]))
            if not alineada:
                print(f"  ! {ruta.name}: rejilla distinta ({ds.width}×{ds.height}); se reproyecta a la del DTM")
                out = np.full((H, W), np.nan)
                _reproject(a, out, src_transform=ds.transform, src_crs=ds.crs, src_nodata=np.nan,
                           dst_transform=dst_t, dst_crs=ds.crs, dst_nodata=np.nan,
                           resampling=Resampling.max if nombre == "peligro" else Resampling.bilinear)
                a = out
        leidas[nombre] = a
        lo, hi = cfg["rango"]
        # Sin `confianza.tif`, la cobertura del peligro ES la confianza: fuera de HiRISE el peligro es
        # desconocido (0 + confianza 0), no prohibido. Así un NaN fuera de cobertura no bloquea el 68 % de Jezero.
        if nombre == "peligro" and not (TERRENO_EXTERNO / "confianza.tif").exists() and np.isnan(a).mean() > 0.05:
            leidas["confianza"] = np.isfinite(a).astype(np.float64)
            print(f"  ! peligro.tif: {np.isnan(a).mean() * 100:.0f} % sin dato → peligro 0 y confianza 0 fuera de cobertura")
            a = np.where(np.isfinite(a), a, 0.0)
        fuera = np.isfinite(a) & ((a < lo) | (a > hi))
        if fuera.any():
            print(f"  ! {ruta.name}: {fuera.sum()} píxeles fuera de [{lo}, {hi}] {cfg['unidad']}; se recortan")
        v = np.where(np.isfinite(a), np.round(np.clip(a, lo, hi) / cfg["escala"] * 10), 65535).astype(np.uint16)
        rgb = np.zeros((H, W, 3), np.uint8)
        rgb[..., 0] = v >> 8
        rgb[..., 1] = v & 255
        destino = SALIDA / f"terreno_{nombre}.png"
        Image.fromarray(rgb, "RGB").save(destino, optimize=True)
        capas[nombre] = {"url": f"data/ruta/{destino.name}", "offset": 0, "escala": cfg["escala"],
                         "fuente": f"Módulo de terreno: {ruta.name} ({cfg['unidad']})"}
        print(f"  ✓ {nombre}: {np.isnan(a).mean() * 100:.2f} % sin dato → data/ruta/{destino.name}")
    if "confianza" in leidas and "confianza" not in capas:
        c = leidas["confianza"]
        v = np.round(np.clip(c, 0, 1) / CAPAS_EXTERNAS["confianza"]["escala"] * 10).astype(np.uint16)
        rgb = np.zeros((H, W, 3), np.uint8); rgb[..., 0] = v >> 8; rgb[..., 1] = v & 255
        Image.fromarray(rgb, "RGB").save(SALIDA / "terreno_confianza.png", optimize=True)
        capas["confianza"] = {"url": "data/ruta/terreno_confianza.png", "offset": 0, "escala": CAPAS_EXTERNAS["confianza"]["escala"],
                              "fuente": "Cobertura del DTM HiRISE 1 m (derivada de peligro.tif)"}
        print(f"  ✓ confianza: {c.mean() * 100:.0f} % verificado con HiRISE → data/ruta/terreno_confianza.png")
    if capas:
        meta["capas"] = capas
    else:
        meta.pop("capas", None)
        print("  (sin capas en data/terreno/: el planificador calcula pendiente y rugosidad del DTM)")


# ───────────────────────── Ortoimagen CTX ─────────────────────────

# Duotono marciano: la CTX es pancromática; el tinte es estético y se indica así en la interfaz.
RAMPA = np.array([[30, 18, 12], [92, 52, 32], [170, 104, 64], [236, 196, 150], [252, 236, 212]], np.float32)


def tintar(gris: np.ndarray) -> np.ndarray:
    x = np.clip(gris, 0, 1) * (len(RAMPA) - 1)
    i = np.clip(np.floor(x).astype(int), 0, len(RAMPA) - 2)
    f = (x - i)[..., None]
    return (RAMPA[i] * (1 - f) + RAMPA[i + 1] * f).astype(np.uint8)


def generar_orto(meta: dict, z_max: int = 14):
    ruta = descargar(URL_ORTO, RAW / "jezero_ctx_orto_6m.tif")
    with rasterio.open(ruta) as ds:
        img = ds.read(1).astype(np.float32)
        t = ds.transform
    validos = img > 0
    lo, hi = np.percentile(img[validos], [0.5, 99.5])
    norm = np.where(validos, np.clip((img - lo) / (hi - lo), 0, 1) ** 0.9, np.nan).astype(np.float32)
    deg = 180.0 / math.pi / R_MARTE
    src_t = Affine(t.a * deg, 0, t.c * deg, 0, t.e * deg, t.f * deg)
    lon_w, lat_n = t.c * deg, t.f * deg
    lon_e, lat_s = lon_w + img.shape[1] * t.a * deg, lat_n + img.shape[0] * t.e * deg
    total = 0
    rangos = {}
    for z in range(Z_MIN, z_max + 1):
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
                          resampling=Resampling.cubic if z >= 13 else Resampling.average)
                alfa = np.isfinite(out)
                if not alfa.any():
                    continue
                rgba = np.zeros((256, 256, 4), np.uint8)
                rgba[..., :3] = tintar(np.nan_to_num(out))
                rgba[..., 3] = np.where(alfa, 255, 0)
                destino = TESELAS_ORTO / str(z) / str(tx)
                destino.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgba, "RGBA").save(destino / f"{ty}.webp", quality=82, method=5)
                total += 1
    meta["orto"] = {
        "fuente": "USGS Mars 2020 TRN CTX orthoMosaic 6 m (JEZ_ctx_B_soc_008), tinte marciano sobre escala de grises",
        "url": "tiles/jezero_orto/{z}/{x}/{y}.webp", "zoom_min": Z_MIN, "zoom_max": z_max,
        "bounds": [lon_w, lat_s, lon_e, lat_n], "rangos": rangos,
    }
    print(f"  ✓ {total} teselas en tiles/jezero_orto (z{Z_MIN}-{z_max})")


# ───────────────────────── Traza de Perseverance ─────────────────────────

def preparar_traza(meta: dict):
    traza = json.loads(descargar(URL_TRAZA, RAW / "M20_traverse.json").read_text())
    puntos = json.loads(descargar(URL_WAYPOINTS, RAW / "M20_waypoints.json").read_text())
    w, s, e, n = meta["teselas"]["bounds"] if "teselas" in meta else (
        meta["lon0"], meta["lat0"] - meta["alto"] * meta["dlat"],
        meta["lon0"] + meta["ancho"] * meta["dlon"], meta["lat0"])

    def dentro(c):
        return w <= c[0] <= e and s <= c[1] <= n

    feats = []
    for f in traza["features"]:
        coords = [[round(c[0], 7), round(c[1], 7), round(c[2], 2)] for c in f["geometry"]["coordinates"] if dentro(c)]
        if len(coords) < 2:
            continue
        p = f["properties"]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                      "properties": {"tipo": "recorrido", "sol": p.get("sol"), "longitud_m": p.get("length")}})
    for f in puntos["features"]:
        p = f["properties"]
        c = f["geometry"]["coordinates"]
        if not dentro(c):
            continue
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [round(c[0], 7), round(c[1], 7)]},
                      "properties": {"tipo": "localizacion", "sol": p.get("sol"), "rmc": p.get("RMC"),
                                     "elev_m": p.get("elev_geoid"), "inclinacion_deg": p.get("tilt"),
                                     "dist_total_m": p.get("dist_total_m"), "nota": p.get("Note")}})
    out = {"type": "FeatureCollection",
           "metadata": {"fuente": "NASA/JPL-Caltech MMGIS M20 (mars.nasa.gov)", "urls": [URL_TRAZA, URL_WAYPOINTS]},
           "features": feats}
    (SALIDA / "m20_traverse.geojson").write_text(json.dumps(out, separators=(",", ":")))
    print(f"  ✓ data/ruta/m20_traverse.geojson ({len(feats)} elementos)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--solo-rejilla", action="store_true", help="no regenera teselas ni traza")
    ap.add_argument("--solo-orto", action="store_true", help="solo regenera las teselas de la ortoimagen")
    ap.add_argument("--solo-capas", action="store_true",
                    help="solo integra data/terreno/*.tif (rápido; para cuando el módulo de terreno entrega capas)")
    args = ap.parse_args()

    print("1/5 DTM CTX de Jezero")
    dtm = descargar(URL_DTM, RAW / "jezero_ctx_dtm_20m.tif")
    elev, meta = leer_dtm(dtm)
    print(f"  {meta['ancho']}×{meta['alto']} px a {meta['res_m']:.0f} m · "
          f"lon {meta['lon0']:.4f}… lat {meta['lat0']:.4f}… · {meta['elev_min']:.0f}…{meta['elev_max']:.0f} m")
    if args.solo_orto:
        previo = SALIDA / "jezero_meta.json"
        meta = {**json.loads(previo.read_text()), **{k: meta[k] for k in ("ancho", "alto", "lon0", "lat0", "res_m")}}
        print("Ortoimagen CTX 6 m")
        generar_orto(meta)
        previo.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
        return
    if args.solo_capas:
        previo = SALIDA / "jezero_meta.json"
        if previo.exists():
            meta = {**json.loads(previo.read_text()), **{k: meta[k] for k in ("ancho", "alto", "lon0", "lat0", "res_m")}}
        print("Capas del módulo de terreno")
        integrar_capas_externas(meta)
        previo.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
        print("  ✓ data/ruta/jezero_meta.json")
        return
    print("2/5 Rejilla del planificador")
    escribir_rejilla(elev, meta)
    integrar_capas_externas(meta)
    if not args.solo_rejilla:
        print("3/5 Teselas Terrain-RGB fundidas con MOLA")
        generar_teselas(elev, meta)
        print("4/5 Traza de Perseverance")
        preparar_traza(meta)
        print("5/5 Ortoimagen CTX 6 m")
        generar_orto(meta)
    (SALIDA / "jezero_meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print("  ✓ data/ruta/jezero_meta.json")


if __name__ == "__main__":
    main()
