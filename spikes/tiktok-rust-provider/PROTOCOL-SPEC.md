# TikTok LIVE → Rust Provider: Wire Protocol Specification

**Status:** research spike output, implementation-ready
**Target:** a Rust client that connects to a TikTok LIVE stream using the free (no-API-key) Euler Stream signature server
**Date of research:** all live probes and source reads performed in a single session; HTTP probes are labelled `[PROBE]`

---

## 0. Provenance, versions, and how to read this document

### 0.1 Sources used

| ID | Source | Revision | Licence | Used for |
|----|--------|----------|---------|----------|
| `[TL]` | `isaackogan/TikTokLive` (Python) | branch `master`, `PACKAGE_VERSION = "7.0.1"` | modified AGPL-3.0 | Flow, endpoints, params, headers, status codes. **Facts extracted only — no code copied.** |
| `[TLR]` | `jwdeveloper/TikTokLiveRust` | branch `master` | MIT (verified `license.txt`) | Verbatim `.proto` excerpts; Rust handshake/ACK/heartbeat behaviour |
| `[GTL]` | `steampoweredtaco/gotiktoklive` | branch `master` | MIT (verified `LICENSE`) | Verbatim `.proto` excerpts (second, independent copy) |
| `[ZTC]` | `zerodytrash/TikTok-Live-Connector` | branch `main`, `src/proto/tiktokSchema.proto` | MIT | Cross-verification of field numbers (older/partial schema) |
| `[OAS]` | Euler Stream OpenAPI spec, `EulerStream/TikTok-Live-Api` → `sdk/csharp/src/generated/api/openapi.yaml` | commit `73ba7c0354dbeb4311249be56689df6cadb731ce` | All Rights Reserved (spec read as documentation; no content redistributed beyond factual parameter names) | Exact `/webcast/fetch` contract |
| `[DOCS]` | `eulerstream.com/docs/*` (incl. `/api/docs/md/...` markdown endpoints) | live | docs | Free-tier policy, 429 semantics |

### 0.2 The single most important version fact

`[TL]` v7.0.1 **no longer defines its own protobuf schema**. `TikTokLive/proto/__init__.py` re-exports
`TikTokLiveProto.v3.*`, and `TikTokLive/proto/__init__.py` pulls from
`TikTokLiveProto.v3.webcast.model`, `.im`, `.shared.message`, `.model.base`, `.model.data`.

Consequences for a Rust implementation:

1. The envelope type is `ProtoMessageFetchResult` in Python v7 — the **same wire message** as
   `WebcastResponse` in the MIT protos. Use `WebcastResponse`.
2. v3 **renamed several fields** relative to the v2-era MIT protos. The *field numbers and wire types are
   unchanged*; only the JSON/prost names differ. Section E marks each v3 name explicitly.
3. v3 dropped some historical messages entirely. Anything you rely on must exist in your own `.proto`.

### 0.3 Field-table convention

Every field is `#<number>` + proto type. Unless stated otherwise:

* `#1` = field number 1, and the encoding follows from the type (varint for `int32/int64/uint64/bool/enum`,
  length-delimited for `string/bytes/message/repeated scalar`, a 4-byte little-endian float for `float`).
* All schemas in section E are **proto3** (see E.9 for prost implications).

---

## 1. End-to-end flow (4 stages)

```
unique_id (@handle)
   │
   │ STAGE 1  resolve room_id
   ▼
room_id (int64, decimal string)
   │
   │ STAGE 2  GET https://api.eulerstream.com/webcast/fetch?room_id=…   (NO API KEY)
   ▼
binary protobuf  ==  WebcastResponse { cursor, internalExt, pushServer,
                                       routeParamsMap, needsAck,
                                       heartBeatDuration, isFirst, messages[] }
   │                                + HTTP header  X-Set-TT-Cookie
   │ STAGE 3  build wss:// URL from pushServer + routeParamsMap + base params
   ▼
WebSocket upgrade (Cookie + User-Agent; subprotocol echo-protocol)
   │
   │ STAGE 4  binary frames
   ▼
WebcastPushFrame { PayloadType, LogId, Payload, headers[] }
   │  if PayloadType != "msg" → discard
   │  if headers contain compress_type == "gzip" → gunzip Payload
   ▼
WebcastResponse  → messages[] each { method, payload }  → decode payload by `method`
   │
   ├─ if needsAck → send WebcastPushFrame{ PayloadType:"ack", LogId:<frame LogId>,
   │                                        PayloadEncoding:"pb", Payload:internalExt }
   └─ every ~5–10 s → send WebcastPushFrame{ PayloadType:"hb", … }
```

**Critical lifetime fact:** the signed WebSocket URL **expires after ~30 seconds** (`[TL]` `ws_connect.py`
docstring: *"signed URLs expire after 30 seconds"*). A reconnect therefore *always* requires a fresh
`/webcast/fetch` call. There is no "reuse the URL" path.

---

## A. STAGE 1 — resolve `room_id`

### A.1 Method choice (which is "most reliable")

`[TL]` `client.py::start()` tries **HTML first, API second**:

> *"Fetch room ID"* → `fetch_room_id_from_html(...)`; on non-`UserOfflineError` failure:
> `"Failed to parse room ID from HTML. Using API fallback."` → `fetch_room_id_from_api(...)`.

**Recommendation for the Rust provider: use the JSON API as the primary route** (with HTML as an optional
fallback). Rationale, from `[TL] client.py`:

> `room_id: An override to the room ID to connect directly to the livestream and skip scraping the live.
> Useful when trying to scale, as scraping the HTML can result in TikTok blocks.`

`[PROBE A-1]` and `[PROBE A-2]` below confirm the API route works, returns pure JSON, and identifies
offline/nonexistent users unambiguously — with **no signature and no API key**.

### A.2 Primary route — JSON API

**Method:** `GET`
**Base URL:** `https://www.tiktok.com/api-live/user/room/`
**Body:** none

**Required query parameters** (names are case-sensitive).

Route-specific:

| Name | Value | Notes |
|------|-------|-------|
| `uniqueId` | the `@handle` without `@`, e.g. `isaackogz` | **camelCase** |
| `sourceType` | `54` | literal; required |

Base parameters (`[TL] web_settings.py::DEFAULT_WEB_CLIENT_PARAMS`) — these are **mandatory**. Omitting them
yields `params_error` (see A.6):

| Name | Example value | Randomised? |
|------|---------------|-------------|
| `aid` | `1988` | fixed |
| `app_language` | `en` | from location preset |
| `app_name` | `tiktok_web` | fixed |
| `browser_language` | `en-US` | from location preset |
| `browser_name` | `Mozilla` | **URL-encoded** browser name |
| `browser_online` | `true` | fixed |
| `browser_platform` | `Win32` or `MacIntel` | derived from UA |
| `browser_version` | `5.0%20(Windows)` | **URL-encoded**, pre-encoded value |
| `channel` | `tiktok_web` | fixed |
| `cookie_enabled` | `true` | fixed |
| `device_platform` | `web_pc` | fixed |
| `focus_state` | `true` | fixed |
| `from_page` | *(empty)* | fixed |
| `history_len` | `4`–`14` | **random per process** |
| `is_fullscreen` | `false` | fixed |
| `is_page_visible` | `true` | fixed |
| `os` | `windows` or `mac` | derived from UA |
| `priority_region` | `US` | country code from location preset |
| `region` | `US` | country code from location preset |
| `screen_height` | `1080` | random from preset list |
| `screen_width` | `1920` | random from preset list |
| `tz_name` | `America/Toronto` | IANA tz from location preset |
| `webcast_language` | `en` | from location preset |
| `data_collection_enabled` | `true` | fixed |
| `user_is_login` | `false` | `true` only when a `sessionid` is set |
| `msToken` | *(empty)* | **left empty**; never compute `X-Bogus` |
| `device_id` | 19–20 digit number | **regenerated on every request** |
| `referer` | `https://www.tiktok.com/@<handle>/live` | set by the client |
| `root_referer` | `https://www.tiktok.com/@<handle>/live` | set by the client |

`device_id` derivation (`[TL] web_base.py::generate_device_id`):

```
random.randrange(10_000_000_000_000_000_000, 99_999_999_999_999_999_999)
```

i.e. a uniformly random integer in `[10^19, 10^20)`. In Rust:
`rand::rng().random_range(10_000_000_000_000_000_000u64..100_000_000_000_000_000_000u64)` (use `u128`
arithmetic or `rand::distr::Uniform` over `u64`; `u64::MAX ≈ 1.8e19` so the top of the range does not fit
`u64` — clamp to ~`9.2e18`, or generate a 19-digit decimal string directly).

**Required headers** (`[TL] web_settings.py::DEFAULT_REQUEST_HEADERS`):

```http
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36
Accept: text/html,application/json,application/protobuf
Referer: https://www.tiktok.com/
Origin: https://www.tiktok.com
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate
Connection: keep-alive
Cache-Control: max-age=0
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Sec-Fetch-Ua-Mobile: ?0
```

**Cookies:** `tt-target-idc=useast1a` (default; `[TL] web_settings.py::DEFAULT_COOKIES`).
`sessionid` is **not** required for stage 1.

**`browser_name` / `browser_version` / `User-Agent` must agree.** `[DOCS] custom-sign-servers`:
> *"the signature parameters encode your browser details, which must match the `browser_version` and
> `browser_name` query parameters. These must also match your `User-Agent` header."*

The `[TL]` presets derive them by splitting the UA at the first `/`:

```
browser_name    = urlencode(UA[..first_slash])          # e.g. "Mozilla"
browser_version = urlencode(UA[first_slash+1..])        # e.g. "5.0 (Windows NT 10.0; ...) Safari/537.36"
browser_platform= "MacIntel" if UA contains "Macintosh" else "Win32"
os              = "mac"      if UA contains "Macintosh" else "windows"
```

Note the UA strings are pre-encoded once in Python, then placed raw into the URL string — do **not**
double-encode.

### A.3 JSON field paths and live/offline detection

**room_id path:** `data.user.roomId` — a **string** of digits.

`[TL] fetch_room_id_api.py::parse_room_id` is literally `data['data']['user']['roomId']`.

**Live/offline signal:** `data.user.status` **and** `data.liveRoom.status`. `4` means **offline**.

`[TL] fetch_is_live.py::fetch_is_live_unique_id`:
```
response_json["data"]["liveRoom"]["status"] != 4      # True  => live
```
`[TL] fetch_room_id_live_html.py`: `if room_data.get('status') == 4: raise UserOfflineError(...)`.

`[PROBE A-1]` — real request for a user who is offline:

```
GET https://www.tiktok.com/api-live/user/room/?<base params>&sourceType=54&uniqueId=isaackogz
HTTP 200
```
```json
{
  "data": {
    "user": { "id":"6779789250017592326", "uniqueId":"isaackogz", "nickname":"Isaac 🇨🇦🍁",
              "secUid":"MS4wLjABAAAA8reuNQWczHjPgKB6LBEAcxgcDB4B5lE3mzrufe1fksc73eMORY-D-uyJGnqNK_Zg",
              "roomId":"7684008970436823815", "status":4, "followStatus":0 },
    "liveRoom": { "status":4, "startTime":1789072789, "title":"",
                  "liveRoomStats":{"enterCount":7,"userCount":1}, ... }
  },
  "message": "",
  "statusCode": 0
}
```

**⚠ Major gotcha:** `data.user.roomId` is **non-empty even when the user is offline** (it is the user's
"last room" ID). `status == 4` is the only reliable offline check. A Rust provider that blindly takes
`data.user.roomId` will hand a dead room to `/webcast/fetch` and produce a confusing failure.

### A.4 `is_live` check equivalent (preferred, cheap, unsigned)

**Method:** `GET`
**URL:** `https://webcast.tiktok.com/webcast/room/check_alive/`
**Route param:** `room_ids` = comma-separated list, e.g. `123,456` (plural; batches allowed)
**Body:** none. Uses the same base params + headers as A.2, but `device_platform=web` (not `web_pc`).

**Response shape:**
```json
{"data":[{"alive":false,"room_id":7684008970436823815,"room_id_str":"7684008970436823815"}],
 "extra":{"now":1789625067764}, "status_code":0}
```

`[TL] fetch_is_live.py::fetch_is_live_room_ids` returns `[i["alive"] for i in response_json["data"]]`.

`[PROBE A-2]` — **this endpoint works with NO signature and NO API key**:
```
GET https://webcast.tiktok.com/webcast/room/check_alive/?room_ids=7684008970436823815&<base params>
HTTP 200  →  {"data":[{"alive":false,"room_id":7684008970436823815,"room_id_str":"7684008970436823815"}],
              "extra":{"now":1789625067764},"status_code":0}
```

This is the cheapest and most reliable live check: no signature, no rate-limit budget against Euler,
and it accepts up to (at least) 50 room IDs per call. Prefer it over re-calling the room API.

### A.5 Fallback route — HTML scraping

`GET https://www.tiktok.com/@<unique_id>/live` with **no base params** (`base_params=False`), normal headers.

Parse: regex `<script id="SIGI_STATE" type="application/json">(.*?)</script>` (DOTALL) → `serde_json`
→ `LiveRoom.liveRoomUserInfo.user.roomId`.

* `LiveRoom` missing → user has never gone live / does not exist.
* `user.status == 4` → offline.
* Regex miss → *"Failed to extract the SIGI_STATE HTML tag, you might be blocked by TikTok."*
* JSON parse failure → captcha-blocked.

