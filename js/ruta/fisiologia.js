/**
 * @module fisiologia
 * @author Hani (módulo 5: rutas y seguridad)
 * @description Qué le pasa al cuerpo de quien camina, minuto a minuto, y qué debe comer y beber.
 * Amplía `respuestaCuerpo` (eva.js) con un estado por zonas del cuerpo que sigue la línea de tiempo:
 * piernas (trabajo al subir y frenada al bajar), corazón y lactato (esfuerzo frente al umbral), glucógeno,
 * sudor e hidratación, manos (trabajo con guante) y radiación. Con eso propone un plan de comida y bebida
 * antes, durante y después de la salida.
 *
 * Es un modelo fisiológico con fuentes, no aprendizaje automático: solo hay un punto medido de marcha con
 * traje en gravedad reducida (docs/modelo_cuerpo.md). Los cortes de color (verde, ámbar, rojo) son
 * orientativos y están escritos aquí; no es una evaluación médica ni nutricional individual.
 */
import { G_MARTE, vo2, vo2maxLeger, VO2MAX_REFERENCIA, REFERENCIAS_CUERPO } from './eva.js';

const G_TIERRA = 9.80665;

/** Fuentes que cita la tarjeta (una vez cada una). */
export const FUENTES_FISIOLOGIA = {
    umbral: 'Faude, Kindermann & Meyer 2009, Sports Med 39:469 (umbrales de lactato: ~55-65 % del VO₂máx en personas no entrenadas, 75-85 % en entrenadas). La relación con tu VO₂máx es nuestra.',
    sustratos: 'Romijn et al. 1993, Am J Physiol 265:E380 (al 25 % del VO₂máx domina la grasa; al 65 %, mitad y mitad; al 85 %, sobre todo hidratos)',
    glucogeno: 'Reserva de glucógeno ~500 g en 70 kg (≈400 g en músculo y ≈100 g en hígado; Hearris et al. 2018, Nutrients 10:298)',
    agua: 'Perder más del 2 % del peso en agua reduce el rendimiento (Sawka et al. 2007, ACSM, Med Sci Sports Exerc 39:377). Sudor: calor por encima del umbral del traje del Apolo (Waligora & Horrigan 1975) / 2,43 MJ/kg.',
    nutricion: 'Thomas, Erdman & Burke 2016, ACSM/Academia de Nutrición/Dietistas de Canadá, Med Sci Sports Exerc 48:543',
    leche: 'Leche con cacao como bebida de recuperación: Karp et al. 2006, Int J Sport Nutr Exerc Metab 16:78. Leche: ~3,3 g de proteína y ~120 mg de calcio por 100 mL (BEDCA/USDA).',
    manos: 'La fatiga y las lesiones de manos por el guante presurizado son el problema más citado en las EVA y su entrenamiento (Strauss 2004, NASA/TP-2004-212075)',
    radiacion: 'RAD/MSL, 0,64 mSv/día en superficie (Hassler et al. 2014)',
};

/** VO₂máx (mL/kg/min) de la persona: test de 20 m si lo hay; si no, el de los sujetos de NASA. */
export function vo2maxDe(persona) {
    return persona?.etapa ? vo2maxLeger(persona.etapa, persona.edad) : VO2MAX_REFERENCIA;
}

/** Umbral de lactato estimado (% del VO₂máx): 55 % sin entrenar (~35 mL/kg/min) a 80 % muy entrenado. Orientativo. */
export function umbralLactatoPct(vo2max) {
    return Math.min(80, Math.max(55, 55 + (vo2max - 35) * 0.75));
}

/** Fracción de la energía que sale de hidratos según la intensidad (interpolación de Romijn et al. 1993). */
export function fraccionHidratos(pct) {
    const P = [[0, 0.10], [25, 0.15], [65, 0.50], [85, 0.75], [100, 0.90]];
    for (let i = 1; i < P.length; i++) if (pct <= P[i][0]) {
        const [a, fa] = P[i - 1], [b, fb] = P[i];
        return fa + (fb - fa) * (pct - a) / (b - a);
    }
    return 0.9;
}

const NIVEL = (v, ambar, rojo) => v >= rojo ? 'rojo' : v >= ambar ? 'ambar' : 'verde';

