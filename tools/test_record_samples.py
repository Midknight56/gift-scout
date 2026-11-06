import importlib.util
import json
import pathlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HERE = pathlib.Path(__file__).resolve().parent
TOKEN = 'made-up-owner-token'
seen = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        seen.append(body)
        if body.get('conversation'):
            events = ([{'t': 'run', 'mode': 'live'}] if body.get('owner') == TOKEN
                      else [{'t': 'error', 'text': 'owner token missing'}])
        else:
            events = [{'t': 'run', 'mode': 'live', 'conversation': 'conversation123'},
                      {'t': 'owner', 'token': TOKEN}]
            events.extend({'t': 'call'} for _ in range(5))
            events.append({'t': 'cards', 'cards': [
                {'entity': {'type': kind, 'affinity': 0.8}, 'from_call': 1}
                for kind in ('book', 'brand', 'place', 'artist', 'movie')
            ]})
        payload = ''.join(json.dumps(event) + '\n' for event in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        for name in ('record_samples', 'demo_check'):
            module = load(name)
            module.BASE = base
            if name == 'demo_check':
                module.BASE = base
            seen.clear()
            first = module.scout('First message')
            token = module.owner_of(first)
            second = module.scout('Refine', first[0]['conversation'], token)
            assert seen[1].get('owner') == TOKEN, f'{name}: refinement did not send owner token'
            assert second[0]['t'] == 'run'

            errors = module.scout('Refine without token', first[0]['conversation'])
            assert errors == [{'t': 'error', 'text': 'owner token missing'}], errors
            if name == 'record_samples':
                try:
                    module.check_stream(errors)
                except RuntimeError as error:
                    assert str(error) == 'the Worker said: owner token missing'
                else:
                    raise AssertionError('record_samples did not raise the Worker error')
            else:
                faults = module.judge(first, errors)
                assert any('owner token missing' in fault for fault in faults), faults
            print(f'ok  {name} sends owner token and reports Worker errors')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
