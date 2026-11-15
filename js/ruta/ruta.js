/**
 * @module ruta
 * @author Hani (módulo 5: rutas y seguridad)
 * @description Interfaz del planificador Marswalk con el lenguaje de los mapas de uso diario:
 *  - Vista "Cómo llegar": puntos de paso, hora de salida, opciones de ruta con la recomendada, avisos y perfil.
 *  - Navegación paso a paso: banner verde con la maniobra, cámara en tercera persona detrás del caminante,
 *    flechas de giro dibujadas sobre el terreno, chevrones de sentido, hoja inferior con la llegada.
 *  - Imprevistos con replanificación inmediata y validación contra la traza real de Perseverance.
 * Todo el cálculo vive en planificador.worker.js (núcleo WebAssembly).
 *
 * Integración: `initRutaModule(map)` desde main.js. Condiciones ambientales: si el módulo 4 expone
 * `window.marsConditions.en(lon, lat, utcMs)` → { tempMediaC, amplitudC, tau, vientoMs, tormentaSolar },
 * se usan; si no, se leen polvo y viento de data/*.geojson y la temperatura de una climatología tipo MEDA.
 */
import { utcForLtst, daylight, formatHora, seasonLabel, marsEpoch, sunPosition } from './marsTime.js';
import { PERFILES, TRAJE_DEFECTO, NOMBRE_RECURSO, CALIBRACION, REFERENCIAS_CUERPO, respuestaCuerpo, velocidadMarcha, potenciaMetabolica, potenciaTraje } from './eva.js';
import { registrarTerreno3D, anadirCapasTerreno, anclarCamara } from './terreno3d.js';
import * as terreno3d from './terreno3d.js';
import { activarRocas, desactivarRocas, actualizarRocas, infoRocas } from './rocas3d.js';
import { LineaTiempo, indice } from './perfil.js';
import { construirTramos } from './validacion.js';
import { cargarPanoramas, hayPanorama, abrirPanorama, abrirPrincipal, precargarPanorama, MIRADOR_PRINCIPAL, objetoDelante, objetosDe, mirarPanorama } from './panorama.js';
import { construirVisor, actualizarVisor, camaraAstronauta, limitesAstronauta, leerAltura, ponerAltura, CAMARA, anadirOrtoHirise, registrarRelieveHirise, anadirDetalleSintetico, ESCALA_MAPA, mirada, fijarRumboVisor } from './astronauta.js';
import { crearMundo, EXAG as EXAG_MUNDO } from './mundo3d.js';
import { prepararFisiologia, estadoCuerpo, planNutricion, consejoCuerpo, FUENTES_FISIOLOGIA, svgCuerpo } from './fisiologia.js';

const PERFILES_UI = ['segura', 'equilibrada', 'ciencia'];
const reducirMovimiento = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Resolución nativa: DTM 20 m ≈ z13, ortoimagen CTX 6 m ≈ z14. Más zoom no añade información.
const ZOOM_MAX_RUTA = 15.6, ZOOM_NAV = 15.3, PITCH_NAV = 66;
// El relieve de Jezero es suave (el frente del delta mide ~100 m): se exagera para que se lea en 3D.
const EXAGERACION = { vista: 1.8, nav: 2.2 };
/**
 * Calidad adaptativa: el terreno 3D de MapLibre es caro cuando la cámara se mueve (en un portátil con GPU
 * integrada medimos 4 fps con terreno frente a 50 fps sin él, con la misma cámara inclinada). Si durante la
 * navegación o el sobrevuelo no se sostienen ~15 fps, se pasa a mapa inclinado (como la navegación de los mapas
 * de uso diario): misma cámara, el relieve sigue visible por el sombreado y las sombras del Sol real.
 */
const terrenoDe = () => {
    // Con el mundo 3D (js/ruta/mundo3d.js) el relieve en movimiento lo dibuja él: MapLibre navega siempre en plano.
    if (M && S.navegando) return null;
    // Modo astronauta: siempre en 3D, pase lo que pase con el botón 2D/3D o el modo fluido. La exageración
    // vertical de 3,2 hace que las montañas del cráter y el frente del delta destaquen en el horizonte.
    if (S.astronauta && S.navegando) return { source: S.relieveHr ? 'marsdem-hr' : 'marsdem', exaggeration: 3.2 };
    if (!S.tresD) return null;
    if ((S.navegando || S.volando) && S.modoFluido && !S.forzar3D) return null;
    return { source: 'marsdem', exaggeration: S.navegando ? EXAGERACION.nav : EXAGERACION.vista };
};
const rendimiento = { muestras: [], desde: 0 };
/** Mundo 3D de la navegación (null hasta que carga; si no carga, se navega con el relieve de MapLibre como antes). */
let M = null;
const mundoActivo = () => !!M && !!(S.mirador3d || S.previa || (S.navegando && (S.astronauta || S.tresD)));
/** El icono es la vista a la que se pasa al pulsarlo; el texto al pasar el ratón dice la vista actual y qué hace el clic. */
function pintarBoton3D() {
    const b = document.getElementById('mw-btn-3d');
    if (!b || !S.map) return;
    const en3D = M ? (S.navegando ? mundoActivo() : S.tresD) : !!S.map.getTerrain();
    b.innerHTML = en3D ? ICO.dosd : ICO.tresd;
    const txt = en3D ? 'Vista actual: 3D con relieve. Pulsa para ver el mapa plano (2D)'
        : 'Vista actual: mapa plano (2D). Pulsa para ver el relieve en 3D';
    b.setAttribute('aria-label', txt);
    b.title = txt;
}
// La decisión se recuerda en este navegador: las siguientes navegaciones arrancan ya fluidas.
const leerFluido = () => { try { return localStorage.getItem('marswalk.modoFluido') === '1'; } catch { return false; } };
const guardarFluido = v => { try { v ? localStorage.setItem('marswalk.modoFluido', '1') : localStorage.removeItem('marswalk.modoFluido'); } catch { /* almacenamiento no disponible */ } };
/** Llamar en cada fotograma de una animación con cámara en movimiento. */
function vigilarRendimiento(ts) {
    if (S.modoFluido || S.forzar3D || S.astronauta || !S.map.getTerrain()) return;
    const R = rendimiento;
    if (!R.desde) { R.desde = ts; R.muestras = []; R.ant = ts; return; }
    R.muestras.push(ts - R.ant); R.ant = ts;
    if (ts - R.desde < 1500 || R.muestras.length < 3) return;
    const medio = R.muestras.reduce((a, b) => a + b, 0) / R.muestras.length;
    R.desde = 0;
    if (medio > 66) {
        S.modoFluido = true; guardarFluido(true);
        S.map.setTerrain(null); anclar();
        iluminar(utcSalida() + (S.t + S.tOffset) * 1000, true);
        aviso({ titulo: 'Modo fluido activado', texto: `El relieve 3D iba a ${Math.round(1000 / medio)} fotogramas por segundo en este equipo: durante el movimiento se usa el mapa inclinado. Pulsa 3D para forzarlo.` });
    }
}
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const fmtKm = m => m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`;
const fmtDur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };
const pct = v => `${Math.round(v * 100)} %`;
const RUMBOS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const VACIO = { type: 'FeatureCollection', features: [] };

// ───────────────────────── iconos ─────────────────────────

const ICO = {
    base: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 2 12h3v8h5v-6h4v6h5v-8h3z"/></svg>',
    pie: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6A2 2 0 0 0 12 6c-.3 0-.5 0-.8.1L6 8.3V13h2V9.6z"/></svg>',
    capas: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 16.5-7.4-5.7L3 12.1l9 7 9-7-1.6-1.3zM12 14l7.4-5.7L21 7l-9-7-9 7 1.6 1.3z" transform="translate(0 2)"/></svg>',
    centrar: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>',
    brujula: '<svg viewBox="0 0 24 24"><path d="M12 2 7 12h10z" fill="#d93025"/><path d="M12 22 7 12h10z" fill="#9aa0a6"/></svg>',
    navegar: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>',
    cerrar: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg>',
    aviso: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pausa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>',
    tresd: '<svg viewBox="0 0 24 24"><text x="12" y="16" text-anchor="middle" font-family="Roboto,Arial" font-weight="700" font-size="11" fill="currentColor">3D</text></svg>',
    dosd: '<svg viewBox="0 0 24 24"><text x="12" y="16" text-anchor="middle" font-family="Roboto,Arial" font-weight="700" font-size="11" fill="currentColor">2D</text></svg>',
    voz: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
    mudo: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.4 2.4.1-.6zm2.5 0c0 .9-.2 1.8-.5 2.6l1.5 1.5A9 9 0 0 0 14 3.2v2.1a7 7 0 0 1 5 6.7zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.2c-.7.5-1.4.9-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3-9-9zM12 4 9.9 6.1 12 8.2z"/></svg>',
    meta: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>',
};

/** Icono de maniobra: tallo vertical y tramo de salida girado `giro` grados (positivo = derecha). */
function iconoGiro(giro, color = '#fff') {
    if (giro === 'llegada') return `<svg viewBox="0 0 48 48"><path d="M14 44V6h16l1 4h9v20H27l-1-4H18v18z" fill="${color}"/></svg>`;
    const a = Math.max(-150, Math.min(150, giro)) * Math.PI / 180;
    const cx = 24, cy = 24, L = 15;
    const ex = cx + Math.sin(a) * L, ey = cy - Math.cos(a) * L;
    const ux = Math.sin(a), uy = -Math.cos(a), px = -uy, py = ux;
    const punta = `${ex + ux * 7},${ey + uy * 7} ${ex + px * 7},${ey + py * 7} ${ex - px * 7},${ey - py * 7}`;
    return `<svg viewBox="0 0 48 48"><path d="M24 46V${cy} L${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${color}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/><polygon points="${punta}" fill="${color}"/></svg>`;
}

// ───────────────────────── workers ─────────────────────────

class Planificador {
    constructor() {
        this.w = new Worker(new URL('./planificador.worker.js', import.meta.url), { type: 'module' });
        this.n = 0; this.pend = new Map();
        this.w.onmessage = ({ data }) => {
            const p = this.pend.get(data.id);
            if (!p) return;
            if (data.progreso) { p.prog?.(data.progreso); return; }
            this.pend.delete(data.id);
            data.ok ? p.ok(data.res) : p.err(new Error(data.error));
        };
    }
    llamar(msg, prog) {
        const id = ++this.n;
        return new Promise((ok, err) => { this.pend.set(id, { ok, err, prog }); this.w.postMessage({ id, ...msg }); });
    }
}
let W = null, W2 = null, W3 = null; // un worker por perfil: los tres planes se calculan en paralelo
/**
 * Arranque temprano: los workers cargan el terreno en cuanto se importa este módulo, en paralelo con MapLibre
 * y con el resto de módulos (no necesitan el mapa). También se cargan ya las paradas y la traza del rover.
 */
const T0 = { importado: performance.now() };
let TERRENO = null;   // { meta, elev } del DTM de 20 m, compartido con el mundo 3D
/** Elevación real (m) del DTM de 20 m en un punto, o null fuera de Jezero o antes de cargar. */
function elevTerreno(lon, lat) {
    if (!TERRENO) return null;
    const m = TERRENO.meta, fi = (lon - m.lon0) / m.dlon - 0.5, fj = (m.lat0 - lat) / m.dlat - 0.5;
    if (fi < 0 || fj < 0 || fi > m.ancho - 1.001 || fj > m.alto - 1.001) return null;
    const i = fi | 0, j = fj | 0, a = fi - i, b = fj - j, k = j * m.ancho + i, e = TERRENO.elev;
    const v = (e[k] * (1 - a) + e[k + 1] * a) * (1 - b) + (e[k + m.ancho] * (1 - a) + e[k + m.ancho + 1] * a) * b;
    return Number.isFinite(v) ? v : null;
}
/**
 * Ancla la cámara al suelo. Mientras las teselas de relieve cargan MapLibre no sabe la altura (devuelve null o 0) y
 * la vista saldría mirando desde 4 km de altura con el cielo en negro: en ese caso se usa la del DTM de 20 m.
 */
function anclar(map = S.map) {
    S.anclando = true;
    try { anclarAlSuelo(map); } finally { S.anclando = false; }
}
function anclarAlSuelo(map) {
    const t = map.getTerrain?.();
    if (t && map.setCenterElevation) {
        const c = map.getCenter(), q = map.queryTerrainElevation(c);
        if (q == null || q === 0 || !Number.isFinite(q)) {
            const e = elevTerreno(c.lng, c.lat);
            if (e != null) { const v = e * (t.exaggeration ?? 1); if (Math.abs(v - map.getCenterElevation()) > 3) map.setCenterElevation(v); return; }
        }
    }
    anclarCamara(map);
}
const ARRANQUE = (() => {
    W = new Planificador(); W2 = new Planificador(); W3 = new Planificador();
    // Un solo worker lee y decodifica los PNG del terreno; los otros dos reciben copias de los arrays.
    const ini = W.llamar({ tipo: 'init' }).then(async r1 => {
        const t = await W.llamar({ tipo: 'exportar' });
        TERRENO = { meta: t.meta, elev: t.elev.slice() };
        const copia = () => ({ ...t, elev: t.elev.slice(), pend: t.pend.slice(), rug: t.rug.slice(), peligro: t.peligro.slice() });
        const [r2, r3] = await Promise.all([W2.llamar({ tipo: 'init', terreno: copia() }), W3.llamar({ tipo: 'init', terreno: t })]);
        T0.terreno = performance.now();
        return [r1, r2, r3];
    });
    const datos = Promise.all([fetch('data/ruta/puntos_eva.json').then(r => r.json()), fetch('data/ruta/m20_traverse.geojson').then(r => r.json())]);
    const cache = fetch('data/ruta/cache_pares.json').then(r => r.ok ? r.json() : null).catch(() => null);
    // El campo de vuelta de la base se precalcula en cuanto hay terreno: la primera ruta sale antes.
    Promise.all([ini, datos]).then(([, [puntos]]) => {
        const habitat = { lon: puntos.habitat.lon, lat: puntos.habitat.lat };
        for (const id of PERFILES_UI) workerDe(id).llamar({ tipo: 'precalentar', perfil: id, habitat, traje: TRAJE_DEFECTO }).catch(() => {});
    }).catch(() => {});
    return { ini, datos, cache };
})();

// ───────────────────────── caché de costes por pares ─────────────────────────

/** FNV-1a de 32 bits: versión del terreno + traje + zonas para invalidar la caché ante cualquier cambio. */
function fnv(texto) { let h = 0x811c9dc5; for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
export function versionCache(meta, traje, zonas = []) {
    return fnv(JSON.stringify(meta) + [traje.masaCorporal, traje.masaTraje, traje.carga, traje.duracionMaxH, `cal${CALIBRACION.version}`].join('/') + JSON.stringify(zonas));
}
const CLAVE_LS = 'marswalk.pares.v1';
function cacheActual() {
    const v = versionCache(S.meta, S.traje, S.zonas);
    if (S.cachePares?.version !== v) {
        let guardada = null;
        try { guardada = JSON.parse(localStorage.getItem(CLAVE_LS) || 'null'); } catch { /* sin almacenamiento */ }
        S.cachePares = guardada?.version === v ? guardada : S.cacheRepo?.version === v ? structuredClone(S.cacheRepo) : { version: v, perfiles: {} };
    }
    return S.cachePares;
}
/**
 * Descarga la caché de costes por pares como data/ruta/cache_pares.json. Uso (consola del navegador), tras
 * cambiar las paradas de puntos_eva.json o los valores por defecto del traje: abrir el planificador, esperar a
 * que salgan las tres rutas y ejecutar `marswalk.exportarCache()`; guardar el archivo en data/ruta/.
 */
function exportarCache() {
    const c = cacheActual();
    const faltan = PERFILES_UI.filter(id => !c.perfiles[id] || !Object.keys(c.perfiles[id]).length);
    if (faltan.length) { console.warn('[ruta] aún no hay costes para:', faltan.join(', '), '— espera a que se calculen las tres rutas.'); return null; }
    const datos = { version: c.version, generado: 'costes exactos por pares (rejilla 40 m) del escenario por defecto; se invalida si cambia el terreno, el traje o las zonas', perfiles: c.perfiles };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(datos)], { type: 'application/json' }));
    a.download = 'cache_pares.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return datos;
}
function guardarPares(perfil, nuevos) {
    if (!nuevos || !Object.keys(nuevos).length) return;
    const c = cacheActual();
    Object.assign((c.perfiles[perfil] ||= {}), nuevos);
    try { localStorage.setItem(CLAVE_LS, JSON.stringify(c)); } catch { /* lleno o no disponible: solo memoria */ }
}
/** Worker que ya tiene en caché los campos de coste de ese perfil (replanificación inmediata). */
const workerDe = id => ({ segura: W, equilibrada: W2, ciencia: W3 })[id] || W2;

// ───────────────────────── estado ─────────────────────────

const S = {
    map: null, meta: null, motor: 'js', puntos: null, habitat: null, paradas: [],
    perfil: 'equilibrada', fecha: new Date().toISOString().slice(0, 10), horaSalida: 9,
    traje: { ...TRAJE_DEFECTO }, cond: { tempMediaC: -52, amplitudC: 33, tau: 0.5, vientoMs: 8, factorDosis: 1 },
    resultados: {}, activo: null, plan: null, fuentes: null, tOffset: 0, maniobras: [],
    t: 0, reproduciendo: false, velocidad: 120, navegando: false, tresD: false, voz: true,   // 2D por defecto: el 3D en marcha es el modo astronauta
    marcadores: [], puck: null, moviendoBase: false, zonas: [], dibujando: null,
    capas: { pendiente: false, alcance: false, sombra: true, cobertura: false, traza: true }, luzReal: true,
    validacion: null, ultimoPlan: 0, recomendacion: null, eleccionManual: false,
    inicio: null, fin: null, eligiendo: null, nPropias: 0,   // inicio/fin: { lon, lat, nombre } o null (= la base)
};
let tiempo = null;

// ───────────────────────── condiciones ─────────────────────────

let solicitudCondiciones = 0;
let datosFallbackCondiciones = null;
let cargaFallbackCondiciones = null;

async function cargarCondiciones(lon, lat, utcMs) {
    const solicitud = ++solicitudCondiciones;
    const referencia = new Date(utcMs).toISOString();
    const aplicar = datos => {
        if (solicitud !== solicitudCondiciones) return false;
        Object.assign(S.cond, datos);
        return true;
    };
    const ext = window.marsConditions?.en;
    if (typeof ext === 'function') {
        try {
            const datos = await ext(lon, lat, utcMs);
            return aplicar({
                ...datos,
                fuente: `${datos.fuente || 'Módulo ambiental (marsConditions)'}; referencia ${referencia} UTC`,
            });
        }
        catch (e) { console.warn('[ruta] marsConditions falló', e); }
    }
    const cercano = (feats, f) => {
        let best = null, d = Infinity;
        for (const x of feats) { const p = x.properties, dd = (p.lat - lat) ** 2 + (p.lon - lon) ** 2; if (dd < d && f(p)) { d = dd; best = p; } }
        return best;
    };
    try {
        if (!cargaFallbackCondiciones) {
            cargaFallbackCondiciones = Promise.all([
                fetch('data/datos_ambientales_marte.geojson').then(r => r.json()),
                fetch('data/polvo_marte.geojson').then(r => r.json()),
            ]).then(([amb, polvo]) => (datosFallbackCondiciones = [amb, polvo]));
        }
        const [amb, polvo] = datosFallbackCondiciones || await cargaFallbackCondiciones;
        const pa = cercano(amb.features, p => Number.isFinite(p.windSpeed) && p.windSpeed < 100);
        const pd = cercano(polvo.features, p => Number.isFinite(p.dust));
        const datos = {
            tempMediaC: -52, amplitudC: 33, tau: pd ? Math.max(0.2, pd.dust) : 0.5,
            vientoMs: pa?.windSpeed ?? 8, ...(Number.isFinite(pa?.windDir) ? { vientoDir: pa.windDir } : {}),
            tormentaSolar: false,
            fuente: `polvo del MCD y viento de EMARS (data/), temperatura según climatología diurna tipo MEDA; referencia ${referencia} UTC`,
        };
        return aplicar(datos);
    } catch (e) {
        cargaFallbackCondiciones = null;
        return aplicar({
            tempMediaC: -52, amplitudC: 33, tau: 0.5, vientoMs: 8, tormentaSolar: false,
            fuente: `valores por defecto (sin datos ambientales), referencia ${referencia} UTC`,
        });
    }
}

// ───────────────────────── DOM ─────────────────────────

/**
 * Dos costes ocultos de MapLibre con el relieve 3D activado (medidos con el perfilador: el 60 % del tiempo de CPU):
 *  - cada marcador comprueba 10 veces por segundo si el relieve lo tapa leyendo píxeles de la GPU (lectura síncrona
 *    que detiene el dibujo). Nuestros marcadores son señales de navegación: se ven siempre, así que se desactiva;
 *  - la barra de escala hace otra lectura igual en cada movimiento de cámara: con relieve se actualiza al parar.
 */
function aligerarMapa(map) {
    const P = maplibregl.Marker?.prototype;
    if (P?._updateOpacity && !P.__mwSinOclusion) {
        const original = P._updateOpacity;
        P.__mwSinOclusion = true;
        P._updateOpacity = function (forzar) {
            if (!this._map?.terrain) return original.call(this, forzar);
            const o = this._opacity ?? '1';
            if (this._element && this._element.style.opacity !== o) this._element.style.opacity = o;
        };
    }
    const escala = map._controls?.find(c => maplibregl.ScaleControl && c instanceof maplibregl.ScaleControl);
    if (escala?._onMove) {
        map.off('move', escala._onMove);
        map.on('move', () => { if (!S.navegando && !map.getTerrain()) escala._onMove(); });
        map.on('moveend', () => { if (!S.navegando) escala._onMove(); });
    }
}

/**
 * Relieve del mapa solo en reposo. Con la cámara en movimiento el relieve 3D de MapLibre va a ~11 fps en una GPU
 * integrada (60 sin él, medido en la vista de planificación): mientras el mapa se mueve —lo arrastre el usuario o lo
 * anime la aplicación— se dibuja inclinado pero plano, y el relieve vuelve medio segundo después de parar.
 * El 3D en movimiento (navegación, modo astronauta, vista previa) es cosa del mundo 3D (js/ruta/mundo3d.js).
 */