### A.6 Literal error responses (observed)

`[PROBE A-3]` — nonexistent user, **with** full base params:
```json
{"data":null,"message":"user_not_found","extra":{"id":"20260917140427F3E88F9B1E568123511E"},"statusCode":19881007}
```

`[PROBE A-4]` — valid params omitted (`uniqueId` + `sourceType` only):
```json
{"data":null,"message":"params_error","extra":{"id":"202609171404081A75491309B5BEE2126C"},"statusCode":19881005}
```

`[TL] fetch_room_id_api.py` raises `UserNotFoundError` when `response_json.get("message") == "user_not_found"`.
A non-JSON body means rate-limited/blocked → raise a distinct retryable error.

**Summary of literals to string-match:**

| Condition | `message` | `statusCode` | HTTP |
|-----------|-----------|--------------|------|
| success | `""` | `0` | 200 |
| user offline | `""` | `0` | 200 (`status == 4` in body) |
| user not found | `user_not_found` | `19881007` | 200 |
| missing base params | `params_error` | `19881005` | 200 |
| blocked / rate-limited | non-JSON body | — | 200 or 4xx |

### A.7 Values that must be randomised / computed in stage 1

| Value | Required? | Derivation |
|-------|-----------|------------|
| `device_id` | yes | random 19-digit integer, **new per request** |
| `history_len` | yes | random int in `[4, 14]` |
| `screen_width` / `screen_height` | yes | random pair from a preset table (e.g. 1920×1080, 2560×1440, 3840×2160, 4096×2160, 5120×2880, 7680×4320, 1152×2048, 1440×2560, 2160×3840, 4320×7680) |
| `last_rtt` | only for the **WS** URL | random int in `[100, 200]` |
| location/device preset | yes | pick one at startup (see preset list in `[TL] web_presets.py`) |
| `msToken` | **no — leave empty** | `// Note: Never include X-Bogus`. Do not fabricate `X-Bogus`, `X-Gnarly` or `msToken` for the direct TikTok call. |
| `X-Bogus`, `X-Gnarly` | **no** | these are what the *sign server* generates for `/webcast/im/fetch`; you never compute them |

`[TL] web_signer.py::webcast_sign` strips `X-Bogus`, `X-Gnarly`, `msToken` from any URL before asking the
sign server to sign it — do the same if you ever sign a URL yourself.

---

## B. STAGE 2 — obtain the signed WebSocket URL (free tier, NO API key)

### B.1 Sign-server host and path — **confirmed**

**Base URL:** `https://api.eulerstream.com`
**Path:** `/webcast/fetch`
**Full endpoint:** `GET https://api.eulerstream.com/webcast/fetch`

Evidence:

* `[TL] web_settings.py`: `tiktok_sign_url: str = "https://api.eulerstream.com"` — **not**
  `tiktok.eulerstream.com`.
* `[OAS]` `servers:` block:
  ```yaml
  servers:
  - description: Public Server (Community & Pro)
    url: https://api.eulerstream.com
  - description: Enterprise Server (Enterprise)
    url: https://tiktok.enterprise.eulerstream.com
  - description: Staging Server (Private Use)
    url: https://tiktok.staging.eulerstream.com
  ```
  and a paths entry `  /webcast/fetch:` with `operationId: FetchWebcastURL`.
* `[DOCS] signatures` still says *"The TikTok LIVE libraries request `https://tiktok.eulerstream.com`"* —
  **this page is stale.** The OpenAPI spec and the v7 source both say `api.eulerstream.com`.
  (`tiktok.eulerstream.com` may still be aliased for legacy clients, but do not target it.)

A separate endpoint, `/webcast/sign_url` (POST), exists for signing *other* TikTok URLs. It is **not**
needed for a read-only LIVE connection and is `PRO`-scoped. Ignore it.

### B.2 Method, parameters, headers

**Method:** `GET`
**Body:** none

**Query parameters** (`[OAS]` `/webcast/fetch`):

| Name | Required | Type | Default | Example | Meaning |
|------|----------|------|---------|---------|---------|
| `client` | no | string | `ttlive-other` | `ttlive-python` | Client library identifier, for metrics. Use something identifying your provider. |
| `room_id` | no* | string | — | `7684008970436823815` | Room ID to fetch the Webcast URL for. |
| `unique_id` | no* | string | — | `isaackogz` | Send **instead of** `room_id`. **Enterprise-only**; do not use on free tier. |
| `cursor` | no | string | — | `"<base64 cursor>"` | Starting cursor for resume. |
| `user_agent` | no | string | — | the exact UA you will use for the WS | Overrides the UA used for signing **and** fetching. Must match `browser_name`/`browser_version` semantics. |
| `client_enter` | no | boolean | `true` | `true` | Whether the client enters the room via query params (sign server performs the enter) or the client sends `im_enter_room` itself. |
| `country` | no | enum | — | `US` | Proxy egress country. Free tier: leave unset. Enum: `US,GB,DE,RO,ES,BE,FR,CA,JP,BR,MX,CO,AR,CL,AU,KR,PE,PL,SG,IT`. |
| `platform` | no | enum | — | `web` | **`web` or `mobile`.** `mobile` requires a valid `sessionid`. |
| `session_id` | no, deprecated | string | — | — | Use `x-cookie-header` instead. |
| `tt_target_idc` | no, deprecated | string | — | — | Use `x-cookie-header` instead. |

\* `room_id` or `unique_id` should be supplied; `room_id` on the free tier.

`[TL] fetch_signed_websocket.py` passes exactly: `client`, `room_id`, `user_agent`, `platform`,
`client_enter=true`, and conditionally `session_id` / `tt_target_idc`.

**Headers:**

| Header | Value | Required |
|--------|-------|----------|
| `User-Agent` | `TikTokLive.py/7.0.1` in `[TL]`; any stable identifier for you | recommended |
| `X-Api-Key` | Euler API key | **only if you have one** — omit for anonymous |
| `x-oauth-token` | OAuth access token | optional alternative auth |
| `x-cookie-header` | `sessionid=…; tt-target-idc=…` | optional; only to act as a logged-in viewer |

`[TL] web_signer.py` sends `{"User-Agent": f"TikTokLive.py/{PACKAGE_VERSION}"}` and, if a key is present,
`AuthenticatedClient(..., auth_header_name="X-Api-Key", prefix="")`. With no key it constructs a plain
`Client` — with the comment:

> `# ``asyncio_detailed`` is annotated as taking ``AuthenticatedClient`` only, but at runtime ``Client``
> works identically — it just omits the auth header. **Anonymous (no API key) callers depend on this.**`

`[TL] web_signer.py` also sets `verify_ssl=False` on the SDK client. Not required for correctness, but it
explains why the reference implementation does not fail behind intercepting proxies.

### B.3 Response shape

**Success = HTTP 200** and the body is **raw protobuf bytes** — a `WebcastResponse`
(`[OAS]` declares the 200 schema as `Uint8Array`; `[TL]` does `data: bytes = response.content`).

