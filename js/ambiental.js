/**
 * @module Ambiental
 * @author Paula
 * @description Módulo encargado de gestionar las capas ambientales (Temperatura, Presión, Polvo, Geopotencial), 
 * la lectura en cursor, la leyenda dinámica, el viento (flechas y animación) y los datos meteorológicos de Marte.
 */

let envTime = 14.5;
let lastCursor = null;
let usingRealData = false;
let realFeatures = null;
let dustFeatures = null;
let resolverAmbientalListo;
const ambientalListo = new Promise(resolve => { resolverAmbientalListo = resolve; });
const TEMP_MEDIA_C = -52;
const TEMP_AMPLITUD_C = 33;

const GRID_STEP = 10;
const LAT_MIN = -85, LAT_MAX = 85;
const LON_MIN = -180, LON_MAX = 180;

let windField = null;
let particleSystem = null;

async function condicionesEn(lon, lat, utcMs) {
    await ambientalListo;
    const env = getEnvAtPosition(lat, lon);
    const vientoMs = Number.isFinite(env.windSpeed) && env.windSpeed < 100 ? env.windSpeed : 8;
    return {
        tempMediaC: TEMP_MEDIA_C,
        amplitudC: TEMP_AMPLITUD_C,
        tau: Number.isFinite(env.dust) ? Math.max(0.2, env.dust) : 0.5,
        vientoMs,
        ...(Number.isFinite(env.windDir) ? { vientoDir: env.windDir } : {}),
        tormentaSolar: false,
        fuente: usingRealData
            ? 'viento EMARS (reanálisis) y polvo MCD (climatología); temperatura MEDA (climatología diurna), sin telemetría en tiempo real'
            : 'datos ambientales sintéticos; temperatura MEDA (climatología diurna), sin telemetría en tiempo real',
        referenciaUtc: utcMs,
    };
}

window.marsConditions = { en: condicionesEn };

/**
 * @function computeEnv
 * @description Calcula los valores ambientales sintéticos en una coordenada dada.
 * @param {number} lat - Latitud.
 * @param {number} lon - Longitud.
 * @param {number} time - Hora para el factor solar.
 * @returns {Object} Valores calculados (temp, tempK, pressure, wind, etc.).
 */
function computeEnv(lat, lon, time) {
    const solarFactor = Math.max(0, Math.sin((time - 6) / 12 * Math.PI));
    const latFactor = Math.cos(lat * Math.PI / 180);
    let tempC = -80 + latFactor * 60 + solarFactor * 30;
    let pressure = 580 + latFactor * 80;
    let windSpeed = 3 + Math.abs(Math.sin(lon * 0.05 + lat * 0.03)) * 12;
    const windDir = Math.round((Math.atan2(Math.sin(lat * 0.1), Math.cos(lon * 0.05)) * 180 / Math.PI + 360) % 360);
    let dust = 0.3 + Math.abs(Math.cos(lon * 0.02)) * 0.4 + Math.abs(lat) / 300;
    const geopot = 3.71 * (latFactor * 20000 - 8000);
    return {
        temp: Math.round(tempC), tempK: Math.round(tempC + 273.15),
        pressure: Math.round(pressure), windSpeed: Math.round(windSpeed),
        windDir: windDir, dust: parseFloat(dust.toFixed(2)),
        geopotential: Math.round(geopot)
    };
}

/**
 * @function generateGrid
 * @description Genera un grid sintético de datos si no hay GeoJSON real.
 * @param {number} time - Hora.
 * @returns {Object} GeoJSON FeatureCollection.
 */
function generateGrid(time) {
    const features = [];
    for (let lat = LAT_MIN; lat <= LAT_MAX; lat += GRID_STEP) {
        for (let lon = LON_MIN; lon <= LON_MAX; lon += GRID_STEP) {
            const env = computeEnv(lat, lon, time);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: { lat, lon, ...env }
            });
        }
    }
    return { type: 'FeatureCollection', features };
}

/**
 * @function getDustAtPosition
 * @description Busca el valor de polvo más cercano en el GeoJSON de polvo real.
 * @param {number} lat - Latitud.
 * @param {number} lon - Longitud.
 * @returns {number} Valor de polvo (tau).
 */
