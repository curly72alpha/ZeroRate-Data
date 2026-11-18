// ZeroRate 중계 (Cloudflare Workers)
// - 환율(OXR latest): 매시 1·6·16분에 깨어나, 이번 시각 자료가 없을 때만 받아 KV에 둠 → 정각 1~2분 뒤 바로 보임.
//   OXR은 시간당 1회. 정각 직후라 지난 자료가 오면 한 번만, 이번 달 남은 횟수가 넉넉할 때만 다시.
// - 30일 전 환율(historical): 처음 찾을 때 OXR에서 한 번 받아 KV에 둠(28~32일 전 날짜만, 하루 1회꼴).
// - FRED·ECOS: 크론 3시간마다(매 3시 31분) 직접 받아 KV에 둠. 크론이 빠져 6시간 넘게 낡으면 다음 요청 때 뒤에서 다시 받음.
//   KV에 없으면 GitHub 중계 것을 넘겨줌. (GitHub 예약 실행은 몇 시간씩 빠져서 11-17 옮김)
// - KRX 금(공공데이터포털)도 같은 크론에서 받음(쪽을 글자로 이어 붙여 CPU 아낌). GitHub 중계는 쓰지 않음(11-18).
// 앱은 이 주소 하나만 읽고, 키는 이 Worker의 Secret(OXR_APP_ID·FRED_API_KEY·ECOS_API_KEY·DATA_GO_KR_KEY)과 GitHub Secret에만 있음.

const hourOf = (ts) => Math.floor(ts / 3600);

async function updateRates(env) {
  const now = hourOf(Date.now() / 1000);
  const cur = await env.DATA.get("latest.json");
  if (cur) {
    try { if (hourOf(JSON.parse(cur).timestamp) === now) return "있음"; } catch {}
  }
  const tries = Number((await env.DATA.get("try:" + now)) || 0);
  if (tries >= 2) return "이번 시각 두 번 받음";
  if (tries === 1) {
    const u = await fetch(`https://openexchangerates.org/api/usage.json?app_id=${env.OXR_APP_ID}`).then(r => r.json()).catch(() => ({}));
    const left = u?.data?.usage?.requests_remaining ?? 0;
    const days = u?.data?.usage?.days_remaining ?? 31;
    if (left <= days * 30) return "남은 횟수 빠듯";
  }
  await env.DATA.put("try:" + now, String(tries + 1), { expirationTtl: 7200 });
  const r = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${env.OXR_APP_ID}`);
  if (!r.ok) return "OXR 실패 " + r.status;
  const text = await r.text();
  if (!JSON.parse(text).rates) return "OXR 내용 이상";
  await env.DATA.put("latest.json", text);
  return "받음";
}

// FRED: 최신순 2700개 (앱이 필요한 만큼 잘라 씀), 물가는 1년 전 대비 % 40개
const FRED_IDS = ["UNRATE", "DGS2", "DFEDTARU", "DFEDTARL", "T10Y2Y", "SP500", "NASDAQQGLDI", "DEXKOUS",
  "A191RL1Q225SBEA", "DTWEXBGS", "WALCL", "VIXCLS", "DFII10"];
const SLOW_CRON = "31 */3 * * *";
// KRX 금 종가는 다음 영업일 오후 1시쯤 공개 → 평일 13:41~18:41(한국) 매시 확인, 전 영업일 종가가 이미 있으면 건너뜀
const KRX_CRON = "41 4-9 * * 1-5";
async function krxIfMissing(env) {
  let back = 1;
  const wd = new Date(Date.now() + 9 * 3600000).getUTCDay();
  if (wd === 1) back = 3; // 월요일이면 금요일 종가
  const want = seoulDay(back);
  const have = await env.DATA.get("krx/gold.json");
  if (have && have.includes(`"basDt":"${want}"`)) return "있음";
  return updateKrx(env);
}

/** 한국 시각 날짜 (n일 전) → YYYYMMDD */
function seoulDay(daysAgo = 0) {
  const d = new Date(Date.now() + 9 * 3600000 - daysAgo * 86400000);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

// KRX 금(공공데이터포털): 최근 10년을 1000개씩 받아 한 파일로 — JSON을 풀지 않고 글자로 이어 붙임(무료 CPU 10ms 안)
async function updateKrx(env) {
  try {
    const from = seoulDay(3653);
    const krx = no => `https://apis.data.go.kr/1160100/GetGeneralProductInfoService_V2/getGoldPriceInfo_V2?serviceKey=${env.DATA_GO_KR_KEY}&resultType=json&numOfRows=1000&pageNo=${no}&beginBasDt=${from}`;
    const first = await fetch(krx(1)).then(r => r.text());
    const total = Number((first.match(/"totalCount"\s*:\s*(\d+)/) || [])[1] || 0);
    const items = t => { const a = t.indexOf('"item":['); const b = t.lastIndexOf("]"); return a < 0 || b <= a ? "" : t.slice(a + 8, b).trim(); };
    const parts = [items(first)];
    for (let no = 2; no <= Math.ceil(total / 1000) && no <= 12; no++) parts.push(items(await fetch(krx(no)).then(r => r.text())));
    const body = parts.filter(Boolean).join(",");
    if (!(total > 0 && body)) return `fail total ${total} first ${first.slice(0, 200)}`;
    await env.DATA.put("krx/gold.json", `{"response":{"body":{"totalCount":${total},"items":{"item":[${body}]}}}}`);
    return `ok ${total} ${body.length}`;
  } catch (e) {
    return "error " + e;
  }
}

