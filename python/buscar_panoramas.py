#!/usr/bin/env python3
"""
EXPERIMENTAL, NO SE USA EN LA APP. El montaje propio de fotos raw no es fiable: en los solapes que predicen los
modelos de cámara las fotos no muestran lo mismo (comprobado el 14-11-2026). La app usa las panorámicas oficiales
de Mastcam-Z (python/preparar_panoramas_oficiales.py). Se conserva como registro del intento.

Busca las mejores posiciones del rover para la vista 360° de la demo, cerca de NUESTRA base (hábitat de
data/ruta/puntos_eva.json, punto de partida de la EVA).

Candidatas: posiciones de Perseverance (data/raw/M20_waypoints.json) a menos de --radio m de la base. En cada una
se piden las fotos de la cámara (--cam: MCZ_LEFT = Mastcam-Z izquierda, NAVCAM_LEFT) de ese sol y del siguiente, y
se puntúa la mejor **pasada** (mismo sol, < 30 min entre fotos: luz coherente) con la misma geometría que
generar_panoramas.py:
  - cobertura real de la banda −50°…+10° con el modelo de cámara de cada foto,
  - hora solar local (mejor cerca de mediodía: sombras cortas).
Mastcam-Z: solo fotos completas en color (EBY, 1648×1200).
Salida: tabla ordenada y data/raw/navcam/candidatas_<cam>.json (no se versiona).
Uso: python3 python/buscar_panoramas.py --cam MCZ_LEFT [--radio 2000] [--max 40]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generar_panoramas as g  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent


def util(x, cam):
    if x.get("sample_type") != "Full" or x.get("attitude", "UNK") == "UNK":
        return False
    if not x["camera"].get("camera_model_type", "").startswith("CAHV"):
        return False
    if cam == "MCZ_LEFT":
        return x["extended"].get("dimension") == "(1648,1200)" and "EBY" in x["imageid"]
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cam", default="MCZ_LEFT")
    ap.add_argument("--radio", type=float, default=2000)
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args()
    base = json.loads((RAIZ / "data/ruta/puntos_eva.json").read_text())["habitat"]
    wps = [f["properties"] for f in json.loads(g.WAYPOINTS.read_text())["features"]]
    cand = sorted(((g.distancia_m(w, base), w) for w in wps), key=lambda c: c[0])
    cand = [c for c in cand if c[0] <= a.radio]
    # Un candidato por sol (las posiciones de un mismo sol comparten la consulta a la API).
    vistos, lista = set(), []
    for d, w in cand:
        if w["sol"] not in vistos:
            vistos.add(w["sol"]); lista.append((d, w))
    lista = lista[: a.max]
    print(f"{len(lista)} soles con posiciones del rover a ≤ {a.radio:.0f} m de la base ({base['nombre']})")
    filas = []
    for d0, w0 in lista:
        sol = int(w0["sol"])
        try:
            fotos = [x for x in g.fotos_del_sol(sol, cam=a.cam) if util(x, a.cam)]
        except RuntimeError as e:
            print("  ", e); continue
        pos = {(int(w["site"]), int(w["drive"])): w for w in wps}
        grupos = {}
        for x in fotos:
            try:
                k = (int(x["site"]), int(x["drive"]))
            except (TypeError, ValueError):
                continue
            if k in pos and g.distancia_m(pos[k], base) <= a.radio:
                grupos.setdefault(k, []).append(x)
        for k, fs in grupos.items():
            for pasada in g.pasadas(fs):
                pasada = g.unicas(pasada)
                if len(pasada) < 4:
                    continue
                cub = g.cobertura_real(pasada)
                hora = sum(g.hora_local(x) for x in pasada) / len(pasada)
                w = pos[k]
                fila = dict(nota=round(100 * cub - 3 * abs(hora - 12.5), 1), distBase=round(g.distancia_m(w, base)),
                            sol=sol, site=k[0], drive=k[1], fotos=len(pasada), cobertura=round(cub, 3),
                            hora=round(hora, 2), lon=w["lon"], lat=w["lat"])
                filas.append(fila)
                print(f"  {fila['distBase']:5d} m  sol {sol:4d} site {k[0]:3d} drive {k[1]:5d}  {len(pasada):3d} fotos  "
                      f"cobertura {cub:4.0%}  hora {hora:4.1f}  → {fila['nota']}")
    filas.sort(key=lambda f: -f["nota"])
    (g.CACHE / f"candidatas_{a.cam}.json").write_text(json.dumps(filas, indent=1))
    print("\nMEJORES:")
    for f in filas[:10]:
        print(json.dumps(f))


if __name__ == "__main__":
    main()