function getDustAtPosition(lat, lon) {
    if (!dustFeatures) return 0.5;
    let minDist = Infinity;
    let nearest = null;
    for (const feat of dustFeatures) {
        const dlat = feat.properties.lat - lat;
        const dlon = feat.properties.lon - lon;
        const d = dlat * dlat + dlon * dlon;
        if (d < minDist) { minDist = d; nearest = feat; }
    }
    return nearest ? nearest.properties.dust : 0.5;
}

/**
 * @function getEnvAtPosition
 * @description Obtiene los datos ambientales (reales o sintéticos) para una coordenada.
 * @param {number} lat - Latitud.
 * @param {number} lon - Longitud.
 * @returns {Object} Datos ambientales.
 */
function getEnvAtPosition(lat, lon) {
    if (!usingRealData || !realFeatures || realFeatures.length === 0) {
        return computeEnv(lat, lon, envTime);
    }
    let minDist = Infinity;
    let nearest = null;
    for (const feat of realFeatures) {
        const dlat = feat.properties.lat - lat;
        const dlon = feat.properties.lon - lon;
        const d = dlat * dlat + dlon * dlon;
        if (d < minDist) { minDist = d; nearest = feat; }
    }
    if (nearest) {
        const p = nearest.properties;
        return {
            temp: Math.round(p.tempK - 273.15), tempK: p.tempK,
            pressure: Math.round(p.pressure), windSpeed: Math.round(p.windSpeed),
            windDir: Math.round(p.windDir), dust: getDustAtPosition(lat, lon),
            geopotential: p.geopotential != null ? p.geopotential : null
        };
    }
    return computeEnv(lat, lon, envTime);
}

/**
 * @function updateReadout
 * @description Actualiza el panel flotante con los valores en la posición del cursor.
 * @param {Object} pos - Coordenadas {lon, lat}.
 * @param {Object} env - Datos ambientales.
 */
function updateReadout(pos, env) {
    document.getElementById('rd-lon').textContent   = pos.lon.toFixed(2);
    document.getElementById('rd-lat').textContent   = pos.lat.toFixed(2);
    document.getElementById('rd-temp').textContent  = env.temp;
    document.getElementById('rd-press').textContent = env.pressure;
    document.getElementById('rd-wind').textContent  = env.windSpeed;
    document.getElementById('rd-wdir').textContent  = env.windDir;
    document.getElementById('rd-dust').textContent  = Number(env.dust).toFixed(2);
    
    const g = env.geopotential;
    document.getElementById('rd-geopot').textContent =
        (g != null && !isNaN(g)) ? Math.round(g).toLocaleString('es-ES') : '---';

    const showAll = document.getElementById('toggle-show-all').checked;
    const isTemp = document.getElementById('toggle-temp').checked;
    const isPress = document.getElementById('toggle-pressure').checked;
    const isWind = document.getElementById('toggle-wind').checked || document.getElementById('toggle-wind-animated').checked;
    const isGeopot = document.getElementById('toggle-geopotential').checked;
    const isDust = document.getElementById('toggle-dust').checked;
    
    document.getElementById('row-temp').style.display = (showAll || isTemp) ? 'block' : 'none';
    document.getElementById('row-press').style.display = (showAll || isPress) ? 'block' : 'none';
    document.getElementById('row-wind').style.display = (showAll || isWind) ? 'block' : 'none';
    document.getElementById('row-geopot').style.display = (showAll || isGeopot) ? 'block' : 'none';
    document.getElementById('row-dust').style.display = (showAll || isDust) ? 'block' : 'none';
}

/**
 * @function baseColorState
 * @description Capa base publicada por js/main.js: mosaico Viking en color real
 * o MOLA coloreado por altura. Se asume MOLA si main.js no publicó nada.
 * @returns {{label: string, isElevation: boolean}}
 */
function baseColorState() {
    return { label: 'MOLA DEM 463 m', isElevation: true, ...(window.marsBaseColor || {}) };
}

