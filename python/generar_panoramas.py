#!/usr/bin/env python3
"""
EXPERIMENTAL, NO SE USA EN LA APP. El montaje propio de fotos raw no es fiable: en los solapes que predicen los
modelos de cámara las fotos no muestran lo mismo (comprobado el 14-11-2026). La app usa las panorámicas oficiales
de Mastcam-Z (python/preparar_panoramas_oficiales.py). Se conserva como registro del intento.

Panorámicas 360° de cada parada con fotos reales de Perseverance (Navcam).

Para cada parada de data/ruta/puntos_eva.json:
  1. Busca en data/raw/M20_waypoints.json (MMGIS) la posición del rover de ese sol más cercana a la parada:
     da el `site` y el `drive` (la parada del rover).
  2. Pide a la API pública de raw images (la misma que usa mars.nasa.gov/mars2020/multimedia/raw-images/)
     las fotos NAVCAM_LEFT de ese sol (y de los soles vecinos si hacen falta) tomadas en ese site/drive.
  3. Coloca cada foto en una esfera con su propio modelo de cámara CAHVOR (viene en el JSON de cada foto,
     en el sistema del rover) y la orientación del rover (`attitude`, cuaternión w,x,y,z rover → sitio
     norte-este-abajo). No hay emparejado de rasgos ni nada inventado: cada píxel sale de una foto.
  4. Iguala la exposición entre fotos, funde los bordes y guarda una equirectangular centrada en el norte.

Salidas: data/ruta/panoramas/<id>.jpg y data/ruta/panoramas/panoramas.json (metadatos para el visor y
créditos). Imágenes: NASA/JPL-Caltech.

Uso:  python3 python/generar_panoramas.py [--solo ID ...] [--ancho 4096] [--sin-cache]
La API corta con HTTP 403 si se le pide muy rápido: el script espera entre peticiones y reintenta.
"""
import argparse
import json
import math
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import cv2

RAIZ = Path(__file__).resolve().parent.parent
PUNTOS = RAIZ / "data/ruta/puntos_eva.json"
WAYPOINTS = RAIZ / "data/raw/M20_waypoints.json"
SALIDA = RAIZ / "data/ruta/panoramas"
CACHE = RAIZ / "data/raw/navcam"          # fotos y respuestas de la API (no se versiona)
# Consulta con condiciones de sol: pagina de verdad (la de `&sol=` ignora `page` y repite la primera página).
API = ("https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&num=100&page={page}"
       "&order=sol%20desc&search=%7C{cam}&condition_2={sol}:sol:gte&condition_3={sol}:sol:lte")
PAUSA_S = 3.0
# El modelo CAHVOR de cada foto está en píxeles de la imagen entregada. Comprobación: |A×H|·scaleFactor = 2958 px
# en todos los tipos de foto, y una tira 1280×352 a ¼ (ancho completo del sensor) abarca 2·atan(640/739,5) ≈ 82°:
# cinco tiras cierran los 360° de la panorámica estándar de fin de trayecto (secuencia NCAM00500). Las fotos de
# 1288×968 a ½ son recortes de medio sensor (≈ 47° × 36°), no fotos completas.
ESCALA_MODELO = 1.0
# Viñeteado de Navcam (radio normalizado de la elipse → brillo relativo), medido en 28 fotos del sol 501.
VIN_R = np.array([0.0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.05, 1.15, 1.25, 1.36])
VIN_F = np.array([1.017, 1.017, 1.005, 0.998, 0.931, 0.879, 0.831, 0.809, 0.742, 0.646])


# ------------------------------------------------------------------ descarga

def curl(url, destino=None, intentos=5):
    """Descarga con curl (la API rechaza algunos clientes); espera y reintenta ante 403/errores."""
    for k in range(intentos):
        args = ["curl", "-s", "-m", "60", "-w", "%{http_code}", "-o", str(destino) if destino else "-", url]
        r = subprocess.run(args, capture_output=True)
        out = r.stdout
        codigo = out[-3:].decode() if len(out) >= 3 else "000"
        if codigo == "200":
            return out[:-3] if destino is None else True
        espera = PAUSA_S * (2 ** k)
        print(f"    HTTP {codigo}, reintento en {espera:.0f} s", file=sys.stderr)
        time.sleep(espera)
    raise RuntimeError(f"no se pudo descargar {url}")


