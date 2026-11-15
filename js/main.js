import { initAmbientalModule } from './ambiental.js';
import { initRutaModule } from './ruta/ruta.js';
import { initEspacio } from './espacio.js';

// Estado global compartido para topografía
let lastCursor = null; // En caso de que la topografía necesite actualizar algo, aunque ahora lo maneja el módulo ambiental
let savedMercatorView = null;

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: {},
        layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#0a0a1a' } }
        ]
    },
    center: [0, 0], zoom: 2, minZoom: 1, maxZoom: 6,
    attributionControl: false,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0
});

window.map = map; // Exponerlo globalmente para el módulo ambiental

// Base color raster, in order of preference:
//   1. tiles/viking_xyz           → Viking MDIM 2.1 colorized 232 m (make viking-tiles)
//   2. data/viking_prototype/...  → same mosaic at 1 km, for evaluating the look
//                                   without the 12 GB download (make viking-prototype)
//   3. tiles/color_xyz            → MOLA color-relief (current fallback)
// First candidate whose z0 tile answers is used, so the demo never breaks.
const COLOR_TILESETS = [
    { dir: 'tiles/viking_xyz', maxzoom: 7, label: 'Viking MDIM 2.1 232m — color real' },
    { dir: 'data/viking_prototype/tiles/viking_1km_xyz', maxzoom: 6, label: 'Viking MDIM 2.1 1km — color real (prototipo)' },
    { dir: 'tiles/color_xyz', maxzoom: 6, label: 'MOLA DEM 463m — color topográfico' },
];

async function detectColorTileSet() {
    // Absolute base so tiles resolve both at the repo root and under a subpath.
    // Built by concatenation on purpose: new URL() would percent-encode {z}/{x}/{y}.
    const base = new URL('./', document.baseURI).href;
    for (const set of COLOR_TILESETS) {
        try {
            const r = await fetch(`${base}${set.dir}/0/0/0.png`, { method: 'HEAD' });
            if (r.ok) {
                return { ...set, url: `${base}${set.dir}/{z}/{x}/{y}.png` };
            }
        } catch { /* try the next candidate */ }
    }
    const fallback = COLOR_TILESETS[COLOR_TILESETS.length - 1];
    return { ...fallback, url: `${base}${fallback.dir}/{z}/{x}/{y}.png` };
}

async function recodificarMolaParaMapbox(blob) {
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 256, 256);
    const imagen = ctx.getImageData(0, 0, 256, 256);
    for (let p = 0; p < imagen.data.length; p += 4) {
        const n = imagen.data[p] * 65536 + imagen.data[p + 1] * 256 + imagen.data[p + 2];
        const v = Math.max(0, Math.min(0xffffff, n - 20000));
        imagen.data[p] = (v >> 16) & 255;
        imagen.data[p + 1] = (v >> 8) & 255;
        imagen.data[p + 2] = v & 255;
    }
    ctx.putImageData(imagen, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
}

const demSource = new mlcontour.DemSource({
    url: 'tiles/marte_xyz/{z}/{x}/{y}.png',
    encoding: 'mapbox', maxzoom: 6, worker: false,
    cacheSize: 100, timeoutMs: 20000,
});
demSource.manager.getTile = async (url, abortController) => {
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return { data: await recodificarMolaParaMapbox(await response.blob()) };
};
demSource.setupMaplibre(maplibregl);