/**
 * @function updateInfoBox
 * @description Cambia el texto del panel inferior izquierdo según la capa activa.
 * @param {string|null} activeId - ID del checkbox de la capa activa.
 */
function updateInfoBox(activeId) {
    const infoDiv = document.getElementById('info-panel');
    if (activeId === 'toggle-temp') {
        infoDiv.innerHTML = '<strong>Mapa de Temperatura en la superficie de Marte</strong><br>Datos de EMARS — arrastra y usa la rueda para hacer zoom';
    } else if (activeId === 'toggle-pressure') {
        infoDiv.innerHTML = '<strong>Mapa de Presión en la superficie de Marte</strong><br>Datos de EMARS — arrastra y usa la rueda para hacer zoom';
    } else if (activeId === 'toggle-dust') {
        infoDiv.innerHTML = '<strong>Mapa de Polvo en la superficie de Marte</strong><br>Datos de MCD — arrastra y usa la rueda para hacer zoom';
    } else if (activeId === 'toggle-geopotential') {
        infoDiv.innerHTML = '<strong>Mapa de Geopotencial en la superficie de Marte</strong><br>Datos de EMARS — arrastra y usa la rueda para hacer zoom';
    } else {
        infoDiv.innerHTML = `<strong>Mapa Topográfico de Marte</strong><br>${baseColorState().label} — arrastra y usa la rueda para hacer zoom`;
    }
}

const legendData = {
    'toggle-color': [
        { color: '#1a1a4e', label: '−8000 m' },
        { color: '#2e4a8b', label: '−4000 m' },
        { color: '#4a7cb5', label: '−1000 m' },
        { color: '#7db8a8', label: '0 m' },
        { color: '#a8c88a', label: '2000 m' },
        { color: '#d4b96a', label: '5000 m' },
        { color: '#c47a4a', label: '8000 m' },
        { color: '#a83a2a', label: '12000 m' },
        { color: '#e8e8e8', label: '18000 m' },
        { color: '#ffffff', label: '22000 m' }
    ],
    'toggle-temp': [
        { color: '#000030', label: '-133 °C' }, { color: '#000080', label: '-113 °C' },
        { color: '#0066cc', label: '-93 °C' }, { color: '#00ccff', label: '-73 °C' },
        { color: '#44ff88', label: '-53 °C' }, { color: '#ffff00', label: '-33 °C' },
        { color: '#ff6600', label: '-13 °C' }
    ],
    'toggle-pressure': [
        { color: '#3300aa', label: '300 Pa' }, { color: '#0088dd', label: '500 Pa' },
        { color: '#00ddaa', label: '700 Pa' }, { color: '#88dd00', label: '900 Pa' },
        { color: '#ffee00', label: '1100 Pa' }, { color: '#ff6600', label: '1300 Pa' }
    ],
    'toggle-dust': [
        { color: 'rgba(255,255,255,0.1)', label: '0 τ' }, { color: 'rgba(255,220,150,0.6)', label: '0.5 τ' },
        { color: 'rgba(255,150,50,0.8)', label: '1.5 τ' }, { color: 'rgba(180,60,20,1)', label: '3.0 τ' },
        { color: 'rgba(100,20,10,1)', label: '5.0 τ' }
    ],
    'toggle-geopotential': [
        { color: '#000080', label: '-25000' }, { color: '#0040cc', label: '-18000' },
        { color: '#0099ff', label: '-10000' }, { color: '#44ddff', label: '-3000' },
        { color: '#66ff66', label: '0' }, { color: '#ccff00', label: '5000' },
        { color: '#ffcc00', label: '12000' }, { color: '#ff6600', label: '20000' },
        { color: '#cc0000', label: '27000' }
    ]
};

/**
 * @function updateLegend
 * @description Actualiza la leyenda flotante según la capa ambiental activa.
 * @param {string|null} activeId - ID del checkbox de la capa.
 */
