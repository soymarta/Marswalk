/**
 * @module validacion
 * @author Hani
 * @description Tramos de validación a partir de la traza real de Perseverance (MMGIS M20).
 * Se usan conducciones de UN solo sol (lo que el equipo del rover planificó de una vez), no secuencias de
 * varios soles con idas y vueltas científicas. Compartido por la interfaz y por el script de calibración.
 */

const R_DEF = 3396190;

function distancia(R, a, b) {
    const r = Math.PI / 180;
    return R * Math.hypot((b[0] - a[0]) * r * Math.cos(a[1] * r), (b[1] - a[1]) * r);
}

/**
 * Une los segmentos de cada sol en una conducción y devuelve las que sirven para comparar:
 * recta ≥ 150 m, sin saltos > 60 m entre puntos y dentro de la rejilla de alta resolución.
 */
export function construirTramos(traza, meta, { minRecta = 150, maxSalto = 60 } = {}) {
    const R = meta?.radio_m || R_DEF;
    const [w, s, e, n] = meta?.teselas?.bounds || [-180, -90, 180, 90];
    const porSol = new Map();
    for (const f of traza.features) {
        if (f.properties.tipo !== 'recorrido' || f.geometry.type !== 'LineString') continue;
        const sol = f.properties.sol;
        if (!porSol.has(sol)) porSol.set(sol, []);
        porSol.get(sol).push(...f.geometry.coordinates.map(c => [c[0], c[1]]));
    }
    const tramos = [];
    for (const [sol, pts] of [...porSol.entries()].sort((a, b) => a[0] - b[0])) {
        if (pts.length < 3) continue;
        if (pts.some(p => p[0] < w || p[0] > e || p[1] < s || p[1] > n)) continue;
        let roto = false, largo = 0;
        for (let i = 1; i < pts.length; i++) { const d = distancia(R, pts[i - 1], pts[i]); if (d > maxSalto) { roto = true; break; } largo += d; }
        if (roto) continue;
        const recta = distancia(R, pts[0], pts[pts.length - 1]);
        if (recta < minRecta) continue;
        tramos.push({ soles: String(sol), sol, real: pts, longitud: largo, tortuosidad: largo / recta });
    }
    return tramos;
}
