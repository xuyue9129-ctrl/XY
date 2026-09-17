/* 霞图 · 全国朝晚霞预报 */
(function () {
  "use strict";

  const FORECAST = "https://api.open-meteo.com/v1/forecast";
  const AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";
  const BATCH = 20;
  const DAYS = 7;
  const CACHE_KEY = "glow-v14";
  const CACHE_MS = 30 * 60 * 1000;

  const WX_MODELS = [
    { id: "ecmwf_ifs025", label: "ECMWF", hint: "欧洲中心 IFS，单模型参考" },
    { id: "icon_seamless", label: "ICON", hint: "德国 DWD，云层分层细" },
    { id: "gfs_seamless", label: "GFS", hint: "美国 NOAA，更新勤" },
    { id: "cma_grapes_global", label: "GRAPES", hint: "中国气象局 GRAPES，单模型参考" },
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
    horizon: null,
    generation: 0,
    probeToken: 0,
    customToken: 0,
    horizonCache: new Map()
  };

  const $ = (id) => document.getElementById(id);

  const F = window.GlowForecast;
  const { clamp, buildDays, fmtTime } = F;

  function gradeOf(score) {
    if (!F.finite(score)) return { key: "unknown", label: "暂无预报", hint: "数据不足，暂不评分" };
    let g = GRADES[0];
    for (const row of GRADES) if (score >= row.min) g = row;
    return g;
  }
  function gradeColor(score) {
    if (!F.finite(score)) return "#8c8c8c";
    if (score >= 80) return "#ffd08a";
    if (score >= 65) return "#ff5a1f";
    if (score >= 50) return "#f07832";
    if (score >= 35) return "#d4924a";
    if (score >= 19) return "#a89278";
    return "#4e463f";
  }
  function display(value, suffix = "", digits = 0) {
    return F.finite(value) ? value.toFixed(digits) + suffix : "—";
  }
  function confidence(dayIndex, result, day) {
    if (!F.finite(result?.score)) return { label: "无法判断" };
    const lead = Math.max(0, (result.event * 1000 - Date.now()) / 86400000);
    let value = lead < 1 ? 0.82 : lead < 2 ? 0.72 : lead < 3 ? 0.60 : lead < 4 ? 0.48 : 0.32;
    value *= result.quality;
    if (result.spread > 25) value *= 0.8;
    if (!result.horizon?.available) value *= 0.9;
    if (Date.now() - day.fetchedAt > CACHE_MS) value *= 0.7;
    return { label: value >= 0.7 ? "较高" : value >= 0.45 ? "中等" : "偏低" };
  }
  function diagnose(mode, result) {
    const s = result.sample;
    if (!s) return result.reason || "这一时次缺少云况，无法判断。";
    const bits = [];
    if (s.precip >= 0.4) bits.push("有降水，云底容易发灰");
    if ([45, 48].includes(s.weather)) bits.push("有雾，通透度受限");
    if (s.low >= 65) bits.push("本地低云偏多，可能遮挡视野");
    if (s.high < 8 && s.mid < 8) bits.push("中高云偏少，以地平线淡霞为主");
    else if (result.parts.canvas >= 0.5) bits.push("中高云有利于呈现霞光");
    if (result.horizon?.available && result.horizon.obstruction > 0.45) bits.push("太阳方向云雨较多，已下调指数");
    if (result.parts.clarity < 0.4) bits.push("空气通透度较差");
    if (s.aod >= 0.45 || s.pm25 >= 75) bits.push("霾或气溶胶偏多，已保守下调指数");
    if (s.total + 15 < Math.max(s.high, s.mid, s.low)) bits.push("总云量与分层云量不一致，已保守处理");
    if (result.spread > 25) bits.push("时段内云况变化较大，结果不稳定");
    if (!bits.length) bits.push("成霞仍取决于临近云层空隙");
    return bits.slice(0, 3).join("。") + "。";
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
      return await res.json();
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

  function weatherURL(lats, lons, model = state.wxModel) {
    const n = String(lats).split(",").length;
    const tzs = Array.from({ length: n }, () => "auto").join(",");
    return `${FORECAST}?latitude=${lats}&longitude=${lons}&hourly=${HOURLY}&daily=sunrise,sunset&timezone=${tzs}&timeformat=unixtime&forecast_days=${DAYS}&models=${model}`;
  }

  function airURL(lats, lons) {
    const n = String(lats).split(",").length;
    const tzs = Array.from({ length: n }, () => "auto").join(",");
    return `${AIR}?latitude=${lats}&longitude=${lons}&hourly=${AQ_HOURLY}&timezone=${tzs}&timeformat=unixtime&forecast_days=${DAYS}&domains=cams_global`;
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
    // Open-Meteo returns coordinates in request order. Grid snapping is not identity.
    return batch.map((_, i) => list[i] || null);
  }
  async function fetchWeatherBatch(batch, model, generation) {
    if (!batch.length || generation !== state.generation) return;
    const lats = batch.map((p) => p.lat.toFixed(4)).join(",");
    const lons = batch.map((p) => p.lon.toFixed(4)).join(",");
    const raw = await getJSON(weatherURL(lats, lons, model));
    if (generation !== state.generation) return;
    const weathers = alignPayloads(batch, raw);
    batch.forEach((place, i) => {
      if (!weathers[i]?.daily || !weathers[i]?.hourly) return;
      place._weather = weathers[i];
      place.days = buildDays(weathers[i], null);
    });
  }
  async function fetchAirBatch(batch, generation) {
    const ready = batch.filter((p) => p._weather);
    if (!ready.length || generation !== state.generation) return;
    try {
      const lats = ready.map((p) => p.lat.toFixed(4)).join(",");
      const lons = ready.map((p) => p.lon.toFixed(4)).join(",");
      const raw = await getJSON(airURL(lats, lons));
      if (generation !== state.generation) return;
      const airs = alignPayloads(ready, raw);
      ready.forEach((place, i) => {
        if (!airs[i]?.hourly || !place._weather) return;
        place.days = buildDays(place._weather, airs[i], place.days[0].fetchedAt);
      });
    } catch { /* Air data is optional; keep missing values visible. */ }
  }
  async function fetchOne(lat, lon, model) {
    const [weather, air] = await Promise.all([
      getJSON(weatherURL(lat.toFixed(4), lon.toFixed(4), model)),
      getJSON(airURL(lat.toFixed(4), lon.toFixed(4))).catch(() => null)
    ]);
    return buildDays(asList(weather)[0], air ? asList(air)[0] : null);
  }
  function cacheSlot() { return CACHE_KEY + ":" + state.wxModel; }
  function freshDays(days) {
    return days?.length && Date.now() - days[0].fetchedAt < CACHE_MS &&
      days[0].date === F.localDate(Date.now() / 1000, days[0].timezone);
  }
  function cacheRead() {
    try {
      const obj = JSON.parse(localStorage.getItem(cacheSlot()) || sessionStorage.getItem(cacheSlot()) || "null");
      if (!obj || Date.now() - obj.t > CACHE_MS) return null;
      return obj.places.filter((p) => freshDays(p.days));
    } catch { return null; }
  }
  function cacheWrite() {
    try {
      const places = state.places.filter((p) => p.id !== "custom" && freshDays(p.days))
        .map((p) => ({ id: p.id, days: p.days }));
      const payload = JSON.stringify({ t: Date.now(), places });
      try { localStorage.setItem(cacheSlot(), payload); }
      catch { sessionStorage.setItem(cacheSlot(), payload); }
    } catch { /* Storage is optional. */ }
  }
  function setStatus(text, kind) {
    const el = $("status");
    el.textContent = text || "";
    el.dataset.kind = kind || "";
    el.hidden = !text;
  }

  function renderDays() {
    const host = $("days");
    const sample = state.selected?.days ? state.selected : state.places.find((p) => p.days?.length);
    if (!sample) { host.innerHTML = ""; return; }
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
      .filter((x) => F.finite(x.g?.score))
      .sort((a, b) => b.g.score - a.g.score);
    const top = ranked.slice(0, 12);
    const when = state.dayIndex === 0 ? "各地今日" : `各地第 ${state.dayIndex + 1} 天`;
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
          <b style="color:${gradeColor(g.score)}">${display(g.score)}</b>
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
          return `<button type="button" data-id="${p.id}"><span>${p.name}</span><b style="color:${gradeColor(g.score)}">${display(g.score)}</b><small class="g-${gr.key}">${gr.label}</small></button>`;
        })
        .join("");
    }
    const hot = ranked.filter((x) => x.g.score >= 50).length;
    $("rank-meta").textContent = `${modeName} · ${hot} 城达中烧以上 · 点选核对光路`;
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
      const score = display(g?.score);
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
    const pct = F.finite(value) ? Math.round(clamp(value, 0, 1) * 100) : 0;
    return `<div class="bar">
      <span>${text}</span>
      <i><u style="width:${pct}%"></u></i>
      <b>${F.finite(value) ? pct : "—"}</b>
    </div>`;
  }

  function renderInspector() {
    const el = $("inspector");
    const place = state.selected;
    if (!place || !place.days?.[state.dayIndex]) {
      el.hidden = true;
      el.innerHTML = "";
      document.body.classList.remove("has-inspect");
      return;
    }
    const day = currentDay(place);
    const glow = currentGlow(place);
    const gr = gradeOf(glow.score);
    const conf = confidence(state.dayIndex, glow, day);
    const s = glow.sample;
    const modeName = state.mode === "sunset" ? "晚霞" : "朝霞";
    const eventIso = state.mode === "sunset" ? day.sunset : day.sunrise;
    const eventName = state.mode === "sunset" ? "日落" : "日出";
    const viewFrom = fmtTime(glow.viewFrom, day.timezone);
    const viewTo = fmtTime(glow.viewTo, day.timezone);
    const hz = glow.horizon;
    const hzText = hz?.available
      ? `太阳方位 ${Math.round(hz.azimuth)}° · 前方 50–150 km 共 ${hz.count} 个采样点，已计入指数；未考虑山体与建筑遮挡。`
      : state.horizon?.text || "远处光路尚未核对；当前为本地云况估计。";
    const dataNote = s ? [s.visKm == null ? "能见度缺测" : "", s.aod == null && s.pm25 == null ? "气溶胶缺测" : ""].filter(Boolean).join("、") : "";
    const past = F.finite(eventIso) && eventIso * 1000 < Date.now();
    const strip = place.days
      .map((d, i) => {
        const g = state.mode === "sunset" ? d.sunsetGlow : d.sunriseGlow;
        const gg = gradeOf(g.score);
        return `<button class="strip ${i === state.dayIndex ? "on" : ""}" data-day="${i}" type="button">
          <small>${dayLabel(d.date, i)}</small>
          <b style="color:${gradeColor(g.score)}">${display(g.score)}</b>
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
        <div class="score" style="color:${gradeColor(glow.score)}">${display(glow.score)}</div>
        <div>
          <div class="grade-label g-${gr.key}">${gr.label}</div>
          <p class="hint">${gr.hint} · ${wxMeta().label} · 参考信心${conf.label}</p>
        </div>
      </div>
      <p class="clock">${day.date} · ${eventName} ${fmtTime(eventIso, day.timezone)}${past ? "（已过）" : ""}<br>当地时间 ${day.timezone} · 参考时段 ${viewFrom}–${viewTo}</p>
      <p class="horizon">保守观赏指数 0–100，非发生概率。${wxMeta().hint}；两天外仅供趋势参考。关键通透度数据缺失时，最高按小烧评估。</p>
      <p class="diag">${diagnose(state.mode, glow)}</p>
      ${bar("画布（中高云）", glow.parts.canvas)}
      ${bar("光路（低云越少越好）", glow.parts.horizon)}
      ${bar("通透", glow.parts.clarity)}
      ${bar("未降水", glow.parts.rain)}
      <dl class="nums">
        <div><dt>高云</dt><dd>${display(s?.high, "%")}</dd></div>
        <div><dt>中云</dt><dd>${display(s?.mid, "%")}</dd></div>
        <div><dt>低云</dt><dd>${display(s?.low, "%")}</dd></div>
        <div><dt>能见度</dt><dd>${display(s?.visKm, " km")}</dd></div>
        <div><dt>湿度</dt><dd>${display(s?.rh, "%")}</dd></div>
        <div><dt>PM2.5</dt><dd>${s && s.pm25 != null ? s.pm25.toFixed(0) : "—"}</dd></div>
        <div><dt>AOD</dt><dd>${s && s.aod != null ? s.aod.toFixed(2) : "—"}</dd></div>
        <div><dt>数据获取</dt><dd>${fmtTime(day.fetchedAt / 1000, day.timezone)}</dd></div>
      </dl>
      <p class="horizon">${hzText}</p>
      ${dataNote ? `<p class="horizon">${dataNote}，已降低参考信心。</p>` : ""}
      ${Date.now() - day.fetchedAt > CACHE_MS ? '<p class="horizon">缓存已过期，正在尝试更新；请勿用于临近判断。</p>' : ""}
      <div class="week">${strip}</div>
    `;
  }

  function markerHtml(place) {
    const g = currentGlow(place);
    const score = g?.score;
    const gr = gradeOf(score);
    const hot = score >= 65 ? "hot" : "";
    const on = state.selected && state.selected.id === place.id ? "sel" : "";
    const side = MAP_LABELS[place.name];
    if (side) {
      return `<button class="pin ${side} ${on}" type="button" style="--c:${gradeColor(score)}" data-id="${place.id}" aria-label="${place.name} ${gr.label} ${display(score)}">
        <i class="dot ${hot} g-${gr.key}" style="--c:${gradeColor(score)}"></i>
        <span class="pin-name">${place.name}</span>
      </button>`;
    }
    return `<button class="dot ${hot} ${on} g-${gr.key}" type="button" style="--c:${gradeColor(score)}" data-id="${place.id}" title="${place.name} ${gr.label} ${display(score)}" aria-label="${place.name} ${gr.label} ${display(score)}"><i></i></button>`;
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
    renderDays();
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
    const day = currentDay(place), mode = state.mode, model = state.wxModel;
    const token = ++state.probeToken, generation = state.generation;
    state.horizon = null;
    if (!day) return;
    const key = mode === "sunset" ? "sunsetGlow" : "sunriseGlow";
    const glow = day[key];
    if (!F.finite(glow?.score)) return;
    const azimuth = F.sunPosition(glow.event, place.lat, place.lon).azimuth;
    const points = [[50, 0], [150, 0], [150, -15], [150, 15]]
      .map(([km, delta]) => F.destination(place.lat, place.lon, azimuth + delta, km));
    const cacheKey = `${model}:${place.lat}:${place.lon}:${glow.event}`;
    const cached = state.horizonCache.get(cacheKey);
    if (cached && Date.now() - cached.t < CACHE_MS && glow.horizon?.available) return;
    state.horizon = { text: "正在核对太阳方向的远处云况…" };
    renderInspector();
    try {
      let samples;
      if (cached && Date.now() - cached.t < CACHE_MS) samples = cached.samples;
      else {
        const raw = await getJSON(weatherURL(points.map((p) => p.lat.toFixed(4)).join(","), points.map((p) => p.lon.toFixed(4)).join(","), model));
        samples = asList(raw).map((w) => F.sampleAt(w.hourly, null, glow.event));
        state.horizonCache.set(cacheKey, { t: Date.now(), samples });
      }
      if (token !== state.probeToken || generation !== state.generation || state.selected !== place || day !== currentDay(place) || mode !== state.mode) return;
      day[key] = F.applyHorizon(day[key], samples, azimuth);
      state.horizon = { text: "远处云况缺测，指数暂未加入光路修正。" };
      renderRank(); paintMarkers(); renderInspector();
    } catch {
      if (token !== state.probeToken || generation !== state.generation) return;
      state.horizon = { text: "远处云况暂不可用，指数暂未加入光路修正。" };
      renderInspector();
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
    const top = Math.ceil(document.querySelector(".top").getBoundingClientRect().height) + 12;
    const portrait = h >= w;
    if (w < 720 || (w < 1100 && portrait)) {
      return { paddingTopLeft: [10, top], paddingBottomRight: [10, 96] };
    }
    if (w < 1100) {
      return { paddingTopLeft: [16, top], paddingBottomRight: [state.selected ? 340 : 16, 84] };
    }
    return {
      paddingTopLeft: [292, top],
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
    const token = ++state.customToken;
    const generation = state.generation;
    setStatus("正在计算这个位置…", "load");
    try {
      lon = ((lon + 540) % 360) - 180;
      const days = await fetchOne(lat, lon, state.wxModel);
      if (generation !== state.generation || token !== state.customToken) return;
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
      if (generation !== state.generation || token !== state.customToken) return;
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
        state.probeToken++;
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
    state.horizon = null;
    state.probeToken++;
    renderDays();
    renderRank();
    paintMarkers();
    renderInspector();
    const sample = state.selected?.days ? state.selected : state.places.find((p) => p.days);
    const date = sample?.days?.[state.dayIndex]?.date || "";
    $("headline").textContent =
      (state.mode === "sunset" ? "晚霞" : "朝霞") +
      " · " +
      wxMeta().label +
      (date ? " · " + date.replace(/-/g, ".") : "");
    if (state.selected) probeHorizon(state.selected);
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
    await loadModel();
  }
  async function loadModel() {
    state.loading = true;
    const generation = ++state.generation, model = state.wxModel;
    state.probeToken++;
    state.horizon = null;
    const cached = cacheRead() || [];
    const byId = new Map(cached.map((p) => [p.id, p]));
    state.places.forEach((p) => {
      p.days = byId.get(p.id)?.days || null;
      p._weather = null;
    });
    refreshView();
    if (cached.length) afterLoad();
    setStatus("正在加载 " + wxMeta().label + " 云况…", "load");
    const majors = MAJORS.map(placeByName).filter(Boolean);
    const rest = state.places.filter((p) => !majors.includes(p));
    const pending = majors.concat(rest).filter((p) => !freshDays(p.days));
    let failures = 0;
    for (const batch of chunk(pending, BATCH)) {
      if (generation !== state.generation) return;
      try {
        await fetchWeatherBatch(batch, model, generation);
        if (generation !== state.generation) return;
        if (state.places.some((p) => p.days)) {
          if (!state.booted) afterLoad();
          else refreshView();
        }
        await fetchAirBatch(batch, generation);
        if (generation !== state.generation) return;
        if (state.places.some((p) => p.days)) refreshView();
        cacheWrite();
      } catch (e) { failures++; console.error(e); }
    }
    if (generation !== state.generation) return;
    state.ready = state.places.some((p) => p.days);
    state.loading = false;
    setStatus(failures ? "部分地点暂时无法更新，可稍后点击重试。" : "", failures ? "err" : "");
    refreshView();
  }
  async function setWxModel(id) {
    if (!WX_MODELS.some((m) => m.id === id) || id === state.wxModel) return;
    state.wxModel = id;
    document.querySelectorAll("[data-wx]").forEach((b) => b.classList.toggle("on", b.dataset.wx === id));
    await loadModel();
  }

  function afterLoad() {
    const hour = new Date().getHours();
    if (!state.booted && hour < 10) state.mode = "sunrise";
    document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
    document.querySelectorAll("[data-wx]").forEach((b) => b.classList.toggle("on", b.dataset.wx === state.wxModel));
    state.ready = true;
    refreshView();
    if (!state.booted) {
      const home = placeByName("北京");
      if (home) selectPlace(home.id, false);
    }
    state.booted = true;
    fitChina();
  }

  function boot() {
    const top = document.querySelector(".top");
    const measureTop = () => document.documentElement.style.setProperty("--top-height", `${Math.ceil(top.getBoundingClientRect().height)}px`);
    measureTop();
    new ResizeObserver(measureTop).observe(top);
    initMap();
    bindUI();
    loadAll();
    $("status").addEventListener("click", () => { if ($("status").dataset.kind === "err") loadModel(); });
    // Refresh a tab left open through a local midnight or a model update.
    const refreshIfStale = () => {
      if (!document.hidden && !state.loading && state.places.some((p) => p.days && !freshDays(p.days))) loadModel();
    };
    setInterval(refreshIfStale, 60000);
    document.addEventListener("visibilitychange", refreshIfStale);
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
