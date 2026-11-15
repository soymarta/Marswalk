/**
 * @module astronauta
 * @author Hamza
 * @description Modo astronauta: vista en primera persona durante la navegación y visor tipo casco (HUD)
 * con las siguientes indicaciones de ruta y el estado del traje.
 *
 * Se apoya en la navegación de ruta.js: este módulo solo coloca la cámara a la altura de los ojos y pinta el
 * visor con los datos que ruta.js ya calcula en cada paso (maniobra, consumibles, rumbo, pendiente...).
 */

/**
 * Cámara. MapLibre trabaja con metros terrestres: en este mapa de Marte un metro horizontal real ocupa 1,88 m de
 * mapa (radio de la Tierra / radio de Marte), así que las alturas se multiplican por ese factor para que la
 * proporción entre la altura de los ojos y el paisaje sea la correcta.
 */
export const ESCALA_MAPA = 6371008.8 / 3396190;
export const CAMARA = {
    alturaOjos: 4,       // m sobre el suelo; ajustable con el control «Altura» (2 m ≈ ojos de un astronauta de pie)
    alturaMin: 1.5, alturaMax: 12,
    cabeceo: 85,         // grados desde la vertical: 85° deja el horizonte (delta y borde del cráter) en el centro de la vista
    zoomMax: 24, cabeceoMax: 88,
};

/** Altura de la cámara sobre el suelo, recordada entre sesiones. */
export function leerAltura() {
    try { const v = parseFloat(localStorage.getItem('marswalk.alturaAstronauta')); if (v >= CAMARA.alturaMin && v <= CAMARA.alturaMax) CAMARA.alturaOjos = v; } catch { /* sin almacenamiento */ }
    return CAMARA.alturaOjos;
}
export function ponerAltura(v) {
    CAMARA.alturaOjos = Math.max(CAMARA.alturaMin, Math.min(CAMARA.alturaMax, +v || CAMARA.alturaOjos));
    try { localStorage.setItem('marswalk.alturaAstronauta', String(CAMARA.alturaOjos)); } catch { /* sin almacenamiento */ }
    return CAMARA.alturaOjos;
}

let sueloPrevio = null;

/**
 * Control de mirada interactiva 360° en modo astronauta (deslizar para girar/inclinar, rueda para zoom).
 */
export const mirada = {
    yaw: 0,        // grados de rotación horizontal (360° continuo)
    pitch: 0,      // grados de inclinación vertical (-25° arriba a +25° abajo)
    zoomOffset: 0  // multiplicador de zoom (-4 a +5)
};

let ultimaLon = null, ultimaLat = null, ultimoRumbo = 0, mapaRef = null;

export function actualizarVisorRumbo() {
    const rumboEfectivo = (((ultimoRumbo + mirada.yaw) % 360) + 360) % 360;
    const cinta = $('astro-cinta');
    if (cinta) cinta.style.transform = `translateX(${-rumboEfectivo * PX_GRADO}px)`;
    const txt = $('astro-rumbo');
    if (txt) txt.textContent = `${String(Math.round(rumboEfectivo) % 360).padStart(3, '0')}°`;
}

/** Rumbo de marcha para la cinta del visor cuando la cámara la lleva el mundo 3D (js/ruta/mundo3d.js) y no MapLibre. */
export function fijarRumboVisor(rumbo) { ultimoRumbo = rumbo; mapaRef = null; actualizarVisorRumbo(); }

