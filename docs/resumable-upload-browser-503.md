# Resumable Uploads: Browser-Only R2 Multipart PUT 503

Status: **open, root cause not yet identified.** This document preserves the
diagnosis performed against checkpoint `49e15c5` after integrating current
`main` (Direct Messaging, multi-team invitations) into
`feature/resumable-mobile-uploads`.

## Checkpoint

- Branch: `feature/resumable-mobile-uploads`
- Integration commit (main merged in): `d4f3eca`
- Phase A server-side multipart test (`testMultipartUploads.js`, real R2): **34/34**
- Full merged-branch regression suite (existing production-backed suites +
  Phase A, rerun after the merge): **259/259**

## What works

- **Node presigned PUT succeeds.** A direct `fetch()` PUT (and a raw
  `https.request()` PUT) from Node to the exact same presigned R2 part URL
  returns `200 OK`, an `ETag` response header, and the part is durably
  stored (confirmed via R2 `ListParts`).
- **CORS preflight succeeds.** The `OPTIONS` preflight for the browser's PUT
  returns `204` with the correct request origin and `PUT` allowed.
- **Successful responses expose `ETag`.** Both the Node control PUTs and (per
  the original checkpoint's server-side testing) properly-configured
  successful browser PUTs return a readable `ETag`, confirming R2's
  `Access-Control-Expose-Headers` is correctly configured for the success
  path.

## What fails

- **Real Chrome's presigned PUT consistently returns a wire-level `503`.**
  Reproduced live via `multipartUploader.js`, unmodified, called directly
  (the `RESUMABLE_UPLOADS_ENABLED` flag was never turned on — see "Safety
  state" below). Every part PUT attempt from the real browser failed;
  `multipartUploader.js`'s own retry loop (5 attempts, exponential backoff)
  exhausted and tripped its circuit breaker, surfacing as `Error: Network
  error during part upload` in the app.
- **R2 stores zero parts from the failed Chrome attempts.** Confirmed via
  `ListParts` immediately after the failed run — not merely an
  unreadable-`ETag`/CORS-response-reading issue; the part genuinely never
  landed.
- Chrome's DevTools network log shows the true wire-level status as `503`
  for every failed PUT (i.e., this is confirmed as a real HTTP status
  returned to the browser, not an artifact of the JS-level CORS block on
  reading the response — though the CORS block does mean the response
  *body* and most response *headers* were not readable from page
  JavaScript for the failing requests specifically).

## Ruled out by controlled Node tests

Each of the following was tested by replicating the real browser's exact
value/behavior from Node against the same session/endpoint, and each still
returned `200 OK`:

| Hypothesis | Test | Result |
|---|---|---|
| HTTP/2 vs HTTP/1.1 | Raw TLS/ALPN probe against the R2 host | R2's endpoint only ever negotiates `http/1.1` via ALPN — Chrome and Node necessarily use the same protocol version here. HTTP/2 itself is not reachable on this host, ruling it out entirely. |
| `Origin` header | PUT with `Origin` header added in Node | Succeeded (this had already been ruled out prior to this checkpoint too). |
| Full realistic Chrome header set | PUT with matching `User-Agent`, `Accept`, `Accept-Encoding`, `Accept-Language`, `Sec-Fetch-Dest/Mode/Site`, `sec-ch-ua*`, `Connection` (values pulled live from the real Chrome tab) | Succeeded. |
| IPv4 vs IPv6 | PUT forced over each address family explicitly (`family: 4` / `family: 6`) | Succeeded on both. |

## Remaining fault boundary

With HTTP version, address family, `Origin`, and the full realistic browser
header set all ruled out as the trigger, the fault boundary is something
specific to the **real browser/network/TLS client path** that a Node
`https`/`fetch` request — even one built to match Chrome's request content
as closely as possible — does not reproduce.

**This is a fault-boundary statement, not a diagnosis.** The following are
open hypotheses, listed for the next investigation pass — none has
supporting edge-side evidence yet, and none should be treated as concluded:

- Cloudflare edge/WAF or bot-management behavior keyed on TLS
  fingerprint (e.g., JA3/JA4) rather than request content, on this R2
  bucket's presigned-URL host.
- Local TLS interception/inspection (security software, proxy, or
  corporate/network middlebox) altering the browser's outbound TLS
  handshake in a way that doesn't affect Node's separate TLS stack.
- Chrome extension or browser-profile behavior altering the request
  before it leaves the browser.
- Some other browser-only transport characteristic not yet identified.

## Captured non-secret correlation data

Response `Date` headers and `cf-ray` values from the **successful Node
control PUTs** (useful as a timing anchor, not as evidence about the
failures themselves — response headers were not readable from page
JavaScript for the failed Chrome requests, which is itself part of the
open fault-boundary question):

| Test | Date (response header) | cf-ray |
|---|---|---|
| Node `fetch()` baseline | Fri, 28 Aug 2026 03:17:53 GMT | `a3202a535f07e777-DEN` |
| Origin-header replication | Fri, 28 Aug 2026 03:18:52 GMT | `a3202bbd7e647c28-DEN` |
| Full Chrome-header replication | Fri, 28 Aug 2026 03:18:55 GMT | `a3202bd0ff137c28-DEN` |
| IPv6-forced | Fri, 28 Aug 2026 03:19:43 GMT | `a3202d01b9f78984-DEN` |
| IPv4-forced | Fri, 28 Aug 2026 03:19:46 GMT | `a3202d139d47d215-DEN` |

Approximate UTC timestamps of the **failed real-Chrome PUT attempts**
(from the presigned request's own signing timestamp, not from a
credential — the signature itself is not reproduced here): `03:14:50`,
`03:14:51`, `03:14:52` (×2), `03:14:55`, `03:14:56`, `03:15:01` (×2),
`03:15:51`, `03:16:03` UTC on 2026-08-28. No `cf-ray` was captured for
these specific failed requests — the CORS block on error responses
prevented page JavaScript from reading response headers, and the
available network-inspection tooling in this pass did not expose them
either. Retrieving the real `cf-ray`/edge identifiers for these exact
timestamps from Cloudflare's own logs (dashboard, Logpush, or a support
request) is the most direct way to close this gap — see "Next diagnostic
step" below.

## Cleanup proof

- The multipart session was aborted through the real API endpoint
  (`POST /api/video-uploads/:sessionId/abort`), which calls R2's
  `AbortMultipartUploadCommand` — not a database-only delete.
- A subsequent `ListParts` call against the same storage key/upload id
  returned `NoSuchUpload`, confirming R2 has no record of the session and
  no orphaned parts remain in the bucket.
- All database fixtures created during this diagnosis (throwaway user,
  team, team_members, auto-created team conversation/messages,
  video_uploads row, security_audit_log rows) were deleted and
  independently reverified at zero afterward via fresh queries.

## Current safety state

- `RESUMABLE_UPLOADS_ENABLED` remains `false` in `client/multipartUploader.js`
  — never flipped on during this diagnosis.
- `RESUMABLE_UPLOAD_THRESHOLD_BYTES` is unchanged.
- `client/app.js`'s `API_URL` is restored to the production Render URL
  (it was temporarily pointed at a local dev server for this diagnosis,
  then reverted before committing).
- No temporary local dev server is running.
- The legacy iPhone upload path (`legacyUploadVideo` / the native
  Record flow) is untouched by any of this work.

## Next diagnostic step

Before modifying any application code: correlate the failed Chrome
request timestamps above (and, if a fresh reproduction is done, their
`cf-ray` values captured via a HAR export or Cloudflare's own
request-logging) against Cloudflare's dashboard/Logpush data or a
Cloudflare support request for this R2 bucket's custom domain, to get
edge-side evidence on *why* these specific browser-originated requests
were answered with `503` — before treating any of the hypotheses above as
a conclusion.