def fotos_del_sol(sol, cam="NAVCAM_LEFT", usar_cache=True):
    f = CACHE / f"api2_{cam}_{sol:05d}.json"
    if usar_cache and f.exists():
        return json.loads(f.read_text())
    todas, vistos = [], set()
    for page in range(30):
        datos = json.loads(curl(API.format(sol=sol, page=page, cam=cam)))
        nuevas = [x for x in datos.get("images", []) if x["imageid"] not in vistos]
        vistos.update(x["imageid"] for x in nuevas)
        todas += nuevas
        time.sleep(PAUSA_S)
        if len(datos.get("images", [])) < 100 or not nuevas:
            break
    CACHE.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(todas))
    return todas


# ------------------------------------------------------------------ geometría

def vec(s):
    return np.array([float(v) for v in s.strip("()").split(",")])


def rot_cuaternion(q):
    """Cuaternión (w, x, y, z) → matriz rover → sitio (norte, este, abajo)."""
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def modelo(foto):
    partes = foto["camera"]["camera_model_component_list"].split(";")
    C, A, H, V, O, R = (vec(p) for p in partes[:6])
    return dict(C=C, A=A, H=H, V=V, O=O, R=R)


def proyectar(d, m):
    """Direcciones (N×3, sistema del rover) → píxel (col, fila) del modelo CAHVOR a escala completa.
    Puntos en el infinito: el centro C no interviene."""
    A, H, V, O, R = m["A"], m["H"], m["V"], m["O"], m["R"]
    om = d @ O
    lam = d - om[:, None] * O
    tau = np.einsum("ij,ij->i", lam, lam) / np.maximum(om * om, 1e-9)
    mu = R[0] + R[1] * tau + R[2] * tau * tau
    p = d + mu[:, None] * lam
    pa = p @ A
    # Solo rayos a menos de ~60° del eje óptico (Navcam abarca ±48° × ±37°): fuera de ese cono el
    # modelo de distorsión puede devolver píxeles válidos para direcciones que la cámara no ve.
    ok = (d @ A > 0.5) & (om > 0.5)
    pa = np.where(ok, pa, 1.0)
    return (p @ H) / pa, (p @ V) / pa, ok


# ------------------------------------------------------------------ selección de fotos

def parada_del_rover(parada, waypoints):
    """Posición del rover (site, drive) del sol de la parada más cercana a ella."""
    cand = [w for w in waypoints if w["sol"] == parada.get("sol")] or waypoints
    def dist(w):
        dx = (w["lon"] - parada["lon"]) * 59274.0 * math.cos(math.radians(parada["lat"]))
        dy = (w["lat"] - parada["lat"]) * 59274.0
        return math.hypot(dx, dy)
    w = min(cand, key=dist)
    return w, dist(w)


def distancia_m(a, b):
    dx = (a["lon"] - b["lon"]) * 59274.0 * math.cos(math.radians(b["lat"]))
    return math.hypot(dx, (a["lat"] - b["lat"]) * 59274.0)


def elegir_fotos(parada, waypoints, usar_cache, radio_m=50, cam="NAVCAM_LEFT"):
    """Entre las posiciones del rover a menos de `radio_m` de la parada (soles vecinos incluidos), la que
    tiene la panorámica Navcam más completa; a igual cobertura, la más cercana."""
    w0, _ = parada_del_rover(parada, waypoints)
    sol0 = int(parada.get("sol") or w0["sol"])
    pos = {(int(w["site"]), int(w["drive"])): w for w in waypoints}
    grupos = {}
    for dsol in (0, 1, -1, 2, -2, 3, -3):
        sol = sol0 + dsol
        if sol < 0:
            continue
        for x in fotos_del_sol(sol, cam=cam, usar_cache=usar_cache):
            if cam.startswith("MCZ") and not (x["extended"].get("dimension") == "(1648,1200)" and "EBY" in x["imageid"]):
                continue      # Mastcam-Z: solo fotos completas en color
            dim = x["extended"].get("dimension", "(0,0)").strip("()").split(",")
            if (min(int(dim[0]), int(dim[1])) < 240 or x.get("sample_type") != "Full"
                    or not x["camera"].get("camera_model_type", "").startswith("CAHV")
                    or x.get("attitude", "UNK") == "UNK"):
                continue
            try:
                clave = (int(x["site"]), int(x["drive"]))
            except (TypeError, ValueError):
                continue
            w = pos.get(clave)
            if w is None or distancia_m(w, parada) > radio_m:
                continue
            grupos.setdefault(clave, []).append(x)
        mejor = max(grupos.values(), key=cobertura, default=[])
        if cobertura(mejor) >= 300:
            break
    if not grupos:
        return [], w0, distancia_m(w0, parada)
    clave = max(grupos, key=lambda k: (cobertura(grupos[k]), -distancia_m(pos[k], parada)))
    fotos, w = grupos[clave], pos[clave]
    d = distancia_m(w, parada)
    return mejor_secuencia(fotos), w, d