function relieveEnReposo(map) {
    let t = 0;
    const enRuta = () => document.body.classList.contains('modo-ruta');
    map.on('movestart', () => {
        if (S.anclando || S.navegando) return;                  // navegando en 2D el mapa se mueve en cada fotograma, sin relieve
        clearTimeout(t);
        if (velo) velo.style.display = 'none';
        if (map.getTerrain() && enRuta()) { S.relievePausado = true; map.setTerrain(null); anclar(map); }
    });
    // Al volver, el relieve tarda unos fotogramas en tener sus mallas (y mientras deja huecos en negro): se tapa con
    // una copia congelada de la vista plana que se funde con la vista en relieve cuando esta ya está completa.
    let velo = null;
    const conFundido = () => {
        const lienzo = map.getCanvas();
        if (!velo) { velo = document.createElement('canvas'); velo.className = 'mw-velo'; lienzo.after(velo); }
        map.once('render', () => {
            if (map.isMoving() || !S.relievePausado) return;
            S.relievePausado = false;
            try {
                velo.width = lienzo.width; velo.height = lienzo.height;
                velo.getContext('2d').drawImage(lienzo, 0, 0);
                velo.style.transition = 'none'; velo.style.opacity = '1'; velo.style.display = 'block';
            } catch { velo.style.display = 'none'; }
            setTimeout(() => {
                map.setTerrain(terrenoDe()); anclar(map);
                let hecho = false;
                const quitar = () => { if (hecho) return; hecho = true; velo.style.transition = 'opacity .5s ease'; velo.style.opacity = '0'; setTimeout(() => { if (velo.style.opacity === '0') { velo.style.display = 'none'; velo.width = velo.height = 0; } }, 520); };
                map.once('idle', quitar); setTimeout(quitar, 3500);
            }, 0);
        });
        map.triggerRepaint();
    };
    const volver = () => {
        clearTimeout(t);
        if (!S.relievePausado) return;
        t = setTimeout(() => {
            if (!S.relievePausado || !enRuta()) { S.relievePausado = false; return; }
            if (map.isMoving() || S.llegando) return;          // sigue en marcha: se reintenta en el siguiente moveend
            if (!terrenoDe()) { S.relievePausado = false; return; }
            conFundido();
        }, 450);
    };
    map.on('moveend', () => { if (!S.anclando && !S.navegando) volver(); });
    S.volverRelieve = volver;
}

/** Descarga por adelantado (a la caché del navegador) las teselas de la vista de llegada a Jezero: el vuelo aterriza nítido. */
function precargarLlegada() {
    const m = S.meta, c = [S.habitat.lon - 0.01, S.habitat.lat - 0.004];
    const base = new URL('./', document.baseURI).href, urls = [];
    for (const [plantilla, rangos, zs] of [[m.orto?.url, m.orto?.rangos, [9, 10, 11, 12, 13]], [m.teselas?.url, m.teselas?.rangos, [9, 10, 11, 12]]]) {
        if (!plantilla) continue;
        for (const z of zs) {
            const r = rangos?.[z]; if (!r) continue;
            const n = 2 ** z, cx = Math.floor((c[0] + 180) / 360 * n), cy = Math.floor((1 - Math.asinh(Math.tan(c[1] * Math.PI / 180)) / Math.PI) / 2 * n), d = z >= 12 ? 3 : 2;
            for (let y = Math.max(r[1], cy - d); y <= Math.min(r[3], cy + d); y++) for (let x = Math.max(r[0], cx - d); x <= Math.min(r[2], cx + d); x++)
                urls.push(base + plantilla.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        }
    }
    // Mapa base global de z0 a z4 (341 teselas pequeñas) y, hasta z6, el pasillo sobre Jezero que cruza el vuelo de entrada.
    const color = S.map.getSource('color-tiles')?.tiles?.[0];
    if (color) {
        for (let z = 0; z <= 4; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) urls.push(color.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        for (let z = 5; z <= 6; z++) {
            const n = 2 ** z, cx = Math.floor((c[0] + 180) / 360 * n), cy = Math.floor((1 - Math.asinh(Math.tan(c[1] * Math.PI / 180)) / Math.PI) / 2 * n);
            for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 3; x <= cx + 3; x++) if (y >= 0 && y < n) urls.push(color.replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y));
        }
    }
    let k = 0;
    const siguiente = () => { const u = urls[k++]; if (u) fetch(u).then(r => r.blob()).catch(() => {}).finally(siguiente); };
    for (let i = 0; i < 4; i++) siguiente();
}

function construirDOM() {
    document.body.insertAdjacentHTML('beforeend', `
<div class="mw-modo" role="group" aria-label="Modo">
  <button type="button" data-modo="explorar" aria-pressed="true">Explorar Marte</button>
  <button type="button" data-modo="ruta" aria-pressed="false">Ruta a pie en Jezero</button>
</div>
<button class="mw-ir-jezero" id="mw-ir-jezero" type="button">Acercar a Jezero · detalle de 6 m</button>
<aside class="g-panel" aria-label="Indicaciones de la EVA">
  <header class="g-cabecera"><span class="ico">${ICO.pie}</span>
    <div><span class="g-rol" title="Dos modos, dos personas: quien prepara la salida en la base y quien camina">Planificador · en la base</span>
    <h1>Cómo llegar a pie</h1><p>Para quien prepara la EVA: compara rutas, consumibles, cuerpo y fuentes. Cráter Jezero, cálculo en <span id="mw-motor">…</span>.</p></div></header>
  <div class="g-scroll">
    <section class="g-sec">
      <ol class="g-pasos" id="mw-pasos"></ol>
      <details class="g-otras" id="mw-otras"><summary>Añadir parada</summary><div id="mw-otras-lista"></div></details>
    </section>
    <section class="g-sec">
      <div class="g-salida">
        <div class="hora" id="mw-hora">Salir a las 09:00</div>
        <input type="date" id="mw-fecha" aria-label="Fecha (UTC)">
        <input type="range" id="mw-hora-rango" min="5" max="17" step="0.25" value="9" aria-label="Hora de salida (hora solar local)">
      </div>
      <p class="g-nota" id="mw-luz-txt"></p>
    </section>
    <section class="g-sec">
      <div class="g-opciones" id="mw-opciones" role="group" aria-label="Opciones de ruta"></div>
      <p class="g-razon" id="mw-razon"></p>
      <div class="g-acciones">
        <button class="g-boton" id="mw-iniciar" type="button" title="Pasa a la vista del astronauta: solo lo que hace falta mientras caminas">${ICO.navegar}<span>Iniciar salida</span><i class="barra" style="width:0"></i></button>
        <button class="g-boton sec" id="mw-vista" type="button">Vista previa</button>
      </div>
    </section>
    <section class="g-sec" id="mw-resumen" hidden>
      <div class="g-datos" id="mw-datos"></div>
      <div class="g-perfil"><canvas id="mw-linea" tabindex="0" aria-label="Perfil de elevación a lo largo del tiempo; flechas para recorrerlo"></canvas></div>
      <p class="g-nota">Elevación por hora local. Las zonas sombreadas son paradas; la línea discontinua, el límite de vuelta a pie (lo que queda por encima de la reserva tras volver desde cada punto).</p>
    </section>
    <section class="g-sec g-condicion" id="mw-condicion" aria-live="polite">
      <div class="g-condicion-cabecera"><h2>Decisión ambiental</h2><strong id="mw-condicion-estado">…</strong></div>
      <p id="mw-condicion-resumen"></p>
      <div class="g-condicion-datos" id="mw-condicion-datos"></div>
      <p class="g-nota" id="mw-condicion-regla"></p>
    </section>
    <section class="g-sec" id="mw-cuerpo-sec" hidden>
      <h2>Tu cuerpo en esta ruta</h2>
      <div class="g-cuerpo-entrada">
        <div class="g-fila"><label for="mw-edad">Edad</label><input type="number" id="mw-edad" min="6" max="90" step="1"></div>
        <div class="g-fila"><label for="mw-etapa">Etapa en el test de ida y vuelta de 20 m <small>(vacío si no lo sabes)</small></label><input type="number" id="mw-etapa" min="1" max="21" step="0.5" placeholder="—"></div>
        <div class="g-fila"><label for="mw-masa">Peso (kg)</label><input type="number" id="mw-masa" min="20" max="150" step="1"></div>
      </div>
      <p class="g-veredicto" id="mw-cuerpo-veredicto"></p>
      <div class="g-cuerpo-mapa">
        ${svgCuerpo('id="mw-cuerpo-svg"')}
        <div><p class="g-cuerpo-cuando" id="mw-cuerpo-cuando"></p><ul class="g-zonas" id="mw-zonas"></ul></div>
      </div>
      <h3 class="g-sub">Qué comer y beber</h3>
      <ol class="g-nutri" id="mw-nutri"></ol>
      <details class="g-cifras"><summary>Cifras de toda la ruta</summary><ul class="g-cuerpo" id="mw-cuerpo"></ul></details>
      <p class="g-nota" id="mw-cuerpo-nota"></p>
    </section>
    <section class="g-sec" id="mw-avisos-sec" hidden>
      <h2>Avisos de la ruta</h2>
      <ul class="g-avisos" id="mw-avisos"></ul>
    </section>
    <section class="g-sec">
      <details><summary>Traje y consumibles</summary>
        <div class="g-fila"><label for="mw-o2">O₂ utilizable (kg)</label><input type="number" id="mw-o2" step="0.1" min="0.2"></div>
        <div class="g-fila"><label for="mw-bat">Batería (Wh)</label><input type="number" id="mw-bat" step="100" min="200"></div>
        <div class="g-fila"><label for="mw-agua">Agua de refrigeración (kg)</label><input type="number" id="mw-agua" step="0.5" min="0.5"></div>
        <div class="g-fila"><label for="mw-dur">Duración máxima (h)</label><input type="number" id="mw-dur" step="0.5" min="1"></div>
        <div class="g-fila"><label for="mw-carga">Carga transportada (kg)</label><input type="number" id="mw-carga" step="1" min="0"></div>
        <button class="g-chip" id="mw-recalcular" type="button">Recalcular rutas</button>
        <p class="g-nota">Gasto metabólico de Pandolf con corrección de Santee, calibrado con la caminata de 10 km con traje de NASA (Norcross et al. 2008) y escalado a 0,38 g.</p>
      </details>
    </section>
    <section class="g-sec">
      <details><summary>Editar el terreno</summary>
        <div class="g-fila-botones">
          <button class="g-chip" id="mw-mover-base" type="button">Mover la base</button>
          <button class="g-chip" id="mw-zona" type="button">Marcar zona prohibida</button>
        </div>
        <p class="g-nota">Las zonas prohibidas se evitan en todas las rutas (por ejemplo, un campo de rocas visto en HiRISE).</p>
      </details>
    </section>
    <section class="g-sec">
      <details id="mw-validar-det"><summary>Comparar con Perseverance</summary>
        <p class="g-nota">Planificamos con coste de rover los tramos que condujo Perseverance y medimos cuánto se separa nuestra ruta de la real, frente a ir en línea recta.</p>
        <div class="g-fila-botones"><button class="g-chip" id="mw-validar" type="button">Ejecutar la comparación</button></div>
        <div id="mw-validacion"></div>
      </details>
    </section>
    <section class="g-sec">
      <details id="mw-fuentes-det"><summary>Fuentes y fiabilidad</summary><ul class="g-fuentes" id="mw-fuentes"></ul></details>
    </section>
  </div>
</aside>
<div class="g-controles">
  <button class="g-redondo" id="mw-btn-capas" type="button" aria-label="Capas">${ICO.capas}</button>
  <button class="g-redondo" id="mw-btn-3d" type="button" aria-label="Cambiar entre 3D y 2D">${ICO.dosd}</button>
  <button class="g-redondo" id="mw-btn-norte" type="button" aria-label="Orientar al norte">${ICO.brujula}</button>
  <button class="g-redondo" id="mw-btn-centrar" type="button" aria-label="Centrar en la ruta">${ICO.centrar}</button>
</div>
<div class="g-capas-pop" id="mw-capas-pop" role="dialog" aria-label="Capas del mapa">
  <h3>Detalles del mapa</h3>
  <div class="g-capas-grid">
    <button class="g-capa" type="button" data-capa="sombra" aria-pressed="true"><i style="--m:linear-gradient(135deg,#d9a273 50%,#3b2414 50%)"></i>Luz y sombras reales</button>
    <button class="g-capa" type="button" data-capa="pendiente" aria-pressed="false"><i style="--m:linear-gradient(135deg,#f9ab00,#d93025)"></i>Pendiente</button>
    <button class="g-capa" type="button" data-capa="alcance" aria-pressed="false" title="Hasta dónde puedes llegar y aún volver a pie a la base sin gastar la reserva de O₂, batería, agua ni tiempo"><i style="--m:radial-gradient(circle,#8ab4f8 35%,#1a73e8 36%,#1a73e8 40%,#c58d63 41%)"></i>Límite de vuelta a pie</button>
    <button class="g-capa" type="button" data-capa="cobertura" aria-pressed="false"><i style="--m:repeating-linear-gradient(45deg,#a142f4 0 4px,#c58d63 4px 10px)"></i>Sin radio</button>
    <button class="g-capa" type="button" data-capa="traza" aria-pressed="true"><i style="--m:linear-gradient(#b07a52,#b07a52) padding-box,repeating-linear-gradient(90deg,#fff 0 6px,transparent 6px 10px) center/100% 3px no-repeat;background-color:#b07a52"></i>Traza del rover</button>
  </div>
</div>
<button class="g-origen" id="mw-origen" type="button" title="De dónde salen el terreno y la imagen: ver todas las fuentes">
  <span class="g-origen-tit">Terreno</span><span id="mw-origen-txt">USGS Mars 2020 TRN · ruta sobre DTM CTX 20 m</span>
</button>
<div class="g-ley" id="mw-alcance-ley" hidden role="note">
  <b><i></i>Límite de vuelta a pie</b>
  <span id="mw-alcance-txt"></span>
</div>
<div class="g-banner" id="mw-banner" role="status" aria-live="polite">
  <div class="prin"><div id="mw-ban-ico"></div><div><div class="dist" id="mw-ban-dist">—</div><div class="txt" id="mw-ban-txt"></div></div></div>
  <div class="luego" id="mw-ban-luego"></div>
</div>
<div class="g-hoja" aria-label="Navegación">
  <div class="fila1">
    <button class="salir" id="mw-salir" type="button" aria-label="Salir de la navegación">${ICO.cerrar}</button>
    <div class="eta"><span class="g-rol astro" title="Lo que necesita quien camina, en primer plano">Astronauta · en la salida</span><b id="mw-eta">—</b><span id="mw-eta-sub"></span></div>
    <div class="reproductor">
      <button class="g-redondo" id="mw-play" type="button" aria-label="Pausar">${ICO.pausa}</button>
      <button class="g-chip" data-vel="60" type="button" aria-pressed="false">60×</button>
      <button class="g-chip" data-vel="120" type="button" aria-pressed="true">120×</button>
      <button class="g-chip" data-vel="480" type="button" aria-pressed="false">480×</button>
      <button class="g-redondo" id="mw-voz" type="button" aria-pressed="true" aria-label="Silenciar las indicaciones de voz">${ICO.voz}</button>
      <button class="g-chip" id="mw-astro" type="button" aria-pressed="false" title="Vista en primera persona con visor de casco">Modo astronauta</button>
      <label class="astro-altura" title="Altura de la cámara sobre el suelo">Altura
        <input type="range" id="mw-astro-alt" min="${CAMARA.alturaMin}" max="${CAMARA.alturaMax}" step="0.5" aria-label="Altura de la cámara sobre el suelo, en metros">
        <b id="mw-astro-alt-txt"></b></label>
    </div>
  </div>
  <div class="barra-progreso" id="mw-progreso" role="slider" tabindex="0" aria-label="Posición en la EVA"><i></i></div>
  <div class="indic" id="mw-indic"></div>
  <div class="imprevistos"><span>Simular imprevisto:</span>
    <button class="g-chip" data-cont="polvo" type="button">Tormenta de polvo</button>
    <button class="g-chip" data-cont="consumibles" type="button">Consumibles al 40 %</button>
    <button class="g-chip" data-cont="radiacion" type="button">Alerta solar</button>
    <button class="g-chip" data-cont="volver" type="button">Volver a la base</button>
  </div>
</div>
<div class="g-aviso" id="mw-aviso" role="alert"></div>`);
}

// ───────────────────────── panel ─────────────────────────

const utcSalida = () => utcForLtst(Date.parse(S.fecha + 'T00:00:00Z'), S.habitat.lon, S.horaSalida);

function pintarSalida() {
    $('#mw-hora').innerHTML = `Salir a las ${formatHora(S.horaSalida)}<small>hora solar local</small>`;
    const e = marsEpoch(utcSalida()), est = seasonLabel(e.Ls);
    const d = daylight(utcSalida(), S.habitat.lon, S.habitat.lat);
    const utc = new Date(utcSalida()).toISOString().slice(11, 16);
    $('#mw-luz-txt').textContent = `Luz de ${formatHora(d.orto)} a ${formatHora(d.ocaso)}. Equivale a las ${utc} UTC. ` +
        `Estación Ls ${e.Ls.toFixed(0)}°${est.temporadaPolvo ? ', temporada de tormentas de polvo' : ''}.`;
    pintarCondiciones();
}

function pintarCondiciones() {
    const c = S.cond;
    const capitalizar = texto => texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : texto;
    const noGo = c.tormentaSolar || c.tau > 2 || c.vientoMs > 30;
    const precaucion = !noGo && (c.tau > 1 || c.vientoMs > 20);
    const estado = noGo ? 'NO-GO' : precaucion ? 'PRECAUCIÓN' : 'GO';
    const clase = noGo ? 'no-go' : precaucion ? 'precaucion' : 'go';
    const motivo = c.tormentaSolar ? 'Alerta solar simulada' : c.tau > 2 ? 'Polvo por encima del límite' : c.vientoMs > 30 ? 'Viento por encima del límite' :
        precaucion ? 'Hay una condición que requiere revisar la ruta' : 'Polvo y viento dentro de los límites de esta demo';
    $('#mw-condicion-estado').className = clase;
    $('#mw-condicion-estado').textContent = estado;
    $('#mw-condicion-resumen').textContent = `${motivo}. ${noGo ? 'La salida queda bloqueada.' : precaucion ? 'La salida requiere revisión.' : 'La ruta puede continuar.'}`;
    $('#mw-condicion-datos').innerHTML = [
        `<span><b>Polvo</b> τ=${c.tau.toFixed(2)} <small>climatología de modelo · MCD</small></span>`,
        `<span><b>Viento</b> ${c.vientoMs.toFixed(0)} m/s <small>reanálisis · EMARS</small></span>`,
        `<span><b>Temperatura</b> ${c.tempMediaC.toFixed(0)} °C ±${c.amplitudC.toFixed(0)} °C <small>climatología diurna · MEDA; afecta a la batería</small></span>`,
    ].join('');
    $('#mw-condicion-regla').textContent = `${capitalizar(c.fuente || 'Datos ambientales del planificador')}. Regla provisional de demo: τ > 1 o viento > 20 m/s = precaución; τ > 2 o viento > 30 m/s = NO-GO.`;
}

function pintarPasos() {
    const plan = S.plan?.factible ? S.plan : null;
    const llegadas = new Map((plan?.paradas || []).map(p => [p.id, p]));
    const enRuta = plan ? plan.paradas.map(p => S.paradas.find(x => x.id === p.id)).filter(Boolean) : S.paradas.filter(p => p.activa);
    const fin = plan ? plan.muestras.ltst[plan.muestras.ltst.length - 1] : null;
    $('#mw-pasos').innerHTML = [
        S.inicio
            ? `<li class="g-paso"><span class="pin inicio"></span><span class="nombre" data-ir="inicio"><b>${S.inicio.nombre}</b><small>Salida ${formatHora(S.horaSalida)}</small></span>
               <span class="acciones"><button class="enlace" type="button" data-elegir="inicio">Cambiar</button><button class="quitar" type="button" data-reset="inicio" aria-label="Salir desde la base">×</button></span></li>`
            : `<li class="g-paso"><span class="pin base">${ICO.base}</span><span class="nombre" data-ir="base"><b>${S.puntos.habitat.nombre}</b><small>Salida ${formatHora(S.horaSalida)}</small></span>
               <span class="acciones"><button class="enlace" type="button" data-elegir="inicio">Cambiar</button></span></li>`,
        ...enRuta.map((p, i) => {
            const l = llegadas.get(p.id);
            return `<li class="g-paso"><span class="pin">${i + 1}</span><span class="nombre" data-ir="${p.id}"><b>${p.nombre}</b><small>${l ? `Llegada ${formatHora(l.llegadaLtst)}, ${p.trabajoMin} min de trabajo` : `${p.trabajoMin} min de trabajo`}${p.obligatoria ? ', fija' : ''}</small></span>
              <span class="acciones">${boton360(p, true)}<button class="quitar" type="button" data-quitar="${p.id}" aria-label="Quitar ${p.nombre}">×</button></span></li>`;
        }),
        S.fin
            ? `<li class="g-paso"><span class="pin fin">${ICO.meta}</span><span class="nombre" data-ir="fin"><b>${S.fin.nombre}</b><small>${fin != null ? `Llegada ${formatHora(fin)}` : 'Destino'}</small></span>
               <span class="acciones"><button class="enlace" type="button" data-elegir="fin">Cambiar</button><button class="quitar" type="button" data-reset="fin" aria-label="Volver a la base">×</button></span></li>`
            : `<li class="g-paso"><span class="pin base">${ICO.base}</span><span class="nombre" data-ir="base"><b>Regreso a la base</b><small>${fin != null ? `Llegada ${formatHora(fin)}` : ''}</small></span>
               <span class="acciones"><button class="enlace" type="button" data-elegir="fin">Cambiar</button></span></li>`,
    ].join('');
    const otras = S.paradas.filter(p => !enRuta.includes(p));
    $('#mw-otras-lista').innerHTML = `<div class="g-otra"><span><b>Un punto del mapa</b><small>Toca el terreno donde quieras parar</small></span>
          <button type="button" data-elegir="parada">Elegir en el mapa</button></div>` + otras.map(p => {
        const descartada = p.activa && plan;
        return `<div class="g-otra"><span><b>${p.nombre}</b><small>${descartada ? 'No cabe en esta EVA con la reserva elegida' : `${p.trabajoMin} min de trabajo, valor ${p.valor}/10`}</small></span>
          <button type="button" data-fijar="${p.id}">${descartada ? 'Forzar' : 'Añadir'}</button></div>`;
    }).join('');
}

/**
 * Botón «360°» de una parada: las fotos reales de Mastcam-Z donde las hay (js/ruta/panorama.js) y, en el resto, la
 * reconstrucción 3D del terreno desde ese punto (js/ruta/mundo3d.js), etiquetada como tal.
 */
function boton360(p, corto = false) {
    const real = hayPanorama(p.id);
    if (corto) return `<button class="enlace g-360" type="button" ${real ? `data-pano="${p.id}"` : `data-mirador3d="${p.id}"`} title="${real ? 'Vista 360° con fotos reales de Perseverance' : 'Vista 360° del terreno en 3D (reconstrucción con HiRISE)'}">360°</button>`;
    return real ? `<button type="button" class="g-pano-btn" data-pano="${p.id}">Ver en 360° · fotos reales de NASA</button>`
        : `<button type="button" class="g-pano-btn sec" data-mirador3d="${p.id}">Ver en 360° · terreno 3D</button>`;
}