const puntosInteres = [
    { name: 'Olympus Mons',       coords: [-133.80, 18.65], desc: 'Volcán más alto del sistema solar (21.9 km)' },
    { name: 'Valles Marineris',   coords: [-59.00, -14.00], desc: 'Cañón de 4000 km de longitud' },
    { name: 'Hellas Planitia',    coords: [70.50, -42.40],  desc: 'Cuenca de impacto, ~7 km de profundidad' },
    { name: 'Gale Crater',        coords: [137.80, -5.40],  desc: 'Lugar de aterrizaje del rover Curiosity' },
    { name: 'Jezero Crater',      coords: [77.58, 18.38],   desc: 'Lugar de aterrizaje del rover Perseverance' },
    { name: 'Elysium Mons',       coords: [147.21, 25.02],  desc: 'Volcán en la región de Elysium' },
    { name: 'Ascraeus Mons',      coords: [-104.50, 11.80], desc: 'Volcán del grupo Tharsis Montes' },
    { name: 'Pavonis Mons',       coords: [-112.96, 1.48],  desc: 'Volcán del grupo Tharsis Montes' },
    { name: 'Arsia Mons',         coords: [-119.50, -8.35], desc: 'Volcán del grupo Tharsis Montes' },
    { name: 'Syrtis Major',       coords: [69.50, 8.40],    desc: 'Altiplano oscuro, antigua región volcánica' },
    { name: 'Utopia Planitia',    coords: [117.50, 46.70],  desc: 'Gran llanura del hemisferio norte' },
    { name: 'Vastitas Borealis',  coords: [0.00, 70.00],    desc: 'Llanura polar norte' },
    { name: 'Chryse Planitia',    coords: [-40.00, 28.00],  desc: 'Llanura de aterrizaje del Viking 1' },
    { name: 'Isidis Planitia',    coords: [87.50, 13.00],   desc: 'Cuenca de impacto en el hemisferio norte' },
    { name: 'Amazonis Planitia',  coords: [-160.00, 25.00], desc: 'Llanura joven del hemisferio norte' },
];

