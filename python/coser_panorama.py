#!/usr/bin/env python3
"""
EXPERIMENTAL, NO SE USA EN LA APP. El montaje propio de fotos raw no es fiable: en los solapes que predicen los
modelos de cámara las fotos no muestran lo mismo (comprobado el 14-11-2026). La app usa las panorámicas oficiales
de Mastcam-Z (python/preparar_panoramas_oficiales.py). Se conserva como registro del intento.

Cosido de panorámicas 360° con el flujo de OpenCV (cv2.detail), arrancando de la geometría real del rover.

1. Cámaras iniciales: cada foto trae su modelo CAHVOR (sistema del rover) y la orientación del rover (cuaternión
   rover → sitio norte-este-abajo). De ahí salen la focal, el punto principal y la rotación de cada cámara.
2. Sin distorsión: cada foto se remuestrea a una cámara estenopeica exacta con su propio CAHVOR.
3. Ajuste fino con puntos clave: SIFT entre fotos que se solapan y ajuste de haces (BundleAdjusterRay). Luego se
   vuelve a anclar el conjunto a la orientación del rover (el norte y la horizontal no se mueven).
4. Proyección equirectangular propia (norte en el centro), con las fotos que cruzan el borde duplicadas para que
   el cierre de los 360° también se funda.
5. Exposición por bloques (BlocksGainCompensator), costuras por corte de grafo (GraphCutSeamFinder, por color) y
   fusión multibanda (MultiBandBlender): sin escalones de color ni bordes visibles.

Lo usa generar_panoramas.py con --metodo coser (por defecto).
"""
import math

import numpy as np
import cv2

import generar_panoramas as g

# Sitio (norte, este, abajo) → mundo de OpenCV (x = este, y = abajo, z = norte).
P = np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]], float)


def camara_inicial(x):
    m = g.modelo(x)
    A, H, V = m["A"], m["H"], m["V"]
    hc, vc = A @ H, A @ V
    hs, vs = np.linalg.norm(np.cross(A, H)), np.linalg.norm(np.cross(A, V))
    Hp, Vp = (H - hc * A) / hs, (V - vc * A) / vs
    Rcam = np.stack([Hp, Vp, A], 1)                      # ejes de la cámara en el sistema del rover
    U, _, Vt = np.linalg.svd(Rcam)
    Rcam = U @ Vt
    Rrs = g.rot_cuaternion(g.vec(x["attitude"]))
    R = P @ Rrs @ Rcam                                   # cámara → mundo
    return dict(f=float((hs + vs) / 2), ppx=float(hc), ppy=float(vc), R=R, Rcam=Rcam, m=m)