function pintarOpciones() {
    $('#mw-opciones').innerHTML = PERFILES_UI.map(id => {
        const p = PERFILES[id], r = S.resultados[id];
        let cuerpo;
        if (!r) cuerpo = `<span class="t">…</span><span class="nom">${p.nombre}</span><span class="det">${p.descripcion}</span>`;
        else if (!r.factible) cuerpo = `<span class="t no">Sin ruta posible</span><span class="nom">${p.nombre}</span><span class="det">${r.motivo}</span>`;
        else cuerpo = `<span class="t">${fmtDur(r.duracion)}</span><span class="nom">${p.nombre}</span>
            <span class="det">${fmtKm(r.distancia)}, ${r.paradas.length} paradas, ${r.valorCiencia} puntos de ciencia, pendiente máx. ${Math.round(r.pendienteMax)}°</span>
            ${S.recomendacion?.id === id ? '<span class="rec">Recomendada</span>' : ''}`;
        return `<button class="g-opcion" type="button" data-perfil="${id}" aria-pressed="${S.perfil === id}">${cuerpo}</button>`;
    }).join('');
    $('#mw-razon').textContent = S.recomendacion?.texto || '';
}

function pintarResumen() {
    const r = S.activo;
    $('#mw-resumen').hidden = !r?.factible;
    $('#mw-avisos-sec').hidden = !r;
    if (!r) return;
    const alertas = r.factible ? (r.alertas || []) : [{ nivel: 'critica', texto: r.motivo }];
    $('#mw-avisos').innerHTML = alertas.length ? alertas.map((a, i) => `<li class="${a.nivel}" data-alerta="${i}">${a.nivel === 'info' ? ICO.info : ICO.aviso}<span>${a.texto}</span></li>`).join('')
        : `<li class="info">${ICO.info}<span>Sin avisos: pendientes, luz, radio y consumibles dentro de los límites.</span></li>`;
    if (!r.factible) return;
    const s = r.muestras, n = s.t.length - 1;
    $('#mw-datos').innerHTML = [
        [`${Math.round(r.desnivelPositivo ?? 0)} m`, 'de subida'], [`${(r.pendienteMax ?? 0).toFixed(0)}°`, 'pendiente máxima'], [`${Math.round(limiteVuelta(r.margenMin).min)} min`, 'límite de vuelta en el punto más justo'],
        [pct(1 - s.o2[n]), 'O₂ al volver'], [pct(1 - s.bat[n]), 'batería al volver'], [`${s.dosis[n].toFixed(2).replace('.', ',')} mSv`, 'dosis de radiación'],
    ].map(([v, l]) => `<div class="g-dato"><b>${v}</b><span>${l}</span></div>`).join('');
    pintarCuerpo();
}

// ───────────────────────── tu cuerpo en esta ruta ─────────────────────────

const CLAVE_CUERPO = 'marswalk.cuerpo.v1';
function leerPersona() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(CLAVE_CUERPO) || 'null'); } catch { /* sin almacenamiento */ }
    return { edad: 30, etapa: null, ...(p || {}) };
}
function guardarPersona(p) { try { localStorage.setItem(CLAVE_CUERPO, JSON.stringify(p)); } catch { /* sin almacenamiento */ } }

/**
 * Estado del traje para el HUD de la vista 360° y el asistente: ahora (si se navega) o al llegar a la parada.
 * Porcentajes restantes del modelo del planificador; null si no hay ruta.
 */
function trajeEn(paradaId) {
    const r = S.activo;
    if (!r?.factible) return null;
    let t, momento;
    const p = (r.paradas || []).find(x => x.id === paradaId);
    const fin = r.muestras.t[r.muestras.t.length - 1];
    if (S.navegando) { t = Math.min(S.t, fin); momento = S.t >= fin - 1 ? 'al terminar la EVA' : 'ahora'; }
    else if (p) { t = p.llegadaS; momento = `al llegar a ${p.nombre}`; }
    else { t = r.muestras.t[r.muestras.t.length - 1]; momento = 'al volver a la base'; }
    const m = muestraEn(t);
    const lim = limiteVuelta(m.margen);
    return { momento, o2Pct: 100 * (1 - m.o2), batPct: 100 * (1 - m.bat), aguaPct: 100 * (1 - m.agua),
        margenPct: 100 * Math.max(0, m.margen), limiteMin: lim.min, limiteTxt: fmtLimite(lim), hora: formatHora(m.ltst) };
}

/**
 * Límite de vuelta a pie en cifras (EUROAVIA Castelldefels): cuánto más puedes alejarte andando, en llano, y aún volver a
 * la base sin tocar la reserva. `margen` es lo que queda del consumible que más limita por encima de la reserva tras volver
 * desde aquí; se gasta en ida y vuelta, así que la ida es la mitad. Al ritmo del consumible que antes se agota.
 */
function limiteVuelta(margen) {
    const tr = { ...TRAJE_DEFECTO, ...S.traje }, v = velocidadMarcha(0, 0), M = potenciaMetabolica(v, 0, 0, tr);
    const ritmo = Math.max(M / 20100 * 1.429e-3 / tr.o2Kg, potenciaTraje(tr, (S.cond?.tempMediaC ?? -52) + 15) / 3600 / tr.bateriaWh,
        Math.max(0, 0.8 * M - 90) / 2.45e6 / tr.aguaKg, 1 / (tr.duracionMaxH * 3600));   // fracción por segundo
    const idaS = Math.max(0, margen) / ritmo / 2;
    return { min: idaS / 60, m: idaS * v };
}
const fmtLimite = l => l.min < 1 ? 'vuelve ya' : `${Math.round(l.min)} min · ${fmtKm(l.m)} más`;

/** Cuerpo por zonas en el mismo instante que `trajeEn` (ahora al navegar, al llegar a la parada o al volver). */
function cuerpoEn(paradaId) {
    const F = fisiologiaActual(), r = S.activo;
    if (!F) return null;
    const p = (r.paradas || []).find(x => x.id === paradaId), fin = r.muestras.t[r.muestras.t.length - 1];
    const t = S.navegando ? Math.min(S.t, fin) : p ? p.llegadaS + 1 : Infinity;
    return estadoCuerpo(F, t);
}

/** Respuesta a «¿puedo hacer esta ruta?» para la ruta activa, o { disponible: false } si aún no hay ruta. */
function cuerpoActual() {
    const r = S.activo;
    if (!r?.factible || !r.muestras?.dtm) return { disponible: false };
    const s = r.muestras, n = s.t.length - 1;
    // Destino: la siguiente parada durante la navegación, o la primera parada al planificar.
    const prox = (r.paradas || []).find(p => p.llegadaS >= (S.navegando ? S.t : -1)) || r.paradas?.[0];
    const ficha = prox && S.paradas.find(x => x.id === prox.id);
    return {
        ruta: r.perfil, nombreRuta: PERFILES[r.perfil]?.nombre, veredictoRuta: r.veredicto,
        duracionH: s.t[n] / 3600, distanciaKm: s.dist[n] / 1000, margenMin: r.margenMin,
        motivo: $('#mw-razon')?.textContent || '',
        destino: ficha ? { id: ficha.id, nombre: ficha.nombre, que: ficha.que, porque: ficha.porque, muestra: ficha.muestra,
            llegadaLtst: prox.llegadaLtst, panorama: hayPanorama(ficha.id) } : null,
        ...respuestaCuerpo(r, leerPersona(), S.traje),
        ...fisiologiaParaVoz(),
    };
}

/** Estado por zonas y plan de comida para el asistente: ahora si se navega; si no, al volver a la base. */
function fisiologiaParaVoz() {
    const F = fisiologiaActual();
    if (!F) return {};
    const fin = estadoCuerpo(F), plan = planNutricion(F, fin);
    const ahora = S.navegando ? estadoCuerpo(F, S.t) : fin;
    return { fisiologia: ahora, nutricion: plan, consejo: consejoCuerpo(ahora, plan) };
}

function pintarCuerpo() {
    const r = S.activo;
    $('#mw-cuerpo-sec').hidden = !r?.factible || !r.muestras?.dtm;
    if ($('#mw-cuerpo-sec').hidden) return;
    const persona = leerPersona();
    if (document.activeElement?.id !== 'mw-edad') $('#mw-edad').value = persona.edad;
    if (document.activeElement?.id !== 'mw-etapa') $('#mw-etapa').value = persona.etapa ?? '';
    if (document.activeElement?.id !== 'mw-masa') $('#mw-masa').value = S.traje.masaCorporal;
    const c = cuerpoActual();
    const F = fisiologiaActual(), plan = c.nutricion;
    // Contrato para el asistente (modo astronauta, voz): mismas cifras que la tarjeta (#7, #15).
    window.dispatchEvent(new CustomEvent('marswalk:cuerpo', { detail: c }));
    if (F) {
        $('#mw-nutri').innerHTML = ['antes', 'durante', 'despues'].map(k => `<li><b>${plan[k].titulo}</b><span>${plan[k].texto}</span></li>`).join('') +
            `<li class="fuente">${plan.fuentes.join(' · ')}</li>`;
        pintarZonasCuerpo(S.t);
    }
    const f0 = x => Math.round(x).toLocaleString('es-ES');
    $('#mw-cuerpo-veredicto').className = `g-veredicto ${{ asumible: 'ok', exigente: 'exigente', demasiado: 'dura' }[c.nivel]}`;
    $('#mw-cuerpo-veredicto').textContent = c.texto;
    const fila = (titulo, valor, etiqueta, fuente) => `<li><span class="t">${titulo}</span><b>${valor}</b><span class="g-tipo ${etiqueta}" title="${fuente}">${{ medido: 'dato medido', umbral: 'umbral medido', modelo: 'modelo' }[etiqueta]}</span></li>`;
    $('#mw-cuerpo').innerHTML = [
        fila('Energía', `${f0(c.kcalRango[0])}–${f0(c.kcalRango[1])} kcal`, 'modelo', 'Pandolf/Santee calibrado con la caminata de 10 km con traje (Norcross et al. 2008); rango del 90 %'),
        fila('Equivale a', `${f0(c.kcal / REFERENCIAS_CUERPO.kcalPlatano)} plátanos o andar ${c.kmTierra.toFixed(1).replace('.', ',')} km en la Tierra`, 'modelo', 'Plátano mediano 105 kcal (USDA); paseo a 5 km/h sin carga (Pandolf)'),
        fila('Esfuerzo máximo sostenido', `${f0(c.picoPct)} % ${c.conTest ? 'de tu VO₂máx' : 'del VO₂máx de referencia'}`, 'modelo', c.conTest ? `Tu VO₂máx estimado: ${c.vo2max.toFixed(0)} mL/kg/min (Léger et al. 1988)` : 'VO₂pico medio de los sujetos de NASA: 48,7 mL/kg/min (Norcross et al. 2008)'),
        fila('Minutos por encima del 70 %', `${f0(c.minMuyDuro)} min`, 'modelo', 'Tramos de la ruta con el esfuerzo más alto'),
        fila('Minutos sudando dentro del traje', `${f0(c.minSudor)} min`, 'umbral', 'Por encima de 1670 kJ/h el traje del Apolo ya no evitaba el sudor (Waligora & Horrigan 1975)'),
        fila('Por encima de lo que refrigeraba el Apolo', `${f0(c.minRefrig)} min`, 'umbral', 'Refrigeración sostenida del traje del Apolo: 2090 kJ/h (Waligora & Horrigan 1975)'),
        fila('O₂ que gastarás', `${c.o2Kg.toFixed(2).replace('.', ',')} kg`, 'modelo', '1 L de O₂ por cada 20,1 kJ metabólicos; validado ±3 % con la caminata de 10 km y el Apolo'),
        fila('Agua para beber', `bolsa de 1 L`, 'medido', 'Bolsa de bebida del Apolo, 1 L; en la caminata de 10 km se bebieron 0,7-0,95 L en 1,6 h (Norcross et al. 2008)'),
    ].join('');
    $('#mw-cuerpo-nota').textContent = c.conTest
        ? `Capacidad estimada con tu etapa del test de 20 m y tu edad (Léger et al. 1988): ${c.vo2max.toFixed(0)} mL/kg/min. ${c.aviso}`
        : `Sin tu test, se compara con los astronautas de la prueba de NASA (48,7 mL/kg/min). Pon tu etapa del test de ida y vuelta de 20 m para verlo para ti. ${c.aviso}`;
}

// ───────────────────────── cuerpo por zonas ─────────────────────────

/** Series fisiológicas de la ruta activa (se recalculan al cambiar ruta, persona o traje). */
function fisiologiaActual() {
    const r = S.activo;
    if (!r?.factible || !r.muestras?.dtm) return null;
    const persona = leerPersona(), clave = [r.perfil, r.muestras.t.length, r.muestras.t[r.muestras.t.length - 1], persona.edad, persona.etapa, S.traje.masaCorporal, S.traje.masaTraje, S.traje.carga].join('|');
    if (S.fis?.clave !== clave || S.fis.ruta !== r) S.fis = { clave, ruta: r, F: prepararFisiologia(r, persona, S.traje) };
    return S.fis.F;
}

const ZONAS = {
    corazon: { nombre: 'Corazón y lactato', fuente: FUENTES_FISIOLOGIA.umbral,
        valor: z => `${z.pico ? 'pico ' : ''}${Math.round(z.pct)} % de tu capacidad`, texto: z => `Umbral de lactato estimado: ${Math.round(z.lt)} %. ${z.minSobreLT >= 1 ? `${Math.round(z.minSobreLT)} min por encima: ahí el lactato se acumula y la fatiga llega antes.` : 'Sin minutos por encima: el lactato no se acumula.'}` },
    muslos: { nombre: 'Muslos (cuádriceps y glúteos)', fuente: 'Trabajo vertical = masa con traje × 3,72 m/s² × desnivel, expresado como metros de escalera en la Tierra sin traje. Cortes orientativos.',
        valor: z => `+${Math.round(z.subeM)} m / −${Math.round(z.bajaM)} m`, texto: z => `Como subir ${Math.round(z.subeM / 3)} pisos y bajar ${Math.round(z.bajaM / 3)} en la Tierra. Bajar cuesta poco oxígeno, pero el cuádriceps frena: es lo que da agujetas al día siguiente.` },
    gemelos: { nombre: 'Gemelos y tobillos', fuente: 'Pasos de 0,75 m. Cortes orientativos.',
        valor: z => `${Math.round(z.pasos).toLocaleString('es-ES')} pasos`, texto: () => 'Con la bota rígida del traje, el tobillo trabaja más en cada paso.' },
    manos: { nombre: 'Manos', fuente: FUENTES_FISIOLOGIA.manos,
        valor: z => `${Math.round(z.min)} min con guante`, texto: () => 'El guante presurizado se resiste a cerrar la mano: la fatiga del antebrazo y los dedos limita el trabajo de campo.' },
    glucogeno: { nombre: 'Glucógeno (reserva de hidratos)', fuente: `${FUENTES_FISIOLOGIA.sustratos}. ${FUENTES_FISIOLOGIA.glucogeno}`,
        valor: z => `${Math.round(z.g)} g (${Math.round(z.frac * 100)} %)`, texto: z => z.frac > 0.3 ? 'Gasto importante: repón hidratos al volver.' : 'Queda reserva de sobra para volver.' },
    agua: { nombre: 'Sudor e hidratación', fuente: FUENTES_FISIOLOGIA.agua,
        valor: z => `${z.L.toFixed(1).replace('.', ',')} L (${z.pctPeso.toFixed(1).replace('.', ',')} % del peso)`, texto: z => z.pctPeso >= 2 ? 'Más del 2 %: baja el rendimiento. Bebe de la bolsa del traje.' : z.pctPeso >= 1 ? 'Empieza a notarse: bebe unos sorbos.' : 'Bien hidratado.' },
    radiacion: { nombre: 'Radiación', fuente: FUENTES_FISIOLOGIA.radiacion,
        valor: z => `${Math.round(z.uSv)} µSv`, texto: () => 'Dosis de esta salida en superficie; un TAC de tórax son unos 7000 µSv.' },
};

/** Pinta el diagrama y las zonas en el instante t (al planificar sigue la línea de tiempo; en t = 0, la ruta entera). */
function pintarZonasCuerpo(t) {
    const F = fisiologiaActual();
    if (!F || $('#mw-cuerpo-sec').hidden) return;
    const fin = t <= 1, E = estadoCuerpo(F, fin ? Infinity : t);
    $('#mw-cuerpo-cuando').textContent = fin ? 'Al volver a la base. Mueve la línea de tiempo para verlo minuto a minuto.'
        : `A las ${formatHora(S.activo.muestras.ltst[Math.min(S.activo.muestras.t.length - 1, indice(S.activo.muestras.t, t))])}${E.enParada ? ', trabajando en una parada' : ''}.`;
    document.querySelectorAll('#mw-cuerpo-svg [data-zona]').forEach(el => el.setAttribute('class', E.zonas[el.dataset.zona].nivel));
    const html = Object.entries(ZONAS).map(([k, Z]) => {
        const z = E.zonas[k];
        return `<li data-zona="${k}" class="${z.nivel}" title="${Z.fuente}"><i></i><span class="n">${Z.nombre}</span><b>${Z.valor(z)}</b><span class="x">${Z.texto(z)}</span></li>`;
    }).join('');
    if ($('#mw-zonas').innerHTML !== html) $('#mw-zonas').innerHTML = html;
}

function leerTraje() {
    const v = id => parseFloat($(id).value);
    S.traje = { ...S.traje, o2Kg: v('#mw-o2'), bateriaWh: v('#mw-bat'), aguaKg: v('#mw-agua'), duracionMaxH: v('#mw-dur'), carga: v('#mw-carga') };
}
function escribirTraje() {
    $('#mw-o2').value = S.traje.o2Kg; $('#mw-bat').value = S.traje.bateriaWh; $('#mw-agua').value = S.traje.aguaKg;
    $('#mw-dur').value = S.traje.duracionMaxH; $('#mw-carga').value = S.traje.carga;
}

function pintarFuentes(fuentes) {
    const m = S.meta;
    $('#mw-fuentes').innerHTML = [
        `<li><b>Terreno de ruta</b>: ${m.fuente}. 20 m por píxel: ve laderas de decenas de metros, no rocas sueltas.</li>`,
        m.orto ? `<li><b>Imagen</b>: ${m.orto.fuente}.</li>` : '',
        `<li><b>Imagen de detalle</b>: ${S.hirise?.fuente || 'USGS Mars 2020 TRN HiRISE orthoMosaic 25 cm (JEZ_hirise_soc_006)'}, a partir del zoom 15 en la zona de las paradas.</li>`,
        S.relieveHr?.fuente ? `<li><b>Relieve de detalle (solo vista 3D)</b>: ${S.relieveHr.fuente}. La ruta y sus cifras se calculan con el DTM CTX de 20 m.</li>` : '',
        `<li><b>Vista 3D</b>: relieve exagerado ×${EXAGERACION.vista.toString().replace('.', ',')} (×${EXAGERACION.nav.toString().replace('.', ',')} al navegar) para que se lean pendientes de pocas decenas de metros. Las cifras de la ruta usan las alturas reales.</li>`,
        `<li><b>Pendiente</b>: ${fuentes.pendiente}.</li>`,
        `<li><b>Rugosidad</b>: ${fuentes.rugosidad}.</li>`,
        `<li><b>Rocas y peligros</b>: ${fuentes.peligro}. Fuera de Jezero el relieve es MOLA (463 m), solo como contexto.</li>`,
        `<li><b>Traza del rover</b>: NASA/JPL-Caltech MMGIS (Mars 2020).</li>`,
        `<li><b>Condiciones</b>: ${S.cond.fuente || ''}. τ = ${S.cond.tau.toFixed(2)}, viento ${S.cond.vientoMs.toFixed(0)} m/s.</li>`,
        `<li><b>Radiación</b>: RAD/MSL, 0,64 mSv/día en superficie (Hassler et al. 2014).</li>`,
        `<li><b>Hora solar y Sol</b>: algoritmo Mars24 (Allison & McEwen 2000).</li>`,
    ].join('');
}

/**
 * Sello de origen del terreno, siempre a la vista en el mapa: qué modelo de elevación calcula la ruta y qué imagen
 * se está viendo a este zoom (EUROAVIA Castelldefels: «da mucha credibilidad ante el jurado»). Al pulsarlo se abre
 * «Fuentes y fiabilidad».
 */
function pintarOrigen() {
    const map = S.map, el = $('#mw-origen-txt');
    if (!el || !map) return;
    const z = map.getZoom(), c = map.getCenter(), hb = S.hirise?.bounds;
    const enHirise = hb && z >= (S.hirise.zoom_min ?? 15) && c.lng >= hb[0] && c.lng <= hb[2] && c.lat >= hb[1] && c.lat <= hb[3];
    const imagen = enHirise ? 'imagen HiRISE 25 cm' : z >= 9 ? 'imagen CTX 6 m' : 'imagen Viking 232 m';
    const relieve3d = enHirise && S.relieveHr && map.getTerrain() ? ' (relieve 3D: DTM HiRISE 1 m)' : '';
    const txt = `USGS Mars 2020 TRN · ruta sobre DTM CTX 20 m · ${imagen}${relieve3d}`;
    if (el.textContent !== txt) el.textContent = txt;
}

// ───────────────────────── capas del mapa ─────────────────────────

function imagenesMapa(map) {
    const dibujar = (w, h, f) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); f(x); return x.getImageData(0, 0, w, h); };
    // Chevrón blanco que apunta en el sentido de la línea (como en la navegación de los mapas)
    map.addImage('mw-chevron', dibujar(48, 48, x => {
        x.strokeStyle = '#ffffff'; x.lineWidth = 7; x.lineCap = 'round'; x.lineJoin = 'round';
        x.beginPath(); x.moveTo(16, 10); x.lineTo(32, 24); x.lineTo(16, 38); x.stroke();
    }), { pixelRatio: 2 });
    // Punta de la flecha de maniobra (blanca con borde azul)
    map.addImage('mw-punta', dibujar(96, 96, x => {
        x.beginPath(); x.moveTo(48, 6); x.lineTo(86, 80); x.lineTo(48, 62); x.lineTo(10, 80); x.closePath();
        x.fillStyle = '#ffffff'; x.fill(); x.lineWidth = 6; x.strokeStyle = '#1557b0'; x.lineJoin = 'round'; x.stroke();
    }), { pixelRatio: 2 });
}