/**
 * Series acumuladas a lo largo de la ruta (una entrada por muestra) para leer el estado en cualquier instante.
 * Las paradas (trabajo de campo, 280 W) se suman aparte por tiempo, porque ocurren entre dos muestras.
 */
export function prepararFisiologia(ruta, persona, traje) {
    const s = ruta.muestras, n = s.t.length;
    const masa = traje.masaCorporal, mTotal = masa + (traje.masaTraje ?? 0) + (traje.carga ?? 0);
    const vmax = vo2maxDe(persona), lt = umbralLactatoPct(vmax);
    const sube = new Float64Array(n), baja = new Float64Array(n), pasos = new Float64Array(n);
    const hc = new Float64Array(n), sudor = new Float64Array(n), sobreLT = new Float64Array(n);
    const pct = new Float32Array(n);
    const sudorDe = (M, dt) => Math.max(0, 0.8 * (M - REFERENCIAS_CUERPO.sudorW)) * dt / 2.43e6 + 0.05 * dt / 3600; // + ~50 mL/h respirando
    const hcDe = (M, dt, p) => M * dt * fraccionHidratos(p) / 4184 / 4;   // g de hidratos (4 kcal/g)
    for (let k = 1; k < n; k++) {
        const dz = s.elev[k] - s.elev[k - 1], dt = s.dtm?.[k] ?? 0, M = s.met?.[k] ?? 0, d = s.dist[k] - s.dist[k - 1];
        const p = M > 0 ? 100 * vo2(M, masa) / vmax : 0;
        pct[k] = p;
        sube[k] = sube[k - 1] + (dz > 0 ? mTotal * G_MARTE * dz : 0);
        baja[k] = baja[k - 1] + (dz < 0 ? -mTotal * G_MARTE * dz : 0);
        pasos[k] = pasos[k - 1] + d / 0.75;
        hc[k] = hc[k - 1] + (dt > 0 ? hcDe(M, dt, p) : 0);
        sudor[k] = sudor[k - 1] + (dt > 0 ? sudorDe(M, dt) : 0);
        sobreLT[k] = sobreLT[k - 1] + (p > lt ? dt : 0);
    }
    const paradas = (ruta.paradas || []).filter(p => p.trabajoS > 0).map(p => ({ desde: p.llegadaS ?? 0, dur: p.trabajoS }));
    const Mp = REFERENCIAS_CUERPO.trabajoParadaW, pctP = 100 * vo2(Mp, masa) / vmax;
    return { s, n, masa, mTotal, vmax, lt, sube, baja, pasos, hc, sudor, sobreLT, pct, paradas,
        parada: { M: Mp, pct: pctP, hcS: hcDe(Mp, 1, pctP), sudorS: sudorDe(Mp, 1) },
        reservaHc: 500 * masa / 70 };
}

/** Estado del cuerpo en el instante `t` (s desde la salida). Sin `t`, al final de la ruta. */
export function estadoCuerpo(F, t = Infinity) {
    const { s, n } = F;
    let k = 0;
    if (t >= s.t[n - 1]) k = n - 1;
    else { let a = 0, b = n - 1; while (a < b) { const m = (a + b + 1) >> 1; if (s.t[m] <= t) a = m; else b = m - 1; } k = a; }
    // Trabajo de campo hecho hasta t
    let campoS = 0, enParada = false;
    for (const p of F.paradas) {
        const hecho = Math.min(p.dur, Math.max(0, Math.min(t, s.t[n - 1]) - p.desde));
        campoS += hecho;
        if (t >= p.desde && t < p.desde + p.dur) enParada = true;
    }
    const tierra = J => J / (F.masa * G_TIERRA);   // metros que tendrías que subir en la Tierra, sin traje, para el mismo trabajo
    const subeM = tierra(F.sube[k]), bajaM = tierra(F.baja[k]);
    const hcG = F.hc[k] + campoS * F.parada.hcS;
    const sudorL = F.sudor[k] + campoS * F.parada.sudorS;
    // Al final de la ruta no hay «ahora»: se da el pico sostenido hasta ese momento.
    const fin = t >= s.t[n - 1];
    let pico = 0;
    for (let i = 1; i <= k; i++) if ((s.dtm?.[i] ?? 0) > 0 && F.pct[i] > pico) pico = F.pct[i];
    const pctAhora = fin ? pico : enParada ? F.parada.pct : F.pct[Math.min(n - 1, k + 1)] || F.pct[k];
    const minSobreLT = F.sobreLT[k] / 60;
    const pctPeso = 100 * sudorL / F.masa;
    const dosisUSv = (s.dosis?.[k] ?? 0) * 1000;
    const zonas = {
        corazon: { nivel: pctAhora > F.lt ? 'rojo' : pctAhora > F.lt - 10 ? 'ambar' : 'verde', pct: pctAhora, pico: fin, lt: F.lt, minSobreLT },
        muslos: { nivel: NIVEL(Math.max(subeM, bajaM * 1.5), 150, 400), subeM, bajaM },
        gemelos: { nivel: NIVEL(F.pasos[k], 6000, 12000), pasos: F.pasos[k] },
        manos: { nivel: NIVEL(campoS / 60, 45, 90), min: campoS / 60 },
        glucogeno: { nivel: NIVEL(hcG / F.reservaHc, 0.3, 0.6), g: hcG, frac: hcG / F.reservaHc },
        agua: { nivel: NIVEL(pctPeso, 1, 2), L: sudorL, pctPeso },
        radiacion: { nivel: 'verde', uSv: dosisUSv },
    };
    return { t: Math.min(t, s.t[n - 1]), enParada, zonas, vmax: F.vmax };
}