def secuencia(imageid):
    m = re.search(r"(NCAM\d{5})", imageid)
    return m.group(1) if m else None


def unicas(fotos):
    """Una foto por orientación (la última) y sin las que miran al cielo (> +25°: Sol, calibración)."""
    u = {}
    for x in sorted(fotos, key=lambda x: x["date_taken_utc"]):
        e = x["extended"]
        if float(e["mastEl"]) > 25:
            continue
        # Las fotos completas de Navcam llegan en 4 teselas (recortes 2×2 del sensor) con la misma orientación:
        # la clave incluye el recorte (subframeRect) para no quedarse con una sola.
        u[(round(float(e["mastAz"]) / 3), round(float(e["mastEl"]) / 3), e["dimension"], e.get("subframeRect"))] = x
    return list(u.values())


def cobertura_real(fotos, ancho=360):
    """Fracción de la banda de elevación −50°…+10° que ve al menos una foto (con su modelo de cámara)."""
    alto = ancho // 2
    az = (np.arange(ancho) + 0.5) / ancho * 2 * np.pi - np.pi
    el = np.pi / 2 - (np.arange(alto) + 0.5) / alto * np.pi
    AZ, EL = np.meshgrid(az, el)
    d = np.stack([np.cos(EL) * np.cos(AZ), np.cos(EL) * np.sin(AZ), -np.sin(EL)], -1).reshape(-1, 3)
    cub = np.zeros(len(d), bool)
    for x in fotos:
        m = modelo(x)
        R = rot_cuaternion(vec(x["attitude"]))
        w, h = (int(v) for v in x["extended"]["dimension"].strip("()").split(","))
        u, v, ok = proyectar(d @ R, m)
        u, v = u / ESCALA_MODELO, v / ESCALA_MODELO
        cub |= ok & (u >= 0) & (u < w) & (v >= 0) & (v < h)
    banda = np.repeat(((np.degrees(el) > -50) & (np.degrees(el) < 10))[:, None], ancho, 1).reshape(-1)
    return float(cub[banda].mean())


def hora_local(x):
    m = re.search(r"M(\d\d):(\d\d)", x.get("date_taken_mars", ""))
    return int(m.group(1)) + int(m.group(2)) / 60 if m else None


def pasadas(fotos, hueco_h=0.5):
    """Agrupa las fotos en pasadas: mismo sol y sin huecos de más de `hueco_h` horas entre fotos seguidas."""
    out = []
    for sol in sorted({x["sol"] for x in fotos}):
        fs = sorted((x for x in fotos if x["sol"] == sol and hora_local(x) is not None), key=hora_local)
        actual = []
        for x in fs:
            if actual and hora_local(x) - hora_local(actual[-1]) > hueco_h:
                out.append(actual); actual = []
            actual.append(x)
        if actual:
            out.append(actual)
    return out


def mejor_secuencia(fotos):
    """Las fotos de UNA pasada de la cámara (mismo sol, menos de 30 min entre fotos): luz coherente.
    Se prefieren las fotos a resolución completa (teselas 1288×968) si cubren el horizonte; si no, la pasada de
    tiras de horizonte. A igualdad, la más cercana a mediodía (sombras cortas)."""
    mejor, nota_mejor = [], -1e9
    for fs in pasadas(fotos):
        fs = unicas(fs)
        for subconj, bonus in ((fs, 0), ([x for x in fs if x["extended"]["dimension"] in ("(1288,968)", "(1296,976)")], 15)):
            if len(subconj) < 3:
                continue
            cub = cobertura_real(subconj)
            hora = sum(hora_local(x) for x in subconj) / len(subconj)
            nota = 100 * cub + (bonus if cub > 0.85 else 0) - 3 * abs(hora - 12.5)
            if nota > nota_mejor:
                mejor, nota_mejor = subconj, nota
    return mejor or unicas(fotos)