`[PROBE B-1]` — anonymous call, no API key:
```
GET https://api.eulerstream.com/webcast/fetch?client=ttlive-python&room_id=7684008970436823815&platform=web&client_enter=true
HTTP 200, Content-Type: application/protubuf
```
The body is protobuf, so it cannot be pasted as JSON. Note the **misspelled content type**
`application/protubuf` (Euler's typo for `protobuf`).

> **Rust gotcha:** do **not** gate on `Content-Type`. Read the body as bytes whenever the status is 200.

Decoded, the envelope is (`[TLR]`/`[GTL]` `WebcastResponse`, field numbers in section E.2). A realistic
reconstruction of the decoded value:

```jsonc
{
  "messages": [ /* prototype of the first-payload events; may be non-empty */ ],
  "cursor": "Cg8KCwiS0q2SBhCwqLLMAhIEIAEoAQ==",   // opaque, base64-ish, treat as blob
  "fetchInterval": 0,
  "now": 1789625067764,
  "internalExt": "IAEoAQ==",                      // bytes!
  "fetchType": 1,                                  // 1 = ws
  "routeParamsMap": {
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; …) Safari/537.36",
    "webcast_language": "en"
  },
  "heartBeatDuration": 10000,
  "needsAck": true,
  "pushServer": "wss://webcast.tiktok.com/webcast/im/ws/…",
  "isFirst": true,
  "historyCommentCursor": "",
  "historyNoMore": true
}
```

**Which fields carry what:**

| Need | Field |
|------|-------|
| WebSocket URL | `pushServer` (field **10**) — a full `wss://` URL |
| resume token | `cursor` (field **2**) |
| ACK token | `internalExt` (field **5**) |
| WS query additions | `routeParamsMap` (field **7**) — `map<string,string>` |
| heartbeat period | `heartBeatDuration` (field **8**) — milliseconds |
| ACK required? | `needsAck` (field **9**) |
| first payload? | `isFirst` (field **11**) |

**Response headers you must read:**

| Header | Required | Purpose |
|--------|----------|---------|
| `X-Set-TT-Cookie` | **yes** | TikTok cookies (notably `tt-target-idc`, `ttwid`) that must be forwarded to the WebSocket. `[TL]` raises `SignAPIError(EMPTY_COOKIES, "Sign server did not return cookies!")` if missing. |
| `X-Agent-Id` | no | diagnostics |
| `X-Request-Id` | no | diagnostics / support |
| `X-Log-Code` | no | diagnostics |
| rate-limit reset headers | no | *"Headers are included in the response data for when you can request again"* |

`X-Set-TT-Cookie` is a **cookie-style string** (`name=value; name2=value2`), not `Set-Cookie`. Parse it with
a cookie parser, store the cookies against domain `.tiktok.com`, and reuse the jar for both the WS handshake
and any subsequent TikTok HTTP call. `[TL]` explicitly re-inserts them on `.tiktok.com` to avoid duplicate
cookies when a cookie of the same name already exists.

### B.4 Cursor and `internalExt` — representation and reuse

* Both are **opaque byte strings**. `[TLR]` declares `internalExt` as `string`; `[GTL]` declares it as
  `bytes`; `[ZTC]` declares it as `string`. They are wire-identical on field 5. **Declare it `bytes`
  (`Vec<u8>`) in Rust** — that is lossless, avoids UTF-8 validation failures, and is what the ACK path
  needs (`payload=(internal_ext or "-").encode()`).
* `cursor` **resumes the stream**: pass it back as the `cursor` query parameter of `/webcast/fetch`.
  `[OAS]`: *"Starting cursor for the webcast connection, if any"*.
* `internalExt` **acknowledges a frame**: it goes into the `Payload` of the `ack` push frame (section D.4).
* They are **not interchangeable**.
* `[TLR]` re-sends the *last received* `internalExt` as the ACK payload for `needsAck` responses;
  `[TL]` sends `internal_ext` or the literal `"-"` when empty.
* Persist the latest `cursor` per connection so a reconnect can resume rather than replay.

### B.5 Rate limiting, bad signature, and free-tier limits

**HTTP status codes and bodies:**

| Status | Meaning | Body / handling |
|--------|---------|-----------------|
| `200` | OK | raw protobuf. **If the body is empty** → `[TL]` raises `SignAPIError(EMPTY_PAYLOAD, "Sign API returned an empty request. Are you being detected by TikTok?")`. Treat empty 200 as a hard error, not a retry-storm. |
| `429` | **rate limit** | JSON body. `[TL]` parses `data_json["message"]` and `data_json["limit_label"]` and throws `SignatureRateLimitError` with the template `"{limit_label}Too many connections started, try again in %s seconds."` |
| `403` | permission / premium route | `[TL] web_signer.py` also checks a **body-level** `code == 403` and raises `PremiumEndpointError` ("You do not have permission from the signature provider to sign this URL."). So: **inspect the JSON body's `code` even on HTTP 200.** |
| other non-200 | signature failure | `[TL]` raises `SignAPIError(SIGN_NOT_200, …)` and pretty-prints the payload |
| connect error | — | `SignAPIError(CONNECT_ERROR)` |

`[DOCS] /api/docs/md/api/rate-limits` (verbatim):

> *"If you exceed the limit, a **429 HTTP Error code** will be returned. Headers are included in the
> response data for when you can request again, but you can also check them with the `/webcast/rate_limits`
> endpoint. For example, the current rate limits for **anonymous connections** are as follows: …"*
>
> *"**Increasing Your Limits.** If you don't have an API key, sign up for one, and you'll get an immediate
> free increase to the rate limit."*

**Anonymous free-tier limits — measured live, no API key** `[PROBE B-2]`:
```
GET https://api.eulerstream.com/webcast/rate_limits
HTTP 200
{"code":200,"message":"Successfully retrieved WEBCAST rate limits!",
 "day":   {"max":100,"remaining":100,"reset_at":null},
 "hour":  {"max":30, "remaining":30, "reset_at":null},
 "minute":{"max":5,  "remaining":5,  "reset_at":null}}
```

So, anonymously: **5/minute, 30/hour, 100/day**. This is the binding constraint on the provider: you can
open at most 5 new connections per minute and 100 per day without a key. A long-lived connection consumes
one `/webcast/fetch` call, so sustained single-stream monitoring is fine; a reconnect loop is not.

**Note:** `[OAS]`'s `GetRateLimits` schema additionally exposes `load_shedding: { at, chance }` — the
server may shed load probabilistically even below the nominal limits. Treat any non-200 as
backoff-and-retry with jitter, never as a tight loop.

**`/webcast/rate_limits` is the cheapest way to implement a budget guard** — it is `PUBLIC`-scoped and
returns `remaining` per window.

### B.6 Is `sessionid` / authentication required? What degrades without it?

**No.** For a read-only LIVE connection on the `web` platform:

* `[OAS]` `/webcast/fetch` description, verbatim:
  > *"**Authentication (Optional):** Anonymous access is supported. For authenticated requests, provide
  > exactly one of the following headers: `x-oauth-token` … `x-cookie-header` …"*
* `[OAS]` security block for `/webcast/fetch`:
  ```yaml
  security:
  - jwt_key_header: [PUBLIC]
    api_key_query: [PUBLIC]
    api_key_header: [PUBLIC]
  ```
  Scope `PUBLIC` — the same scope the docs describe as *"the unauthenticated limits if no key is provided"*.
* `[TL] fetch_signed_websocket.py` only logs a **warning** when a session is present:
  > `"Sending session ID to sign server for WebSocket connection. This is a risky operation."`
  and only *requires* it for `platform == "mobile"`:
  > `raise ValueError("Mobile platform requires a 'sessionid' cookie to be set, …")`
* `[TL] client.py` sets `user_is_login=false` and every request works without a session. The Python
  library's own tagline is *"No login, no credentials or app are required."*

**What you lose without a `sessionid`:**

| Capability | Anonymous | With session / auth |
|------------|-----------|---------------------|
| Read chat, gifts, likes, joins, viewer counts (web platform) | ✅ | ✅ |
| `platform=mobile` | ❌ rejected | ✅ |
| Sending chat / gifts, moderation, premium routes | ❌ (`403` / `PremiumEndpointError`) | ✅ |
| Rate limit | 5/min, 30/hr, 100/day | higher |
| Risk | — | *"a risky operation"* — a session tied to a real account can be banned |

**Recommendation:** go anonymous. It is explicitly supported, and it keeps the provider read-only.

---

## C. STAGE 3 — WebSocket handshake

### C.1 URL construction

`[TL] ws_utils.py::build_webcast_uri` builds:

```
connect_uri = push_server + "?" + join("&", f"{k}={v}" for k, v in uri_params) + base_uri_append_str
```

where

```
uri_params = { percent_encode(v) : k for route_params }   # route params FIRST, all values encoded
           ⊕ base_uri_params                              # then base params, values NOT re-encoded
```

Two ordering/encoding rules that are easy to get wrong:

1. **`routeParamsMap` keys keep their name; their values are percent-encoded** with `safe=""`
   (encode *everything*). `[TL]` comments explain why:
   > *"Route params arrive verbatim from the sign server and must be percent-encoded: the Euler Stream
   > fallback push server echoes the raw user agent back as a route param, and its spaces and parentheses
   > are illegal in an HTTP request-target (the server answers 400)."*
   An unencoded `(` / `)` / space in a route-param value yields **HTTP 400** at upgrade time.
2. **Base params are inserted raw** — the device presets already ship pre-encoded values such as
   `browser_version=5.0%20(Windows)`. Re-encoding them double-encodes and breaks the signature match.
3. Empty route-param values are dropped (`if v`).

**Base WS parameters** (`[TL] web_settings.py::DEFAULT_WS_CLIENT_PARAMS`) — note this is a **different set**
from the HTTP base params:

| Name | Example | Notes |
|------|---------|-------|
| `aid` | `1988` | fixed |
| `app_language` | `en` | location preset |
| `app_name` | `tiktok_web` | fixed |
| `browser_platform` | `Win32` | from UA |
| `browser_language` | `en-US` | location preset |
| `browser_name` | `Mozilla` | pre-encoded |
| `browser_version` | `5.0%20(Windows)` | pre-encoded |
| `browser_online` | `true` | |
| `cookie_enabled` | `true` | |
| `tz_name` | `America/Toronto` | location preset |
| `device_platform` | `web` | **`web`, not `web_pc`** |
| `identity` | `audience` | |
| `live_id` | `12` | |
| `sup_ws_ds_opt` | `1` | |
| `update_version_code` | `2.0.0` | |
| `version_code` | `180800` | (plus a duplicated second value below) |
| `client_enter` | `1` | |
| `ws_direct` | `1` | |
| `did_rule` | `3` | |
| `webcast_language` | `en` | location preset |
| `screen_height` | `1080` | screen preset |
| `screen_width` | `1920` | screen preset |
| `heartbeat_duration` | `10000` | ms |
| `resp_content_type` | `protobuf` | **required** |
| `history_comment_count` | `6` | |
| `last_rtt` | `100`–`200` | **random per process** |
| `room_id` | `7684008970436823815` | appended by the WS client, overrides any collision |
| `compress` | `gzip` (or empty string to disable) | appended by the WS client |

Then `base_uri_append_str` is appended **verbatim**:

```
DEFAULT_WS_CLIENT_PARAMS_APPEND_STR = "&version_code=270000"
```

`[TL]` comment:
> *"Don't ask me why, but the URL has an EXTRA version_code on prod. Since Python dicts can't handle
> duplicate keys, we have to append it manually."*

So the final URL contains `version_code=180800` **and** a later `version_code=270000`. Reproduce this
exactly.

**Resulting example:**

```
wss://<host from pushServer>/webcast/im/ws/<opaque>?user_agent=Mozilla%2F5.0%20%28Windows%20NT%2010.0%3B%20Win64%3B%20x64%29%20AppleWebKit%2F537.36%20%28KHTML%2C%20like%20Gecko%29%20Chrome%2F147.0.0.0%20Safari%2F537.36&webcast_language=en&aid=1988&app_language=en&app_name=tiktok_web&browser_platform=Win32&browser_language=en-US&browser_name=Mozilla&browser_version=5.0%20(Windows)&browser_online=true&cookie_enabled=true&tz_name=America/Toronto&device_platform=web&identity=audience&live_id=12&sup_ws_ds_opt=1&update_version_code=2.0.0&version_code=180800&client_enter=1&ws_direct=1&did_rule=3&webcast_language=en&screen_height=1080&screen_width=1920&heartbeat_duration=10000&resp_content_type=protobuf&history_comment_count=6&last_rtt=137&room_id=7684008970436823815&compress=gzip&version_code=270000
```

Note: `pushServer` may point at TikTok directly (`wss://webcast.tiktok.com/...`) **or** at an Euler
fallback push server (which is why route params contain a raw user agent). Handle both; do not assume the
host.

### C.2 Required upgrade headers

`[TLR] live_client_websocket.rs` constructs this request — this is a **working, MIT-licensed, Rust**
handshake, and is the best template:

```http
GET <connect_uri> HTTP/1.1
Host: <host>
Upgrade: websocket
Connection: keep-alive
Cache-Control: max-age=0
Accept: text/html,application/json,application/protobuf
Sec-Websocket-Key: asd
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36
Referer: https://www.tiktok.com/
Origin: https://www.tiktok.com
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate
Cookie: <cookie string from X-Set-TT-Cookie plus tt-target-idc>
Sec-Websocket-Version: 13
```

`[TL]` sends the same idea through the `websockets` library, with `extra_headers` limited to:

```http
Cookie: tt-target-idc=useast1a; <cookies from X-Set-TT-Cookie>
User-Agent: <the exact UA used for signing>
```

Notes:

* **Origin IS sent**, and it is `https://www.tiktok.com`. (The task brief asks about this; both `[TLR]`
  and the `[TL]` default header set include it. `Origin` is not in `[TL]`'s explicit WS `extra_headers` —
  the `websockets` library does not add one — so `Origin` is *recommended* rather than strictly proven
  necessary. Send it.)
* **The `User-Agent` must be byte-identical to the `user_agent` you signed with** (and to the UA whose
  `browser_name`/`browser_version` you put in the query string). Signature mismatch is the #1 cause of
  upgrade rejection.
* `Sec-Websocket-Key: asd` is not a valid RFC 6455 key (must be 16 random bytes, base64). TikTok evidently
  does not validate it in the way a spec-compliant server would. **With `tokio-tungstenite`, prefer letting
  the library generate a proper key** (use `connect_async(url)` with `IntoClientRequest` and then push the
  extra headers) rather than hand-building the `Request` — hand-building is what forces the dummy key.
* `Connection: keep-alive` is what `[TLR]` sends instead of `Connection: Upgrade`. Both are accepted;
  `tokio-tungstenite` will emit `Upgrade` itself.
* **Cookies:** `[TL]` builds the string as `f"{key}={value};"` joined by a **space** — i.e.
  `"a=1; b=2;"`. Standard clients should join with `"; "` and no trailing delimiter; the spaced form is a
  quirk that works because TikTok's parser is lenient.

### C.3 Subprotocols and compression extensions

**Subprotocols:** `[TL] ws_client.py` passes
```python
subprotocols=ws_kwargs.pop("subprotocols", ["echo-protocol"])
```
So the handshake offers **`Sec-WebSocket-Protocol: echo-protocol`**. In practice TikTok does not require a
subprotocol to be agreed; with `tokio-tungstenite` you may offer it via
`tungstenite::client::IntoClientRequest` + `Sec-WebSocket-Protocol: echo-protocol`, or omit it. Omitting it
is lower-risk than agreeing to a protocol you do not implement.

**Compression:** none at the **WebSocket extension** level (`permessage-deflate` is not negotiated). Gzip is
requested at the **application** level instead, via the `compress=gzip` query parameter, and the compression
flag arrives **per frame inside `WebcastPushFrame.headers`** (section D.3). Do not enable
`permessage-deflate`; you would add a second, unrelated decompression layer.

### C.4 Handshake failure signals

`[TL] ws_connect.py` maps upgrade failures:

* **HTTP 400** → `WebcastBlockedError` with the reason from the `Handshake-Msg` response header:
  > `WebSocket rejected by TikTok due to "400 Bad Request" with reason "{Handshake-Msg}"`
  Typical cause: a malformed/unsigned query string (see the percent-encoding rule in C.1).
* **HTTP 200** (an HTTP status where you expected a 101) → also a rejection. `[TL]` comment:
  > *"IF the WebSockets are >>SIGNED<< WITH A SESSION ID and you DO NOT pass a sessionid cookie in the
  > header, it will reject for 'illegal secret key'."*
  → `WebcastBlockedError(f'WebSocket rejected by TikTok due to "{Handshake-Msg}".')`
* **`[TL]` disables retries** for the upgrade. Comment:
  > *"It disables retry mechanisms and **disallows** reconnects, since signed URLs expire after 30 seconds.
  > Also, the default mechanism in the `websockets` library ignores the '200' error code and retries, even
  > though this is a 'detected by TikTok' error & thus retrying is useless."*

Read `Handshake-Msg` on failure and surface it verbatim — it is the only diagnostic TikTok gives.

**Success response header:** `Handshake-Options` — a **cookie-style string** of server options. `[TL]`
parses it and reads `ping-interval` (seconds) to override the default heartbeat period. Treat this as the
authoritative heartbeat interval when present.

---

## D. STAGE 4 — frame decoding pipeline, step by step

### D.1 Wire format of a received message

Every WebSocket binary message is a **`WebcastPushFrame`** wrapper — yes, a wrapper.

```
WebSocket binary message
  └─ protobuf: WebcastPushFrame {
       SeqId           = 1  (uint64)
       LogId           = 2  (uint64)
       Service         = 3  (uint64)
       Method          = 4  (uint64)
       headers         = 5  (map<string,string>  — see D.3 note)
       PayloadEncoding = 6  (string)   e.g. "pb"
       PayloadType     = 7  (string)   "msg" | "hb" | "ack" | "im_enter_room" | ...
       Payload         = 8  (bytes)    the inner serialized message
     }
```

**The inner payload is raw `bytes` — not base64.** Protobuf `bytes` is length-delimited binary; there is
no base64 layer anywhere in the pipeline. `[TLR]` does `WebcastPushFrame::parse_from_bytes(&buffer)` then
`WebcastResponse::parse_from_bytes(push_frame.Payload.as_mut_slice())`.

**Step 1 — always discard non-`msg` frames.** `[TL] ws_connect.py`:

> *"Only `msg` frames carry the event stream. Everything else (`hb` server heartbeat, `ack` receipt signal,
> `im_enter_room_resp` room-switch ack, etc.) is transport-level and intentionally discarded — matching how
> the JS connector handles them."*

Implementation: `if push_frame.payload_type != "msg" { continue }`.

`[TLR]` skips this check and parses every frame as a `WebcastResponse` (harmless but wasteful). Follow `[TL]`.

### D.2 Do not trust "the message is always a `msg` frame" — but do trust `PayloadType`

`PayloadType` is a free-form string. Observed values across implementations: `msg`, `hb`, `ack`,
`im_enter_room`, `im_enter_room_resp`. Only `msg` is an event. Log others at DEBUG.

### D.3 Decompression rule

Compression is **not** detectable from the WebSocket layer. It is signalled **per frame** by a header entry
inside `WebcastPushFrame.headers` with key `compress_type`:

| `compress_type` value | Action |
|-----------------------|--------|
| absent, or `"none"` | parse `Payload` directly as `WebcastResponse` |
| `"gzip"` | **GZIP-decompress** `Payload` (gzip container, i.e. 1f 8b magic — `GzipFile`, not raw deflate), then parse |
| anything else | log an error ("TikTok update"), and attempt to parse the raw payload anyway |