def sin_distorsion(img, c):
    """Remuestrea la foto a la cámara estenopeica (f, ppx, ppy) con el modelo CAHVOR completo."""
    h, w = img.shape[:2]
    uu, vv = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    rc = np.stack([(uu - c["ppx"]) / c["f"], (vv - c["ppy"]) / c["f"], np.ones_like(uu)], -1).reshape(-1, 3)
    rr = rc @ c["Rcam"].T
    rr /= np.linalg.norm(rr, axis=1, keepdims=True)
    x, y, ok = g.proyectar(rr, c["m"])
    x = np.where(ok, x, -1).reshape(h, w).astype(np.float32)
    y = np.where(ok, y, -1).reshape(h, w).astype(np.float32)
    out = cv2.remap(img, x, y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    masc = cv2.remap(np.full((h, w), 255, np.uint8), x, y, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT)
    return out, masc


def angulo(R1, R2):
    c = (np.trace(R1.T @ R2) - 1) / 2
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def refinar(imgs, cams, registro):
    """SIFT + ajuste de haces desde las cámaras del rover; devuelve rotaciones y focales refinadas y re-ancladas."""
    n = len(imgs)
    sift = cv2.SIFT_create(nfeatures=2500)
    feats = []
    for im in imgs:
        gris = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
        feats.append(cv2.detail.computeImageFeatures2(sift, gris))
    # Solo se emparejan fotos cuyos ejes ópticos están a menos de 70°.
    mascara = np.zeros((n, n), np.uint8)
    for i in range(n):
        for j in range(n):
            if i != j and angulo(cams[i]["R"], cams[j]["R"]) < 70:
                mascara[i, j] = 1
    matcher = cv2.detail_BestOf2NearestMatcher(False, 0.3)
    pares = matcher.apply2(feats, mascara)
    matcher.collectGarbage()
    params = []
    for c in cams:
        cp = cv2.detail.CameraParams()
        cp.focal, cp.aspect, cp.ppx, cp.ppy = c["f"], 1.0, c["ppx"], c["ppy"]
        cp.R = c["R"].astype(np.float32)
        cp.t = np.zeros((3, 1), np.float64)
        params.append(cp)
    ajuste = cv2.detail_BundleAdjusterRay()
    ajuste.setConfThresh(0.5)
    ok, refinadas = ajuste.apply(feats, pares, params)
    if not ok:
        registro.append("ajuste de haces sin convergencia: se usan las cámaras del rover")
        return [c["R"] for c in cams], [c["f"] for c in cams]
    Rr = [np.asarray(p.R, np.float64) for p in refinadas]
    # Re-anclaje: la rotación global que mejor lleva las refinadas a las del rover (Kabsch).
    M = sum(c["R"] @ r.T for c, r in zip(cams, Rr))
    U, _, Vt = np.linalg.svd(M)
    Q = U @ Vt
    Rr = [Q @ r for r in Rr]
    fr = [float(p.focal) for p in refinadas]
    # Si una foto se aleja mucho (sin pares fiables), vuelve a su cámara original.
    cambios = []
    for k, c in enumerate(cams):
        d = angulo(c["R"], Rr[k])
        if d > 4 or abs(fr[k] / c["f"] - 1) > 0.05:
            Rr[k], fr[k] = c["R"], c["f"]
            d = -1
        cambios.append(d)
    usados = [d for d in cambios if d >= 0]
    registro.append(f"puntos clave: {sum(len(f.keypoints) for f in feats)}; corrección media "
                    f"{np.mean(usados) if usados else 0:.2f}° (máx {max(usados) if usados else 0:.2f}°); "
                    f"{cambios.count(-1)} fotos sin refinar")
    return Rr, fr


def montar_cosido(fotos, ancho, cam="NAVCAM_LEFT", el_sup=25.0, el_inf=-35.0, registro=None):
    registro = registro if registro is not None else []
    cams, imgs, mascs = [], [], []
    for x in fotos:
        c = camara_inicial(x)
        img = g.descargar_foto(x)
        u, mk = sin_distorsion(img, c)
        cams.append(c); imgs.append(u); mascs.append(mk)
    R, F = refinar(imgs, cams, registro)

    px_por_rad = ancho / (2 * math.pi)
    alto = int(round((math.radians(el_sup) - math.radians(el_inf)) * px_por_rad))
    margen = int(ancho * 0.3)
    caps, esq, tams = [], [], []
    for k, (im, mk) in enumerate(zip(imgs, mascs)):
        h, w = im.shape[:2]
        f, ppx, ppy = F[k], cams[k]["ppx"], cams[k]["ppy"]
        eje = R[k][:, 2]
        az_c = math.atan2(eje[0], eje[2])
        semi = max(math.atan(math.hypot(max(ppx, w - ppx), max(ppy, h - ppy)) / f), 0.2) + 0.05
        anchura = int(2 * semi / math.cos(min(1.2, abs(math.asin(max(-1, min(1, -eje[1])))) + semi)) * px_por_rad) + 4
        anchura = min(anchura, ancho)
        # Columna (en el lienzo extendido) del centro de la foto; norte en ancho/2 + margen.
        cc = int(round(az_c * px_por_rad + ancho / 2 + margen))
        for desplaz in (0, -ancho, ancho):                     # duplicados para cerrar los 360°
            x0 = cc + desplaz - anchura // 2
            if x0 + anchura < 0 or x0 >= ancho + 2 * margen:
                continue
            cols = np.arange(x0, x0 + anchura)
            filas = np.arange(alto)
            az = (cols - ancho / 2 - margen) / px_por_rad
            el = math.radians(el_sup) - (filas + 0.5) / px_por_rad
            AZ, EL = np.meshgrid(az, el)
            ray = np.stack([np.cos(EL) * np.sin(AZ), -np.sin(EL), np.cos(EL) * np.cos(AZ)], -1)
            cc3 = ray @ R[k]                                   # Rᵀ·rayo
            z = cc3[..., 2]
            delante = z > 0.05
            zs = np.where(delante, z, 1)
            uu = (f * cc3[..., 0] / zs + ppx).astype(np.float32)
            vv = (f * cc3[..., 1] / zs + ppy).astype(np.float32)
            uu[~delante] = -1; vv[~delante] = -1
            warp = cv2.remap(im, uu, vv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            wm = cv2.remap(mk, uu, vv, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT)
            if wm.max() == 0:
                continue
            ys, xs = np.where(wm > 0)
            a0, a1, b0, b1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            caps.append((warp[a0:a1, b0:b1], wm[a0:a1, b0:b1]))
            esq.append((int(x0 + b0), int(a0)))
            tams.append((int(b1 - b0), int(a1 - a0)))
    if not caps:
        raise RuntimeError("ninguna foto cae en la banda de elevación pedida")

    # Exposición por bloques.
    comp = cv2.detail.ExposureCompensator_createDefault(cv2.detail.ExposureCompensator_GAIN_BLOCKS)
    comp.feed(corners=esq, images=[cv2.UMat(c[0]) for c in caps], masks=[cv2.UMat(c[1]) for c in caps])
    ims_c = []
    for k, (im, mk) in enumerate(caps):
        u = cv2.UMat(im.copy())
        comp.apply(k, esq[k], u, cv2.UMat(mk))
        ims_c.append(u.get())
    # Costuras por corte de grafo a 1/4 de resolución.
    s = 0.25
    peq = [cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA).astype(np.float32) for im in ims_c]
    mpeq = [cv2.UMat(cv2.resize(mk, None, fx=s, fy=s, interpolation=cv2.INTER_NEAREST)) for _, mk in caps]
    esq_p = [(int(x * s), int(y * s)) for x, y in esq]
    costura = cv2.detail_GraphCutSeamFinder("COST_COLOR")
    mpeq = costura.find(peq, esq_p, mpeq)
    # Fusión multibanda.
    fusion = cv2.detail_MultiBandBlender()
    roi = cv2.detail.resultRoi(corners=esq, sizes=tams)
    fusion.setNumBands(int(max(1, math.log2(max(roi[2], roi[3]) / 64))) if False else 5)
    fusion.prepare(roi)
    for k, (im, mk) in enumerate(zip(ims_c, (c[1] for c in caps))):
        mc = mpeq[k].get() if isinstance(mpeq[k], cv2.UMat) else mpeq[k]
        mc = cv2.resize(cv2.dilate(mc, None), (mk.shape[1], mk.shape[0]), interpolation=cv2.INTER_LINEAR_EXACT)
        mc = cv2.bitwise_and(mc, mk)
        fusion.feed(cv2.UMat(im.astype(np.int16)), mc, esq[k])
    res, res_m = fusion.blend(None, None)
    res = res.get() if isinstance(res, cv2.UMat) else res
    res_m = res_m.get() if isinstance(res_m, cv2.UMat) else res_m
    # Al lienzo extendido y de ahí a los 360° (columna margen ↔ azimut −180°).
    ext = np.zeros((alto, ancho + 2 * margen, 3), np.float32)
    ext_m = np.zeros((alto, ancho + 2 * margen), bool)
    x0, y0 = roi[0], roi[1]
    xa, xb = max(0, x0), min(ext.shape[1], x0 + res.shape[1])
    ya, yb = max(0, y0), min(alto, y0 + res.shape[0])
    ext[ya:yb, xa:xb] = res[ya - y0:yb - y0, xa - x0:xb - x0]
    ext_m[ya:yb, xa:xb] = res_m[ya - y0:yb - y0, xa - x0:xb - x0] > 0
    pano = ext[:, margen:margen + ancho].copy()
    cub = ext_m[:, margen:margen + ancho].copy()
    # Filas con buena cobertura.
    filas = np.where(cub.mean(1) > 0.9)[0]
    if len(filas):
        a, b = filas.min(), filas.max() + 1
        pano, cub = pano[a:b], cub[a:b]
        el_top = el_sup - a / px_por_rad * 180 / math.pi
        el_bot = el_sup - b / px_por_rad * 180 / math.pi
    else:
        el_top, el_bot = el_sup, el_inf
    if not cam.startswith("MCZ"):
        # Navcam raw: balance de blancos suave hacia un tono de regolito (las fotos raw no lo traen).
        medio = pano[cub].mean(0)
        objetivo = np.array([0.62, 0.80, 1.0]) * medio.mean() / np.array([0.62, 0.80, 1.0]).mean()
        pano = pano * (0.5 + 0.5 * objetivo / np.maximum(medio, 1))
    # Huecos pequeños: desenfoque normalizado de los vecinos.
    if (~cub).any():
        h, w = pano.shape[:2]
        num = cv2.GaussianBlur(pano * cub[..., None], (0, 0), 25)
        den = cv2.GaussianBlur(cub.astype(np.float32), (0, 0), 25)
        rel = num / np.maximum(den, 1e-3)[..., None]
        rel[den < 1e-3] = pano[cub].mean(0)
        pano[~cub] = rel[~cub]
    frac = float(cub.mean())
    return np.clip(pano, 0, 255).astype(np.uint8), el_top, el_bot, frac
