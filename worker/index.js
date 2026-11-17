// ZeroRate 중계 (Cloudflare Workers)
// - 환율(OXR latest): 매시 1·6·16분에 깨어나, 이번 시각 자료가 없을 때만 받아 KV에 둠 → 정각 1~2분 뒤 바로 보임.
//   OXR은 시간당 1회. 정각 직후라 지난 자료가 오면 한 번만, 이번 달 남은 횟수가 넉넉할 때만 다시.
// - 30일 전 환율(historical): 처음 찾을 때 OXR에서 한 번 받아 KV에 둠(28~32일 전 날짜만, 하루 1회꼴).
// - FRED·ECOS: 크론 3시간마다(매 3시 31분) 직접 받아 KV에 둠. 크론이 빠져 6시간 넘게 낡으면 다음 요청 때 뒤에서 다시 받음.
//   KV에 없으면 GitHub 중계 것을 넘겨줌. (GitHub 예약 실행은 몇 시간씩 빠져서 11-17 옮김)
// - KRX 금은 GitHub 중계(update.yml)를 그대로 넘겨줌(쪽을 합치는 일이 Worker 무료 CPU에 부담, 자료도 하루 늦음).
// 앱은 이 주소 하나만 읽고, 키는 이 Worker의 Secret(OXR_APP_ID·FRED_API_KEY·ECOS_API_KEY)과 GitHub Secret에만 있음.
const GITHUB = "https://raw.githubusercontent.com/curly72alpha/ZeroRate-Data/data";

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
  "A191RL1Q225SBEA", "DTWEXBGS", "WALCL", "VIXCLS"];
const SLOW_CRON = "31 */3 * * *";

/** 한국 시각 날짜 (n일 전) → YYYYMMDD */
function seoulDay(daysAgo = 0) {
  const d = new Date(Date.now() + 9 * 3600000 - daysAgo * 86400000);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
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
  let ok = 0;
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
  if (ok > 0) await env.DATA.put("slow:at", String(Date.now()));
  return `${ok}/${jobs.length}`;
}

const json = (body, maxAge) => new Response(body, {
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
});

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === SLOW_CRON ? updateSlow(env) : updateRates(env));
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
    if (!/^\/(fred|ecos|krx)\/[\w.-]+\.json$/.test(path)) return new Response("없음", { status: 404 });
    if (!path.startsWith("/krx/")) {
      // 크론이 빠져 6시간 넘게 낡았으면 뒤에서 다시 받음 (지금 응답은 있는 것으로)
      const at = Number((await env.DATA.get("slow:at")) || 0);
      if (Date.now() - at > 6 * 3600000) ctx.waitUntil(updateSlow(env));
      const text = await env.DATA.get(path.slice(1), { cacheTtl: 300 });
      if (text) return json(text, 600);
    }
    const r = await fetch(GITHUB + path, { cf: { cacheTtl: 600, cacheEverything: true } });
    return r.ok ? json(r.body, 600) : new Response("없음", { status: r.status });
  },
};
