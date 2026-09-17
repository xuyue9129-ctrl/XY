/* 霞图 · 全国朝晚霞预报 */
(function () {
  "use strict";

  const FORECAST = "https://api.open-meteo.com/v1/forecast";
  const AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";
  const BATCH = 20;
  const DAYS = 7;
  const CACHE_KEY = "xy-v9";
  const CACHE_MS = 6 * 60 * 60 * 1000;

  const WX_MODELS = [
    { id: "ecmwf_ifs025", label: "ECMWF", hint: "欧洲中心 IFS，全球综合最稳，推荐" },
    { id: "icon_seamless", label: "ICON", hint: "德国 DWD，云层分层细" },
    { id: "gfs_seamless", label: "GFS", hint: "美国 NOAA，更新勤" },
    { id: "cma_grapes_global", label: "GRAPES", hint: "中国气象局，本土有时更贴" },
    { id: "best_match", label: "自动", hint: "Open-Meteo 就近拼合" }
  ];

  const MAJORS = [
    "北京",
    "上海",
    "广州",
    "深圳",
    "成都",
    "杭州",
    "重庆",
    "西安",
    "武汉",
    "南京",
    "天津",
    "香港",
    "台北",
    "东京",
    "首尔",
    "新加坡",
    "曼谷",
    "吉隆坡",
    "雅加达",
    "新德里",
    "孟买",
    "迪拜",
    "伊斯坦布尔",
    "伦敦",
    "巴黎",
    "罗马",
    "柏林",
    "马德里",
    "巴塞罗那",
    "莫斯科",
    "纽约",
    "洛杉矶",
    "旧金山",
    "芝加哥",
    "多伦多",
    "墨西哥城",
    "圣保罗",
    "里约热内卢",
    "悉尼",
    "墨尔本",
    "开罗"
  ];
  const MAP_LABELS = {
    北京: "right",
    上海: "down",
    广州: "right",
    东京: "right",
    新加坡: "right",
    迪拜: "right",
    伦敦: "right",
    巴黎: "down",
    纽约: "right",
    洛杉矶: "right",
    悉尼: "right",
    开罗: "right",
    里约热内卢: "right",
    莫斯科: "right",
    伊斯坦布尔: "down"
  };

  const HOURLY =
    "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,relative_humidity_2m,precipitation,weather_code";
  const AQ_HOURLY = "pm2_5,aerosol_optical_depth,dust";

  const GRADES = [
    { key: "none", min: 0, label: "难见", hint: "几乎不成霞" },
    { key: "faint", min: 19, label: "淡霞", hint: "地平线一层颜色" },
    { key: "small", min: 35, label: "小烧", hint: "局部有颜色" },
    { key: "mid", min: 50, label: "中烧", hint: "值得出门看一眼" },
    { key: "big", min: 65, label: "大烧", hint: "火烧云机会高" },
    { key: "full", min: 80, label: "满天", hint: "结构好、颜色足" }
  ];

  const state = {
    mode: "sunset",
    dayIndex: 0,
    selected: null,
    places: [],
    map: null,
    markers: new Map(),
    customLayer: null,
    ready: false,
    booted: false,
    loading: true,
    wxModel: "ecmwf_ifs025",
    packs: {},
    error: "",
    horizon: null
  };

  const $ = (id) => document.getElementById(id);

  function trapezoid(x, a, b, c, d) {
    if (x == null || Number.isNaN(x)) return 0;
    if (x <= a || x >= d) return 0;
    if (x >= b && x <= c) return 1;
    if (x < b) return (x - a) / (b - a);
    return (d - x) / (d - a);
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function gradeOf(score) {
    let g = GRADES[0];
    for (const row of GRADES) if (score >= row.min) g = row;
    return g;
  }

  function gradeColor(score) {
    if (score >= 80) return "#ffd08a";
    if (score >= 65) return "#ff5a1f";
    if (score >= 50) return "#f07832";
    if (score >= 35) return "#d4924a";
    if (score >= 19) return "#a89278";
    return "#4e463f";
  }

  function num(v, fallback = null) {
    return v == null || Number.isNaN(Number(v)) ? fallback : Number(v);
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function parseStamp(iso) {
    const [date, time] = String(iso).split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = (time || "00:00").split(":").map(Number);
    return { date, y, m, d, hh, mm: mm || 0 };
  }

  function toDate(iso) {
    const p = parseStamp(iso);
    return new Date(p.y, p.m - 1, p.d, p.hh, p.mm);
  }

  function col(hourly, key, i, fallback) {
    const a = hourly && hourly[key];
    if (!a) return fallback;
    return num(a[i], fallback);
  }

  function sampleAt(hourly, air, i) {
    if (i < 0 || !hourly || !hourly.time || i >= hourly.time.length) return null;
    const t = hourly.time[i];
    let ai = -1;
    if (air && air.time) {
      ai = air.time.indexOf(t);
      if (ai < 0) {
        const prefix = t.slice(0, 13);
        ai = air.time.findIndex((x) => x.startsWith(prefix));
      }
    }
    return {
      high: col(hourly, "cloud_cover_high", i, 0),
      mid: col(hourly, "cloud_cover_mid", i, 0),
      low: col(hourly, "cloud_cover_low", i, 0),
      total: col(hourly, "cloud_cover", i, 0),
      visKm: col(hourly, "visibility", i, 10000) / 1000,
      rh: col(hourly, "relative_humidity_2m", i, 60),
      precip: col(hourly, "precipitation", i, 0),
      weather: col(hourly, "weather_code", i, 0),
      aod: ai >= 0 ? num(air.aerosol_optical_depth[ai], null) : null,
      pm25: ai >= 0 ? num(air.pm2_5[ai], null) : null,
      hourLabel: t.slice(11, 16)
    };
  }

  function pickHour(hourly, air, iso) {
    const event = toDate(iso);
    let best = -1;
    let bestAbs = Infinity;
    hourly.time.forEach((t, i) => {
      const dt = Math.abs(toDate(t) - event);
      if (dt < bestAbs) {
        bestAbs = dt;
        best = i;
      }
    });
    return sampleAt(hourly, air, best);
  }

  function weightedSample(hourly, air, iso, mode) {
    const event = toDate(iso);
    const lo = mode === "sunrise" ? -70 : -55;
    const hi = mode === "sunrise" ? 40 : 65;
    const sigma = 32;
    const ok = [];
    hourly.time.forEach((t, i) => {
      const dt = (toDate(t) - event) / 60000;
      if (dt < lo || dt > hi) return;
      const w = Math.exp(-0.5 * (dt / sigma) ** 2);
      if (w < 0.12) return;
      const s = sampleAt(hourly, air, i);
      if (s) ok.push({ s, w, dt });
    });
    if (!ok.length) {
      const s = pickHour(hourly, air, iso);
      return s ? Object.assign(s, { window: s.hourLabel ? [s.hourLabel] : [] }) : null;
    }
    ok.sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt));
    const keys = ["high", "mid", "low", "total", "visKm", "rh", "precip", "aod", "pm25"];
    const mixed = { weather: ok[0].s.weather, hourLabel: ok[0].s.hourLabel };
    for (const k of keys) {
      let n = 0;
      let d = 0;
      for (const x of ok) {
        if (x.s[k] == null) continue;
        n += x.s[k] * x.w;
        d += x.w;
      }
      mixed[k] = d ? n / d : null;
    }
    mixed.window = ok.map((x) => x.s.hourLabel);
    return mixed;
  }

  function scoreSample(s) {
    if (!s) {
      return {
        score: 0,
        parts: { canvas: 0, horizon: 0, cover: 0, clarity: 0, rain: 1 },
        sample: null
      };
    }

    let rain = 1;
    if (s.precip >= 1.2) rain = 0.12;
    else if (s.precip >= 0.4) rain = 0.38;
    else if (s.precip >= 0.1) rain = 0.7;
    if (s.weather === 45 || s.weather === 48) rain *= 0.4;
    if (s.weather >= 95) rain *= 0.25;

    const highScore = trapezoid(s.high, 6, 32, 68, 96);
    const midScore = trapezoid(s.mid, 8, 24, 50, 88);
    const canvas = clamp(highScore * 0.7 + midScore * 0.3, 0, 1);
    const horizon = clamp(1 - Math.pow(s.low / 100, 1.18), 0, 1);
    const cover = trapezoid(s.total, 8, 28, 62, 96);

    const visScore = clamp((s.visKm - 3.5) / 16.5, 0, 1);
    const rhScore = s.rh <= 52 ? 1 : s.rh >= 92 ? 0.22 : 1 - ((s.rh - 52) / 40) * 0.78;

    let aodScore = 0.72;
    if (s.aod != null) {
      if (s.aod < 0.07) aodScore = 0.84;
      else if (s.aod < 0.28) aodScore = 1;
      else if (s.aod < 0.45) aodScore = 0.68;
      else if (s.aod < 0.75) aodScore = 0.38;
      else aodScore = 0.18;
    } else if (s.pm25 != null) {
      if (s.pm25 < 12) aodScore = 0.86;
      else if (s.pm25 < 35) aodScore = 1;
      else if (s.pm25 < 75) aodScore = 0.66;
      else if (s.pm25 < 150) aodScore = 0.38;
      else aodScore = 0.16;
    }
    const clarity = visScore * 0.46 + rhScore * 0.24 + aodScore * 0.3;

    const dramatic = (canvas * 0.7 + cover * 0.3) * (0.42 + 0.58 * horizon);
    let raw = (dramatic * 0.8 + clarity * 0.2) * rain;
    if (horizon < 0.22) raw *= 0.32;
    if (canvas < 0.1 && horizon > 0.72 && rain > 0.8) {
      raw = clamp(0.16 + clarity * 0.14, 0, 0.3);
    }
    const score = Math.round(clamp(raw, 0, 1) * 100);
    return { score, parts: { canvas, horizon, cover, clarity, rain }, sample: s };
  }

  function eventScore(hourly, air, iso, mode) {
    const mixed = weightedSample(hourly, air, iso, mode);
    const chosen = scoreSample(mixed);
    chosen.window = mixed ? mixed.window : [];
    return chosen;
  }

  function addMinutes(iso, mins) {
    const p = parseStamp(iso);
    const dt = new Date(p.y, p.m - 1, p.d, p.hh, p.mm);
    dt.setMinutes(dt.getMinutes() + mins);
    return pad(dt.getHours()) + ":" + pad(dt.getMinutes());
  }

  function confidence(dayIndex, result) {
    let c = dayIndex <= 0 ? 0.86 : dayIndex === 1 ? 0.78 : dayIndex === 2 ? 0.64 : dayIndex === 3 ? 0.5 : 0.36;
    if (result && result.parts.rain < 0.5) c *= 0.9;
    if (dayIndex >= 4) c *= 0.9;
    const label = c >= 0.75 ? "较高" : c >= 0.55 ? "中等" : "偏低";
    return { value: c, label };
  }

  function diagnose(mode, result) {
    const s = result.sample;
    if (!s) return "这一时次缺少云况，无法判断。";
    const bits = [];
    const side = mode === "sunset" ? "西边" : "东边";
    if (s.precip >= 0.4) bits.push("有降水，云底容易发灰");
    else if (s.weather === 45 || s.weather === 48) bits.push("有雾，通透度会被压低");
    if (result.parts.horizon < 0.34) bits.push(`低云偏多，${side}光路可能被挡`);
    if (result.parts.canvas < 0.14 && result.parts.horizon > 0.6) {
      bits.push("中高云太少，难成火烧云，最多地平线一层颜色");
    } else if (s.high >= 28 && s.low < 42) {
      bits.push("高云够当画布，结构合适");
    }
    if (s.mid >= 22 && s.high >= 18) bits.push("中高云叠层，颜色会比较有层次");
    if (result.parts.clarity < 0.4) bits.push("湿度或气溶胶偏高，颜色容易发糊");
    else if (result.parts.clarity > 0.78) bits.push("空气相对通透");
    if (!bits.length) bits.push("各要素中等，成霞看临近云的空隙");
    return bits.slice(0, 3).join("。") + "。";
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const p = parseStamp(iso);
    return `${pad(p.hh)}:${pad(p.mm)}`;
  }

  function weekday(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  }

  function dayLabel(dateStr, index) {
    if (index === 0) return "今天";
    if (index === 1) return "明天";
    if (index === 2) return "后天";
    return `周${weekday(dateStr)}`;
  }

  function asList(payload) {
    return Array.isArray(payload) ? payload : [payload];
  }

  async function getJSON(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 18000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function wxMeta() {
    return WX_MODELS.find((m) => m.id === state.wxModel) || WX_MODELS[0];
  }

  function weatherURL(lats, lons) {
    const n = String(lats).split(",").length;
    const tzs = Array.from({ length: n }, () => "auto").join(",");
    return `${FORECAST}?latitude=${lats}&longitude=${lons}&hourly=${HOURLY}&daily=sunrise,sunset&timezone=${tzs}&forecast_days=${DAYS}&models=${state.wxModel}`;
  }

  function airURL(lats, lons) {
    const n = String(lats).split(",").length;
    const tzs = Array.from({ length: n }, () => "auto").join(",");
    return `${AIR}?latitude=${lats}&longitude=${lons}&hourly=${AQ_HOURLY}&timezone=${tzs}&forecast_days=${DAYS}&domains=cams_global`;
  }

  function buildDays(weather, air) {
    const days = [];
    const n = weather.daily.time.length;
    for (let i = 0; i < n; i++) {
      const date = weather.daily.time[i];
      const sunrise = weather.daily.sunrise[i];
      const sunset = weather.daily.sunset[i];
      const rise = eventScore(weather.hourly, air && air.hourly, sunrise, "sunrise");
      const set = eventScore(weather.hourly, air && air.hourly, sunset, "sunset");
      days.push({ date, sunrise, sunset, sunriseGlow: rise, sunsetGlow: set });
    }
    return days;
  }

  function currentGlow(place) {
    if (!place.days || !place.days[state.dayIndex]) return null;
    const d = place.days[state.dayIndex];
    return state.mode === "sunset" ? d.sunsetGlow : d.sunriseGlow;
  }

  function currentDay(place) {
    return place.days && place.days[state.dayIndex];
  }

  function alignPayloads(batch, payloads) {
    const list = asList(payloads);
    const used = new Set();
    return batch.map((place) => {
      let bestI = -1;
      let bestD = Infinity;
      list.forEach((o, i) => {
        if (!o || used.has(i) || o.latitude == null) return;
        const d = Math.hypot(o.latitude - place.lat, (o.longitude - place.lon) * Math.cos((place.lat * Math.PI) / 180));
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      });
      if (bestI < 0) return null;
      used.add(bestI);
      return list[bestI];
    });
  }

  async function fetchWeatherBatch(batch) {
    if (!batch.length) return;
    const lats = batch.map((p) => p.lat.toFixed(4)).join(",");
    const lons = batch.map((p) => p.lon.toFixed(4)).join(",");
    let lastErr;
    for (let t = 0; t < 2; t++) {
      try {
        const weatherRaw = await getJSON(weatherURL(lats, lons));
        const weathers = alignPayloads(batch, weatherRaw);
        batch.forEach((place, i) => {
          if (!weathers[i]) return;
          place._weather = weathers[i];
          place.days = buildDays(weathers[i], place._air || null);
        });
        if (batch.some((p) => p.days)) return;
        throw new Error("empty weather batch");
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 350 * (t + 1)));
      }
    }
    throw lastErr;
  }

  async function fetchAirBatch(batch) {
    const ready = batch.filter((p) => p._weather);
    if (!ready.length) return;
    const lats = ready.map((p) => p.lat.toFixed(4)).join(",");
    const lons = ready.map((p) => p.lon.toFixed(4)).join(",");
    try {
      const airRaw = await getJSON(airURL(lats, lons));
      const airs = alignPayloads(ready, airRaw);
      ready.forEach((place, i) => {
        if (!airs[i] || !place._weather) return;
        place._air = airs[i];
        place.days = buildDays(place._weather, airs[i]);
      });
    } catch {
      /* air optional */
    }
  }

  async function fetchOne(lat, lon) {
    const weather = asList(await getJSON(weatherURL(lat.toFixed(4), lon.toFixed(4))))[0];
    const air = await getJSON(airURL(lat.toFixed(4), lon.toFixed(4))).catch(() => null);
    return buildDays(weather, air ? asList(air)[0] : null);
  }

  function cacheSlot() {
    return CACHE_KEY + ":" + state.wxModel;
  }

  function cacheRead() {
    try {
      const raw = localStorage.getItem(cacheSlot()) || sessionStorage.getItem(cacheSlot());
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.t > CACHE_MS) return null;
      return obj.places;
    } catch {
      return null;
    }
  }

  function cacheWrite(places) {
    try {
      const slim = places.map((p) => ({
        id: p.id,
        days: p.days
      }));
      const payload = JSON.stringify({ t: Date.now(), places: slim });
      try {
        localStorage.setItem(cacheSlot(), payload);
      } catch {
        sessionStorage.setItem(cacheSlot(), payload);
      }
    } catch {
      /* quota */
    }
  }

  function snapshotPack() {
    if (!state.places.some((p) => p.days)) return;
    state.packs[state.wxModel] = state.places.map((p) => ({ id: p.id, days: p.days }));
  }

  function restorePack(id) {
    const pack = state.packs[id];
    if (!pack) return false;
    const byId = new Map(pack.map((x) => [x.id, x]));
    state.places.forEach((p) => {
      const hit = byId.get(p.id);
      p.days = hit && hit.days ? hit.days : null;
      p._weather = null;
    });
    return state.places.some((p) => p.days);
  }

  function setStatus(text, kind) {
    const el = $("status");
    el.textContent = text || "";
    el.dataset.kind = kind || "";
    el.hidden = !text;
  }

  function renderDays() {
    const host = $("days");
    const sample = state.places.find((p) => p.days && p.days.length);
    if (!sample) return;
    host.innerHTML = sample.days
      .map((d, i) => {
        const on = i === state.dayIndex ? "on" : "";
        return `<button class="chip ${on}" data-day="${i}" type="button">
          <span>${dayLabel(d.date, i)}</span>
          <small>${d.date.slice(5).replace("-", "/")}</small>
        </button>`;
      })
      .join("");
  }

  function renderRank() {
    const ranked = state.places
      .filter((p) => p.days)
      .map((p) => ({ p, g: currentGlow(p) }))
      .filter((x) => x.g)
      .sort((a, b) => b.g.score - a.g.score);
    const top = ranked.slice(0, 12);
    const sample = state.places.find((p) => p.days);
    const when = sample ? dayLabel(sample.days[state.dayIndex].date, state.dayIndex) : "今日";
    const modeName = state.mode === "sunset" ? "晚霞" : "朝霞";
    const titleEl = $("rank-title");
    if (titleEl) titleEl.textContent = when + modeName + "靠前";
    const rows = top
      .map(({ p, g }, i) => {
        const gr = gradeOf(g.score);
        const on = state.selected && state.selected.id === p.id ? "on" : "";
        return `<button class="rank-row ${on}" data-id="${p.id}" type="button">
          <em>${i + 1}</em>
          <span class="rank-name">${p.name}<small>${p.province}</small></span>
          <span class="rank-grade g-${gr.key}">${gr.label}</span>
          <b style="color:${gradeColor(g.score)}">${g.score}</b>
        </button>`;
      })
      .join("");
    $("rank-list").innerHTML = rows;
    const film = $("film");
    if (film) {
      film.innerHTML = top
        .slice(0, 8)
        .map(({ p, g }) => {
          const gr = gradeOf(g.score);
          return `<button type="button" data-id="${p.id}"><span>${p.name}</span><b style="color:${gradeColor(g.score)}">${g.score}</b><small class="g-${gr.key}">${gr.label}</small></button>`;
        })
        .join("");
    }
    const hot = ranked.filter((x) => x.g.score >= 50).length;
    $("rank-meta").textContent = `${modeName} · ${hot} 城达中烧以上`;
    renderMajors();
  }

  function placeByName(name) {
    return state.places.find((p) => p.name === name && p.id !== "custom");
  }

  function renderMajors() {
    const host = $("majors");
    if (!host) return;
    host.innerHTML = MAJORS.map((name) => {
      const p = placeByName(name);
      if (!p) return "";
      const g = currentGlow(p);
      const score = g ? g.score : "·";
      const on = state.selected && state.selected.id === p.id ? "on" : "";
      const color = g ? gradeColor(g.score) : "var(--faint)";
      return `<button type="button" class="major ${on}" data-id="${p.id}">
        <strong>${name}</strong>
        <b style="color:${color}">${score}</b>
      </button>`;
    }).join("");
  }

  function bar(label, value) {
    const compact = window.innerWidth < 720;
    const text = compact
      ? ({ "画布（中高云）": "画布", "光路（低云越少越好）": "光路" }[label] || label)
      : label;
    const pct = Math.round(clamp(value, 0, 1) * 100);
    return `<div class="bar">
      <span>${text}</span>
      <i><u style="width:${pct}%"></u></i>
      <b>${pct}</b>
    </div>`;
  }

  function renderInspector() {
    const el = $("inspector");
    const place = state.selected;
    if (!place || !place.days) {
      el.hidden = true;
      el.innerHTML = "";
      document.body.classList.remove("has-inspect");
      return;
    }
    const day = currentDay(place);
    const glow = currentGlow(place);
    const gr = gradeOf(glow.score);
    const conf = confidence(state.dayIndex, glow);
    const s = glow.sample;
    const modeName = state.mode === "sunset" ? "晚霞" : "朝霞";
    const eventIso = state.mode === "sunset" ? day.sunset : day.sunrise;
    const eventName = state.mode === "sunset" ? "日落" : "日出";
    const viewFrom = addMinutes(eventIso, state.mode === "sunset" ? -20 : -25);
    const viewTo = addMinutes(eventIso, state.mode === "sunset" ? 25 : 15);
    const hz = state.horizon;
    const strip = place.days
      .map((d, i) => {
        const g = state.mode === "sunset" ? d.sunsetGlow : d.sunriseGlow;
        const gg = gradeOf(g.score);
        return `<button class="strip ${i === state.dayIndex ? "on" : ""}" data-day="${i}" type="button">
          <small>${dayLabel(d.date, i)}</small>
          <b style="color:${gradeColor(g.score)}">${g.score}</b>
          <span class="g-${gg.key}">${gg.label}</span>
        </button>`;
      })
      .join("");

    el.hidden = false;
    document.body.classList.add("has-inspect");
    el.innerHTML = `
      <div class="sheet-handle" aria-hidden="true"></div>
      <button class="close" id="close-inspector" type="button" aria-label="关闭">×</button>
      <p class="kicker">${place.province} · ${place.region}</p>
      <h2>${place.name}</h2>
      <div class="score-row">
        <div class="score" style="color:${gradeColor(glow.score)}">${glow.score}</div>
        <div>
          <div class="grade-label g-${gr.key}">${gr.label}</div>
          <p class="hint">${gr.hint} · ${wxMeta().label} · 置信${conf.label}</p>
        </div>
      </div>
      <p class="clock">${eventName} ${fmtTime(eventIso)} · 建议 ${viewFrom}–${viewTo}</p>
      <p class="horizon">${wxMeta().hint}。气溶胶用 CAMS。当天较准，两天外只是趋势。火烧云是概率不是实况。</p>
      <p class="diag">${diagnose(state.mode, glow)}</p>
      ${bar("画布（中高云）", glow.parts.canvas)}
      ${bar("光路（低云越少越好）", glow.parts.horizon)}
      ${bar("通透", glow.parts.clarity)}
      ${bar("未降水", glow.parts.rain)}
      <dl class="nums">
        <div><dt>高云</dt><dd>${s ? Math.round(s.high) + "%" : "—"}</dd></div>
        <div><dt>中云</dt><dd>${s ? Math.round(s.mid) + "%" : "—"}</dd></div>
        <div><dt>低云</dt><dd>${s ? Math.round(s.low) + "%" : "—"}</dd></div>
        <div><dt>能见度</dt><dd>${s ? s.visKm.toFixed(0) + " km" : "—"}</dd></div>
        <div><dt>湿度</dt><dd>${s ? Math.round(s.rh) + "%" : "—"}</dd></div>
        <div><dt>PM2.5</dt><dd>${s && s.pm25 != null ? s.pm25.toFixed(0) : "—"}</dd></div>
        <div><dt>AOD</dt><dd>${s && s.aod != null ? s.aod.toFixed(2) : "—"}</dd></div>
        <div><dt>${modeName}高峰</dt><dd>${s ? s.hourLabel : "—"}</dd></div>
      </dl>
      ${hz ? `<p class="horizon">${hz.text}</p>` : ""}
      <div class="week">${strip}</div>
    `;
  }

  function markerHtml(place) {
    const g = currentGlow(place);
    const score = g ? g.score : 0;
    const gr = gradeOf(score);
    const hot = score >= 65 ? "hot" : "";
    const on = state.selected && state.selected.id === place.id ? "sel" : "";
    const side = MAP_LABELS[place.name];
    if (side) {
      return `<button class="pin ${side} ${on}" type="button" style="--c:${gradeColor(score)}" data-id="${place.id}" aria-label="${place.name} ${gr.label} ${score}">
        <i class="dot ${hot} g-${gr.key}" style="--c:${gradeColor(score)}"></i>
        <span class="pin-name">${place.name}</span>
      </button>`;
    }
    return `<button class="dot ${hot} ${on} g-${gr.key}" type="button" style="--c:${gradeColor(score)}" data-id="${place.id}" title="${place.name} ${gr.label} ${score}" aria-label="${place.name} ${gr.label} ${score}"><i></i></button>`;
  }

  function upsertMarker(place) {
    const latlng = [place.lat, place.lon];
    const html = markerHtml(place);
    const labeled = Boolean(MAP_LABELS[place.name]);
    const down = MAP_LABELS[place.name] === "down";
    const icon = L.divIcon({
      className: labeled ? "pin-wrap" : "dot-wrap",
      html,
      iconSize: labeled ? (down ? [64, 44] : [78, 28]) : [28, 28],
      iconAnchor: labeled ? (down ? [10, 10] : [10, 14]) : [14, 14]
    });
    let m = state.markers.get(place.id);
    if (!m) {
      m = L.marker(latlng, {
        icon,
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: labeled ? 900 : 0
      }).addTo(state.map);
      m.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectPlace(place.id, true);
      });
      state.markers.set(place.id, m);
    } else {
      m.setIcon(icon);
      m.setLatLng(latlng);
      m.setZIndexOffset(labeled ? 900 : 0);
    }
  }

  function paintMarkers() {
    state.places.forEach(upsertMarker);
  }

  function selectPlace(id, fly) {
    const place = state.places.find((p) => p.id === id);
    if (!place) return;
    state.selected = place;
    state.horizon = null;
    paintMarkers();
    renderRank();
    renderInspector();
    if (fly && state.map) {
      const phone = window.innerWidth < 720 || (window.innerWidth < 1100 && window.innerHeight >= window.innerWidth);
      const z = Math.max(state.map.getZoom(), phone ? 5.4 : 6);
      state.map.flyTo([place.lat, place.lon], z, { duration: 0.55 });
      if (phone) {
        setTimeout(() => {
          if (state.map) state.map.panBy([0, Math.round(window.innerHeight * 0.2)], { animate: true, duration: 0.25 });
        }, 560);
      }
    }
    probeHorizon(place);
  }

  async function probeHorizon(place) {
    const day = currentDay(place);
    if (!day) return;
    const iso = state.mode === "sunset" ? day.sunset : day.sunrise;
    const dlon = state.mode === "sunset" ? -2.1 : 2.1;
    const lat = place.lat;
    const lon = place.lon + dlon;
    const side = state.mode === "sunset" ? "西" : "东";
    try {
      const weather = asList(await getJSON(weatherURL(lat.toFixed(4), lon.toFixed(4))))[0];
      const sample = pickHour(weather.hourly, null, iso);
      if (!sample || state.selected !== place) return;
      const blocked = sample.low >= 55;
      state.horizon = {
        low: sample.low,
        text: `${side}侧约 200 km 低云 ${Math.round(sample.low)}%${blocked ? "，光路偏差" : "，光路相对干净"}`
      };
      renderInspector();
    } catch {
      /* optional */
    }
  }

  function initMap() {
    const map = L.map("map", {
      zoomControl: false,
      attributionControl: false,
      minZoom: 2,
      maxZoom: 11,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      worldCopyJump: true,
      maxBounds: [
        [-85, -180],
        [85, 180]
      ],
      maxBoundsViscosity: 0.6
    });

    L.control.attribution({ prefix: false }).addTo(map);
    map.attributionControl.addAttribution(
      '气象 <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · 气溶胶 CAMS'
    );

    fetch("world.json")
      .then((r) => r.json())
      .then((geo) => {
        L.geoJSON(geo, {
          interactive: false,
          style: {
            color: "rgba(232,177,90,0.22)",
            weight: 0.7,
            fillColor: "#1c1612",
            fillOpacity: 0.94
          }
        }).addTo(map);
      })
      .catch(() => {});

    L.control.zoom({ position: "bottomright" }).addTo(map);

    map.on("click", (e) => {
      if (!state.ready) return;
      addCustom(e.latlng.lat, e.latlng.lng);
    });

    state.map = map;
    fitChina();
    setTimeout(() => {
      map.invalidateSize();
      fitChina();
    }, 200);
  }

  function layoutPadding() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const portrait = h >= w;
    if (w < 720 || (w < 1100 && portrait)) {
      return { paddingTopLeft: [10, 168], paddingBottomRight: [10, 96] };
    }
    if (w < 1100) {
      return { paddingTopLeft: [16, 128], paddingBottomRight: [state.selected ? 340 : 16, 84] };
    }
    return {
      paddingTopLeft: [292, 140],
      paddingBottomRight: [state.selected ? 360 : 24, 56]
    };
  }

  function fitChina() {
    if (!state.map) return;
    const pad = layoutPadding();
    state.map.fitBounds(
      [
        [-48, -140],
        [72, 170]
      ],
      {
        paddingTopLeft: pad.paddingTopLeft,
        paddingBottomRight: pad.paddingBottomRight,
        animate: false,
        maxZoom: wMaxZoom()
      }
    );
  }

  function wMaxZoom() {
    return window.innerWidth < 720 ? 2.6 : 3.1;
  }

  async function addCustom(lat, lon) {
    const id = "custom";
    setStatus("正在计算这个位置…", "load");
    try {
      const days = await fetchOne(lat, lon);
      let place = state.places.find((p) => p.id === id);
      if (!place) {
        place = { id, name: "地图选点", province: "自定义", region: "选点", lat, lon, aliases: "", days };
        state.places.push(place);
      } else {
        place.lat = lat;
        place.lon = lon;
        place.days = days;
      }
      setStatus("");
      selectPlace(id, true);
      renderDays();
    } catch (err) {
      setStatus("这个点没拉到预报，请再试一次", "err");
      console.error(err);
    }
  }

  function bindUI() {
    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mode = btn.dataset.mode;
        document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b === btn));
        refreshView();
        if (state.selected) probeHorizon(state.selected);
      });
    });

    document.querySelectorAll("[data-wx]").forEach((btn) => {
      btn.addEventListener("click", () => setWxModel(btn.dataset.wx));
    });

    $("days").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day]");
      if (!btn) return;
      state.dayIndex = Number(btn.dataset.day);
      refreshView();
    });

    $("majors").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-id]");
      if (btn) selectPlace(btn.dataset.id, true);
    });
    $("rank-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-id]");
      if (btn) selectPlace(btn.dataset.id, true);
    });
    $("film").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-id]");
      if (btn) selectPlace(btn.dataset.id, true);
    });

    $("inspector").addEventListener("click", (e) => {
      if (e.target.id === "close-inspector") {
        state.selected = null;
        paintMarkers();
        renderRank();
        renderInspector();
        return;
      }
      const btn = e.target.closest("[data-day]");
      if (btn) {
        state.dayIndex = Number(btn.dataset.day);
        refreshView();
      }
    });

    $("loc").addEventListener("click", locateMe);

    fetch("/api/info")
      .then((r) => r.json())
      .then((info) => {
        const el = $("phone-url");
        if (!el || !info.urls || !info.urls.length) return;
        const pick =
          info.urls.find((u) => u.indexOf("172.20.") >= 0) ||
          info.urls.find((u) => u.indexOf("192.168.") >= 0) ||
          info.urls.find((u) => u.indexOf("10.") >= 0) ||
          info.urls[0];
        el.hidden = false;
        el.textContent = pick.replace(/^http:\/\//, "手机 ");
        el.href = pick;
      })
      .catch(() => {});

    const q = $("q");
    const box = $("suggest");
    q.addEventListener("input", () => {
      const v = q.value.trim().toLowerCase();
      if (!v) {
        box.hidden = true;
        box.innerHTML = "";
        return;
      }
      const hits = state.places
        .filter((p) => p.id !== "custom")
        .filter((p) => (p.name + p.province + p.aliases).toLowerCase().includes(v))
        .slice(0, 8);
      box.hidden = !hits.length;
      box.innerHTML = hits
        .map((p) => `<button type="button" data-id="${p.id}">${p.name}<small>${p.province}</small></button>`)
        .join("");
    });
    box.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-id]");
      if (!btn) return;
      q.value = "";
      box.hidden = true;
      selectPlace(btn.dataset.id, true);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        box.hidden = true;
        if (state.selected) {
          state.selected = null;
          paintMarkers();
          renderRank();
          renderInspector();
        }
      }
      if (e.key === "/" && document.activeElement !== q) {
        e.preventDefault();
        q.focus();
      }
    });
  }

  function refreshView() {
    renderDays();
    renderRank();
    paintMarkers();
    renderInspector();
    const sample = state.places.find((p) => p.days);
    const date = sample ? sample.days[state.dayIndex].date : "";
    $("headline").textContent =
      (state.mode === "sunset" ? "晚霞" : "朝霞") +
      " · " +
      wxMeta().label +
      (date ? " · " + date.replace(/-/g, ".") : "");
  }

  function locateMe() {
    if (!navigator.geolocation) {
      setStatus("浏览器不支持定位", "err");
      return;
    }
    setStatus("正在定位…", "load");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setStatus("");
        const { latitude, longitude } = pos.coords;
        const near = nearest(latitude, longitude, 80);
        if (near) selectPlace(near.id, true);
        else addCustom(latitude, longitude);
      },
      () => setStatus("定位被拒绝，可直接点地图", "err"),
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }

  function nearest(lat, lon, km) {
    let best = null;
    let bestD = km;
    for (const p of state.places) {
      if (p.id === "custom") continue;
      const d = haversine(lat, lon, p.lat, p.lon);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  function haversine(a, b, c, d) {
    const R = 6371;
    const toR = (x) => (x * Math.PI) / 180;
    const dLat = toR(c - a);
    const dLon = toR(d - b);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function seedPlaces() {
    return window.XIATU_CITIES.map(([name, province, region, lat, lon, aliases]) => ({
      id: name + "-" + province,
      name,
      province,
      region,
      lat,
      lon,
      aliases: aliases || ""
    }));
  }

  async function loadAll() {
    state.places = seedPlaces();
    renderMajors();
    const cached = cacheRead();
    if (cached && cached.length) {
      const byId = new Map(cached.map((p) => [p.id, p]));
      state.places.forEach((p) => {
        const hit = byId.get(p.id);
        if (hit && hit.days) p.days = hit.days;
      });
      if (state.places.some((p) => p.days)) afterLoad();
    }

    const majors = MAJORS.map(placeByName).filter(Boolean);
    const rest = state.places.filter((p) => p.id !== "custom" && majors.indexOf(p) < 0);

    setStatus("正在加载热门城市云况…", "load");
    try {
      await Promise.all(chunk(majors, BATCH).map((b) => fetchWeatherBatch(b)));
      snapshotPack();
      afterLoad();
      setStatus("");
    } catch (err) {
      console.error(err);
      if (!state.booted) setStatus("热门城市暂时拉不到，稍后会再试", "err");
    }

    chunk(rest, BATCH)
      .reduce(
        (prev, batch) =>
          prev.then(async () => {
            try {
              await fetchWeatherBatch(batch);
              if (state.booted) {
                paintMarkers();
                renderRank();
              }
            } catch (e) {
              console.error(e);
            }
          }),
        Promise.resolve()
      )
      .then(() => {
        snapshotPack();
        cacheWrite(state.places);
        if (state.booted) refreshView();
        return Promise.all(chunk(majors.concat(rest), BATCH).map((b) => fetchAirBatch(b)));
      })
      .then(() => {
        snapshotPack();
        cacheWrite(state.places);
        if (state.booted) refreshView();
      })
      .catch((err) => console.error(err));
  }

  async function setWxModel(id) {
    if (!id || id === state.wxModel) return;
    snapshotPack();
    state.wxModel = id;
    document.querySelectorAll("[data-wx]").forEach((b) => b.classList.toggle("on", b.dataset.wx === id));
    if (restorePack(id)) {
      refreshView();
      if (state.selected) probeHorizon(state.selected);
      return;
    }
    const cached = cacheRead();
    if (cached && cached.length) {
      const byId = new Map(cached.map((p) => [p.id, p]));
      state.places.forEach((p) => {
        const hit = byId.get(p.id);
        p.days = hit && hit.days ? hit.days : null;
        p._weather = null;
      });
      if (state.places.some((p) => p.days)) {
        snapshotPack();
        refreshView();
      }
    } else {
      state.places.forEach((p) => {
        p.days = null;
        p._weather = null;
      });
    }
    const majors = MAJORS.map(placeByName).filter(Boolean);
    const rest = state.places.filter((p) => p.id !== "custom" && majors.indexOf(p) < 0);
    setStatus("正在切换到 " + wxMeta().label + "…", "load");
    try {
      await Promise.all(chunk(majors, BATCH).map((b) => fetchWeatherBatch(b)));
      snapshotPack();
      refreshView();
      setStatus("");
      if (state.selected) probeHorizon(state.selected);
    } catch (err) {
      console.error(err);
      setStatus(wxMeta().label + " 暂时不可用", "err");
      return;
    }
    for (const batch of chunk(rest, BATCH)) {
      try {
        await fetchWeatherBatch(batch);
        paintMarkers();
        renderRank();
      } catch (e) {
        console.error(e);
      }
    }
    snapshotPack();
    cacheWrite(state.places);
    refreshView();
    Promise.all(chunk(state.places.filter((p) => p.id !== "custom"), BATCH).map((b) => fetchAirBatch(b)))
      .then(() => {
        snapshotPack();
        cacheWrite(state.places);
        refreshView();
      })
      .catch(() => {});
  }

  function afterLoad() {
    const hour = new Date().getHours();
    if (!state.booted && hour < 10) state.mode = "sunrise";
    document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
    document.querySelectorAll("[data-wx]").forEach((b) => b.classList.toggle("on", b.dataset.wx === state.wxModel));
    state.ready = true;
    state.loading = false;
    refreshView();
    if (!state.booted) {
      const home = placeByName("北京");
      if (home) selectPlace(home.id, false);
    }
    state.booted = true;
    fitChina();
  }

  function boot() {
    initMap();
    bindUI();
    loadAll();
    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.map) return;
        state.map.invalidateSize();
        fitChina();
      }, 180);
    };
    window.addEventListener("resize", onResize);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", onResize);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