/** Coloca la cámara en la posición del caminante, a la altura de los ojos y mirando en el rumbo de marcha + 360° interactivo. */
export function camaraAstronauta(map, lon, lat, rumbo) {
    mapaRef = map;
    ultimaLon = lon;
    ultimaLat = lat;
    ultimoRumbo = rumbo;

    let suelo = 0;
    if (map.getTerrain()) {
        // Mientras carga el terreno MapLibre devuelve null o 0: se conserva la última lectura válida.
        const e = map.queryTerrainElevation([lon, lat]);
        if (e != null && e !== 0 && Number.isFinite(e)) sueloPrevio = e;
        suelo = sueloPrevio ?? map.getCenterElevation?.() ?? 0;
    } else sueloPrevio = null;
    const exag = map.getTerrain()?.exaggeration ?? 1;
    const altura = suelo + CAMARA.alturaOjos * ESCALA_MAPA * Math.max(1, exag);
    const pos = new maplibregl.LngLat(lon, lat);

    // Rumbo y cabeceo efectivos considerando el control 360° interactivo del usuario:
    const rumboEfectivo = (((rumbo + mirada.yaw) % 360) + 360) % 360;
    const cabeceoEfectivo = Math.max(50, Math.min(88, CAMARA.cabeceo + mirada.pitch));

    // Focalizamos la cámara a una distancia controlada para mantener las teselas de alta resolución y horizonte nítidos:
    const d = Math.max(15, Math.min(60, (altura - suelo) * Math.tan(cabeceoEfectivo * Math.PI / 180)));
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = d * Math.cos(rumboEfectivo * rad) / R / rad, dLon = d * Math.sin(rumboEfectivo * rad) / (R * Math.cos(lat * rad)) / rad;
    const destinoSuelo = map.getTerrain() ? (map.queryTerrainElevation([lon + dLon, lat + dLat]) ?? suelo) : suelo;
    let cam;
    if (map.calculateCameraOptionsFromTo) {
        cam = map.calculateCameraOptionsFromTo(pos, altura, new maplibregl.LngLat(lon + dLon, lat + dLat), destinoSuelo);
    } else if (map.calculateCameraOptionsFromCameraLngLatAltRotation) {
        cam = map.calculateCameraOptionsFromCameraLngLatAltRotation(pos, altura, rumboEfectivo, cabeceoEfectivo);
    }
    if (cam) {
        const zoomFinal = Math.max(12, Math.min(23, (cam.zoom || 17) + mirada.zoomOffset));
        // roll: 0 explícito; MapLibre devuelve roll indefinido y jumpTo no lo admite.
        map.jumpTo({ ...cam, zoom: zoomFinal, bearing: rumboEfectivo, pitch: cabeceoEfectivo, roll: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    }
}

/** Ajusta los límites del mapa para la vista a ras de suelo y los devuelve a su valor al salir. */
export function limitesAstronauta(map, activo, normales) {
    if (activo) { map.setMaxZoom(CAMARA.zoomMax); map.setMaxPitch(CAMARA.cabeceoMax); }
    else {
        sueloPrevio = null;
        mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
        if (map.getPitch() > normales.cabeceoMax) map.jumpTo({ pitch: normales.cabeceoMax });
        if (map.getZoom() > normales.zoomMax) map.jumpTo({ zoom: normales.zoomMax });
        map.setMaxPitch(normales.cabeceoMax); map.setMaxZoom(normales.zoomMax);
    }
}

// ───────────────────────── ortoimagen HiRISE ─────────────────────────

/**
 * Ortoimagen HiRISE (~0,6 m por píxel) sobre la CTX de 6 m, solo en la zona de la EVA y a partir de z14,5.
 * Sin ella el suelo se ve borroso desde la altura de los ojos. Las teselas las genera
 * python/generar_teselas_hirise.py; si no existen, el mapa sigue funcionando con la CTX.
 */
export async function anadirOrtoHirise(map) {
    if (map.getLayer('ruta-hirise')) return true;
    let meta;
    try {
        const r = await fetch('data/ruta/jezero_hirise.json', { cache: 'no-cache' });
        if (!r.ok) return false;
        meta = await r.json();
    } catch { return false; }
    map.addSource('jezero-hirise', { type: 'raster', tiles: [meta.url], tileSize: 256,
        minzoom: meta.zoom_min, maxzoom: meta.zoom_max, bounds: meta.bounds });
    // Justo encima de la CTX y debajo del sombreado del relieve, para que la luz del Sol siga aplicándose.
    const antes = ['ruta-relieve-ambiente', 'ruta-relieve', 'contour-lines'].find(id => map.getLayer(id));
    map.addLayer({ id: 'ruta-hirise', type: 'raster', source: 'jezero-hirise', minzoom: 14,
        paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 1], 'raster-fade-duration': 150 } }, antes);
    return meta;
}