// 미장 주요 일정 → events.json {fomc, cpi, jobs: ["YYYY-MM-DD", …]} (앱은 받은 날짜를 쓰고, 그 뒤는 앱에 넣어 둔 목록)
//   FOMC: 연준 일정표 페이지 (해마다 연준이 다음 해를 올림) — 결정일 = 회의 마지막 날
//   CPI·고용: BLS 일정(막히면) → FRED 다음 발표일
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = n => String(n).padStart(2, "0");
async function updateEvents(env) {
  const out = { fomc: [], cpi: [], jobs: [], src: {} };
  try {
    const html = await fetch("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", { headers: { "user-agent": UA } }).then(r => r.text());
    const panels = html.split(/>(\d{4}) FOMC Meetings</);
    for (let i = 1; i + 1 < panels.length; i += 2) {
      const year = Number(panels[i]);
      // 회의 하나씩 (다음 회의 앞까지) — "17-18*" 만, 표결·임시·전략 회의(결정 없음)는 뺌
      for (const blk of panels[i + 1].split("fomc-meeting__month").slice(1)) {
        const m = blk.match(/<strong>([A-Za-z/]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]*)</);
        if (!m || /strategy/i.test(blk)) continue;
        const d = m[2].trim().match(/^(\d{1,2})-(\d{1,2})\*?$/);
        if (!d) continue;
        const mon = MONTHS.indexOf(m[1].split("/").pop()) + 1;
        if (mon > 0) out.fomc.push(`${year}-${pad(mon)}-${pad(d[2])}`);
      }
    }
    out.src.fomc = out.fomc.length;
  } catch (e) { out.src.fomc = "error " + e; }
  try {
    const ics = await fetch("https://www.bls.gov/schedule/news_release/bls.ics", { headers: { "user-agent": UA, accept: "text/calendar,*/*" } });
    out.src.bls = ics.status;
    if (ics.ok) {
      for (const ev of (await ics.text()).split("BEGIN:VEVENT").slice(1)) {
        const sum = (ev.match(/SUMMARY[^:]*:(.*)/) || [])[1] || "";
        const dt = (ev.match(/DTSTART[^:]*:(\d{4})(\d\d)(\d\d)/) || []).slice(1).join("-");
        if (!dt) continue;
        if (/^Consumer Price Index/i.test(sum)) out.cpi.push(dt);
        if (/^Employment Situation/i.test(sum)) out.jobs.push(dt);
      }
    }
  } catch (e) { out.src.bls = "error " + e; }
  const since = seoulDay(1).replace(/(\d{4})(\d\d)/, "$1-$2-");
  for (const [key, id] of [["cpi", 10], ["jobs", 50]]) {
    try {
      const r = await fetch(`https://api.stlouisfed.org/fred/release/dates?release_id=${id}&api_key=${env.FRED_API_KEY}&file_type=json&include_release_dates_with_no_data=true&realtime_start=${since}&sort_order=asc&limit=24`);
      for (const x of (await r.json()).release_dates || []) out[key].push(x.date);
    } catch {}
  }
  for (const k of ["fomc", "cpi", "jobs"]) out[k] = [...new Set(out[k])].filter(d => d >= since).sort();
  if (out.fomc.length || out.cpi.length || out.jobs.length) await env.DATA.put("events.json", JSON.stringify(out));
  return out;
}

