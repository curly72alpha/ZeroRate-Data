# ZeroRate-Data

ZeroRate 앱용 환율 중계. GitHub Actions가 1시간마다 Open Exchange Rates를 받아 `data` 브랜치에 올린다.

- `latest.json` — 최신 환율 (OXR 형식 그대로)
- `historical/YYYY-MM-DD.json` — 29~31일 전 마감 환율

키는 Secret `OXR_APP_ID`에만 둔다. 앱은 `https://raw.githubusercontent.com/curly72alpha/ZeroRate-Data/data/latest.json`을 읽는다.