`[TL] ws_utils.py::extract_webcast_response_message` performs exactly this dispatch.

**Two ways to get gzip frames:**

* **You asked for them:** `compress=gzip` in the connect URL. `[TL]` defaults `compress_ws_events=True`.
  This is the recommended setting — it substantially reduces bandwidth.
* **You did not:** send `compress=` (empty). `[TLR]` takes this path and never gunzips. Frames then arrive
  uncompressed and the `compress_type` header is absent/`none`.

**Recommendation:** request `compress=gzip` and implement gunzip. It is a single `flate2::read::GzDecoder`
call and matches the reference implementation's default.

**`headers` map vs list — a real v2/v3 divergence.** `[TLR]`/`[GTL]`/`[ZTC]` all declare
`map<string, string> headers = 5`. `[TL]` v7's `ws_utils.py` says:

> *"v3 `WebcastPushFrame.headers` is `list[PushHeader]` (each header is a `{key, value}` message), not
> a dict."*

These are **wire-compatible**: `map<string,string>` is encoded as `repeated` entries of
`{1: string key, 2: string value}` — identical to a `repeated PushHeader{ key=1; value=2; }`. So:

* In Rust/prost, declaring `map<string, string> headers = 5;` **works** and is the simplest option.
* Caveat: a `HashMap` collapses duplicate keys (last wins). If you need every entry, declare
  `repeated PushHeader headers = 5;` instead. For `compress_type` lookup, `HashMap` is sufficient.

### D.4 The `WebcastResponse` envelope, and how to ACK

Payload decoded → `WebcastResponse` (aka `ProtoMessageFetchResult`) — full definition in E.2.

**Field-by-field:**

| Field | # | Type | Behaviour |
|-------|---|------|-----------|
| `messages` | 1 | `repeated Message` | the event batch |
| `cursor` | 2 | `string` | resume token; **store the latest** |
| `fetchInterval` | 3 | `int64` | polling hint (ws mode: unused) |
| `now` | 4 | `int64` | server time (ms) |
| `internalExt` | 5 | `bytes` (see B.4) | ACK token |
| `fetchType` | 6 | `int32` | `1` = ws, `2` = polling |
| `routeParamsMap` | 7 | `map<string,string>` | only meaningful on the *initial* `/webcast/fetch` response |
| `heartBeatDuration` | 8 | `int64` | heartbeat period (ms); reference sends every 5 s or `Handshake-Options.ping-interval` |
| `needsAck` | 9 | `bool` | **if true, you must ACK this frame** |
| `pushServer` | 10 | `string` | only on the initial response |
| `isFirst` | 11 | `bool` | true on the initial payload → trigger `im_enter_room` + start heartbeat |
| `historyCommentCursor` | 12 | `string` | history paging |
| `historyNoMore` | 13 | `bool` | history exhausted |

**ACK — exact frame to send** (`[TL] send_ack`, corroborated by `[TLR]`):

```
WebcastPushFrame {
  SeqId           = ""        // unset (0)
  LogId           = <LogId of the WebcastPushFrame you are ACKing>   // field 2 — CRITICAL
  Service         = ""        // unset
  Method          = ""        // unset
  headers         = []        // empty
  PayloadEncoding = "pb"
  PayloadType     = "ack"
  Payload         = <WebcastResponse.internalExt as raw bytes, or b"-" if empty>
}
```

Serialize and send as a **binary** WebSocket message.

* The **`LogId` must be copied from the enclosing `WebcastPushFrame`**, not from the response. `[TL]`
  passes `log_id=webcast_push_frame.log_id`.
* `[TLR]` sends empty bytes when `internalExt` is empty (no `"-"` fallback). Both are accepted.
* Skipping ACKs causes the server to stop delivering (or to close the stream) — do not skip.
* The **very first** response (yielded from the sign-server payload, not from a WS frame) has no enclosing
  push frame, so **no ACK is sent for it**:
  > *"The first message does NOT need an ack since we perform the ack with the actual WebSocket connect URI"*
  In practice, ACK only when you decoded the response from a real `WebcastPushFrame`.

### D.5 Mapping `Message.method` → protobuf type

`WebcastResponse.Message` (v3 name: `BaseProtoMessage`):

| Field | # | Type |
|-------|---|------|
| `method` | 1 | `string` |
| `payload` | 2 | `bytes` |
| `msgId` | 3 | `int64` |
| `msgType` | 4 | `int32` |
| `offset` | 5 | `int64` |
| `isHistory` | 6 | `bool` |

(`[ZTC]`'s older schema names fields 1/2 `type`/`binary` — same numbers, same types.)

Dispatch: `match message.method.as_str()` → decode `message.payload` with that type. Unknown method →
emit an `Unknown` event carrying the raw bytes; **never** drop silently (that is how you discover schema
drift).

**Method strings → types actually used** (from `[TL]` `EVENT_MAPPINGS` inputs, `events.yaml`,
`proto_events.py`):

| `method` string | Message type | v7 event class |
|-----------------|--------------|----------------|
| `WebcastChatMessage` | `WebcastChatMessage` | `CommentEvent` |
| `WebcastGiftMessage` | `WebcastGiftMessage` | `GiftEvent` |
| `WebcastLikeMessage` | `WebcastLikeMessage` | `LikeEvent` |
| `WebcastMemberMessage` | `WebcastMemberMessage` | `JoinEvent` |
| `WebcastSocialMessage` | `WebcastSocialMessage` | `SocialEvent` (+ `FollowEvent`/`ShareEvent`) |
| `WebcastRoomUserSeqMessage` | `WebcastRoomUserSeqMessage` | `RoomUserSeqEvent` |
| `WebcastControlMessage` | `WebcastControlMessage` | `ControlEvent` (+ `LiveEnd`/`LivePause`/`LiveUnpause`) |
| `WebcastRoomMessage` | `WebcastRoomMessage` | `RoomEvent` |
| `WebcastRoomPinMessage` | `WebcastRoomPinMessage` | `RoomPinEvent` |
| `WebcastEmoteChatMessage` | `WebcastEmoteChatMessage` | `EmoteChatEvent` |
| `WebcastEnvelopeMessage` | `WebcastEnvelopeMessage` | `EnvelopeEvent` |
| `WebcastSubNotifyMessage` | `WebcastSubNotifyMessage` | `SubNotifyEvent` |
| `WebcastBarrageMessage` | `WebcastBarrageMessage` | `BarrageEvent` |
| `WebcastCaptionMessage` | `WebcastCaptionMessage` | `CaptionEvent` |
| `WebcastGoalUpdateMessage` | `WebcastGoalUpdateMessage` | `GoalUpdateEvent` |
| `WebcastImDeleteMessage` | `WebcastImDeleteMessage` | `ImDeleteEvent` |
| `WebcastInRoomBannerMessage` | `WebcastInRoomBannerMessage` | `InRoomBannerEvent` |
| `WebcastLiveIntroMessage` | `WebcastLiveIntroMessage` | `LiveIntroEvent` |
| `WebcastMsgDetectMessage` | `WebcastMsgDetectMessage` | `MessageDetectEvent` |
| `WebcastOecLiveShoppingMessage` | `WebcastOecLiveShoppingMessage` | `OecLiveShoppingEvent` |
| `WebcastPollMessage` | `WebcastPollMessage` | `PollEvent` |
| `WebcastQuestionNewMessage` | `WebcastQuestionNewMessage` | `QuestionNewEvent` |
| `WebcastRankTextMessage` | `WebcastRankTextMessage` | `RankTextEvent` |
| `WebcastRankUpdateMessage` | `WebcastRankUpdateMessage` | `RankUpdateEvent` |
| `WebcastHourlyRankMessage` | `WebcastHourlyRankMessage` | `HourlyRankRewardEvent` |
| `WebcastLinkMicBattle` | `WebcastLinkMicBattle` | `LinkMicBattleEvent` |
| `WebcastLinkMicArmies` | `WebcastLinkMicArmies` | `LinkMicArmiesEvent` |
| `WebcastLinkMicMethod` | `WebcastLinkMicMethod` | `LinkMicMethodEvent` |
| `WebcastLinkMicFanTicketMethod` | `WebcastLinkMicFanTicketMethod` | `LinkMicFanTicketMethodEvent` |
| `WebcastLinkMicBattlePunishFinish` | `WebcastLinkMicBattlePunishFinish` | `LinkMicBattlePunishFinishEvent` |
| `WebcastLinkmicBattleTaskMessage` | `WebcastLinkmicBattleTaskMessage` | `LinkmicBattleTaskEvent` |
| `WebcastLinkMessage` | `WebcastLinkMessage` | `LinkEvent` |
| `WebcastLinkLayerMessage` | `WebcastLinkLayerMessage` | `LinkLayerEvent` |
| `WebcastSystemMessage` | `WebcastSystemMessage` | `SystemEvent` |
| `WebcastUnauthorizedMemberMessage` | `WebcastUnauthorizedMemberMessage` | `UnauthorizedMemberEvent` |
| `WebcastRoomVerifyMessage` | `RoomVerifyMessage` | `RoomVerifyEvent` |
| `WebcastLiveGameIntroMessage` | `WebcastLiveGameIntroMessage` | `LiveGameIntroEvent` |

**Derived / filtered events are NOT separate methods.** They are computed from a base message:

* `FollowEvent` / `ShareEvent` ← `WebcastSocialMessage`, discriminated by **substring match on
  `common.displayText.key`** (`[TL] client.py::handle_custom_event`, verbatim logic):
  > *"FollowEvent / ShareEvent — keyed off the common display-text marker."*
  ```
  common_dt = common_display_type(event.common)   # = common.display_text.key  (field 8 → field 1)
  if "follow" in common_dt: → FollowEvent
  if "share"  in common_dt: → ShareEvent
  ```
  **This is the authoritative discriminator** — do not use `action` (field 4). `common.display_text` is
  `Common` field **8**, and `Text.key` is `Text` field **1** (v3 renamed v2's `display_type` → `key`;
  same number, same type).
* `LiveEndEvent` ← `WebcastControlMessage` with `action ∈ {STREAM_ENDED, STREAM_SUSPENDED}`.
  `LivePauseEvent` ← `STREAM_PAUSED`. `LiveUnpauseEvent` ← `STREAM_UNPAUSED`. (`ControlAction` enum,
  `WebcastControlMessage` field 2.)
* `SuperFanEvent` / `SuperFanJoinEvent` ← `WebcastBarrageMessage`, substring match on
  `ttlive_superfan` / `ttlive_superfan_commentnotif_superfanjoined` in either
  `content.display_type` or `common_barrage_content.display_type`.
* `SuperFanBoxEvent` ← `WebcastEnvelopeMessage` where `common.display_text.key` contains
  `ttlive_superfanbox`, **or** `envelope_info.business_type == 19` (`SUPER_FAN_BOX`; v3 renamed the enum
  variant but the wire value 19 is unchanged).

### D.6 Heartbeat / ping behaviour

**Two layers, and the library layer is disabled:**

1. **WebSocket protocol pings are turned OFF.** `[TL] ws_client.py` passes `ping_timeout=None,
   ping_interval=None`. The comment explains why:
   > *"When `ping_timeout` is set … the client waits for a pong for N seconds. **TikTok DO NOT SEND pongs
   > back.** … `websockets.exceptions.ConnectionClosedError: sent 1011 (unexpected error) keepalive ping
   > timeout; no close frame received`. If you set `ping_timeout` to `None`, it doesn't wait for a pong.
   > Perfect, since TikTok don't send them."*
   **→ In Rust, disable tungstenite's automatic ping** (`WebSocketConfig { … }`; with
   `tokio-tungstenite` use `connect_async_with_config` and leave ping handling to your own loop). If you
   enable automatic pings you will get spurious disconnects.

2. **Application-level heartbeat frames.** Send a `WebcastPushFrame` with `PayloadType = "hb"`:

   *Preferred (v7 form — carries a payload, sequence-numbered):*
   ```
   WebcastPushFrame {
     headers         = []
     PayloadEncoding = "pb"
     PayloadType     = "hb"
     Payload         = serialize(HeartBeatMessage { room_id, sendPacketSeqId })
   }
   ```
   `[TL] ws_client.py::_ping_loop_fn`:
   * period = `Handshake-Options["ping-interval"]` if present, else **5.0 s**
     (`DEFAULT_PING_INTERVAL = 5.0`)
   * `_seq_id` starts at **1** and increments by 1 per heartbeat; reset to 1 on `restart_ping_loop`
   * `room_id` is the connected room

   *Minimal form (proven in Rust — MIT `[TLR]`):* `[TLR]` sends the literal 4 bytes
   `[0x3a, 0x02, 0x68, 0x62]` every **9 s**. Decoding: `0x3a` = tag for field **7**, wire type 2;
   `0x02` = length 2; `0x68 0x62` = `"hb"`. i.e. a `WebcastPushFrame` with **only**
   `PayloadType = "hb"` set and **no payload**. This works and requires no `HeartBeatMessage` definition
   at all.

   **Recommendation:** start with the minimal 4-byte form (zero schema risk), and move to the
   sequence-numbered form if TikTok ever starts requiring it. Send it every 5–10 s; the server's
   `Handshake-Options.ping-interval` takes precedence when present.

   > `HeartBeatMessage` field numbers are **not present in any MIT proto source consulted**
   > (`[TLR]`, `[GTL]`, `[ZTC]`). They live in `TikTokLiveProto.v3`. Widely-used community layouts are
   > `int64 roomId = 1; int64 sendPacketSeqId = 2;` (PascalCase in the original, `room_id`/`send_packet_seq_id`
   > in v3) — **treat these as unverified** and prefer the empty-payload heartbeat above, which sidesteps
   > the question entirely.

