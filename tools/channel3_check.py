"""Prove that a live scout turn can find and buy Channel3 products.

    python tools/channel3_check.py https://<host>
    python tools/channel3_check.py https://<host> --message "A gift prompt"
    python tools/channel3_check.py --self-test
"""
import argparse
import copy
import json
import sys
import urllib.parse
import urllib.request


DEFAULT_MESSAGE = "My dad. Le Carre novels and single malt. Christmas."
HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': 'gift-scout-channel3-check/1.0',
}
PRODUCT_KINDS = {'brand', 'book', 'podcast', 'artist'}


def check_events(events: list, purchase_events: list | None = None) -> list[tuple[str, bool, str]]:
    """Return the Channel3 judging checks for a scout stream and optional buy stream.

    Cards come from the last cards event: the set the visitor sees. An earlier one may hold only dropped ideas.
    """
    purchase_events = purchase_events or []
    checks = []
    run = next((event for event in events if event.get('t') == 'run'), {})
    mode = run.get('mode', 'unknown')
    checks.append(('live run', mode == 'live', '' if mode == 'live' else f'not live: {mode}'))

    calls = [event for event in events if event.get('t') == 'call' and event.get('tool') == 'search_products']
    results = [event for event in events if event.get('t') == 'result']
    missing = [call for call in calls if not any(
        result.get('n') == call.get('n') and result.get('tool') == 'search_products' for result in results
    )]
    calls_ok = bool(calls) and not missing
    call_detail = '' if calls_ok else ('no search_products call' if not calls else f'{len(missing)} call(s) without a result')
    checks.append(('product searches have results', calls_ok, call_detail))

    cards_event = next((event for event in reversed(events) if event.get('t') == 'cards'), {})
    cards = cards_event.get('cards', []) or []
    products = [(card, card.get('product')) for card in cards if isinstance(card, dict) and card.get('product') is not None]
    checks.append(('at least two product cards', len(products) >= 2,
                   '' if len(products) >= 2 else f'found {len(products)}'))

    invalid = []
    for card, product in products:
        if not isinstance(product, dict):
            invalid.append(card.get('gift', card.get('id', 'card')) + ': malformed product')
            continue
        price = product.get('price')
        high = card.get('price_high')
        valid_price = isinstance(price, (int, float)) and not isinstance(price, bool)
        valid_price = valid_price and isinstance(high, (int, float)) and not isinstance(high, bool)
        if not valid_price or price < 5 or price > high:
            invalid.append(card.get('gift', card.get('id', 'card')) + ': price outside $5 to card price_high')
            continue
        if not isinstance(product.get('url'), str) or not product['url'].startswith('https://'):
            invalid.append(card.get('gift', card.get('id', 'card')) + ': url is not https')
        if not isinstance(product.get('title'), str) or not product['title'].strip():
            invalid.append(card.get('gift', card.get('id', 'card')) + ': empty title')
    checks.append(('products have valid title, https url, and price', not invalid,
                   '; '.join(invalid)))

    forbidden = [card for card in cards if isinstance(card, dict) and card.get('product') is not None
                 and card.get('entity', {}).get('type') in {'destination', 'place'}]
    checks.append(('no destination or place products', not forbidden,
                   '' if not forbidden else ', '.join(card.get('gift', card.get('id', 'card')) for card in forbidden)))

    chosen = next(((card, product) for card, product in products if isinstance(product, dict)), None)
    paid = next((event for event in purchase_events if event.get('t') == 'paid'), None)
    if not chosen:
        checks.append(('paid amount and product title match', False, 'no product card to buy'))
    elif not paid:
        checks.append(('paid amount and product title match', False, 'no paid event'))
    else:
        card, product = chosen
        try:
            amount_matches = round(float(paid.get('amount')), 2) == round(float(product.get('price')), 2)
        except (TypeError, ValueError):
            amount_matches = False
        title_matches = paid.get('product_title') == product.get('title')
        detail = []
        if not amount_matches:
            detail.append(f"paid amount {paid.get('amount')} does not match product price {product.get('price')}")
        if not title_matches:
            detail.append('paid product_title does not match')
        checks.append(('paid amount and product title match', amount_matches and title_matches, '; '.join(detail)))
    return checks


def print_checks(checks: list[tuple[str, bool, str]]) -> bool:
    for name, passed, detail in checks:
        print(f"{'PASS' if passed else 'FAIL'} {name}" + (f': {detail}' if detail and not passed else ''))
    return all(passed for _, passed, _ in checks)


def print_products(events: list) -> None:
    cards_event = next((event for event in reversed(events) if event.get('t') == 'cards'), {})
    for card in cards_event.get('cards', []) or []:
        if not isinstance(card, dict) or not isinstance(card.get('product'), dict):
            continue
        product = card['product']
        host = urllib.parse.urlsplit(product.get('url', '')).hostname or ''
        print(f"PRODUCT {card.get('gift', '')} | {product.get('title', '')} | ${product.get('price', '')} | {host}")


