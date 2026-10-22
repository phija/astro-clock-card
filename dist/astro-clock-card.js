/*!
 * Astro Clock Card — a 24-hour astronomical clock for Home Assistant.
 *
 * Shows day, civil / nautical / astronomical twilight and night for the
 * current local day as colored arcs on a 24-hour dial, highlights the spans
 * in which the sun is higher than configurable elevations (default 7° and
 * 18°), and displays the current apparent sun elevation.
 *
 * Self-contained: no external dependencies, no build step.
 * License: MIT
 */
(() => {
    'use strict';

    const CARD_TAG = 'astro-clock-card';
    const VERSION = '1.0.0';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HOUR_MS = 3600000;
    const DAY_MS = 86400000;

    // ------------------------------------------------------------------
    // Solar position
    // ------------------------------------------------------------------

    const degToRad = (d) => d * Math.PI / 180;
    const radToDeg = (r) => r * 180 / Math.PI;

    // Geometric altitude of the sun's center and its local hour angle, using
    // the NOAA / Meeus low-precision solar position (accuracy ~0.01°).
    // Longitude is east-positive. No refraction applied.
    function sunPosition(epochMs, latitude, longitude) {
        const jd = epochMs / DAY_MS + 2440587.5;
        const d = jd - 2451545.0;
        const T = d / 36525;

        const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
        const M = degToRad(357.52911 + T * (35999.05029 - 0.0001537 * T));
        const C = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T))
                + Math.sin(2 * M) * (0.019993 - 0.000101 * T)
                + Math.sin(3 * M) * 0.000289;
        const omega = degToRad(125.04 - 1934.136 * T);
        const lambda = degToRad(L0 + C - 0.00569 - 0.00478 * Math.sin(omega));

        const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
        const eps = degToRad(eps0 + 0.00256 * Math.cos(omega));

        const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
        const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));

        const gmst = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000;
        const lhaDeg = ((gmst + longitude - radToDeg(ra)) % 360 + 540) % 360 - 180; // (-180, 180]

        const phi = degToRad(latitude);
        const sinAlt = Math.sin(phi) * Math.sin(decl)
                     + Math.cos(phi) * Math.cos(decl) * Math.cos(degToRad(lhaDeg));
        return { altitude: radToDeg(Math.asin(sinAlt)), lhaDeg };
    }

    // Atmospheric refraction (degrees) for a geometric altitude `h`, using
    // the NOAA solar calculator approximation (10 °C, 1010 hPa). Continuous
    // across its pieces; decays towards zero below the horizon.
    function refractionDeg(h) {
        if (h > 85) return 0;
        const te = Math.tan(degToRad(h));
        let arcsec;
        if (h > 5) {
            arcsec = 58.1 / te - 0.07 / (te * te * te) + 0.000086 / Math.pow(te, 5);
        } else if (h > -0.575) {
            arcsec = 1735 + h * (-518.2 + h * (103.4 + h * (-12.79 + h * 0.711)));
        } else {
            arcsec = -20.772 / te;
        }
        return arcsec / 3600;
    }

    const apparentAltitude = (h) => h + refractionDeg(h);

    // Phase thresholds, ascending. Twilight limits are geometric by
    // convention; -0.833° is the standard sunrise/sunset altitude (refraction
    // at the horizon plus the sun's semi-diameter). Elevation zones are
    // appended at runtime as apparent altitudes.
    const TWILIGHT_THRESHOLDS = [
        { key: 'astronomical', value: -18,    apparent: false },
        { key: 'nautical',     value: -12,    apparent: false },
        { key: 'civil',        value: -6,     apparent: false },
        { key: 'sun',          value: -0.833, apparent: false },
    ];

    // All crossings of `thresholds` in [t0, t1]. The geometric altitude is
    // sampled every 10 minutes and each sign change refined by bisection to
    // well under a second.
    function findCrossings(t0, t1, lat, lon, thresholds) {
        const STEP = 10 * 60000;
        const alt = (t) => sunPosition(t, lat, lon).altitude;
        const value = (h, th) => (th.apparent ? apparentAltitude(h) : h) - th.value;

        const times = [];
        const alts = [];
        for (let t = t0; ; t += STEP) {
            const tt = Math.min(t, t1);
            times.push(tt);
            alts.push(alt(tt));
            if (tt >= t1) break;
        }

        const out = [];
        for (const th of thresholds) {
            for (let i = 1; i < times.length; i++) {
                let fa = value(alts[i - 1], th);
                const fb = value(alts[i], th);
                if ((fa > 0) === (fb > 0)) continue;
                let a = times[i - 1];
                let b = times[i];
                for (let k = 0; k < 22; k++) {
                    const m = (a + b) / 2;
                    const fm = value(alt(m), th);
                    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else { b = m; }
                }
                out.push({ key: th.key, t: (a + b) / 2, rising: fb > 0 });
            }
        }
        return out.sort((x, y) => x.t - y.t);
    }

    // Upper culmination closest to `tGuess` (local hour angle = 0).
    function solarTransit(tGuess, lat, lon) {
        let t = tGuess;
        for (let i = 0; i < 4; i++) {
            t -= (sunPosition(t, lat, lon).lhaDeg / 360.98564736629) * DAY_MS;
        }
        return t;
    }

    // ------------------------------------------------------------------
    // Time zone helpers (Intl only — never the browser's own zone)
    // ------------------------------------------------------------------

    const partsFormatters = new Map();
    function wallClock(epochMs, zone) {
        let f = partsFormatters.get(zone);
        if (!f) {
            f = new Intl.DateTimeFormat('en-US', {
                timeZone: zone, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
            partsFormatters.set(zone, f);
        }
        const p = {};
        for (const { type, value } of f.formatToParts(new Date(epochMs))) p[type] = value;
        return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
    }

    // Wall-clock time of `epochMs` in `zone`, expressed as if it were UTC.
    function naiveMs(epochMs, zone) {
        const w = wallClock(epochMs, zone);
        const ms = ((epochMs % 1000) + 1000) % 1000;
        return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) + ms;
    }

    // Epoch of local 00:00 on the given calendar date in `zone`.
    function localMidnight(y, m, d, zone) {
        const naive = Date.UTC(y, m - 1, d);
        let t = naive - (naiveMs(naive, zone) - naive);
        t = naive - (naiveMs(t, zone) - t);
        return t;
    }

    function isValidLocale(tag) {
        try {
            return Intl.getCanonicalLocales(tag).length > 0;
        } catch (e) {
            return false;
        }
    }

    function isValidZone(zone) {
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: zone });
            return true;
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Day model
    // ------------------------------------------------------------------

    // Everything the dial needs for one local calendar day. Hours on the
    // dial are local wall-clock hours (so they match the hand on 23 h / 25 h
    // DST days); values may exceed [0, 24) for events on adjacent days.
    function computeDay(ymd, lat, lon, zone, zones) {
        const dayStart = localMidnight(ymd.y, ymd.m, ymd.d, zone);
        const nd = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + 1));
        const dayEnd = localMidnight(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), zone);
        const naiveStart = Date.UTC(ymd.y, ymd.m - 1, ymd.d);
        const toHour = (t) => (naiveMs(t, zone) - naiveStart) / HOUR_MS;

        const thresholds = TWILIGHT_THRESHOLDS.concat(
            zones.map((z, i) => ({ key: `zone${i}`, value: z, apparent: true }))
        );

        // Wide window so that transit-anchored dawn/dusk can be found even
        // when they fall on the previous or next calendar day.
        const crossings = findCrossings(dayStart - 14 * HOUR_MS, dayEnd + 14 * HOUR_MS, lat, lon, thresholds);

        // Phase level = number of thresholds exceeded. Thresholds are nested
        // (each one implies all lower ones), so the level is well defined.
        const levelAt = (t) => {
            const h = sunPosition(t, lat, lon).altitude;
            const ha = apparentAltitude(h);
            let n = 0;
            for (const th of thresholds) if ((th.apparent ? ha : h) > th.value) n++;
            return n;
        };

        const breaks = [dayStart];
        for (const c of crossings) if (c.t > dayStart && c.t < dayEnd) breaks.push(c.t);
        breaks.push(dayEnd);

        const segments = [];
        let lastHour = 0;
        for (let i = 1; i < breaks.length; i++) {
            const a = breaks[i - 1];
            const b = breaks[i];
            const from = Math.max(lastHour, Math.min(24, Math.max(0, toHour(a))));
            const to = i === breaks.length - 1 ? 24 : Math.max(from, Math.min(24, toHour(b)));
            lastHour = to;
            const level = levelAt((a + b) / 2);
            const prev = segments[segments.length - 1];
            if (prev && prev.level === level) prev.to = to;
            else segments.push({ from, to, level });
        }

        // Center-panel times, anchored on the day's solar transit: dawn is
        // the last rising crossing before it, dusk the first falling one
        // after it. This stays correct at high latitudes where dusk slips
        // past midnight.
        const transit = solarTransit((dayStart + dayEnd) / 2, lat, lon);
        const events = { noon: transit };
        for (const th of TWILIGHT_THRESHOLDS) {
            let dawn = null;
            let dusk = null;
            for (const c of crossings) {
                if (c.key !== th.key) continue;
                if (c.rising && c.t <= transit && c.t >= transit - 14 * HOUR_MS) dawn = c.t;
                if (!c.rising && c.t >= transit && c.t <= transit + 14 * HOUR_MS && dusk === null) dusk = c.t;
            }
            events[`${th.key}Dawn`] = dawn;
            events[`${th.key}Dusk`] = dusk;
        }

        // Marker positions on the dial: twilight crossings within the day,
        // plus solar noon.
        const markers = crossings
            .filter((c) => c.t >= dayStart && c.t < dayEnd && !c.key.startsWith('zone'))
            .map((c) => toHour(c.t));
        if (transit >= dayStart && transit < dayEnd) markers.push(toHour(transit));

        return { segments, events, markers, toHour };
    }

    // ------------------------------------------------------------------
    // Presentation
    // ------------------------------------------------------------------

    const DEFAULT_COLORS = {
        night:                '#06091f',
        astronomical_twilight: '#101836',
        nautical_twilight:    '#1e3254',
        civil_twilight:       '#3b5276',
        day:                  '#accfff',
        face:                 '#0a0e22',
        tick_major:           '#f0eee0',
        tick_minor:           '#9aa0b4',
        label:                '#f0eee0',
        hand:                 '#ffffff',
        sun:                  '#ffd34d',
    };
    const DEFAULT_ZONE_COLORS = ['#e6e3b0', '#ffd966', '#ffb84d', '#ff9a3c'];
    const DEFAULT_ZONES = [7, 18];

    const I18N = {
        en: {
            night: 'night', astronomical: 'astronomical', nautical: 'nautical',
            civil: 'civil', day: 'day', sunrise: 'sunrise', sunset: 'sunset',
            elevation: 'elevation',
        },
        de: {
            night: 'Nacht', astronomical: 'astronomisch', nautical: 'nautisch',
            civil: 'bürgerlich', day: 'Tag', sunrise: 'Aufgang', sunset: 'Untergang',
            elevation: 'Höhe',
        },
    };

    const G = {
        viewMinX: -270, viewMinY: -270, viewW: 540,
        viewHWithLegend: 580, viewHNoLegend: 540,
        outerFrame: 255, ringOuter: 220, ringInner: 140,
        tickOuter: 218, tickMajor: 200, tickMinor: 205,
        labelRadius: 235,
        handLength: 170, handNeedle: 45, handRadius: 15, centerDot: 7,
        legendY: 290,
    };

    const FONT_UI = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const FONT_MONO = '"SF Mono", Consolas, Menlo, "Roboto Mono", monospace';

    const hourToAngle = (h) => ((((h - 12) / 24) * 360) % 360 + 360) % 360;

    function polar(angleDeg, r) {
        const rad = degToRad(angleDeg - 90);
        return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
    }

    function annularSectorPath(a1, a2, ri, ro) {
        let sweep = a2 - a1;
        if (sweep <= 0) sweep += 360;
        const large = sweep > 180 ? 1 : 0;
        const os = polar(a1, ro), oe = polar(a2, ro), is = polar(a1, ri), ie = polar(a2, ri);
        const f = (n) => n.toFixed(3);
        return `M ${f(os.x)} ${f(os.y)} A ${ro} ${ro} 0 ${large} 1 ${f(oe.x)} ${f(oe.y)} `
             + `L ${f(ie.x)} ${f(ie.y)} A ${ri} ${ri} 0 ${large} 0 ${f(is.x)} ${f(is.y)} Z`;
    }

    function el(tag, attrs, parent) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v !== undefined && v !== null) node.setAttribute(k, v);
        }
        if (parent) parent.appendChild(node);
        return node;
    }

    function parseNumber(value, name, min, max) {
        if (value === undefined || value === null || value === '') return undefined;
        const n = Number(value);
        if (!Number.isFinite(n) || n < min || n > max) {
            throw new Error(`${CARD_TAG}: '${name}' must be a number between ${min} and ${max}`);
        }
        return n;
    }

    // ------------------------------------------------------------------
    // Card element
    // ------------------------------------------------------------------

    class AstroClockCard extends HTMLElement {
        constructor() {
            super();
            this.attachShadow({ mode: 'open' });
            this._config = null;
            this._hass = null;
            this._renderKey = null;
            this._refs = null;
            this._timer = null;
        }

        static getStubConfig() {
            return {};
        }

        setConfig(config) {
            if (!config || typeof config !== 'object') {
                throw new Error(`${CARD_TAG}: invalid configuration`);
            }
            const zones = config.elevation_zones === undefined ? DEFAULT_ZONES : config.elevation_zones;
            if (!Array.isArray(zones) || zones.length > DEFAULT_ZONE_COLORS.length) {
                throw new Error(`${CARD_TAG}: 'elevation_zones' must be a list of up to ${DEFAULT_ZONE_COLORS.length} numbers`);
            }
            const parsedZones = zones
                .map((z) => parseNumber(z, 'elevation_zones', 0, 89.9))
                .sort((a, b) => a - b);
            if (config.time_zone !== undefined && !isValidZone(config.time_zone)) {
                throw new Error(`${CARD_TAG}: unknown time_zone '${config.time_zone}'`);
            }
            if (config.language !== undefined && !isValidLocale(config.language)) {
                throw new Error(`${CARD_TAG}: invalid language '${config.language}' (use e.g. 'en' or 'de-DE')`);
            }
            const lat = parseNumber(config.latitude, 'latitude', -90, 90);
            const lon = parseNumber(config.longitude, 'longitude', -180, 180);
            if ((lat === undefined) !== (lon === undefined)) {
                throw new Error(`${CARD_TAG}: set both 'latitude' and 'longitude', or neither`);
            }
            const zoneColors = Array.isArray(config.elevation_zone_colors) ? config.elevation_zone_colors : [];

            this._config = {
                name: config.name,
                latitude: lat,
                longitude: lon,
                time_zone: config.time_zone,
                language: config.language,
                show_legend: config.show_legend !== false,
                show_times: config.show_times !== false,
                show_elevation: config.show_elevation !== false,
                zones: parsedZones,
                zoneColors: parsedZones.map((_, i) => zoneColors[i] || DEFAULT_ZONE_COLORS[i]),
                colors: { ...DEFAULT_COLORS, ...(config.colors || {}) },
            };
            this._renderKey = null;
            this._update();
        }

        set hass(hass) {
            this._hass = hass;
            this._update();
        }

        getCardSize() {
            return 8;
        }

        getGridOptions() {
            return { columns: 12, min_columns: 6 };
        }

        connectedCallback() {
            if (!this._timer) this._timer = setInterval(() => this._update(), 1000);
            this._update();
        }

        disconnectedCallback() {
            clearInterval(this._timer);
            this._timer = null;
        }

        // ---------- context resolution ----------

        _context() {
            const cfg = this._config;
            const hass = this._hass;
            if (!cfg || !hass) return null;

            const lat = cfg.latitude !== undefined ? cfg.latitude : hass.config && hass.config.latitude;
            const lon = cfg.longitude !== undefined ? cfg.longitude : hass.config && hass.config.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return { error: 'No location available. Set latitude/longitude in the Home Assistant configuration or in the card.' };
            }

            let zone = cfg.time_zone;
            if (!zone) {
                const pref = hass.locale && hass.locale.time_zone;
                zone = pref === 'local'
                    ? Intl.DateTimeFormat().resolvedOptions().timeZone
                    : (hass.config && hass.config.time_zone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
            }

            const langRaw = cfg.language || (hass.locale && hass.locale.language) || hass.language || 'en';
            const lang = isValidLocale(String(langRaw)) ? String(langRaw) : 'en';
            const t = I18N[lang.split('-')[0]] || I18N.en;
            const name = cfg.name !== undefined ? cfg.name : (hass.config && hass.config.location_name) || '';
            return { lat, lon, zone, lang, t, name };
        }

        // ---------- update loop ----------

        _update() {
            const ctx = this._context();
            if (!ctx) return;
            if (ctx.error) {
                if (this._renderKey !== 'error') {
                    this._renderKey = 'error';
                    this._refs = null;
                    this.shadowRoot.innerHTML = `<ha-card><div style="padding:16px;color:var(--error-color,#db4437)">${ctx.error}</div></ha-card>`;
                }
                return;
            }

            const now = Date.now();
            const w = wallClock(now, ctx.zone);
            const key = [w.y, w.m, w.d, ctx.lat, ctx.lon, ctx.zone, ctx.lang, ctx.name].join('|');
            if (key !== this._renderKey) {
                this._renderKey = key;
                this._day = computeDay({ y: w.y, m: w.m, d: w.d }, ctx.lat, ctx.lon, ctx.zone, this._config.zones);
                this._render(ctx);
            }
            this._tick(ctx, now);
        }

        _tick(ctx, now) {
            const r = this._refs;
            if (!r) return;
            const h = this._day.toHour(now);
            r.hand.setAttribute('transform', `rotate(${hourToAngle(h).toFixed(3)})`);
            r.time.textContent = r.timeFormat.format(now);
            r.date.textContent = r.dateFormat.format(now);
            if (r.elevation) {
                const alt = apparentAltitude(sunPosition(now, ctx.lat, ctx.lon).altitude);
                r.elevation.textContent = `${ctx.t.elevation} ${alt.toFixed(1)}°`;
            }
        }

        // ---------- rendering ----------

        _render(ctx) {
            const cfg = this._config;
            const C = cfg.colors;
            const day = this._day;
            const viewH = cfg.show_legend ? G.viewHWithLegend : G.viewHNoLegend;

            this.shadowRoot.innerHTML = `
<style>
  ha-card { padding: 12px; box-sizing: border-box; }
  svg { display: block; width: 100%; height: auto; max-width: 720px; margin: 0 auto; }
  .legend-text { fill: var(--primary-text-color, #e1e1e1); }
</style>
<ha-card></ha-card>`;
            const card = this.shadowRoot.querySelector('ha-card');
            const svg = el('svg', {
                viewBox: `${G.viewMinX} ${G.viewMinY} ${G.viewW} ${viewH}`,
                preserveAspectRatio: 'xMidYMid meet',
                role: 'img',
                'aria-label': 'Astronomical clock',
            });
            card.appendChild(svg);

            el('circle', { cx: 0, cy: 0, r: G.outerFrame, fill: C.face, stroke: C.tick_minor, 'stroke-width': 1 }, svg);

            // Phase ring
            const levelColors = [C.night, C.astronomical_twilight, C.nautical_twilight, C.civil_twilight, C.day]
                .concat(cfg.zoneColors);
            const ring = el('g', {}, svg);
            for (const s of day.segments) this._drawSpan(ring, s.from, s.to, levelColors[s.level]);
            el('circle', { cx: 0, cy: 0, r: G.ringOuter, fill: 'none', stroke: C.face, 'stroke-width': 1.5 }, ring);
            el('circle', { cx: 0, cy: 0, r: G.ringInner, fill: 'none', stroke: C.face, 'stroke-width': 1.5 }, ring);

            this._drawTicks(svg, C);

            // Event markers on the inner edge of the ring
            const markers = el('g', {}, svg);
            for (const h of day.markers) {
                const a = hourToAngle(h);
                const p1 = polar(a, G.ringInner);
                const p2 = polar(a, G.ringInner - 12);
                el('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: C.tick_major, 'stroke-width': 1.4 }, markers);
            }

            // Center panel
            const panel = el('g', {}, svg);
            if (ctx.name) {
                el('text', {
                    x: 0, y: -90, 'text-anchor': 'middle', fill: C.label,
                    'font-size': 16, 'font-weight': 600, 'font-family': FONT_UI, opacity: 0.9,
                }, panel).textContent = ctx.name;
            }
            if (cfg.show_times) this._drawTimes(panel, ctx, C);

            const elevation = cfg.show_elevation
                ? el('text', {
                    x: 0, y: 60, 'text-anchor': 'middle', fill: C.sun,
                    'font-size': 14, 'font-weight': 600, 'font-family': FONT_MONO,
                }, panel)
                : null;
            const time = el('text', {
                x: 0, y: 95, 'text-anchor': 'middle', fill: C.label,
                'font-size': 22, 'font-weight': 700, 'font-family': FONT_MONO, 'letter-spacing': '0.05em',
            }, panel);
            const date = el('text', {
                x: 0, y: 115, 'text-anchor': 'middle', fill: C.label,
                'font-size': 11, 'font-family': FONT_UI, opacity: 0.7,
            }, panel);

            // Hand (built pointing up; rotated on each tick)
            const hand = el('g', {}, svg);
            el('line', { x1: 0, y1: 12, x2: 0, y2: -G.handLength, stroke: C.hand, 'stroke-width': 3, 'stroke-linecap': 'round' }, hand);
            el('line', { x1: 0, y1: -G.handLength, x2: 0, y2: -G.handLength - G.handNeedle, stroke: C.hand, 'stroke-width': 1, 'stroke-linecap': 'round' }, hand);
            el('circle', { cx: 0, cy: -G.handLength, r: G.handRadius, fill: C.hand }, hand);
            el('circle', { cx: 0, cy: 0, r: G.centerDot, fill: C.label }, svg);

            if (cfg.show_legend) this._drawLegend(svg, ctx, levelColors, C);

            this._refs = {
                hand, time, date, elevation,
                timeFormat: new Intl.DateTimeFormat(ctx.lang, {
                    timeZone: ctx.zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
                }),
                dateFormat: new Intl.DateTimeFormat(ctx.lang, {
                    timeZone: ctx.zone, weekday: 'long', day: '2-digit', month: 'short', year: 'numeric',
                }),
            };
        }

        _drawSpan(group, from, to, color) {
            const span = to - from;
            if (span <= 1e-9) return;
            if (span >= 24 - 1e-6) {
                const ro = G.ringOuter, ri = G.ringInner;
                el('path', {
                    d: `M ${ro} 0 A ${ro} ${ro} 0 1 1 ${-ro} 0 A ${ro} ${ro} 0 1 1 ${ro} 0 Z `
                     + `M ${ri} 0 A ${ri} ${ri} 0 1 1 ${-ri} 0 A ${ri} ${ri} 0 1 1 ${ri} 0 Z`,
                    fill: color, 'fill-rule': 'evenodd',
                }, group);
                return;
            }
            el('path', { d: annularSectorPath(hourToAngle(from), hourToAngle(to), G.ringInner, G.ringOuter), fill: color }, group);
        }

        _drawTicks(svg, C) {
            const g = el('g', {}, svg);
            for (let i = 0; i < 144; i++) {
                if (i % 6 === 0) continue;
                const a = hourToAngle(i / 6);
                const p1 = polar(a, G.tickOuter);
                const p2 = polar(a, G.tickOuter - 2);
                el('line', {
                    x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: C.tick_minor,
                    'stroke-width': 0.6, 'stroke-linecap': 'round', opacity: 0.55,
                }, g);
            }
            for (let h = 0; h < 24; h++) {
                const a = hourToAngle(h);
                const major = h % 6 === 0;
                const mid = h % 3 === 0;
                const p1 = polar(a, G.tickOuter);
                const p2 = polar(a, major ? G.tickMajor : (mid ? G.tickMinor : G.tickMinor + 3));
                el('line', {
                    x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
                    stroke: major ? C.tick_major : C.tick_minor,
                    'stroke-width': major ? 2.2 : (mid ? 1.4 : 0.9), 'stroke-linecap': 'round',
                }, g);
                const lp = polar(a, G.labelRadius);
                el('text', {
                    x: lp.x, y: lp.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
                    fill: C.label, 'font-family': FONT_UI,
                    'font-size': major ? 22 : (mid ? 16 : 13),
                    'font-weight': major ? 600 : (mid ? 500 : 400),
                    opacity: major ? 1 : (mid ? 0.9 : 0.7),
                }, g).textContent = String(h).padStart(2, '0');
            }
        }

        _drawTimes(panel, ctx, C) {
            const ev = this._day.events;
            const fmt = new Intl.DateTimeFormat(ctx.lang, {
                timeZone: ctx.zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
            });
            const show = (t) => (t === null ? '—' : fmt.format(t));
            const t = ctx.t;
            const columns = [
                { x: -55, anchor: 'end', rows: [
                    [t.sunrise, ev.sunDawn], [t.civil, ev.civilDawn],
                    [t.nautical, ev.nauticalDawn], [t.astronomical, ev.astronomicalDawn],
                ] },
                { x: 55, anchor: 'start', rows: [
                    [t.sunset, ev.sunDusk], [t.civil, ev.civilDusk],
                    [t.nautical, ev.nauticalDusk], [t.astronomical, ev.astronomicalDusk],
                ] },
            ];
            for (const col of columns) {
                col.rows.forEach(([label, value], i) => {
                    const y = -62 + i * 25;
                    el('text', {
                        x: col.x, y, 'text-anchor': col.anchor, fill: C.label,
                        'font-size': 11, 'font-family': FONT_UI, opacity: 0.75,
                    }, panel).textContent = label;
                    el('text', {
                        x: col.x, y: y + 13, 'text-anchor': col.anchor, fill: C.label,
                        'font-size': 13, 'font-weight': 600, 'font-family': FONT_MONO,
                    }, panel).textContent = show(value);
                });
            }
        }

        _drawLegend(svg, ctx, levelColors, C) {
            const t = ctx.t;
            const labels = [t.night, t.astronomical, t.nautical, t.civil, t.day]
                .concat(this._config.zones.map((z) => `>${z}°`));
            const fontSize = 11, swatch = 12, gap = 5, itemGap = 14, charW = fontSize * 0.55;
            const widths = labels.map((l) => swatch + gap + l.length * charW);
            const total = widths.reduce((a, b) => a + b, 0) + itemGap * (labels.length - 1);
            const scale = Math.min(1, (G.viewW - 20) / total);
            const g = el('g', {
                transform: `translate(${(-total * scale / 2).toFixed(2)} ${G.legendY}) scale(${scale.toFixed(3)})`,
            }, svg);
            let x = 0;
            labels.forEach((label, i) => {
                el('rect', {
                    x, y: -swatch / 2, width: swatch, height: swatch, rx: 2,
                    fill: levelColors[i], stroke: C.tick_minor, 'stroke-width': 0.5,
                }, g);
                el('text', {
                    x: x + swatch + gap, y: 0, 'dominant-baseline': 'central', class: 'legend-text',
                    'font-size': fontSize, 'font-family': FONT_UI,
                }, g).textContent = label;
                x += widths[i] + itemGap;
            });
        }
    }

    if (!customElements.get(CARD_TAG)) {
        customElements.define(CARD_TAG, AstroClockCard);
        window.customCards = window.customCards || [];
        window.customCards.push({
            type: CARD_TAG,
            name: 'Astro Clock Card',
            description: '24-hour astronomical clock with twilight phases and sun elevation zones.',
            preview: true,
        });
        console.info(`%c ASTRO-CLOCK-CARD %c v${VERSION} `,
            'color:#0a0e22;background:#ffd966;font-weight:700', 'color:#ffd966;background:#0a0e22');
    }

    // Exposed for tests only; not part of the card's public API.
    if (typeof window !== 'undefined') {
        window.__astroClockCardInternals = { sunPosition, refractionDeg, computeDay, localMidnight, naiveMs };
    }
})();