### D.7 Room entry (`im_enter_room`) on first response

When `WebcastResponse.is_first == true`, `[TL]` sends a room-enter frame and (re)starts the heartbeat loop:

```
WebcastPushFrame {
  PayloadType     = "im_enter_room"
  PayloadEncoding = "pb"
  Payload         = serialize(WebcastImEnterRoomMessage {
                      room_id, room_tag = "", live_id = 12, identity = "audience",
                      cursor = "", account_type = 0, enter_unique_id = 0,
                      filter_welcome_msg = "0", is_anchor_continue_keep_msg = false })
}
```

`[TL] switch_rooms()` also sets `room_tag = ""` and resets the ping sequence to 1.

> **Unverified field numbers.** `WebcastImEnterRoomMessage` is likewise **not in any MIT proto source
> consulted**; the field *names* above are the constructor kwargs from `[TL] ws_client.py`. The
> widely-used community layout is:
> `int64 roomId = 1; string roomTag = 2; int64 liveId = 3; string identity = 4; string cursor = 5;
> int64 accountType = 6; int64 enterUniqueId = 7; string filterWelcomeMsg = 8;
> bool isAnchorContinueKeepMsg = 9;` — **treat as unverified.**

**Because you pass `client_enter=true` to `/webcast/fetch` (the `[TL]` default), the sign server already
performs the room entry.** `[OAS]` describes `client_enter` as *"Whether the client enters a room after
connecting, or if it's done by query parameters."* So the safest Rust plan is:

1. Send `client_enter=true`.
2. Start the heartbeat loop on `isFirst`.
3. **Skip** the client-side `im_enter_room` initially. If events do not flow, add it using the field layout
   above and verify the encoding on the wire.

Do not let uncertainty here block the first implementation — heartbeat + ACK are the two frames you
genuinely cannot omit.

### D.8 Reconnect / cursor resume

* **No in-place reconnect is possible.** The signed URL expires in ~30 s (`[TL]`). A reconnect means a new
  `GET /webcast/fetch`.
* **Resume with the cursor.** Store the latest `WebcastResponse.cursor` and pass it back as
  `&cursor=<value>` on the next `/webcast/fetch` call to pick up where you left off rather than replaying.
* **Budget the reconnect.** 5 requests/minute and 100/day anonymously (`[PROBE B-2]`). A reconnect storm
  will exhaust the daily budget in minutes. Use exponential backoff with jitter, and cap reconnects.
* On reconnect, rebuild the URL from scratch (`pushServer`/`routeParamsMap` may differ) and re-read
  `X-Set-TT-Cookie`.
* `[TL]` closes the iterator when the socket is no longer open; `code 1000`/`1001`/no-code = clean end
  (stream ended), any other code = error.
* `WebcastControlMessage.action == STREAM_ENDED` should be treated as a terminal stream end and should
  **not** trigger reconnect.

### D.9 Decoding pipeline summary (pseudocode)

```
loop over ws.binary_messages:
    frame = WebcastPushFrame::decode(bytes)?          # step 1: unwrap
    if frame.payload_type != "msg":                    # step 2: filter
        debug!("discard {frame.payload_type}"); continue
    ct = frame.headers.get("compress_type")
    body = match ct {
        None | Some("none") => frame.payload,
        Some("gzip")        => gunzip(frame.payload)?,  # step 3: decompress
        Some(other)         => { error!(other); frame.payload }
    }
    resp = WebcastResponse::decode(body)?               # step 4: envelope
    if resp.is_first { start_heartbeat(resp.heart_beat_duration) }   # step 5
    if resp.needs_ack { send_ack(frame.log_id, &resp.internal_ext) } # step 6: ACK
    if !resp.cursor.is_empty() { store_cursor(resp.cursor) }
    for msg in resp.messages {                          # step 7: dispatch
        match msg.method.as_str() {
            "WebcastChatMessage"     => emit(decode::<WebcastChatMessage>(&msg.payload)?),
            "WebcastGiftMessage"     => emit(decode::<WebcastGiftMessage>(&msg.payload)?),
            /* … table in D.5 … */
            other => emit(Unknown { method: other, raw: msg.payload }),
        }
    }
```

---

## E. PROTOBUF DEFINITIONS — verbatim `.proto` excerpts

All excerpts in this section are **verbatim** from MIT-licensed sources. Provenance is stated per block.
`syntax = "proto3"` throughout (see E.9).

### E.1 `WebcastPushFrame` — the frame wrapper

**Source:** `[TLR] build-script/proto/webcast.proto` (MIT). Byte-identical definition in
`[GTL] proto/webcast.proto` (MIT), which also carries `option go_package`.

```proto
//@WebcastPushFrame
// Response from TikTokServer. Container for Messages
message WebcastPushFrame {
  uint64 SeqId = 1;
  uint64 LogId = 2;
  uint64 Service = 3;
  uint64 Method = 4;
  map<string, string> headers = 5;
  string PayloadEncoding = 6;
  string PayloadType = 7;
  bytes Payload = 8;
}
```

**v3 note:** `[TL] ws_utils.py` states v3 declares `headers` as `repeated PushHeader{ key=1; value=2; }`.
Wire-compatible with `map<string,string>` — see D.3. v3 field names are
`seq_id, log_id, service, method, headers, payload_encoding, payload_type, payload` (`Method` is a
reserved-ish keyword shape in some generators; `prost` will emit `method` fine).

### E.2 `WebcastResponse` — the envelope (+ `Message` entry)

**Source:** `[TLR] build-script/proto/webcast.proto` (MIT).

```proto
//@WebcastResponse
// Response from TikTokServer. Container for Messages
message WebcastResponse {
  repeated Message messages = 1;
  string cursor = 2;
  int64 fetchInterval = 3;
  int64 now = 4;
  string internalExt = 5;
  int32 fetchType = 6;
  map<string, string> routeParamsMap = 7;
  int64 heartBeatDuration = 8;
  bool needsAck = 9;
  string pushServer = 10;
  bool isFirst = 11;
  string historyCommentCursor = 12;
  bool historyNoMore = 13;

  // Server-Message. Binary will deserialize into specific message
  message Message {
    string method = 1;
    bytes payload = 2;
    int64 msgId = 3;
    int32 msgType = 4;
    int64 offset = 5;
    bool isHistory = 6;
  }
}
```

**Divergence:** `[GTL] proto/webcast.proto` (MIT) declares field 5 as `bytes internalExt = 5;` instead of
`string`. Both are wire-compatible (length-delimited). **Use `bytes`** — see B.4.

**v3 naming:** `internal_ext`, `fetch_interval`, `route_params_map`, `heart_beat_duration`, `needs_ack`,
`push_server`, `is_first`, `history_comment_cursor`, `history_no_more`; `Message.method` / `Message.payload`.
The v3 class name is `ProtoMessageFetchResult`; `Message` is `BaseProtoMessage`.

**Historical variant** — `[ZTC] src/proto/tiktokSchema.proto` (MIT), the pre-2023 envelope. Field numbers
match, names differ, `wsParams`/`wsUrl` are the old spellings of `routeParamsMap`/`pushServer`:

```proto
message WebcastResponse {
  repeated Message messages = 1;
  string cursor = 2;
  int32 fetchInterval = 3;
  int64 serverTimestamp = 4;
  string internalExt = 5;
  int32 fetchType = 6; // ws (1) or polling (2)
  repeated WebsocketParam wsParams = 7;
  int32 heartbeatDuration = 8;
  bool needAck = 9;
  string wsUrl = 10;
}

message Message {
  string type = 1;
  bytes binary = 2;
}
```

### E.3 `Common` (`CommonMessageData`)

**Source:** `[TLR] build-script/proto/data.proto` (MIT).

```proto
// @Common
message Common {
  string method = 1;
  int64 msgId = 2;
  int64 roomId = 3;
  int64 createTime = 4;
  int32 monitor = 5;
  bool isShowMsg = 6;
  string describe = 7;
  Text displayText = 8;
  int64 foldType = 9;
  int64 anchorFoldType = 10;
  int64 priorityScore = 11;
  string logId = 12;
  string msgProcessFilterK = 13;
  string msgProcessFilterV = 14;
  string fromIdc = 15;
  string toIdc = 16;
  repeated string filterMsgTagsList = 17;
  LiveMessageSEI sei = 18;
  LiveMessageID dependRootId = 19;
  LiveMessageID dependId = 20;
  int64 anchorPriorityScore = 21;
  int64 roomMessageHeatLevel = 22;
  int64 foldTypeForWeb = 23;
  int64 anchorFoldTypeForWeb = 24;
  int64 clientSendTime = 25;
  IMDispatchStrategy dispatchStrategy = 26; // Enum

  message LiveMessageSEI {
    LiveMessageID uniqueId = 1;
    int64 timestamp = 2;
  }

  message LiveMessageID {
    string primaryId = 1;
    string messageScene = 2;
  }

  enum IMDispatchStrategy {
    IM_DISPATCH_STRATEGY_DEFAULT = 0;
    IM_DISPATCH_STRATEGY_BYPASS_DISPATCH_QUEUE = 1;
  }
}
```

**Key fields:** `method` = **1**, `msgId` = **2**, `roomId` = **3**, `createTime` = **4** (epoch **seconds**),
`describe` = **7**, `displayText` = **8**, `logId` = **12**.

**v3 naming:** `msg_id`, `room_id`, `create_time`, `is_show_msg`, `display_text`, `log_id`,
`filter_msg_tags_list`, `dispatch_strategy`. The type name is `CommonMessageData`.

**`Text`** (needed for `display_text`, and for the follow/share discriminator in D.5):

```proto
// @Text
message Text {
  string key = 1;
  string defaultPattern = 2;
  TextFormat defaultFormat = 3;
  repeated TextPiece piecesList = 4;

  message TextPiece {
    int32 type = 1;
    TextFormat format = 2;
    string stringValue = 11;
    oneof textPieceType
    {
      TextPieceUser userValue = 21;
      TextPieceGift giftValue = 22;
    }
    TextPiecePatternRef patternRefValue = 24;
  }

  message TextFormat {
    string color = 1;
    bool bold = 2;
    bool italic = 3;
    int32 weight = 4;
    int32 italicAngle = 5;
    int32 fontSize = 6;
    bool useHeighLightColor = 7;
    bool useRemoteClor = 8;
  }

  message TextPieceGift {
    int32 giftId = 1;
    int64 colorId = 4;
  }

  message TextPiecePatternRef {
    string key = 1;
    string defaultPattern = 2;
  }

  message TextPieceUser {
    User user = 1;
    bool withColon = 2;
  }
}
```

**v3 note:** `Text` field 1 was renamed `display_type` → **`key`** (`[TL] proto_utils.py`:
*"v3 renamed Text field 1 (same wire number, same string type) to `key`"*). Field 2 is
`default_pattern`. `piecesList` → `pieces_list`.

### E.4 `Image` and `User`

**Source:** `[TLR] build-script/proto/data.proto` (MIT).

```proto
// @Image
message Image {
  repeated string urlList = 1;
  bool isAnimated = 9;
}
```

```proto
// @User
message User {
  int64 id = 1;
  string nickname = 3;
  string bioDescription = 5;
  Image avatarThumb = 9;
  Image avatarMedium = 10;
  Image avatarLarge = 11;
  bool verified = 12;
  int32 status = 15;
  int64 createTime = 16;
  int64 modifyTime = 17;
  int32 secret = 18;
  string shareQrcodeUri = 19;
  repeated Image badgeImageList = 21;
  FollowInfo followInfo = 22;
  PayGrade payGrade = 23;
  FansClub fansClub = 24;
  Border border = 25;
  string specialId = 26;
  Image avatarBorder = 27;
  Image medal = 28;
  repeated Image realTimeIconsList = 29;
  repeated Image newRealTimeIconsList = 30;
  int64 topVipNo = 31;
  UserAttr userAttr = 32;
  OwnRoom ownRoom = 33;
  int64 payScore = 34;
  int64 ticketCount = 35;
  LinkmicStatus linkMicStats = 37;
  string displayId = 38;
  bool withCommercePermission = 39;
  bool withFusionShopEntry = 40;
  AnchorLevel webcastAnchorLevel = 42;
  string verifiedContent = 43;
  AuthorStats authorStats = 44;
  repeated User topFansList = 45;
  string secUid = 46;
  int32 userRole = 47;
  ActivityInfo activityReward = 49;
  Image personalCard = 52;
  AuthenticationInfo authenticationInfo = 53;
  repeated Image mediaBadgeImageList = 57;
  ComboBadgeInfo comboBadgeInfo = 62;
  SubscribeInfo subscribeInfo = 63;
  repeated BadgeStruct badgeList = 64;
  FansClubInfo fansClubInfo = 66;
  /* … 1xxx-range privacy/stats flags omitted for brevity … */
  UserStats stats = 1041;
  string verifiedReason = 1043;
  bool isBlock = 1048;

  message FollowInfo {
    int64 followingCount = 1;
    int64 followerCount = 2;
    int64 followStatus = 3;
    int64 pushStatus = 4;
  }

  message UserAttr {
    bool isMuted = 1;
    bool isAdmin = 2;
    bool isSuperAdmin = 3;
    int64 muteDuration = 4;
  }

  message FansClubInfo {
    bool isSleeping = 1;
    int64 fansLevel = 2;
    int64 fansScore = 3;
    Image badge = 4;
    int64 fansCount = 5;
  }

  message ComboBadgeInfo {
    Image icon = 1;
    int64 comboCount = 2;
  }
}
```

