// PayPal Orders v2 in the sandbox, plain REST: a client credentials token, create an order, capture it. Every Gift
// Scout order carries a custom_id that starts with "gs-", so the shared sandbox app's other apps never touch ours.
// Measured 23 Oct 2026 with the shared app: token 200, create 200 (PAYER_ACTION_REQUIRED, a payer-action link),
// buyer approval in the sandbox, capture 201 COMPLETED, refund 201 COMPLETED.

export const PAYPAL_SANDBOX = 'https://api-m.sandbox.paypal.com'

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly debugId?: string) { super(message) }
}

export interface Order { id: string; status: string; approveUrl?: string; customId?: string; amount?: string; captureId?: string }

/** PayPal's published sandbox test card (developer.paypal.com/tools/sandbox/card-testing). Sandbox only: the client
 *  talks to api-m.sandbox.paypal.com. Measured 23 Oct 2026: an order paid with it answered 201 COMPLETED in one call. */
export const SANDBOX_TEST_CARD = { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Gift Scout Judge' }
export interface Capture { orderId: string; status: string; captureId: string; amount: string; customId?: string }

export class PayPal {
  private token?: { value: string; until: number }

  constructor(
    private clientId: string,
    private secret: string,
    private fetcher: typeof fetch,
    private base = PAYPAL_SANDBOX,
    private now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value
    let res: Response
    try { res = await this.timedFetch(this.base + '/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${this.clientId}:${this.secret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }) } catch { throw new PayPalError('PayPal did not answer the sign-in request', 502) }
    if (!res.ok) throw new PayPalError('PayPal did not sign us in', res.status)
    let body: { access_token?: unknown; expires_in?: unknown }
    try { body = await res.json() as typeof body } catch { throw new PayPalError('PayPal returned an unreadable sign-in answer', 502) }
    if (typeof body?.access_token !== 'string' || !body.access_token || (body.expires_in !== undefined && (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)))) {
      throw new PayPalError('PayPal returned an incomplete sign-in answer', 502)
    }
    // A minute early, so a token never runs out in the middle of a request.
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 300
    this.token = { value: body.access_token, until: this.now() + (lifetime - 60) * 1000 }
    return this.token.value
  }

  private async call(path: string, body: unknown, requestId: string): Promise<Record<string, unknown>> {
    let res: Response
    try { res = await this.timedFetch(this.base + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (await this.accessToken()), 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId },
      body: JSON.stringify(body),
    }) } catch { throw new PayPalError('PayPal did not answer the request', 502) }
    let out: Record<string, unknown>
    try {
      const parsed: unknown = await res.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      out = parsed as Record<string, unknown>
    } catch {
      if (res.ok) throw new PayPalError('PayPal returned an unreadable answer', 502)
      out = {}
    }
    if (!res.ok) {
      const name = typeof out.name === 'string' ? out.name : 'HTTP ' + res.status
      throw new PayPalError('PayPal said: ' + name, res.status, out.debug_id as string | undefined)
    }
    return out
  }

  private async timedFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try { return await this.fetcher(input, { ...init, signal: controller.signal }) }
    finally { clearTimeout(timer) }
  }

  /** An order. With `card` it is paid at once with that card (COMPLETED, with a capture); without, it waits for the
   *  buyer to approve at PayPal's link. `requestId` makes a repeat of the same tap the same order. */
  async createOrder(o: {
    amount: string; customId: string; description: string; returnUrl: string; cancelUrl: string; requestId: string
    card?: typeof SANDBOX_TEST_CARD
  }): Promise<Order> {
    const source = o.card
      ? { card: o.card }
      : { paypal: { experience_context: { brand_name: 'Gift Scout', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: o.returnUrl, cancel_url: o.cancelUrl } } }
    const out = await this.call('/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: o.customId, description: o.description.slice(0, 127), amount: { currency_code: 'USD', value: o.amount } }],
      payment_source: source,
    }, o.requestId)
    if (typeof out.id !== 'string' || !out.id || typeof out.status !== 'string' || !out.status) {
      throw new PayPalError('PayPal returned an incomplete order answer', 502)
    }
    const links = (out.links as { rel: string; href: string }[] | undefined) ?? []
    const cap = (out.purchase_units as { payments?: { captures?: { id: string; status: string }[] } }[] | undefined)?.[0]?.payments?.captures?.[0]
    return {
      id: String(out.id),
      status: String(out.status),
      approveUrl: links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href,
      customId: o.customId,
      amount: o.amount,
      ...(cap?.status === 'COMPLETED' ? { captureId: cap.id } : {}),
    }
  }

  async capture(orderId: string): Promise<Capture> {
    const out = await this.call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, 'capture-' + orderId)
    const unit = (out.purchase_units as { custom_id?: string; payments?: { captures?: { id: string; status: string; amount: { value: string }; custom_id?: string }[] } }[] | undefined)?.[0]
    const cap = unit?.payments?.captures?.[0]
    if (!cap || typeof cap.id !== 'string' || !cap.id || typeof cap.status !== 'string' || typeof cap.amount?.value !== 'string') throw new PayPalError('PayPal gave no capture', 502)
    return { orderId, status: cap.status, captureId: cap.id, amount: cap.amount.value, customId: cap.custom_id ?? unit?.custom_id }
  }

  /** Ask PayPal to verify a webhook against its original, unmodified event body. */
  async verifyWebhook(headers: Headers, raw: string, webhookId: string): Promise<boolean> {
    const fields = {
      auth_algo: headers.get('PAYPAL-AUTH-ALGO'),
      cert_url: headers.get('PAYPAL-CERT-URL'),
      transmission_id: headers.get('PAYPAL-TRANSMISSION-ID'),
      transmission_sig: headers.get('PAYPAL-TRANSMISSION-SIG'),
      transmission_time: headers.get('PAYPAL-TRANSMISSION-TIME'),
    }
    if (Object.values(fields).some((v) => !v)) return false
    let token: string
    try { token = await this.accessToken() } catch { return false }
    const body = '{"auth_algo":' + JSON.stringify(fields.auth_algo) +
      ',"cert_url":' + JSON.stringify(fields.cert_url) +
      ',"transmission_id":' + JSON.stringify(fields.transmission_id) +
      ',"transmission_sig":' + JSON.stringify(fields.transmission_sig) +
      ',"transmission_time":' + JSON.stringify(fields.transmission_time) +
      ',"webhook_id":' + JSON.stringify(webhookId) + ',"webhook_event":' + raw + '}'
    const res = await this.fetcher(this.base + '/v1/notifications/verify-webhook-signature', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body,
    })
    if (!res.ok) return false
    const out = await res.json().catch(() => null) as { verification_status?: unknown } | null
    return out?.verification_status === 'SUCCESS'
  }
}
