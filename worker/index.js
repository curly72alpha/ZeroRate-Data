// ZeroRate 중계 (Cloudflare Workers)
// - 환율(OXR latest): 매시 1·6·16분에 깨어나, 이번 시각 자료가 없을 때만 받아 KV에 둠 → 정각 1~2분 뒤 바로 보임.
//   OXR은 시간당 1회. 정각 직후라 지난 자료가 오면 한 번만, 이번 달 남은 횟수가 넉넉할 때만 다시.
// - 그 밖의 파일(30일 전 환율, FRED·ECOS·KRX 금)은 GitHub 중계(ZeroRate-Data data 브랜치)를 그대로 넘겨줌(10분 캐시).
// 앱은 이 주소 하나만 읽고, 키는 이 Worker의 Secret(OXR_APP_ID)과 GitHub Secret에만 있음.
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

const json = (body, maxAge) => new Response(body, {
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
});

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(updateRates(env));
  },
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/latest.json") {
      let text = await env.DATA.get("latest.json", { cacheTtl: 60 });
      if (!text) { await updateRates(env); text = await env.DATA.get("latest.json"); }
      return text ? json(text, 60) : new Response("없음", { status: 503 });
    }
    if (!/^\/(historical|fred|ecos|krx)\/[\w.-]+\.json$/.test(path)) return new Response("없음", { status: 404 });
    const r = await fetch(GITHUB + path, { cf: { cacheTtl: 600, cacheEverything: true } });
    return r.ok ? json(r.body, 600) : new Response("없음", { status: r.status });
  },
};