// ───────────────────────── relieve de detalle (DTM HiRISE) ─────────────────────────

/**
 * Fuente de terreno `marsdem-hr`: igual que `marsdem` (CTX 20 m + MOLA) pero con el DTM HiRISE de 1 m en la zona
 * de la EVA (teselas z14-16 de python/generar_relieve_hirise.py). Fuera de esa zona, las teselas de z14-16 se
 * remuestrean del relieve general, así que no hay huecos ni escalones. Si las teselas no existen devuelve false
 * y el modo astronauta usa el relieve general.
 */
export async function registrarRelieveHirise(map, terreno3d) {
    if (map.getSource('marsdem-hr')) return true;
    let meta;
    try {
        const r = await fetch('data/ruta/jezero_relieve_hirise.json', { cache: 'no-cache' });
        if (!r.ok) return false;
        meta = await r.json();
    } catch { return false; }
    const { alturasMarsdem, alturasDeUrl, codificarAlturas, remuestrear } = terreno3d;
    const Z_GENERAL = 13, cache = new Map();
    const general = (x, y, signal) => {  // alturas de la tesela z13 del relieve general, con caché
        const k = `${x}/${y}`;
        if (!cache.has(k)) {
            cache.set(k, alturasMarsdem(Z_GENERAL, x, y, signal));
            if (cache.size > 24) cache.delete(cache.keys().next().value);
        }
        return cache.get(k).catch(e => { cache.delete(k); throw e; });
    };
    maplibregl.addProtocol('marsdemhr', async (params, abort) => {
        const [z, x, y] = params.url.replace('marsdemhr://', '').split('/').map(Number);
        const r = meta.rangos[z];
        if (r && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) {
            try {
                return { data: await codificarAlturas(await alturasDeUrl(meta.url.replace('{z}', z).replace('{x}', x).replace('{y}', y), abort.signal)) };
            } catch (e) { if (abort.signal.aborted) throw e; }
        }
        if (z <= Z_GENERAL) return { data: await codificarAlturas(await alturasMarsdem(z, x, y, abort.signal)) };
        const f = 2 ** (z - Z_GENERAL), ax = Math.floor(x / f), ay = Math.floor(y / f);
        return { data: await codificarAlturas(remuestrear(await general(ax, ay, abort.signal), f, x - ax * f, y - ay * f)) };
    });
    map.addSource('marsdem-hr', { type: 'raster-dem', tiles: ['marsdemhr://{z}/{x}/{y}'], tileSize: 256, encoding: 'mapbox', maxzoom: meta.zoom_max });
    // Sombreado del relieve de detalle; solo se muestra con el modo astronauta (ver ponerAstronauta en ruta.js).
    const antes = ['ruta-relieve', 'contour-lines'].find(id => map.getLayer(id));
    map.addLayer({ id: 'astro-relieve', type: 'hillshade', source: 'marsdem-hr', minzoom: 14, layout: { visibility: 'none' },
        paint: { 'hillshade-exaggeration': 0.85, 'hillshade-shadow-color': '#0e0402', 'hillshade-highlight-color': '#fff4e2',
            'hillshade-accent-color': '#3a1b0d', 'hillshade-illumination-anchor': 'map' } }, antes);
    return meta;
}

// ───────────────────────── detalle cercano sintético ─────────────────────────