// S&P500 10년: FRED가 2026-11부터 최근 1년만 줌 → CBOE 일별 종가(1975~, 1.7MB)의 끝부분만 글자로 잘라 FRED 모양으로 저장
//   (JSON 전체를 풀면 무료 CPU 10ms를 넘을 수 있음). 실패하면 FRED 것(1년) 그대로.
async function updateSp500(env) {
  try {
    const text = await fetch("https://cdn-api.cboe.com/api/global/delayed_quotes/charts/historical/_SPX.json").then(r => r.text());
    const tail = text.slice(-500000);
    const obs = [];
    for (const m of tail.matchAll(/"date": ?"(\d{4}-\d\d-\d\d)"[^}]*?"close": ?"([\d.]+)"/g)) {
      if (Number(m[2]) > 0) obs.push(`{"date":"${m[1]}","value":"${Number(m[2]).toFixed(2)}"}`);
    }
    if (obs.length < 2000) return `짧음 ${obs.length}`;
    const desc = obs.slice(-2700).reverse();
    await env.DATA.put("fred/SP500.json", `{"source":"CBOE","observations":[${desc.join(",")}]}`);
    return `ok ${desc.length}`;
  } catch (e) {
    return "error " + e;
  }
}

// 자료 검사 → health.json {at, problems: ["S&P500: …", …]} — 앱 상식 맨 위에 주황 줄로
//   개수가 평소보다 크게 줄었는지, 마지막 날짜가 너무 오래됐는지 (JSON을 풀지 않고 글자로만 봄)
const HEALTH = [
  // [KV 키, 이름, 최소 개수, 허용 지연(일)]
  ["fred/SP500.json", "S&P500", 2000, 6], ["fred/VIXCLS.json", "VIX 기록", 2000, 6],
  ["fred/NASDAQQGLDI.json", "금 지수", 2000, 7], ["fred/DEXKOUS.json", "원/달러 기록", 2000, 10],
  ["fred/DGS2.json", "미국 2년물", 2000, 7], ["fred/T10Y2Y.json", "장단기 금리차", 2000, 7],
  ["fred/DFII10.json", "실질금리", 2000, 7], ["fred/DTWEXBGS.json", "달러지수", 2000, 12],
  ["fred/DFEDTARU.json", "미국 기준금리", 100, 10], ["fred/UNRATE.json", "실업률", 100, 75],
  ["fred/CPIAUCSL_pc1.json", "미국 물가", 20, 75], ["fred/WALCL.json", "연준 자산", 100, 21],
  ["fred/A191RL1Q225SBEA.json", "GDP", 20, 200],
];
const daysSince = ymd => (Date.now() - Date.parse(ymd.length === 6 ? `${ymd.slice(0, 4)}-${ymd.slice(4)}-01` : ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}` : ymd)) / 86400000;
async function checkHealth(env) {
  const problems = [];
  try {
    for (const [key, name, min, late] of HEALTH) {
      const t = await env.DATA.get(key);
      if (!t) { problems.push(`${name}: 자료 없음`); continue; }
      const n = t.split('"date"').length - 1 - (t.split('"value":"."').length - 1);
      const last = (t.match(/"date":\s*"(\d{4}-\d\d-\d\d)"/) || [])[1];
      if (n < min) problems.push(`${name}: 자료가 ${n}개뿐 (평소 ${min}개 넘음)`);
      else if (!last || daysSince(last) > late) problems.push(`${name}: ${last || "?"} 뒤로 새 자료 없음`);
    }
    for (const [key, name, late] of [["ecos/base.json", "한국 기준금리", 12], ["ecos/y3.json", "국고채 3년", 12],
      ["ecos/cpi.json", "한국 물가", 75], ["ecos/deposit.json", "정기예금 금리", 75], ["ecos/unrate.json", "한국 실업률", 75]]) {
      const t = await env.DATA.get(key);
      const times = [...(t || "").matchAll(/"TIME":"(\d{6,8})"/g)].map(m => m[1]).sort();
      const last = times[times.length - 1];
      if (!last) problems.push(`${name}: 자료 없음`);
      else if (daysSince(last) > late + (last.length === 6 ? 31 : 0)) problems.push(`${name}: ${last} 뒤로 새 자료 없음`);
    }
    const gq = [...((await env.DATA.get("ecos/gdp.json")) || "").matchAll(/"TIME":"(\d{4})Q(\d)"/g)].map(m => `${m[1]}${String(m[2] * 3).padStart(2, "0")}`).sort().pop();
    if (!gq) problems.push("한국 GDP: 자료 없음");
    else if (daysSince(gq) > 200) problems.push(`한국 GDP: ${gq.slice(0, 4)}년 ${Number(gq.slice(4)) / 3}분기 뒤로 새 자료 없음`);
    const k = await env.DATA.get("krx/gold.json");
    const kd = [...(k || "").matchAll(/"basDt":"(\d{8})"/g)].map(m => m[1]).sort().pop();
    if (!kd) problems.push("KRX 금: 자료 없음");
    else if (daysSince(kd) > 6) problems.push(`KRX 금: ${kd.slice(0, 4)}-${kd.slice(4, 6)}-${kd.slice(6)} 뒤로 새 자료 없음`);
    const r = await env.DATA.get("latest.json");
    const ts = Number((r || "").match(/"timestamp":\s*(\d+)/)?.[1] || 0);
    if (Date.now() / 1000 - ts > 3 * 3600) problems.push("환율: 3시간 넘게 새 자료 없음");
    const ev = await env.DATA.get("events.json");
    if (!ev || !/"fomc":\["\d/.test(ev)) problems.push("미장 일정: 연준 일정표를 못 읽음 (앱에 적어 둔 목록 사용 중)");
  } catch (e) {
    problems.push("검사 오류: " + e);
  }
  await env.DATA.put("health.json", JSON.stringify({ at: new Date().toISOString(), problems }));
  return problems;
}

async function updateSlow(env) {
  if (await env.DATA.get("slow:lock")) return "받는 중";
  await env.DATA.put("slow:lock", "1", { expirationTtl: 300 });
  const fred = (id, extra = "") =>
    `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${env.FRED_API_KEY}&file_type=json&sort_order=desc${extra}`;
  const jobs = FRED_IDS.map(id => [`fred/${id}.json`, fred(id, "&limit=2700")]);
  jobs.push(["fred/CPIAUCSL_pc1.json", fred("CPIAUCSL", "&limit=40&units=pc1")]);
  // ECOS: 일별 50일, 월별 26달 (1년 전의 전년비까지)
  const today = seoulDay(), d50 = seoulDay(50), mon = today.slice(0, 6), m26 = seoulDay(800).slice(0, 6);
  const ecos = (t, c, a, b, item) =>
    `https://ecos.bok.or.kr/api/StatisticSearch/${env.ECOS_API_KEY}/json/kr/1/100/${t}/${c}/${a}/${b}/${item}`;
  jobs.push(["ecos/base.json", ecos("722Y001", "D", d50, today, "0101000")]);
  jobs.push(["ecos/y3.json", ecos("817Y002", "D", d50, today, "010200000")]);
  jobs.push(["ecos/y10.json", ecos("817Y002", "D", d50, today, "010210000")]);
  jobs.push(["ecos/cpi.json", ecos("901Y009", "M", m26, mon, "0")]);
  jobs.push(["ecos/base_m.json", ecos("722Y001", "M", m26, mon, "0101000")]);
  // 한국 경기: GDP 성장률(실질, 1년 전 같은 분기 대비, 최근 3년 분기) · 실업률(월별 26달)
  const yr = Number(today.slice(0, 4));
  jobs.push(["ecos/gdp.json", ecos("200Y102", "Q", `${yr - 3}Q1`, `${yr}Q4`, "10211")]);
  jobs.push(["ecos/unrate.json", ecos("901Y027", "M", m26, mon, "I61BC")]);
  jobs.push(["ecos/deposit.json", ecos("121Y002", "M", m26, mon, "BEABAA211")]); // 예금은행 정기예금 평균 금리(신규)
  let ok = 0;
  if ((await updateKrx(env)).startsWith("ok")) ok++;
  await updateEvents(env);
  for (const [key, url] of jobs) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const text = await r.text();
      // FRED는 observations, ECOS는 row가 있어야 정상 (오류도 200으로 옴)
      if (!text.includes(key.startsWith("fred") ? '"observations"' : '"row"')) continue;
      await env.DATA.put(key, text);
      ok++;
    } catch {}
  }
  await updateSp500(env); // FRED SP500(1년)을 CBOE 10년으로 덮어씀
  if (ok > 0) await env.DATA.put("slow:at", String(Date.now()));
  await checkHealth(env);
  return `${ok}/${jobs.length + 1}`;
}

