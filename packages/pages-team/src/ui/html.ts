/**
 * Server-rendered HTML: the UI shell, plain message pages, and the page frame.
 *
 * The page frame is served from its own address with a strict CSP:
 *   - `sandbox` (no allow-same-origin) gives the page an opaque origin, even
 *     when someone opens the frame address directly. The page cannot read
 *     the sign-in cookie or call the team API.
 *   - `connect-src 'none'` and no external sources: the page cannot use the
 *     network. Pages are self-contained by contract (see docs/pages.md).
 *   - Static pages get no scripts, as in the app.
 */

import type { PageKind } from '../page-files.ts'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function renderShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Incredible pages</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<div id="app" class="app"><div class="state"><p class="state-text">Loading…</p></div></div>
<script src="/assets/app.js"></script>
</body>
</html>`
}

export function renderMessagePage(status: number, title: string, message: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<div class="app"><div class="state"><p class="state-text">${escapeHtml(message)}</p></div></div>
</body>
</html>`
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
  })
}

export function frameCsp(kind: PageKind): string {
  const scripts = kind === 'static' ? "script-src 'none'" : "script-src 'unsafe-inline'"
  const sandbox = kind === 'static' ? 'sandbox' : 'sandbox allow-scripts allow-forms'
  return [
    "default-src 'none'",
    scripts,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    sandbox,
  ].join('; ')
}

export function renderFrameResponse(kind: PageKind, content: string): Response {
  return new Response(content, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': frameCsp(kind),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  })
}