function anadirCapasMapa() {
    const map = S.map;
    const antes = map.getLayer('contour-lines') ? 'contour-lines' : undefined;
    anadirCapasTerreno(map, S.meta, antes);
    // Marco de la zona con datos de alta resolución: se ve al explorar, antes de entrar en el detalle.
    const zb = S.meta.teselas.bounds;
    map.addSource('mw-marco-jezero', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString',
        coordinates: [[zb[0], zb[1]], [zb[2], zb[1]], [zb[2], zb[3]], [zb[0], zb[3]], [zb[0], zb[1]]] } } });
    map.addLayer({ id: 'mw-marco-jezero', type: 'line', source: 'mw-marco-jezero', minzoom: 4,
        paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [3, 2],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.9, 8, 0.9, 9.5, 0] } });
    imagenesMapa(map);
    const b = S.meta.teselas.bounds;
    const esquinas = [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]];
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    for (const capa of ['sombra', 'pendiente', 'alcance', 'cobertura']) {
        map.addSource(`mw-${capa}`, { type: 'image', url: pixel, coordinates: esquinas });
        map.addLayer({ id: `mw-${capa}`, type: 'raster', source: `mw-${capa}`, layout: { visibility: 'none' },
            paint: { 'raster-opacity': capa === 'sombra' ? 0.8 : 0.9, 'raster-fade-duration': 0, 'raster-resampling': capa === 'cobertura' ? 'nearest' : 'linear' } });
    }
    const linea = (id, fuente, paint, layout = {}) => map.addLayer({ id, type: 'line', source: fuente, layout: { 'line-cap': 'round', 'line-join': 'round', ...layout }, paint });
    map.addSource('mw-traza', { type: 'geojson', data: VACIO });
    linea('mw-traza', 'mw-traza', { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, 2], 'line-opacity': 0.75, 'line-dasharray': [1, 2] });
    map.setFilter('mw-traza', ['==', ['get', 'tipo'], 'recorrido']);
    map.addSource('mw-validacion', { type: 'geojson', data: VACIO });
    linea('mw-validacion', 'mw-validacion', { 'line-color': '#8ab4f8', 'line-width': 2.5 });
    map.addSource('mw-zonas', { type: 'geojson', data: VACIO });
    map.addLayer({ id: 'mw-zonas', type: 'fill', source: 'mw-zonas', paint: { 'fill-color': '#d93025', 'fill-opacity': 0.25 } });
    linea('mw-zonas-borde', 'mw-zonas', { 'line-color': '#d93025', 'line-width': 2, 'line-dasharray': [2, 1.5] });
    // Rutas alternativas (gris azulado, clicables como en los mapas)
    map.addSource('mw-alternativas', { type: 'geojson', data: VACIO });
    linea('mw-alt-borde', 'mw-alternativas', { 'line-color': '#5f6c7b', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 7, 15, 13] });
    linea('mw-alternativas', 'mw-alternativas', { 'line-color': '#bcd0ee', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 5, 15, 9.5] });
    // Ruta activa: borde azul oscuro + relleno con color por pendiente; tramo recorrido en gris
    map.addSource('mw-ruta', { type: 'geojson', data: VACIO, lineMetrics: true });
    linea('mw-ruta-borde', 'mw-ruta', { 'line-color': '#1557b0', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 9.5, 15, 19, 16, 20, 19, 34, 21, 60] });
    linea('mw-ruta', 'mw-ruta', { 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6.5, 15, 14.5, 16, 15.4, 19, 27, 21, 48], 'line-gradient': '#4285f4' });
    map.addLayer({ id: 'mw-chevrones', type: 'symbol', source: 'mw-ruta', minzoom: 12.5,
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'mw-chevron', 'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.45, 15, 0.8],
            'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map' } });
    map.addSource('mw-emergencia', { type: 'geojson', data: VACIO, lineMetrics: true });
    linea('mw-emergencia-borde', 'mw-emergencia', { 'line-color': '#8c1c13', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 9.5, 15, 19, 16, 20, 19, 34, 21, 60] });
    linea('mw-emergencia', 'mw-emergencia', { 'line-color': '#ea4335', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6.5, 15, 14.5, 16, 15.4, 19, 27, 21, 48] });
    map.addLayer({ id: 'mw-emergencia-chev', type: 'symbol', source: 'mw-emergencia', minzoom: 12.5,
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'mw-chevron', 'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.45, 15, 0.8],
            'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map' } });
    // Próximo tramo con aviso (pendiente, sombra, sin radio…) resaltado sobre el terreno al navegar
    map.addSource('mw-tramo-aviso', { type: 'geojson', data: VACIO });
    linea('mw-tramo-aviso', 'mw-tramo-aviso', { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 14, 16, 34],
        'line-blur': 6, 'line-opacity': 0.55 });
    // Flecha de la próxima maniobra pintada sobre el terreno
    map.addSource('mw-maniobra', { type: 'geojson', data: VACIO });
    linea('mw-maniobra-borde', 'mw-maniobra', { 'line-color': '#1557b0', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 22] }, { 'line-cap': 'butt' });
    linea('mw-maniobra', 'mw-maniobra', { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 6, 16, 14] }, { 'line-cap': 'butt' });
    map.setFilter('mw-maniobra-borde', ['==', ['geometry-type'], 'LineString']);
    map.setFilter('mw-maniobra', ['==', ['geometry-type'], 'LineString']);
    map.addLayer({ id: 'mw-maniobra-punta', type: 'symbol', source: 'mw-maniobra', filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'icon-image': 'mw-punta', 'icon-rotate': ['get', 'rumbo'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.45, 16, 1.0], 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    // Nombres de las paradas, como etiquetas de lugares
    map.addSource('mw-etiquetas', { type: 'geojson', data: VACIO });
    map.addLayer({ id: 'mw-etiquetas', type: 'symbol', source: 'mw-etiquetas',
        layout: { 'text-field': ['get', 'nombre'], 'text-font': ['Open Sans Bold'], 'text-size': 13, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,.85)', 'text-halo-width': 1.6 } });
    map.on('click', 'mw-alternativas', e => {
        const id = e.features?.[0]?.properties?.perfil;
        if (id && !S.navegando) elegirPerfil(id);
    });
    map.on('mouseenter', 'mw-alternativas', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'mw-alternativas', () => { map.getCanvas().style.cursor = ''; });
    ponerVisibilidadRuta(false);
}

// Detalle de Jezero (ortoimagen CTX y relieve del DTM de 20 m): visible también al explorar, a partir de z7.
const CAPAS_RELIEVE = ['ruta-relieve-ambiente', 'ruta-relieve'];
const EXAGERACION_RELIEVE = 0.35;
const aparece = v => ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, v];
const desaparece = v => ['interpolate', ['linear'], ['zoom'], 7, v, 8.5, 0];
/**
 * Aspecto del mapa al explorar: el relieve global (MOLA) se funde con el de detalle entre z7 y z8,5, y las
 * curvas de nivel de MOLA (463 m) se apagan donde ya no aportan. En modo ruta manda la luz del Sol real.
 */
function estiloExplorar() {
    const map = S.map, pintar = (id, prop, v) => { if (map.getLayer(id)) try { map.setPaintProperty(id, prop, v); } catch { /* propiedad no soportada */ } };
    pintar('hillshade', 'hillshade-exaggeration', desaparece(0.55));
    for (const id of CAPAS_RELIEVE) pintar(id, 'hillshade-exaggeration', aparece(EXAGERACION_RELIEVE));
    pintar('ruta-relieve', 'hillshade-illumination-direction', 335);
    pintar('ruta-relieve', 'hillshade-illumination-altitude', 45);
    pintar('ruta-orto', 'raster-brightness-max', 1);
    pintar('ruta-hirise', 'raster-brightness-max', 1);
    pintar('contour-lines', 'line-opacity', ['interpolate', ['linear'], ['zoom'], 8, 1, 9.5, 0]);
    pintar('contour-labels', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 8, 1, 9.5, 0]);
    S.ultimaLuz = null;
}
function relieveVisible(ruta) { return ruta || document.getElementById('toggle-hillshade')?.checked !== false; }

const CAPAS_RUTA = ['mw-tramo-aviso', 'mw-traza', 'mw-validacion', 'mw-zonas', 'mw-zonas-borde', 'mw-alt-borde', 'mw-alternativas',
    'mw-ruta-borde', 'mw-ruta', 'mw-chevrones', 'mw-emergencia-borde', 'mw-emergencia', 'mw-emergencia-chev', 'mw-maniobra-borde', 'mw-maniobra', 'mw-maniobra-punta', 'mw-etiquetas'];
function ponerVisibilidadRuta(v) {
    for (const id of CAPAS_RUTA) if (S.map.getLayer(id)) {
        const vis = id === 'mw-traza' ? v && S.capas.traza : v;
        S.map.setLayoutProperty(id, 'visibility', vis ? 'visible' : 'none');
    }
    for (const c of ['pendiente', 'alcance', 'sombra', 'cobertura'])
        S.map.setLayoutProperty(`mw-${c}`, 'visibility', v && S.capas[c] ? 'visible' : 'none');
    if (S.map.getLayer('ruta-orto')) S.map.setLayoutProperty('ruta-orto', 'visibility', 'visible');
    for (const id of CAPAS_RELIEVE) if (S.map.getLayer(id)) S.map.setLayoutProperty(id, 'visibility', relieveVisible(v) ? 'visible' : 'none');
    if (S.map.getLayer('mw-marco-jezero')) S.map.setLayoutProperty('mw-marco-jezero', 'visibility', v ? 'none' : 'visible');
    // Las curvas de nivel globales (MOLA 463 m) no aportan a escala de EVA.
    // En el modo ruta, el color hipsométrico de MOLA (azules y verdes) choca con la imagen de Marte: se oculta y el
    // fondo pasa a neblina de polvo; más allá de la ortoimagen el sombreado del relieve fundido llega al horizonte.
    // Si el color base es el mosaico Viking en color real (no el MOLA por alturas), se deja: durante el vuelo de entrada
    // y más allá de la ortoimagen se ve Marte y no un fondo liso.
    for (const [id, toggle] of [['contour-lines', 'toggle-contours'], ['contour-labels', 'toggle-labels'], ['hillshade', 'toggle-hillshade'], ['color', 'toggle-color']]) {
        const marcado = document.getElementById(toggle)?.checked, real = id === 'color' && window.marsBaseColor && !window.marsBaseColor.isElevation;
        if (S.map.getLayer(id)) S.map.setLayoutProperty(id, 'visibility', (!v || real) && marcado ? 'visible' : 'none');
    }
    if (S.map.getLayer('background')) {
        if (v) {
            if (S.fondoAntes == null) S.fondoAntes = S.map.getPaintProperty('background', 'background-color') ?? '#0a0a1a';
            S.map.setPaintProperty('background', 'background-color', '#c99d76');
        } else if (S.fondoAntes != null) { S.map.setPaintProperty('background', 'background-color', S.fondoAntes); S.fondoAntes = null; }
    }
}

function imagenDe({ ancho, alto, px }) {
    const c = document.createElement('canvas');
    c.width = ancho; c.height = alto;
    c.getContext('2d').putImageData(new ImageData(px, ancho, alto), 0, 0);
    return c.toDataURL('image/png');
}

async function actualizarCapa(capa, utc = null) {
    if (!S.capas[capa] || capa === 'traza') return;
    if (capa === 'sombra' && S.sombraEnCurso) { S.sombraPendiente = utc; return; }
    if (capa === 'sombra') S.sombraEnCurso = true;
    if (capa === 'alcance' && S.alcanceEnCurso) { S.alcancePendiente = true; return; }
    if (capa === 'alcance') S.alcanceEnCurso = true;
    try {
        const msg = { tipo: 'capa', capa, perfil: S.perfil, habitat: S.habitat, traje: S.traje, cond: S.cond, utc: utc ?? utcSalida(), png: true };
        // Límite de vuelta a pie: desde la base con todo lleno o, ya en camino, desde donde estás con lo que te queda.
        let enCamino = null;
        if (capa === 'alcance' && S.activo?.factible && (S.t > 1 || S.tOffset > 0)) {
            const m = muestraEn(S.t);
            enCamino = { m, t: S.t + S.tOffset };
            Object.assign(msg, { desde: { lon: m.lon, lat: m.lat }, usado: { o2: m.o2, bat: m.bat, agua: m.agua, t: S.t + S.tOffset } });
            S.alcanceDesde = { lon: m.lon, lat: m.lat, t: S.t };
        } else if (capa === 'alcance') S.alcanceDesde = null;
        const r = await (capa === 'alcance' ? workerDe(S.perfil) : W).llamar(msg);
        const b = r.bounds;
        const url = r.blob ? URL.createObjectURL(r.blob) : imagenDe(r);
        S.map.getSource(`mw-${capa}`).updateImage({ url, coordinates: [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]] });
        const urls = S.urlsCapa || (S.urlsCapa = {});
        if (urls[capa]) setTimeout(URL.revokeObjectURL.bind(URL, urls[capa]), 2000);
        urls[capa] = r.blob ? url : null;
        if (document.body.classList.contains('modo-ruta') && S.capas[capa]) S.map.setLayoutProperty(`mw-${capa}`, 'visibility', 'visible');
        if (capa === 'alcance') leyendaAlcance(r, enCamino);
    } finally {
        if (capa === 'alcance') {
            S.alcanceEnCurso = false;
            if (S.alcancePendiente) { S.alcancePendiente = false; actualizarCapa('alcance'); }
        }
        if (capa === 'sombra') {
            S.sombraEnCurso = false;
            if (S.sombraPendiente != null) { const u = S.sombraPendiente; S.sombraPendiente = null; actualizarCapa('sombra', u); }
        }
    }
}

/** Leyenda del límite de vuelta a pie: qué es, con qué reserva y cuánto terreno abarca ahora. */
function leyendaAlcance(r, enCamino) {
    const el = $('#mw-alcance-ley');
    if (!el) return;
    const perfil = PERFILES[S.perfil] || {};
    const reserva = Math.round((perfil.reserva ?? 0.25) * 100);
    const area = `${(r?.areaKm2 ?? 0).toFixed(1).replace('.', ',')} km²`;
    let limita = '';
    if (enCamino) {
        const m = enCamino.m, tMax = (S.traje?.duracionMaxH ?? 8) * 3600;
        const [nombre, usado] = [['O₂', m.o2], ['batería', m.bat], ['agua', m.agua], ['tiempo de salida', enCamino.t / tMax]].sort((a, b) => b[1] - a[1])[0];
        limita = `Lo que más limita ahora: ${nombre} (queda ${pct(1 - usado)}).`;
    }
    $('#mw-alcance-txt').innerHTML = enCamino
        ? `Desde donde estás, con lo que te queda, puedes ir hasta la línea y volver a la base sin tocar la reserva del ${reserva} %. ${limita} <em>${area}</em>`
        : `Hasta la línea puedes ir y volver a la base andando sin tocar la reserva del ${reserva} % de O₂, batería, agua y tiempo. Línea interior: con la mitad. <em>${area}</em>`;
    el.hidden = !S.capas.alcance;
}

/** Durante la EVA (o al mover la línea de tiempo) el límite de vuelta se recalcula desde la posición actual. */
function seguirAlcance() {
    if (!S.capas.alcance || !S.activo?.factible || mundoActivo()) return;
    const ahora = performance.now(), espera = 1500 - (ahora - (S.ultimoAlcance || 0));
    // Como mucho cada 1,5 s, pero la última posición siempre se calcula (al pausar o saltar en la línea de tiempo).
    if (espera > 0) { S.alcanceTimer ||= setTimeout(() => { S.alcanceTimer = 0; seguirAlcance(); }, espera); return; }
    const d = S.alcanceDesde, m = muestraEn(S.t);
    if (d ? Math.abs(S.t - d.t) < 120 && Math.hypot((m.lon - d.lon) * 56000, (m.lat - d.lat) * 59000) < 60 : d === null && S.t <= 1) return;
    S.ultimoAlcance = ahora;
    actualizarCapa('alcance');
}

// ───────────────────────── ruta en el mapa ─────────────────────────

/**
 * Línea de la ruta para dibujar, con las esquinas redondeadas: cada punto es la media (peso triangular) de los que
 * tiene a ±14 m por el camino; los extremos no se mueven. Solo es el trazo: las cifras usan la ruta calculada.
 */
function lineaDe(s, desde = 0) {
    const c = [], n = s.lon.length, R = 14;
    for (let k = desde; k < n; k++) {
        const lim = Math.min(R, s.dist[k] - s.dist[desde], s.dist[n - 1] - s.dist[k]);
        if (!(lim > 0.5)) { c.push([s.lon[k], s.lat[k]]); continue; }
        let a = k, b = k, x = 0, y = 0, w = 0;
        while (a > desde && s.dist[k] - s.dist[a - 1] <= lim) a--;
        while (b < n - 1 && s.dist[b + 1] - s.dist[k] <= lim) b++;
        for (let q = a; q <= b; q++) { const p = 1.02 - Math.abs(s.dist[q] - s.dist[k]) / lim; x += s.lon[q] * p; y += s.lat[q] * p; w += p; }
        c.push([x / w, y / w]);
    }
    return c;
}

/** Relleno de la ruta: recorrido en gris; resto azul, ámbar o rojo según la pendiente frente al límite (como el tráfico). */
function gradienteRuta(res, recorrido = 0) {
    const s = res.muestras, total = s.dist[s.dist.length - 1] || 1, lim = PERFILES[res.perfil]?.pendienteMax || 20;
    const color = (q, p) => p < recorrido ? '#9aa0a6' : q > 0.8 ? '#ea4335' : q > 0.55 ? '#fbbc04' : '#4285f4';
    const stops = [];
    let ult = -1, ultC = null;
    for (let k = 0; k < s.dist.length; k++) {
        const p = s.dist[k] / total, c = color(s.pend[k] / lim, p);
        if (c !== ultC && p > ult + 1e-6) { stops.push(p, c); ult = p; ultC = c; }
    }
    if (stops.length < 4) return color(0, 1);
    stops[0] = 0;
    return ['interpolate', ['linear'], ['line-progress'], ...stops];
}

function rumboEntre(lon1, lat1, lon2, lat2) {
    const r = Math.PI / 180, dl = (lon2 - lon1) * r;
    return (Math.atan2(Math.sin(dl) * Math.cos(lat2 * r), Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dl)) / r + 360) % 360;
}
/** Punto de la muestra a `d` metros a lo largo de la ruta (interpolado). */
function puntoA(s, d) {
    let k = 0;
    while (k < s.dist.length - 2 && s.dist[k + 1] < d) k++;
    const f = s.dist[k + 1] > s.dist[k] ? Math.max(0, Math.min(1, (d - s.dist[k]) / (s.dist[k + 1] - s.dist[k]))) : 0;
    return [s.lon[k] + (s.lon[k + 1] - s.lon[k]) * f, s.lat[k] + (s.lat[k + 1] - s.lat[k]) * f];
}

/**
 * Maniobras paso a paso a partir de los vértices de la ruta suavizada: el giro en cada vértice se mide con
 * los rumbos 30 m antes y después; giros < 20° se ignoran. Las llegadas a paradas y a la base son maniobras.
 */
function calcularManiobras(res) {
    const s = res.muestras, n = s.dist.length, total = s.dist[n - 1];
    const out = [];
    for (let k = 1; k < n - 1; k++) {
        if (!s.vertice[k]) continue;
        const a = puntoA(s, Math.max(0, s.dist[k] - 30)), b = puntoA(s, Math.min(total, s.dist[k] + 30));
        const hin = rumboEntre(a[0], a[1], s.lon[k], s.lat[k]), hout = rumboEntre(s.lon[k], s.lat[k], b[0], b[1]);
        const giro = ((hout - hin + 540) % 360) - 180;
        if (Math.abs(giro) >= 20) out.push({ idx: k, dist: s.dist[k], giro, rumbo: hout });
    }
    for (const p of res.paradas || []) out.push({ idx: p.idx, dist: s.dist[p.idx], llegada: p.nombre, parada: p });
    out.push({ idx: n - 1, dist: total, llegada: destinoNombre() });
    out.sort((x, y) => x.dist - y.dist);
    // Fusiona giros muy próximos (zigzags del terreno) y los que caen justo antes de una llegada.
    const limpio = [];
    for (const m of out) {
        const ult = limpio[limpio.length - 1];
        if (ult && m.dist - ult.dist < 25) {
            if (m.llegada) limpio[limpio.length - 1] = m;
            else if (!ult.llegada && Math.abs(m.giro) > Math.abs(ult.giro)) limpio[limpio.length - 1] = m;
            continue;
        }
        limpio.push(m);
    }
    // Destino al que lleva cada maniobra (para "… hacia Wildcat Ridge")
    let destino = 'la base';
    for (let i = limpio.length - 1; i >= 0; i--) { if (limpio[i].llegada) destino = limpio[i].llegada; else limpio[i].hacia = destino; }
    return limpio;
}

function textoManiobra(m) {
    if (m.llegada) return m.llegada === 'la base' ? 'Llegas a la base' : `Llegas a ${m.llegada}`;
    const lado = m.giro > 0 ? 'derecha' : 'izquierda', g = Math.abs(m.giro);
    const verbo = g < 40 ? `Gira ligeramente a la ${lado}` : g < 115 ? `Gira a la ${lado}` : `Gira bruscamente a la ${lado}`;
    return `${verbo} hacia ${m.hacia}`;
}

function dibujarRuta() {
    const map = S.map, r = S.activo;
    limpiarMarcadores();
    const emerg = !!r?.esEmergencia;
    if (S.plan?.factible) {
        map.getSource('mw-ruta').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: lineaDe(S.plan.muestras) } });
        map.setPaintProperty('mw-ruta', 'line-gradient', gradienteRuta(S.plan));
    } else map.getSource('mw-ruta').setData(VACIO);
    map.getSource('mw-emergencia').setData(emerg ? { type: 'Feature', geometry: { type: 'LineString', coordinates: lineaDe(r.muestras) } } : VACIO);
    map.getSource('mw-alternativas').setData({ type: 'FeatureCollection', features: S.navegando ? [] : PERFILES_UI.filter(id => id !== S.perfil && S.resultados[id]?.factible)
        .map(id => ({ type: 'Feature', properties: { perfil: id }, geometry: { type: 'LineString', coordinates: lineaDe(S.resultados[id].muestras) } })) });
    // Inicio y fin propios (la base se dibuja siempre: es el mástil de radio)
    for (const [clave, x] of [['inicio', S.inicio], ['fin', S.fin]]) {
        if (!x) continue;
        const el = document.createElement('div');
        el.className = `g-m-${clave}`; el.innerHTML = clave === 'fin' ? `<span class="gota">${ICO.meta}</span>` : ''; el.title = x.nombre;
        S.marcadores.push(new maplibregl.Marker({ element: el, anchor: clave === 'fin' ? 'bottom' : 'center' }).setLngLat([x.lon, x.lat]).addTo(map));
    }
    // Base
    const base = document.createElement('div');
    base.className = 'g-m-base'; base.innerHTML = ICO.base; base.title = S.puntos.habitat.nombre;
    S.marcadores.push(new maplibregl.Marker({ element: base }).setLngLat([S.habitat.lon, S.habitat.lat])
        .setPopup(new maplibregl.Popup({ className: 'g-popup', offset: 20 }).setHTML(`<h3>${S.puntos.habitat.nombre}</h3><p>${S.puntos.habitat.porque}</p>${boton360({ id: 'base' })}`)).addTo(map));
    // Paradas
    const orden = new Map((S.plan?.paradas || []).map((p, i) => [p.id, i + 1]));
    const etiquetas = [];
    for (const p of S.paradas.filter(x => x.activa || orden.has(x.id))) {
        const n = orden.get(p.id);
        const el = document.createElement('div');
        // Antes de salir, la parada «actual» es la primera; al navegar, la siguiente (ver actualizarTiempo).
        const destino = S.navegando ? S.siguienteParada : S.plan?.paradas?.[0]?.id;
        el.className = `g-m-parada${n ? '' : ' omitida'}${p.id === destino ? ' siguiente' : ''}${S.navegando && S.hechas?.includes(p.id) ? ' hecha' : ''}`; el.textContent = n || '';
        el.dataset.parada = p.id;
        const l = S.plan?.paradas.find(x => x.id === p.id);
        const pop = new maplibregl.Popup({ className: 'g-popup', offset: 16 }).setHTML(
            `<h3>${p.nombre}</h3><p class="meta">${l ? `Llegada ${formatHora(l.llegadaLtst)}, O₂ restante ${pct(l.o2Llegada)}` : 'No entra en esta EVA con la reserva del perfil'}</p>` +
            `<p>${p.que}</p><p><b>Por qué importa:</b> ${p.porque}</p><p><b>Muestra:</b> ${p.muestra}</p><p><b>Rover:</b> ${p.rover}</p>${boton360(p)}`);
        S.marcadores.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).setPopup(pop).addTo(map));
        if (n) etiquetas.push({ type: 'Feature', properties: { nombre: p.nombre }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
    }
    map.getSource('mw-etiquetas').setData({ type: 'FeatureCollection', features: etiquetas });
    // Punto de no retorno o de margen mínimo
    const ref = emerg ? r : S.plan;
    if (ref?.factible) {
        const k = ref.pnr >= 0 ? ref.pnr : ref.puntoCompromiso;
        if (k != null && k >= 0 && (ref.pnr >= 0 || (S.navegando && ref.margenMin < 0.15))) {
            const el = document.createElement('div');
            el.className = 'g-m-chip';
            el.innerHTML = `<i style="--c:${ref.pnr >= 0 ? '#d93025' : '#f9ab00'}"></i>${ref.pnr >= 0 ? 'Punto de no retorno' : `Margen mínimo ${pct(Math.max(0, ref.margenMin))}`}`;
            S.marcadores.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 14] }).setLngLat([ref.muestras.lon[k], ref.muestras.lat[k]]).addTo(map));
        }
    }
    // Caminante: punto azul en la vista general, flecha de navegación tumbada sobre el suelo al navegar.
    const p = document.createElement('div');
    if (S.navegando) {
        p.innerHTML = `<svg class="g-flecha-nav" viewBox="0 0 48 48"><path d="M24 3 8 43l16-9 16 9z" fill="${emerg ? '#d93025' : '#1a73e8'}" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/></svg>`;
        S.puck = new maplibregl.Marker({ element: p, rotationAlignment: 'map', pitchAlignment: 'map' });
    } else {
        p.className = `g-punto${emerg ? ' emergencia' : ''}`;
        S.puck = new maplibregl.Marker({ element: p });
    }
    if (r?.factible) S.puck.setLngLat([r.muestras.lon[0], r.muestras.lat[0]]).addTo(map);
    S.marcadores.push(S.puck);
}

