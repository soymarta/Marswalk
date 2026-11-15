#!/usr/bin/env python3
"""
Calibración del gasto metabólico de la caminata con traje (js/ruta/eva.js) con medidas reales de NASA.

Modelo (Pandolf et al. 1977 + Santee et al. 2003, el mismo de eva.js), generalizado a cualquier gravedad g:

    M = s · [ 1,5·W  +  (g/g₀) · 2(W+L)(L/W)²  +  (a + (1−a)·g/g₀) · η(W+L)(1,5v² + 0,35·v·G) ]

  W masa corporal, L traje + carga, v velocidad, G pendiente (%), η factor de terreno.
  - El término de sostener la carga escala con el peso (g/g₀).
  - El de locomoción tiene una parte que no depende del peso (balanceo de piernas, inercia): a.
  - s: sobrecoste del traje presurizado (rigidez de articulaciones).
  En la Tierra (g = g₀, sin traje, s = 1) es exactamente Pandolf.

Datos medidos que se usan (ver docs/modelo_cuerpo.md para las referencias completas):
  [1] Norcross et al. 2008, caminata de 10 km con traje MKIII a 1/6 g (NTRS 20080014853):
      n = 6, 81,4 kg, traje 121 kg, 10 km en 95,8 min, 2374 ± 304 BTU/h, 50,8 % del VO2pico (48,7 mL/kg/min),
      O₂ 0,4 lb/h. Apolo (comparación en la misma fuente): 933 BTU/h y 0,15 lb/h de O₂.
  [2] Waligora & Horrigan 1975 (NASA SP-368, NTRS 19760005584): medias de EVA del Apolo ≈ 200-250 kcal/h;
      refrigeración sostenida del traje ≈ 500 kcal/h; supresión del sudor ≈ 400 kcal/h; bolsa de bebida 1 L.

Con un solo punto de marcha medido con traje en gravedad reducida no se pueden ajustar a la vez `a` y `s`:
se ajusta `a` a la caminata de 10 km y la incertidumbre (error de la medida y rango plausible de `s`) se
propaga por Monte Carlo hasta las predicciones en Marte. Salida: data/ruta/calibracion_metabolica.json.
Uso: python3 python/calibrar_metabolismo.py
"""
import json
from pathlib import Path

import numpy as np

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "data/ruta/calibracion_metabolica.json"

G0 = 9.80665
G_LUNA = 1.62
G_MARTE = 3.721
BTU_H_W = 0.29307107
KJ_POR_L_O2 = 20.1
G_POR_L_O2 = 1.429
LB = 0.45359237


def pandolf_terminos(W, L, v, G=0.0, eta=1.0):
    """Términos de Pandolf (W) sin escalar: reposo, carga, locomoción (con Santee en bajada)."""
    reposo = 1.5 * W
    carga = 2 * (W + L) * (L / W) ** 2
    loco = eta * (W + L) * (1.5 * v * v + 0.35 * v * G)
    if G < 0:
        loco -= eta * ((G * (W + L) * v) / 3.5 - ((W + L) * (G + 6) ** 2) / W + (25 - v * v))
    return reposo, carga, max(0.0, loco)


def potencia(W, L, v, g, a, s, G=0.0, eta=1.0):
    r, c, lo = pandolf_terminos(W, L, v, G, eta)
    gr = g / G0
    return s * (r + gr * c + (a + (1 - a) * gr) * lo)


def resolver_a(M, W, L, v, g, s, eta=1.0):
    r, c, lo = pandolf_terminos(W, L, v, 0.0, eta)
    gr = g / G0
    lg = (M / s - r - gr * c) / lo
    return (lg - gr) / (1 - gr)