def cobertura(fotos):
    """Grados de azimut con alguna foto (aprox., para elegir la posición del rover)."""
    cub = np.zeros(360, bool)
    for x in fotos:
        az = float(x["extended"]["mastAz"])
        for k in range(int(az - 40), int(az + 40)):
            cub[k % 360] = True
    return int(cub.sum())


# ------------------------------------------------------------------ montaje

def descargar_foto(x):
    url = x["image_files"]["full_res"]
    f = CACHE / "img" / f"{x['imageid']}{Path(url).suffix}"
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        curl(url, f)
        time.sleep(0.5)
    img = cv2.imread(str(f), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"imagen ilegible {f}")
    return img


ULTIMA_CONSISTENCIA = float("nan")
Z_SUELO = None          # altura del suelo en el sistema del rover (z hacia abajo); None = sin paralaje


def punto_superficie(d, O, z_suelo, lejos=1e4, max_suelo=400.0):
    """Punto 3D (sistema del rover) donde el rayo O + t·d choca con el suelo z = z_suelo; si no baja, a `lejos` m."""
    dz = d[:, 2]
    t = np.where(dz > 1e-3, (z_suelo - O[2]) / np.maximum(dz, 1e-3), lejos)
    t = np.where((t > 0) & (t < max_suelo), t, lejos)
    return O[None, :] + t[:, None] * d