def request_events(base: str, path: str, body: dict) -> list:
    headers = dict(HEADERS)
    headers['Origin'] = base
    request = urllib.request.Request(base + path, data=json.dumps(body).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(request, timeout=240) as response:
        return [json.loads(line) for line in response if line.strip()]


def self_test() -> int:
    product_one = {'title': 'Le Carre: The Spy Who Came in from the Cold', 'brand': 'Penguin',
                   'price': 18.50, 'url': 'https://shop.example/books/spy', 'source': 'channel3'}
    product_two = {'title': 'Single Malt Tasting Glass', 'price': 24, 'url': 'https://shop.example/glass',
                   'source': 'channel3'}
    good = [
        {'t': 'run', 'mode': 'live', 'conversation': 'abcdef123456'},
        {'t': 'owner', 'token': 'secret-example-token'},
        {'t': 'call', 'n': 1, 'tool': 'search_products', 'args': {'query': 'Le Carre', 'max_price': 30}},
        {'t': 'result', 'n': 1, 'tool': 'search_products'},
        {'t': 'cards', 'cards': [
            {'id': 't1c1', 'gift': 'A novel', 'price_high': 30, 'entity': {'type': 'book'}, 'product': product_one},
            {'id': 't1c2', 'gift': 'A tasting glass', 'price_high': 40, 'entity': {'type': 'brand'}, 'product': product_two},
            {'id': 't1c3', 'gift': 'A place', 'price_high': 40, 'entity': {'type': 'place'}},
        ]},
    ]
    good_buy = [{'t': 'order', 'amount': '18.50', 'product_title': product_one['title'],
                 'product_url': product_one['url']},
                {'t': 'paid', 'amount': '18.50', 'product_title': product_one['title'],
                 'product_url': product_one['url']}]

    cases = [('good stream', good, good_buy, None)]
    cached = copy.deepcopy(good)
    cached[0]['mode'] = 'cache'
    cases.append(('cached run', cached, good_buy, 'live run'))
    over = copy.deepcopy(good)
    over[4]['cards'][0]['product']['price'] = 31
    cases.append(('product over band', over, good_buy, 'products have valid title, https url, and price'))
    destination = copy.deepcopy(good)
    destination[4]['cards'][2]['product'] = copy.deepcopy(product_two)
    cases.append(('destination product', destination, good_buy, 'no destination or place products'))
    wrong_paid = copy.deepcopy(good_buy)
    wrong_paid[1]['amount'] = '18.51'
    cases.append(('paid amount differs', good, wrong_paid, 'paid amount and product title match'))
    retried = copy.deepcopy(good)
    retried.insert(4, {'t': 'cards', 'cards': [], 'dropped': [{'gift': 'A trip', 'reason': 'over the budget'}]})
    cases.append(('retry after dropped ideas', retried, good_buy, None))

    all_pass = True
    for label, events, buy_events, expected_failure in cases:
        checks = check_events(events, buy_events)
        correct = (all(ok for _, ok, _ in checks) if expected_failure is None
                   else any(name == expected_failure and not ok for name, ok, _ in checks))
        print(f"{'PASS' if correct else 'FAIL'} self-test {label}")
        if not correct:
            print_checks(checks)
        all_pass = all_pass and correct
    print('ALL PASS' if all_pass else 'SELF-TEST FAILED')
    return 0 if all_pass else 1


def main() -> int:
    parser = argparse.ArgumentParser(description='Check live Channel3 product search and purchase events')
    parser.add_argument('base', nargs='?', help='base URL of the Gift Scout host')
    parser.add_argument('--message', default=DEFAULT_MESSAGE, help='message to send to the scout')
    parser.add_argument('--self-test', action='store_true', help='judge built-in example event streams without network')
    args = parser.parse_args()
    if args.self_test:
        if args.base is not None:
            parser.error('--self-test does not take a host')
        return self_test()
    if not args.base:
        parser.error('base URL is required unless --self-test is used')
    base = args.base.rstrip('/')
    try:
        events = request_events(base, '/api/scout', {'message': args.message})
    except Exception as error:
        print(f'FAIL scout request: {type(error).__name__}: {error}')
        print('FAILED')
        return 1

    print_products(events)
    checks = check_events(events)
    live = next((event.get('mode') for event in events if event.get('t') == 'run'), None) == 'live'
    token = next((event.get('token') for event in events if event.get('t') == 'owner'
                  and isinstance(event.get('token'), str)), None)
    cards_event = next((event for event in reversed(events) if event.get('t') == 'cards'), {})
    first_product = next((card for card in (cards_event.get('cards', []) or [])
                          if isinstance(card, dict) and isinstance(card.get('product'), dict)), None)
    buy_events = []
    paid_check_name = 'paid amount and product title match'
    if live and token and first_product:
        try:
            buy_events = request_events(base, '/api/buy', {
                'conversation': next((event.get('conversation') for event in events if event.get('t') == 'run'), ''),
                'card': first_product.get('id'), 'method': 'card', 'owner': token,
            })
            checks = check_events(events, buy_events)
        except Exception as error:
            print(f'FAIL buy request: {type(error).__name__}: {error}')
            checks = [check for check in checks if check[0] != paid_check_name]
            checks.append((paid_check_name, False, 'buy request failed'))
    else:
        checks = [check for check in checks if check[0] != paid_check_name]
        reason = 'no owner token' if not token else 'no product card' if not first_product else 'run was not live'
        checks.append((paid_check_name, False, reason))
    success = print_checks(checks)
    print('ALL PASS' if success else 'FAILED')
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
