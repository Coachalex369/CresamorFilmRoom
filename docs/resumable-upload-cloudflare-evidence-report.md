# Cloudflare R2 Evidence Report — Browser-Only Multipart UploadPart 503

Prepared from the diagnosis committed at `4d24ac3` on
`feature/resumable-mobile-uploads` (see `docs/resumable-upload-browser-503.md`
for full context). This file contains no secrets — presigned URLs, query
strings, signatures, and credential IDs are redacted throughout.

## What Cloudflare needs to correlate

- **R2 account ID:** `2af9bb10bed09c45bd6c7f0ee401418f` (not an access key —
  this is the account-id segment of the bucket's virtual-hosted endpoint).
- **Bucket:** `cresamor-videos`
- **Endpoint hostname (sanitized):**
  `cresamor-videos.2af9bb10bed09c45bd6c7f0ee401418f.r2.cloudflarestorage.com`
- **Object path pattern:** `videos/<team_id>/<year>/<uuid>.mp4` (object key
  itself is a random UUID, not sensitive)
- **Operation:** S3-compatible multipart `UploadPart` (`x-id=UploadPart`)
- **Part size:** 10 MiB (10,485,760 bytes) — `UPLOAD_PART_SIZE_MB` default
- **Concurrency:** reproduced at concurrency 1 (isolated single-part PUTs,
  fresh presigned URL per attempt), in addition to the app's normal
  concurrency of up to 3 concurrent parts during the initial automatic
  reproduction
- **Browser / OS:** Chrome 151.0.0.0, Windows (Win64; x64), from
  `navigator.userAgent`: `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36`

## Failed requests (browser-originated)

All requests below: **method `PUT`**, target the endpoint above with query
string `[REDACTED]` (contains `X-Amz-Algorithm`, `X-Amz-Credential`,
`X-Amz-Date`, `X-Amz-Expires`, `X-Amz-Signature`, `X-Amz-SignedHeaders=host`,
`partNumber`, `uploadId`, checksum params — all omitted here), **status
`503`**, operation `UploadPart`.

| # | UTC timestamp (2026-08-28) | Part | Source |
|---|---|---|---|
| 1 | 03:14:50 | 1 | automatic reproduction (app's real retry/concurrency path) |
| 2 | 03:14:51 | 2 | automatic reproduction |
| 3 | 03:14:52 | 1 | automatic reproduction |
| 4 | 03:14:52 | 2 | automatic reproduction |
| 5 | 03:14:55 | 1 | automatic reproduction |
| 6 | 03:14:56 | 2 | automatic reproduction |
| 7 | 03:15:01 | 1 | automatic reproduction |
| 8 | 03:15:01 | 2 | automatic reproduction |
| 9 | 03:15:51 | 1 | manual, isolated, concurrency-1 reproduction |
| 10 | 03:16:03 | 1 | manual, isolated, concurrency-1 reproduction |

**cf-ray for the failed requests: not captured.** The browser's CORS policy
blocked page JavaScript from reading response headers on these specific
(non-2xx) responses, and the network-inspection tooling available during
this diagnosis exposed only URL/method/status, not headers. This is itself
part of what Cloudflare's own logs would need to fill in — see "Open
question for Cloudflare" below.

**Response header names for the failures: not captured** (same CORS-blocking
reason above — the browser reports these as a generic network error at the
JS layer, with zero readable headers).

**Response body / S3-style error code for the failures: not captured** (same
reason; no tooling in this pass could read the 503 response body from a
real browser request).

## Control data (successful Node requests, same account/bucket/operation)

Captured from **Node**, not the browser, replicating the exact same
`UploadPart` operation against the same bucket immediately after / around
the failures above. These succeeded every time — provided as a same-window
baseline for Cloudflare to compare against, not as evidence about the
failures themselves.

| UTC timestamp (2026-08-28, response `Date` header) | Status | cf-ray | Response header names |
|---|---|---|---|
| 03:17:53 | 200 | `a3202a535f07e777-DEN` | `date`, `content-length`, `connection`, `etag`, `x-amz-checksum-crc64nvme`, `server`, `cf-ray` |
| 03:18:52 | 200 | `a3202bbd7e647c28-DEN` | (same set as above) |
| 03:18:55 | 200 | `a3202bd0ff137c28-DEN` | (same set as above) |
| 03:19:43 | 200 | `a3202d01b9f78984-DEN` | (same set as above) |
| 03:19:46 | 200 | `a3202d139d47d215-DEN` | (same set as above) |

Every `cf-ray` captured in this diagnosis ends in the **`-DEN`** data-center
suffix. This is only confirmed for the successful Node control requests
above — the data center that actually handled the failed browser requests
is unconfirmed (no `cf-ray` was captured for them). Given all requests
originated from the same network location within the same short window,
`DEN` is a reasonable starting assumption for Cloudflare's own log lookup,
not a confirmed fact.

Response body on all successful requests: empty (`content-length: 0`), with
a real `ETag` returned, confirming the part was accepted and stored.

## Confirmation: Node succeeds, browser does not

- Every Node-originated `UploadPart` PUT during this diagnosis — the
  baseline `fetch()` call, an `Origin`-header replication, a full
  realistic-Chrome-header replication, an IPv4-forced attempt, and an
  IPv6-forced attempt — returned **`200`** with a real `ETag`.
- Every browser-originated `UploadPart` PUT during this diagnosis — 10
  total, spanning the app's normal automatic retry path and two manually
  isolated concurrency-1 attempts — returned **`503`**. None ever returned
  a `200` or an `ETag`.

## Confirmation: R2 stored zero parts from the browser attempts

No browser attempt, in any of the 10 requests above, ever received an
HTTP 200/`ETag` response — by the S3 multipart-upload protocol, a part is
only durably stored once `UploadPart` returns successfully, so none of
these 10 attempts landed a part. As secondary, weaker corroboration: after
this diagnosis concluded, the session was aborted through the real API
(`AbortMultipartUploadCommand`), and a subsequent `ListParts` call against
the same upload id returned `NoSuchUpload` — consistent with, though not an
independent pre-abort proof of, zero parts having been stored. (An earlier,
separate branch checkpoint predating this diagnosis pass is understood to
have independently confirmed zero stored parts via `ListParts` on its own
failed attempts, prior to any cleanup — that check was not repeated in this
pass to avoid running another live upload test.)

## Open question for Cloudflare

Browser-originated multipart `UploadPart` requests to our R2 bucket
consistently return HTTP 503 and store no part. The same freshly presigned
operation succeeds from Node with HTTP 200. CORS preflight returns 204 and
allows the exact browser origin and `PUT`. We reproduced the failure at
concurrency 1 with fresh upload sessions. We were also able to rule out,
via controlled Node-side replication, HTTP/2 vs HTTP/1.1 (the endpoint only
negotiates HTTP/1.1 via ALPN), IPv4 vs IPv6, the `Origin` header alone, and
a full replicated set of real Chrome request headers (User-Agent, Accept*,
Sec-Fetch-*, Sec-CH-UA*) — none of these reproduce the failure outside a
real browser. Please correlate the UTC timestamps above (and `cf-ray`
values, for the successful control requests) with R2 gateway logs and
identify the internal reason the browser-originated requests receive 503.