/**
 * Plan de comida y bebida para la ruta entera (Thomas et al. 2016), en gramos y con ejemplos de comida real.
 * `E` = estado al final de la ruta.
 */
export function planNutricion(F, E) {
    const masa = F.masa, horas = F.s.t[F.n - 1] / 3600;
    const z = E.zonas, gastoAlto = z.glucogeno.frac > 0.3 || horas > 2.5;
    const r5 = x => Math.round(x / 5) * 5;
    const antesG = r5(masa * (gastoAlto ? 2 : 1));
    const duranteG = horas > 1 ? r5(30 * horas) : 0;
    // Beber durante: lo que repone el sudor dejando como mucho un 1 % del peso de déficit; el traje lleva una bolsa de 1 L.
    const beberL = Math.min(REFERENCIAS_CUERPO.bebidaL, Math.max(0, z.agua.L - 0.01 * masa));
    const deficitL = Math.max(0, z.agua.L - beberL);
    const protG = r5(0.3 * masa);
    const hcDespuesG = r5(masa * (gastoAlto ? 1.0 : 0.6));
    const rehidL = Math.round(deficitL * 1.5 * 10) / 10;
    // 500 mL de leche con cacao ≈ 16 g de proteína y ≈ 50 g de hidratos; si falta proteína, un complemento.
    const lecheMl = Math.min(500, Math.round(protG / 3.3 * 100 / 50) * 50), faltaProt = protG - lecheMl * 0.033;
    const ejemplo = `${lecheMl} mL de leche con cacao (≈${Math.round(lecheMl * 0.033)} g de proteína y ≈${Math.round(lecheMl * 0.1)} g de hidratos)` +
        (faltaProt > 3 ? ` y un bocadillo de pavo o queso` : '');
    return {
        antes: { titulo: '2-3 h antes', hcG: antesG,
            texto: `${antesG} g de hidratos${gastoAlto ? ' (salida larga o exigente)' : ''}: por ejemplo, un bol de avena con leche y un plátano. Poca grasa y poca fibra: dentro del traje no hay baño.` },
        durante: { titulo: 'Durante', hcG: duranteG, beberL,
            texto: `${beberL > 0 ? `Bebe unos ${beberL.toFixed(1).replace('.', ',')} L de la bolsa del traje a sorbos (cada 15-20 min)` : 'Agua de la bolsa del traje a sorbos'}${duranteG ? `, con ${duranteG} g de hidratos en total (≈30 g/h: bebida con hidratos y sales o la barrita del casco)` : ''}.` },
        despues: { titulo: 'Al volver (antes de 1-2 h)', protG, hcG: hcDespuesG, rehidL,
            texto: `${protG} g de proteína y ${hcDespuesG} g de hidratos${rehidL > 0 ? `, y ${rehidL.toFixed(1).replace('.', ',')} L de líquido (1,5 L por cada litro perdido)` : ''}. Por ejemplo: ${ejemplo}. El calcio y la vitamina D ayudan al hueso, que con 0,38 g recibe menos carga que en la Tierra.` },
        fuentes: [FUENTES_FISIOLOGIA.nutricion, FUENTES_FISIOLOGIA.leche],
    };
}