function updateLegend(activeId) {
    const titleEl = document.getElementById('legend-title');
    const itemsEl = document.getElementById('legend-items');
    
    if (!activeId || !legendData[activeId]) {
        titleEl.textContent = 'Leyenda';
        itemsEl.innerHTML = '<div style="font-size:11px; opacity:0.7;">Sin capa activa</div>';
        return;
    }

    // Con el mosaico Viking en color real, el color base no codifica altura:
    // mostrar la rampa de elevación sería engañoso.
    const base = baseColorState();
    if (activeId === 'toggle-color' && !base.isElevation) {
        titleEl.textContent = 'Color real';
        itemsEl.innerHTML = `
            <div class="legend-item">
                <span class="legend-color" style="background:linear-gradient(90deg,#6d4532,#c58b62,#4c5a6b);"></span>
                <span>${base.label}</span>
            </div>
            <div style="font-size:11px; opacity:0.7; margin-top:4px;">La altura se lee en las curvas de nivel y el sombreado.</div>`;
        return;
    }
    
    const titles = {
        'toggle-color': 'Elevación',
        'toggle-temp': 'Temperatura', 
        'toggle-pressure': 'Presión',
        'toggle-dust': 'Polvo (τ)', 
        'toggle-geopotential': 'Geopotencial'
    };
    
    titleEl.textContent = titles[activeId];
    itemsEl.innerHTML = legendData[activeId].map(item => `
        <div class="legend-item">
            <span class="legend-color" style="background:${item.color};"></span>
            <span>${item.label}</span>
        </div>
    `).join('');
}

/**
 * @function extrapolarGeoJSON
 * @description Extiende los datos de latitud hacia los polos para evitar zonas vacías.
 * @param {Object} data - GeoJSON original.
 * @returns {Object} GeoJSON extendido.
 */
function extrapolarGeoJSON(data) {
    const featuresExtendidas = [...data.features];
    const latsExistentes = [...new Set(data.features.map(f => f.properties.lat))];
    const latMax = Math.max(...latsExistentes);
    const latMin = Math.min(...latsExistentes);

    const filaNorte = data.features.filter(f => f.properties.lat === latMax);
    for (let lat = latMax + 10; lat <= 90; lat += 10) {
        filaNorte.forEach(f => {
            featuresExtendidas.push({ ...f, properties: { ...f.properties, lat: lat } });
        });
    }

    const filaSur = data.features.filter(f => f.properties.lat === latMin);
    for (let lat = latMin - 10; lat >= -90; lat -= 10) {
        filaSur.forEach(f => {
            featuresExtendidas.push({ ...f, properties: { ...f.properties, lat: lat } });
        });
    }

    return { type: 'FeatureCollection', features: featuresExtendidas };
}

/**
 * @function buildWindField
 * @description Precalcula un campo vectorial de viento (u, v) para la animación de partículas.
 */
function buildWindField() {
    const STEP = 5;
    const latN = Math.round((LAT_MAX - LAT_MIN) / STEP) + 1;
    const lonN = Math.round((LON_MAX - LON_MIN) / STEP) + 1;
    
    const us = new Float32Array(latN * lonN);
    const vs = new Float32Array(latN * lonN);
    
    for (let i = 0; i < latN; i++) {
        const lat = LAT_MIN + i * STEP;
        for (let j = 0; j < lonN; j++) {
            const lon = LON_MIN + j * STEP;
            const env = getEnvAtPosition(lat, lon);
            const toRad = (env.windDir + 180) * Math.PI / 180;
            us[i * lonN + j] = env.windSpeed * Math.sin(toRad);
            vs[i * lonN + j] = env.windSpeed * Math.cos(toRad);
        }
    }
    windField = { latMin: LAT_MIN, lonMin: LON_MIN, STEP, latN, lonN, us, vs };
}

/**
 * @function sampleWindFast
 * @description Muestrea la velocidad y dirección del viento interpolando el campo precalculado.
 * @param {number} lat - Latitud.
 * @param {number} lon - Longitud.
 * @returns {Object} Datos del viento (velocidad, dirección, componentes u/v).
 */
