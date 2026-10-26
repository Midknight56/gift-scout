export interface PayPalEvent {
  type: string
  orderId?: string
  captureId?: string
  customId?: string
  amount?: string
}

/** Parse only the two PayPal events Gift Scout acts on. */
export function parseEvent(raw: string): PayPalEvent | null {
  let body: any
  try { body = JSON.parse(raw) } catch { return null }
  if (!body || typeof body !== 'object' || typeof body.event_type !== 'string' || !body.resource || typeof body.resource !== 'object') return null
  const r = body.resource
  if (body.event_type === 'CHECKOUT.ORDER.APPROVED') {
    const id = r.id, customId = r.purchase_units?.[0]?.custom_id
    return typeof id === 'string' && typeof customId === 'string' ? { type: body.event_type, orderId: id, customId } : null
  }
  if (body.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const captureId = r.id, customId = r.custom_id, orderId = r.supplementary_data?.related_ids?.order_id, amount = r.amount?.value
    return [captureId, customId, orderId, amount].every((x) => typeof x === 'string')
      ? { type: body.event_type, captureId, customId, orderId, amount } : null
  }
  return null
}