map.on('load', async () => {
    // Lógica para minimizar el panel de capas
    document.getElementById('controls-toggle').addEventListener('click', () => {
        const panel = document.getElementById('controls-panel');
        panel.classList.toggle('collapsed');
        document.getElementById('controls-icon').textContent = panel.classList.contains('collapsed') ? '▼' : '▲';
    });
    
    // 1. Topografía base — Viking color mosaic si disponible, MOLA color en caso contrario
    const colorSet = await detectColorTileSet();
    console.info(`[main] capa de color: ${colorSet.label} → ${colorSet.url}`);
    // Estado público para el módulo ambiental: la leyenda de elevación solo tiene
    // sentido cuando el color base ES el MOLA coloreado por altura.
    window.marsBaseColor = {
        label: colorSet.label,
        isElevation: colorSet.dir === 'tiles/color_xyz'
    };
    const infoLabel = document.getElementById('info-color-layer');
    if (infoLabel) infoLabel.textContent = colorSet.label;
    const colorToggleLabel = document.getElementById('label-toggle-color');
    if (colorToggleLabel && !window.marsBaseColor.isElevation) colorToggleLabel.textContent = 'Color real (Viking)';
    map.addSource('color-tiles', {
        type: 'raster',
        tiles: [colorSet.url],
        tileSize: 256, maxzoom: colorSet.maxzoom
    });
    map.addLayer({
        id: 'color', type: 'raster', source: 'color-tiles',
        paint: { 'raster-opacity': 1 }
    });

    map.addSource('dem', {
        type: 'raster-dem', encoding: 'mapbox',
        tiles: [demSource.sharedDemProtocolUrl], maxzoom: 6, tileSize: 256
    });
    map.addLayer({
        id: 'hillshade', type: 'hillshade', source: 'dem',
        paint: {
            'hillshade-exaggeration': 0.55,
            'hillshade-shadow-color': '#000000',
            'hillshade-highlight-color': '#ffffff'
        }
    });

    map.addSource('contour-source', {
        type: 'vector',
        tiles: [demSource.contourProtocolUrl({
            thresholds: { 2: [5000, 20000], 3: [5000, 20000], 4: [2000, 10000], 5: [1000, 5000], 6: [500, 2000] },
            elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
        })],
        maxzoom: 6,
    });
    map.addLayer({
        id: 'contour-lines', type: 'line',
        source: 'contour-source', 'source-layer': 'contours',
        paint: {
            'line-color': 'rgba(255, 255, 255, 0.55)',
            'line-width': ['match', ['get', 'level'], 1, 1.2, 0.5]
        }
    });
    map.addLayer({
        id: 'contour-labels', type: 'symbol',
        source: 'contour-source', 'source-layer': 'contours',
        filter: ['>', ['get', 'level'], 0],
        layout: {
            'symbol-placement': 'line', 'text-size': 10,
            'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'],
            'text-font': ['Open Sans Bold']
        },
        paint: {
            'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5,
            'text-color': '#ffffff'
        }
    });

    // 2. Marcadores
    const markers = [];
    puntosInteres.forEach(poi => {
        const el = document.createElement('div');
        el.style.cssText = `
            width: 10px; height: 10px;
            background: #ff5533; border: 2px solid #ffffff;
            border-radius: 50%; cursor: pointer;
            box-shadow: 0 0 6px rgba(0,0,0,0.8);
        `;
        const popup = new maplibregl.Popup({ offset: 15, closeButton: true })
            .setHTML(`
                <div style="font-family: sans-serif; max-width: 220px;">
                    <strong style="font-size: 13px;">${poi.name}</strong><br>
                    <span style="font-size: 11px; color: #555;">${poi.desc}</span><br>
                    <span style="font-size: 10px; color: #888; font-family: monospace;">
                        ${poi.coords[1].toFixed(2)}°, ${poi.coords[0].toFixed(2)}°
                    </span>
                </div>
            `);
        const marker = new maplibregl.Marker({ element: el })
            .setLngLat(poi.coords).setPopup(popup);
        markers.push(marker);
    });

    // 3. Nomenclatura
    map.addSource('mars-nomenclature', {
        type: 'geojson', data: './data/mars_nomenclature.geojson'
    });
    map.addLayer({
        id: 'nomenclature-major', type: 'symbol', source: 'mars-nomenclature',
        minzoom: 3.4,   // ocultos mientras la barra de escala marca 1000 km (globo entero); salen al pasar a 500 km
        filter: ['any',
            ['in', 'Mons', ['get', 'type']], ['in', 'Planitia', ['get', 'type']],
            ['in', 'Planum', ['get', 'type']], ['in', 'Terra', ['get', 'type']],
            ['in', 'Chasma', ['get', 'type']], ['in', 'Vallis', ['get', 'type']],
            ['in', 'Tholus', ['get', 'type']], ['in', 'Patera', ['get', 'type']],
            ['in', 'Rupes', ['get', 'type']], ['in', 'Labyrinthus', ['get', 'type']],
            ['in', 'Chaos', ['get', 'type']]
        ],
        layout: {
            'text-field': ['get', 'name'], 'text-font': ['Open Sans Bold'],
            'text-anchor': 'center',
            'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 4, 13, 6, 16],
            'text-transform': 'uppercase', 'text-letter-spacing': 0.08,
            'text-allow-overlap': false, 'text-ignore-placement': false,
            'text-padding': 6
        },
        paint: {
            'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.9)',
            'text-halo-width': 1.6
        }
    });
    map.addLayer({
        id: 'nomenclature-craters-large', type: 'symbol', source: 'mars-nomenclature',
        minzoom: 4,
        filter: ['all', ['in', 'Crater', ['get', 'type']], ['>', ['get', 'diameter'], 80]],
        layout: {
            'text-field': ['get', 'name'], 'text-font': ['Open Sans Bold'],
            'text-anchor': 'center',
            'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 6, 14],
            'text-allow-overlap': false, 'text-padding': 5
        },
        paint: {
            'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.9)',
            'text-halo-width': 1.5
        }
    });
    map.addLayer({
        id: 'nomenclature-minor', type: 'symbol', source: 'mars-nomenclature',
        minzoom: 5,
        filter: ['all', ['<=', ['get', 'diameter'], 80]],
        layout: {
            'text-field': ['get', 'name'], 'text-font': ['Open Sans Bold'],
            'text-anchor': 'center',
            'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 6, 12],
            'text-allow-overlap': false, 'text-padding': 4
        },
        paint: {
            'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.9)',
            'text-halo-width': 1.4
        }
    });

    // 4. Controles
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');

    // 5. Vista global de Marte
    const globeToggle = document.getElementById('toggle-globe');
    const spaceBackground = document.getElementById('space-background');
    let lastSpaceCenter = null;
    let lastSpaceBearing = 0;
    let spaceRotation = 0;
    let spaceTilt = 0;
    // Estrellas, estrellas fugaces, cometa y asteroides sobre el fondo de nebulosas (js/espacio.js)
    const espacio = initEspacio(spaceBackground);
    const getGlobeFitZoom = () => {
        const { width, height } = map.getContainer().getBoundingClientRect();
        return Math.max(-2, Math.log2(Math.min(width, height) * 1.1 * Math.PI / 512));
    };
    const getAngleDelta = (current, previous) => {
        let delta = current - previous;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        return delta;
    };
    const updateSpaceBackground = () => {
        if (!lastSpaceCenter) return;

        const center = map.getCenter();
        const { height } = map.getContainer().getBoundingClientRect();
        spaceRotation += getAngleDelta(center.lng, lastSpaceCenter.lng);
        spaceRotation -= getAngleDelta(map.getBearing(), lastSpaceBearing);
        spaceTilt += center.lat - lastSpaceCenter.lat;
        lastSpaceCenter = { lng: center.lng, lat: center.lat };
        lastSpaceBearing = map.getBearing();
        spaceBackground.style.transform =
            `rotate(${-spaceRotation}deg) translate3d(0, ${-spaceTilt * height / 180}px, 0) scale(1.05)`;
        espacio.mover(spaceRotation, spaceTilt);
    };

    map.on('move', updateSpaceBackground);

    // Efecto de planeta en la vista de globo: halo de atmósfera polvorienta por detrás y, por delante, luz del Sol,
    // lado nocturno y oscurecimiento del limbo. Sin él, el globo se ve como un disco plano recortado.
    const globoAtmosfera = document.createElement('div'); globoAtmosfera.id = 'globe-atmo'; globoAtmosfera.setAttribute('aria-hidden', 'true');
    const globoLuz = document.createElement('div'); globoLuz.id = 'globe-luz'; globoLuz.setAttribute('aria-hidden', 'true');
    spaceBackground.after(globoAtmosfera);
    map.getContainer().after(globoLuz);
    const updateGlobeEffect = () => {
        const activo = map.getProjection?.()?.type === 'globe' || globeToggle.checked;
        globoAtmosfera.classList.toggle('visible', activo); globoLuz.classList.toggle('visible', activo);
        if (!activo) return;
        const { width, height } = map.getContainer().getBoundingClientRect();
        // Radio del globo en pantalla: MapLibre conserva la escala Mercator en la latitud del centro.
        // y la cámara lo mira en perspectiva, a `d` píxeles de su superficie: su silueta mide r = d·R / √(d² + 2dR).
        const R = 512 * Math.pow(2, map.getZoom()) / (2 * Math.PI) / Math.cos(map.getCenter().lat * Math.PI / 180);
        const d = map.transform?.cameraToCenterDistance || height * 1.5;
        const r = d * R / Math.sqrt(d * d + 2 * d * R);
        // Al acercarse (el planeta ya no cabe en pantalla) el efecto se desvanece: de cerca es un mapa.
        const o = Math.max(0, Math.min(1, (1.25 - r / Math.min(width, height)) / 0.5));
        for (const el of [globoAtmosfera, globoLuz]) { el.style.setProperty('--r', `${r.toFixed(1)}px`); el.style.opacity = o.toFixed(3); }
    };
    map.on('move', updateGlobeEffect);
    map.on('resize', updateGlobeEffect);

    // Cámara flotando: con el globo entero en pantalla, la vista se mece arriba-abajo y a los lados y Marte gira despacio.
    // Se detiene al acercarse, en el modo ruta / 3D, mientras el usuario lo arrastra y unos segundos después.
    const reducirMovimiento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const raiz = document.documentElement;
    let flotaAmp = 0, flotaFase = 0, flotaT0 = 0, giroPausaHasta = 0, flotaRaf = 0;
    const pausarGiro = () => { giroPausaHasta = performance.now() + 3500; };
    for (const ev of ['mousedown', 'touchstart', 'wheel']) map.getContainer().addEventListener(ev, pausarGiro, { passive: true });
    map.on('movestart', e => { if (e.originalEvent) pausarGiro(); });
    const globoEntero = () => {
        if (map.getProjection?.()?.type !== 'globe' || document.body.classList.contains('modo-ruta')
            || document.body.classList.contains('mundo3d') || document.hidden) return false;
        const { width, height } = map.getContainer().getBoundingClientRect();
        const R = 512 * Math.pow(2, map.getZoom()) / (2 * Math.PI) / Math.cos(map.getCenter().lat * Math.PI / 180);
        const d = map.transform?.cameraToCenterDistance || height * 1.5;
        return d * R / Math.sqrt(d * d + 2 * d * R) < Math.min(width, height) * 0.62;
    };
    const flotarGlobo = t => {
        const dt = flotaT0 ? Math.min(0.1, (t - flotaT0) / 1000) : 0;
        flotaT0 = t;
        const activo = globoEntero();
        flotaAmp += ((activo ? 1 : 0) - flotaAmp) * Math.min(1, dt * 2.5);   // entra y sale con suavidad
        flotaFase += dt;
        // La cámara es la que flota: arriba y abajo cada 6 s, a los lados cada 9,5 s (una curva que nunca se repite
        // igual). Las estrellas, lejanas, se mueven menos que el planeta: paralaje.
        const fy = Math.sin(flotaFase * 2 * Math.PI / 6) * 9 * flotaAmp;
        const fx = Math.sin(flotaFase * 2 * Math.PI / 9.5 + 1.1) * 12 * flotaAmp;
        raiz.style.setProperty('--flota', `${fy.toFixed(2)}px`);
        raiz.style.setProperty('--flota-x', `${fx.toFixed(2)}px`);
        if (activo && t > giroPausaHasta && !map.isMoving()) {
            const c = map.getCenter();
            map.jumpTo({ center: [c.lng + dt * 2.2 * flotaAmp, c.lat] });     // ~2° por segundo, hacia el este
        }
        if (activo || flotaAmp > 0.002) flotaRaf = requestAnimationFrame(flotarGlobo);
        else { flotaRaf = 0; flotaT0 = 0; flotaAmp = 0; raiz.style.setProperty('--flota', '0px'); raiz.style.setProperty('--flota-x', '0px'); }
    };
    const despertarFlota = () => { if (!flotaRaf && !reducirMovimiento && globoEntero()) flotaRaf = requestAnimationFrame(flotarGlobo); };
    map.on('moveend', despertarFlota);
    document.addEventListener('visibilitychange', despertarFlota);

    globeToggle.addEventListener('change', e => {
        if (e.target.checked) {
            const center = map.getCenter();
            savedMercatorView = {
                center: [center.lng, center.lat],
                zoom: map.getZoom(),
                bearing: map.getBearing(),
                pitch: map.getPitch()
            };
            const zoom = getGlobeFitZoom();
            map.setMinZoom(Math.min(1, zoom));
            map.setProjection({ type: 'globe' });
            map.setLayoutProperty('background', 'visibility', 'none');
            lastSpaceCenter = { lng: 0, lat: 0 };
            lastSpaceBearing = 0;
            spaceRotation = 0;
            spaceTilt = 0;
            spaceBackground.classList.add('visible');
            espacio.activar(true);
            map.jumpTo({ center: [0, 0], zoom, bearing: 0, pitch: 0 });
            updateSpaceBackground();
            updateGlobeEffect();
            pausarGiro(); despertarFlota();
        } else {
            map.setProjection({ type: 'mercator' });
            map.setMinZoom(1);
            map.setLayoutProperty('background', 'visibility', 'visible');
            spaceBackground.classList.remove('visible');
            espacio.activar(false);
            lastSpaceCenter = null;
            spaceRotation = 0;
            spaceTilt = 0;
            spaceBackground.style.transform = '';
            if (savedMercatorView) map.jumpTo(savedMercatorView);
            savedMercatorView = null;
            updateGlobeEffect();
        }
    });

    // El globo 3D es la vista por defecto (casilla marcada en el HTML).
    if (globeToggle.checked) globeToggle.dispatchEvent(new Event('change'));

    // 6. Toggles Topografía y Marcadores
    const toggle = (layerId, visible) => {
        if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
        }
    };
    
    document.getElementById('toggle-hillshade').addEventListener('change', e => toggle('hillshade', e.target.checked));
    document.getElementById('toggle-contours').addEventListener('change', e => toggle('contour-lines', e.target.checked));
    document.getElementById('toggle-labels').addEventListener('change', e => toggle('contour-labels', e.target.checked));
    document.getElementById('toggle-poi').addEventListener('change', e => {
        markers.forEach(m => { if (e.target.checked) m.addTo(map); else m.remove(); });
    });
    document.getElementById('toggle-names').addEventListener('change', e => {
        const v = e.target.checked;
        toggle('nomenclature-major', v);
        toggle('nomenclature-craters-large', v);
        toggle('nomenclature-minor', v);
    });

    // 7. Planificador de rutas EVA (Marswalk, módulo 5): no espera al módulo ambiental
    initRutaModule(map).catch(e => console.error('[ruta] no se pudo iniciar el planificador:', e));

    // 8. Inicializar Módulo Ambiental
    await initAmbientalModule(map);
});

map.on('error', (e) => {
    console.error('Error en MapLibre:', e.error);
});