function sampleWindFast(lat, lon) {
    if (!windField) return { windSpeed: 5, windDir: 0, u: 0, v: 5 };
    const { latMin, lonMin, STEP, latN, lonN, us, vs } = windField;
    
    let fi = (lat - latMin) / STEP;
    let fj = (lon - lonMin) / STEP;
    fi = Math.max(0, Math.min(latN - 1.001, fi));
    fj = Math.max(0, Math.min(lonN - 1.001, fj));
    
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const i1 = i0 + 1, j1 = j0 + 1;
    const ti = fi - i0, tj = fj - j0;

    const u00 = us[i0 * lonN + j0], u01 = us[i0 * lonN + j1];
    const u10 = us[i1 * lonN + j0], u11 = us[i1 * lonN + j1];
    const u = (u00 * (1 - ti) + u10 * ti) * (1 - tj) + (u01 * (1 - ti) + u11 * ti) * tj;

    const v00 = vs[i0 * lonN + j0], v01 = vs[i0 * lonN + j1];
    const v10 = vs[i1 * lonN + j0], v11 = vs[i1 * lonN + j1];
    const v = (v00 * (1 - ti) + v10 * ti) * (1 - tj) + (v01 * (1 - ti) + v11 * ti) * tj;

    const speed = Math.sqrt(u*u + v*v);
    let dirTo = Math.atan2(u, v) * 180 / Math.PI;
    let dirFrom = (dirTo + 180 + 360) % 360;

    return { windSpeed: speed, windDir: dirFrom, u: u, v: v };
}

/**
 * @function generateDenseWindArrows
 * @description Genera un GeoJSON denso de flechas de viento para la capa estática.
 * @returns {Object} GeoJSON FeatureCollection.
 */
function generateDenseWindArrows() {
    const features = [];
    const step = 2.5;
    for (let lat = LAT_MIN; lat <= LAT_MAX; lat += step) {
        for (let lon = LON_MIN; lon <= LON_MAX; lon += step) {
            const w = sampleWindFast(lat, lon);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: { lat, lon, windSpeed: w.windSpeed, windDir: w.windDir }
            });
        }
    }
    return { type: 'FeatureCollection', features };
}

/**
 * @function setupWindParticles
 * @description Inicializa el canvas y el sistema de partículas animadas para el viento.
 */
