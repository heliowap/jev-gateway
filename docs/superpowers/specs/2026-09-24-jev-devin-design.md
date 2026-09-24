# jev-devin: run Devin CLI through the gateway

`jev-devin` is a fifth launcher that puts Devin CLI sessions behind the gateway, so Jev picks
the tool instead of the reasoning model — the same job `jev-codex`, `jev-claude`, `jev-opencode`
and `jev-gemini` already do. Unlike those four, Devin CLI does not speak an OpenAI, Anthropic or
Gemini wire format. It speaks the Codeium "exa" protocol: Connect RPC with protobuf bodies to
`https://server.codeium.com`. This spec covers the launcher, the exa adapter, and the minimal
protobuf layer the adapter needs.

Everything below was verified against live traffic on 2026-09-24 (Devin CLI 3000.11.3), captured
through a local dumping proxy.

## What Devin CLI sends

Setting `WINDSURF_API_SERVER_URL=http://127.0.0.1:PORT` redirects all exa traffic, and only that
traffic: authentication, handoff and cloud sessions go to `api.devin.ai` untouched, which is
correct — none of it is model traffic.

Observed endpoints:

| Endpoint | Content type | Role |
|---|---|---|
| `/exa.api_server_pb.ApiServerService/GetChatMessage` | `application/connect+proto` | Model inference. The interception point. |
| `/exa.api_server_pb.ApiServerService/GetCliModelConfigs` | `application/proto` | Model catalogue for `/model`. |
| `/exa.api_server_pb.ApiServerService/GetAccountManagedPlugins` | `application/proto` | Managed plugins. |
| `/exa.seat_management_pb.SeatManagementService/*` | `application/proto` | Plan, team settings, usage limits. |
| `/exa.product_analytics_pb.ProductAnalyticsService/*` | `application/proto` | Analytics events. |

`GetChatMessage` uses Connect server-streaming: request and response bodies are frames of
`[flags:1][length:4 BE][protobuf]`. The request is a single frame; the response is many. The
final frame has flag `0x2` and a JSON trailer (`{}` on success). The other endpoints are plain
unary `application/proto` — a raw protobuf body, no envelope.

### `GetChatMessageRequest`, as decoded

Only the field numbers the adapter reads are listed; everything else is forwarded as raw bytes.

- `1` — client metadata (name, version, session token JWT, locale, OS)
- `3` (repeated) — one message each:
  - `1` message uuid, `2` role (`1` user/system text, `2` assistant, `4` tool result),
    `3` text content
  - assistant messages carry `6` = tool call `{ 1 = call id, 2 = tool name, 3 = args JSON }`,
    `11` = thinking text, and `12`/`18` = a `sealed.v1.…` server signature
  - tool-result messages carry `7` = the call id they answer
- `10` (repeated) — one tool each: `1` name, `2` description, `3` parameters as a JSON-schema
  string

Requests without field `10` happen (a small follow-up call carried only the last user message);
they pass through with `no_tools` like any other adapter.

### `GetChatMessageResponse` stream

Each frame is one protobuf message. The fields that matter:

- `6` — tool-call delta: first `{ 1 = call id, 2 = tool name }`, then `{ 3 = args JSON chunk }`
  repeated
- `9` — text delta (assistant and reasoning text)
- a late frame carries usage as labelled counters (`input_tokens`, `output_tokens`,
  `cached_input_tokens`); the adapter locates it by those labels for the dashboard

### The seal

Assistant messages in the next request carry `12`/`18` = `sealed.v1.<base64>`, a server-side
signature. If the server validates it, a `direct` answer synthesized by the gateway — which
produces an unsealed assistant message in the client's history — could fail every later turn.
This is the design's one unverified assumption, handled by the fallback below.

## Design

### Proto layer (`src/proto/`)

- `wire.ts` — protobuf wire-format reader and writer, no schema and no dependencies:
  `readFields(buf)` yields `{ field, wire, varint? , bytes? }` for wire types 0, 1, 2 and 5 and
  throws on anything else (groups included); `field(fieldNo, wire, payload)` encodes one field.
  ~120 lines. Callers catch the throw and fall back to passthrough — malformed input is never
  the gateway's problem to solve.
