"""Check first-message gift suggestions against simple quality rules.

    python tools/quality_check.py
    python tools/quality_check.py https://example.workers.dev --limit 3
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import re
import sys
import time
import urllib.request


MESSAGES = [
    "My mum. She loves Agatha Christie and gardening. Under 50 dollars.",
    "A coworker who loves Taylor Swift and baking.",
    "My brother. Star Wars and craft beer. He lives in Chicago.",
    "My grandfather, 80. Jazz and fishing.",
    "A teenager who plays Minecraft and loves anime.",
    "My partner. She loves Frida Kahlo and Mexican food. We live in Montreal. Anniversary.",
    "A friend who loves hiking and the podcast Radiolab.",
    "My boss. Golf and Ernest Hemingway. Something classy, under 100 dollars.",
    "My niece, 10. Harry Potter and horses.",
    "Someone who loves Zzqxv Blorpt.",
]
HEADERS = {'Content-Type': 'application/json', 'User-Agent': 'gift-scout-demo-check/1.0'}
QLOO_TOOLS = {'search_entities', 'search_tags', 'taste_insights'}


def all_cards_traced(events: list) -> bool:
    results = [event for event in events
               if event.get('t') == 'result' and event.get('tool') in QLOO_TOOLS]
    cards = [card for event in events if event.get('t') == 'cards'
             for card in (event.get('cards') or [])]

    def traced(card: dict) -> bool:
        entity_id = (card.get('entity') or {}).get('id')
        return entity_id is not None and any(
            result.get('n') == card.get('from_call')
            and any((top or {}).get('id') == entity_id for top in (result.get('top') or []))
            for result in results
        )

    return all(traced(card) for card in cards)


def mode_failure_reason(mode: str) -> str | None:
    return None if mode == 'live' else f'not live: {mode}'


def budget_in(text: str):
    # Copy of budgetIn in src/agent/text.ts.
    match = re.search(r'\b(?:under|below|less than|at most|up to|max(?:imum)?|no more than)\s*(?:US\s*)?\$?\s*(\d{1,5})', text, re.I)
    return int(match.group(1)) if match else None


def measure(runs: list) -> dict:
    live = []
    for item in runs:
        events = item.get('events', [])
        run_event = next((event for event in events if event.get('t') == 'run'), {})
        if run_event.get('mode') == 'live':
            live.append((item.get('message', ''), events))

    cards = []
    budget_cards = []
    dropped = Counter()
    kinds_per_run = []
    affinities = []
    traced = 0
    qloo_calls = []
    neurons = []
    for message, events in live:
        calls = [event for event in events if event.get('t') == 'call']
        results = {event.get('n'): event for event in events
                   if event.get('t') == 'result' and event.get('tool') in QLOO_TOOLS}
        card_events = [event for event in events if event.get('t') == 'cards']
        run_cards = [card for event in card_events for card in (event.get('cards') or [])]
        cards.extend(run_cards)
        for event in card_events:
            dropped.update(item.get('reason', 'unknown') for item in (event.get('dropped') or []))

        budget = budget_in(message)
        if budget is not None:
            budget_cards.extend((card, budget) for card in run_cards)

        for card in run_cards:
            result = results.get(card.get('from_call'))
            entity_id = (card.get('entity') or {}).get('id')
            if result and any((top or {}).get('id') == entity_id for top in (result.get('top') or [])):
                traced += 1
            affinity = (card.get('entity') or {}).get('affinity')
            if isinstance(affinity, (int, float)) and not isinstance(affinity, bool):
                affinities.append(affinity)

        kinds_per_run.append(len({(card.get('entity') or {}).get('type', 'unknown') for card in run_cards}))
        qloo_calls.append(sum(call.get('tool') in QLOO_TOOLS for call in calls))
        usage = next((event for event in events if event.get('t') == 'usage'), {})
        neurons.append(usage.get('neurons', 0) or 0)

    card_count = len(cards)
    budget_count = len(budget_cards)
    seeded = sum('seed_shares' in card and card.get('seed_shares') is not None for card in cards)
    products = sum('product' in card and card.get('product') is not None for card in cards)
    return {
        'run_count': len(live),
        'cards': card_count,
        'traced_cards': traced,
        'budget_cards': budget_count,
        'over_budget': sum((card.get('price_low') or 0) > budget for card, budget in budget_cards),
        'dropped_by_reason': dict(sorted(dropped.items())),
        'dropped_count': sum(dropped.values()),
        'mean_kinds': sum(kinds_per_run) / len(kinds_per_run) if kinds_per_run else None,
        'lowest_kinds': min(kinds_per_run) if kinds_per_run else None,
        'affinity_count': len(affinities),
        'mean_affinity': sum(affinities) / len(affinities) if affinities else None,
        'seed_shares_count': seeded if seeded else None,
        'product_count': products if products else None,
        'mean_qloo_calls': sum(qloo_calls) / len(qloo_calls) if qloo_calls else None,
        'mean_neurons': sum(neurons) / len(neurons) if neurons else None,
    }


def percent(part: int, whole: int) -> str:
    return f'{100 * part / whole:.1f}%' if whole else '0.0%'


def measured_lines(data: dict) -> list:
    run_count = data['run_count']
    affinity = f"{data['mean_affinity']:.3f}" if data['mean_affinity'] is not None else 'n/a'
    kinds = f"mean {data['mean_kinds']:.2f}, lowest {data['lowest_kinds']}" if run_count else 'n/a'
    qloo = f"{data['mean_qloo_calls']:.2f}" if run_count else 'n/a'
    neuron_mean = f"{data['mean_neurons']:.2f}" if run_count else 'n/a'
    lines = [
        f'Measured ({run_count} live runs)',
        f"Cards traced to Qloo: {data['traced_cards']} of {data['cards']} cards ({percent(data['traced_cards'], data['cards'])})",
        f"Cards over budget: {data['over_budget']} of {data['budget_cards']} cards over budget",
        f"Dropped ideas: {data['dropped_count']}" + ((' (' + '; '.join(f'{reason}: {count}' for reason, count in data['dropped_by_reason'].items()) + ')') if data['dropped_by_reason'] else ''),
        f'Kinds per run: {kinds}',
        f'Mean Qloo affinity: {affinity}',
    ]
    if data['seed_shares_count'] is not None:
        lines.append(f"Cards with seed shares: {data['seed_shares_count']} of {data['cards']} cards ({percent(data['seed_shares_count'], data['cards'])})")
    if data['product_count'] is not None:
        lines.append(f"Cards with a product: {data['product_count']} of {data['cards']} cards ({percent(data['product_count'], data['cards'])})")
    lines.extend([f'Qloo calls per run: mean {qloo}', f'Neurons per run: mean {neuron_mean}'])
    return lines


def self_test() -> None:
    def card(entity_id, kind, low, affinity, from_call, **extra):
        return {'entity': {'id': entity_id, 'type': kind, 'affinity': affinity},
                'price_low': low, 'from_call': from_call, **extra}

    runs = [
        {'message': 'Under 50 dollars', 'events': [
            {'t': 'run', 'mode': 'live'},
            {'t': 'call', 'n': 1, 'tool': 'taste_insights'},
            {'t': 'call', 'n': 2, 'tool': 'search_entities'},
            {'t': 'result', 'n': 1, 'tool': 'taste_insights', 'top': [{'id': 'a'}, {'id': 'b'}]},
            {'t': 'cards', 'cards': [card('a', 'book', 20, .8, 1, seed_shares=['mum']),
                                     card('b', 'place', 60, .6, 1, product={'price': 60})],
             'dropped': [{'gift': 'x', 'reason': 'over the budget'}]},
            {'t': 'usage', 'neurons': 10},
        ]},
        {'message': 'No budget here', 'events': [
            {'t': 'run', 'mode': 'live'},
            {'t': 'call', 'n': 3, 'tool': 'search_tags'},
            {'t': 'call', 'n': 4, 'tool': 'taste_insights'},
            {'t': 'call', 'n': 5, 'tool': 'other'},
            {'t': 'result', 'n': 3, 'tool': 'search_tags', 'top': [{'id': 'c'}]},
            {'t': 'result', 'n': 4, 'tool': 'taste_insights', 'top': [{'id': 'c'}]},
            {'t': 'cards', 'cards': [card('c', 'book', 10, .4, 3), card('d', 'book', 15, None, 4)],
             'dropped': [{'gift': 'y', 'reason': 'over the budget'}, {'gift': 'z', 'reason': 'no Qloo result behind it'}]},
            {'t': 'usage', 'neurons': 20},
        ]},
        {'message': 'Under 10 dollars', 'events': [
            {'t': 'run', 'mode': 'cache'},
            {'t': 'cards', 'cards': [card('cached', 'movie', 100, 1, 1)]},
        ]},
    ]
    expected = {
        'run_count': 2, 'cards': 4, 'traced_cards': 3, 'budget_cards': 2, 'over_budget': 1,
        'dropped_by_reason': {'no Qloo result behind it': 1, 'over the budget': 2}, 'dropped_count': 3,
        'mean_kinds': 1.5, 'lowest_kinds': 1, 'affinity_count': 3,
        'mean_affinity': (0.8 + 0.6 + 0.4) / 3, 'seed_shares_count': 1, 'product_count': 1,
        'mean_qloo_calls': 2.0, 'mean_neurons': 15.0,
    }
    result = measure(runs)
    expected_lines = [
        'Measured (2 live runs)',
        'Cards traced to Qloo: 3 of 4 cards (75.0%)',
        'Cards over budget: 1 of 2 cards over budget',
        'Dropped ideas: 3 (no Qloo result behind it: 1; over the budget: 2)',
        'Kinds per run: mean 1.50, lowest 1',
        'Mean Qloo affinity: 0.600',
        'Cards with seed shares: 1 of 4 cards (25.0%)',
        'Cards with a product: 1 of 4 cards (25.0%)',
        'Qloo calls per run: mean 2.00',
        'Neurons per run: mean 15.00',
    ]
    if result != expected or measured_lines(result) != expected_lines:
        print('Self-test FAIL')
        print('\n'.join(measured_lines(result)))
        sys.exit(1)
    untraced = [{'t': 'cards', 'cards': [card('missing', 'book', 10, .5, 99)]}]
    if not all_cards_traced(runs[0]['events']) or all_cards_traced(untraced):
        print('Self-test FAIL: Qloo provenance')
        sys.exit(1)
    for mode in ('cache', 'replay'):
        if mode_failure_reason(mode) != f'not live: {mode}' or mode_failure_reason('live') is not None:
            print('Self-test FAIL: non-live mode')
            sys.exit(1)
    print('Self-test PASS')


def scout(base: str, message: str) -> list:
    body = {'message': message}
    req = urllib.request.Request(base + '/api/scout', data=json.dumps(body).encode(), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=240) as response:
        return [json.loads(line) for line in response if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description='Check first message gift suggestions')
    parser.add_argument('base', nargs='?', default='http://127.0.0.1:8787')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--json', dest='json_path')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not 1 <= args.limit <= 10:
        parser.error('--limit must be from 1 to 10')
    base = args.base.rstrip('/')

    print('Message Result Reasons Mode Calls Cards Kinds Neurons Seconds')
    passed = 0
    total_neurons = 0
    attempted = 0
    runs = []
    for number, message in enumerate(MESSAGES[:args.limit], 1):
        attempted = number
        mode = 'unknown'
        started = time.time()
        try:
            events = scout(base, message)
            runs.append({'message': message, 'events': events})
            seconds = time.time() - started
            run = next((event for event in events if event.get('t') == 'run'), {})
            mode = run.get('mode', 'unknown')
            calls = sum(event.get('t') == 'call' for event in events)
            cards_event = next((event for event in events if event.get('t') == 'cards'), {})
            cards = cards_event.get('cards', []) or []
            kinds = sorted({card.get('entity', {}).get('type', 'unknown') for card in cards})
            usage = next((event for event in events if event.get('t') == 'usage'), {})
            neurons = usage.get('neurons', 0) or 0
            total_neurons += neurons
            errors = [event.get('text', 'unknown error') for event in events if event.get('t') == 'error']
            say_lines = [event.get('text', '') for event in events if event.get('t') == 'say']
            reasons = []
            mode_reason = mode_failure_reason(mode)
            if mode_reason:
                reasons.append(mode_reason)
            if number < 10:
                if errors:
                    reasons.append('error ' + ', '.join(errors))
                if len(cards) < 5:
                    reasons.append('fewer than five cards')
                if len(kinds) < 3:
                    reasons.append('fewer than three kinds')
                if any(card.get('entity', {}).get('affinity') is None for card in cards):
                    reasons.append('card without affinity')
                if not all_cards_traced(events):
                    reasons.append('card without Qloo provenance')
            else:
                if cards:
                    reasons.append('cards were returned')
                if not any('does not know' in line.lower() for line in say_lines):
                    reasons.append('no say line says does not know')
            result = 'PASS' if not reasons else 'FAIL'
            passed += result == 'PASS'
            reason_text = ', '.join(reasons) if reasons else 'none'
            kind_text = ','.join(kinds) if kinds else 'none'
            print(f'{number} {result} {reason_text} {mode} {calls} {len(cards)} {kind_text} {neurons} {seconds:.1f}')
        except Exception as error:
            seconds = time.time() - started
            print(f'{number} FAIL request error {type(error).__name__} 0 0 none 0 {seconds:.1f}')
        if mode in ('replay', 'off'):
            print(f'Stopping early because mode is {mode} and later runs would not be live')
            break
    measured = measure(runs)
    print('\n'.join(measured_lines(measured)))
    if args.json_path:
        report = {
            'measured_at_utc': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
            'base_url': base,
            **measured,
        }
        with open(args.json_path, 'w', encoding='utf-8') as output:
            json.dump(report, output, indent=2, sort_keys=True)
            output.write('\n')
    print(f'{passed} of {attempted} PASS')
    print(f'Total neurons {total_neurons}')
    sys.exit(0 if passed == attempted else 1)


if __name__ == '__main__':
    main()
