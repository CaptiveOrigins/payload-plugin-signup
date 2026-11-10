import type { Endpoint, PayloadRequest } from 'payload'

import { currentMode, readSignupRequest, type RequestDetail, submitSignup, verifySignup } from './flow.js'
import { SignupError } from './util.js'

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const failure = (error: unknown, req: PayloadRequest) => {
  if (error instanceof SignupError) return json({ error: { code: error.code, message: error.message } }, error.status)
  req.payload.logger.error({ err: error, msg: 'signup: request failed' })
  return json({ error: { code: 'error', message: 'Something went wrong. Please try again later.' } }, 500)
}
const body = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  try {
    const type = req.headers.get('content-type') ?? ''
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) return Object.fromEntries((await req.formData!()).entries())
    return ((await req.json?.()) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** A bare page for sites without their own: readable, keyboard-friendly, no scripts. */
const page = (title: string, inner: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title>` +
      '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#1a4d2e;color:#fff;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #f2a900;outline-offset:2px}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}dd{margin:0}input{font:inherit;padding:.5rem;width:100%;max-width:20rem;box-sizing:border-box}.error{color:#b00020;font-weight:600}@media (prefers-color-scheme:dark){.error{color:#ff8a80}}@media (prefers-color-scheme:dark){body{background:#121212;color:#eee}}</style>' +
      `</head><body><main><h1>${escape(title)}</h1>${inner}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  )

/** Choose a password, twice, then confirm. Labels and autocomplete hints for password managers and screen readers. */
/** What they asked for, so they can see it's their request before confirming. */
const summary = (shown: { email: string; details: RequestDetail[] } | null) =>
  shown
    ? `<p>You asked for an account as <strong>${escape(shown.email)}</strong>.</p>` +
      (shown.details.length ? `<dl>${shown.details.map((d) => `<dt>${escape(d.label)}</dt><dd>${escape(d.value)}</dd>`).join('')}</dl>` : '')
    : ''

const confirmForm = (req: PayloadRequest, token: string, shown: { email: string; details: RequestDetail[] } | null = null) => {
  const min = (req.payload.config.custom?.signup as { minPasswordLength?: number } | undefined)?.minPasswordLength ?? 10
  return (
    summary(shown) +
    `<p>Choose the password for your account, then press the button to confirm this is your email address.</p>` +
    `<form method="post" action="${escape(req.payload.config.routes.api)}/signup/verify">` +
    `<input type="hidden" name="token" value="${escape(token)}">` +
    `<p><label for="password">Password (at least ${min} characters)</label><br><input id="password" name="password" type="password" autocomplete="new-password" minlength="${min}" maxlength="256" required></p>` +
    `<p><label for="confirm">The same password again</label><br><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${min}" maxlength="256" required></p>` +
    `<button type="submit">Confirm my email</button></form>` +
    `<p>If you didn't ask for an account, close this page. Nothing happens unless you press the button.</p>`
  )
}

export const signupEndpoints: Endpoint[] = [
  {
    // What the form should show: open to requests or not, and the message when it isn't.
    path: '/signup/mode',
    method: 'get',
    handler: async (req) => {
      const { mode, message } = await currentMode(req.payload)
      return json({ mode, accepting: mode === 'open' || mode === 'approval', message })
    },
  },
  {
    path: '/signup/request',
    method: 'post',
    handler: async (req) => {
      try {
        const b = await body(req)
        const out = await submitSignup(req.payload, { email: b.email, details: b.details, answers: b.answers, humanToken: typeof b.humanToken === 'string' ? b.humanToken : undefined }, req)
        return json(out, 202)
      } catch (error) {
        return failure(error, req)
      }
    },
  },
  {
    // The link in the email. Opening it never verifies by itself (mail scanners open links): the person chooses
    // their password here and presses the button, so the account is made by whoever owns the inbox.
    path: '/signup/verify',
    method: 'get',
    handler: async (req) => {
      const token = new URL(req.url ?? 'http://x').searchParams.get('token') ?? ''
      // Show the request so they know what they're confirming. Reading changes nothing, so a mail scanner opening
      // the link is harmless. A dead link says so now, rather than after they've typed a password twice.
      try {
        return page('Confirm your email', confirmForm(req, token, await readSignupRequest(req.payload, { token }, req)))
      } catch (error) {
        if (error instanceof SignupError && error.code === 'badLink') return page('That didn\'t work', `<p>${escape(error.message)}</p>`, 400)
        if (!(error instanceof SignupError)) req.payload.logger.error({ err: error, msg: 'signup: request not readable for the confirm page' })
        // Too many tries or a lookup that broke: the form still works, without the summary.
        return page('Confirm your email', confirmForm(req, token))
      }
    },
  },
  {
    path: '/signup/verify',
    method: 'post',
    handler: async (req) => {
      const b = await body(req)
      const html = !(req.headers.get('content-type') ?? '').includes('json')
      try {
        // The page asks twice; the JSON API leaves that to the site's own form.
        if (html && b.password !== b.confirm) throw new SignupError('passwordMismatch', 'The two passwords don\'t match. Please type the same password twice.')
        const out = await verifySignup(req.payload, { token: b.token, password: b.password }, req)
        if (!html) return json(out)
        return out.status === 'active'
          ? page('You\'re in', '<p>Your email is confirmed and your account is ready. We\'ve sent you an email with the sign-in link.</p>')
          : page('Thanks, you\'re on the list', '<p>Your email is confirmed. A person will look at your request, and we\'ll email you when it\'s decided.</p>')
      } catch (error) {
        if (!html) return failure(error, req)
        const message = error instanceof SignupError ? error.message : 'Something went wrong. Please try again later.'
        // A password problem keeps the form, so they can try again with the same link.
        if (error instanceof SignupError && (error.code === 'password' || error.code === 'passwordMismatch'))
          {
          const shown = await readSignupRequest(req.payload, { token: b.token }, req).catch(() => null)
          return page('Confirm your email', `<p role="alert" class="error">${escape(message)}</p>${confirmForm(req, String(b.token ?? ''), shown)}`, 400)
        }
        return page('That didn\'t work', `<p>${escape(message)}</p>`, error instanceof SignupError ? error.status : 500)
      }
    },
  },
]