- `connect.ts` — `peel(buf)` splits a body into `{ flags, payload }` frames and
  `frame(payload, flags)` builds one.

### Adapter (`src/adapters/exa.ts`)

Implements `Adapter<ExaRequest>` where `ExaRequest` is the decoded frame list plus the raw
request bytes.

- `toInput` — peel the request frame, decode the protobuf, map field `10` to `RouterTool[]`
  (kind `function`, parameters parsed from the JSON-schema string) and field `3` to `Turn[]`
  (`role 1` → user, `2` → assistant with `tool_calls`, `4` → tool_result). `toolChoice` is
  `"auto"` — the protocol has no tool-choice field — and `steer` is `"hint"`.
- `apply` — `hint` mode only: appends a role-`1` message to field `3` whose text asks for Jev's
  tool, then re-frames. Appending after the last block keeps any prompt-cache prefix intact.
- `directStream` — synthesizes the response: a frame carrying
  `6 { 1 = generated call id, 2 = tool }`, frames chunking `6 { 3 = args JSON }`, and the `0x2`
  trailer `{}`. `directJson` returns the same bytes — the protocol is always streamed.

Parse failure anywhere on this path is a `passthrough` reason, matching invariant 1.

### Routing (`src/app.ts`)

`route()` today parses JSON. Exa needs a sibling, `routeProto(adapter)`, that runs the same
decide/apply/forward flow on decoded frames:

- `POST /exa.api_server_pb.ApiServerService/GetChatMessage` → `routeProto(exaAdapter)`
- `app.all("/*")`, registered after every other route — everything else (`seat_management`,
  analytics, `GetCliModelConfigs`, unknown future endpoints) forwards untouched

`forward()` already proxies bytes verbatim; exa adds no upstream special-casing beyond
`UPSTREAM_BASE_URL=https://server.codeium.com`.

### Launcher (`bin/`)

- `clients.mjs` gains `devin`: `client: "devin"`, `portEnv: "JEV_DEVIN_PORT"`,
  `defaultPort: 8792`, `upstream` defaulting to `https://server.codeium.com` (overridable via
  `JEV_DEVIN_UPSTREAM_BASE_URL`), `env: (origin) => ({ WINDSURF_API_SERVER_URL: origin })`.
  `configHelp` prints the env var form. No `notices` in v1.
- `bin/jev-devin.mjs` — the three-line launcher like its siblings.
- `package.json` — `bin` entry, `devin` keyword, `pnpm devin` script.

`devin` and `devin -p` both spawn `devin acp` internally, and the child inherits
`WINDSURF_API_SERVER_URL`, so interactive and print modes are covered by the same launcher.

### Seal fallback

Test first: run a real `devin -p` session through the gateway with a direct answer and check
the next turn. If the server rejects unsealed history, the adapter reports
`passthrough`/`hint` only — the exa route skips `direct` from then on. That decision is
recorded in code once the test answers it, not left as a runtime probe.

### Tests

- `test/exa.test.ts` — sanitized `.bin` fixtures captured from real traffic (the session JWT
  in field `1.3` replaced): `toInput` extracts tools and turns, `apply` appends a hint message,
  `directStream` emits frames that `peel` and the wire reader accept, and garbage bytes produce
  `passthrough`, never a thrown route.
- `test/helpers.ts` — no changes expected; `fakeJev`/`fakeUpstream`/`testConfig` already inject
  everything external.

## Out of scope

- `api.devin.ai` traffic (auth, handoff, cloud). No env var reaches it, and it carries no model
  calls.
- `devin acp --cloud`, `devin ssh`, outposts — separate transports.
- Decoding seat-management or analytics messages. They are forwarded opaque.
- `ACP_BACKEND` — only `windsurf` exists in build 3000.11.3; the `openai` backend its own error
  message advertises is not compiled in.

## Why it is built this way

A schema-free wire reader fits the repo's few-dependencies rule: the adapter needs six field
numbers, not the `exa.api_server_pb` schema, and generated protobuf code would pin a
reverse-engineered schema that changes without notice. Synthesizing `direct` answers rather
than forcing tool choice follows the protocol's shape — there is no `tool_choice` to set —
while `hint` covers the confident-but-argless decisions and keeps the prompt cache valid by
appending instead of rewriting.
