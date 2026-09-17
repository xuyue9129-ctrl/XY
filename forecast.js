/* Heuristic viewing index, not a calibrated probability. All calculations use UTC seconds. */
(function (root) {
  "use strict";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  const rad = Math.PI / 180;
  const fields = {
    high: "cloud_cover_high", mid: "cloud_cover_mid", low: "cloud_cover_low",
    total: "cloud_cover", visKm: "visibility", rh: "relative_humidity_2m",
    precip: "precipitation", weather: "weather_code", aod: "aerosol_optical_depth", pm25: "pm2_5"
  };
  const required = ["high", "mid", "low", "total", "precip", "weather"];
  function trapezoid(x, a, b, c, d) {
    if (!finite(x) || x <= a || x >= d) return 0;
    if (x >= b && x <= c) return 1;
    return x < b ? (x - a) / (b - a) : (d - x) / (d - c);
  }
  function localDate(t, zone = "UTC") {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date(t * 1000));
    const get = (type) => p.find((v) => v.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function fmtTime(t, zone = "UTC") {
    if (!finite(t) || t <= 0) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(t * 1000));
  }
  function valueAt(hourly, key, t, interval = false) {
    if (!hourly?.time?.length || !hourly[key] || !finite(t)) return null;
    const times = hourly.time;
    if (t < times[0] || t > times[times.length - 1]) return null;
    let hi = times.findIndex((x) => x >= t);
    if (hi < 0) return null;
    const right = hourly[key][hi];
    if (times[hi] === t || interval) return finite(right) ? right : null;
    const lo = hi - 1;
    const left = hourly[key][lo];
    // Never extrapolate across a missing hour or beyond model coverage.
    if (!finite(left) || !finite(right) || times[hi] - times[lo] > 3600) return null;
    return left + (right - left) * (t - times[lo]) / (times[hi] - times[lo]);
  }
  function sampleAt(hourly, air, t) {
    const s = {};
    for (const [key, field] of Object.entries(fields)) {
      // Precipitation/code refer to the preceding hour: do not interpolate away showers.
      s[key] = valueAt(key === "aod" || key === "pm25" ? air : hourly, field, t,
        key === "precip" || key === "weather");
    }
    if (s.visKm != null) s.visKm /= 1000;
    for (const key of ["high", "mid", "low", "total", "rh"]) {
      if (s[key] != null && (s[key] < 0 || s[key] > 100)) s[key] = null;
    }
    for (const key of ["visKm", "precip", "aod", "pm25"]) {
      if (s[key] != null && s[key] < 0) s[key] = null;
    }
    return s;
  }
  function unavailable(reason) {
    return { score: null, sample: null, parts: {}, quality: 0, reason };
  }
  function scoreSample(s) {
    if (!s || required.some((k) => !finite(s[k]))) return unavailable("关键云况或降水数据缺失");
    let rain = s.precip >= 1.2 ? 0.12 : s.precip >= 0.4 ? 0.38 : s.precip >= 0.1 ? 0.7 : 1;
    if ([45, 48].includes(s.weather)) rain *= 0.4;
    if (s.weather >= 95) rain *= 0.25;
    const high = trapezoid(s.high, 6, 32, 68, 120);
    const mid = trapezoid(s.mid, 8, 24, 50, 100);
    // Layer cloud diagnostics can disagree with native total cover (notably IFS).
    // Sparse total cover must limit the available illuminated cloud canvas.
    const canvas = clamp(high * 0.7 + mid * 0.3, 0, 1) * clamp(s.total / 28, 0, 1);
    const horizon = clamp(1 - (s.low / 100) ** 1.18, 0, 1);
    const cover = trapezoid(s.total, 8, 28, 62, 110);
    // Missing optional measurements stay missing in the UI; no invented visibility/RH.
    const clarityTerms = [];
    if (finite(s.visKm)) clarityTerms.push([clamp((s.visKm - 2) / 18, 0, 1), 0.65]);
    if (finite(s.rh)) clarityTerms.push([1 - 0.4 * clamp((s.rh - 65) / 35, 0, 1), 0.1]);
    if (finite(s.aod)) clarityTerms.push([Math.exp(-1.5 * s.aod), 0.25]);
    else if (finite(s.pm25)) clarityTerms.push([Math.exp(-s.pm25 / 100), 0.15]);
    const weight = clarityTerms.reduce((n, x) => n + x[1], 0);
    const clarity = weight ? clarityTerms.reduce((n, x) => n + x[0] * x[1], 0) / weight : 0.55;
    let raw = ((canvas * 0.7 + cover * 0.3) * (0.25 + 0.75 * horizon) * 0.8 + clarity * 0.2) * rain;
    if (horizon < 0.22) raw *= 0.32;
    // Only genuinely sparse clouds receive a clear-sky twilight floor. Thick overcast does not.
    if (s.high < 8 && s.mid < 8 && s.total < 15 && s.low < 15 && rain > 0.8) {
      raw = Math.min(0.28, 0.12 + clarity * 0.14);
    }
    // Conservative transmission gates: upper clouds cannot compensate for haze/fog.
    // These empirical factors deliberately trade missed events for fewer false alarms.
    const visibilityGate = finite(s.visKm) ? 0.15 + 0.85 * clamp(s.visKm / 15, 0, 1) : 0.85;
    const aerosolGate = finite(s.aod) ? 0.25 + 0.75 * Math.exp(-1.5 * s.aod)
      : finite(s.pm25) ? 0.25 + 0.75 * Math.exp(-s.pm25 / 65) : 0.85;
    const humidityGate = finite(s.rh) ? 1 - 0.2 * clamp((s.rh - 80) / 20, 0, 1) : 0.95;
    raw *= visibilityGate * aerosolGate * humidityGate;
    // Missing extinction data cannot substantiate a strong-glow label.
    if (!finite(s.visKm) || (!finite(s.aod) && !finite(s.pm25))) raw = Math.min(raw, 0.49);
    const consistent = s.total + 15 >= Math.max(s.high, s.mid, s.low);
    const quality = (0.65 + (finite(s.visKm) ? 0.15 : 0) + (finite(s.rh) ? 0.05 : 0) +
      (finite(s.aod) || finite(s.pm25) ? 0.15 : 0)) * (consistent ? 1 : 0.8);
    return { score: Math.round(clamp(raw, 0, 1) * 100), parts: { canvas, horizon, cover, clarity, rain }, sample: s, quality };
  }
  // Low-precision solar ephemeris; azimuth clockwise from true north, geometric elevation.
  function sunPosition(t, lat, lon) {
    const d = t / 86400 + 2440587.5 - 2451545;
    const g = (357.529 + 0.98560028 * d) * rad;
    const q = (280.459 + 0.98564736 * d) * rad;
    const L = q + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const decl = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const hour = (280.46061837 + 360.98564736629 * d + lon) * rad - ra;
    const phi = lat * rad;
    const elevation = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hour)) / rad;
    const azimuth = (Math.atan2(Math.sin(hour), Math.cos(hour) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / rad + 180 + 360) % 360;
    return { elevation, azimuth };
  }
  function destination(lat, lon, bearing, km) {
    const d = km / 6371, b = bearing * rad, p = lat * rad, l = lon * rad;
    const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b));
    const l2 = l + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
    return { lat: p2 / rad, lon: ((l2 / rad + 540) % 360) - 180 };
  }
  function eventScore(hourly, air, event, mode, lat, lon) {
    if (!finite(event) || event <= 0) return unavailable("当天无日出／日落事件（可能为极昼或极夜）");
    const offsets = [];
    for (let m = -120; m <= 120; m += 10) {
      const pos = sunPosition(event + m * 60, lat, lon);
      if (pos.elevation >= -6 && pos.elevation <= 2) offsets.push(m);
    }
    if (!offsets.length) return unavailable("当天无适合此日出／日落的曙暮光时段");
    const samples = offsets.map((m) => {
      const t = event + m * 60;
      const r = scoreSample(sampleAt(hourly, air, t));
      return { r, t, w: Math.exp(-0.5 * ((m - (mode === "sunrise" ? -8 : 8)) / 25) ** 2) };
    });
    const valid = samples.filter((x) => finite(x.r.score));
    if (valid.length < Math.ceil(samples.length * 0.6)) return unavailable("事件附近的逐小时数据不足");
    const sum = valid.reduce((n, x) => n + x.w, 0);
    const avg = (fn) => valid.reduce((n, x) => n + fn(x) * x.w, 0) / sum;
    const base = valid.reduce((a, b) => Math.abs(a.t - event) < Math.abs(b.t - event) ? a : b).r;
    const score = Math.round(avg((x) => x.r.score));
    const spread = Math.max(...valid.map((x) => x.r.score)) - Math.min(...valid.map((x) => x.r.score));
    return { ...base, score, baseScore: score, quality: avg((x) => x.r.quality) * valid.length / samples.length,
      parts: Object.fromEntries(Object.keys(base.parts).map((k) => [k, avg((x) => x.r.parts[k])])),
      spread, event, mode, viewFrom: samples[0].t, viewTo: samples[samples.length - 1].t,
      missing: Object.keys(fields).filter((k) => !finite(base.sample[k])), horizon: null };
  }
  function applyHorizon(result, samples, azimuth) {
    if (!finite(result?.baseScore)) return result;
    const valid = samples.filter((s) => finite(s.low) && finite(s.mid) && finite(s.precip));
    if (valid.length < 3) return { ...result, horizon: { available: false } };
    const obstruction = valid.reduce((n, s) => n + clamp(s.low / 100 * 0.75 + s.mid / 100 * 0.15 + Math.min(s.precip, 1) * 0.1, 0, 1), 0) / valid.length;
    // Sparse remote samples only support a bounded penalty, not a claim of cloud optical depth.
    const factor = 1 - obstruction * 0.4;
    return { ...result, score: Math.round(result.baseScore * factor),
      horizon: { available: true, azimuth, obstruction, count: valid.length, factor } };
  }
  function buildDays(weather, air, now = Date.now()) {
    if (!weather?.daily?.time || !weather.hourly?.time) throw new Error("预报数据结构不完整");
    const zone = weather.timezone || "UTC";
    return weather.daily.time.map((t, i) => {
      const sunrise = weather.daily.sunrise?.[i], sunset = weather.daily.sunset?.[i];
      return { date: localDate(t, zone), timezone: zone, fetchedAt: now,
        sunrise, sunset,
        sunriseGlow: eventScore(weather.hourly, air?.hourly, sunrise, "sunrise", weather.latitude, weather.longitude),
        sunsetGlow: eventScore(weather.hourly, air?.hourly, sunset, "sunset", weather.latitude, weather.longitude) };
    });
  }
  const api = { clamp, finite, trapezoid, localDate, fmtTime, valueAt, sampleAt, scoreSample,
    sunPosition, destination, eventScore, applyHorizon, buildDays };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GlowForecast = api;
})(typeof globalThis === "object" ? globalThis : this);