/** Frase para la voz (Jarvis) a partir del estado: qué zona va peor y qué hacer. */
export function consejoCuerpo(E, plan) {
    const z = E.zonas;
    if (z.corazon.nivel === 'rojo') return `Vas por encima de tu umbral de lactato, al ${Math.round(z.corazon.pct)} por ciento de tu capacidad. Baja el ritmo en esta subida.`;
    if (z.agua.nivel !== 'verde') return `Llevas ${z.agua.L.toFixed(1).replace('.', ',')} litros de sudor. Bebe unos sorbos de la bolsa del traje.`;
    if (z.muslos.nivel === 'rojo') return 'Tus piernas acumulan mucho trabajo, sobre todo al frenar en las bajadas. Pasos cortos al bajar.';
    if (z.glucogeno.nivel !== 'verde') return `Has gastado un ${Math.round(z.glucogeno.frac * 100)} por ciento de tu glucógeno. Toma hidratos al volver: ${plan.despues.hcG} gramos.`;
    return 'Tu cuerpo va bien: esfuerzo por debajo de tu umbral, piernas y agua dentro de lo normal.';
}

/** Silueta del cuerpo por zonas (SVG). `atrs`: atributos extra del <svg> (id, clase). Colores por CSS (.verde/.ambar/.rojo). */
export function svgCuerpo(atrs = '') {
    return `<svg ${atrs} viewBox="0 0 120 240" role="img" aria-label="Estado del cuerpo por zonas">
  <g class="neutro"><rect x="21" y="44" width="13" height="62" rx="6.5" transform="rotate(8 27 44)"/><rect x="86" y="44" width="13" height="62" rx="6.5" transform="rotate(-8 93 44)"/>
    <rect x="40" y="106" width="40" height="20" rx="8"/><ellipse cx="49" cy="230" rx="9" ry="5"/><ellipse cx="71" cy="230" rx="9" ry="5"/></g>
  <circle data-zona="radiacion" cx="60" cy="22" r="15"/>
  <rect data-zona="corazon" x="37" y="38" width="46" height="72" rx="14"/>
  <path class="icono" d="M53 60c0-4 6-6 7-1 1-5 7-3 7 1 0 5-7 9-7 9s-7-4-7-9z"/>
  <ellipse data-zona="glucogeno" cx="69" cy="92" rx="9" ry="6"/>
  <circle data-zona="manos" cx="24" cy="112" r="7"/><circle data-zona="manos" cx="96" cy="112" r="7"/>
  <rect data-zona="muslos" x="40" y="122" width="18" height="54" rx="9"/><rect data-zona="muslos" x="62" y="122" width="18" height="54" rx="9"/>
  <rect data-zona="gemelos" x="42" y="178" width="14" height="48" rx="7"/><rect data-zona="gemelos" x="64" y="178" width="14" height="48" rx="7"/>
  <path data-zona="agua" d="M106 142c0 0-8 10-8 15a8 8 0 0 0 16 0c0-5-8-15-8-15z"/>
</svg>`;
}

/** Etiquetas cortas por zona para paneles estrechos (HUD de la vista 360°). */
export const ZONAS_CORTAS = {
    corazon: ['Esfuerzo', z => `${z.pico ? 'pico ' : ''}${Math.round(z.pct)} % (umbral ${Math.round(z.lt)})`],
    muslos: ['Muslos', z => `+${Math.round(z.subeM)} / −${Math.round(z.bajaM)} m`],
    gemelos: ['Gemelos', z => `${Math.round(z.pasos).toLocaleString('es-ES')} pasos`],
    manos: ['Manos', z => `${Math.round(z.min)} min con guante`],
    glucogeno: ['Glucógeno', z => `${Math.round(z.g)} g (${Math.round(z.frac * 100)} %)`],
    agua: ['Sudor', z => `${z.L.toFixed(1).replace('.', ',')} L (${z.pctPeso.toFixed(1).replace('.', ',')} %)`],
    radiacion: ['Radiación', z => `${Math.round(z.uSv)} µSv`],
};
