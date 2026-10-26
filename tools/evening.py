"""Run tonight's live Gift Scout checks and collect their output.

    python tools/evening.py --dry-run
    python tools/evening.py --main https://example.workers.dev --only 1,4

Use --record to run record_samples.py. That step rewrites private/.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'out' / 'evening'
PW_LOCK = 'A:/Projects/shipatonv2/tools/pw_lock.py'
DEFAULT_MAIN = 'https://gift-scout.midknight-labs.workers.dev'
DEFAULT_PAYPAL = 'https://gift-scout-paypal.midknight-labs.workers.dev'

# The live checks make several requests, and some individual requests allow up
# to four minutes. These limits give each complete tool run time to finish.
TIMEOUTS = {1: 5400, 2: 2700, 3: 1800, 4: 900, 5: 600, 6: 1800, 7: 300}
STEP_NAMES = {
    1: 'demo_check', 2: 'quality_check', 3: 'record_samples', 4: 'e2e',
    5: 'channel3_check', 6: 'phones', 7: 'public_check',
}
MODE_EXPECTATIONS = {
    1: 'round 1 live, rounds 2 and 3 from the run cache, because demo_check repeats the same example',
    2: 'live for each quality prompt, because this step measures live quality and rejects cached or replayed runs',
    3: 'live on the local Worker, because recording clears local caches and captures fresh turns',
    4: 'example 2 from the run cache, filled by step 1, because e2e exercises that saved example',
    5: 'live on the paypal Worker, because Channel3 checks require a live product search and purchase',
    6: 'example 2 from the run cache, filled by step 1, because the phone sweep uses that example',
    7: 'no scout mode, because this step scans the repo before it goes public',
}


def commands(main: str, paypal: str) -> dict[int, list[str]]:
    return {
        1: ['python', 'tools/demo_check.py', main, '3'],
        2: ['python', 'tools/quality_check.py', main, '--json', 'out/evening/measured.json'],
        3: ['python', 'tools/record_samples.py'],
        4: ['python', PW_LOCK, 'run', 'gift-scout', '--', 'node', 'tools/e2e.mjs', main],
        5: ['python', 'tools/channel3_check.py', paypal],
        6: ['python', PW_LOCK, 'run', 'gift-scout', '--', 'node', 'tools/phones.mjs', main],
        7: ['python', 'tools/public_check.py'],
    }


def display_command(command: list[str]) -> str:
    if os.name == 'nt':
        return subprocess.list2cmdline(command)
    import shlex
    return shlex.join(command)


def parse_only(value: str) -> set[int]:
    try:
        numbers = [int(item.strip()) for item in value.split(',')]
    except ValueError as error:
        raise argparse.ArgumentTypeError('use comma-separated step numbers from 1 to 7') from error
    if not numbers or any(number not in range(1, 8) for number in numbers):
        raise argparse.ArgumentTypeError('use comma-separated step numbers from 1 to 7')
    if len(set(numbers)) != len(numbers):
        raise argparse.ArgumentTypeError('step numbers must not be repeated')
    return set(numbers)


def last_line(output: str) -> str:
    lines = output.rstrip().splitlines()
    return lines[-1] if lines else '(no output)'


def local_worker_ready() -> bool:
    try:
        with urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=5) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def run_step(number: int, command: list[str]) -> dict:
    started = time.monotonic()
    timed_out = False
    try:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        )
        try:
            output, _ = process.communicate(timeout=TIMEOUTS[number])
        except subprocess.TimeoutExpired:
            timed_out = True
            if os.name == 'nt':
                subprocess.run(
                    ['taskkill', '/PID', str(process.pid), '/T', '/F'],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            if process.poll() is None:
                process.kill()
            output, _ = process.communicate()
    except OSError as error:
        output = f'Could not start command: {type(error).__name__}: {error}\n'
        return {'status': 'FAIL', 'seconds': time.monotonic() - started, 'last': last_line(output), 'output': output}

    tail = last_line(output)
    if timed_out:
        tail = f'TIMED OUT after {TIMEOUTS[number]}s; {tail}'
    status = 'PASS' if not timed_out and process.returncode == 0 else 'FAIL'
    return {'status': status, 'seconds': time.monotonic() - started, 'last': tail, 'output': output}


def main() -> int:
    parser = argparse.ArgumentParser(description='Run tonight’s Gift Scout live checks and save output under out/evening/.')
    parser.add_argument('--main', default=DEFAULT_MAIN, help='Gift Scout main host')
    parser.add_argument('--paypal', default=DEFAULT_PAYPAL, help='Gift Scout PayPal host')
    parser.add_argument('--only', type=parse_only, help='comma-separated step numbers to run, for example 1,4')
    parser.add_argument('--record', action='store_true', help='run step 3; it rewrites private/')
    parser.add_argument('--dry-run', action='store_true', help='print selected commands without running them')
    args = parser.parse_args()

    selected = args.only if args.only is not None else set(range(1, 8))
    plan = commands(args.main.rstrip('/'), args.paypal.rstrip('/'))
    if args.dry_run:
        for number in sorted(selected):
            if number == 3 and not args.record:
                continue
            print(f'step {number}: {MODE_EXPECTATIONS[number]}')
            print(f'{number}. {display_command(plan[number])}')
        return 0

    OUT.mkdir(parents=True, exist_ok=True)
    results = {}
    for number in sorted(selected):
        if number == 3 and not args.record:
            continue
        print(f'step {number}: {MODE_EXPECTATIONS[number]}')
        if number == 3:
            if 1 not in results or results[1]['status'] != 'PASS':
                results[number] = {'status': 'SKIP', 'seconds': 0.0, 'last': 'requires step 1 to pass'}
                print(f'STEP {number} SKIP | requires step 1 to pass')
                continue
            if not local_worker_ready():
                result = {'status': 'FAIL', 'seconds': 0.0, 'last': 'start wrangler dev first',
                          'output': 'FAIL start wrangler dev first\n'}
                (OUT / f"{STEP_NAMES[number]}.txt").write_text(result['output'], encoding='utf-8')
                results[number] = result
                print(f"STEP {number} {result['status']} | {result['last']}")
                continue

        result = run_step(number, plan[number])
        (OUT / f"{STEP_NAMES[number]}.txt").write_text(result['output'], encoding='utf-8')
        results[number] = result
        print(f"STEP {number} {result['status']} | {result['last']}")

    print('\nStep | Result | Seconds | Last output line')
    print('-----|--------|---------|----------------')
    for number in sorted(results):
        result = results[number]
        print(f"{number} | {result['status']} | {result['seconds']:.1f} | {result['last']}")
    return 1 if any(result['status'] == 'FAIL' for result in results.values()) else 0


if __name__ == '__main__':
    raise SystemExit(main())
