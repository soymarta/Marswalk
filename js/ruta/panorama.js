/**
 * @module panorama
 * @author Hani (módulo 5: rutas y seguridad)
 * @description «Mira alrededor»: panorámicas 360° oficiales de Mastcam-Z (NASA/JPL-Caltech/ASU/MSSS) en los
 * miradores del recorrido, a pantalla completa con paneles de cristal flotantes:
 *  - panel derecho: rumbo, lo que tienes delante (con fuentes), traje y cuerpo;
 *  - panel izquierdo: asistente (Jarvis). Por defecto responde solo con datos de la app y de NASA (prototipo);
 *    si otro módulo registra `window.marswalk.jarvis = { responder }`, el panel usa ese motor.
 *  - modo voz de demo (`?demo` en la URL): palabra de activación «Hey Jarvis» con el micrófono y, como respaldo sin
 *    red ni micrófono, atajos de teclado que simulan la frase hablada (J o 1-4). Respuestas preparadas en
 *    data/ruta/jarvis_demo.json (solo datos verificados por Ciencia); las cifras del traje y del cuerpo se leen en
 *    vivo del planificador. La interfaz lo etiqueta como demo guiada.
 * Cada panorámica es un punto de vista fijo: se mira alrededor y se salta entre miradores; no se camina entre ellos.
 *
 * Datos: data/ruta/panoramas/panoramas.json (python/preparar_panoramas_oficiales.py):
 *   miradores: { id: { archivo, titulo, soles, haov, vaov, vOffset, lon, lat, nombreCorto, objetos[] } }
 *   paradas:   { idParada: idMirador }   (solo si hay un mirador a menos de 50 m)
 * Visor: Pannellum 2.5.6 (MIT), cargado al abrir la primera panorámica.
 */

import { svgCuerpo, ZONAS_CORTAS } from './fisiologia.js';
import { montarHolograma } from './holograma.js';

const BASE = 'data/ruta/panoramas/';
const GUION = 'data/ruta/jarvis_demo.json';
const PANNELLUM = 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/';
const R_MARTE = 3389500;
/** Mirador principal de la demo: la vista 360° se abre aquí al terminar la ruta (decisión del equipo, #9/#15). */
export const MIRADOR_PRINCIPAL = 'wildcat-ridge';
/** Saltos entre miradores tipo Street View: desactivados en la demo (una sola vista, al final de la ruta). */
const SALTOS_ENTRE_MIRADORES = false;

const PARAMS = new URLSearchParams(location.search);
/** Modo voz de demo: `mapa_marte.html?demo` (y `&lang=en` para que la interfaz de voz arranque en inglés). */
export const MODO_DEMO = PARAMS.has('demo');
const IDIOMA_DEMO = PARAMS.get('lang') === 'en' ? 'en' : 'es';

let meta = null;
let cargando = null;
let visor = null;
let alCerrarActual = null;
let actual = null;          // { id (mirador), p (datos), parada }
let reloj = null;

// ───────────────────────── datos ─────────────────────────

export function cargarPanoramas() {
    if (meta) return Promise.resolve(meta);
    if (!cargando) {
        cargando = fetch(`${BASE}panoramas.json`, { cache: 'no-cache' })
            .then(r => (r.ok ? r.json() : {}))
            .catch(() => ({}))
            .then(m => (meta = { miradores: {}, paradas: {}, ...m }));
    }
    return cargando;
}