/** Pasa la ruta activa al mundo 3D: la pinta en el suelo, precarga sus teselas y deja construido el punto de salida. */
function rutaAlMundo() {
    const r = S.activo;
    if (!M || !r?.factible) return;
    const s = r.muestras, lim = PERFILES[r.perfil]?.pendienteMax || 20, emergencia = !!r.esEmergencia;
    const colores = Array.from(s.pend, p => emergencia ? '#ea4335' : p / lim > 0.8 ? '#ea4335' : p / lim > 0.55 ? '#fbbc04' : '#4285f4');
    const orden = (emergencia ? r : S.plan)?.paradas || [];
    const paradas = orden.map((p, i) => { const x = S.paradas.find(q => q.id === p.id); return x && { id: p.id, nombre: x.nombre, n: i + 1, lon: x.lon, lat: x.lat }; }).filter(Boolean);
    const fin = S.fin || S.habitat;
    paradas.push({ id: 'base', nombre: S.fin ? S.fin.nombre : 'Base', base: true, lon: fin.lon, lat: fin.lat });
    M.fijarRuta(s, colores, paradas, { emergencia }).catch(() => {});
    calentarMundo();
}
/** Deja el punto de salida construido en el mundo 3D (mallas, texturas, sombreadores), pero solo con el mapa quieto. */
function calentarMundo() {
    clearTimeout(S.tCalentar);
    S.tCalentar = setTimeout(() => {
        const r = S.activo;
        if (!M || !r?.factible || M.visible) return;
        if (S.llegando || S.map.isMoving()) { calentarMundo(); return; }
        const s = r.muestras, m = S.navegando ? muestraEn(S.t) : { lon: s.lon[0], lat: s.lat[0] };
        M.calentar(m.lon, m.lat).catch(e => console.warn('[ruta] mundo 3D:', e.message));
    }, 700);
}
/** Muestra u oculta el mundo 3D según el estado de la navegación (3D o astronauta → mundo; 2D → mapa). */
function sincronizarMundo(op) {
    if (!M) return;
    M.astronauta(!S.previa && (S.astronauta || !!S.mirador3d), !M.visible);
    M.mostrar(mundoActivo(), op);
    document.body.classList.toggle('mundo3d', mundoActivo());
    pintarBoton3D();
}

function limpiarMarcadores() { S.marcadores.forEach(m => m.remove()); S.marcadores = []; S.puck = null; }

function dibujarManiobra(m) {
    const src = S.map.getSource('mw-maniobra');
    if (!m || m.llegada || !S.navegando) { src.setData(VACIO); M?.maniobra(null); return; }
    const s = S.activo.muestras, total = s.dist[s.dist.length - 1];
    const pts = [];
    for (let d = Math.max(0, m.dist - 45); d <= Math.min(total, m.dist + 35); d += 5) pts.push(puntoA(s, d));
    const fin = pts[pts.length - 1], pre = pts[pts.length - 3] || pts[0];
    M?.maniobra(pts, { dist: m.dist, giro: m.giro });
    src.setData({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.slice(0, -1) } },
        { type: 'Feature', properties: { rumbo: rumboEntre(pre[0], pre[1], fin[0], fin[1]) }, geometry: { type: 'Point', coordinates: fin } },
    ] });
}

// ───────────────────────── recomendación y planificación ─────────────────────────

/**
 * Recomendación de perfil (regla explícita, docs/planificador_rutas.md):
 *  1. Se descartan los planes no factibles y los NO-GO.
 *  2. Se parte del perfil más seguro que quede.
 *  3. Se sube a uno más arriesgado solo si compensa de verdad:
 *     a) más ciencia: al menos una parada más y +15 % de valor, con ≥ 10 % de margen; o
 *     b) misma ciencia en mucho menos tiempo: ≥ 30 min y ≥ 15 % más corta, sin terreno más empinado (+2° como
 *        mucho) y con ≥ 15 % de margen. En una EVA el tiempo también es riesgo (consumibles, radiación, luz),
 *        pero ahorrar unos minutos nunca justifica más riesgo.
 */
function recomendar() {
    const orden = PERFILES_UI.map(id => [id, S.resultados[id]]).filter(([, r]) => r?.factible);
    const validos = orden.filter(([, r]) => r.veredicto !== 'NO-GO');
    const lista = validos.length ? validos : orden;
    if (!lista.length) return null;
    let [id, r] = lista[0];
    const motivos = [];
    for (const [id2, r2] of lista.slice(1)) {
        const masParadas = r2.paradas.length > r.paradas.length;
        const masCiencia = masParadas && r2.valorCiencia >= r.valorCiencia * 1.15 && r2.margenMin >= 0.10;
        const ahorro = r.duracion - r2.duracion;
        const masRapida = r2.valorCiencia >= r.valorCiencia && ahorro >= 1800 && ahorro >= 0.15 * r.duracion
            && r2.pendienteMax <= r.pendienteMax + 2 && r2.margenMin >= 0.15;
        const nombre = PERFILES[id2].nombre;
        if (masCiencia) {
            motivos.push(`${nombre} añade ${r2.paradas.length - r.paradas.length} parada(s) y ${r2.valorCiencia - r.valorCiencia} puntos de ciencia sin bajar del 10 % de margen`);
            [id, r] = [id2, r2];
        } else if (masRapida) {
            motivos.push(`${nombre} consigue la misma ciencia ${Math.round(ahorro / 60)} min antes, sin pendientes más fuertes y con ${pct(r2.margenMin)} de margen: menos tiempo expuesto`);
            [id, r] = [id2, r2];
        } else {
            const dt = Math.round(ahorro / 60);
            const porque = r2.valorCiencia > r.valorCiencia && !masParadas ? `${r2.valorCiencia - r.valorCiencia} puntos más sin paradas nuevas`
                : masParadas && r2.margenMin < 0.10 ? `deja solo un ${pct(Math.max(0, r2.margenMin))} de margen para volver`
                : masParadas ? 'la ciencia extra es pequeña'
                : dt > 0 && dt < 30 ? `la misma ciencia y solo ${dt} min menos`
                : dt >= 30 && r2.pendienteMax > r.pendienteMax + 2 ? `ahorra ${dt} min pero con pendientes de hasta ${Math.round(r2.pendienteMax)}°`
                : dt >= 30 ? `ahorra ${dt} min pero con poco margen` : 'no mejora la ciencia ni el tiempo';
            motivos.push(`${nombre} no compensa: ${porque}`);
        }
    }
    return { id, texto: `${motivos.join('. ')}.` };
}

const destinoNombre = () => S.fin ? S.fin.nombre : 'la base';
const punto = x => x ? { lon: x.lon, lat: x.lat } : undefined;
function mensajePlan(perfil, extra = {}) {
    return { tipo: 'planificar', habitat: S.habitat, inicio: punto(S.inicio), fin: punto(S.fin), perfil, traje: S.traje, cond: S.cond, inicioUTC: utcSalida(),
        paresCache: S.meta ? cacheActual().perfiles[perfil] : undefined,
        paradas: S.paradas.filter(p => p.activa).map(({ id, nombre, lon, lat, valor, trabajoMin, obligatoria }) => ({ id, nombre, lon, lat, valor, trabajoMin, obligatoria })), ...extra };
}

/** Campos de coste del destino en cada worker mientras el usuario mira el mapa (la primera ruta sale antes). */
function precalentar(conIda = false) {
    for (const id of PERFILES_UI) workerDe(id).llamar({ tipo: 'precalentar', perfil: id, habitat: S.fin || S.habitat, traje: S.traje, conIda }).catch(() => {});
}

async function planificar() {
    leerTraje();
    const boton = $('#mw-iniciar'), barra = $('.barra', boton), txt = $('span', boton);
    boton.disabled = true; txt.textContent = 'Buscando rutas…'; barra.style.width = '4%';
    const marca = ++S.ultimoPlan;
    S.resultados = {}; pintarOpciones();
    T0.inicioPlan ??= performance.now();
    try {
        aviso(null);
        const prog = {};
        const res = await Promise.all(PERFILES_UI.map(id => workerDe(id).llamar(mensajePlan(id), p => {
            prog[id] = p.frac;
            barra.style.width = `${Math.round(Math.min(...PERFILES_UI.map(k => prog[k] ?? 0)) * 100)}%`;
        }).then(r => { guardarPares(id, r.paresNuevos); if (marca === S.ultimoPlan) { S.resultados[id] = r; pintarOpciones(); } return r; })));
        if (marca !== S.ultimoPlan) return;
        PERFILES_UI.forEach((id, i) => { S.resultados[id] = res[i]; });
        T0.primerPlan ??= performance.now();
        S.recomendacion = recomendar();
        if (!S.idaPrecalculada) { S.idaPrecalculada = true; setTimeout(() => precalentar(true), 500); }
        if (!S.eleccionManual && S.recomendacion) S.perfil = S.recomendacion.id;
        activar(S.resultados[S.perfil]);
        if (S.resultados[S.perfil]?.rendimiento) console.info('[ruta] rendimiento', S.resultados[S.perfil].rendimiento);
    } catch (e) {
        console.error(e);
        aviso({ titulo: 'No se pudieron calcular las rutas', texto: String(e.message).split('\n')[0], critico: true });
    } finally {
        boton.disabled = false; txt.textContent = 'Iniciar salida'; barra.style.width = '0';
    }
}

function elegirPerfil(id) {
    S.perfil = id;
    S.eleccionManual = id !== S.recomendacion?.id;
    const r = S.resultados[id];
    if (r) activar(r); else planificar();
    if (S.capas.pendiente) actualizarCapa('pendiente');
    if (S.capas.alcance) actualizarCapa('alcance');
}

function activar(r, { mantenerTiempo = false } = {}) {
    S.activo = r;
    if (!r.esEmergencia) { S.plan = r; S.tOffset = 0; S.eOffset = 0; }
    pintarOpciones(); pintarPasos(); pintarResumen();
    if (!r.factible) { limpiarMarcadores(); S.map.getSource('mw-ruta').setData(VACIO); return; }
    S.maniobras = calcularManiobras(r);
    tiempo.fijar(r, PERFILES[r.perfil] || PERFILES[S.perfil]);
    dibujarRuta();
    rutaAlMundo();
    if (!mantenerTiempo) { S.t = 0; if (!S.navegando) encuadrar(r); }
    actualizarTiempo(S.t);
    if (S.capas.alcance) { S.alcanceDesde = undefined; actualizarCapa('alcance'); }
}

function encuadrar(r, dur = 1800) {
    if (!document.body.classList.contains('modo-ruta')) return;
    const s = r.muestras;
    let w = Infinity, e = -Infinity, so = Infinity, n = -Infinity;
    for (let k = 0; k < s.lon.length; k++) { w = Math.min(w, s.lon[k]); e = Math.max(e, s.lon[k]); so = Math.min(so, s.lat[k]); n = Math.max(n, s.lat[k]); }
    const ancho = innerWidth > 760;
    // En móvil el panel ocupa la mitad superior: la ruta se encuadra en el mapa visible de abajo.
    const padding = ancho ? { left: 430, right: 80, top: 70, bottom: 60 } : { left: 24, right: 60, top: Math.round(innerHeight * 0.56), bottom: 24 };
    // Viniendo de lejos (vista global) se vuela en planta, sin horizonte a la vista; la inclinación llega al aterrizar
    // (ver `aterrizar`). Ya en Jezero, el encuadre se hace con la vista inclinada de siempre.
    const lejos = S.llegando || S.map.getZoom() < 9.5;
    if (lejos) S.llegando = true;
    else if (S.map.getTerrain()) { S.relievePausado = true; S.map.setTerrain(null); anclar(); }
    S.map.fitBounds([[w, so], [e, n]], { padding, pitch: lejos ? 0 : S.tresD ? 50 : 0, bearing: lejos ? 0 : S.tresD ? -15 : 0,
        duration: reducirMovimiento ? 0 : lejos ? 2800 : dur, maxZoom: 13.8, essential: true });
}

// ───────────────────────── luz y cielo reales ─────────────────────────

const mezclar = (a, b, f) => {
    const h = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
    const A = h(a), B = h(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * Math.max(0, Math.min(1, f))).toString(16).padStart(2, '0')).join('');
};
/**
 * Ilumina el terreno con la posición real del Sol (Mars24) en Jezero en el instante `utc`: dirección y altura
 * del sombreado, color del cielo (ocre de día por el polvo; azulado al atardecer, como lo fotografiaron
 * Curiosity y Perseverance) y sombras proyectadas por el relieve (calculadas en el worker).
 */
function iluminar(utc, forzar = false) {
    if (!S.luzReal || !document.body.classList.contains('modo-ruta')) return;
    const sol = sunPosition(utc, S.habitat.lon, S.habitat.lat);
    const dif = Math.abs(sol.elev - (S.ultimaLuz?.elev ?? 999)) + Math.abs(sol.az - (S.ultimaLuz?.az ?? 999)) / 4;
    // En reproducción, el sombreado solo se re-renderiza con cambios de luz perceptibles (re-renderizar las
    // teselas de relieve en 3D es lo más caro de cada fotograma).
    if (!forzar && dif < (S.reproduciendo ? 2.5 : 0.6)) return;
    S.ultimaLuz = sol;
    const map = S.map, e = Math.max(0, sol.elev);
    try {
        map.setPaintProperty('ruta-relieve', 'hillshade-illumination-direction', sol.az);
        map.setPaintProperty('ruta-relieve', 'hillshade-illumination-altitude', Math.max(2, Math.min(80, e)));
        // Sin malla 3D (modo fluido al navegar) el relieve solo se lee por el sombreado: se refuerza.
        const plano = !map.getTerrain();
        map.setPaintProperty('ruta-relieve', 'hillshade-exaggeration', plano ? 0.85 : sol.elev < 15 ? 0.7 : 0.45);
        if (map.getLayer('ruta-relieve-ambiente')) map.setPaintProperty('ruta-relieve-ambiente', 'hillshade-exaggeration', plano ? 0.6 : 0.35);
    } catch { /* versiones sin altura de iluminación */ }
    const dia = Math.min(1, e / 20), noche = sol.elev < -4;
    try {
        map.setSky({ 'sky-color': noche ? '#0b0d1f' : mezclar('#3d5f9a', '#c79466', dia), 'horizon-color': noche ? '#141a3a' : mezclar('#8fb4e8', '#ecc9a0', dia),
            'fog-color': noche ? '#141018' : mezclar('#6b5a6e', '#d0a27a', dia), 'sky-horizon-blend': 0.7,
            // En modo astronauta, sin niebla: la niebla de MapLibre pinta una franja beige que se mueve con la cámara y tapa
            // el relieve lejano, que el propio mapa sí dibuja (frente del delta y borde del cráter).
            'horizon-fog-blend': S.astronauta ? 1 : 0.6, 'fog-ground-blend': S.astronauta ? 1 : 0.4,
            ...(S.astronauta ? { 'sky-horizon-blend': 0.5 } : {}), 'atmosphere-blend': 0 });
    } catch { /* sin cielo */ }
    map.setPaintProperty('ruta-orto', 'raster-brightness-max', noche ? 0.25 : 0.6 + 0.4 * dia);
    if (map.getLayer('ruta-hirise')) map.setPaintProperty('ruta-hirise', 'raster-brightness-max', noche ? 0.25 : 0.6 + 0.4 * dia);
    if (map.getLayer('astro-relieve') && (forzar || !S.reproduciendo || !S.astronauta || dif > 8)) try {
        map.setPaintProperty('astro-relieve', 'hillshade-illumination-direction', sol.az);
        map.setPaintProperty('astro-relieve', 'hillshade-illumination-altitude', Math.max(2, Math.min(80, e)));
        map.setPaintProperty('astro-relieve', 'hillshade-exaggeration', 0.85);
    } catch { /* versiones sin altura de iluminación */ }
    const umbralE = S.reproduciendo ? 4 : 1.5, umbralA = S.reproduciendo ? 8 : 3;
    if (S.capas.sombra && !S.astronauta && (forzar || ((Math.abs(sol.elev - (S.ultimaSombra ?? 999)) > umbralE || Math.abs(sol.az - (S.ultimaSombraAz ?? 999)) > umbralA)
        && performance.now() - (S.ultimaSombraT || 0) > 1500))) {
        S.ultimaSombra = sol.elev; S.ultimaSombraAz = sol.az; S.ultimaSombraT = performance.now();
        actualizarCapa('sombra', utc);
    }
}

// ───────────────────────── voz ─────────────────────────

let vozEn = null;
/**
 * La voz depende del sistema: cada máquina ofrece su lista y la primera en-US puede ser robótica (en macOS, Fred o
 * Albert). Se puntúan las voces y se elige la más natural que haya: las «mejoradas/premium/neural», Google US English
 * en Chrome, las de Edge «Online (Natural)» o las buenas de Apple (Samantha, Ava…); las de efectos nunca.
 */
const VOCES_RARAS = /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Princess|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley)\b/i;
const VOCES_BUENAS = /\b(Samantha|Ava|Allison|Susan|Zoe|Evan|Nathan|Tom|Alex|Joelle|Noelle|Aaron|Nicky)\b/i;
function puntuarVoz(v) {
    if (!/^en/i.test(v.lang) || VOCES_RARAS.test(v.name)) return -1;
    let p = /^en(-|_)US/i.test(v.lang) ? 10 : 0;
    if (/premium|enhanced|mejorad|neural|natural/i.test(v.name)) p += 40;
    if (/Google US English/i.test(v.name)) p += 35;
    if (VOCES_BUENAS.test(v.name)) p += 20;
    if (/Google/i.test(v.name)) p += 5;
    return p;
}
function elegirVozEn(voces, soloLocales = false) {
    let mejor = null, pm = -1;
    for (const v of voces) {
        if (soloLocales && !v.localService) continue;
        const p = puntuarVoz(v); if (p > pm) { pm = p; mejor = v; }
    }
    return mejor;
}
let sinRed = false;          // las voces «Online» de Edge necesitan internet: si fallan, se pasa a una local
// Las voces cargan en segundo plano: se elige de nuevo cuando la lista cambia.
if ('speechSynthesis' in window) {
    try { speechSynthesis.getVoices(); speechSynthesis.addEventListener?.('voiceschanged', () => { vozEn = null; }); } catch { /* */ }
}
/** Indicaciones habladas en inglés (Web Speech API). Lo no crítico se omite si la voz sigue hablando: nunca va con retraso. */
function hablar(texto, critico = false) {
    if (!S.voz || !('speechSynthesis' in window) || !texto) return;
    const sint = window.speechSynthesis;
    if (sint.speaking && !critico) return;
    if (critico) sint.cancel();
    vozEn = vozEn || elegirVozEn(sint.getVoices(), sinRed);
    const u = new SpeechSynthesisUtterance(texto);
    if (vozEn && !vozEn.localService) {
        u.onerror = e => {
            if (sinRed || e.error === 'interrupted' || e.error === 'canceled') return;
            sinRed = true; vozEn = null; hablar(texto, critico);       // se repite una vez con una voz del sistema
        };
    }
    u.lang = 'en-US'; u.rate = 1.0; if (vozEn) u.voice = vozEn;
    sint.speak(u);
}
const distEn = m => m >= 950 ? `${(m / 1000).toFixed(1)} kilometers` : `${Math.max(10, Math.round(m / 10) * 10)} meters`;
const pctEn = v => `${Math.round(v * 100)} percent`;
function maniobraEn(m) {
    if (m.llegada) return m.llegada === 'la base' ? 'arrive at the base' : `arrive at ${m.llegada}`;
    const lado = m.giro > 0 ? 'right' : 'left', g = Math.abs(m.giro);
    const verbo = g < 40 ? `turn slightly ${lado}` : g < 115 ? `turn ${lado}` : `make a sharp ${lado}`;
    return `${verbo} toward ${m.hacia === 'la base' ? 'the base' : m.hacia}`;
}
const TRAMO_EN = { pendiente: 'steep slope ahead', sombra: 'shadowed section ahead', cobertura: 'entering a radio shadow, no direct link to the base',
    solBajo: 'the Sun is getting low', noche: 'night will fall before you return', pnr: 'point of no return ahead' };

// ───────────────────────── avisos durante el camino ─────────────────────────

const TIPOS_TRAMO = ['pendiente', 'sombra', 'cobertura', 'solBajo', 'noche'];
/** Resalta sobre el terreno el tramo con aviso en el que se está o el siguiente a menos de 400 m. */
function resaltarTramo(r, m) {
    const s = r.muestras;
    const a = (r.alertas || []).find(x => TIPOS_TRAMO.includes(x.tipo) && x.fin > x.ini && s.dist[x.fin] > m.dist && s.dist[x.ini] - m.dist < 400);
    const clave = a ? `${a.tipo}:${a.ini}` : '';
    if (clave === S.tramoResaltado) return;
    S.tramoResaltado = clave;
    const fuente = S.map.getSource('mw-tramo-aviso');
    if (!a) { fuente.setData(VACIO); M?.tramoAviso(null); return; }
    const coords = [];
    for (let k = a.ini; k <= a.fin; k++) coords.push([s.lon[k], s.lat[k]]);
    const color = a.nivel === 'critica' ? '#ea4335' : a.tipo === 'cobertura' ? '#a142f4' : a.tipo === 'sombra' ? '#3c4a8a' : '#fbbc04';
    fuente.setData({ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: coords } });
    M?.tramoAviso({ ini: a.ini, fin: a.fin, color });
}

