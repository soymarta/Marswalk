/**
 * @module perfil
 * @author Hani
 * @description Línea de tiempo de la EVA en un canvas: perfil de elevación en función del TIEMPO
 * (las paradas de trabajo se ven como mesetas), bandas de luz solar / sombra / sin radio, curva del
 * margen de retorno, paradas numeradas, punto de no retorno y cabezal arrastrable.
 */
import { formatHora } from './marsTime.js';

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class LineaTiempo {
    constructor(canvas, { alMover } = {}) {
        this.cv = canvas;
        this.ctx = canvas.getContext('2d');
        this.alMover = alMover;
        this.datos = null;
        this.t = 0;
        this.hover = null;
        const ro = new ResizeObserver(() => this.dibujar());
        ro.observe(canvas);
        const pos = e => {
            const r = canvas.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - r.left - this.m.l) / (r.width - this.m.l - this.m.r)));
        };
        let arrastrando = false;
        canvas.addEventListener('pointerdown', e => {
            if (!this.datos) return;
            arrastrando = true; canvas.setPointerCapture(e.pointerId);
            this.alMover?.(pos(e) * this.duracion);
        });
        canvas.addEventListener('pointermove', e => {
            if (!this.datos) return;
            this.hover = pos(e);
            if (arrastrando) this.alMover?.(this.hover * this.duracion);
            else this.dibujar();
        });
        canvas.addEventListener('pointerup', () => { arrastrando = false; });
        canvas.addEventListener('pointerleave', () => { this.hover = null; this.dibujar(); });
        canvas.addEventListener('keydown', e => {
            if (!this.datos) return;
            const paso = this.duracion / 100;
            if (e.key === 'ArrowRight') { this.alMover?.(Math.min(this.duracion, this.t + paso)); e.preventDefault(); }
            if (e.key === 'ArrowLeft') { this.alMover?.(Math.max(0, this.t - paso)); e.preventDefault(); }
        });
        this.m = { l: 46, r: 40, t: 14, b: 22 };
    }

    /** res: resultado del planificador (con muestras). tOffset: tiempo previo (replanificación). */
    fijar(res, perfil) {
        this.datos = res;
        this.perfil = perfil;
        this.duracion = res ? res.muestras.t[res.muestras.t.length - 1] || 1 : 1;
        this.t = 0;
        this.dibujar();
    }

    fijarTiempo(t) { this.t = t; this.dibujar(); }

    dibujar() {
        const cv = this.cv, dpr = window.devicePixelRatio || 1;
        const W = cv.clientWidth, H = cv.clientHeight;
        if (!W || !H) return;
        if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!this.datos) return;
        const { muestras: s, paradas = [], pnr, puntoCompromiso } = this.datos;
        const n = s.t.length, m = this.m;
        const x = t => m.l + (W - m.l - m.r) * t / this.duracion;
        let zMin = Infinity, zMax = -Infinity;
        for (let k = 0; k < n; k++) { zMin = Math.min(zMin, s.elev[k]); zMax = Math.max(zMax, s.elev[k]); }
        const pad = Math.max(10, (zMax - zMin) * 0.15);
        zMin -= pad; zMax += pad;
        const y = z => m.t + (H - m.t - m.b) * (1 - (z - zMin) / (zMax - zMin));
        const yM = v => m.t + (H - m.t - m.b) * (1 - Math.max(0, Math.min(1, v)));
        const C = {
            texto: css('--polvo'), suave: css('--basalto'), ruta: css('--ocaso'), ambar: css('--sol'),
            peligro: css('--hematita'), fondo: css('--regolito'),
        };

        // Bandas: noche / sol bajo / sombra (arriba) y sin radio (abajo)
        for (let k = 1; k < n; k++) {
            const x0 = x(s.t[k - 1]), x1 = x(s.t[k]) + 0.5;
            if (s.solElev[k] <= 0) { ctx.fillStyle = 'rgba(60,64,110,.25)'; ctx.fillRect(x0, m.t, x1 - x0, H - m.t - m.b); }
            else if (s.solElev[k] < 10) { ctx.fillStyle = 'rgba(249,171,0,.10)'; ctx.fillRect(x0, m.t, x1 - x0, H - m.t - m.b); }
            if (s.sombra[k]) { ctx.fillStyle = 'rgba(95,99,104,.30)'; ctx.fillRect(x0, m.t, x1 - x0, 5); }
            if (!s.cobertura[k]) { ctx.fillStyle = 'rgba(161,66,244,.55)'; ctx.fillRect(x0, H - m.b - 4, x1 - x0, 4); }
        }

        // Relleno del perfil
        const grad = ctx.createLinearGradient(0, m.t, 0, H - m.b);
        grad.addColorStop(0, 'rgba(66,133,244,.28)');
        grad.addColorStop(1, 'rgba(66,133,244,.02)');
        ctx.beginPath();
        ctx.moveTo(x(s.t[0]), H - m.b);
        for (let k = 0; k < n; k++) ctx.lineTo(x(s.t[k]), y(s.elev[k]));
        ctx.lineTo(x(s.t[n - 1]), H - m.b);
        ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();

        // Línea del perfil coloreada por pendiente relativa al límite del perfil
        const lim = this.perfil?.pendienteMax || 20;
        ctx.lineWidth = 2;
        for (let k = 1; k < n; k++) {
            const q = s.pend[k] / lim;
            ctx.strokeStyle = q > 0.8 ? C.peligro : q > 0.55 ? C.ambar : C.ruta;
            ctx.beginPath(); ctx.moveTo(x(s.t[k - 1]), y(s.elev[k - 1])); ctx.lineTo(x(s.t[k]), y(s.elev[k])); ctx.stroke();
        }

        // Margen de retorno (eje derecho 0-100 %)
        ctx.setLineDash([4, 3]); ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(95,99,104,.8)';
        ctx.beginPath();
        for (let k = 0; k < n; k++) { const xx = x(s.t[k]), yy = yM(s.margen[k]); k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
        ctx.stroke(); ctx.setLineDash([]);

        // Ejes
        ctx.fillStyle = C.suave; ctx.font = '400 11px Roboto, sans-serif'; ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.round(zMax - pad)} m`, m.l - 6, y(zMax - pad));
        ctx.fillText(`${Math.round(zMin + pad)} m`, m.l - 6, y(zMin + pad));
        ctx.textAlign = 'left';
        ctx.fillText('100 %', W - m.r + 6, yM(1)); ctx.fillText('0 %', W - m.r + 6, yM(0));
        ctx.save(); ctx.translate(W - 8, (H - m.b + m.t) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
        ctx.fillText('límite de vuelta', 0, 0); ctx.restore();
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        const pasos = Math.max(2, Math.floor((W - m.l - m.r) / 90));
        for (let i = 0; i <= pasos; i++) {
            const t = this.duracion * i / pasos;
            const k = indice(s.t, t);
            ctx.fillText(formatHora(s.ltst[k]), x(t), H - 6);
        }

        // Paradas
        paradas.forEach((p, i) => {
            if (p.llegadaS == null) return;
            const x0 = x(p.llegadaS), x1 = x(p.salidaS ?? p.llegadaS);
            ctx.fillStyle = 'rgba(26,115,232,.08)'; ctx.fillRect(x0, m.t, Math.max(2, x1 - x0), H - m.t - m.b);
            const yy = y(s.elev[p.idx]) - 12;
            ctx.beginPath(); ctx.arc(x0, yy, 8, 0, 2 * Math.PI); ctx.fillStyle = C.fondo; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#3c4043'; ctx.stroke();
            ctx.fillStyle = C.texto; ctx.font = '500 10px Roboto, sans-serif'; ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), x0, yy + 0.5); ctx.textBaseline = 'alphabetic';
        });

        // Punto de no retorno o de máximo compromiso
        const kP = pnr >= 0 ? pnr : puntoCompromiso;
        if (kP != null && kP >= 0) {
            const xx = x(s.t[kP]);
            ctx.strokeStyle = pnr >= 0 ? C.peligro : C.ambar; ctx.lineWidth = 1.5; ctx.setLineDash(pnr >= 0 ? [] : [2, 3]);
            ctx.beginPath(); ctx.moveTo(xx, m.t); ctx.lineTo(xx, H - m.b); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = pnr >= 0 ? C.peligro : '#b06000'; ctx.font = '500 10.5px Roboto, sans-serif'; ctx.textAlign = 'left';
            ctx.fillText(pnr >= 0 ? 'no retorno' : 'mín. margen', xx + 4, m.t + 16);
        }

        // Cabezal
        const xp = x(this.t);
        ctx.strokeStyle = C.texto; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(xp, m.t - 4); ctx.lineTo(xp, H - m.b); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(xp - 5, m.t - 8); ctx.lineTo(xp + 5, m.t - 8); ctx.lineTo(xp, m.t - 2); ctx.closePath();
        ctx.fillStyle = C.texto; ctx.fill();

        // Lectura al pasar el ratón
        if (this.hover != null) {
            const t = this.hover * this.duracion, k = indice(s.t, t), xx = x(t);
            ctx.strokeStyle = 'rgba(60,64,67,.35)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(xx, m.t); ctx.lineTo(xx, H - m.b); ctx.stroke();
            const txt = `${formatHora(s.ltst[k])}  ${Math.round(s.elev[k])} m  ${s.pend[k].toFixed(0)}°  margen ${(s.margen[k] * 100).toFixed(0)} %`;
            ctx.font = '400 11.5px Roboto, sans-serif';
            const w = ctx.measureText(txt).width + 14;
            const bx = Math.min(W - m.r - w, Math.max(m.l, xx + 8));
            ctx.fillStyle = 'rgba(32,33,36,.92)'; ctx.fillRect(bx, m.t + 2, w, 20);
            ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(txt, bx + 7, m.t + 16);
        }
    }
}

/** Índice de la última muestra con t ≤ tiempo (búsqueda binaria). */
export function indice(ts, t) {
    let lo = 0, hi = ts.length - 1;
    if (t <= ts[0]) return 0;
    if (t >= ts[hi]) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    return lo;
}