let guion = null;
function cargarGuion() {
    if (!guion) guion = fetch(GUION, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    return guion;
}

const mirador = id => meta?.miradores?.[id] ? id : meta?.paradas?.[id] || null;

/** true si la parada (o el mirador) tiene panorámica. */
export function hayPanorama(id) {
    return !!mirador(id);
}

function rumboYDistancia(a, b) {
    const R = Math.PI / 180, f1 = a.lat * R, f2 = b.lat * R, dl = (b.lon - a.lon) * R;
    const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    const rumbo = (Math.atan2(y, x) / R + 360) % 360;
    const d = 2 * R_MARTE * Math.asin(Math.sqrt(Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2));
    return { rumbo, d };
}
const aYaw = rumbo => ((rumbo + 540) % 360) - 180;          // 0 = norte en el centro, positivo hacia el este
const fmtM = m => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const cardinal = rumbo => CARD[Math.round(((rumbo % 360) + 360) % 360 / 45) % 8];
const CARD_LARGO = ['Norte', 'Noreste', 'Este', 'Sureste', 'Sur', 'Suroeste', 'Oeste', 'Noroeste'];
const cardinalLargo = rumbo => CARD_LARGO[Math.round(((rumbo % 360) + 360) % 360 / 45) % 8];
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const espera = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────── visor ─────────────────────────

function cargarScript(src) {
    return new Promise((ok, mal) => {
        const s = document.createElement('script');
        s.src = src; s.onload = ok; s.onerror = () => mal(new Error(`no se pudo cargar ${src}`));
        document.head.appendChild(s);
    });
}

async function cargarPannellum() {
    if (window.pannellum) return;
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = `${PANNELLUM}pannellum.css`;
    document.head.appendChild(css);
    await cargarScript(`${PANNELLUM}pannellum.js`);
}

const ICO = {
    cerrar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    paneles: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="1.8"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    enviar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l15-7-5 15-2.5-6.5L4 12z" fill="currentColor"/></svg>',
    aguja: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" stroke-opacity=".25"/><path class="n" d="M20 5l4 15h-8z"/><path d="M20 35l-4-15h8z" fill="currentColor" fill-opacity=".35"/></svg>',
};

const ORBE = '<span class="mw-orbe" data-estado="reposo" aria-hidden="true"><i></i><i></i><i></i></span>';

function construir() {
    let el = document.getElementById('mw-pano');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'mw-pano';
    el.className = `mw-pano${MODO_DEMO ? ' demo' : ''}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'mw-pano-titulo');
    el.innerHTML = `
        <div id="mw-pano-visor" class="mw-pano-visor"></div>
        <div class="mw-pano-vineta" aria-hidden="true"></div>
        <header class="mw-pano-cabecera mw-cristal">
            <span class="mw-vivo" aria-hidden="true"></span>
            <div><h2 id="mw-pano-titulo"></h2><p id="mw-pano-sub"></p></div>
        </header>
        <div class="mw-pano-acciones">
            <button type="button" class="mw-redondo mw-cristal" id="mw-pano-paneles" aria-pressed="false" title="Ocultar paneles (H)" aria-label="Ocultar paneles">${ICO.paneles}</button>
            <button type="button" class="mw-redondo mw-cristal mw-pano-cerrar" title="Cerrar (Esc)" aria-label="Cerrar la vista 360°">${ICO.cerrar}</button>
        </div>
        <aside class="mw-hud mw-hud-izq mw-cristal mw-jarvis" aria-label="Asistente Jarvis">
            <div class="mw-jarvis-cab">
                <div><b>Jarvis</b><small id="mw-jarvis-estado">Listo</small></div>
                <span class="mw-chip" id="mw-jarvis-chip">Demo guiada</span>
            </div>
            <div class="mw-nucleo" data-estado="reposo" aria-hidden="true">
                <span class="anillo a1"></span><span class="anillo a2"></span><span class="anillo a3"></span>
                <span class="onda">${'<i></i>'.repeat(9)}</span><span class="centro"></span>
            </div>
            <p class="mw-jarvis-pregunta" id="mw-jarvis-pregunta" aria-live="polite"></p>
            <p class="mw-jarvis-respuesta" id="mw-jarvis-respuesta" aria-live="polite"></p>
            <div class="mw-jarvis-datos" id="mw-jarvis-datos"></div>
            <button type="button" class="mw-jarvis-boton" id="mw-jarvis-boton">${ICO.mic}<span>Mantén para preguntar</span><kbd>J</kbd></button>
            <small class="mw-jarvis-etiqueta" id="mw-jarvis-etiqueta">Demo guiada · respuesta pregrabada · cifras modeladas</small>
            <ol class="mw-jarvis-log" id="mw-jarvis-log" hidden></ol>
        </aside>
        <aside class="mw-hud mw-hud-der mw-cristal" aria-label="Información">
            <section class="mw-rumbo">
                <span class="mw-aguja" id="mw-hud-aguja">${ICO.aguja}</span>
                <div><h3>Rumbo</h3><p><b id="mw-hud-rumbo">—</b> <span id="mw-hud-card"></span></p></div>
            </section>
            <section hidden><h3>Delante</h3><div id="mw-hud-objeto" class="mw-hud-objeto"></div></section>
            <section hidden><h3>Miradores</h3><ul id="mw-hud-ir" class="mw-hud-ir"></ul></section>
            <section><h3>Tu cuerpo</h3><div id="mw-hud-diagrama" class="mw-hud-diagrama"><div class="silueta" id="mw-hud-silueta"></div><ul id="mw-hud-zonas"></ul></div></section>
            <section><h3 id="mw-hud-traje-tit">Traje</h3><div id="mw-hud-traje" class="mw-hud-barras"></div></section>
            <section><h3>Cuerpo</h3><div id="mw-hud-cuerpo" class="mw-hud-cuerpo"></div></section>
        </aside>
        <div class="mw-voz mw-cristal" id="mw-voz" aria-live="polite">
            ${ORBE}
            <div class="mw-voz-txt"><small id="mw-voz-estado"></small><p id="mw-voz-texto"></p></div>
        </div>
        <p id="mw-pano-pie" class="mw-pano-pie"></p>`;
    document.body.appendChild(el);
    el.querySelector('.mw-pano-cerrar').addEventListener('click', cerrarPanorama);
    el.querySelector('#mw-pano-paneles').addEventListener('click', alternarPaneles);
    document.addEventListener('keydown', teclado, true);
    document.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'j' && (escucha || empezando)) { e.preventDefault(); soltarEscucha(); } }, true);
    window.addEventListener('blur', () => { if (escucha || empezando) soltarEscucha(); });
    // Jarvis solo de voz: un botón (o la tecla J / la barra espaciadora) lanza la escena guiada.
    const boton = el.querySelector('#mw-jarvis-boton');
    boton.addEventListener('pointerdown', e => { e.preventDefault(); boton.setPointerCapture?.(e.pointerId); empezarEscucha(); });
    for (const ev of ['pointerup', 'pointercancel']) boton.addEventListener(ev, () => soltarEscucha());
    boton.addEventListener('click', e => { if (e.detail === 0) escenaJarvis(); });   // Intro/espacio sobre el botón
    el.querySelector('#mw-voz').addEventListener('click', () => escenaJarvis());
    el.querySelector('#mw-hud-ir').addEventListener('click', e => { const b = e.target.closest('[data-ir]'); if (b) saltar(b.dataset.ir); });
    cargarGuion().then(g => {
        const et = g?.escena?.[IDIOMA_DEMO]?.etiqueta || g?.etiqueta?.[IDIOMA_DEMO];
        if (et) { el.querySelector('#mw-jarvis-etiqueta').textContent = et; el.querySelector('#mw-jarvis-chip').title = et; }
    });
    return el;
}

function alternarPaneles() {
    const el = document.getElementById('mw-pano');
    const oculto = el.classList.toggle('sin-paneles');
    const b = el.querySelector('#mw-pano-paneles');
    b.setAttribute('aria-pressed', String(oculto));
    b.title = oculto ? 'Mostrar paneles (H)' : 'Ocultar paneles (H)';
}

function teclado(e) {
    const el = document.getElementById('mw-pano');
    if (!el?.classList.contains('visible')) return;
    if (e.key === 'Escape') { e.stopPropagation(); cerrarPanorama(); return; }
    if (e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'h') { e.preventDefault(); alternarPaneles(); return; }
    if (k === 'j') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) empezarEscucha(); return; }
    if (k === ' ') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) escenaJarvis(); return; }
    if (!MODO_DEMO) return;
    // Atajos del presentador: simulan la frase hablada (respaldo sin micrófono ni red).
    if (k === 'v') { e.preventDefault(); alternarEscucha(); return; }
    if (/^[1-4]$/.test(k)) { e.preventDefault(); e.stopPropagation(); if (!ocupado) simular(atajo(k)); }
}

const precargadas = new Map();
/**
 * Descarga y decodifica por adelantado el visor y la imagen del mirador (por defecto el principal) para que la vista
 * 360° aparezca al instante al terminar la ruta, sin «Cargando…».
 */
export async function precargarPanorama(id = MIRADOR_PRINCIPAL) {
    await cargarPanoramas();
    if (MODO_DEMO) cargarGuion();
    const mid = mirador(id);
    if (!mid || precargadas.has(mid)) return precargadas.get(mid);
    const img = new Image();
    img.crossOrigin = 'anonymous';          // mismo modo que la petición de Pannellum: reutiliza la caché
    img.src = `${BASE}${meta.miradores[mid].archivo}`;
    const listo = Promise.all([cargarPannellum().catch(() => {}), img.decode().catch(() => {})]).then(() => img);
    precargadas.set(mid, listo);
    return listo;
}

/** Abre la vista 360° del mirador principal (al terminar la ruta). */
export function abrirPrincipal(op = {}) {
    return abrirPanorama(MIRADOR_PRINCIPAL, op);
}

/**
 * Abre la panorámica de una parada o de un mirador.
 * @param {string} id  id de parada (data/ruta/puntos_eva.json) o de mirador
 * @param {{rumbo?: number, alCerrar?: Function, parada?: string}} [op]  rumbo: dirección inicial (° desde el norte)
 */
export async function abrirPanorama(id, op = {}) {
    await cargarPanoramas();
    const mid = mirador(id);
    if (!mid) return false;
    const p = meta.miradores[mid];
    const el = construir();
    const soles = p.soles.length > 1 ? `soles ${p.soles[0]}–${p.soles[p.soles.length - 1]}` : `sol ${p.soles[0]}`;
    el.querySelector('#mw-pano-titulo').textContent = p.nombreCorto || p.titulo;
    const sub = `Vista 360° · fotos reales de Perseverance (Mastcam-Z) · ${soles}`;
    el.querySelector('#mw-pano-sub').textContent = sub;
    el.querySelector('.mw-pano-cabecera').title = `${p.titulo} · ${sub}`;
    el.querySelector('#mw-pano-pie').textContent = `${p.credito}. ${p.nota || ''} Punto de vista fijo de Perseverance: se mira alrededor.`;
    const parada = op.parada || (meta.paradas[id] ? id : Object.keys(meta.paradas).find(k => meta.paradas[k] === mid) || null);
    actual = { id: mid, p, parada };
    clearTimeout(cierreT);
    el.classList.remove('cerrando');
    el.style.transition = 'opacity .6s ease';
    el.style.opacity = '0';
    el.classList.add('visible');
    await precargarPanorama(mid);
    if (op.alCerrar !== undefined || !alCerrarActual) alCerrarActual = op.alCerrar || alCerrarActual || null;
    try {
        await cargarPannellum();
    } catch (e) {
        el.querySelector('#mw-pano-visor').innerHTML =
            `<p class="mw-pano-error">No se pudo cargar el visor 360° (sin conexión). <a href="${BASE}${p.archivo}" target="_blank" rel="noopener">Abrir la imagen</a></p>`;
        el.style.opacity = '1';
        return true;
    }
    visor?.destroy();
    el.querySelector('#mw-pano-visor').innerHTML = '';
    await perfilMascara(mid);                 // la imagen ya está precargada: es inmediato
    const yaw0 = Number.isFinite(op.rumbo) ? aYaw(op.rumbo) : 0;
    const inicio = encuadreSeguro(yaw0, -3, 72);
    const otros = Object.entries(meta.miradores).filter(([k]) => k !== mid);
    visor = window.pannellum.viewer('mw-pano-visor', {
        type: 'equirectangular',
        panorama: `${BASE}${p.archivo}`,
        haov: p.haov, vaov: p.vaov, vOffset: p.vOffset,
        yaw: yaw0,
        // Encuadre de «estar ahí»: campo algo cerrado mirando al horizonte; sin ver el borde superior de la imagen
        // (cielo vacío) y con el inferior limitado para no ver la cubierta enmascarada del rover, salvo en el
        // mirador principal, donde hay que poder bajar la vista hasta la roca (−54°).
        pitch: inicio.p, hfov: inicio.h, minHfov: 30, maxHfov: 88,
        maxPitch: p.vOffset + p.vaov / 2,
        minPitch: mid === MIRADOR_PRINCIPAL ? -64 : p.vOffset - p.vaov / 2 + 28,
        autoLoad: true, compass: false, northOffset: 0, showFullscreenCtrl: false, showZoomCtrl: false,
        strings: { loadingLabel: 'Cargando las fotos…' },
        hotSpots: [
            // Objetos de interés: al pulsarlos, el asistente recibe sus datos de NASA.
            ...(p.objetos || []).map(o => ({
                pitch: o.pitch, yaw: o.yaw, type: 'info', text: o.nombre, cssClass: 'mw-pano-objeto',
                createTooltipFunc: (div, t) => { const s = document.createElement('span'); s.textContent = t; div.appendChild(s); },
                createTooltipArgs: o.nombre,
                clickHandlerFunc: () => { emitirObjeto(o, 'clic'); responderObjeto(o); },
            })),
            // Flechas hacia los otros miradores, en su dirección real (desactivadas en la demo).
            ...(SALTOS_ENTRE_MIRADORES ? otros : []).map(([k, m]) => {
                const { rumbo, d } = rumboYDistancia(p, m);
                return {
                    pitch: -14, yaw: aYaw(rumbo), type: 'info', cssClass: 'mw-pano-ir',
                    createTooltipFunc: (div, t) => { const s = document.createElement('span'); s.textContent = t; div.appendChild(s); },
                    createTooltipArgs: `Ir a ${m.nombreCorto} · ${fmtM(d)} al ${cardinal(rumbo)}`,
                    clickHandlerFunc: () => saltar(k),
                };
            }),
        ],
    });
    // Sin caja de «Cargando…»: la imagen ya está precargada; se muestra con un fundido al estar lista.
    const caja = el.querySelector('.pnlm-load-box');
    if (caja) caja.style.display = 'none';
    let mostrado = false;
    const mostrar = () => requestAnimationFrame(() => {
        el.style.opacity = '1';
        if (mostrado) return;
        mostrado = true;
        if (mid === MIRADOR_PRINCIPAL) setTimeout(llegadaGuiada, 700);   // tras el fundido de entrada
    });
    visor.on('load', mostrar);
    // Si el usuario coge la vista con el ratón o el dedo, la interpolación se detiene y manda él.
    visor.on('mousedown', pararVuelo);
    visor.on('touchstart', pararVuelo);
    vigilarNegro();
    setTimeout(mostrar, 2500);               // por si el evento no llega
    pintarMiradores();
    clearInterval(reloj);
    reloj = setInterval(actualizarHud, 250);
    actualizarHud();
    estadoVoz('reposo');
    prepararJarvis(p);
    return true;
}

/** Salta a otro mirador mirando en la dirección en la que se llega. */
async function saltar(k) {
    if (!actual || !meta.miradores[k]) return;
    const { rumbo } = rumboYDistancia(actual.p, meta.miradores[k]);
    const el = document.getElementById('mw-pano');
    el.classList.add('saltando');
    await espera(350);
    await abrirPanorama(k, { rumbo });
    el.classList.remove('saltando');
    decir(`Has llegado al mirador de ${meta.miradores[k].nombreCorto}.`);
}

// ───────────────────────── objetos delante ─────────────────────────

function emitirObjeto(o, como) {
    const detail = { parada: actual?.parada, mirador: actual?.id, como, objeto: o };
    window.dispatchEvent(new CustomEvent('marswalk:objeto', { detail }));
    return detail;
}

function masCercano(margen) {
    if (!visor || !actual?.p?.objetos?.length) return null;
    const yaw = visor.getYaw(), pitch = visor.getPitch(), R = Math.PI / 180;
    const dir = (y, q) => [Math.cos(q * R) * Math.cos(y * R), Math.cos(q * R) * Math.sin(y * R), Math.sin(q * R)];
    const v = dir(yaw, pitch);
    let mejor = null, dmin = Infinity;
    for (const o of actual.p.objetos) {
        const w = dir(o.yaw, o.pitch);
        const ang = Math.acos(Math.min(1, v[0] * w[0] + v[1] * w[1] + v[2] * w[2])) / R;
        if (ang < dmin) { dmin = ang; mejor = o; }
    }
    return mejor && dmin <= margen ? { objeto: mejor, anguloGrados: Math.round(dmin) } : null;
}

/**
 * «¿Qué tengo delante?»: el objeto de interés más cercano a la dirección de la vista (a menos de `margen` grados), o
 * null. Emite 'marswalk:objeto'. Datos con fuentes de NASA (#15).
 */
export function objetoDelante(margen = 35) {
    const c = masCercano(margen);
    return c ? { ...emitirObjeto(c.objeto, 'mirada'), anguloGrados: c.anguloGrados } : null;
}

/**
 * Objetos de interés de una parada o mirador (con sus fichas y fuentes de NASA), sin abrir la vista 360°.
 * Para el popup de Jarvis durante la ruta (#15). Devuelve [] si no hay.
 */
export async function objetosDe(id) {
    await cargarPanoramas();
    const mid = mirador(id);
    return mid ? (meta.miradores[mid].objetos || []) : [];
}

/** Gira la vista 360° hacia (yaw, pitch) en grados; para que el asistente enseñe un objeto. */
export function mirarPanorama(yaw, pitch, hfov = 60, ms) {
    if (!visor) return false;
    acercarse(yaw, pitch, hfov, ms);
    return true;
}

// ───────────────────────── cámara: sin la cubierta negra del rover ─────────────────────────
// Mastcam-Z enmascara en negro la cubierta del rover. Su borde superior cambia mucho con la dirección (de −16° a −80°),
// así que se mide en la propia foto: para cada una de 360 columnas, la altura a la que empieza la franja negra que llega
// hasta el borde inferior. La cámara nunca baja tanto que el borde inferior de la pantalla la alcance.

const perfiles = new Map();      // mirador → Float32Array(360) con la altura (°) donde empieza el negro, o null
const MARGEN_NEGRO = 3;          // grados de foto útil que se dejan por encima del negro

async function perfilMascara(mid) {
    if (perfiles.has(mid)) return perfiles.get(mid);
    let perfil = null;
    try {
        const img = await precargarPanorama(mid);
        const p = meta.miradores[mid];
        const W = 360, H = Math.max(60, Math.round(W * img.naturalHeight / img.naturalWidth));
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, W, H);
        const d = ctx.getImageData(0, 0, W, H).data;
        const arriba = p.vOffset + p.vaov / 2;
        perfil = new Float32Array(W);
        for (let x = 0; x < W; x++) {
            let r = H;
            while (r > 0) {
                const i = ((r - 1) * W + x) * 4;
                if ((d[i] + d[i + 1] + d[i + 2]) / 3 >= 16) break;
                r--;
            }
            perfil[x] = arriba - (r / H) * p.vaov;
        }
    } catch { perfil = null; }           // sin perfil se usan los límites fijos del visor
    perfiles.set(mid, perfil);
    return perfil;
}

const RAD = Math.PI / 180;
/** Campo vertical (°) para un campo horizontal dado, según la forma de la pantalla. */
function vfovDe(hfov) {
    const el = document.getElementById('mw-pano-visor');
    const asp = el && el.clientHeight ? el.clientWidth / el.clientHeight : 16 / 9;
    return 2 * Math.atan(Math.tan(hfov / 2 * RAD) / asp) / RAD;
}
/** Cabeceo mínimo para que, mirando a `yaw` con campo `hfov`, no se vea la franja negra. */
function cabeceoMinimo(yaw, hfov) {
    const perfil = actual && perfiles.get(actual.id);
    if (!perfil) return -90;
    const v = vfovDe(hfov);
    const abajo = Math.max(-89, -v / 2 - 20);   // borde inferior aproximado para el ancho de barrido
    // Mirando hacia abajo, las esquinas inferiores abarcan más rumbo que el centro.
    const media = Math.min(90, Math.atan(Math.tan(hfov / 2 * RAD) / Math.max(.2, Math.cos(abajo * RAD))) / RAD) + 2;
    let techo = -90;
    for (let a = -media; a <= media; a += 1) {
        const x = ((Math.round(yaw + a + 180) % 360) + 360) % 360;
        if (perfil[x] > techo) techo = perfil[x];
    }
    return techo + MARGEN_NEGRO + v / 2;
}

/**
 * Encuadre sin negro para (yaw, pitch, hfov): si entre la franja negra y el borde superior de la foto no cabe la altura
 * de la pantalla, se cierra el campo; luego el cabeceo se coloca entre el mínimo sin negro y el techo de la foto.
 */
function encuadreSeguro(yaw, pitch, hfov) {
    const p = actual?.p;
    if (!p || !perfiles.get(actual.id)) return { p: pitch, h: hfov };
    const techo = p.vOffset + p.vaov / 2;
    let h = hfov;
    while (h > 30 && cabeceoMinimo(yaw, h) + vfovDe(h) / 2 > techo) h -= 1;
    const v = vfovDe(h);
    return { p: Math.min(Math.max(pitch, cabeceoMinimo(yaw, h)), techo - v / 2), h };
}

let vuelo = null;                // animación en curso (id de requestAnimationFrame)
const suave = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const tramo = (t, a, b) => suave(Math.min(1, Math.max(0, (t - a) / (b - a))));

function pararVuelo() { if (vuelo) cancelAnimationFrame(vuelo); vuelo = null; }

/**
 * Interpolación de cámara hasta (yaw, pitch, hfov): primero gira a la altura del horizonte, y solo cuando ya mira hacia
 * el objetivo baja la vista y se acerca; en cada fotograma se respeta el cabeceo mínimo sin negro.
 * Si con ese límite el objetivo quedara fuera de pantalla, se cierra el campo hasta que entre.
 */
function acercarse(yaw, pitch, hfov = 55, ms) {
    if (!visor) return Promise.resolve();
    pararVuelo();
    try { visor.stopMovement(); } catch { /* */ }
    let hf = hfov;
    while (hf > 32 && cabeceoMinimo(yaw, hf) > pitch + vfovDe(hf) * .32) hf -= 2;
    const pf = Math.max(pitch, cabeceoMinimo(yaw, hf));
    const y0 = visor.getYaw(), p0 = visor.getPitch(), h0 = visor.getHfov();
    const dy = ((yaw - y0 + 540) % 360) - 180;                 // por el camino más corto
    const alto = Math.max(p0, -6);                              // altura de crucero mientras gira
    const dur = ms ?? Math.min(5200, 1800 + Math.abs(dy) * 14 + Math.abs(pf - p0) * 18);
    const t0 = performance.now();
    return new Promise(fin => {
        const paso = ahora => {
            if (!visor) { vuelo = null; return fin(); }
            const t = Math.min(1, (ahora - t0) / dur);
            const y = y0 + dy * tramo(t, 0, .62);
            const subir = tramo(t, 0, .25), bajar = tramo(t, .45, 1);
            const pc = p0 + (alto - p0) * subir;
            const h = h0 + (hf - h0) * tramo(t, .25, 1);
            const e = encuadreSeguro(y, pc + (pf - pc) * bajar, h);
            visor.lookAt(e.p, y, e.h, false);
            if (t < 1) vuelo = requestAnimationFrame(paso);
            else { vuelo = null; fin(); }
        };
        vuelo = requestAnimationFrame(paso);
    });
}

/** Mientras la vista 360° está abierta: si el usuario arrastra o aleja hacia la franja negra, la vista se queda justo encima. */
let guardia = null;
function vigilarNegro() {
    cancelAnimationFrame(guardia);
    const paso = () => {
        if (!visor) { guardia = null; return; }
        if (!vuelo) {
            const y = visor.getYaw(), h = visor.getHfov(), q = visor.getPitch(), e = encuadreSeguro(y, q, h);
            if (Math.abs(e.p - q) > .05 || Math.abs(e.h - h) > .05) visor.lookAt(e.p, y, e.h, false);
        }
        guardia = requestAnimationFrame(paso);
    };
    guardia = requestAnimationFrame(paso);
}

/** Al entrar en la vista 360° del mirador principal: la cámara se acerca sola hasta la roca Wildcat Ridge. */
function llegadaGuiada() {
    const o = actual?.p?.objetos?.[0];
    if (!o) return;
    acercarse(o.yaw, o.pitch, 52);
}

// ───────────────────────── HUD ─────────────────────────

const $p = s => document.querySelector(`#mw-pano ${s}`);
const pct = x => `${Math.round(x)} %`;

function pintarMiradores() {
    const ul = $p('#mw-hud-ir');
    ul.closest('section').hidden = !SALTOS_ENTRE_MIRADORES;
    if (!SALTOS_ENTRE_MIRADORES) { ul.innerHTML = ''; return; }
    ul.innerHTML = Object.entries(meta.miradores).filter(([k]) => k !== actual.id).map(([k, m]) => {
        const { rumbo, d } = rumboYDistancia(actual.p, m);
        return `<li><button type="button" data-ir="${k}" data-rumbo="${rumbo}"><b>${esc(m.nombreCorto)}</b><span>${fmtM(d)} · ${cardinal(rumbo)} · <i class="giro"></i></span></button></li>`;
    }).join('');
}

const NIVEL = { asumible: ['Asumible', 'ok'], exigente: ['Exigente', 'aviso'], demasiado: ['Demasiado exigente', 'mal'] };

function actualizarHud() {
    if (!visor || !actual) return;
    const yaw = visor.getYaw(), rumbo = (yaw + 360) % 360;
    $p('#mw-hud-rumbo').textContent = `${String(Math.round(rumbo) % 360).padStart(3, '0')}°`;
    $p('#mw-hud-card').textContent = cardinalLargo(rumbo);
    $p('#mw-hud-aguja').style.transform = `rotate(${-rumbo}deg)`;
    for (const b of document.querySelectorAll('#mw-hud-ir [data-rumbo]')) {
        const g = ((Number(b.dataset.rumbo) - rumbo + 540) % 360) - 180;
        b.querySelector('.giro').textContent = Math.abs(g) < 15 ? 'de frente' : g > 0 ? `${Math.round(g)}° a la derecha` : `${Math.round(-g)}° a la izquierda`;
    }
    const c = masCercano(35);
    const caja = $p('#mw-hud-objeto');
    const clave = c?.objeto.id || '';
    if (caja.dataset.obj !== clave) {
        caja.dataset.obj = clave;
        caja.classList.toggle('activo', !!c);
        caja.innerHTML = c ? `<b>${esc(c.objeto.nombre)}</b><p>${esc(c.objeto.que)}</p>` +
            `<dl><dt>Minerales</dt><dd>${esc(c.objeto.minerales)}</dd><dt>Muestras</dt><dd>${esc(c.objeto.muestras)}</dd></dl>` +
            `<p class="fuentes">${(c.objeto.fuentes || []).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname.replace('www.', ''))}</a>`).join('')}</p>`
            : `<p class="vacio">Nada catalogado en esta dirección. Busca el marcador pulsante.</p>`;
    }
    // Diagrama del cuerpo (mismo instante que el traje): silueta por zonas y cifra corta de cada una.
    const ec = window.marswalk?.cuerpoEn?.(actual.parada);
    const zonasHtml = ec ? Object.entries(ZONAS_CORTAS).map(([k, [n, f]]) =>
        `<li class="${ec.zonas[k].nivel}"><i></i><span>${n}</span><b>${esc(f(ec.zonas[k]))}</b></li>`).join('')
        : '<li class="vacio">Planifica una ruta para ver tu cuerpo.</li>';
    const zl = $p('#mw-hud-zonas');
    if (zl.dataset.h !== zonasHtml) { zl.dataset.h = zonasHtml; zl.innerHTML = zonasHtml; }
    pintarSilueta(ec?.zonas);
    const t = window.marswalk?.traje?.(actual.parada);
    $p('#mw-hud-traje-tit').innerHTML = t ? `Traje <span>${esc(t.momento)}</span>` : 'Traje';
    // «Bajo»: < 20 % en consumibles; < 10 % en el margen de vuelta, que ya se mide por encima de la reserva obligatoria.
    const trajeHtml = t ? [['O₂', t.o2Pct, 20], ['Batería', t.batPct, 20], ['Agua', t.aguaPct, 20], ['Límite de vuelta a pie', t.margenPct, 10, t.limiteTxt]]
        .map(([n, v, umbral, txt]) => `<div class="barra ${v < umbral ? 'baja' : ''}"><span>${n}</span><b>${txt ? esc(txt) : pct(v)}</b><i><u style="width:${Math.max(0, Math.min(100, v))}%"></u></i></div>`).join('') +
        `<p class="nota">Hora local ${esc(t.hora)} · modelo del planificador</p>` : '<p class="vacio">Planifica una ruta para ver el traje.</p>';
    const tr = $p('#mw-hud-traje');
    if (tr.dataset.h !== trajeHtml) { tr.dataset.h = trajeHtml; tr.innerHTML = trajeHtml; }
    const cu = window.marswalk?.cuerpo?.();
    const [nivel, cls] = NIVEL[cu?.nivel] || ['', ''];
    const cuerpoHtml = cu?.disponible
        ? `<span class="nivel ${cls}">${nivel}</span>` +
          `<div class="cifras"><div><small>Esfuerzo medio</small><b>${pct(cu.mediaPct)}</b></div><div><small>Pico</small><b>${pct(cu.picoPct)}</b></div>` +
          `<div><small>Energía</small><b>${cu.kcalRango[0]}–${cu.kcalRango[1]}<em> kcal</em></b></div><div><small>O₂</small><b>${cu.o2Kg.toFixed(2).replace('.', ',')}<em> kg</em></b></div></div>` +
          (cu.consejo ? `<p class="consejo">${esc(cu.consejo)}</p>` : '') +
          `<p class="nota">${esc(cu.aviso)}</p>`
        : '<p class="vacio">Sin ruta activa.</p>';
    const cc = $p('#mw-hud-cuerpo');
    if (cc.dataset.h !== cuerpoHtml) { cc.dataset.h = cuerpoHtml; cc.innerHTML = cuerpoHtml; }
}

/**
 * Silueta del panel «Tu cuerpo»: el holograma 3D (holograma.js) si están los ficheros del modelo; si no, la silueta SVG.
 * Se monta una vez por panorámica abierta; luego solo cambian los colores de las zonas.
 */
let holo = null, holoMontando = false, holoNo = false;
function pintarSilueta(zonas) {
    const cont = $p('#mw-hud-silueta');
    if (!cont) return;
    if (holo) { if (!holo.contenedor.isConnected) { holo.h.destruir(); holo = null; } else { holo.h.actualizar(zonas); return; } }
    if (!holoNo && !holoMontando) {
        holoMontando = true;
        cont.classList.add('holo'); cont.querySelector('svg')?.remove();
        montarHolograma(cont).then(h => {
            holoMontando = false;
            if (!h) { holoNo = true; cont.classList.remove('holo'); pintarSilueta(zonas); return; }
            holo = { h, contenedor: cont };
            h.actualizar(zonas);
        }).catch(e => { holoMontando = false; holoNo = true; console.warn('[holograma]', e); });
    }
    if (holo || cont.classList.contains('holo')) return;   // montado o montándose
    if (!cont.querySelector('svg')) cont.innerHTML = svgCuerpo();
    cont.querySelectorAll('[data-zona]').forEach(el => el.setAttribute('class', zonas?.[el.dataset.zona]?.nivel || ''));
}

// ───────────────────────── Jarvis: voz ─────────────────────────

let ocupado = false;      // procesando o hablando una respuesta
let audioActual = null;

/** reposo | escucha | piensa | habla: anima los dos orbes y pone el texto de estado. */
function estadoVoz(estado, texto) {
    for (const o of document.querySelectorAll('#mw-pano .mw-orbe, #mw-pano .mw-nucleo')) o.dataset.estado = estado;
    const el = document.getElementById('mw-pano');
    if (!el) return;
    el.dataset.voz = estado;
    const txt = texto ?? {
        reposo: escuchaContinua ? 'Escuchando «Hey Jarvis»…' : 'Listo · mantén J para preguntar',
        escucha: 'Escuchando…', piensa: 'Consultando los datos…', habla: 'Hablando',
    }[estado];
    $p('#mw-jarvis-estado').textContent = txt;
    $p('#mw-voz-estado').textContent = txt;
    if (estado === 'reposo') $p('#mw-voz-texto').textContent = '';
}

const VOCES = {
    en: [/google uk english male/i, /daniel/i, /ryan/i, /arthur/i, /george/i, /en-gb/i, /^en/i],
    es: [/google español$/i, /jorge/i, /álvaro|alvaro/i, /pablo/i, /es-es/i, /^es/i],
};
function elegirVoz(lang) {
    const vs = window.speechSynthesis?.getVoices?.() || [];
    for (const re of VOCES[lang]) {
        const v = vs.find(x => re.test(x.name) || re.test(x.lang));
        if (v && (v.lang || '').toLowerCase().startsWith(lang)) return v;
    }
    return vs.find(x => (x.lang || '').toLowerCase().startsWith(lang)) || null;
}
try { window.speechSynthesis?.getVoices(); } catch { /* las voces cargan en segundo plano */ }

/** Maqueta el texto con cada palabra en su <span>, todavía invisible; devuelve los spans en orden. */
function maquetar(el, texto) {
    const frag = document.createDocumentFragment(), spans = [];
    for (const parte of texto.split(/(\s+)/)) {
        if (!parte) continue;
        if (/^\s+$/.test(parte)) { frag.append(' '); continue; }
        const sp = document.createElement('span');
        sp.className = 'mw-pal'; sp.textContent = parte;
        frag.append(sp); spans.push(sp);
    }
    el.replaceChildren(frag);
    return spans;
}

/**
 * Transcripción fluida. Antes se reescribía el párrafo entero (y el subtítulo) a cada palabra: el texto cambiaba de
 * tamaño, el navegador recalculaba la maquetación del panel y repintaba su desenfoque decenas de veces por segundo.
 * Ahora el texto se maqueta una sola vez, completo e invisible, y cada palabra aparece con un fundido (solo opacidad:
 * ni maquetación ni saltos de línea en marcha). El avance lo marca `f()` (0-1): el reloj del audio o el tiempo.
 * El subtítulo de abajo va por frases, así nunca se corta.
 */
function crearRevelado(panel, sub, texto) {
    const palabras = maquetar(panel, texto);
    const trozos = texto.trim().split(/\s+/), total = Math.max(1, texto.length);
    const inicio = []; let c = 0;
    for (const t of trozos) { inicio.push(c / total); c += t.length + 1; }
    // Frases del subtítulo: se corta en un signo de cierre a partir de ~90 caracteres.
    const grupos = []; let g0 = 0, largo = 0;
    trozos.forEach((t, i) => {
        largo += t.length + 1;
        if (i === trozos.length - 1 || (largo >= 90 && /[.!?…»”"]$/.test(t))) { grupos.push([g0, i + 1]); g0 = i + 1; largo = 0; }
    });
    let dichas = 0, grupo = -1, spansSub = [], raf = 0, f = null;
    const poner = n => {
        n = Math.min(palabras.length, n);
        while (dichas < n) {
            palabras[dichas].classList.add('dicha');
            const g = grupos.findIndex(([a, b]) => dichas >= a && dichas < b);
            if (sub && g !== grupo && g >= 0) { grupo = g; spansSub = maquetar(sub, trozos.slice(grupos[g][0], grupos[g][1]).join(' ')); }
            if (sub && grupo >= 0) spansSub[dichas - grupos[grupo][0]]?.classList.add('dicha');
            dichas++;
        }
    };
    const paso = () => {
        const v = f();
        let n = dichas;
        while (n < palabras.length && inicio[n] <= v) n++;
        poner(n);
        raf = v < 1 && dichas < palabras.length ? requestAnimationFrame(paso) : 0;
    };
    return {
        seguir(fn) { f = fn; cancelAnimationFrame(raf); raf = requestAnimationFrame(paso); },
        durante(ms) { const t0 = performance.now(); this.seguir(() => (performance.now() - t0) / Math.max(1, ms)); },
        fin() { cancelAnimationFrame(raf); raf = 0; poner(palabras.length); },
        get enMarcha() { return !!raf; },
    };
}

let finHabla = null;   // termina la respuesta en curso (al cerrar la vista a media frase)
/** Reproduce la respuesta: audio pregrabado si lo hay; si no, voz sintética. Resuelve al terminar. */
function hablar(texto, { lang = 'es', audio = null, p } = {}) {
    return new Promise(fin => {
        const R = crearRevelado(p, $p('#mw-voz-texto'), texto);
        let hecho = false;
        const terminar = () => { if (hecho) return; hecho = true; finHabla = null; R.fin(); fin(); };
        finHabla = terminar;
        try { window.speechSynthesis?.cancel(); audioActual?.pause(); } catch { /* */ }
        if (audio) {
            const a = new Audio(audio);
            audioActual = a;
            // El texto sigue al reloj del propio audio (termina un poco antes que la voz): nunca se desincroniza.
            a.onloadedmetadata = () => R.seguir(() => (a.currentTime + 0.12) / Math.max(0.1, a.duration * 0.93));
            a.onended = terminar;
            a.onerror = () => { audioActual = null; finHabla = null; hecho = true; hablar(texto, { lang, p }).then(fin); };
            a.play().catch(a.onerror);
            return;
        }
        // ~ 14 caracteres por segundo a velocidad normal: el texto avanza al ritmo de la voz.
        const ms = (texto.length / 14.5) * 1000;
        if (!window.speechSynthesis) { R.durante(texto.length * 30); setTimeout(terminar, texto.length * 30 + 200); return; }
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = lang === 'en' ? 'en-GB' : 'es-ES';
        const v = elegirVoz(lang);
        if (v) u.voice = v;
        u.rate = 1.02; u.pitch = lang === 'en' ? 0.92 : 1;
        u.onstart = () => { if (!R.enMarcha) R.durante(ms); };
        u.onend = terminar; u.onerror = terminar;
        speechSynthesis.speak(u);
        // Algunos navegadores no disparan onstart sin interacción previa: no dejar el texto vacío.
        setTimeout(() => { if (!hecho && !R.enMarcha) R.durante(ms); }, 900);
    });
}

/** Transcripción «en vivo» de lo que dice el usuario (simulada): palabra a palabra, sin rehacer la maquetación. */
async function transcribir(texto, panel, sub) {
    const cita = `“${texto}”`, ms = Math.max(600, texto.length * 30);
    const R = crearRevelado(panel || document.createElement('p'), sub, cita);
    R.durante(ms);
    await espera(ms + 60);
    R.fin();
}

function anotar(quien, texto) {
    const li = document.createElement('li');
    li.className = quien;
    li.innerHTML = quien === 'jarvis' ? '<span class="quien">Jarvis</span><p></p>' : '<p></p>';
    li.querySelector('p').textContent = texto;
    const log = $p('#mw-jarvis-log');
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
    return li.querySelector('p');
}

/** Jarvis responde: texto en el panel y, si `voz`, en voz alta con subtítulo. */
async function decir(texto, { voz = true, lang = 'es', audio = null } = {}) {
    const p = anotar('jarvis', voz ? '' : texto);
    if (!voz || !document.getElementById('mw-pano')?.classList.contains('visible')) return;
    estadoVoz('habla');
    document.getElementById('mw-pano')?.classList.add('subtitulos');
    await hablar(texto, { lang, audio, p });
    await espera(1400);
    document.getElementById('mw-pano')?.classList.remove('subtitulos');
    estadoVoz('reposo');
}

function responderObjeto(o) {
    return decir(`${o.nombre}. ${o.que} ${o.minerales} ${o.porque}`);
}

// ───────────────────────── Jarvis: escena guiada (solo voz) ─────────────────────────

const pct1 = x => `${(Math.round(x * 1000) / 10).toString().replace('.', ',')} %`;

/** Panel en reposo al abrir la vista: sin conversación, con la indicación de qué hacer. */
function prepararJarvis(p) {
    if (ocupado) return;
    $p('#mw-jarvis-pregunta').textContent = '';
    $p('#mw-jarvis-respuesta').textContent = `Estás en ${p?.nombreCorto || p?.titulo || 'el mirador'}. Mantén pulsada J (o el botón), haz la pregunta y suelta.`;
    $p('#mw-jarvis-datos').innerHTML = '';
    document.getElementById('mw-pano')?.classList.remove('jarvis-activo');
}

/**
 * Cifras de la escena, leídas en vivo del planificador (las mismas que da Hani en #15): margen mínimo de vuelta y
 * valor científico de las rutas Segura y Máx. ciencia, y el O₂ modelado de la ruta activa.
 */
function pintarDatosEscena() {
    const R = window.marswalk?.estado?.resultados || {};
    const seg = R.segura, cie = R.ciencia, c = window.marswalk?.cuerpo?.();
    const filas = [];
    if (seg?.factible && cie?.factible) {
        filas.push(['Margen de vuelta', `Segura ${pct1(seg.margenMin)}`, `Máx. ciencia ${pct1(cie.margenMin)}`, cie.margenMin < 0.1]);
        filas.push(['Valor científico', `Segura ${seg.valorCiencia}`, `Máx. ciencia ${cie.valorCiencia}`, false]);
    }
    if (c?.disponible) filas.push(['O₂ modelado (ruta activa)', `${(Math.round(c.o2Kg * 100) / 100).toString().replace('.', ',')} kg`, c.nombreRuta || '', false]);
    const nota = cie?.factible ? `<p class="mw-jarvis-nota">El audio redondea: el modelo da ${pct1(cie.margenMin)} de margen en Máx. ciencia.</p>` : '';
    $p('#mw-jarvis-datos').innerHTML = filas.map(([t, a, b, mal]) =>
        `<div class="fila${mal ? ' mal' : ''}"><small>${t}</small><b>${a}</b>${b ? `<span>${b}</span>` : ''}</div>`).join('') + nota;
}

/**
 * Escena guiada de Wildcat Ridge, en dos fases como una interfaz de voz:
 *  1. al pulsar (J mantenida, o el botón mantenido): «Escuchando…» con la onda mientras Pablo dice la pregunta;
 *  2. al soltar: aparece la transcripción preparada, ~1 s «Pensando…» y suena el audio pregrabado de Pablo
 *     (data/ruta/jarvis/) con el mismo texto en pantalla.
 * Una pulsación corta (clic, espacio) hace la escena entera con una escucha simulada de ~2 s.
 * No se graba ni se reconoce audio: la interfaz lo indica («demo guiada · respuesta pregrabada»).
 */
let escucha = null;         // { e, seguro } mientras se mantiene pulsado
let empezando = false, soltarPendiente = false;   // por si se suelta antes de que la escucha haya arrancado
async function empezarEscucha() {
    if (ocupado || escucha || !actual) return false;
    ocupado = true; empezando = true; soltarPendiente = false;
    const g = await cargarGuion();
    const e = g?.escena?.[IDIOMA_DEMO] || g?.escena?.es;
    if (!e) { ocupado = false; empezando = false; return false; }
    try { window.speechSynthesis?.cancel(); audioActual?.pause(); } catch { /* */ }
    const el = document.getElementById('mw-pano');
    el.classList.add('jarvis-activo', 'subtitulos');
    const o = actual.p?.objetos?.[0];
    if (o) mirarPanorama(o.yaw, o.pitch, 52);              // la vista se acerca a Wildcat Ridge (sin ver el negro)
    $p('#mw-jarvis-respuesta').textContent = '';
    $p('#mw-jarvis-datos').innerHTML = '';
    $p('#mw-jarvis-pregunta').textContent = '';
    const sub = $p('#mw-voz-texto');
    sub.classList.add('usuario'); sub.textContent = '…';
    estadoVoz('escucha', 'Escuchando… suelta J al terminar');
    // Por si la tecla se suelta fuera de la ventana: a los 15 s se responde igualmente.
    escucha = { e, seguro: setTimeout(() => soltarEscucha(), 15000) };
    empezando = false;
    if (soltarPendiente) { soltarPendiente = false; setTimeout(soltarEscucha, 600); }   // pulsación muy corta
    return true;
}
async function soltarEscucha() {
    if (!escucha) { if (empezando) soltarPendiente = true; return; }
    const { e, seguro } = escucha;
    escucha = null;
    clearTimeout(seguro);
    const el = document.getElementById('mw-pano');
    try {
        // Transcripción preparada: aparece rápida, como si el reconocedor acabara de entender la frase
        const preg = $p('#mw-jarvis-pregunta'), sub = $p('#mw-voz-texto');
        // Con el fundido palabra a palabra de Hani (crearRevelado), pero rápido: ya se ha «oído» la frase entera.
        const R = crearRevelado(preg, sub, `“${e.pregunta}”`);
        R.durante(700);
        await espera(760);
        R.fin();
        await espera(350);
        sub.classList.remove('usuario');
        estadoVoz('piensa', 'Pensando…');
        await espera(1000);
        pintarDatosEscena();
        estadoVoz('habla', 'Respondiendo');
        await hablar(e.respuesta, { lang: IDIOMA_DEMO, audio: e.audio, p: $p('#mw-jarvis-respuesta') });
        await espera(1600);
    } finally {
        el?.classList.remove('subtitulos');
        estadoVoz('reposo', 'Listo · mantén J o el botón para repetir');
        ocupado = false;
    }
}
/** Pulsación corta: escucha simulada de ~2 s y respuesta. */
async function escenaJarvis() {
    if (!(await empezarEscucha())) return;
    await espera(2000);
    await soltarEscucha();
}

// ───────────────────────── Jarvis: respuestas ─────────────────────────

/** Inglés si la pregunta lo parece; si no, español. */
const idiomaDe = q => (/\b(what|what's|how|can|could|where|why|is|this|the|rock|oxygen|left|route|tell|show|me|i)\b/i.test(q)
    && !/[¿¡ñáéíóú]|\b(qué|que|cuánto|puedo|esta|roca)\b/i.test(q) ? 'en' : 'es');

const num = (x, d = 0, lang = 'es') => (lang === 'en' ? x.toFixed(d) : x.toFixed(d).replace('.', ','));
const horasMin = (h, lang) => { const H = Math.floor(h), M = Math.round((h - H) * 60); return lang === 'en' ? `${H} h ${M} min` : `${H} h ${M} min`; };

/** Objeto del que se pregunta: el que se mira o, si no hay ninguno, el más cercano, girando la vista hacia él. */
function objetoPreguntado(ctx) {
    if (ctx.objeto?.objeto) return { o: ctx.objeto.objeto, girado: false };
    const o = actual?.p?.objetos?.[0];
    if (!o) return null;
    mirarPanorama(o.yaw, o.pitch, 50);
    return { o, girado: true };
}

/** Motor local: solo datos de la app y fichas con fuente de NASA (y el guion de demo, sacado de esas fichas). */
async function responderLocal(q, ctx) {
    const t = q.toLowerCase();
    const lang = idiomaDe(q);
    const g = MODO_DEMO || lang === 'en' ? await cargarGuion() : null;
    const en = lang === 'en';

    const quiereRoca = /(roca|rock|stone|piedra|mineral|compos|qu[eé] (es|hay|tengo)|what('s| is) (this|that)|looking at|delante|in front|esto|ens[eé]ñame|mu[eé]strame|show me)/.test(t);
    const porQue = /(por qu[eé]|why|importa|matter|important|interesa)/.test(t);
    if (quiereRoca || (porQue && !/(ruta|route)/.test(t))) {
        const r = objetoPreguntado(ctx);
        if (!r) return { lang, texto: en ? 'There is no catalogued object at this viewpoint yet.' : 'En este mirador no hay ningún objeto catalogado todavía.' };
        emitirObjeto(r.o, ctx.objeto ? 'mirada' : 'pregunta');
        const prep = g?.objetos?.[r.o.id]?.[lang];
        const pre = r.girado ? (en ? 'Let me show you. ' : 'Te la enseño. ') : '';
        if (prep) return { lang, texto: pre + (porQue ? prep.porque : prep.que + (MODO_DEMO ? '' : ` ${prep.porque}`)), audio: porQue ? null : prep.audio };
        if (en) return { lang, texto: `${pre}${r.o.nombre}. I only have the Spanish fact sheet for this object; it is shown in the panel.` };
        return { lang, texto: `${pre}${r.o.nombre}. ${r.o.que} ${r.o.minerales} ${r.o.muestras} ${r.o.porque}` };
    }
    // Comer y beber (antes del traje: «beber agua» es una pregunta del cuerpo, no del depósito).
    if (/(comer|comida|beber|bebo|nutri|aliment|hidrat|\bsed\b|hambre|recuper|\beat\b|drink|food|thirst|hungry|recover)/.test(t)) {
        const n = ctx.cuerpo?.nutricion;
        if (!n) return { lang, texto: en ? 'There is no active route to plan your food and drink.' : 'No hay una ruta activa para planificar qué comer y beber.' };
        if (en) return { lang, texto: `Before: ${n.antes.hcG} grams of carbohydrate two to three hours ahead. During: sip from the suit drink bag${n.durante.hcG ? `, about 30 grams of carbohydrate per hour` : ''}. After: ${n.despues.protG} grams of protein and ${n.despues.hcG} grams of carbohydrate within two hours; chocolate milk covers most of it. Sports nutrition guidelines, not individual advice.` };
        return { lang, texto: `Antes, ${n.antes.hcG} gramos de hidratos dos o tres horas antes. Durante, sorbos de la bolsa del traje${n.durante.hcG ? ', con unos 30 gramos de hidratos por hora' : ''}. Al volver, ${n.despues.protG} gramos de proteína y ${n.despues.hcG} de hidratos en las dos primeras horas: un vaso grande de leche con cacao cubre casi todo. Son pautas de nutrición deportiva, no un consejo individual.` };
    }
    // Músculos, lactato, fatiga: el estado por zonas ahora (o al volver, si se planifica).
    if (/(lact|m[uú]scul|pierna|fatig|agujeta|cansad|muscle|\blegs?\b|tired|sore|fatigue)/.test(t)) {
        const c = ctx.cuerpo, z = c?.fisiologia?.zonas;
        if (!z) return { lang, texto: en ? 'There is no active route to estimate your fatigue.' : 'No hay una ruta activa para estimar tu fatiga.' };
        if (en) return { lang, texto: `Effort ${Math.round(z.corazon.pct)} percent of your capacity, lactate threshold about ${Math.round(z.corazon.lt)}. Legs: like climbing ${Math.round(z.muslos.subeM)} and descending ${Math.round(z.muslos.bajaM)} metres on Earth. Sweat ${num(z.agua.L, 1, 'en')} litres. Model estimate, not a medical assessment.` };
        return { lang, texto: `${c.consejo} Esfuerzo al ${Math.round(z.corazon.pct)} por ciento de tu capacidad, con el umbral de lactato hacia el ${Math.round(z.corazon.lt)}. Tus piernas llevan el equivalente a subir ${Math.round(z.muslos.subeM)} metros y bajar ${Math.round(z.muslos.bajaM)} en la Tierra. Es una estimación, no una evaluación médica.` };
    }
    if (/(ox[ií]geno|oxygen|o2|aire|\bair\b|bater|agua|water|traje|suit|consum|left)/.test(t)) {
        const tr = ctx.traje;
        if (!tr) return { lang, texto: en ? 'There is no active route: plan one so I can model your suit.' : 'No hay una ruta activa: planifícala para que pueda calcular tu traje.' };
        if (en) return { lang, texto: `Oxygen at ${Math.round(tr.o2Pct)} percent, battery at ${Math.round(tr.batPct)} percent, water at ${Math.round(tr.aguaPct)} percent, and a return margin of ${Math.round(tr.margenPct)} percent. These are planner model estimates.` };
        return { lang, texto: `${tr.momento[0].toUpperCase() + tr.momento.slice(1)}: oxígeno al ${Math.round(tr.o2Pct)} %, batería al ${Math.round(tr.batPct)} %, agua al ${Math.round(tr.aguaPct)} % y puedes alejarte ${tr.limiteTxt.replace(' · ', ', ')} antes de volver. Son estimaciones del modelo del planificador.` };
    }
    if (/(puedo|can i|make it|cansad|tired|esfuerzo|effort|cuerpo|body|energ|calor|kcal|salud|ruta|route)/.test(t)) {
        const c = ctx.cuerpo;
        if (!c?.disponible) return { lang, texto: en ? 'There is no active route to estimate your effort.' : 'No hay una ruta activa para estimar tu esfuerzo.' };
        if (!en) return { lang, texto: c.voz };
        const ver = { GO: 'go', 'PRECAUCIÓN': 'caution', 'NO-GO': 'no-go' }[c.veredictoRuta] || c.veredictoRuta;
        const niv = { asumible: 'manageable', exigente: 'demanding', demasiado: 'too demanding' }[c.nivel];
        return { lang, texto: `${c.nombreRuta ? `${c.nombreRuta} route: ` : ''}${ver ? `${ver}. ` : ''}It takes ${horasMin(c.duracionH, 'en')} over ${num(c.distanciaKm, 1, 'en')} kilometers. For your body it is ${niv}: average effort ${Math.round(c.mediaPct)} percent, about ${num(c.o2Kg, 2, 'en')} kilograms of oxygen. Model estimate, not a medical assessment.` };
    }
    if (/(d[oó]nde|where|siguiente|next|ir |hacia|camino|direcci|mirador)/.test(t) && !SALTOS_ENTRE_MIRADORES) {
        return { lang, texto: en ? `You have finished the route. You are at ${actual?.p?.nombreCorto || 'the main viewpoint'}: look around or ask me about the rock in front of you.`
            : `Has terminado la ruta. Estás en ${actual?.p?.nombreCorto || 'el mirador principal'}: mira alrededor o pregúntame por la roca que tienes delante.` };
    }
    if (/(d[oó]nde|siguiente|ir |hacia|camino|direcci|mirador)/.test(t)) {
        const otros = Object.entries(meta.miradores).filter(([k]) => k !== actual.id)
            .map(([, m]) => ({ m, ...rumboYDistancia(actual.p, m) })).sort((a, b) => a.d - b.d);
        if (!otros.length) return { lang, texto: 'No hay más miradores cerca.' };
        const o = otros[0], gi = ((o.rumbo - (visor.getYaw() + 360) % 360 + 540) % 360) - 180;
        return { lang, texto: `El mirador más cercano es ${o.m.nombreCorto}, a ${fmtM(o.d)} hacia el ${cardinal(o.rumbo)}: ${Math.abs(gi) < 15 ? 'lo tienes de frente' : `gira ${Math.round(Math.abs(gi))} grados a la ${gi > 0 ? 'derecha' : 'izquierda'}`}. Pulsa la flecha para ir.` };
    }
    return { lang, texto: en ? 'I only answer with verified app and NASA data. Ask me about the rock in front of you, your oxygen, or your route.'
        : 'Solo respondo con datos verificados de la app y de NASA. Pregúntame por la roca que tienes delante, tu oxígeno o tu ruta.' };
}

async function preguntar(q, { anotada = false } = {}) {
    if (ocupado) return;
    ocupado = true;
    try {
        if (!anotada) anotar('yo', q);
        estadoVoz('piensa');
        const ctx = { objeto: masCercano(35), cuerpo: window.marswalk?.cuerpo?.(), traje: window.marswalk?.traje?.(actual?.parada), parada: actual?.parada, mirador: actual?.id };
        const externo = window.marswalk?.jarvis?.responder;
        let r;
        try { r = externo ? await externo(q, ctx) : await responderLocal(q, ctx); }
        catch { r = await responderLocal(q, ctx); }
        await espera(MODO_DEMO ? 650 : 250);
        await decir(r.texto, { lang: r.lang || idiomaDe(q), audio: r.audio || null });
    } finally {
        ocupado = false;
    }
}

// ───────────────────────── Jarvis: palabra de activación y demo ─────────────────────────

const RE_DESPERTAR = /^(.*?\b)?(hey|hi|ok|okay|oye|hola|eh)?[\s,]*j[ae]r?vis\b[\s,.!?:;-]*(.*)$/i;

/** Frase hablada (real o simulada) → si lleva «Hey Jarvis», responde a lo que sigue; si solo despierta, escucha. */
async function procesarFrase(frase) {
    const m = frase.match(RE_DESPERTAR);
    if (!m) return false;
    const resto = m[3].trim();
    if (!resto) {
        const g = await cargarGuion();
        const lang = idiomaDe(frase) === 'en' || IDIOMA_DEMO === 'en' ? 'en' : 'es';
        await decir(g?.despertar?.[lang] || (lang === 'en' ? 'Yes?' : '¿Sí?'), { lang });
        esperandoPregunta = Date.now();
        estadoVoz('escucha');
        return true;
    }
    anotar('yo', frase.trim());
    await preguntar(resto, { anotada: true });
    return true;
}

function atajo(k) {
    const def = { j: { es: 'Hey Jarvis, ¿qué roca es esta?', en: 'Hey Jarvis, what is this rock?' } };
    return (guionCache?.atajos?.[k] || def[k] || def.j)[IDIOMA_DEMO];
}
let guionCache = null;
if (MODO_DEMO) cargarGuion().then(g => { guionCache = g; });

/** Simula que el presentador lo ha dicho en voz alta: escucha, transcribe en vivo y responde. */
async function simular(frase) {
    if (ocupado || !frase) return;
    ocupado = true;
    try {
        try { window.speechSynthesis?.cancel(); } catch { /* */ }
        const el = document.getElementById('mw-pano');
        el.classList.add('subtitulos');
        estadoVoz('escucha');
        await espera(450);
        const sub = $p('#mw-voz-texto');
        sub.classList.add('usuario');
        await transcribir(frase, null, sub);
        await espera(500);
        sub.classList.remove('usuario');
    } finally {
        ocupado = false;
    }
    await procesarFrase(frase);
}

let escuchaContinua = false;
let reconocedor = null;
let esperandoPregunta = 0;

function crearReconocedor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const rec = new SR();
    rec.lang = IDIOMA_DEMO === 'en' ? 'en-US' : 'es-ES';
    rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onresult = e => {
        if (ocupado) return;
        const r = e.results[e.results.length - 1];
        const txt = r[0].transcript.trim();
        const despierto = RE_DESPERTAR.test(txt) || Date.now() - esperandoPregunta < 8000;
        if (!despierto) return;
        const sub = $p('#mw-voz-texto');
        document.getElementById('mw-pano')?.classList.add('subtitulos');
        if (!r.isFinal) { estadoVoz('escucha'); sub.textContent = `“${txt}”`; sub.classList.add('usuario'); return; }
        sub.classList.remove('usuario');
        if (Date.now() - esperandoPregunta < 8000 && !RE_DESPERTAR.test(txt)) { esperandoPregunta = 0; preguntar(txt); return; }
        esperandoPregunta = 0;
        procesarFrase(txt);
    };
    rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') {
            escuchaContinua = false;
            $p('#mw-jarvis-mic')?.classList.remove('activo');
            estadoVoz('reposo', e.error === 'network' ? 'Sin red para el reconocimiento de voz · usa J o 1-4' : 'Micrófono bloqueado · usa J o 1-4');
        }
    };
    rec.onend = () => { if (escuchaContinua) { try { rec.start(); } catch { /* ya activo */ } } };
    return rec;
}

/** Modo demo: activa o desactiva la escucha continua de «Hey Jarvis». */
function alternarEscucha() {
    reconocedor = reconocedor || crearReconocedor();
    if (!reconocedor) { estadoVoz('reposo', 'Este navegador no reconoce voz · usa J o 1-4'); return; }
    escuchaContinua = !escuchaContinua;
    $p('#mw-jarvis-mic')?.classList.toggle('activo', escuchaContinua);
    try { escuchaContinua ? reconocedor.start() : reconocedor.stop(); } catch { /* */ }
    estadoVoz('reposo');
}

/** Fuera de la demo: el micrófono escucha una sola pregunta. */
function escucharUnaVez() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { estadoVoz('reposo', 'Este navegador no reconoce voz: escribe la pregunta.'); return; }
    const rec = new SR();
    rec.lang = 'es-ES'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onstart = () => { estadoVoz('escucha'); $p('#mw-jarvis-mic')?.classList.add('activo'); };
    rec.onend = () => { $p('#mw-jarvis-mic')?.classList.remove('activo'); if (!ocupado) estadoVoz('reposo'); };
    rec.onresult = e => { const txt = e.results[0][0].transcript; RE_DESPERTAR.test(txt) ? procesarFrase(txt) : preguntar(txt); };
    rec.onerror = () => estadoVoz('reposo', 'No te he oído bien: escribe la pregunta.');
    rec.start();
}

let cierreT = null;
export function cerrarPanorama() {
    const el = document.getElementById('mw-pano');
    if (!el?.classList.contains('visible')) return;
    // Si se cierra con J aún pulsada, se abandona la escucha sin responder.
    if (escucha) { clearTimeout(escucha.seguro); escucha = null; ocupado = false; estadoVoz('reposo'); }
    soltarPendiente = false;
    // Fundido de salida: primero se retiran los paneles de cristal (su desenfoque es lo caro de componer) y la foto
    // se funde con lo que hay debajo, que ya se está recolocando (alCerrar se llama en el fotograma siguiente).
    el.classList.add('cerrando');
    el.style.transition = 'opacity .55s cubic-bezier(.4, 0, .2, 1)';
    el.style.opacity = '0';
    clearTimeout(cierreT);
    clearInterval(reloj);
    try { window.speechSynthesis?.cancel(); audioActual?.pause(); } catch { /* */ }
    finHabla?.();
    if (escuchaContinua) alternarEscucha();
    el.classList.remove('subtitulos');
    pararVuelo();
    cancelAnimationFrame(guardia); guardia = null;
    const v = visor;
    visor = null;
    actual = null;
    cierreT = setTimeout(() => { el.classList.remove('visible', 'cerrando'); v?.destroy(); }, 580);   // tras el fundido
    const f = alCerrarActual; alCerrarActual = null;
    if (f) requestAnimationFrame(() => f());
}

// Demo: P abre directamente la vista 360° del mirador principal (sin recorrer la ruta).
if (MODO_DEMO) {
    document.addEventListener('keydown', e => {
        if (e.key.toLowerCase() !== 'p' || e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey) return;
        if (document.getElementById('mw-pano')?.classList.contains('visible')) return;
        abrirPrincipal({ parada: MIRADOR_PRINCIPAL });
    });
}