const PREAVISO_M = 150;
/**
 * Avisos al estilo de la navegación: se anuncian una sola vez, con antelación (150 m) para los tramos
 * de la ruta y al cruzar umbrales para los consumibles. Los críticos se muestran en rojo.
 */
function avisosEnRuta(r, m, enParada) {
    if (!S.navegando || !S.reproduciendo) return;
    const A = S.anunciados || (S.anunciados = new Set());
    const s = r.muestras, n = s.t.length - 1;
    const una = (clave, a, voz) => { if (A.has(clave)) return; A.add(clave); aviso(a); hablar(voz, !!a.critico); };
    // Llegada a una parada: ficha de trabajo
    if (enParada) {
        const p = S.paradas.find(x => x.id === enParada.id);
        una(`llegada:${enParada.id}`, { titulo: `Has llegado a ${enParada.nombre}`, texto: `${p?.muestra || 'Trabajo de campo'} Tienes ${fmtDur(enParada.trabajoS)}; quedará un ${pct(Math.max(0, enParada.margenSalida))} de margen al salir.${p && hayPanorama(p.id) ? `<br>${boton360(p)}` : ''}` },
            `You have arrived at ${enParada.nombre}. ${Math.round(enParada.trabajoS / 60)} minutes of field work.`);
        return;
    }
    resaltarTramo(r, m);
    // Tramos señalados en la planificación, avisados antes de llegar
    for (const [i, a] of (r.alertas || []).entries()) {
        if (a.ini == null || a.ini <= 0 || !['pendiente', 'sombra', 'cobertura', 'solBajo', 'noche', 'pnr'].includes(a.tipo)) continue;
        // Se anuncia si el tramo empieza en menos de 150 m y aún no se ha dejado atrás (a velocidades altas
        // el caminante puede saltarse la ventana de preaviso entre dos comprobaciones).
        const d = s.dist[a.ini] - m.dist;
        if (d < PREAVISO_M && s.dist[a.fin] > m.dist) {
            const titulo = { pendiente: 'Pendiente fuerte', sombra: 'Tramo en sombra', cobertura: 'Sin radio directa con la base',
                solBajo: 'El Sol está bajando', noche: 'Se hará de noche', pnr: 'Punto de no retorno' }[a.tipo];
            una(`tramo:${i}`, { titulo: d > 10 ? `En ${fmtKm(d)}: ${titulo.toLowerCase()}` : titulo, texto: a.texto, critico: a.nivel === 'critica' },
                `${a.nivel === 'critica' ? 'Warning. ' : ''}${d > 10 ? `In ${distEn(d)}, ` : ''}${TRAMO_EN[a.tipo]}.`);
            return;
        }
    }
    // Fin de tramos con aviso (radio recuperada, vuelta al sol), como el «fin del atasco» de la navegación
    for (const [i, a] of (r.alertas || []).entries()) {
        if (!['cobertura', 'sombra'].includes(a.tipo) || !A.has(`tramo:${i}`)) continue;
        if (m.dist >= s.dist[a.fin] && m.dist - s.dist[a.fin] < 200) {
            if (a.tipo === 'cobertura') una(`fin:${i}`, { titulo: 'Radio con la base recuperada', texto: 'Vuelves a tener línea de visión con el mástil de la base.' }, 'Radio link to the base restored.');
            else una(`fin:${i}`, { titulo: 'Vuelves al sol', texto: 'Fin del tramo en sombra: el traje recupera aporte solar.' }, 'You are back in sunlight.');
            return;
        }
    }
    // Consumibles y margen
    const o2 = 1 - m.o2;
    if (o2 < 0.5) una('o2-50', { titulo: 'Queda la mitad del oxígeno', texto: `Llegarás a la base con un ${pct(1 - s.o2[n])} de O₂.` },
        `Half of your oxygen is left. You will reach the base with ${pctEn(1 - s.o2[n])}.`);
    if (o2 < 0.3) una('o2-30', { titulo: 'Oxígeno por debajo del 30 %', texto: 'No añadas paradas: sigue la ruta de vuelta.', critico: true },
        'Warning. Oxygen below 30 percent. Do not add stops.');
    if (1 - m.bat < 0.3) una('bat-30', { titulo: 'Batería por debajo del 30 %', texto: 'Calefacción y comunicaciones en modo de ahorro.', critico: true },
        'Warning. Battery below 30 percent.');
    if (m.margen < 0.1 && m.margen >= 0) una('margen-10', { titulo: `Límite de vuelta a pie: ${fmtLimite(limiteVuelta(m.margen))}`, texto: 'A partir de aquí cualquier retraso consume la reserva.', critico: true },
        'Warning. Return margin below 10 percent.');
    if (m.margen < 0) una('margen-0', { titulo: 'Has superado el punto de no retorno', texto: 'Vuelve ya por la ruta de emergencia.', critico: true },
        'Warning. You have passed the point of no return. Head back now.');
}

// ───────────────────────── navegación ─────────────────────────

function muestraEn(t) {
    const s = S.activo.muestras, k = indice(s.t, t), k2 = Math.min(s.t.length - 1, k + 1);
    const f = s.t[k2] > s.t[k] ? (t - s.t[k]) / (s.t[k2] - s.t[k]) : 0;
    const lerp = a => a[k] + (a[k2] - a[k]) * f;
    return { k, lon: lerp(s.lon), lat: lerp(s.lat), elev: lerp(s.elev), dist: lerp(s.dist), o2: lerp(s.o2), bat: lerp(s.bat), agua: lerp(s.agua),
        dosis: lerp(s.dosis), margen: lerp(s.margen), ltst: s.ltst[k], pend: s.pend[k], sombra: s.sombra[k], cobertura: s.cobertura[k], solElev: lerp(s.solElev),
        ener: s.ener ? lerp(s.ener) : 0, met: s.met ? s.met[k2] : 0 };
}

let rumboCamara = null, ultimaCamara = 0;
/** Suavizado exponencial del rumbo de la cámara, independiente de los fotogramas por segundo. */
function suavizarRumbo(objetivo) {
    if (objetivo == null || !Number.isFinite(objetivo)) return rumboCamara ?? 0;
    const ahora = performance.now(), dt = ultimaCamara ? Math.min(0.25, (ahora - ultimaCamara) / 1000) : 1;
    ultimaCamara = ahora;
    if (rumboCamara == null) return (rumboCamara = objetivo);
    const dif = ((((objetivo - rumboCamara) % 360) + 540) % 360) - 180;
    let paso = dif * (1 - Math.exp(-(S.astronauta ? 0.9 : 2.2) * dt));
    // En primera persona un giro brusco marea: además del suavizado, la cabeza gira como mucho 40° por segundo.
    if (S.astronauta) { const max = 40 * dt; paso = Math.max(-max, Math.min(max, paso)); }
    rumboCamara = (rumboCamara + paso + 360) % 360;
    return rumboCamara;
}
function actualizarTiempo(t) {
    if (!S.activo?.factible) return;
    const r = S.activo, s = r.muestras, dur = s.t[s.t.length - 1], total = s.dist[s.dist.length - 1] || 1;
    S.t = Math.max(0, Math.min(dur, t));
    const m = muestraEn(S.t);
    if (!S.navegando) { tiempo.fijarTiempo(S.t); pintarZonasCuerpo(S.t); }   // el panel (y su perfil) está oculto al navegar: no se redibuja 60 veces por segundo
    S.puck?.setLngLat([m.lon, m.lat]);
    // En modo astronauta el rumbo se mira en un tramo más largo (60 m por delante, 20 por detrás): la cámara empieza a
    // girar antes de la curva y no reacciona a cada pequeño quiebro del camino.
    const delante = S.astronauta ? 60 : 25, detras = S.astronauta ? 20 : 5;
    const ahead = puntoA(s, Math.min(total, m.dist + delante)), atras = puntoA(s, Math.max(0, m.dist - detras));
    const distDelta = Math.hypot(ahead[0] - atras[0], ahead[1] - atras[1]);
    const rumbo = distDelta > 1e-6 ? rumboEntre(atras[0], atras[1], ahead[0], ahead[1]) : (rumboCamara ?? 0);
    if (S.navegando) S.puck?.setRotation(rumbo);
    // Con el mundo 3D a la vista el mapa queda debajo, quieto: no se le cambia nada (cada cambio lo haría redibujarse).
    const enMundo = mundoActivo();
    // Tramo recorrido en gris (en reproducción, como mucho cada 0,6 s)
    const ahora = performance.now();
    if (!enMundo && !r.esEmergencia && ahora - (S.ultimoGrad || 0) > (S.reproduciendo ? 600 : 0)) { S.ultimoGrad = ahora; S.map.setPaintProperty('mw-ruta', 'line-gradient', gradienteRuta(r, m.dist / total)); }
    if (!enMundo) iluminar(utcSalida() + (S.t + S.tOffset) * 1000);
    seguirAlcance();
    if (!S.navegando) return;
    // Cámara en tercera persona: detrás del caminante, mirando hacia donde va (cada fotograma).
    if (enMundo) {
        // Mundo 3D: cámara de seguimiento o, en modo astronauta, en los ojos del caminante. Sol real en cada fotograma.
        suavizarRumbo(rumbo);
        M.actualizar({ lon: m.lon, lat: m.lat, dist: m.dist, rumbo: rumboCamara, progreso: r.esEmergencia ? -1 : m.dist, siguiente: S.siguienteParada ?? null, hechas: S.hechas,
            sol: sunPosition(utcSalida() + (S.t + S.tOffset) * 1000, S.habitat.lon, S.habitat.lat),
            viento: { ms: S.cond?.vientoMs, dir: S.cond?.vientoDir, tau: S.cond?.tau } });
        if (S.astronauta) fijarRumboVisor(rumboCamara);
    } else if (S.seguir !== false) {
        suavizarRumbo(rumbo);
        // El caminante queda justo por encima de la hoja inferior (más alta en móvil), con el camino por delante.
        if (S.astronauta) {
            // Modo astronauta: la cámara va en los ojos del caminante (js/ruta/astronauta.js).
            camaraAstronauta(S.map, m.lon, m.lat, rumboCamara);
            actualizarRocas(S.map, m.lon, m.lat, S.ultimaLuz, S.activo?.muestras, { ms: S.cond?.vientoMs, dir: S.cond?.vientoDir, tau: S.cond?.tau });
        } else {
            const alto = S.map.getContainer().clientHeight;
            const hoja = (S.altoHoja ||= document.querySelector('.g-hoja')?.offsetHeight || 150) + 24;
            S.map.jumpTo({ center: [m.lon, m.lat], bearing: rumboCamara, pitch: S.tresD ? PITCH_NAV : 0, zoom: ZOOM_NAV,
                padding: { top: Math.max(0, Math.min(alto * 0.42, alto - hoja - 120)), bottom: hoja, left: 0, right: 0 } });
            anclar();
        }
    }
    // Texto del banner y de la hoja: 5 veces por segundo bastan (reescribir el DOM en cada fotograma cuesta).
    if (S.reproduciendo && ahora - (S.ultimoDom || 0) < 200) return;
    S.ultimoDom = ahora;
    // Banner de maniobra
    const enParada = (r.paradas || []).find(p => S.t >= p.llegadaS - 1 && S.t <= p.salidaS);
    const siguiente = enParada || (r.paradas || []).find(p => p.llegadaS > S.t);
    if (S.siguienteParada !== siguiente?.id) {
        S.siguienteParada = siguiente?.id;
        // La parada a la que se va, en azul; las ya hechas, en gris; el resto, en blanco.
        S.hechas = (S.plan?.paradas || []).filter(p => p.salidaS <= S.t + S.tOffset + 1).map(p => p.id).filter(id => id !== siguiente?.id);
        document.querySelectorAll('.g-m-parada').forEach(e => { e.classList.toggle('siguiente', e.dataset.parada === siguiente?.id); e.classList.toggle('hecha', S.hechas.includes(e.dataset.parada)); });
    }
    avisosEnRuta(r, m, enParada);
    const i = S.maniobras.findIndex(x => x.dist > m.dist + 2);
    const prox = S.maniobras[i], luego = S.maniobras[i + 1];
    const banner = $('#mw-banner');
    banner.classList.toggle('emergencia', !!r.esEmergencia);
    if (enParada) {
        if (S.icoBanner !== 'llegada') { S.icoBanner = 'llegada'; $('#mw-ban-ico').innerHTML = iconoGiro('llegada'); }
        $('#mw-ban-dist').textContent = enParada.nombre;
        $('#mw-ban-txt').textContent = `Trabajo de campo, quedan ${fmtDur(Math.max(0, enParada.salidaS - S.t))}${S.reproduciendo ? ' (×6)' : ''}`;
        $('#mw-ban-luego').classList.remove('visible');
        dibujarManiobra(null);
    } else if (prox) {
        const ico = prox.llegada ? 'llegada' : Math.round(prox.giro / 5) * 5;
        if (S.icoBanner !== ico) { S.icoBanner = ico; $('#mw-ban-ico').innerHTML = iconoGiro(ico); }
        $('#mw-ban-dist').textContent = fmtKm(Math.max(0, prox.dist - m.dist));
        $('#mw-ban-txt').textContent = textoManiobra(prox);
        const l = $('#mw-ban-luego');
        if (luego && luego.dist - prox.dist < 250) { l.innerHTML = `Luego ${iconoGiro(luego.llegada ? 'llegada' : luego.giro)} ${luego.llegada ? textoManiobra(luego) : ''}`; l.classList.add('visible'); }
        else l.classList.remove('visible');
        if (S.maniobraDibujada !== prox) { S.maniobraDibujada = prox; dibujarManiobra(prox); }
        const faltan = prox.dist - m.dist, A = S.anunciados || (S.anunciados = new Set());
        if (S.reproduciendo && faltan < 110 && !A.has(`man:${prox.dist}`)) {
            A.add(`man:${prox.dist}`);
            const txt = maniobraEn(prox);
            hablar(faltan > 25 ? `In ${distEn(faltan)}, ${txt}.` : `${txt[0].toUpperCase()}${txt.slice(1)}.`);
        }
    }
    // Hoja inferior
    const resta = dur - S.t;
    const finLtst = s.ltst[s.ltst.length - 1];
    $('#mw-eta').textContent = fmtDur(resta);
    $('#mw-eta').classList.toggle('mal', m.margen < 0);
    $('#mw-eta-sub').textContent = `${fmtKm(total - m.dist)} · llegada a la base ${formatHora(finLtst)}`.replace(' · ', ', ');
    $('#mw-progreso i').style.width = `${(S.t / dur) * 100}%`;
    const c = (txt, v, mal) => `<span class="${mal ? 'mal' : ''}">${txt} <b>${v}</b></span>`;
    // Desnivel de los próximos 300 m (como el aviso de subida de las apps de senderismo)
    let sube = 0, baja = 0;
    for (let k = m.k + 1; k < s.dist.length && s.dist[k] - m.dist <= 300; k++) {
        const dz = s.elev[k] - s.elev[k - 1];
        if (dz > 0) sube += dz; else baja -= dz;
    }
    // Modo astronauta: primero lo que decide si sigues (O₂, margen para volver, radio, lo que viene), después el contexto.
    const p = (txt, v, mal) => `<span class="pri ${mal ? 'mal' : ''}">${txt} <b>${v}</b></span>`;
    $('#mw-indic').innerHTML = `<div class="indic-pri">${p('O₂', pct(1 - m.o2), 1 - m.o2 < (PERFILES[r.perfil]?.reserva ?? 0.25)) +
        p('Límite de vuelta a pie', fmtLimite(limiteVuelta(m.margen)), m.margen < 0.05) +
        p('Próximos 300 m', `+${Math.round(sube)} / −${Math.round(baja)} m`, sube > 40) +
        (m.cobertura ? '' : p('Radio', 'solo vía orbitador', true)) + chipCuerpo(p)}</div>` +
        `<div class="indic-sec">${c('Batería', pct(1 - m.bat)) + c('Pendiente', `${m.pend.toFixed(0)}°`, m.pend > (PERFILES[r.perfil]?.pendienteMax ?? 20) * 0.8) +
        c('Hora local', formatHora(m.ltst)) + c('Rumbo', `${Math.round(rumbo)}° ${RUMBOS[Math.round(rumbo / 22.5) % 16]}`) +
        (m.sombra && m.solElev > 0 ? c('Luz', 'en sombra') : '')}</div>`;
    // Visor del modo astronauta: los mismos datos, en el casco.
    if (S.astronauta) {
        const perfil = PERFILES[r.perfil] || {};
        const clave = enParada ? 'llegada' : prox ? (prox.llegada ? 'llegada' : Math.round(prox.giro / 5) * 5) : '';
        actualizarVisor({
            rumbo: rumboCamara ?? rumbo, claveIcono: clave, icono: clave === '' ? '' : iconoGiro(clave, '#8fe9ff'),
            dist: enParada ? enParada.nombre : prox ? fmtKm(Math.max(0, prox.dist - m.dist)) : '',
            texto: enParada ? `Trabajo de campo, quedan ${fmtDur(Math.max(0, enParada.salidaS - S.t))}` : prox ? textoManiobra(prox) : '',
            o2: 1 - m.o2, bat: 1 - m.bat, margen: Math.max(0, m.margen), limiteTxt: fmtLimite(limiteVuelta(m.margen)), reservaO2: perfil.reserva ?? 0.25,
            hora: formatHora(m.ltst), eta: formatHora(finLtst), pendiente: m.pend, pendienteMax: perfil.pendienteMax ?? 20,
            parada: siguiente?.nombre, emergencia: !!r.esEmergencia,
            alertas: [r.esEmergencia && { texto: 'Ruta de emergencia hacia la base', critico: true },
                m.margen < 0.05 && { texto: 'Límite de vuelta a pie casi agotado', critico: true },
                !m.cobertura && { texto: 'Sin radio directa: solo vía orbitador' },
                m.sombra && m.solElev > 0 && { texto: 'Tramo en sombra' }].filter(Boolean),
        });
    }
}

/** Indicador del cuerpo para quien camina: solo lo que pide actuar ahora (bajar el ritmo, beber). */
function chipCuerpo(p) {
    const F = fisiologiaActual();
    if (!F) return '';
    const z = estadoCuerpo(F, S.t).zonas;
    if (z.corazon.nivel === 'rojo') return p('Cuerpo', 'sobre el umbral: baja el ritmo', true);
    if (z.agua.nivel !== 'verde') return p('Cuerpo', `${z.agua.L.toFixed(1).replace('.', ',')} L de sudor: bebe`, z.agua.nivel === 'rojo');
    if (z.muslos.nivel === 'rojo') return p('Piernas', 'cargadas: pasos cortos al bajar');
    return p('Cuerpo', 'bien');
}

/** Activa o desactiva el modo astronauta (primera persona + visor) durante la navegación. */
function ponerAstronauta(v) {
    if (M) {
        // Con el mundo 3D solo cambia la cámara (de seguimiento a primera persona, con transición) y aparece el visor.
        S.astronauta = !!v;
        document.body.classList.toggle('astronauta', S.astronauta);
        $('#mw-astro')?.setAttribute('aria-pressed', String(S.astronauta));
        mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
        sincronizarMundo({ entrada: false });
        if (!mundoActivo() && S.navegando) S.map.setTerrain(terrenoDe());
        S.altoHoja = 0; S.ultimoDom = 0;
        if (S.navegando) actualizarTiempo(S.t);
        return;
    }
    // Al entrar se guarda la vista 2D/3D que había; al salir se recupera tal cual.
    if (v && !S.astronauta) S.tresDAntesAstro = S.tresD;
    if (!v && S.astronauta && S.tresDAntesAstro != null) { S.tresD = S.tresDAntesAstro; S.tresDAntesAstro = null; }
    S.astronauta = !!v;
    document.body.classList.toggle('astronauta', S.astronauta);
    $('#mw-astro')?.setAttribute('aria-pressed', String(S.astronauta));
    limitesAstronauta(S.map, S.astronauta, { zoomMax: ZOOM_MAX_RUTA, cabeceoMax: 80 });
    if (S.navegando) S.map.setTerrain(terrenoDe());
    // Textura sintética del suelo: retirada (cuesta muchas teselas a z19-20 y las rocas 3D ya dan el primer plano).
    if (S.map.getLayer('astro-detalle')) S.map.setLayoutProperty('astro-detalle', 'visibility', 'none');
    // Capa de sombras del Sol real: en primera persona no aporta y se recalcula cada pocos segundos.
    if (S.map.getLayer('mw-sombra')) S.map.setLayoutProperty('mw-sombra', 'visibility', !S.astronauta && S.capas.sombra && document.body.classList.contains('modo-ruta') ? 'visible' : 'none');
    // Resolución: en pantallas Retina se dibujan 4 veces más píxeles; con el relieve 3D a ras de suelo no compensa.
    if (S.astronauta) { S.pixelRatioAntes ??= S.map.getPixelRatio(); S.map.setPixelRatio(Math.min(1.5, S.pixelRatioAntes)); }
    else if (S.pixelRatioAntes != null) { S.map.setPixelRatio(S.pixelRatioAntes); S.pixelRatioAntes = null; }
    nitidezSuelo(S.astronauta);
    // Con el relieve de detalle, su sombreado sustituye al del DTM de 20 m.
    if (S.map.getLayer('astro-relieve')) {
        S.map.setLayoutProperty('astro-relieve', 'visibility', S.astronauta ? 'visible' : 'none');
        if (S.map.getLayer('ruta-relieve')) S.map.setLayoutProperty('ruta-relieve', 'visibility', S.astronauta ? 'none' : 'visible');
    }
    // Rocas y bloques en 3D (js/ruta/rocas3d.js) y cielo más limpio para ver el relieve lejano.
    if (S.astronauta) activarRocas(S.map).then(ok => { if (ok && S.navegando) actualizarTiempo(S.t); });
    else desactivarRocas(S.map);
    S.ultimaLuz = null; iluminar(utcSalida() + (S.t + S.tOffset) * 1000, true);
    S.altoHoja = 0; S.ultimoDom = 0;
    if (S.navegando) actualizarTiempo(S.t);
}

/**
 * Suelo nítido en modo astronauta. Con la cámara casi horizontal MapLibre carga teselas de baja resolución a partir
 * de pocos metros (hasta 9 niveles de zoom distintos en pantalla): se limitan a 6 niveles y se permiten más teselas,
 * así la imagen HiRISE se mantiene nítida hasta lejos. Algo más de contraste y saturación para que el suelo no se
 * vea lavado de cerca. Al salir se recuperan los valores por defecto de MapLibre (9,314 y 3).
 */