def montar(fotos, ancho, cam="NAVCAM_LEFT"):
    alto = ancho // 2
    # Rejilla equirectangular: columna central = norte, azimut creciente hacia el este (derecha).
    az = (np.arange(ancho) + 0.5) / ancho * 2 * np.pi - np.pi
    el = np.pi / 2 - (np.arange(alto) + 0.5) / alto * np.pi
    acum = np.zeros((alto, ancho, 3), np.float32)
    peso = np.zeros((alto, ancho), np.float32)
    capas = []
    O_rover = np.mean([modelo(x)["C"] for x in fotos], axis=0)
    for x in fotos:
        img = descargar_foto(x).astype(np.float32)
        h, w = img.shape[:2]
        m = modelo(x)
        Rrs = rot_cuaternion(vec(x["attitude"]))
        # Centro de la foto en el sistema del sitio, para recortar la ventana de la esfera que ocupa.
        cs = Rrs @ m["A"]
        az_c = math.atan2(cs[1], cs[0]); el_c = -math.asin(max(-1, min(1, cs[2])))
        i0 = int((az_c - math.radians(75) + np.pi) / (2 * np.pi) * ancho)
        cols = np.arange(i0, i0 + int(ancho * 150 / 360)) % ancho
        f0 = max(0, int((np.pi / 2 - (el_c + math.radians(70))) / np.pi * alto))
        f1 = min(alto, int((np.pi / 2 - (el_c - math.radians(70))) / np.pi * alto))
        filas = np.arange(f0, f1)
        AZ, EL = np.meshgrid(az[cols], el[filas])
        d_sitio = np.stack([np.cos(EL) * np.cos(AZ), np.cos(EL) * np.sin(AZ), -np.sin(EL)], -1).reshape(-1, 3)
        d_rover = d_sitio @ Rrs                       # Rᵀ·d para cada fila
        if Z_SUELO is not None:
            # Paralaje: la cámara se desplaza ~0,3 m entre orientaciones (no está en el eje del mástil). Cada rayo
            # de la panorámica sale del centro común O y choca con el suelo (plano z = Z_SUELO del rover) o, por
            # encima del horizonte, con una esfera lejana; ese punto se proyecta desde la posición real C de la foto.
            rel = punto_superficie(d_rover, O_rover, Z_SUELO) - m["C"]
            rel /= np.linalg.norm(rel, axis=1, keepdims=True)
        else:
            rel = d_rover
        u, v, ok = proyectar(rel, m)
        # El modelo CAHVOR viene en unidades de 2 × píxel de la imagen entregada, en todos los tipos de foto
        # (|A×H|·scaleFactor = 2958 en las 13 combinaciones de tamaño y escala de los soles usados). Con ese
        # factor las fotos de una misma panorámica encajan sin huecos; sin él cubren la mitad del ángulo.
        u = u / ESCALA_MODELO; v = v / ESCALA_MODELO
        ok &= (u >= 0) & (u <= w - 1) & (v >= 0) & (v <= h - 1)
        if not ok.any():
            continue
        U = u.reshape(len(filas), len(cols)).astype(np.float32)
        Vv = v.reshape(len(filas), len(cols)).astype(np.float32)
        OK = ok.reshape(len(filas), len(cols))
        mues = cv2.remap(img, U, Vv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        # Esquinas negras (tapadas por el parasol de la cámara): no son datos.
        # Sin las esquinas extremas (r > 1,2): tienen la sombra del parasol y el viñeteado más fuerte.
        f_px = np.linalg.norm(np.cross(m["A"], m["H"])) / ESCALA_MODELO
        pp_u, pp_v = m["A"] @ m["H"] / ESCALA_MODELO, m["A"] @ m["V"] / ESCALA_MODELO
        # Radio normalizado al campo completo del sensor respecto al punto principal (semiejes 0,87·f y
        # 0,655·f: los de las fotos completas de 1288 × 968), así sirve también para las tiras de horizonte.
        if cam.startswith("MCZ"):    # Mastcam-Z: foto completa, cada una con su zoom; radio respecto a su centro
            rr = np.sqrt(((U - w / 2) / (w / 2)) ** 2 + ((Vv - h / 2) / (h / 2)) ** 2)
        else:
            rr = np.sqrt(((U - pp_u) / (f_px * 0.87)) ** 2 + ((Vv - pp_v) / (f_px * 0.655)) ** 2)
        OK &= rr < 1.2
        # Viñeteado medido en 28 fotos Navcam (mediana normalizada por radio): se corrige.
        if not cam.startswith("MCZ"):
            mues = mues / np.interp(rr, VIN_R, VIN_F)[..., None]
        # Peso radial: máximo en el centro y nulo en las esquinas (viñeteado de la óptica), así cada zona
        # de la esfera la aporta sobre todo la foto que la ve más de frente.
        r2 = rr ** 2
        borde = np.minimum(np.minimum(U, w - 1 - U), np.minimum(Vv, h - 1 - Vv))
        # Potencia alta: casi «gana la foto más centrada», con transiciones cortas (sin fantasmas).
        wgt = (np.clip(1 - r2 / 1.6, 0, 1) ** 8) * np.clip(borde / 40.0, 0, 1) * OK + 1e-6 * OK
        wgt = wgt * min(1.0, (f_px / 740.0) ** 2)      # las fotos a menor resolución (tiras) solo rellenan
        # Foto a contraluz (mirando al Sol): suelo oscuro y cielo quemado. Solo rellena si nadie más llega.
        g = img.mean(-1)
        if g[: h // 4].mean() > 3.0 * max(g[-h // 4:].mean(), 1):
            wgt = wgt * 1e-3
        capas.append((el_c, filas, cols, mues, wgt))
    if not capas:
        raise RuntimeError("ninguna foto cae en la esfera")
    # Consistencia geométrica: correlación normalizada media en los solapes del suelo (por debajo de −3°) entre
    # pares de fotos de orientaciones distintas. 1 = coinciden; sirve para comparar métodos y alturas del suelo.
    global ULTIMA_CONSISTENCIA
    fila_el = 90 - (np.arange(alto) + 0.5) / alto * 180
    suma, pesos = 0.0, 0.0
    for i in range(len(capas)):
        for j in range(i + 1, len(capas)):
            ei, fi, ci, mi, wi = capas[i]
            ej, fj, cj, mj, wj = capas[j]
            if abs(ei - ej) < 1e-6 and False:
                continue
            ff = np.intersect1d(fi, fj); cc = np.intersect1d(ci, cj)
            ff = ff[fila_el[ff] < -3]
            if len(ff) < 20 or len(cc) < 20:
                continue
            ri = np.searchsorted(fi, ff); rj = np.searchsorted(fj, ff)
            ki = np.array([np.where(ci == c)[0][0] for c in cc]); kj = np.array([np.where(cj == c)[0][0] for c in cc])
            gi = mi[np.ix_(ri, ki)].mean(-1); gj = mj[np.ix_(rj, kj)].mean(-1)
            m = (wi[np.ix_(ri, ki)] > 0) & (wj[np.ix_(rj, kj)] > 0)
            if m.sum() < 150:
                continue
            a_, b_ = gi[m] - gi[m].mean(), gj[m] - gj[m].mean()
            ncc = float((a_ * b_).sum() / np.sqrt((a_ * a_).sum() * (b_ * b_).sum() + 1e-9))
            suma += ncc * m.sum(); pesos += m.sum()
    ULTIMA_CONSISTENCIA = suma / pesos if pesos else float("nan")
    # Exposición: ajuste global iterativo. Cada foto se escala (por canal) para coincidir con la media de todas
    # las fotos que la solapan; se repite hasta estabilizar y se normaliza la media geométrica de las ganancias.
    mascaras = [(wgt > 0).astype(np.float32) for _, _, _, _, wgt in capas]
    gan = [np.ones(3, np.float32) for _ in capas]
    for _ in range(4):
        acum[:] = 0; peso[:] = 0
        for (el_c, filas, cols, mues, wgt), m, gk in zip(capas, mascaras, gan):
            ix = np.ix_(filas, cols)
            acum[ix] += mues * gk * m[..., None]
            peso[ix] += m
        media = acum / np.maximum(peso, 1e-6)[..., None]
        for k, ((el_c, filas, cols, mues, wgt), m) in enumerate(zip(capas, mascaras)):
            ix = np.ix_(filas, cols)
            sol = (m > 0) & (peso[ix] > 1.5)          # solo donde hay otra foto además de esta
            if sol.sum() > 2000:
                g = (np.median(media[ix][sol], 0) + 1) / (np.median((mues * gan[k])[sol], 0) + 1)
                gan[k] = np.clip(gan[k] * g, 0.4, 2.5)
        gm = np.exp(np.mean([np.log(g) for g in gan], 0))
        gan = [g / gm for g in gan]
    acum[:] = 0; peso[:] = 0
    for (el_c, filas, cols, mues, wgt), gk in zip(capas, gan):
        ix = np.ix_(filas, cols)
        acum[ix] += mues * gk * wgt[..., None]
        peso[ix] += wgt
    pano = acum / np.maximum(peso, 1e-6)[..., None]
    cubierto = peso > 1e-7
    filas_ok = np.where(cubierto.mean(1) > 0.35)[0]
    f0, f1 = int(filas_ok.min()), int(filas_ok.max()) + 1
    f1 = min(f1, int((90 + 35) / 180 * alto))          # debajo de −35° domina la cubierta del rover
    f0 = max(f0, int((90 - 20) / 180 * alto))          # por encima de +20° solo hay cielo
    pano = pano[f0:f1]
    cub = cubierto[f0:f1]
    # Balance de blancos: las fotos raw en color no lo traen. Mundo gris sobre el suelo con foto,
    # llevado a un tono de regolito marciano (R:G:B ≈ 1 : 0,80 : 0,62). Se indica en los metadatos.
    medio = pano[cub].mean(0)
    objetivo = np.array([0.62, 0.80, 1.0]) * medio.mean() / np.array([0.62, 0.80, 1.0]).mean()   # BGR
    if not cam.startswith("MCZ"):      # EBY de Mastcam-Z ya trae el color calibrado
        pano = pano * (objetivo / np.maximum(medio, 1))
    # Cielo: casi sin textura, pero cada foto lo expuso distinto. Se suaviza en horizontal usando solo
    # píxeles de cielo (convolución normalizada), sin tocar el terreno ni el horizonte.
    gris = cv2.cvtColor(np.clip(pano, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    var = cv2.blur(gris * gris, (21, 21)) - cv2.blur(gris, (21, 21)) ** 2
    el_filas = 90 - (f0 + np.arange(pano.shape[0]) + 0.5) / alto * 180
    cielo = (np.sqrt(np.maximum(var, 0)) < 4.0) & (el_filas[:, None] > -3) & cub
    cielo = cv2.morphologyEx(cielo.astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9), np.uint8)).astype(bool)
    if cielo.any():
        sx = pano.shape[1] / 24
        pad = int(3 * sx)
        def desenfoque(a):     # gaussiano que da la vuelta en azimut (la panorámica es cerrada)
            ext = np.concatenate([a[:, -pad:], a, a[:, :pad]], axis=1)
            return cv2.GaussianBlur(ext, (0, 0), sigmaX=sx, sigmaY=8)[:, pad:-pad]
        num = desenfoque((pano * cielo[..., None]).astype(np.float32))
        den = desenfoque(cielo.astype(np.float32))
        suave = num / np.maximum(den, 1e-3)[..., None]
        transicion = cv2.GaussianBlur(cielo.astype(np.float32), (0, 0), 6)[..., None]
        pano = pano * (1 - transicion) + suave * transicion
    # Cielo (> +3°): cada foto lo expuso distinto y deja costuras. Se funde hasta +14° con un cielo muy
    # suavizado (hasta +10°) del color medido en esas mismas fotos (sin inventar contenido: es el cielo, borroso).
    el_filas = 90 - (f0 + np.arange(pano.shape[0]) + 0.5) / alto * 180
    banda = (el_filas > 2) & (el_filas < 20)
    if banda.any():
        ref = pano[banda].reshape(-1, 3)
        ref_cub = cub[banda].reshape(-1)
        color = np.median(ref[ref_cub], 0) if ref_cub.any() else ref.mean(0)
        alto_px = pano.shape[0]
        sx = pano.shape[1] / 6
        pad = int(2 * sx)
        ext = np.concatenate([pano[:, -pad:], pano, pano[:, :pad]], axis=1).astype(np.float32)
        suave = cv2.GaussianBlur(ext, (0, 0), sigmaX=sx, sigmaY=alto_px / 20)[:, pad:-pad]
        suave = 0.5 * suave + 0.5 * color
        t = np.clip((el_filas - 3) / 7, 0, 1)[:, None, None]
        pano = pano * (1 - t) + suave * t
        cub = cub | (el_filas[:, None] > 3)
    # Huecos sin foto: desenfoque normalizado de los píxeles con foto vecinos (manchas suaves, sin vetas),
    # con radios crecientes hasta cubrirlos. fraccionConFoto en los metadatos dice cuánto es foto.
    if (~cub).any():
        h, w = pano.shape[:2]
        peq = cv2.resize(pano.astype(np.float32), (w // 8, h // 8), interpolation=cv2.INTER_AREA)
        mpeq = cv2.resize(cub.astype(np.float32), (w // 8, h // 8), interpolation=cv2.INTER_AREA)
        relleno = np.zeros_like(peq); hecho = np.zeros(mpeq.shape, bool)
        for sigma in (4, 10, 25, 60):
            pad = min(3 * sigma, peq.shape[1] - 1)
            ext = lambda a: np.concatenate([a[:, -pad:], a, a[:, :pad]], axis=1)
            num = cv2.GaussianBlur(ext(peq * mpeq[..., None]), (0, 0), sigma)[:, pad:-pad]
            den = cv2.GaussianBlur(ext(mpeq), (0, 0), sigma)[:, pad:-pad]
            nuevo = (den > 0.05) & ~hecho
            relleno[nuevo] = (num / np.maximum(den, 1e-6)[..., None])[nuevo]
            hecho |= nuevo
        relleno[~hecho] = pano[cub].mean(0)
        rel = cv2.resize(relleno, (w, h), interpolation=cv2.INTER_CUBIC)
        borde = cv2.GaussianBlur(cub.astype(np.float32), (0, 0), 4)[..., None]
        pano = np.where(cub[..., None], pano, rel)
        pano = pano * np.maximum(borde, cub[..., None]) + rel * (1 - np.maximum(borde, cub[..., None]))
    el_sup = 90 - f0 / alto * 180
    el_inf = 90 - f1 / alto * 180
    return np.clip(pano, 0, 255).astype(np.uint8), el_sup, el_inf, float(cub.mean())


# ------------------------------------------------------------------ principal

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--solo", nargs="*", help="ids de parada")
    ap.add_argument("--ancho", type=int, default=4096)
    ap.add_argument("--sin-cache", action="store_true", help="vuelve a pedir la lista de fotos a la API")
    ap.add_argument("--lugar", nargs=3, type=int, metavar=("SOL", "SITE", "DRIVE"),
                    help="monta la panorámica de esa posición del rover (no de una parada)")
    ap.add_argument("--id", help="id con el que se guarda la panorámica de --lugar")
    ap.add_argument("--nombre", help="nombre mostrado de la panorámica de --lugar")
    ap.add_argument("--cam", default="NAVCAM_LEFT", help="NAVCAM_LEFT o MCZ_LEFT (Mastcam-Z, color)")
    ap.add_argument("--metodo", default="coser", choices=["coser", "geometria"],
                    help="coser: puntos clave + ajuste de haces + costuras + fusión multibanda (coser_panorama.py)")
    a = ap.parse_args()

    puntos = json.loads(PUNTOS.read_text())
    waypoints = [f["properties"] for f in json.loads(WAYPOINTS.read_text())["features"]]
    SALIDA.mkdir(parents=True, exist_ok=True)
    meta_f = SALIDA / "panoramas.json"
    meta = json.loads(meta_f.read_text()) if meta_f.exists() else {}
    meta.setdefault("paradas", {})
    meta["credito"] = "Imágenes: NASA/JPL-Caltech (Perseverance Navcam, raw images). Montaje: Marswalk."
    meta["nota"] = ("Cada píxel procede de una foto Navcam colocada con su modelo de cámara CAHVOR y la "
                    "orientación del rover. Balance de blancos automático (las fotos raw no lo traen). Los huecos pequeños sin foto se rellenan por difusión desde sus bordes; fraccionConFoto indica cuánto es foto.")

    lista = puntos["paradas"]
    if a.lugar:
        sol, site, drive = a.lugar
        w = next((x for x in waypoints if int(x["site"]) == site and int(x["drive"]) == drive), None)
        if w is None:
            sys.exit(f"no hay posición del rover site {site} drive {drive}")
        lista = [{"id": a.id or f"s{sol}-{site}-{drive}", "nombre": a.nombre or f"Perseverance, sol {sol}",
                  "lon": w["lon"], "lat": w["lat"], "sol": sol}]
    for p in lista:
        if a.solo and p["id"] not in a.solo:
            continue
        t0 = time.time()
        print(f"[{p['id']}] sol {p.get('sol')}")
        fotos, w, d = elegir_fotos(p, waypoints, not a.sin_cache, radio_m=5 if a.lugar else 50, cam=a.cam)
        print(f"  rover site {w['site']} drive {w['drive']} a {d:.0f} m; {len(fotos)} fotos, "
              f"cobertura ≈ {cobertura(fotos)}°")
        if len(fotos) < 3:
            print("  pocas fotos: se omite")
            continue
        if a.metodo == "coser":
            import coser_panorama
            registro = []
            pano, el_sup, el_inf, frac = coser_panorama.montar_cosido(fotos, a.ancho, cam=a.cam, registro=registro)
            for linea in registro:
                print("  " + linea)
        else:
            pano, el_sup, el_inf, frac = montar(fotos, a.ancho, cam=a.cam)
        archivo = f"{p['id']}.jpg"
        cv2.imwrite(str(SALIDA / archivo), pano, [cv2.IMWRITE_JPEG_QUALITY, 86, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
        soles = sorted({x["sol"] for x in fotos})
        meta["paradas"][p["id"]] = {
            "archivo": archivo, "nombre": p["nombre"],
            "soles": soles, "site": int(w["site"]), "drive": int(w["drive"]),
            "lon": w["lon"], "lat": w["lat"], "distanciaParadaM": round(d, 1),
            "fotos": len(fotos), "fraccionConFoto": round(frac, 3),
            "camara": "Mastcam-Z" if a.cam.startswith("MCZ") else "Navcam",
            "haov": 360, "vaov": round(el_sup - el_inf, 2), "vOffset": round((el_sup + el_inf) / 2, 2),
            "fechaUtc": min(x["date_taken_utc"] for x in fotos)[:10],
            "imageids": [x["imageid"] for x in fotos], "secuencia": secuencia(fotos[0]["imageid"]),
        }
        print(f"  → {archivo} {pano.shape[1]}×{pano.shape[0]}, elevación {el_inf:.0f}° a {el_sup:.0f}°, "
              f"{frac:.0%} con foto, {time.time() - t0:.0f} s")
        meta_f.write_text(json.dumps(meta, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