> Note: in `[TLR]` `FollowInfo` etc. are **nested** inside `User`; `[ZTC]` declares them as top-level
> messages. Nesting does not change the wire format — only the generated type path (`User.FollowInfo`
> vs `FollowInfo`). Either compiles.

**Cross-verification with `[ZTC]` (independent MIT source) — field numbers agree exactly:**

```proto
message User {
  uint64 userId = 1;
  string nickname = 3;
  ProfilePicture profilePicture = 9;
  string uniqueId = 38;
  string secUid = 46;
  repeated UserBadgesAttributes badges = 64;
  uint64 createTime = 16;
  string bioDescription = 5;
  FollowInfo followInfo = 22;
}
```

So: **avatar/profile picture = field 9** (`avatarThumb` / `profilePicture`, type `Image`);
**uniqueId = field 38** (`displayId` in the newer schema); **secUid = field 46**;
**badges = field 64** (type changed from `UserBadgesAttributes` to `BadgeStruct`);
**createTime = 16**; **bioDescription = 5**; **followInfo = 22**.

**Nested picture fields.** `[ZTC]` models field 9 as a single-URL message:

```proto
message ProfilePicture {
  repeated string urls = 1;
}
```

Modern traffic sends `Image` (§E.4 above): `urlList` = **1** (`repeated string`), `isAnimated` = **9**.
Field 1 is the URL list in both models — read `avatar_thumb.url_list` (v3) / `avatarThumb.urlList`.
`[ZTC] webcastDataConverter.js` prefers the `100x100` + `.webp` entry from that list.

**`FollowInfo` (verbatim, `[TLR]`):**

```proto
  message FollowInfo {
    int64 followingCount = 1;
    int64 followerCount = 2;
    int64 followStatus = 3;
    int64 pushStatus = 4;
  }
```

`followStatus >= 2` is "friends with the streamer" (`[TL] custom_proto.py::is_friend`). Also note
`[TL]`'s `follow_info` may be absent entirely under proto3 implicit presence — treat missing as
"not friends".

**Badges** (`[TLR]`, `BadgeStruct`; this is the modern field-64 payload, which `[ZTC]`'s older
`UserBadgesAttributes` predates):

```proto
// @Badge
message BadgeStruct {
  BadgeDisplayType displayType = 1; // Enum
  oneof badgeType
  {
    ImageBadge image = 20;
    TextBadge text = 21;
    StringBadge str = 22;
    CombineBadge combine = 23;
  }

  message ImageBadge {
    Image image = 2;
  }

  message TextBadge {
    string defaultPattern = 3;
  }

  message StringBadge {
    string str = 2;
  }

  message CombineBadge {
    Image icon = 2;
    TextBadge text = 3;
    string str = 4;
    ProfileCardPanel profileCardPanel = 7;
    CombineBadgeBackground background = 11;
    CombineBadgeBackground backgroundDarkMode = 12;
    int32 publicScreenShowStyle = 15;
    int32 personalCardShowStyle = 16;
    int32 ranklistOnlineAudienceShowStyle = 17;
    int32 multiGuestShowStyle = 18;
  }

  enum BadgeDisplayType {
    BADGEDISPLAYTYPE_UNKNOWN = 0;
    BADGEDISPLAYTYPE_IMAGE = 1;
    BADGEDISPLAYTYPE_TEXT = 2;
    BADGEDISPLAYTYPE_STRING = 3;
    BADGEDISPLAYTYPE_COMBINE = 4;
  }
}
```

The **older** badge shape (`[ZTC]`, still present in traffic for some rooms) — useful fallback:

```proto
message UserBadgesAttributes {
  int32 badgeSceneType = 3;
  repeated UserImageBadge imageBadges = 20;
  repeated UserBadge badges = 21;
  PrivilegeLogExtra privilegeLogExtra = 12;
}

message PrivilegeLogExtra {
  string privilegeId = 2;
  string level = 5;
}

message UserBadge {
  string type = 2;
  string name = 3;
}

message UserImageBadge {
  int32 displayType = 1;
  UserImageBadgeImage image = 2;
}

message UserImageBadgeImage {
  string url = 1;
}
```

`badgeSceneType` meanings per `[ZTC] webcastDataConverter.js`:
`1 = ADMIN (moderator)`, `4 = SUBSCRIBER`, `7 = NEWSUBSCRIBER`, `8 = UserGrade (gifter level)`,
`10 = Fans (member/team level)`.

### E.5 `WebcastChatMessage`

**Source:** `[TLR] build-script/proto/webcast.proto` (MIT).

```proto
// Comment sent by User
//@WebcastChatMessage
message WebcastChatMessage {
  Common common = 1;
  User user = 2;
  string content = 3;
  bool visibleToSender = 4;
  Image backgroundImage = 5;
  string fullScreenTextColor = 6;
  Image backgroundImageV2 = 7;
  Image giftImage = 10;
  int32 inputType = 11;
  User atUser = 12;
  repeated EmoteWithIndex emotesList = 13;
  string contentLanguage = 14;
  int32 quickChatScene = 16;
  int32 communityFlaggedStatus = 17;
  UserIdentity UserIdentity = 18;
  map<int32, string> CommentQualityScores = 19;

  // @EmoteWithIndex
  // proto.webcast.im.ChatMessage
  message EmoteWithIndex {
    int64 index = 1;
    Emote emote = 2;
  }
}
```

`[ZTC]` cross-check: `user = 2`, `comment = 3` — matches (**content = 3**).

