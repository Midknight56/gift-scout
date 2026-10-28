"""Proves the finished purchase in the PayPal sandbox and prints each answer's HTTP code and ids (never a secret).

An order with a shipping address, paid with PayPal's published sandbox test card; a tracker on its capture; the order
read back with the tracker on it; then a full refund of the capture. Reads PAYPAL_CLIENT_ID and PAYPAL_SECRET from
.dev.vars (or the environment). Sandbox only: every call goes to api-m.sandbox.paypal.com.

    python tools/sandbox_finish_purchase.py
"""
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

BASE = 'https://api-m.sandbox.paypal.com'
ROOT = pathlib.Path(__file__).resolve().parent.parent


def setting(name):
    if os.environ.get(name):
        return os.environ[name]
    try:
        for line in (ROOT / '.dev.vars').read_text(encoding='utf-8').splitlines():
            if line.startswith(name + '='):
                return line.split('=', 1)[1].strip()
    except OSError:
        pass
    sys.exit(f'{name} is not set')


def call(method, path, token=None, body=None, basic=None, form=None, request_id=None):
    headers = {'Content-Type': 'application/json'}
    if basic:
        headers['Authorization'] = 'Basic ' + basic
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if request_id:
        headers['PayPal-Request-Id'] = request_id
    data = None
    if form is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        data = form.encode()
    elif body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except ValueError:
            return e.code, {}


def main():
    basic = base64.b64encode(f"{setting('PAYPAL_CLIENT_ID')}:{setting('PAYPAL_SECRET')}".encode()).decode()
    status, out = call('POST', '/v1/oauth2/token', basic=basic, form='grant_type=client_credentials')
    print('token', status)
    if status != 200:
        return 1
    token = out['access_token']
    stamp = str(int(time.time()))
    order_body = {
        'intent': 'CAPTURE',
        'purchase_units': [{
            'custom_id': 'gs-sandboxproof-t1c1',
            'description': 'A copy of Fallen Angel',
            'amount': {'currency_code': 'USD', 'value': '15.00'},
            'shipping': {
                'type': 'SHIPPING',
                'name': {'full_name': 'Sam Rivera'},
                'address': {'address_line_1': '1 Main St', 'admin_area_2': 'San Jose', 'admin_area_1': 'CA',
                            'postal_code': '95131', 'country_code': 'US'},
            },
        }],
        'payment_source': {'card': {'number': '4111111111111111', 'expiry': '2030-12', 'security_code': '123',
                                    'name': 'Gift Scout Judge'}},
    }
    status, order = call('POST', '/v2/checkout/orders', token, order_body, request_id='gs-proof-order-' + stamp)
    unit = (order.get('purchase_units') or [{}])[0]
    capture = ((unit.get('payments') or {}).get('captures') or [{}])[0]
    print('order with shipping, test card', status, order.get('status'), order.get('id'), 'capture', capture.get('id'),
          capture.get('status'), 'ship to', (unit.get('shipping') or {}).get('address', {}).get('admin_area_2'))
    if status not in (200, 201) or not capture.get('id'):
        print(json.dumps(order)[:600])
        return 1
    track_body = {'capture_id': capture['id'], 'tracking_number': 'GS' + stamp, 'carrier': 'OTHER',
                  'carrier_name_other': 'Gift Scout sandbox', 'notify_payer': False}
    status, tracked = call('POST', f"/v2/checkout/orders/{order['id']}/track", token, track_body,
                           request_id='gs-proof-track-' + stamp)
    trackers = ((tracked.get('purchase_units') or [{}])[0].get('shipping') or {}).get('trackers') or []
    print('tracker', status, [(t.get('id'), t.get('status')) for t in trackers] or json.dumps(tracked)[:400])
    status, again = call('GET', f"/v2/checkout/orders/{order['id']}", token)
    trackers = ((again.get('purchase_units') or [{}])[0].get('shipping') or {}).get('trackers') or []
    print('order read back', status, [(t.get('id'), t.get('status')) for t in trackers])
    status, refund = call('POST', f"/v2/payments/captures/{capture['id']}/refund", token, {},
                          request_id='gs-proof-refund-' + stamp)
    print('refund', status, refund.get('status'), refund.get('id') or json.dumps(refund)[:400])
    approve_body = dict(order_body)
    approve_body['payment_source'] = {'paypal': {'experience_context': {
        'brand_name': 'Gift Scout', 'user_action': 'PAY_NOW', 'shipping_preference': 'SET_PROVIDED_ADDRESS',
        'return_url': 'https://example.com/paid', 'cancel_url': 'https://example.com/'}}}
    status, waiting = call('POST', '/v2/checkout/orders', token, approve_body, request_id='gs-proof-approve-' + stamp)
    print('order for approval at PayPal, provided address', status, waiting.get('status'), waiting.get('id'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