/**
 * Textura de detalle del suelo (grava y piedras pequeñas) para los primeros metros delante del astronauta.
 * NO SON DATOS: la ortoimagen llega a ~0,6 m por píxel y de cerca se ve lisa, así que se superpone una textura
 * generada por ordenador, repetida, solo en el modo astronauta y solo a ras de suelo. El visor lo indica.
 * No interviene en la ruta ni en ninguna capa de datos.
 */
function aleatorio(semilla) {  // mulberry32: mismo resultado en todos los equipos
    let a = semilla >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
async function texturaSuelo(semilla) {
    const N = 256, c = new OffscreenCanvas(N, N), g = c.getContext('2d'), r = aleatorio(semilla);
    // Cada forma se dibuja también desplazada ±N para que la tesela case con sus vecinas sin costuras.
    const repetir = (x, y, radio, dibujar) => {
        for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
            if (x + dx < -radio || x + dx > N + radio || y + dy < -radio || y + dy > N + radio) continue;
            g.save(); g.translate(x + dx, y + dy); dibujar(); g.restore();
        }
    };
    // Grano fino
    for (let i = 0; i < 2600; i++) {
        const x = r() * N, y = r() * N, claro = r() < 0.45, a = 0.07 + r() * 0.16;
        g.fillStyle = claro ? `rgba(255,236,208,${a})` : `rgba(38,20,10,${a})`;
        g.fillRect(x, y, 1 + (r() < 0.2), 1);
    }
    const piedra = (x, y, radio) => {
        const n = 6 + Math.floor(r() * 4), giro = r() * Math.PI, achat = 0.6 + r() * 0.4;
        const pts = Array.from({ length: n }, (_, i) => { const ang = i / n * 2 * Math.PI, rr = radio * (0.72 + r() * 0.4); return [Math.cos(ang) * rr, Math.sin(ang) * rr * achat]; });
        const oscura = r() < 0.6, tono = oscura ? [58 + r() * 30, 38 + r() * 18, 28 + r() * 12] : [168 + r() * 40, 122 + r() * 30, 86 + r() * 24];
        const trazo = () => { g.beginPath(); pts.forEach(([px, py], i) => i ? g.lineTo(px, py) : g.moveTo(px, py)); g.closePath(); };
        repetir(x, y, radio * 2.2, () => {
            g.rotate(giro);
            g.save(); g.rotate(-giro); g.translate(radio * 0.45, radio * 0.4); g.rotate(giro);   // sombra arrojada
            g.fillStyle = `rgba(20,10,5,${radio > 3 ? 0.42 : 0.3})`; trazo(); g.fill(); g.restore();
            g.fillStyle = `rgba(${tono.map(Math.round).join(',')},${radio > 3 ? 0.9 : 0.7})`; trazo(); g.fill();
            g.save(); trazo(); g.clip();                                                         // cara iluminada
            g.rotate(-giro); g.fillStyle = 'rgba(255,238,214,0.28)'; g.fillRect(-radio * 2, -radio * 2, radio * 2.2, radio * 2.1); g.restore();
        });
    };
    for (let i = 0; i < 160; i++) piedra(r() * N, r() * N, 0.8 + r() * 2.2);   // grava: 6-22 cm
    for (let i = 0; i < 10; i++) piedra(r() * N, r() * N, 3.5 + r() * 5.0);    // piedras medianas: 30-70 cm
    for (let i = 0; i < 3; i++) piedra(r() * N, r() * N, 9 + r() * 10);        // rocas destacadas: 1-2 m con sombras profundas
    return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

export function anadirDetalleSintetico(map) {
    if (map.getSource('astro-detalle')) return;
    const variantes = [11, 23, 37, 51].map(texturaSuelo);
    maplibregl.addProtocol('marsdetalle', async params => {
        const [, x, y] = params.url.replace('marsdetalle://', '').split('/').map(Number);
        return { data: (await variantes[(x * 7 + y * 13) & 3]).slice(0) };
    });
    // Teselas de z19-20 (38 y 19 m de lado): solo cargan cerca de la cámara, lejos manda la ortoimagen real.
    map.addSource('astro-detalle', { type: 'raster', tiles: ['marsdetalle://{z}/{x}/{y}'], tileSize: 256, minzoom: 19, maxzoom: 20 });
    const antes = ['astro-relieve', 'ruta-relieve-ambiente', 'ruta-relieve', 'contour-lines'].find(id => map.getLayer(id));
    map.addLayer({ id: 'astro-detalle', type: 'raster', source: 'astro-detalle', minzoom: 17.5, layout: { visibility: 'none' },
        paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 17.8, 0, 18.8, 0.9], 'raster-fade-duration': 0 } }, antes);
}