**v3 notes:** `content` = **3** (`[TL] events.yaml`: *"v2 named this `comment`, v3 renamed it to
`content`"* — and `CommentEvent.comment` is now a read-only alias of `content`). `user` = 2,
`common` = 1, `emotes_list` = 13.

### E.6 `WebcastGiftMessage` + `GiftStruct`

**Source:** `[TLR] build-script/proto/webcast.proto` (MIT).

```proto
//@GiftMessage
message WebcastGiftMessage {
  Common common = 1;
  int64 giftId = 2;
  int64 fanTicketCount = 3;
  int32 groupCount = 4;
  int32 repeatCount = 5;
  int32 comboCount = 6;
  User user = 7;
  User toUser = 8;
  int32 repeatEnd = 9;
  int64 groupId = 11;
  int64 incomeTaskgifts = 12;
  int64 roomFanTicketCount = 13;
  GiftStruct gift = 15;
  string logId = 16;
  int64 sendType = 17;
  string monitorExtra = 22;
  int64 colorId = 24;
  bool isFirstSent = 25;
  string orderId = 28;
  UserIdentity userIdentity = 32;
  UserGiftReciever userGiftReciever = 23;

  message UserGiftReciever
  {
    int64 userId = 1;
    string deviceName = 10;
  }
}
```

**`GiftStruct` — from `[TLR] build-script/proto/data.proto` (MIT):**

```proto
// @Gift
message GiftStruct {
  Image image = 1;
  string describe = 2;
  int64 duration = 4;
  int64 id = 5;
  bool forLinkmic = 7;
  bool combo = 10;
  int32 type = 11;
  int32 diamondCount = 12;
  bool isDisplayedOnPanel = 13;
  int64 primaryEffectId = 14;
  Image giftLabelIcon = 15;
  string name = 16;
  Image icon = 21;
  string goldEffect = 24;
  Image previewImage = 47;
  GiftPanelBanner giftPanelBanner = 48;
  bool isBroadcastGift = 49;
  bool isEffectBefview = 50;
  bool isRandomGift = 51;
  bool isBoxGift = 52;
  bool canPutInGiftBox = 53;
}
```

**Cross-check with `[ZTC]` (independent MIT source) — a *different* message shape with *identical*
numbers for the fields that matter:**

```proto
message WebcastGiftMessage {
  WebcastMessageEvent event = 1;
  int32 giftId = 2;
  int32 repeatCount = 5;
  User user = 7;
  int32 repeatEnd = 9;
  uint64 groupId = 11;
  WebcastGiftMessageGiftDetails giftDetails = 15;
  string monitorExtra = 22;
  WebcastGiftMessageGiftExtra giftExtra = 23;
}

message WebcastGiftMessageGiftDetails {
  WebcastGiftMessageGiftImage giftImage = 1;
  string giftName = 16;
  string describe = 2;
  int32 giftType = 11;
  int32 diamondCount = 12;
}

message WebcastGiftMessageGiftExtra {
  uint64 timestamp = 6;
  uint64 receiverUserId = 8;
}
```

So the combo/streak fields are **confirmed by two independent sources**:

| Concept | Field # | Type | Used for |
|---------|---------|------|----------|
| `giftId` | **2** | int64 | gift identity on the message itself |
| `repeatCount` | **5** | int32 | **increment-style running count within the streak** |
| `comboCount` | **6** | int32 | combo counter |
| `user` | **7** | User | sender |
| `toUser` | **8** | User | recipient |
| `repeatEnd` | **9** | int32 | **final-streak signal** (truthy = streak finished) — see F |
| `groupId` | **11** | int64 | **streak/batch identity — use for de-duplication** |
| `gift` | **15** | GiftStruct | gift metadata |
| `gift.id` | **5** | int64 | gift catalog id |
| `gift.name` | **16** | string | display name |
| `gift.type` | **11** | int32 | **`1` == streakable** |
| `gift.diamondCount` | **12** | int32 | diamond value |
| `gift.image` | **1** | Image | image (also `gift.icon` = **21**) |
| `gift.combo` | **10** | bool | gift supports combo |
| `giftExtra.timestamp` | **6** | uint64 | (when the `giftExtra` shape is used) |
| `giftExtra.receiverUserId` | **8** | uint64 | receiver |

**v3 naming:** `gift_id`, `fan_ticket_count`, `group_count`, `repeat_count`, `combo_count`, `to_user`,
`repeat_end`, `group_id`, `income_taskgifts`, `room_fan_ticket_count`, `gift`, `log_id`, `send_type`,
`monitor_extra`, `color_id`, `is_first_sent`, `order_id`, `user_identity`, `user_gift_reciever`.
In `GiftStruct` v3 uses **`name`, `type`, `image`, `diamond_count`** (`[TL] aliases.yaml`:
*"v2 added `gift_` prefixes; v3 reverted"* — `gift_name`/`gift_type`/`gift_image` are legacy aliases only).

`monitorExtra` (field 22) is a **JSON string** beginning with `{` for gift messages. `[ZTC]` parses it
defensively:
```js
if (typeof webcastObject.monitorExtra === 'string' && webcastObject.monitorExtra.indexOf('{') === 0) { JSON.parse(...) }
```
Useful as a second source of gift metadata and, in practice, for the streak/`repeat_end` corroboration.
It is not required for basic operation.

### E.7 `WebcastLikeMessage`

**Source:** `[TLR] build-script/proto/webcast.proto` (MIT).

```proto
// User sent one or multiple likes to Stream. Maxes at 15 likes per message
//@WebcastLikeMessage
message WebcastLikeMessage {
  Common common = 1;
  int32 count = 2;
  int32 total = 3;
  User user = 5;
}
```

`[ZTC]` cross-check: `likeCount = 2`, `totalLikeCount = 3`, `user = 5` — **identical numbers**.

* `count` (**2**) = **increment** — likes added by this message (the source comment says max 15 per message).
* `total` (**3**) = **absolute running total** for the room.
* `user` (**5**) — note it is **5, not 4**.

**v3 naming:** `count`, `total`, `user` (v2-era names were `like_count` / `total_like_count`).

### E.8 `WebcastMemberMessage`, `WebcastSocialMessage`, `WebcastRoomUserSeqMessage`

**Source:** `[TLR] build-script/proto/webcast.proto` (MIT).

```proto
// Sent for a variety of events, including Join & Subscribe
//@WebcastMemberMessage
message WebcastMemberMessage {
  Common common = 1;
  User user = 2;
  int32 memberCount = 3;
  User operator = 4;
  bool isSetToAdmin = 5;
  bool isTopUser = 6;
  int64 rankScore = 7;
  int64 topUserNo = 8;
  int64 enterType = 9;
  MemberMessageAction action = 10;
  string actionDescription = 11;
  int64 userId = 12;
  EffectConfig effectConfig = 13;
  string popStr = 14;
  EffectConfig enterEffectConfig = 15;
  Image backgroundImage = 16;
  Image backgroundImageV2 = 17;
  Text anchorDisplayText = 18;
  string clientEnterSource = 19;
  string clientEnterType = 20;
  string clientLiveReason = 21;
  int64 actionDuration = 22;
  string userShareType = 23;
}
```

`[ZTC]` cross-check: `actionId = 10` — matches (**action = 10**). Join vs subscribe is discriminated by
`action` (**10**, `MemberMessageAction` enum); `memberCount` is **3**.

> ⚠ **`memberCount` = 3 is the count carried on the member/join message itself, not necessarily the
> room's total viewer count.** Do not use it as the room population; use `WebcastRoomUserSeqMessage`.

```proto
// Sent for a variety of events, including Follow & Share
//@WebcastSocialMessage
message WebcastSocialMessage {
  Common common = 1;
  User user = 2;
  int64 shareType = 3;
  int64 action = 4;
  string shareTarget = 5;
  int32 followCount = 6;
  int64 shareDisplayStyle = 7;
  int32 shareCount = 8;
}
```

`[ZTC]` cross-check: `event = 1`, `user = 2` — matches. The richer fields (`action` = 4,
`followCount` = 6, `shareCount` = 8) come from the newer schema.

**Follow vs share: use `common.displayText.key`, not `action`.** See D.5 for the authoritative rule
(`[TL] client.py`: substring `"follow"` / `"share"`). `action` (4) exists but `[TL]` does not use it as
the discriminator; treat any `action`-based heuristic as unverified.

```proto
// Status of Room (ViewerCount + Top Viewers)
//@WebcastRoomUserSeqMessage
message WebcastRoomUserSeqMessage {
  Common common = 1;
  repeated Contributor ranksList = 2;
  int64 total = 3;
  string popStr = 4;
  repeated Contributor seatsList = 5;
  int64 popularity = 6;
  int32 totalUser = 7;
  int64 anonymous = 8;

  // @Contributor
  message Contributor {
    int32 score = 1;
    User user = 2;
    int32 rank = 3;
    int64 delta = 4;
  }
}
```

`[ZTC]` cross-check: `topViewers = 2`, `viewerCount = 3` — matches (**viewer count = field 3**).

| Concept | Field # | Notes |
|---------|---------|-------|
| viewer count | **3** (`total`) | **the room's current viewer count** — this is the one you want |
| top viewers / ranks | **2** (`ranksList`) | `repeated Contributor` |
| seats | **5** (`seatsList`) | `repeated Contributor` |
| popularity | **6** | cumulative popularity score |
| `totalUser` | **7** | total distinct users (newer schema) |
| `anonymous` | **8** | anonymous viewer count |
| `Contributor.score` | 1 | |
| `Contributor.user` | 2 | |
| `Contributor.rank` | 3 | |
| `Contributor.delta` | 4 | |

**v3 naming:** `ranks_list`, `pop_str`, `seats_list`, `total_user`; `Contributor` is `RoomUserSeqMessage.Contributor`.

### E.9 Proto syntax version and prost implications

* **All schemas are `syntax = "proto3"`.** No proto2 file exists in any of the consulted sources.
* **No `required` fields anywhere.** proto3 has no `required`, so a missing field can never cause a parse
  error; it decodes to the type's default.
* **Presence semantics that matter for a Rust/prost implementation:**
  * Singular **scalar** fields (`int32/int64/bool/string`) in proto3 have *implicit* presence. `prost`
    generates `i32`/`i64`/`bool`/`String` (not `Option<…>`). **You cannot distinguish "absent" from
    "zero"** — e.g. `repeatEnd = 0` and "no `repeat_end` field on the wire" are identical. Design streak
    handling around `0` meaning "not ended", which is what every reference implementation does.
  * Singular **message** fields have *explicit* presence. `prost` generates `Option<T>`
    (or `Option<Box<T>>` for recursive types). `common`, `user`, `gift`, `follow_info` are therefore
    `Option<…>` — always handle `None`.
  * `repeated` fields are never `Option`; absent → empty `Vec`.
  * `map<K,V>` → `HashMap<K,V>` (or `BTreeMap` with the `btree_map` option). Order is **not** preserved.
    If you consume `WebcastResponse.routeParamsMap` for URL building, **sort the keys deterministically**
    or you will build a different URL each run (harmless, but it breaks reproducible tests and caching).
  * `oneof` (`BadgeStruct.badgeType`, `Text.TextPiece.textPieceType`) → `prost` generates a Rust `enum`
    wrapped in `Option<…>`. Use `badge.badge_type` and match.
  * `bytes` → `Vec<u8>`. **Prefer `bytes` over `string` for `internalExt`** (B.4).
  * `optional` keyword: absent from these schemas. If you add `optional` for convenience, `prost` will
    emit `Option<T>`; that is a source-compatible local change and does not alter the wire format.
  * **Field names:** prost converts Proto names to `snake_case`. `PayloadType` → `payload_type`,
    `internalExt` → `internal_ext`, `displayId` → `display_id`. Supply `#[prost(...)]`/`#[allow(non_snake_case)]`
    only if you pin the odd PascalCase names.
  * **`enum` values** default to 0 and `prost` generates a `i32` field plus a companion enum type;
    unknown enum values are preserved in the `i32`, so forward compatibility is automatic. Do not
    `unwrap()` enum conversions.
  * **Unknown fields are discarded** by `prost` (it does not retain them). If you need to be
    forward-compatible with new fields, decode into a struct that is a superset, or keep the raw bytes.

### E.10 Messages NOT available in the MIT sources (and what to do)

These two are used by `[TL]` but appear in **none** of `[TLR]`, `[GTL]`, `[ZTC]`. Their field numbers are
**not verified by any MIT source consulted**:

| Message | Source of names | Field layout | Status |
|---------|-----------------|--------------|--------|
| `HeartBeatMessage` | `[TL] ws_client.py` kwargs `room_id`, `send_packet_seq_id` | community: `int64 roomId = 1; int64 sendPacketSeqId = 2;` | **unverified** — avoid by sending an empty-`hb` frame (D.6) |
| `WebcastImEnterRoomMessage` | `[TL] ws_client.py` kwargs `room_id, room_tag, live_id, identity, cursor, account_type, enter_unique_id, filter_welcome_msg, is_anchor_continue_keep_msg` | community: `1..9` in that order | **unverified** — avoid with `client_enter=true` (D.7) |

If you later need certainty, obtain them from `TikTokLiveProto` v3 (PyPI package `TikTokLiveProto`) or
capture a real frame from TikTokLive's debug log (`client.logger.setLevel(LogLevel.DEBUG)`) and decode
the hex.

**`PushHeader`** — implied by `[TL] ws_utils.py` for `WebcastPushFrame.headers` in v3; trivially
`{ string key = 1; string value = 2; }`. Wire-identical to `map<string,string>` (D.3).

---

## F. GOTCHAS AND RISKS

### Signature / connectivity

* **`tiktok.eulerstream.com` in the docs is stale.** Use `https://api.eulerstream.com` + `/webcast/fetch`
  (B.1). If something 404s or hangs, check the host first.
* **The signed WebSocket URL expires in ~30 seconds.** There is no retry path — always re-call
  `/webcast/fetch` (B.1, D.8).
* **`User-Agent` must match across all three places:** the `user_agent` query param on `/webcast/fetch`,
  the WS handshake header, and the `browser_name`/`browser_version` query params. Any mismatch is the
  classic signature rejection (C.2).
* **Percent-encode every `routeParamsMap` value** with `safe=""` before appending to the URL. The Euler
  fallback push server echoes a raw user agent as a route param; unencoded spaces/parens → **HTTP 400**
  (C.1).
* **Do not double-encode base params.** `browser_name` / `browser_version` ship pre-encoded; re-encoding
  breaks the match (C.1).
* **Append `&version_code=270000` after the normal params.** TikTok expects a duplicate `version_code`
  (`180800` earlier, `270000` at the end). Reproduce it (C.1).
* **`X-Set-TT-Cookie` is mandatory.** Missing → the reference implementation hard-fails
  (`"Sign server did not return cookies!"`). Forward those cookies on the WS handshake (B.3, C.2).
* **Do not validate `Content-Type` on `/webcast/fetch`.** It returns the misspelled
  `application/protubuf` (B.3).
* **HTTP 200 with an empty body is an error**, not success: *"Are you being detected by TikTok?"* (B.5).
* **A body-level `code: 403` can accompany HTTP 200.** `[TL]` checks the parsed body's `code` *before*
  the HTTP status. Do the same (B.5).
* **`platform=mobile` requires a `sessionid`** and will raise immediately otherwise (B.6).
* **`unique_id` on `/webcast/fetch` is Enterprise-only.** Free tier must use `room_id` (B.2).
* **The free tier is only 5/min, 30/hr, 100/day** (measured, B.5). Reconnect logic must be
  backoff-limited or it will exhaust the daily budget within minutes. `/webcast/rate_limits` is a free,
  unauthenticated way to read `remaining` before spending a request.
* **Load shedding exists** (`load_shedding: {at, chance}`) — non-200 responses can occur below the nominal
  limits. Always jitter-retry.

### Frame / decode pipeline

* **Non-`msg` frames must be discarded.** `hb`, `ack`, `im_enter_room_resp` are transport-level. Parsing
  them as events produces spurious "unknown method" noise (D.1).
* **Gzip is signalled per frame via the `compress_type` header**, not via WebSocket extensions. Expect
  `gzip`, `none`, or absent. Since you send `compress=gzip`, always check (D.3).
* **Gate on `payload_type`, not on frame size or content.** (D.2)
* **Not ACKing kills the stream.** ACK whenever `needsAck`. The `LogId` must come from the **enclosing
  push frame**, not the response — a common bug that silently stalls the feed (D.4).
* **Never ACK the initial sign-server response.** It has no enclosing frame
  (`[TL]` models it as a synthetic push frame with `log_id = -1`). In Rust: only ACK responses you decoded
  from a real `WebcastPushFrame` (D.4).
* **Disable WebSocket-level automatic pings.** TikTok never sends pongs; a ping timeout produces a bogus
  `1011 keepalive ping timeout` disconnect (D.6).
* **`internalExt` should be `bytes`, not `string`.** Declaring it `string` risks UTF-8 decode failures;
  the ACK path just needs the raw bytes (B.4, E.9).
* **`HashMap` for `headers`/`routeParamsMap` loses duplicates and ordering.** Iterating a `HashMap` to
  build the query string yields nondeterministic URLs — sort or use `BTreeMap` (E.9).
* **`routeParamsMap` is only populated on the initial `/webcast/fetch` response.** Do not look for
  `pushServer`/`routeParamsMap` on subsequent WS frames (D.4).

### Schema / events

* **Events get removed from the schema.** `[TL]` README:
  > *"These events are auto-generated from the TikTokLiveProto v3 schema. Only events whose proto
  > messages are present in v3 are emitted; **if you don't see one you used to rely on, it's because
  > TikTok removed it from the schema.**"*
  And `[TL] client.py`:
  > *"v3 dropped the named `BusinessTypeSuperFanBox` variant from the enum, but the wire value (19)
  > is unchanged; compare numerically."*
  **→ Match on the numeric enum value, and treat unknown `method` strings as a first-class event rather
  than an error.**
* **Schema bugs upstream.** `[TL] client.py` has a `parse_error_ignorelist` purely for *"parse failures
  rooted in upstream proto schema bugs"*, with the note
  *"v3 fixed the v2-era `LinkLayerListUser.linkmic_id` int64-vs-string bug"*. **Real traffic contains
  payloads that do not match the published schema.** Your decoder must skip-and-log, never panic or
  tear down the connection on a decode error.
* **`linkMicStats` (User field 37)** is typed as an enum in some schemas — a historical mismatch source.
* **Missing fields are normal.** `followInfo`, `common`, `gift`, `displayText` may all be absent
  (`Option<…>`). A null `messages[i]` entry is possible — `[TL]` logs
  `"Received a null ProtoMessageFetchResultMessage from the Webcast server."` and skips.

### Gifts and streaks — specifics

* **Gifts arrive incrementally, once per streak increment.** `[TL]` README:
  > *"streakable gifts trigger multiple `GiftEvent`s as the viewer ramps up the streak, with
  > `event.repeat_count` incrementing each time. The final gift in a streak carries
  > **`event.repeat_end == 1`**."*
* **Exact final-streak signal in the protobuf: `WebcastGiftMessage.repeatEnd` (field 9).**
  Non-zero = the streak has ended; `0`/absent = mid-streak.
* **Streakable test: `GiftStruct.type` (field 11) `== 1`.** `[TL] custom_proto.py`:
  `def streakable: return self.type == 1`. Equivalent to `event.streaking` being false for
  non-streakable gifts:
  ```
  streaking = gift is not None
              AND gift.type == 1          # streakable
              AND repeat_end == 0          # not yet finished
  ```
* **`repeatCount` (field 5) is an increment/per-message running count, *not* an absolute.** `[TL]`'s USD
  helper multiplies it on the **final** event only, precisely to avoid double counting:
  ```
  value = None if streaking or gift is None
          else repeat_count * gift.diamond_count * 0.005     # USD
  ```
  (`diamond_count * 0.005` ≈ USD per diamond.) **Accumulate on `repeat_end != 0`, never on every event.**
* **`groupId` (field 11) identifies the streak/batch** — use `(groupId, user.id, giftId)` as the natural
  streak key. `[ZTC]` coerces `groupId` to a string because it exceeds 2^53 in JS; in Rust keep it `i64`.
* **Absolute vs increment — the full list:**

  | Field | Message | Semantics |
  |-------|---------|-----------|
  | `repeatCount` (#5) | `WebcastGiftMessage` | **increment** within a streak |
  | `comboCount` (#6) | `WebcastGiftMessage` | combo counter |
  | `fanTicketCount` (#3) | `WebcastGiftMessage` | running total for this gift send |
  | `roomFanTicketCount` (#13) | `WebcastGiftMessage` | **absolute** room fan-ticket total |
  | `count` (#2) | `WebcastLikeMessage` | **increment** (≤15 per message) |
  | `total` (#3) | `WebcastLikeMessage` | **absolute** room like total |
  | `total` (#3) | `WebcastRoomUserSeqMessage` | **absolute** current viewer count |
  | `popularity` (#6) | `WebcastRoomUserSeqMessage` | **absolute** cumulative popularity |
  | `memberCount` (#3) | `WebcastMemberMessage` | count on the member message — **not** the room population |
  | `followCount` (#6) | `WebcastSocialMessage` | running follow count |
  | `shareCount` (#8) | `WebcastSocialMessage` | running share count |
  | `createTime` (#4) | `Common` | epoch **seconds** |
  | `timestamp` (#6) | `giftExtra` | epoch (units unverified — `[ZTC]` `parseInt`s it) |

### De-duplication

* **Primary message identity: `Common.msgId` (field 2)** — per-event, monotonic-ish, unique within a
  room. This is the right de-dup key for comments, likes, joins and non-streak gifts.
* **Envelope identity: `WebcastResponse.Message.msgId` (field 3)** — the transport-level id of the
  wrapped message. Also `Message.offset` (field 5) for history paging and `Message.isHistory` (field 6).
* **Gift streak identity: `WebcastGiftMessage.groupId` (field 11).**
* **Cross-connection identity:** `cursor` (envelope field 2) advances the stream, so a correctly resumed
  stream should not replay. Still de-dup on `msgId` — replays *do* happen on reconnect without a cursor.
* **Pinned-message caveat:** `WebcastRoomPinMessage.pinnedMessage` (field 2) contains a **re-encoded
  nested message** — `[TLR]` comment: *"Usually this is a ChatMessage, but it can also be another
  message."* Use `originalMsgType` (field 30) to pick the type. A pinned comment will therefore appear
  **twice** with the same `msgId` (once live, once pinned) — de-dup accordingly.
* `WebcastChatMessage.emotesList` (field 13) indices are `EmoteWithIndex.index` (field 1), 0-based —
  splice emote images into the content string at those positions.

### Operational

* **Never log or persist full cookies / `X-Set-TT-Cookie`.** `[TL]` explicitly redacts the session ID
  before logging and warns that sending a session ID to the sign server is *"a risky operation."*
* **`sessionid`-based connections are bannable.** Stay anonymous.
* **Debug-log the raw `Handshake-Msg` on upgrade failure** — it is the only diagnostic TikTok provides.

---

## G. Is a free-tier connection WITHOUT an API key actually permitted?

**Yes. This is explicitly supported, not merely tolerated.** Five independent pieces of evidence:

### 1. The official OpenAPI description of `/webcast/fetch` (strongest)

`[OAS]` — `EulerStream/TikTok-Live-Api`, `sdk/csharp/src/generated/api/openapi.yaml`, path `/webcast/fetch`,
verbatim:

> ```
> /webcast/fetch:
>     get:
>       description: |-
>         Fetch the WebSocket URL & first payload for a TikTok LIVE Room given a Room ID.
>
>         **Authentication (Optional):** Anonymous access is supported. For authenticated requests, provide exactly one of the following headers:
>         - `x-oauth-token`: An OAuth access token. ...
>         - `x-cookie-header`: A cookie header string containing `sessionid` and `tt-target-idc` cookies from TikTok.
>       operationId: FetchWebcastURL
> ```
> ```yaml
>       security:
>       - jwt_key_header:
>         - PUBLIC
>         api_key_query:
>         - PUBLIC
>         api_key_header:
>         - PUBLIC
> ```

**"Anonymous access is supported."** The security requirement is scope **`PUBLIC`** — the same scope the
docs describe as *"the unauthenticated limits if no key is provided."* An API key is **not** mandatory.

### 2. The TikTokLive v7 source depends on anonymous access

`[TL] web_signer.py`, in-code comment above the no-key branch:

> `# ``asyncio_detailed`` is annotated as taking ``AuthenticatedClient`` only, but at runtime ``Client``
> works identically — it just omits the auth header. **Anonymous (no API key) callers depend on this.**`

And the signer is constructed with a plain `Client` (no auth header) whenever no key is supplied:

> `self._sdk_client = Client(base_url=self._base_url, headers=headers, verify_ssl=False)`

If an API key were mandatory, the flagship client could not connect out of the box — but its default
`tiktok_sign_api_key` is `None` and its README says *"No login, no credentials or app are required."*

### 3. The rate-limit documentation calls anonymous access a first-class tier

`[DOCS] /api/docs/md/api/rate-limits`, verbatim:

> *"The Euler Stream API is a freemium service that generates a TikTok LIVE WebSocket URL. … If you exceed
> the limit, a 429 HTTP Error code will be returned. … **For example, the current rate limits for anonymous
> connections are as follows:** …"*
>
> *"**Increasing Your Limits.** If you don't have an API key, sign up for one, and **you'll get an
> immediate free increase to the rate limit**."*

An "anonymous connections" rate limit only exists if anonymous connections are allowed. An API key is an
*upgrade*, not a gate.

### 4. Empirical proof — an anonymous request succeeded

`[PROBE B-1]`, performed with **no API key of any kind**:

```
GET https://api.eulerstream.com/webcast/fetch?client=ttlive-python&room_id=7684008970436823815&platform=web&client_enter=true
→ HTTP 200, Content-Type: application/protubuf  (i.e. a binary protobuf body — the success path)
```

`[PROBE B-2]` read the anonymous quota directly with no auth:

```
GET https://api.eulerstream.com/webcast/rate_limits
→ {"code":200,"message":"Successfully retrieved WEBCAST rate limits!",
   "day":{"max":100,...},"hour":{"max":30,...},"minute":{"max":5,...}}
```

The server serves anonymous `/webcast/fetch` requests and reports a non-zero anonymous quota. **No API
key is required.**

### 5. The README says so explicitly

`[TL] README.md` FAQ, *"Is the TikTok LIVE API free?"*:

> *"Yes. TikTokLive is free and open source under a modified AGPL license. Signing is handled by a
> third-party signature server (Euler Stream) with **free community rate limits**; an API key **raises
> those limits**."*

### Caveats (not blockers)

* Anonymous access is **rate-limited to 5/min, 30/hr, 100/day** (measured). This is the real constraint.
* Anonymous access cannot use `platform=mobile`, sending chat/gifts, or any premium/moderation route.
* Euler Stream is a **one-person company** (`[DOCS] signatures`: *"Euler Stream is a 1-person company,
  barely profitable"*) and the sign server *"will never be open source."* It is a **single point of
  failure** and a **terms-of-service dependency** for your provider. If that risk is unacceptable, the
  sign server is pluggable (see `[DOCS] custom-sign-servers` for the `/webcast/fetch` contract) and the
  provider should keep the base URL configurable.
* Signing is closed-source and TikTok-adaptive by design: *"If TikTok make a change that breaks signature
  generation, no library update is needed by you, we just fix the API."* Conversely, if Euler Stream
  disappears, **nothing** works until you implement your own signer. Design for that: isolate the signer
  behind a trait with a swappable base URL.

---

## Appendix 1 — Verified live probes (raw evidence)

All probes used `web_fetch` (the target machine cannot do schannel TLS from child processes, so
`curl` / `Invoke-WebRequest` were unusable).

| ID | Request | Result |
|----|---------|--------|
| A-1 | `GET https://www.tiktok.com/api-live/user/room/` with full base params, `sourceType=54`, `uniqueId=isaackogz` | `HTTP 200`; `data.user.roomId="7684008970436823815"`, `data.user.status=4`, `data.liveRoom.status=4`, `statusCode=0` → **user offline, roomId still populated** |
| A-2 | `GET https://webcast.tiktok.com/webcast/room/check_alive/?room_ids=7684008970436823815&<base params>` — **unsigned** | `HTTP 200`; `{"data":[{"alive":false,"room_id":7684008970436823815,"room_id_str":"7684008970436823815"}],"extra":{"now":1789625067764},"status_code":0}` |
| A-3 | `GET …/api-live/user/room/?<full base params>&uniqueId=thisuserdoesnotexist99999xyz` | `HTTP 200`; `{"data":null,"message":"user_not_found","statusCode":19881007}` |
| A-4 | `GET …/api-live/user/room/?uniqueId=…&sourceType=54` (base params omitted) | `HTTP 200`; `{"data":null,"message":"params_error","statusCode":19881005}` |
| B-1 | `GET https://api.eulerstream.com/webcast/fetch?client=ttlive-python&room_id=7684008970436823815&platform=web&client_enter=true` — **no API key** | `HTTP 200`, `Content-Type: application/protubuf` (binary protobuf). **Anonymous signing works.** |
| B-2 | `GET https://api.eulerstream.com/webcast/rate_limits` — **no API key** | `HTTP 200`; `day.max=100, hour.max=30, minute.max=5` |

## Appendix 2 — Minimum viable implementation checklist

```
[ ] Presets: pick one location + device + screen preset at process start
    (randomise history_len, last_rtt, device_id per request)
[ ] Stage 1: GET www.tiktok.com/api-live/user/room/?...+uniqueId=...&sourceType=54
    -> data.user.roomId  (string->i64)
    -> require data.liveRoom.status != 4, else UserOffline
    -> optional cheap confirmation: webcast.tiktok.com/webcast/room/check_alive/?room_ids=...
[ ] Stage 2: GET api.eulerstream.com/webcast/fetch?client=<you>&room_id=<id>
                                                   &user_agent=<EXACT UA>&platform=web&client_enter=true
    -> 200: bytes = WebcastResponse::decode(body)         (do NOT check Content-Type)
    -> parse X-Set-TT-Cookie into the cookie jar
    -> 429: backoff w/ jitter using message + limit_label ; 403: fatal (premium)
    -> empty 200: fatal ("detected by TikTok")
[ ] Stage 3: url = push_server + "?" + percent_encode(route_params, safe="")
                              + "&" + raw(base_ws_params incl. room_id, compress=gzip)
                              + "&version_code=270000"
    headers: Cookie (X-Set-TT-Cookie + tt-target-idc), User-Agent (<EXACT UA>,
             Origin: https://www.tiktok.com, Referer: https://www.tiktok.com/)
    offer Sec-WebSocket-Protocol: echo-protocol ; NO permessage-deflate
    DISABLE automatic WS pings
    on failure: log Handshake-Msg verbatim; read Handshake-Options on success
[ ] Stage 4: for each binary message:
      frame = WebcastPushFrame::decode
      skip if frame.payload_type != "msg"
      gunzip if headers["compress_type"] == "gzip"
      resp = WebcastResponse::decode
      if resp.is_first            -> start heartbeat loop
      if resp.needs_ack           -> send WebcastPushFrame{payload_type:"ack",
                                     log_id: frame.log_id, payload_encoding:"pb",
                                     payload: resp.internal_ext or b"-"}
      store resp.cursor
      for m in resp.messages: dispatch on m.method -> decode m.payload
                              unknown method -> emit Unknown (never drop)
[ ] Heartbeat: WebcastPushFrame{payload_type:"hb"} (minimal 4-byte form: 3a 02 68 62)
    every Handshake-Options["ping-interval"] else 5-10 s
[ ] Reconnect: new /webcast/fetch with &cursor=<stored>, exponential backoff,
    respecting 5/min, 30/hr, 100/day
[ ] De-dup on Common.msgId (field 2); gifts additionally on groupId (field 11)
[ ] Accumulate gift value only when repeatEnd (field 9) != 0
```

## Appendix 3 — Files read (for reproducibility)

| Path | Source |
|------|--------|
| `TikTokLive/client/web/routes/fetch_signed_websocket.py` | isaackogan/TikTokLive @ master (v7.0.1) |
| `TikTokLive/client/web/web_signer.py` | ″ |
| `TikTokLive/client/web/routes/fetch_room_id_api.py` | ″ |
| `TikTokLive/client/web/routes/fetch_room_id_live_html.py` | ″ |
| `TikTokLive/client/web/routes/fetch_is_live.py` | ″ |
| `TikTokLive/client/web/web_presets.py` | ″ |
| `TikTokLive/client/web/web_settings.py` | ″ |
| `TikTokLive/client/web/web_base.py` | ″ |
| `TikTokLive/client/ws/ws_connect.py` | ″ |
| `TikTokLive/client/ws/ws_client.py` | ″ |
| `TikTokLive/client/ws/ws_utils.py` | ″ |
| `TikTokLive/client/client.py` | ″ |
| `TikTokLive/events/custom_events.py` | ″ |
| `TikTokLive/proto/{__init__,custom_proto,proto_utils}.py` | ″ |
| `TikTokLive/__version__.py` | ″ |
| `scripts/proto/resources/{aliases,events}.yaml` | ″ |
| `README.md` | ″ |
| `.github/workflows/generate.yml` | ″ |
| `build-script/proto/{webcast,data}.proto`, `license.txt` | jwdeveloper/TikTokLiveRust @ master |
| `src/core/live_client_websocket.rs`, `src/http/http_request_builder.rs` | ″ |
| `proto/{webcast,data}.proto`, `LICENSE` | steampoweredtaco/gotiktoklive @ master |
| `src/proto/tiktokSchema.proto`, `src/lib/webcastDataConverter.js` | zerodytrash/TikTok-Live-Connector @ main |
| `sdk/csharp/src/generated/api/openapi.yaml` | EulerStream/TikTok-Live-Api @ master |
| `/docs/api/quickstart`, `/docs/signatures`, `/docs/sign-server/custom-sign-servers`, `/api/docs/md/api/rate-limits` | eulerstream.com |
