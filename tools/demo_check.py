"""Runs the three example messages, each with one narrowing turn, and says PASS or FAIL for each.

    python tools/demo_check.py                         the local `wrangler dev` on port 8787
    python tools/demo_check.py https://<host> 3        three rounds against a deployed Worker

A run passes when it has no error, at least five Qloo calls, at least five cards over at least three kinds, every card
with an affinity from a Qloo call, and a narrowing turn that shows cards with no error. Local runs empty the local run
cache first so every run is live; a deployed Worker may answer a repeat from its cache, and the mode is printed.
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 1
LOCAL = BASE.startswith('http://127.0.0.1') or BASE.startswith('http://localhost')
NARROW = 'Make it cheaper, under 30 dollars.'
HEADERS = {'Content-Type': 'application/json', 'User-Agent': 'gift-scout-demo-check/1.0'}


def scout(message: str, conversation: str | None = None) -> list:
    body = {'message': message, **({'conversation': conversation} if conversation else {})}
    req = urllib.request.Request(BASE + '/api/scout', data=json.dumps(body).encode(), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=240) as r:
        return [json.loads(line) for line in r if line.strip()]


def judge(first: list, second: list) -> list[str]:
    faults = []
    calls = [e for e in first if e['t'] == 'call']
    cards = next((e['cards'] for e in first if e['t'] == 'cards' and e['cards']), [])
    if any(e['t'] == 'error' for e in first):
        faults.append('error: ' + next(e['text'] for e in first if e['t'] == 'error'))
    if len(calls) < 5:
        faults.append(f'{len(calls)} Qloo calls')
    if len(cards) < 5:
        faults.append(f'{len(cards)} cards')
    if len({c['entity']['type'] for c in cards}) < 3:
        faults.append('fewer than three kinds')
    if any(c['entity'].get('affinity') is None or not c['from_call'] for c in cards):
        faults.append('a card with no affinity')
    if any(e['t'] == 'error' for e in second) or not any(e['t'] == 'cards' and e['cards'] for e in second):
        faults.append('the narrowing turn failed')
    return faults


def main() -> None:
    examples = json.load(urllib.request.urlopen(urllib.request.Request(BASE + '/api/examples', headers=HEADERS)))['examples']
    failed = 0
    for rnd in range(1, ROUNDS + 1):
        for i, prompt in enumerate(examples, 1):
            if LOCAL:
                subprocess.run('npx wrangler d1 execute gift-scout --local --command "DELETE FROM run_cache"', cwd=ROOT,
                               shell=True, capture_output=True)
            t0 = time.time()
            first = scout(prompt)
            mid = time.time()
            second = scout(NARROW, first[0]['conversation'])
            faults = judge(first, second)
            failed += bool(faults)
            usage = next((e for e in first if e['t'] == 'usage'), {})
            cards = next((e['cards'] for e in first if e['t'] == 'cards' and e['cards']), [])
            kinds = sorted({c['entity']['type'] for c in cards})
            print(f"round {rnd} run {i}: {'FAIL ' + '; '.join(faults) if faults else 'PASS'} | mode {first[0]['mode']} | "
                  f"{len([e for e in first if e['t'] == 'call'])} calls, {len(cards)} cards {kinds} | "
                  f"{usage.get('neurons', 0)} neurons | {mid - t0:.1f}s + {time.time() - mid:.1f}s")
    print('ALL PASS' if not failed else f'{failed} FAILED')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