const json = (body, maxAge) => new Response(body, {
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
});

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === SLOW_CRON ? updateSlow(env) : event.cron === KRX_CRON ? krxIfMissing(env) : updateRates(env));
  },
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === "/latest.json") {
      let text = await env.DATA.get("latest.json", { cacheTtl: 60 });
      if (!text) { await updateRates(env); text = await env.DATA.get("latest.json"); }
      return text ? json(text, 60) : new Response("없음", { status: 503 });
    }
    const h = path.match(/^\/historical\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (h) {
      const ago = (Date.now() - Date.parse(h[1] + "T00:00:00Z")) / 86400000;
      if (ago < 28 || ago > 33) return new Response("없음", { status: 404 });
      let text = await env.DATA.get("hist:" + h[1]);
      if (!text) {
        const r = await fetch(`https://openexchangerates.org/api/historical/${h[1]}.json?app_id=${env.OXR_APP_ID}`);
        if (!r.ok) return new Response("없음", { status: 502 });
        text = await r.text();
        await env.DATA.put("hist:" + h[1], text, { expirationTtl: 10 * 86400 });
      }
      return json(text, 86400);
    }
    if (path === "/health.json") {
      let text = await env.DATA.get("health.json", { cacheTtl: 300 });
      if (!text) text = JSON.stringify({ problems: await checkHealth(env) });
      return json(text, 600);
    }
    if (path === "/events.json") {
      let text = await env.DATA.get("events.json", { cacheTtl: 300 });
      if (!text) text = JSON.stringify(await updateEvents(env));
      return json(text, 3600);
    }
    if (!/^\/(fred|ecos|krx)\/[\w.-]+\.json$/.test(path)) return new Response("없음", { status: 404 });
    {
      // 크론이 빠져 6시간 넘게 낡았으면 뒤에서 다시 받음 (지금 응답은 있는 것으로)
      const at = Number((await env.DATA.get("slow:at")) || 0);
      if (Date.now() - at > 6 * 3600000) ctx.waitUntil(updateSlow(env));
      let text = await env.DATA.get(path.slice(1), { cacheTtl: 300 });
      // 새로 추가한 자료처럼 KV에 아직 없으면 그 자리에서 한 번 받아 둠 (크론을 기다리지 않음)
      if (!text) {
        await updateSlow(env);
        text = await env.DATA.get(path.slice(1));
      }
      if (text) return json(text, 600);
    }
    return new Response("없음", { status: 503 });
  },
};