// ───────────────────────── visor ─────────────────────────

const $ = id => document.getElementById(id);
const RUMBOS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

export function construirVisor() {
    if ($('astro-visor')) return;
    document.body.insertAdjacentHTML('beforeend', `
<div class="astro-visor" id="astro-visor" aria-hidden="true">
  <div class="astro-cristal"></div>
  <div class="astro-brujula"><div class="cinta" id="astro-cinta"></div><i></i><b id="astro-rumbo">—</b></div>
  <div class="astro-maniobra" id="astro-maniobra">
    <div class="ico" id="astro-ico"></div>
    <div><div class="dist" id="astro-dist">—</div><div class="txt" id="astro-txt"></div></div>
  </div>
  <div class="astro-lado izq">
    <div class="astro-barra" id="astro-o2"><span>O₂</span><div><i></i></div><b>—</b></div>
    <div class="astro-barra" id="astro-bat"><span>Batería</span><div><i></i></div><b>—</b></div>
    <div class="astro-barra" id="astro-margen"><span>Límite de vuelta</span><div><i></i></div><b>—</b></div>
  </div>
  <div class="astro-lado der">
    <div class="astro-dato"><span>Hora local</span><b id="astro-hora">—</b></div>
    <div class="astro-dato"><span>Llegada a la base</span><b id="astro-eta">—</b></div>
    <div class="astro-dato"><span>Pendiente</span><b id="astro-pend">—</b></div>
    <div class="astro-dato"><span>Siguiente parada</span><b id="astro-parada">—</b></div>
  </div>
  <div class="astro-alertas" id="astro-alertas"></div>
  <button class="astro-btn-centrar" id="astro-btn-centrar" type="button" title="Centrar mirada al frente (o doble clic)">Mirar al frente</button>
  <div class="astro-pista" id="astro-pista">Desliza para mirar 360° · Rueda para zoom · Doble clic para centrar</div>
</div>`);
    // Cinta de rumbo: marcas cada 15° y letras en los puntos cardinales, repetida para que no tenga extremos.
    let marcas = '';
    for (let g = -360; g <= 720; g += 15) {
        const n = ((g % 360) + 360) % 360;
        marcas += `<span style="left:${g * PX_GRADO}px" class="${n % 45 === 0 ? 'card' : ''}">${n % 45 === 0 ? RUMBOS[n / 45] : n}</span>`;
    }
    $('astro-cinta').innerHTML = marcas;

    // Control táctil y de ratón: arrastrar en cualquier dirección para girar 360° o inclinar, rueda para zoom
    const visor = $('astro-visor');
    let arrastrando = false, inicioX = 0, inicioY = 0;
    const refrescar = () => {
        if (mapaRef && ultimaLon != null) camaraAstronauta(mapaRef, ultimaLon, ultimaLat, ultimoRumbo);
        actualizarVisorRumbo();   // con el mundo 3D la cámara lee `mirada` en cada fotograma: solo hay que mover la cinta
    };
    visor.addEventListener('pointerdown', e => {
        if (e.target.closest('button, a, input')) return;
        arrastrando = true;
        inicioX = e.clientX;
        inicioY = e.clientY;
        visor.setPointerCapture(e.pointerId);
        visor.classList.add('arrastrando');
    });
    visor.addEventListener('pointermove', e => {
        if (!arrastrando) return;
        const dx = e.clientX - inicioX;
        const dy = e.clientY - inicioY;
        inicioX = e.clientX;
        inicioY = e.clientY;
        mirada.yaw = (mirada.yaw + dx * 0.35 + 360) % 360;
        mirada.pitch = Math.max(mapaRef ? -28 : -60, Math.min(mapaRef ? 28 : 55, mirada.pitch - dy * 0.25));
        refrescar();
    });
    const terminarArrastre = e => {
        if (!arrastrando) return;
        arrastrando = false;
        visor.classList.remove('arrastrando');
        try { visor.releasePointerCapture(e.pointerId); } catch {}
    };
    visor.addEventListener('pointerup', terminarArrastre);
    visor.addEventListener('pointercancel', terminarArrastre);
    visor.addEventListener('wheel', e => {
        e.preventDefault();
        mirada.zoomOffset = Math.max(-4, Math.min(6, mirada.zoomOffset - e.deltaY * 0.003));
        refrescar();
    }, { passive: false });
    visor.addEventListener('dblclick', e => {
        if (e.target.closest('button')) return;
        mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
        refrescar();
    });
    $('astro-btn-centrar')?.addEventListener('click', e => {
        e.stopPropagation();
        mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0;
        refrescar();
    });
}
const PX_GRADO = 4;