function setupWindParticles() {
    try {
        const map = window.map;
        const container = map.getContainer();
        const canvas = document.createElement('canvas');
        canvas.id = 'wind-particles-canvas';
        canvas.style.cssText = [
            'position: absolute', 'top: 0', 'left: 0',
            'width: 100%', 'height: 100%',
            'pointer-events: none', 'z-index: 1',
            'display: none'
        ].join(';');
        container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        function resize() {
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        resize();
        window.addEventListener('resize', resize);
        map.on('resize', resize);

        function W() { return canvas.width / dpr; }
        function H() { return canvas.height / dpr; }

        const NUM_PARTICLES = 2500;
        const MAX_AGE_BASE = 200;
        const FADE_ALPHA = 0.06;
        const V_PX_MIN = 0.35;
        const V_PX_MAX = 1.6;
        const REF_WIND = 30;

        const LINE_WIDTH = 1.4;
        const BASE_ALPHA = 0.38;
        const DEATH_FADE = 0.15;

        const particles = [];

        function spawnInViewport() {
            const x = Math.random() * W();
            const y = Math.random() * H();
            const ll = map.unproject([x, y]);
            return {
                lat: ll.lat, lon: ll.lng,
                age: 0,
                maxAge: MAX_AGE_BASE * (0.5 + Math.random() * 0.9),
                px: null, py: null
            };
        }

        for (let i = 0; i < NUM_PARTICLES; i++) {
            const p = spawnInViewport();
            p.age = Math.floor(Math.random() * p.maxAge);
            particles.push(p);
        }

        map.on('move', () => {
            ctx.clearRect(0, 0, W(), H());
            for (const p of particles) { p.px = null; p.py = null; }
        });

        let running = false;
        let rafId = null;

        function frame() {
            if (!running) return;

            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = `rgba(0,0,0,${FADE_ALPHA})`;
            ctx.fillRect(0, 0, W(), H());
            ctx.globalCompositeOperation = 'source-over';

            const w = W(), h = H();

            ctx.lineCap = 'round';
            ctx.lineWidth = LINE_WIDTH;

            for (const p of particles) {
                const w2 = sampleWindFast(p.lat, p.lon);
                
                const speedRatio = Math.min(1, w2.windSpeed / REF_WIND);
                const V_PX = V_PX_MIN + speedRatio * (V_PX_MAX - V_PX_MIN);

                const mag = Math.sqrt(w2.u * w2.u + w2.v * w2.v) || 1;
                const dx = (w2.u / mag) * V_PX;
                const dy = (w2.v / mag) * V_PX;

                const pt = map.project([p.lon, p.lat]);
                
                const jitterX = (Math.random() - 0.5) * 0.4;
                const jitterY = (Math.random() - 0.5) * 0.4;

                const nextX = pt.x + dx + jitterX;
                const nextY = pt.y - dy + jitterY;

                if (p.px !== null && p.py !== null) {
                    const lifeRatio = p.age / p.maxAge;
                    const alpha = lifeRatio > (1 - DEATH_FADE)
                        ? BASE_ALPHA * (1 - lifeRatio) / DEATH_FADE
                        : BASE_ALPHA;

                    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
                    ctx.beginPath();
                    ctx.moveTo(p.px, p.py);
                    ctx.lineTo(nextX, nextY);
                    ctx.stroke();
                }

                const nextLL = map.unproject([nextX, nextY]);
                p.lat = nextLL.lat;
                p.lon = nextLL.lng;
                p.px = nextX;
                p.py = nextY;
                p.age++;

                const out = nextX < -30 || nextX > w + 30 || nextY < -30 || nextY > h + 30;
                if (p.age > p.maxAge || out) {
                    const np = spawnInViewport();
                    p.lat = np.lat; p.lon = np.lon;
                    p.age = 0; p.maxAge = np.maxAge;
                    p.px = null; p.py = null;
                }
            }

            rafId = requestAnimationFrame(frame);
        }

        particleSystem = {
            canvas,
            start() {
                if (running) return;
                resize();
                if (canvas.width < 10 || canvas.height < 10) return;
                running = true;
                canvas.style.display = 'block';
                frame();
            },
            stop() {
                running = false;
                if (rafId) cancelAnimationFrame(rafId);
                rafId = null;
                canvas.style.display = 'none';
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        };
    } catch (err) {
        console.error('Error inicializando partículas:', err);
    }
}

/**
 * @function initAmbientalModule
 * @description Punto de entrada del módulo. Carga los datos, crea las capas ambientales y configura los eventos de UI.
 * @param {Object} map - Instancia del mapa de MapLibre.
 */
export async function initAmbientalModule(map) {
    window.map = map; // Guardamos la referencia global para el sistema de partículas

    // Carga de datos
    try {
        const resp = await fetch('./data/datos_ambientales_marte.geojson?t=' + Date.now());
        if (resp.ok) {
            const rawData = await resp.json();
            const dataExtendida = extrapolarGeoJSON(rawData);
            realFeatures = dataExtendida.features;
            usingRealData = true;
            map.addSource('temp-source', { type: 'geojson', data: dataExtendida });
            console.log(`Datos reales cargados (${realFeatures.length} puntos).`);
        }
    } catch (e) {
        console.warn('Datos reales no disponibles, usando sintéticos:', e.message);
    }

    if (!usingRealData) {
        const dataSintetica = generateGrid(envTime);
        map.addSource('temp-source', { type: 'geojson', data: dataSintetica });
    }

    try {
        const dustResp = await fetch('./data/polvo_marte.geojson');
        if (dustResp.ok) {
            const dustData = await dustResp.json();
            dustFeatures = dustData.features;
            map.addSource('dust-source', { type: 'geojson', data: dustData });
            console.log(`Capa de polvo real cargada: ${dustData.features.length} puntos.`);
        }
    } catch (e) {
        console.warn('Datos de polvo no disponibles, usando fallback.');
        map.addSource('dust-source', { type: 'geojson', data: generateGrid(envTime) });
    }

    buildWindField();
    const denseWindData = generateDenseWindArrows();
    map.addSource('wind-source', { type: 'geojson', data: denseWindData });

    // Capas ambientales
    map.addLayer({
        id: 'env-temp', type: 'circle', source: 'temp-source',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 40, 3, 90, 5, 160, 6, 220],
            'circle-blur': 1.0, 'circle-opacity': 0.35,
            'circle-color': ['interpolate', ['linear'], ['get', 'tempK'],
                140, '#000030', 160, '#000080', 180, '#0066cc',
                200, '#00ccff', 220, '#44ff88', 240, '#ffff00', 260, '#ff6600']
        }
    }, 'contour-lines');

    map.addLayer({
        id: 'env-pressure', type: 'circle', source: 'temp-source',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 40, 3, 90, 5, 160, 6, 220],
            'circle-blur': 1.0, 'circle-opacity': 0.35,
            'circle-color': ['interpolate', ['linear'], ['get', 'pressure'],
                300, '#3300aa', 500, '#0088dd', 700, '#00ddaa',
                900, '#88dd00', 1100, '#ffee00', 1300, '#ff6600']
        }
    }, 'contour-lines');

    map.addLayer({
        id: 'env-geopotential', type: 'circle', source: 'temp-source',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 40, 3, 90, 5, 160, 6, 220],
            'circle-blur': 1.0, 'circle-opacity': 0.22,
            'circle-color': [
                'interpolate', ['linear'], ['coalesce', ['get', 'geopotential'], 0],
                -25000, '#000080', -18000, '#0040cc', -10000, '#0099ff',
                -3000, '#44ddff', 0, '#66ff66', 5000, '#ccff00',
                12000, '#ffcc00', 20000, '#ff6600', 27000, '#cc0000'
            ]
        }
    }, 'contour-lines');

    map.addLayer({
        id: 'env-dust', type: 'circle', source: 'dust-source',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 40, 3, 90, 5, 160, 6, 220],
            'circle-blur': 1.0, 'circle-opacity': 0.7,
            'circle-color': ['interpolate', ['linear'], ['get', 'dust'],
                0.0, 'rgba(255,255,255,0)', 0.5, 'rgba(255,220,150,0.4)',
                1.5, 'rgba(255,150,50,0.75)', 3.0, 'rgba(180,60,20,0.95)',
                5.0, 'rgba(100,20,10,1)']
        }
    }, 'contour-lines');

    // Capa de viento (flechas)
    const arrowSVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
            <path d="M16 27 L16 5 M9 12 L16 5 L23 12"
                  fill="none" stroke="#4a2e15" stroke-width="1.4"
                  stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    const arrowImg = new Image(32, 32);
    arrowImg.onload = () => {
        if (!map.hasImage('wind-arrow-outline')) {
            map.addImage('wind-arrow-outline', arrowImg, { sdf: false });
        }
        map.addLayer({
            id: 'env-wind', type: 'symbol', source: 'wind-source',
            layout: {
                visibility: 'none',
                'icon-image': 'wind-arrow-outline',
                'icon-rotate': ['+', ['get', 'windDir'], 180],
                'icon-rotation-alignment': 'map',
                'icon-size': [
                    'interpolate', ['linear'], ['zoom'],
                    2, ['interpolate', ['linear'], ['get', 'windSpeed'], 0, 0.5, 10, 0.75, 20, 1.0, 30, 1.3],
                    6, [
                        '*', 
                        ['interpolate', ['linear'], ['get', 'windSpeed'], 0, 0.5, 10, 0.75, 20, 1.0, 30, 1.3],
                        2.2
                    ]
                ],
                'icon-allow-overlap': false,
                'icon-ignore-placement': false,
                'symbol-sort-key': ['get', 'windSpeed']
            },
            paint: {
                'icon-halo-color': 'rgba(255, 255, 255, 1.0)',
                'icon-halo-width': ['interpolate', ['linear'], ['zoom'], 2, 3, 6, 6],
                'icon-halo-blur': 0.5
            }
        }, 'contour-lines');
    };
    arrowImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(arrowSVG);

    // Eventos UI de capas exclusivas (Color, Temp, Presión, Geopotencial)
    const exclusiveIds = ['toggle-color', 'toggle-temp', 'toggle-pressure', 'toggle-geopotential'];
    const exclusiveMapLayers = {
        'toggle-color': 'color',
        'toggle-temp': 'env-temp',
        'toggle-pressure': 'env-pressure',
        'toggle-geopotential': 'env-geopotential'
    };

    exclusiveIds.forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => {
            if (e.target.checked) {
                // Apagar las otras exclusivas
                exclusiveIds.forEach(otherId => {
                    if (otherId !== id) {
                        document.getElementById(otherId).checked = false;
                        if (map.getLayer(exclusiveMapLayers[otherId])) {
                            map.setLayoutProperty(exclusiveMapLayers[otherId], 'visibility', 'none');
                        }
                    }
                });
                if (map.getLayer(exclusiveMapLayers[id])) {
                    map.setLayoutProperty(exclusiveMapLayers[id], 'visibility', 'visible');
                }
            } else {
                if (map.getLayer(exclusiveMapLayers[id])) {
                    map.setLayoutProperty(exclusiveMapLayers[id], 'visibility', 'none');
                }
            }
            
            updateInfoBox(id);
            updateLegend(id);
            
            if (lastCursor) {
                const env = getEnvAtPosition(lastCursor.lat, lastCursor.lng);
                updateReadout(lastCursor, env);
            }
        });
    });

    // ─── Capa de Polvo ───
    document.getElementById('toggle-dust').addEventListener('change', e => {
        if (map.getLayer('env-dust')) {
            map.setLayoutProperty('env-dust', 'visibility', e.target.checked ? 'visible' : 'none');
        }
        if (lastCursor) updateReadout(lastCursor, getEnvAtPosition(lastCursor.lat, lastCursor.lng));
    });

    // ─── Capa de Viento (Estática vs Animada) ───
    document.getElementById('toggle-wind').addEventListener('change', e => {
        if (map.getLayer('env-wind')) {
            map.setLayoutProperty('env-wind', 'visibility', e.target.checked ? 'visible' : 'none');
        }
        if (e.target.checked) {
            // Apagar la animación si estaba encendida
            const animCb = document.getElementById('toggle-wind-animated');
            if (animCb.checked) {
                animCb.checked = false;
                if (particleSystem) particleSystem.stop();
            }
        }
        if (lastCursor) updateReadout(lastCursor, getEnvAtPosition(lastCursor.lat, lastCursor.lng));
    });

    document.getElementById('toggle-wind-animated').addEventListener('change', e => {
        if (e.target.checked) {
            // Apagar las flechas estáticas si estaban encendidas
            const staticCb = document.getElementById('toggle-wind');
            if (staticCb.checked) {
                staticCb.checked = false;
                if (map.getLayer('env-wind')) {
                    map.setLayoutProperty('env-wind', 'visibility', 'none');
                }
            }
            if (particleSystem) particleSystem.start();
        } else {
            if (particleSystem) particleSystem.stop();
        }
        if (lastCursor) updateReadout(lastCursor, getEnvAtPosition(lastCursor.lat, lastCursor.lng));
    });

    // UI Panel cursor
    document.getElementById('coords-toggle').addEventListener('click', () => {
        const panel = document.getElementById('coords');
        panel.classList.toggle('collapsed');
        document.getElementById('coords-icon').textContent = panel.classList.contains('collapsed') ? '▼' : '▲';
    });

    document.getElementById('toggle-show-all').addEventListener('change', () => {
        if (lastCursor) updateReadout(lastCursor, getEnvAtPosition(lastCursor.lat, lastCursor.lng));
    });

    // Evento de movimiento del ratón
    map.on('mousemove', (e) => {
        lastCursor = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        const env = getEnvAtPosition(lastCursor.lat, lastCursor.lon);
        updateReadout(lastCursor, env);
    });

    // Inicializar readout y setup de partículas
    updateReadout({ lat: 0, lon: 0 }, getEnvAtPosition(0, 0));
    setupWindParticles();
    
    updateLegend('toggle-color');
    resolverAmbientalListo();
}