const FUENTES_SUELO = ['jezero-hirise', 'jezero-orto', 'marsdem-hr'];
function nitidezSuelo(activo) {
    const map = S.map;
    if (map.setSourceTileLodParams) for (const id of FUENTES_SUELO) {
        if (map.getSource(id)) try { map.setSourceTileLodParams(activo ? 6 : 9.314, activo ? 8 : 3, id); } catch { /* fuente sin teselas */ }
    }
    for (const id of ['ruta-hirise', 'ruta-orto']) if (map.getLayer(id)) {
        map.setPaintProperty(id, 'raster-contrast', activo ? 0.22 : 0);
        map.setPaintProperty(id, 'raster-saturation', activo ? 0.12 : 0);
    }
}

let ultimoFrame = 0;
function bucle(ts) {
    if (!S.reproduciendo) return;
    const dt = ultimoFrame ? Math.min(0.5, (ts - ultimoFrame) / 1000) : 0;
    ultimoFrame = ts;
    const dur = S.activo.muestras.t[S.activo.muestras.t.length - 1];
    // El trabajo de campo en una parada se reproduce a ×6 para que la simulación no se detenga.
    vigilarRendimiento(ts);
    const trabajando = (S.activo.paradas || []).some(p => S.t >= p.llegadaS && S.t < p.salidaS);
    actualizarTiempo(S.t + dt * S.velocidad * (trabajando ? 6 : 1));
    if (S.t >= dur) { pausar(); resumenFinal(); return; }
    requestAnimationFrame(bucle);
}
function reanudar() {
    if (!S.activo?.factible) return;
    if (S.t >= S.activo.muestras.t[S.activo.muestras.t.length - 1]) S.t = 0;
    S.reproduciendo = true; ultimoFrame = 0; rendimiento.desde = 0;
    $('#mw-play').innerHTML = ICO.pausa; $('#mw-play').setAttribute('aria-label', 'Pausar');
    requestAnimationFrame(bucle);
}
function pausar() {
    S.reproduciendo = false;
    const b = $('#mw-play'); if (b) { b.innerHTML = ICO.play; b.setAttribute('aria-label', 'Reproducir'); }
}

/**
 * «Mira alrededor» en 3D: de pie en una parada sin panorámica de Mastcam-Z, se mira en 360° la reconstrucción del
 * terreno (DTM HiRISE de 1 m e imagen de 0,6 m). No es una foto y la interfaz lo dice.
 */
async function abrirMirador3D(id) {
    const p = id === 'base' ? { ...S.habitat, nombre: S.puntos.habitat.nombre } : S.paradas.find(x => x.id === id);
    if (!p) return;
    if (!M) { aviso({ titulo: 'La vista 3D aún se está preparando', texto: 'Vuelve a intentarlo en unos segundos.' }); return; }
    document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove());
    const seguia = S.navegando && S.reproduciendo;
    if (seguia) pausar();
    let el = $('#mw-mirador');
    if (!el) {
        document.body.insertAdjacentHTML('beforeend', `<div class="mw-mirador" id="mw-mirador" role="dialog" aria-label="Vista 360° del terreno en 3D">
          <div class="cab"><span class="punto"></span><div><b id="mw-mirador-tit"></b><small>Vista 360° · reconstrucción 3D con HiRISE (relieve de 1 m, imagen de 0,6 m) · no es una foto</small></div></div>
          <button type="button" class="cerrar" id="mw-mirador-cerrar" aria-label="Cerrar la vista 360°" title="Cerrar (Esc)">${ICO.cerrar}</button>
          <p class="pista">Arrastra para mirar alrededor · rueda para acercar · doble clic para centrar</p></div>`);
        el = $('#mw-mirador');
        $('#mw-mirador-cerrar').addEventListener('click', cerrarMirador3D);
    }
    $('#mw-mirador-tit').textContent = p.nombre;
    // Se mira hacia la base (o, desde la base, hacia la primera parada) y con el Sol de la hora de llegada.
    const otro = id === 'base' ? (S.plan?.paradas?.[0] && S.paradas.find(x => x.id === S.plan.paradas[0].id)) || S.paradas[0] : S.habitat;
    const llegada = S.plan?.paradas?.find(x => x.id === id);
    const utc = utcSalida() + (llegada?.llegadaS || 0) * 1000;
    await M.calentar(p.lon, p.lat).catch(() => {});
    S.mirador3d = { id, alCerrar: () => { if (seguia) reanudar(); } };
    mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
    M.actualizar({ lon: p.lon, lat: p.lat, rumbo: rumboEntre(p.lon, p.lat, otro.lon, otro.lat), sol: sunPosition(utc, S.habitat.lon, S.habitat.lat),
        viento: { ms: S.cond?.vientoMs, dir: S.cond?.vientoDir, tau: S.cond?.tau }, siguiente: null });
    document.body.classList.add('mirador3d');
    sincronizarMundo();
}
function cerrarMirador3D() {
    const m = S.mirador3d;
    if (!m) return;
    S.mirador3d = null;
    document.body.classList.remove('mirador3d');
    mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
    sincronizarMundo({ entrada: false });
    if (S.navegando) actualizarTiempo(S.t);
    m.alCerrar?.();
}

/** Tarjeta de llegada: lo que se ha recorrido, lo que queda en el traje y las muestras tomadas. */
function resumenFinal() {
    const r = S.activo, s = r.muestras, n = s.t.length - 1;
    const muestras = [...(S.plan?.paradas || []).filter(p => p.salidaS <= S.t + S.tOffset), ...(r.esEmergencia ? (r.paradas || []) : [])]
        .map(p => p.nombre).filter((v, i, a) => a.indexOf(v) === i);
    const total = (r.esEmergencia ? (S.plan?.muestras.dist[indice(S.plan.muestras.t, S.tOffset)] || 0) : 0) + s.dist[n];
    aviso({ titulo: r.esEmergencia ? 'De vuelta en la base, a salvo' : 'EVA completada',
        texto: `${fmtKm(total)} en ${fmtDur(S.t + S.tOffset)}. Vuelves con ${pct(1 - s.o2[n])} de O₂, ${pct(1 - s.bat[n])} de batería y ${s.dosis[n].toFixed(2).replace('.', ',')} mSv de dosis.` +
            (muestras.length ? ` Paradas completadas: ${muestras.join(', ')}.` : ''), fijo: true });
    hablar(r.esEmergencia ? 'You have arrived at the base. You are safe.' : 'You have arrived at the base. EVA complete.', true);
    document.querySelectorAll('.g-m-parada.siguiente').forEach(e => e.classList.remove('siguiente'));
    // Final de la demo: la vista 360° real del mirador principal se activa solo al terminar la ruta (#15).
    const el = $('#mw-aviso');
    if (el && !el.querySelector('[data-pano]')) {
        el.insertAdjacentHTML('beforeend', `<br><button type="button" class="g-pano-btn" data-pano="${MIRADOR_PRINCIPAL}">Ver Wildcat Ridge en 360° (fotos reales de NASA)</button>`);
    }
    setTimeout(() => { if (S.navegando && !S.reproduciendo) { M?.pausa(true); abrirPrincipal({ parada: MIRADOR_PRINCIPAL, alCerrar: () => { M?.pausa(false); if (S.navegando) salirNavegacion(); } }); } }, 2500);
}

/**
 * Capas del modo Explorar que no aportan al navegar y cuestan fotogramas con la cámara en movimiento
 * (medido: 15,6 → 30 fps): la nomenclatura global recoloca miles de etiquetas en cada movimiento y el color MOLA
 * se dibuja bajo la ortoimagen sin verse. Se ocultan solo durante la navegación y se restauran al salir.
 */
// También el color base global (queda bajo la ortoimagen, sin verse) y el sombreado «ambiente» de cuatro direcciones
// (cuatro pasadas por tesela; al navegar basta el del Sol real).
const OCULTAS_AL_NAVEGAR = ['nomenclature-major', 'nomenclature-craters-large', 'nomenclature-minor', 'color', 'ruta-relieve-ambiente'];
function capasNavegacion(navegando) {
    for (const id of OCULTAS_AL_NAVEGAR) {
        if (!S.map.getLayer(id)) continue;
        if (navegando) {
            (S.visAntes ||= {})[id] = S.map.getLayoutProperty(id, 'visibility') || 'visible';
            S.map.setLayoutProperty(id, 'visibility', 'none');
        } else if (S.visAntes?.[id]) S.map.setLayoutProperty(id, 'visibility', S.visAntes[id]);
    }
}

function iniciarNavegacion() {
    if (!S.activo?.factible) return;
    precargarPanorama();       // por si aún no se había precargado
    S.altoHoja = 0; addEventListener('resize', () => { S.altoHoja = 0; }, { once: true });
    S.navegando = true; S.seguir = true; S.hechas = []; rumboCamara = null; ultimaCamara = 0; S.maniobraDibujada = null; S.anunciados = new Set(); S.icoBanner = null; S.ultimoDom = 0; S.siguienteParada = undefined;
    S.map.setTerrain(terrenoDe()); anclar();
    capasNavegacion(true);
    iluminar(utcSalida() + (S.t + S.tOffset) * 1000, true);
    document.body.classList.add('navegando');
    $('#mw-capas-pop').classList.remove('abierto');
    dibujarRuta();
    mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
    if (!mundoActivo()) S.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    actualizarTiempo(S.t);
    sincronizarMundo();
    reanudar();
}
function salirNavegacion() {
    pausar();
    if (S.astronauta) { S.navegando = false; ponerAstronauta(false); }
    window.speechSynthesis?.cancel();
    S.navegando = false;
    sincronizarMundo();
    // Ruta terminada: se vuelve a la elección de ruta como al principio (caminante en la salida, sin el aviso de llegada).
    const dur = S.activo?.factible ? S.activo.muestras.t[S.activo.muestras.t.length - 1] : 0;
    if (dur && S.t >= dur - 1) { S.t = 0; aviso(null); }
    document.body.classList.remove('navegando');
    S.map.setTerrain(terrenoDe()); anclar();
    capasNavegacion(false);
    iluminar(utcSalida() + (S.t + S.tOffset) * 1000, true);
    S.map.getSource('mw-maniobra').setData(VACIO);
    S.map.getSource('mw-tramo-aviso').setData(VACIO); S.tramoResaltado = '';
    if (S.activo?.esEmergencia) activar(S.plan); else { dibujarRuta(); actualizarTiempo(S.t); }
    tiempo.fijarTiempo(S.t);
    S.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    encuadrar(S.activo, 1200);
}

function vistaPrevia() {
    if (!S.plan?.factible) return;
    pausar();
    if (M && !reducirMovimiento) { vistaPreviaMundo(); return; }
    const s = S.plan.muestras, total = s.dist[s.dist.length - 1], dur = Math.min(36000, 8000 + total * 2.5);
    const t0 = performance.now();
    let rumboC = null;
    if (reducirMovimiento) { encuadrar(S.plan); return; }
    S.volando = true; rendimiento.desde = 0;
    S.map.setTerrain(terrenoDe()); anclar();
    const terminar = () => { S.volando = false; S.map.setTerrain(terrenoDe()); anclar(); encuadrar(S.plan); };
    const paso = ts => {
        if (!S.volando) { S.map.setTerrain(terrenoDe()); return; }
        vigilarRendimiento(ts);
        const f = Math.min(1, (ts - t0) / dur), d = f * f * (3 - 2 * f) * total;
        const p = puntoA(s, d), q = puntoA(s, Math.min(total, d + 250));
        const rumbo = rumboEntre(p[0], p[1], q[0], q[1]);
        rumboC = rumboC == null ? rumbo : rumboC + ((((rumbo - rumboC) % 360) + 540) % 360 - 180) * 0.035;
        S.map.jumpTo({ center: p, bearing: rumboC, pitch: 70, zoom: 14.1 });
        anclar();
        if (f < 1) requestAnimationFrame(paso); else terminar();
    };
    requestAnimationFrame(paso);
}

/** Vista previa: sobrevuelo de la ruta en el mundo 3D, con la cámara de seguimiento algo más alta. Cualquier tecla o clic la corta. */
function vistaPreviaMundo() {
    const s = S.plan.muestras, total = s.dist[s.dist.length - 1], dur = Math.min(30000, 9000 + total * 2.2), t0 = performance.now();
    let rumboC = null, ant = t0;
    S.previa = true;
    mirada.yaw = 0; mirada.pitch = -6; mirada.zoomOffset = -1.6;
    document.body.classList.add('previa');
    const cortar = () => { S.previa = false; };
    const fin = () => {
        removeEventListener('keydown', cortar, true); removeEventListener('pointerdown', cortar, true);
        S.previa = false; document.body.classList.remove('previa');
        mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
        sincronizarMundo();
    };
    setTimeout(() => { addEventListener('keydown', cortar, true); addEventListener('pointerdown', cortar, true); }, 300);
    const paso = ts => {
        const f = Math.min(1, (ts - t0) / dur);
        if (!S.previa || f >= 1) { fin(); return; }
        const d = f * f * (3 - 2 * f) * total, p = puntoA(s, d), q = puntoA(s, Math.min(total, d + 180)), dt = Math.min(0.1, (ts - ant) / 1000); ant = ts;
        const rumbo = rumboEntre(p[0], p[1], q[0], q[1]);
        rumboC = rumboC == null ? rumbo : (rumboC + ((((rumbo - rumboC) % 360) + 540) % 360 - 180) * (1 - Math.exp(-1.6 * dt)) + 360) % 360;
        M.actualizar({ lon: p[0], lat: p[1], dist: d, rumbo: rumboC, progreso: -1, siguiente: null,
            sol: sunPosition(utcSalida(), S.habitat.lon, S.habitat.lat), viento: { ms: S.cond?.vientoMs, dir: S.cond?.vientoDir, tau: S.cond?.tau } });
        requestAnimationFrame(paso);
    };
    const p0 = puntoA(s, 0), q0 = puntoA(s, Math.min(total, 180));
    M.actualizar({ lon: p0[0], lat: p0[1], dist: 0, rumbo: rumboEntre(p0[0], p0[1], q0[0], q0[1]), progreso: -1, siguiente: null });
    sincronizarMundo();
    requestAnimationFrame(paso);
}

// ───────────────────────── imprevistos ─────────────────────────

function aviso(a) {
    const el = $('#mw-aviso');
    if (!a) { el.classList.remove('visible'); return; }
    el.className = `g-aviso${a.critico ? ' critico' : ''}`;
    el.innerHTML = `<strong>${a.titulo}</strong>${a.texto}${a.deshacer ? '<br><button type="button" id="mw-deshacer">Volver al plan original</button>' : ''}`;
    el.classList.add('visible');
    clearTimeout(S.avisoT);
    if (!a.fijo) S.avisoT = setTimeout(() => el.classList.remove('visible'), a.critico ? 12000 : 7000);
    $('#mw-deshacer')?.addEventListener('click', () => { aviso(null); activar(S.plan); if (S.navegando) dibujarRuta(); });
}

function usoActual() {
    const m = muestraEn(S.t), tr = S.traje;
    return { o2: m.o2 * tr.o2Kg, bat: m.bat * tr.bateriaWh, agua: m.agua * tr.aguaKg, dosis: m.dosis, t: S.t + S.tOffset, E: (m.ener || 0) * 1000 + (S.eOffset || 0) };
}

async function contingencia(tipo) {
    if (!S.activo?.factible) return;
    pausar();
    const m = muestraEn(S.t);
    const pos = { lon: m.lon, lat: m.lat };
    const utc = utcSalida() + (S.t + S.tOffset) * 1000;
    let uso = usoActual();
    const tOffset = S.t + S.tOffset;
    const eOffset = uso.E;
    const cond = { ...S.cond };
    let titulo;
    if (tipo === 'polvo') { cond.tau = 2.6; cond.vientoMs = 24; titulo = 'Tormenta de polvo detectada'; }
    if (tipo === 'radiacion') { cond.factorDosis = 40; titulo = 'Alerta de partículas solares'; }
    if (tipo === 'volver') titulo = 'Regreso a la base';
    const w = workerDe(S.perfil);
    if (tipo === 'consumibles') {
        const tr = S.traje;
        uso = { ...uso, o2: Math.max(uso.o2, 0.6 * tr.o2Kg), bat: Math.max(uso.bat, 0.6 * tr.bateriaWh), agua: Math.max(uso.agua, 0.6 * tr.aguaKg) };
        const visitadas = new Set((S.activo.paradas || []).filter(p => p.salidaS <= S.t).map(p => p.id));
        const resto = S.paradas.filter(p => p.activa && !visitadas.has(p.id));
        const r = await w.llamar({ ...mensajePlan(S.perfil), inicio: pos, inicioUTC: utc, usoInicial: uso,
            paradas: resto.map(({ id, nombre, lon, lat, valor, trabajoMin, obligatoria }) => ({ id, nombre, lon, lat, valor, trabajoMin, obligatoria })) });
        if (r.factible) {
            const detalle = r.paradas.length ? `Se mantiene ${r.paradas.map(p => p.nombre).join(', ')} y se vuelve con reserva.` : 'Ya no cabe ninguna parada: ruta directa a la base.';
            Object.assign(r, { esEmergencia: true, tOffset });
            S.tOffset = tOffset; S.eOffset = eOffset; activar(r); if (S.navegando) dibujarRuta();
            aviso({ titulo: 'Consumibles al 40 %: ruta recalculada', texto: `${detalle} ${fmtKm(r.distancia)}, ${fmtDur(r.duracion)}.`, deshacer: true, critico: true });
            hablar(`Consumables at 40 percent. Route recalculated: ${r.paradas.length ? `${r.paradas.length} stop${r.paradas.length > 1 ? 's' : ''} kept` : 'straight back to the base'}, ${Math.round(r.duracion / 60)} minutes.`, true);
            if (S.navegando) reanudar();
            return;
        }
        titulo = 'Consumibles al 40 %';
    }
    const r = await w.llamar({ tipo: 'abortar', habitat: S.habitat, fin: punto(S.fin), posicion: pos, perfil: S.perfil, traje: S.traje, cond, utc, usoInicial: uso });
    if (!r.factible) { aviso({ titulo, texto: r.motivo, critico: true }); return; }
    let detalle = `Ruta más segura de vuelta: ${fmtKm(r.distancia)}, ${fmtDur(r.duracion)}, llegada ${formatHora(r.muestras.ltst[r.muestras.ltst.length - 1])}.`;
    if (tipo === 'radiacion') detalle += ` Dosis añadida en el regreso: ${(r.muestras.dosis[r.muestras.dosis.length - 1] - uso.dosis).toFixed(2).replace('.', ',')} mSv.`;
    Object.assign(r, { esEmergencia: true, tOffset });
    S.tOffset = tOffset; S.eOffset = eOffset;
    activar(r);
    if (!S.navegando) iniciarNavegacion(); else { dibujarRuta(); reanudar(); }
    aviso({ titulo, texto: detalle, deshacer: true, critico: tipo !== 'volver' });
    const motivoEn = { polvo: 'Dust storm detected.', radiacion: 'Solar particle alert.', volver: 'Returning to the base.', consumibles: 'Consumables at 40 percent.' }[tipo];
    hablar(`${motivoEn} New route to the base: ${distEn(r.distancia)}, ${Math.round(r.duracion / 60)} minutes.`, tipo !== 'volver');
}

// ───────────────────────── validación ─────────────────────────

async function validar() {
    const b = $('#mw-validar');
    b.disabled = true; b.textContent = 'Calculando…';
    try {
        const r = await W.llamar({ tipo: 'validar', tramos: construirTramos(S.traza, S.meta) }, p => { b.textContent = p.txt; });
        S.validacion = r;
        const x = r.resumen;
        $('#mw-validacion').innerHTML = `
          <p style="margin:12px 0 4px;font-size:14px"><b style="font-size:22px;font-weight:500">${pct(x.transitableReal)}</b> del terreno que Perseverance condujo de verdad es transitable en nuestro modelo (${x.n} conducciones de un sol).</p>
          <p style="margin:4px 0;font-size:14px">Nuestra ruta reproduce el ${pct(x.dentro50m)} de las conducciones a menos de 50 m (separación media ${Math.round(x.desvMedia)} m).
          A esta escala el rover conduce casi en línea recta (${Math.round(x.desvRectaMedia)} m de la recta, menos de una celda de 20 m), así que la recta es difícil de batir; hace falta HiRISE de 1 m para afinar.</p>
          <table class="g-tabla"><thead><tr><th>Sol</th><th>Tramo</th><th>Separación</th><th>Recta</th></tr></thead><tbody>
          ${r.tramos.map((t, i) => `<tr data-tramo="${i}"><td>${t.soles}</td><td>${fmtKm(t.longReal)}</td><td>${Math.round(t.desvMedia)} m</td><td>${Math.round(t.desvRectaMedia)} m</td></tr>`).join('')}
          </tbody></table>
          <p class="g-nota">Blanco punteado: Perseverance. Azul claro: nuestra ruta con coste de rover (pesos calibrados con la mitad de las conducciones).</p>`;
        S.map.getSource('mw-validacion').setData({ type: 'FeatureCollection', features: r.tramos.map(t => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.pred } })) });
        S.capas.traza = true; $('[data-capa="traza"]').setAttribute('aria-pressed', 'true'); ponerVisibilidadRuta(true);
    } catch (e) {
        $('#mw-validacion').innerHTML = `<p class="g-nota">La comparación falló: ${e.message.split('\n')[0]}</p>`;
    } finally { b.disabled = false; b.textContent = 'Ejecutar la comparación'; }
}

// ───────────────────────── modo y eventos ─────────────────────────

/** Encuadra la zona de Jezero con datos de alta resolución (desde la exploración). */
function irAJezero() {
    const b = S.meta.teselas.bounds;
    S.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, duration: reducirMovimiento ? 0 : 3500 });
}

// Fuera de Jezero solo hay MOLA (463 m): más allá de este zoom la imagen se ve pixelada y no aporta nada.
const ZOOM_MAX_GLOBAL = 7.5, MARGEN_DETALLE = 0.25;
function enZonaDetalle(c) {
    const b = S.meta.teselas.bounds;
    return c.lng >= b[0] - MARGEN_DETALLE && c.lng <= b[2] + MARGEN_DETALLE && c.lat >= b[1] - MARGEN_DETALLE && c.lat <= b[3] + MARGEN_DETALLE;
}
/** Al explorar, si se hace zoom fuera de la zona de detalle, el mapa vuelve suavemente al máximo útil. */
function limitarZoomGlobal() {
    const map = S.map;
    if (document.body.classList.contains('modo-ruta') || map.getZoom() <= ZOOM_MAX_GLOBAL + 0.01 || enZonaDetalle(map.getCenter())) return;
    map.easeTo({ zoom: ZOOM_MAX_GLOBAL, duration: reducirMovimiento ? 0 : 600 });
}

