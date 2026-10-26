"""Records the three example runs, each with one narrowing turn, from a local `wrangler dev`, so the page still works
with no Qloo key and no AI budget. Writes private/recorded-runs.json and private/qloo-answers.json.

    npx wrangler dev --port 8787 --var RECORDING:1    (in another terminal, with QLOO_API_KEY in .dev.vars)
    python tools/record_samples.py

It empties the local Qloo cache and run cache first, so the runs are live, and adds their Qloo answers to the file.
"""
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://127.0.0.1:8787'
NARROW = 'Make it cheaper, under 30 dollars.'


def d1(sql: str) -> list:
    out = subprocess.run(f'npx wrangler d1 execute gift-scout --local --json --command "{sql}"', cwd=ROOT, shell=True,
                         capture_output=True, text=True, encoding='utf-8')
    if out.returncode:
        sys.exit('wrangler failed: ' + out.stderr[-400:])
    return json.loads(out.stdout)[0]['results']


def scout(message: str, conversation: str | None = None) -> list:
    body = {'message': message, **({'conversation': conversation} if conversation else {})}
    req = urllib.request.Request(BASE + '/api/scout', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=180) as r:
        return [json.loads(line) for line in r if line.strip()]


def trim(body: dict) -> dict:
    """Keeps what the client reads, so the Worker bundle stays small."""
    def entity(e: dict) -> dict:
        props = e.get('properties') or {}
        keep = {k: e[k] for k in ('entity_id', 'name', 'types', 'subtype', 'popularity') if k in e}
        query = e.get('query') or {}
        if query.get('affinity') is not None:
            keep['query'] = {'affinity': query['affinity']}
        # Qloo's split (how much each seed adds) is what the cards show; a sample without it shows no split.
        shares = (query.get('explainability') or {}).get('signal.interests.entities')
        if isinstance(shares, list):
            keep.setdefault('query', {})['explainability'] = {'signal.interests.entities': shares}
        p = {k: props[k] for k in ('short_description', 'address') if props.get(k)}
        if p:
            keep['properties'] = p
        keep['tags'] = [{'name': t.get('name')} for t in (e.get('tags') or [])[:5] if t.get('name')]
        return keep
    res = body.get('results')
    if isinstance(res, list):
        return {'results': [entity(e) for e in res]}
    if isinstance(res, dict) and 'entities' in res:
        return {'results': {'entities': [entity(e) for e in res['entities']]}}
    if isinstance(res, dict) and 'tags' in res:
        return {'results': {'tags': [{k: t.get(k) for k in ('id', 'name', 'type', 'parents')} for t in res['tags']]}}
    return body


def main() -> None:
    if sys.argv[1:] == ['--self-test']:
        answer = {'results': {'entities': [{'entity_id': '00000000-0000-4000-8000-000000000001', 'query': {
            'affinity': 0.5, 'explainability': {'signal.interests.entities': [{'entity_id': '00000000-0000-4000-8000-000000000002', 'score': 1.0}], 'other': 'discard'},
        }}]}}
        kept = trim(answer)['results']['entities'][0]['query']['explainability']
        assert kept == {'signal.interests.entities': [{'entity_id': '00000000-0000-4000-8000-000000000002', 'score': 1.0}]}
        print('trim preserves signal.interests.entities')
        return
    with urllib.request.urlopen(BASE + '/api/examples', timeout=15) as response:
        examples = json.load(response)['examples']
    d1('DELETE FROM qloo_cache')
    d1('DELETE FROM run_cache')
    runs = []
    for prompt in examples:
        first = scout(prompt)
        cid = first[0]['conversation']
        assert first[0]['mode'] == 'live', first[0]
        assert any(e['t'] == 'cards' and e['cards'] for e in first), 'no cards for: ' + prompt
        second = scout(NARROW, cid)
        assert second[0]['mode'] == 'live', second[0]
        row = d1(f"SELECT state, turns FROM conversations WHERE id = 'first-{cid}' OR id = '{cid}' ORDER BY length(id) DESC")
        snap, full = json.loads(row[0]['state']), json.loads(row[1]['state'])
        runs.append({'recorded_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                     'turns': json.loads(row[1]['turns']), 'states': [snap, full]})
        cards = [e for e in first if e['t'] == 'cards'][0]['cards']
        print(f'{prompt[:40]}... {len(cards)} cards, then {len([e for e in second if e["t"] == "cards"][0]["cards"])}')
    # Answers the Worker served from the bundled samples never reach the D1 cache, so the old file is kept and the new
    # answers are laid over it (measured 23 Oct 2026: without this a re-recording kept 1 answer of 20).
    path = ROOT / 'private' / 'qloo-answers.json'
    answers = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    answers.update({r['key']: trim(json.loads(r['body'])) for r in d1('SELECT key, body FROM qloo_cache')})
    (ROOT / 'private').mkdir(exist_ok=True)
    (ROOT / 'private' / 'recorded-runs.json').write_text(json.dumps(runs, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    (ROOT / 'private' / 'qloo-answers.json').write_text(json.dumps(answers, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(runs)} runs, {len(answers)} Qloo answers recorded')


if __name__ == '__main__':
    main()