def main():
    rng = np.random.default_rng(2026)
    # [1] Caminata de 10 km con traje a 1/6 g (cinta, suspensión POGO: η = 1).
    W1, L1 = 81.4, 121.0
    v1 = 10000 / (95.8 * 60)
    M1, M1_sd = 2374 * BTU_H_W, 303.9 * BTU_H_W

    # Monte Carlo: medida ± su desviación entre sujetos, sobrecoste del traje s en [1,10, 1,40] (supuesto).
    N = 20000
    M_mc = rng.normal(M1, M1_sd, N)
    s_mc = rng.uniform(1.10, 1.40, N)
    a_mc = np.clip(resolver_a(M_mc, W1, L1, v1, G_LUNA, s_mc), 0.0, 1.0)

    s_med = 1.25
    a_med = float(np.clip(resolver_a(M1, W1, L1, v1, G_LUNA, s_med), 0, 1))

    # Predicciones en Marte con el traje por defecto del planificador (75 kg + 60 kg de traje + 10 kg de carga).
    W, L = 75.0, 70.0
    casos = {
        "llano_0,77ms": dict(v=0.77, G=0.0, eta=1.2),
        "subida_10%": dict(v=0.55, G=10.0, eta=1.2),
        "bajada_10%": dict(v=0.75, G=-10.0, eta=1.2),
        "pedregal_llano": dict(v=0.55, G=0.0, eta=2.0),
    }
    pred = {}
    for nombre, c in casos.items():
        mc = np.array([potencia(W, L, c["v"], G_MARTE, a, s, c["G"], c["eta"]) for a, s in zip(a_mc[:4000], s_mc[:4000])])
        anterior = (1.5 * W + 0.7 * (2 * (W + L) * (L / W) ** 2 + max(0, pandolf_terminos(W, L, c["v"], c["G"], c["eta"])[2]))) * 1.25
        pred[nombre] = {
            "W_mediana": round(float(np.median(mc)), 1),
            "W_p5": round(float(np.percentile(mc, 5)), 1),
            "W_p95": round(float(np.percentile(mc, 95)), 1),
            "W_modelo_anterior": round(anterior, 1),
            "W_calibrado": round(potencia(W, L, c["v"], G_MARTE, a_med, s_med, c["G"], c["eta"]), 1),
        }
    llano = pred["llano_0,77ms"]
    banda = (llano["W_p5"] / llano["W_mediana"], llano["W_p95"] / llano["W_mediana"])

    # Validaciones con datos que NO se usaron para ajustar.
    vo2_pred = potencia(W1, L1, v1, G_LUNA, a_med, s_med) * 60 / (KJ_POR_L_O2 * 1000) / W1 * 1000   # mL/kg/min
    vo2_med = 0.508 * 48.7
    o2_walk_pred = M1 * 3600 / (KJ_POR_L_O2 * 1000) * G_POR_L_O2      # g/h con el M medido
    o2_apolo_pred = 933 * BTU_H_W * 3600 / (KJ_POR_L_O2 * 1000) * G_POR_L_O2
    # Apolo en la Luna andando (0,8 m/s, traje A7LB + PLSS ≈ 90 kg, regolito η 1,2-1,5): debe caer cerca
    # de las medias de EVA del Apolo (200-250 kcal/h, que además incluyen tareas más suaves).
    apolo_andar = [potencia(75, 90, 0.8, G_LUNA, a_med, s_med, 0, e) for e in (1.2, 1.5)]

    out = {
        "version": 1,
        "modelo": "M = s·[1,5W + (g/g0)·2(W+L)(L/W)² + (a + (1−a)·g/g0)·η(W+L)(1,5v² + 0,35vG)] (Pandolf 1977 + Santee 2003)",
        "parametros": {"a": round(a_med, 3), "s": s_med},
        "incertidumbre": {
            "a_p5_p95": [round(float(np.percentile(a_mc, 5)), 3), round(float(np.percentile(a_mc, 95)), 3)],
            "factor_energia_p5_p95": [round(banda[0], 3), round(banda[1], 3)],
            "nota": "Monte Carlo: medida de la caminata de 10 km ± su desviación entre sujetos y sobrecoste del traje s uniforme en [1,10, 1,40] (supuesto).",
        },
        "predicciones_marte": pred,
        "validacion": {
            "vo2_caminata_10km_mL_kg_min": {"predicho": round(vo2_pred, 1), "medido": round(vo2_med, 1),
                                            "error_pct": round(100 * (vo2_pred - vo2_med) / vo2_med, 1)},
            "o2_caminata_10km_g_h": {"predicho": round(o2_walk_pred, 0), "medido": round(0.4 * LB * 1000, 0)},
            "o2_apolo_g_h": {"predicho": round(o2_apolo_pred, 0), "medido": round(0.15 * LB * 1000, 0)},
            "apolo_andando_W": {"predicho": [round(x) for x in apolo_andar], "medias_EVA_apolo_W": [233, 291]},
        },
        "umbrales": {
            "sudor_W": round(1670e3 / 3600), "refrigeracion_sostenida_W": round(2090e3 / 3600),
            "fuente": "Waligora & Horrigan 1975 (Apolo): supresión del sudor 1670 kJ/h; refrigeración sostenida del traje 2090 kJ/h",
            "caminata_10km_pct_vo2pico": 50.8,
        },
        "agua_bebida": {"apolo_L": 1.0, "caminata_10km_L": [0.71, 0.95],
                        "fuente": "bolsa de bebida del Apolo 1 L (Waligora & Horrigan 1975); 24-32 oz en 96 min (Norcross et al. 2008)"},
        "fuentes": [
            "Norcross J. et al. 2008, Feasibility of performing a suited 10-km ambulation on the Moon (AsMA), NTRS 20080014853",
            "Waligora J.M. & Horrigan D.J. 1975, Metabolism and heat dissipation during Apollo EVA periods, NASA SP-368, NTRS 19760005584",
            "Norcross J. et al. 2010, Metabolic costs and biomechanics of inclined ambulation and exploration tasks in a planetary suit, NASA/TP-2010-216125, NTRS 20110003409",
            "Pandolf K.B. et al. 1977, J Appl Physiol 43:577-581; Santee W.R. et al. 2003, Aviat Space Environ Med",
            "Léger L.A. et al. 1988, J Sports Sci 6:93-101 (test de ida y vuelta de 20 m)",
        ],
    }
    SALIDA.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps({k: out[k] for k in ("parametros", "incertidumbre", "predicciones_marte", "validacion")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
