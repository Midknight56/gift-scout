"""Plain checks for the counts in tools/quality_check.py. Run: python tools/test_quality_check.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quality_check import measure, measured_lines  # noqa: E402


def card(product=False):
    data = {'entity': {'id': 'e', 'type': 'book', 'affinity': 0.5}, 'price_low': 10, 'from_call': 1}
    if product:
        data['product'] = {'price': 12}
    return data


def run(mode, cards):
    return {'message': 'x', 'events': [{'t': 'run', 'mode': mode}, {'t': 'cards', 'cards': cards}]}


def check(name, ok):
    if not ok:
        print(f'FAIL {name}')
        sys.exit(1)


empty = measure([])
check('zero live runs gives zero products', empty['product_cards'] == 0 and empty['product_share'] == '0 of 0')
check('every mode is counted, zero included', empty['modes'] == {'live': 0, 'cache': 0, 'replay': 0, 'off': 0, 'other': 0})
check('the report shows zero products with its denominator', 'Cards with a product: 0 of 0 cards' in '\n'.join(measured_lines(empty)))

mixed = measure([run('live', [card(True), card(), card()]), run('cache', [card(True), card(True)])])
check('live products', mixed['product_cards'] == 1 and mixed['product_share'] == '1 of 3')
check('products by mode', mixed['by_mode_products'] == {'live': '1 of 3', 'cache': '2 of 2', 'replay': '0 of 0'})
check('modes', mixed['modes'] == {'live': 1, 'cache': 1, 'replay': 0, 'off': 0, 'other': 0})
lines = '\n'.join(measured_lines(mixed))
check('the report names live, cached and recorded runs apart', 'Runs by mode: 1 live, 1 cache, 0 replay, 0 off, 0 other' in lines)
check('the report gives products per mode with denominators', 'Cards with a product by mode: live 1 of 3, cache 2 of 2, replay 0 of 0' in lines)
check('no bare percent for products', 'Cards with a product: 1 of 3 cards' in lines and 'product: 1 of 3 cards (' not in lines)
print('ALL CASES OK')
