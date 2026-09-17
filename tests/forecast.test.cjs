const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../forecast.js');
const good = {high:50, mid:30, low:5, total:55, visKm:25, rh:55, precip:0, weather:2, aod:0.08, pm25:8};
const t = Date.parse('2026-09-17T10:20:00Z') / 1000;
function hourly(start = t - 10800, n = 8, overrides = {}) {
  const h = {time:Array.from({length:n}, (_,i)=>start+i*3600)};
  const fields = {cloud_cover_high:50,cloud_cover_mid:30,cloud_cover_low:5,cloud_cover:55,
    visibility:25000,relative_humidity_2m:55,precipitation:0,weather_code:2};
  for (const [k,v] of Object.entries({...fields,...overrides})) h[k] = Array(n).fill(v);
  return h;
}
test('trapezoid descending slope is continuous and reaches zero', () => {
  assert.equal(F.trapezoid(75,0,20,50,100), .5);
  assert.ok(F.trapezoid(50.0001,0,20,50,100) > .999);
  assert.equal(F.trapezoid(100,0,20,50,100),0);
});
test('missing required data is unavailable, never clear sky or zero score', () => {
  for (const key of ['high','mid','low','total','precip','weather']) {
    assert.equal(F.scoreSample({...good,[key]:null}).score,null);
  }
});
test('missing optional data stays missing and lowers confidence', () => {
  const r=F.scoreSample({...good,visKm:null,rh:null,aod:null,pm25:null});
  assert.ok(Number.isFinite(r.score));
  assert.equal(r.sample.visKm,null);
  assert.ok(r.quality < F.scoreSample(good).quality);
});
test('good layered clouds beat clear twilight and overcast', () => {
  const clear=F.scoreSample({...good,high:0,mid:0,low:0,total:0});
  const overcast=F.scoreSample({...good,low:100,total:100});
  assert.ok(F.scoreSample(good).score > clear.score);
  assert.ok(clear.score <= 28);
  assert.ok(overcast.score < 19);
});
test('rain, thunderstorms and fog suppress favourable clouds', () => {
  const base=F.scoreSample(good).score;
  for (const overrides of [{precip:3},{weather:95},{weather:45,visKm:.3}]) {
    assert.ok(F.scoreSample({...good,...overrides}).score < base*.5);
  }
});
test('poor visibility alone cannot be offset by upper clouds', () => {
  assert.ok(F.scoreSample({...good,visKm:.1}).score < 19);
});
test('more aerosols do not award bonus points', () => {
  assert.ok(F.scoreSample({...good,aod:1}).score < F.scoreSample({...good,aod:0}).score);
});
test('hourly interpolation uses UTC and does not extrapolate', () => {
  const h={time:[0,3600],cloud_cover:[20,80]};
  assert.equal(F.valueAt(h,'cloud_cover',1800),50);
  assert.equal(F.valueAt(h,'cloud_cover',-1),null);
  assert.equal(F.valueAt(h,'cloud_cover',3601),null);
  assert.equal(F.valueAt({time:[0,7200],cloud_cover:[20,80]},'cloud_cover',3600),null);
});
test('missing hours are not interpolated through', () => {
  assert.equal(F.valueAt({time:[0,3600],cloud_cover:[null,80]},'cloud_cover',1800),null);
});
test('rain uses the hour ending after the sample, not an interpolated amount', () => {
  assert.equal(F.valueAt({time:[0,3600],precipitation:[0,2]},'precipitation',1800,true),2);
});
test('air timestamps align in UTC, independent of air/weather local zone', () => {
  const s=F.sampleAt(hourly(),{time:[t-1800,t+1800],pm2_5:[10,20]},t);
  assert.equal(s.pm25,15);
  assert.equal(s.aod,null);
});
test('local dates and clocks handle date line and DST', () => {
  const ts=Date.parse('2026-09-17T01:00:00Z')/1000;
  assert.equal(F.localDate(ts,'Asia/Shanghai'),'2026-09-17');
  assert.equal(F.localDate(ts,'America/Los_Angeles'),'2026-09-16');
  assert.equal(F.fmtTime(ts,'America/Los_Angeles'),'18:00');
  assert.equal(F.fmtTime(Date.parse('2026-11-01T06:30:00Z')/1000,'America/New_York'),'01:30');
});
test('sun direction follows season and hemisphere; NREL SPA example within one degree', () => {
  // NREL SPA reference example: Boulder, 2003-10-17 12:30:30 MDT.
  const p=F.sunPosition(Date.parse('2003-10-17T19:30:30Z')/1000,39.742476,-105.1786);
  assert.ok(Math.abs(p.azimuth-194.34)<1,JSON.stringify(p));
  assert.ok(Math.abs(p.elevation-39.89)<1,JSON.stringify(p));
  const june=F.sunPosition(Date.parse('2026-06-21T11:45:00Z')/1000,40,116);
  assert.ok(june.azimuth>290 && june.azimuth<310);
});
test('great-circle samples preserve distance at high latitude and wrap date line', () => {
  const p=F.destination(70,179.9,90,150);
  assert.ok(p.lon<0 && p.lon>=-180);
  const rad=Math.PI/180;
  const distance=6371*Math.acos(Math.sin(70*rad)*Math.sin(p.lat*rad)+Math.cos(70*rad)*Math.cos(p.lat*rad)*Math.cos((p.lon-179.9)*rad));
  assert.ok(Math.abs(distance-150)<.001);
});
test('polar missing events, expired horizons, truncated data are unavailable', () => {
  assert.equal(F.eventScore(hourly(),null,null,'sunrise',80,0).score,null);
  assert.equal(F.eventScore(hourly(),null,0,'sunrise',80,0).score,null);
  assert.equal(F.eventScore(hourly(t-86400),null,t,'sunset',40,116).score,null);
});
test('event score is finite, bounded and derives an altitude-based window', () => {
  const r=F.eventScore(hourly(),null,t,'sunset',40,116);
  assert.ok(r.score>20 && r.score<=49,JSON.stringify(r));
  assert.ok(r.viewFrom<=t && r.viewTo>t);
  assert.equal(r.sample.aod,null);
});
test('light-path correction is bounded and idempotent', () => {
  const r=F.eventScore(hourly(),null,t,'sunset',40,116);
  const blocked=Array(4).fill({low:100,mid:100,precip:1});
  const once=F.applyHorizon(r,blocked,270);
  assert.ok(once.score<r.score && once.score>=r.score*.6-1);
  assert.equal(F.applyHorizon(once,blocked,270).score,once.score);
  assert.equal(F.applyHorizon(r,[{},{}],270).score,r.score);
  assert.equal(F.applyHorizon(r,[{},{}],270).horizon.available,false);
});
test('data sanitation rejects non-finite and out-of-range weather values', () => {
  const s=F.sampleAt(hourly(t-3600,3,{cloud_cover_low:200,visibility:-1}),null,t);
  assert.equal(s.low,null); assert.equal(s.visKm,null);
  assert.equal(F.scoreSample(s).score,null);
});

module.exports={hourly,t};

test('Beijing reported false alarm: humid hazy upper-cloud scene is below mid-glow', () => {
  const r=F.scoreSample({...good,high:31,mid:44,low:0,total:12,visKm:null,rh:91,aod:.78,pm25:140});
  assert.ok(r.score<19,JSON.stringify(r));
});
test('sparse total cover limits inconsistent high layer estimates', () => {
  const sparse=F.scoreSample({...good,total:12});
  assert.ok(sparse.score<F.scoreSample(good).score*.65);
  assert.ok(sparse.quality<F.scoreSample(good).quality);
});
test('missing visibility or aerosols prevents a mid/strong-glow claim', () => {
  assert.ok(F.scoreSample({...good,visKm:null}).score<50);
  assert.ok(F.scoreSample({...good,aod:null,pm25:null}).score<50);
});
