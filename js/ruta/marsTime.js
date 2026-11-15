/**
 * @module marsTime
 * @description Tiempo solar marciano y posición del Sol (algoritmo Mars24 de NASA GISS:
 * Allison & McEwen 2000, Planet. Space Sci. 48, 215). Sin dependencias; vale en worker y en la página.
 */

const DEG = Math.PI / 180;
const SOL_EN_DIAS_TIERRA = 1.0274912517;
const TT_MENOS_UTC_S = 69.184; // 37 s intercalares + 32,184 s

const PBS = [
    [0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837],
    [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528],
    [0.0018, 32.8493, 49.095],
];

const mod = (a, n) => ((a % n) + n) % n;

/** Parámetros orbitales y de tiempo para un instante UTC (ms desde 1970). */
export function marsEpoch(utcMs) {
    const jdUT = utcMs / 86400000 + 2440587.5;
    const jdTT = jdUT + TT_MENOS_UTC_S / 86400;
    const dt = jdTT - 2451545.0;
    const M = mod(19.3871 + 0.52402073 * dt, 360);
    const aFMS = mod(270.3871 + 0.524038496 * dt, 360);
    let pbs = 0;
    for (const [A, tau, phi] of PBS) pbs += A * Math.cos(DEG * (0.985626 * dt / tau + phi));
    const Mr = M * DEG;
    const nuM = (10.691 + 3.0e-7 * dt) * Math.sin(Mr) + 0.623 * Math.sin(2 * Mr) + 0.050 * Math.sin(3 * Mr)
        + 0.005 * Math.sin(4 * Mr) + 0.0005 * Math.sin(5 * Mr) + pbs;
    const Ls = mod(aFMS + nuM, 360);
    const LsR = Ls * DEG;
    const eot = 2.861 * Math.sin(2 * LsR) - 0.071 * Math.sin(4 * LsR) + 0.002 * Math.sin(6 * LsR) - nuM; // grados
    const msd = (jdTT - 2451549.5) / SOL_EN_DIAS_TIERRA + 44796.0 - 0.00096;
    const mst = mod(24 * msd, 24); // horas, meridiano 0
    const dec = Math.asin(0.42565 * Math.sin(LsR)) / DEG + 0.25 * Math.sin(LsR);
    const rAU = 1.52367934 * (1.00436 - 0.09309 * Math.cos(Mr) - 0.004336 * Math.cos(2 * Mr)
        - 0.00031 * Math.cos(3 * Mr) - 0.00003 * Math.cos(4 * Mr));
    const subsolarLonEste = mod(-(mst * 15 + eot + 180) + 180, 360) - 180;
    return { msd, mst, Ls, eot, dec, rAU, subsolarLonEste };
}

/** Hora solar verdadera local (LTST, h) en una longitud este. */
export function ltst(utcMs, lonEste) {
    const e = marsEpoch(utcMs);
    return mod(e.mst + lonEste / 15 + e.eot / 15, 24);
}

/** Elevación y acimut (grados, acimut desde el norte en sentido horario) del Sol. */
export function sunPosition(utcMs, lonEste, lat) {
    const e = marsEpoch(utcMs);
    const H = (lonEste - e.subsolarLonEste) * DEG;
    const phi = lat * DEG, d = e.dec * DEG;
    const E = -Math.cos(d) * Math.sin(H);
    const N = Math.cos(phi) * Math.sin(d) - Math.sin(phi) * Math.cos(d) * Math.cos(H);
    const U = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
    return {
        elev: Math.asin(Math.max(-1, Math.min(1, U))) / DEG,
        az: mod(Math.atan2(E, N) / DEG, 360),
        Ls: e.Ls,
        // Irradiancia en el techo de la atmósfera (W/m²) — 1361 W/m² a 1 UA.
        toa: 1361 / (e.rAU * e.rAU),
    };
}

/** Instante UTC (ms) en el que la LTST de `lonEste` vale `horaObjetivo`, buscado a partir de `desdeMs`. */
export function utcForLtst(desdeMs, lonEste, horaObjetivo) {
    let t = desdeMs;
    for (let i = 0; i < 4; i++) {
        const dif = mod(horaObjetivo - ltst(t, lonEste), 24);
        const corr = (i === 0 ? dif : (dif > 12 ? dif - 24 : dif));
        t += corr * 3600000 * SOL_EN_DIAS_TIERRA;
    }
    return t;
}

/** Ortos/ocasos aproximados (LTST, h) para la latitud y la época dadas. */
export function daylight(utcMs, lonEste, lat) {
    const { dec } = marsEpoch(utcMs);
    const c = -Math.tan(lat * DEG) * Math.tan(dec * DEG);
    if (c >= 1) return { orto: null, ocaso: null, polar: 'noche' };
    if (c <= -1) return { orto: 0, ocaso: 24, polar: 'dia' };
    const h0 = Math.acos(c) / DEG / 15; // semiarco diurno en horas
    return { orto: 12 - h0, ocaso: 12 + h0 };
}

/** Número de sol marciano (MSD) y estación (Ls) en texto. */
export function seasonLabel(Ls) {
    const s = ['Primavera N', 'Verano N', 'Otoño N', 'Invierno N'][Math.floor(Ls / 90) % 4];
    const polvo = Ls >= 180 && Ls <= 330;
    return { texto: `Ls ${Ls.toFixed(0)}° · ${s}`, temporadaPolvo: polvo };
}

export const formatHora = h => {
    const hh = Math.floor(mod(h, 24));
    const mm = Math.floor((mod(h, 24) - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export const SOL_MS = SOL_EN_DIAS_TIERRA * 86400000;
