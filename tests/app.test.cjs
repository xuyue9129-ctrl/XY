const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const F=require('../forecast.js');
function setup(fetch) {
  const elements=new Map();
  const node=()=>({innerHTML:'',textContent:'',hidden:false,dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(){}});
  const doc={readyState:'loading',addEventListener(){},body:node(),querySelectorAll:()=>[],getElementById(id){if(!elements.has(id))elements.set(id,node());return elements.get(id);}};
  const store=new Map();
  const storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
  const context=vm.createContext({window:{GlowForecast:F,innerWidth:1280},document:doc,
    localStorage:storage,sessionStorage:storage,Date,Intl,console:{error(){}},AbortController,setTimeout:(fn,ms)=>setTimeout(fn,ms===1000?0:ms),clearTimeout,
    fetch,L:{divIcon:x=>x,marker:()=>({addTo(){return this;},on(){},setIcon(){},setLatLng(){},setZIndexOffset(){}})}});
  const source=fs.readFileSync(require.resolve('../app.js'),'utf8').replace('  if (document.readyState === "loading")',
    '  globalThis.app = { state, fetchWeatherBatch, fetchAirBatch, probeHorizon, cacheRead, cacheWrite, freshDays, renderInspector, renderRank, markerHtml, weatherURL, requestWeather, requestProblem, loadFailureText, loadModel };\n  if (document.readyState === "loading")');
  vm.runInContext(source,context);
  return {app:context.app,elements,store};
}
function payload() {
  const start=Date.parse('2026-09-17T00:00:00Z')/1000;
  const hourly={time:Array.from({length:48},(_,i)=>start+i*3600)};
  for(const [k,v] of Object.entries({cloud_cover:55,cloud_cover_high:50,cloud_cover_mid:30,cloud_cover_low:5,precipitation:0,weather_code:2,visibility:25000,relative_humidity_2m:50})) hourly[k]=Array(48).fill(v);
  return {latitude:40,longitude:116,timezone:'Asia/Shanghai',daily:{time:[start],sunrise:[start+22*3600],sunset:[start+10*3600]},hourly};
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('late weather response cannot overwrite a newly selected model',async()=>{
  const wait=deferred();const {app}=setup(()=>wait.promise);
  const p={lat:40,lon:116,days:['new model']};
  app.state.generation=1;
  const running=app.fetchWeatherBatch([p],'ecmwf_ifs025',1);
  app.state.generation=2;
  wait.resolve({ok:true,json:async()=>payload()});await running;
  assert.deepEqual(p.days,['new model']);
  assert.equal(p._weather,undefined);
});
test('late air response cannot mix old cloud data into new model',async()=>{
  const wait=deferred();const {app}=setup(()=>wait.promise);
  const p={lat:40,lon:116,_weather:payload(),days:[{fetchedAt:1}]};
  app.state.generation=1;
  const running=app.fetchAirBatch([p],1);app.state.generation=2;
  wait.resolve({ok:true,json:async()=>({hourly:{time:[]}})});await running;
  assert.deepEqual(p.days,[{fetchedAt:1}]);
});
test('batch coordinates follow API order, including overlapping model cells',async()=>{
  const w1=payload(),w2=payload();w2.hourly.cloud_cover_high.fill(0);
  const {app}=setup(async()=>({ok:true,json:async()=>[w1,w2]}));
  const places=[{lat:40.01,lon:116},{lat:40,lon:116}];
  await app.fetchWeatherBatch(places,'ecmwf_ifs025',0);
  assert.equal(places[0]._weather,w1);assert.equal(places[1]._weather,w2);
});
test('cache rejects a previous local day even within the 30-minute TTL',()=>{
  const {app}=setup();
  const fresh={fetchedAt:Date.now(),timezone:'Pacific/Kiritimati',date:F.localDate(Date.now()/1000,'Pacific/Kiritimati')};
  assert.ok(app.freshDays([fresh]));
  assert.equal(app.freshDays([{...fresh,date:'2000-01-01'}]),false);
  assert.equal(app.freshDays([{...fresh,fetchedAt:Date.now()-31*60000}]),false);
});
test('missing events render unavailable and are excluded from rankings',()=>{
  const {app,elements}=setup();
  const w=payload();w.daily.sunrise=[null];w.daily.sunset=[null];
  const p={id:'p',name:'极地区域',province:'',region:'',lat:80,lon:0,days:F.buildDays(w,null)};
  app.state.places=[p];app.state.selected=p;
  app.renderInspector();app.renderRank();
  assert.match(elements.get('inspector').innerHTML,/暂无预报/);
  assert.doesNotMatch(elements.get('inspector').innerHTML,/NaN|undefined|null/);
  assert.equal(elements.get('rank-list').innerHTML,'');
  assert.match(app.markerHtml(p),/暂无预报/);
});
test('a late horizon probe is discarded after day selection changes',async()=>{
  const wait=deferred();const {app}=setup(()=>wait.promise);
  const days=F.buildDays(payload(),null);
  days.push({...days[0],sunsetGlow:{...days[0].sunsetGlow}});
  const p={id:'p',name:'test',province:'',region:'',lat:40,lon:116,days};
  app.state.selected=p;app.state.places=[p];
  const running=app.probeHorizon(p);app.state.dayIndex=1;
  wait.resolve({ok:true,json:async()=>Array(4).fill(payload())});await running;
  assert.equal(days[0].sunsetGlow.horizon,null);
  assert.equal(days[1].sunsetGlow.horizon,null);
});
test('weather requests pin the selected model and use absolute timestamps',()=>{
  const {app}=setup();const url=app.weatherURL('40','116','gfs_seamless');
  app.state.wxModel='icon_seamless';
  assert.match(url,/models=gfs_seamless/);assert.match(url,/timeformat=unixtime/);
});

test('a transient network failure retries once and can recover',async()=>{
  let calls=0;
  const {app}=setup(async()=>{if(++calls===1)throw new TypeError('Failed to fetch');return {ok:true,json:async()=>({ok:1})};});
  assert.equal((await app.requestWeather('test',0)).ok,1);assert.equal(calls,2);
});
test('persistent server failure stops after two attempts',async()=>{
  let calls=0;const {app}=setup(async()=>{calls++;return {ok:false,status:503};});
  await assert.rejects(app.requestWeather('test',0),{status:503});assert.equal(calls,2);
});
test('rate limits respect Retry-After and are not immediately retried',async()=>{
  let calls=0;const now=Date.now();
  const {app}=setup(async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '120'}};});
  await assert.rejects(app.requestWeather('test',0),e=>e.status===429&&e.retryAt>=now+120000);
  assert.equal(calls,1);
});
test('permanent request errors are not retried',async()=>{
  let calls=0;const {app}=setup(async()=>{calls++;return {ok:false,status:400};});
  await assert.rejects(app.requestWeather('test',0),{status:400});assert.equal(calls,1);
});
test('partial batch results preserve successes and report incompleteness',async()=>{
  const {app}=setup(async()=>({ok:true,json:async()=>[payload(),{}]}));
  const places=[{lat:40,lon:116},{lat:41,lon:117}];
  await assert.rejects(app.fetchWeatherBatch(places,'ecmwf_ifs025',0),/incomplete/);
  assert.equal(places[0].days.length,1);assert.equal(places[1].days,undefined);
});
test('failure message identifies affected cities and distinguishes timeout from throttling',()=>{
  const {app}=setup();
  const places=[{name:'北京'},{name:'上海'}];
  assert.match(app.loadFailureText(places,{name:'AbortError'}),/2 个地点未加载（北京、上海）.*超时/);
  assert.match(app.loadFailureText(places,{status:429,retryAt:Date.now()+120000}),/限流.*分钟后重试/);
});
test('retry during cooldown preserves existing results without starting requests',async()=>{
  let calls=0;const {app,elements}=setup(async()=>{calls++;});
  const places=[{days:['cached']}];app.state.places=places;app.state.retryAt=Date.now()+120000;
  await app.loadModel();assert.equal(calls,0);assert.equal(app.state.places,places);
  assert.match(elements.get('status').textContent,/仍在限流/);
});
test('offline loading stops after two failed batches instead of requesting every city',async()=>{
  let calls=0;const {app,elements}=setup(async()=>{calls++;throw new TypeError('offline');});
  app.state.booted=true;
  app.state.places=Array.from({length:30},(_,i)=>({id:String(i),name:'City '+i,lat:40,lon:116}));
  await app.loadModel();
  assert.equal(calls,4);assert.equal(app.state.loading,false);
  assert.match(elements.get('status').textContent,/30 个地点未加载.*网络连接未成功/);
});