function barra(id, fraccion, mal, critico, texto) {
    const el = $(id), v = Math.max(0, Math.min(1, fraccion));
    el.querySelector('i').style.width = `${v * 100}%`;
    el.querySelector('b').textContent = texto ?? `${Math.round(v * 100)} %`;
    el.classList.toggle('mal', !!mal); el.classList.toggle('critico', !!critico);
}

/**
 * Pinta el visor.
 * @param {object} d rumbo (°), icono (HTML), dist, texto, o2/bat/margen (fracción restante 0-1), reservaO2,
 *   hora, eta, pendiente (°), pendienteMax (°), parada, alertas ([{texto, critico}]), emergencia (bool)
 */
export function actualizarVisor(d) {
    const visor = $('astro-visor');
    if (!visor) return;
    visor.classList.toggle('emergencia', !!d.emergencia);
    const rumboEfectivo = (((d.rumbo + mirada.yaw) % 360) + 360) % 360;
    $('astro-cinta').style.transform = `translateX(${-rumboEfectivo * PX_GRADO}px)`;
    $('astro-rumbo').textContent = `${String(Math.round(rumboEfectivo) % 360).padStart(3, '0')}°`;
    if (visor.dataset.ico !== String(d.claveIcono)) { visor.dataset.ico = String(d.claveIcono); $('astro-ico').innerHTML = d.icono || ''; }
    $('astro-dist').textContent = d.dist || '—';
    $('astro-txt').textContent = d.texto || '';
    barra('astro-o2', d.o2, d.o2 < d.reservaO2 + 0.1, d.o2 < d.reservaO2);
    barra('astro-bat', d.bat, d.bat < 0.3, d.bat < 0.15);
    barra('astro-margen', d.margen, d.margen < 0.15, d.margen < 0.05, d.limiteTxt);
    $('astro-hora').textContent = d.hora;
    $('astro-eta').textContent = d.eta;
    const pend = $('astro-pend');
    pend.textContent = `${Math.round(d.pendiente)}°`;
    pend.classList.toggle('mal', d.pendiente > d.pendienteMax * 0.8);
    $('astro-parada').textContent = d.parada || 'Base';
    const html = (d.alertas || []).map(a => `<span class="${a.critico ? 'critico' : ''}">${a.texto}</span>`).join('');
    if (visor.dataset.alertas !== html) { visor.dataset.alertas = html; $('astro-alertas').innerHTML = html; }
}