function cambiarModo(modo) {
    const ruta = modo === 'ruta';
    document.querySelectorAll('.mw-modo button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
    document.body.classList.toggle('modo-ruta', ruta);
    const map = S.map;
    if (ruta) {
        map.setMaxPitch(80);
        for (const id of CAPAS_RELIEVE) if (map.getLayer(id)) map.setPaintProperty(id, 'hillshade-exaggeration', EXAGERACION_RELIEVE);
        map.dragRotate.enable(); map.touchZoomRotate.enableRotation();
        ponerVisibilidadRuta(true);
        iluminar(utcSalida(), true);
        // Se vuela en planta y sin relieve; al llegar (`aterrizar`) se activa el relieve 3D, ya anclado al suelo, y la
        // vista se inclina. Así no se ve el horizonte vacío ni el cielo en negro mientras cargan las teselas.
        map.setTerrain(null); anclar(map);
        if (S.activo?.factible) { dibujarRuta(); encuadrar(S.activo); }
        else { S.llegando = true; map.flyTo({ center: [S.habitat.lon - 0.01, S.habitat.lat - 0.004], zoom: 12.2, pitch: 0, bearing: 0, duration: reducirMovimiento ? 0 : 2800, essential: true }); }
        if (!S.llegando) map.once('moveend', aterrizar);
        if (!S.activo) planificar();
    } else {
        if (S.navegando) salirNavegacion();
        S.volando = false; S.llegando = false; S.relievePausado = false;
        limitarAJezero(false);
        map.setTerrain(null); anclar(map);
        try { map.setSky(undefined); } catch { /* sin cielo en exploración */ }
        ponerVisibilidadRuta(false);
        limpiarMarcadores();
        aviso(null); // un aviso de la EVA (p. ej. «Tormenta de polvo») no debe quedarse sobre el mapa al explorar
        estiloExplorar();
        // Mismo mapa: se queda donde está (solo se pone plano y con el norte arriba) y se puede seguir
        // alejando hasta ver el planeta entero o acercando hasta el detalle de Jezero.
        map.easeTo({ pitch: 0, bearing: 0, duration: reducirMovimiento ? 0 : 1200 });
        map.once('moveend', () => { if (document.body.classList.contains('modo-ruta')) return; map.setMaxPitch(0); map.dragRotate.disable(); });
    }
}

/**
 * Llegada a Jezero: con el mapa ya quieto y las teselas de relieve de la vista cargadas (las pide el sombreado), se
 * activa el relieve 3D anclado al suelo y la vista se inclina con suavidad.
 */
function aterrizar() {
    const map = S.map;
    if (!document.body.classList.contains('modo-ruta') || S.navegando) return;
    // Ya en Jezero no se puede alejar hasta la zona sin detalle (fuera solo hay el mosaico global, borroso a esta escala).
    limitarAJezero(true);
    S.relievePausado = S.tresD;                                   // el relieve se activa cuando la cámara se detenga
    if (S.tresD && map.getPitch() < 5 && !reducirMovimiento) map.easeTo({ pitch: 50, bearing: -15, duration: 1300, easing: t => t * t * (3 - 2 * t), essential: true });
    else S.volverRelieve?.();
    calentarMundo();
}
/** En modo ruta, el mapa se queda en la zona de Jezero con datos de detalle; al explorar vuelve a ser todo Marte. */
function limitarAJezero(v) {
    const map = S.map, b = S.meta.teselas.bounds;
    try {
        if (v) { map.setMinZoom(10.2); map.setMaxBounds([[b[0] - 0.02, b[1] - 0.02], [b[2] + 0.02, b[3] + 0.02]]); }
        else { map.setMaxBounds(null); map.setMinZoom(1); }
    } catch { /* límites no aplicables a la vista actual */ }
}

/** Modo "Elige un punto en el mapa" para el inicio, el fin o una parada nueva. */
function elegirEnMapa(que) {
    S.eligiendo = que; S.moviendoBase = false; S.dibujando = null;
    S.map.getCanvas().style.cursor = 'crosshair';
    const txt = { inicio: 'Toca el mapa donde empieza la EVA.', fin: 'Toca el mapa donde termina la EVA (un refugio: la base u otro).', parada: 'Toca el mapa donde quieras hacer una parada.' }[que];
    aviso({ titulo: 'Elige un punto en el mapa', texto: txt, fijo: true });
}
function colocarPunto(que, lon, lat) {
    const [w, s, e, n] = S.meta.teselas.bounds;
    if (lon < w || lon > e || lat < s || lat > n) { aviso({ titulo: 'Fuera del terreno de alta resolución', texto: 'Elige un punto dentro del recuadro del DTM de Jezero.' }); return; }
    S.eligiendo = null; S.map.getCanvas().style.cursor = ''; aviso(null);
    const coord = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`;
    if (que === 'parada') {
        const k = ++S.nPropias;
        S.paradas.push({ id: `mapa-${k}`, nombre: `Punto ${k}`, lon, lat, valor: 5, trabajoMin: 20, obligatoria: true, activa: true, propia: true,
            que: `Punto elegido en el mapa (${coord}).`, porque: 'Objetivo elegido por la tripulación.', muestra: 'Según el objetivo de la tripulación.', rover: 'Sin datos del rover.' });
        $('#mw-otras').open = false;
    } else {
        S[que] = { lon, lat, nombre: que === 'inicio' ? `Salida en ${coord}` : `Refugio en ${coord}` };
        if (que === 'fin') S.idaPrecalculada = false;
    }
    planificar();
}

function eventos() {
    const map = S.map;
    document.querySelectorAll('.mw-modo button').forEach(b => b.addEventListener('click', () => cambiarModo(b.dataset.modo)));
    $('#mw-ir-jezero').addEventListener('click', irAJezero);
    map.on('moveend', limitarZoomGlobal);
    map.on('moveend', () => { if (S.llegando && map.getZoom() > 9.5 && document.body.classList.contains('modo-ruta')) { S.llegando = false; aterrizar(); } });
    // El interruptor «Sombreado (relieve)» del panel de capas también gobierna el relieve de detalle al explorar.
    document.getElementById('toggle-hillshade')?.addEventListener('change', () => {
        if (!document.body.classList.contains('modo-ruta')) ponerVisibilidadRuta(false);
    });
    $('#mw-fecha').value = S.fecha;
    const actualizarCondicionesYPlan = async () => {
        const actualizadas = await cargarCondiciones(S.habitat.lon, S.habitat.lat, utcSalida());
        if (actualizadas) { pintarSalida(); pintarFuentes(S.fuentes); await planificar(); }
    };
    $('#mw-fecha').addEventListener('change', e => {
        S.fecha = e.target.value;
        pintarSalida();
        actualizarCondicionesYPlan();
    });
    $('#mw-hora-rango').addEventListener('input', e => { S.horaSalida = parseFloat(e.target.value); pintarSalida(); iluminar(utcSalida()); });
    $('#mw-hora-rango').addEventListener('change', () => {
        iluminar(utcSalida(), true);
        actualizarCondicionesYPlan();
    });
    $('#mw-opciones').addEventListener('click', e => { const b = e.target.closest('[data-perfil]'); if (b) elegirPerfil(b.dataset.perfil); });
    $('#mw-pasos').addEventListener('click', e => {
        const q = e.target.closest('[data-quitar]');
        if (q) {
            const p = S.paradas.find(x => x.id === q.dataset.quitar);
            if (p.propia) S.paradas = S.paradas.filter(x => x !== p); else { p.activa = false; p.obligatoria = false; }
            planificar(); return;
        }
        const rs = e.target.closest('[data-reset]');
        if (rs) { S[rs.dataset.reset] = null; if (rs.dataset.reset === 'fin') S.idaPrecalculada = false; planificar(); return; }
        const el = e.target.closest('[data-elegir]');
        if (el) { elegirEnMapa(el.dataset.elegir); return; }
        const ir = e.target.closest('[data-ir]');
        if (ir) {
            const k = ir.dataset.ir, p = k === 'base' ? S.habitat : k === 'inicio' ? S.inicio : k === 'fin' ? S.fin : S.paradas.find(x => x.id === k);
            map.flyTo({ center: [p.lon, p.lat], zoom: 14.6, pitch: S.tresD ? 60 : 0, duration: reducirMovimiento ? 0 : 1600 });
        }
    });
    $('#mw-otras-lista').addEventListener('click', e => {
        const el = e.target.closest('[data-elegir]');
        if (el) { elegirEnMapa(el.dataset.elegir); return; }
        const b = e.target.closest('[data-fijar]'); if (!b) return;
        const p = S.paradas.find(x => x.id === b.dataset.fijar);
        if (p.activa) p.obligatoria = true; else p.activa = true;
        planificar();
    });
    $('#mw-iniciar').addEventListener('click', () => S.activo?.factible ? iniciarNavegacion() : planificar());
    $('#mw-vista').addEventListener('click', vistaPrevia);
    $('#mw-recalcular').addEventListener('click', planificar);
    // Tu cuerpo: edad y test solo cambian la lectura; el peso cambia el coste de la ruta y se replanifica.
    for (const id of ['#mw-edad', '#mw-etapa']) $(id).addEventListener('input', () => {
        const edad = parseFloat($('#mw-edad').value), etapa = parseFloat($('#mw-etapa').value);
        guardarPersona({ edad: Number.isFinite(edad) ? edad : 30, etapa: Number.isFinite(etapa) && etapa > 0 ? etapa : null });
        pintarCuerpo();
    });
    $('#mw-masa').addEventListener('change', () => {
        const m = parseFloat($('#mw-masa').value);
        if (!Number.isFinite(m) || m < 20 || m > 150 || m === S.traje.masaCorporal) return;
        S.traje = { ...S.traje, masaCorporal: m };
        planificar();
    });
    $('#mw-avisos').addEventListener('click', e => {
        const li = e.target.closest('[data-alerta]'); if (!li || !S.activo?.factible) return;
        const a = S.activo.alertas[+li.dataset.alerta];
        actualizarTiempo(S.activo.muestras.t[a.ini]);
        map.flyTo({ center: [S.activo.muestras.lon[a.ini], S.activo.muestras.lat[a.ini]], zoom: 14.6, pitch: S.tresD ? 60 : 0, duration: reducirMovimiento ? 0 : 1400 });
    });
    // Controles redondos
    $('#mw-btn-capas').addEventListener('click', () => $('#mw-capas-pop').classList.toggle('abierto'));
    $('#mw-btn-3d').addEventListener('click', () => {
        if (S.astronauta && S.navegando) return;  // en modo astronauta la vista es siempre 3D
        if (M && S.navegando) {
            // Navegando: 3D = mundo 3D con cámara de seguimiento; 2D = mapa plano con el norte de marcha arriba.
            S.tresD = !mundoActivo();
            sincronizarMundo({ entrada: false });
            S.altoHoja = 0; S.seguir = true; actualizarTiempo(S.t);
            return;
        }
        // Se decide por lo que se ve: si no hay relieve 3D en pantalla, el botón pide 3D (aunque la preferencia ya
        // fuera 3D y el modo fluido lo hubiera quitado); si lo hay, pide 2D.
        const quiere3D = M ? !S.tresD : !map.getTerrain();
        S.tresD = quiere3D; S.relievePausado = quiere3D;
        if (quiere3D && S.modoFluido && (S.navegando || S.volando)) { S.forzar3D = true; guardarFluido(false); }
        map.setTerrain(terrenoDe()); anclar(map);
        pintarBoton3D();
        if (!S.astronauta || !S.navegando) map.easeTo({ pitch: quiere3D ? (S.navegando ? PITCH_NAV : 50) : 0, duration: reducirMovimiento ? 0 : 800 });
    });
    map.on('terrain', pintarBoton3D);
    $('#mw-btn-norte').addEventListener('click', () => map.easeTo({ bearing: 0, duration: reducirMovimiento ? 0 : 600 }));
    $('#mw-btn-centrar').addEventListener('click', () => { if (S.navegando) { S.seguir = true; rumboCamara = null; actualizarTiempo(S.t); } else if (S.activo?.factible) encuadrar(S.activo, 900); });
    $('#mw-capas-pop').addEventListener('click', e => {
        const b = e.target.closest('[data-capa]'); if (!b) return;
        const c = b.dataset.capa, v = !S.capas[c];
        S.capas[c] = v; b.setAttribute('aria-pressed', String(v));
        if (c === 'traza') map.setLayoutProperty('mw-traza', 'visibility', v ? 'visible' : 'none');
        else if (v) { if (c === 'sombra') iluminar(utcSalida() + (S.t + S.tOffset) * 1000, true); else actualizarCapa(c); }
        else map.setLayoutProperty(`mw-${c}`, 'visibility', 'none');
        if (c === 'alcance' && !v) $('#mw-alcance-ley').hidden = true;
    });
    // Navegación
    $('#mw-salir').addEventListener('click', salirNavegacion);
    $('#mw-astro').addEventListener('click', () => ponerAstronauta(!S.astronauta));
    const pintarAltura = v => { $('#mw-astro-alt').value = v; $('#mw-astro-alt-txt').textContent = `${String(v).replace('.', ',')} m`; };
    pintarAltura(leerAltura());
    $('#mw-astro-alt').addEventListener('input', e => {
        pintarAltura(ponerAltura(e.target.value));
        if (S.navegando && S.astronauta && !S.reproduciendo) actualizarTiempo(S.t);
    });
    $('#mw-voz').addEventListener('click', () => {
        S.voz = !S.voz;
        if (!S.voz) window.speechSynthesis?.cancel();
        $('#mw-voz').innerHTML = S.voz ? ICO.voz : ICO.mudo;
        $('#mw-voz').setAttribute('aria-pressed', String(S.voz));
        $('#mw-voz').setAttribute('aria-label', S.voz ? 'Silenciar las indicaciones de voz' : 'Activar las indicaciones de voz');
        if (S.voz) hablar('Voice guidance on.', true);
    });
    $('#mw-play').addEventListener('click', () => S.reproduciendo ? pausar() : reanudar());
    document.querySelectorAll('[data-vel]').forEach(b => b.addEventListener('click', () => {
        S.velocidad = +b.dataset.vel;
        document.querySelectorAll('[data-vel]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    }));
    const prog = $('#mw-progreso');
    const irA = e => { const r = prog.getBoundingClientRect(); actualizarTiempo((e.clientX - r.left) / r.width * S.activo.muestras.t[S.activo.muestras.t.length - 1]); };
    prog.addEventListener('pointerdown', e => { prog.setPointerCapture(e.pointerId); irA(e); prog.onpointermove = irA; });
    prog.addEventListener('pointerup', () => { prog.onpointermove = null; });
    prog.addEventListener('keydown', e => {
        const d = S.activo.muestras.t[S.activo.muestras.t.length - 1] / 50;
        if (e.key === 'ArrowRight') actualizarTiempo(S.t + d); if (e.key === 'ArrowLeft') actualizarTiempo(S.t - d);
    });
    document.querySelector('.g-hoja .imprevistos').addEventListener('click', e => { const b = e.target.closest('[data-cont]'); if (b) contingencia(b.dataset.cont); });
    // El usuario toma el control de la cámara al arrastrar; "centrar" la devuelve al caminante.
    map.on('dragstart', () => { if (S.navegando) S.seguir = false; S.volando = false; });
    map.on('moveend', () => { if (document.body.classList.contains('modo-ruta') && !S.navegando) anclar(map); });
    map.on('sourcedata', e => { if (e.sourceId === 'marsdem' && e.isSourceLoaded && !S.navegando && !S.volando) anclar(map); });
    // Editar terreno
    $('#mw-validar').addEventListener('click', validar);
    $('#mw-validacion').addEventListener('click', e => {
        const tr = e.target.closest('[data-tramo]'); if (!tr) return;
        const t = S.validacion.tramos[+tr.dataset.tramo];
        const lons = t.real.map(p => p[0]), lats = t.real.map(p => p[1]);
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { left: 440, right: 120, top: 120, bottom: 120 }, pitch: 45, maxZoom: 15, duration: reducirMovimiento ? 0 : 1400 });
    });
    $('#mw-mover-base').addEventListener('click', () => {
        S.moviendoBase = true; S.dibujando = null; map.getCanvas().style.cursor = 'crosshair';
        aviso({ titulo: 'Mover la base', texto: 'Haz clic en el mapa, dentro de Jezero, para colocar el hábitat.', fijo: true });
    });
    $('#mw-zona').addEventListener('click', () => {
        S.dibujando = []; S.moviendoBase = false; map.getCanvas().style.cursor = 'crosshair'; map.doubleClickZoom.disable();
        aviso({ titulo: 'Zona prohibida', texto: 'Haz clic para marcar los vértices y doble clic para cerrarla.', fijo: true });
    });
    map.on('click', e => {
        if (!document.body.classList.contains('modo-ruta')) return;
        $('#mw-capas-pop').classList.remove('abierto');
        const { lng, lat } = e.lngLat;
        if (S.eligiendo) { colocarPunto(S.eligiendo, lng, lat); return; }
        if (S.moviendoBase) {
            const [w, s, ee, n] = S.meta.teselas.bounds;
            if (lng < w || lng > ee || lat < s || lat > n) { aviso({ titulo: 'Fuera del terreno de alta resolución', texto: 'La base debe estar dentro del recuadro del DTM de Jezero.' }); return; }
            S.moviendoBase = false; map.getCanvas().style.cursor = '';
            S.habitat = { ...S.habitat, lon: lng, lat };
            aviso(null); pintarSalida(); planificar();
            return;
        }
        if (S.dibujando) { S.dibujando.push([lng, lat]); pintarZonas(); }
    });
    map.on('dblclick', e => {
        if (!S.dibujando || S.dibujando.length < 3) return;
        e.preventDefault();
        S.zonas.push([...S.dibujando, S.dibujando[0]]);
        S.dibujando = null; map.getCanvas().style.cursor = '';
        setTimeout(() => map.doubleClickZoom.enable(), 300);
        pintarZonas(); aviso(null);
        Promise.all([W, W2, W3].map(w => w.llamar({ tipo: 'zonas', poligonos: S.zonas }))).then(planificar);
    });
    addEventListener('keydown', e => {
        if (S.mirador3d) { if (e.key === 'Escape') cerrarMirador3D(); return; }
        if (!S.navegando || e.target.matches('input, textarea')) return;
        if (e.code === 'Space') { e.preventDefault(); S.reproduciendo ? pausar() : reanudar(); }
        if (e.key === 'Escape') salirNavegacion();
    });
}

function pintarZonas() {
    const feats = S.zonas.map(z => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [z] } }));
    if (S.dibujando?.length >= 2) feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...S.dibujando, S.dibujando[0]]] } });
    S.map.getSource('mw-zonas').setData({ type: 'FeatureCollection', features: feats });
}

// ───────────────────────── inicio ─────────────────────────

export async function initRutaModule(map) {
    T0.mapaListo = performance.now();
    S.tiempos = T0;
    S.map = map;
    S.modoFluido = leerFluido();
    aligerarMapa(map);
    relieveEnReposo(map);
    construirDOM();
    construirVisor();
    const [ini] = await ARRANQUE.ini;
    S.cacheRepo = await ARRANQUE.cache;
    S.meta = ini.meta; S.motor = ini.motor;
    $('#mw-motor').textContent = ini.motor === 'wasm' ? 'WebAssembly' : 'JavaScript';
    const [puntos, traza] = await ARRANQUE.datos;
    S.puntos = puntos; S.traza = traza;
    S.habitat = { lon: puntos.habitat.lon, lat: puntos.habitat.lat };
    S.paradas = puntos.paradas.map(p => ({ ...p, activa: true }));
    await cargarCondiciones(S.habitat.lon, S.habitat.lat, utcSalida());
    registrarTerreno3D(maplibregl, S.meta);
    anadirCapasMapa();
    // Ortoimagen HiRISE de la zona de la EVA (si sus teselas están generadas); no bloquea el arranque.
    const hirise = anadirOrtoHirise(map).then(m => { if (m) S.hirise = m; return m; });
    const relieve = registrarRelieveHirise(map, terreno3d).then(m => { if (m) S.relieveHr = m; return m; });
    // Mundo 3D de la navegación: se prepara en segundo plano; si algo falla (sin three.js, sin WebGL) queda el relieve de MapLibre.
    Promise.all([hirise, relieve]).then(([orto, rel]) => crearMundo({ terreno: TERRENO, orto: orto?.url ? orto : null, relieve: rel?.url ? rel : null, origen: S.habitat, contenedor: document.body }))
        .then(async m => { await m.listo; M = m; rutaAlMundo(); if (S.navegando) { S.map.setTerrain(terrenoDe()); sincronizarMundo(); } })
        .catch(e => console.warn('[ruta] mundo 3D no disponible, se usa el relieve del mapa:', e.message));
    map.getSource('mw-traza').setData(traza);
    tiempo = new LineaTiempo($('#mw-linea'), { alMover: t => { pausar(); actualizarTiempo(t); } });
    S.fuentes = ini.fuentes;
    escribirTraje(); pintarSalida(); pintarOpciones(); pintarPasos(); pintarFuentes(S.fuentes);
    pintarOrigen(); map.on('moveend', pintarOrigen); Promise.all([hirise, relieve]).then(() => { pintarOrigen(); pintarFuentes(S.fuentes); });
    $('#mw-origen').addEventListener('click', () => {
        const d = $('#mw-fuentes-det'); d.open = true;
        d.scrollIntoView({ behavior: reducirMovimiento ? 'auto' : 'smooth', block: 'start' });
    });
    eventos();
    // Las fichas de las paradas se vuelven a pintar cuando se sabe qué paradas tienen panorámica.
    cargarPanoramas().then(() => {
        if (S.plan) dibujarRuta();
        // La vista 360° final se precarga en segundo plano: al terminar la ruta aparece al instante.
        (window.requestIdleCallback || (f => setTimeout(f, 3000)))(() => precargarPanorama());
    });
    // «Mira alrededor»: botones de la ficha y del aviso de llegada (se crean como HTML, de ahí la delegación).
    document.addEventListener('click', e => {
        const b = e.target.closest?.('[data-pano]');
        if (!b) return;
        const seguia = S.navegando && S.reproduciendo;
        const dur = S.activo?.factible ? S.activo.muestras.t[S.activo.muestras.t.length - 1] : 0;
        const terminada = S.navegando && dur && S.t >= dur - 1;   // ruta acabada: al cerrar se vuelve a la elección de ruta
        if (seguia) pausar();
        M?.pausa(true);                                          // la foto 360° lo tapa todo: el mundo 3D no se dibuja debajo
        abrirPanorama(b.dataset.pano, { rumbo: b.dataset.rumbo != null ? Number(b.dataset.rumbo) : undefined,
            alCerrar: () => { M?.pausa(false); if (terminada && S.navegando) salirNavegacion(); else if (seguia) reanudar(); } });
    });
    document.addEventListener('click', e => { const b = e.target.closest?.('[data-mirador3d]'); if (b) abrirMirador3D(b.dataset.mirador3d); });
    // Un solo mapa: desde la exploración también se puede acercar hasta el detalle de Jezero.
    map.setMaxZoom(ZOOM_MAX_RUTA);
    estiloExplorar();
    // Precalcula el campo de vuelta de la base en cada worker mientras el usuario mira el mapa.
    T0.interfaz = performance.now();
    (window.requestIdleCallback || (f => setTimeout(f, 1500)))(precargarLlegada);
    if (location.hash === '#eva') cambiarModo('ruta');
    window.marswalk = { estado: S, planificar, cambiarModo, contingencia, validar, iniciarNavegacion, salirNavegacion, vistaPrevia, exportarCache, ponerAstronauta, infoRocas, mundo: () => M, abrirPanorama, abrirMirador3D, cerrarMirador3D, objetoDelante, objetosDe, mirarPanorama, cuerpo: cuerpoActual, traje: trajeEn, cuerpoEn };
}
