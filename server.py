"""Servidor do Dama Online — apenas biblioteca padrão do Python (3.8+).

Uso:  python server.py            (porta 8000)
      PORT=3000 python server.py
"""

import json
import mimetypes
import os
import queue
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import checkers

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')
ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
ROOM_TTL = 6 * 3600
MAX_CHAT = 100

rooms = {}
rooms_lock = threading.Lock()


def clean_name(name):
    name = str(name or '').strip()[:20]
    return name or 'Anônimo'


class Room:
    def __init__(self, room_id, mandatory_capture=True):
        self.id = room_id
        self.mandatory_capture = bool(mandatory_capture)
        self.lock = threading.RLock()
        self.game = checkers.new_game()
        self.seats = {'w': None, 'b': None}  # {'token':..., 'name':...}
        self.spectators = {}                 # token -> name
        self.subscribers = []                # [(token, queue)]
        self.chat = []
        self.rematch = set()
        self.draw_offer = None
        self.wins = {}                       # name -> vitórias (placar da sala)
        self.touch()

    def touch(self):
        self.last_activity = time.time()

    # ----- identidade -----
    def color_of(self, token):
        for color, seat in self.seats.items():
            if seat and seat['token'] == token:
                return color
        return None

    def name_of(self, token):
        color = self.color_of(token)
        if color:
            return self.seats[color]['name']
        return self.spectators.get(token)

    def online(self, token):
        return any(t == token for t, _ in self.subscribers)

    # ----- estado -----
    def snapshot(self, token):
        players = {}
        for color, seat in self.seats.items():
            players[color] = None if not seat else {
                'name': seat['name'],
                'online': self.online(seat['token']),
                'wins': self.wins.get(seat['name'], 0),
            }
        g = self.game
        ready = all(self.seats.values())
        moves = checkers.legal_moves(g['board'], g['turn'], mandatory_capture=self.mandatory_capture) if ready and not g['result'] else []
        return {
            'room': self.id,
            'mandatoryCapture': self.mandatory_capture,
            'you': self.color_of(token),
            'players': players,
            'spectators': len([t for t in self.spectators if self.online(t)]),
            'game': g,
            'moves': moves,
            'ready': ready,
            'chat': self.chat[-MAX_CHAT:],
            'rematch': sorted(self.rematch),
            'drawOffer': self.draw_offer,
        }

    def broadcast(self):
        for token, q in list(self.subscribers):
            q.put(json.dumps(self.snapshot(token)))

    def system_msg(self, text):
        self.chat.append({'system': True, 'text': text, 't': int(time.time() * 1000)})
        self.chat = self.chat[-MAX_CHAT:]

    def finish(self, result):
        self.game['result'] = result
        self.draw_offer = None
        winner = result.get('winner')
        if winner and self.seats[winner]:
            name = self.seats[winner]['name']
            self.wins[name] = self.wins.get(name, 0) + 1

    # ----- ações -----
    def join(self, token, name):
        name = clean_name(name)
        if token and self.color_of(token):
            color = self.color_of(token)
            self.seats[color]['name'] = name
            return token, color
        token = token or secrets.token_urlsafe(16)
        for color in ('w', 'b'):
            if self.seats[color] is None:
                self.seats[color] = {'token': token, 'name': name}
                self.spectators.pop(token, None)
                self.system_msg(f'{name} entrou com as {"brancas" if color == "w" else "pretas"}.')
                return token, color
        if token not in self.spectators:
            self.system_msg(f'{name} está assistindo.')
        self.spectators[token] = name
        return token, None

    def action(self, token, data):
        kind = data.get('type')
        color = self.color_of(token)
        g = self.game

        if kind == 'chat':
            text = str(data.get('text', '')).strip()[:300]
            name = self.name_of(token)
            if not text or not name:
                return 'Mensagem inválida.'
            self.chat.append({'name': name, 'color': color, 'text': text,
                              't': int(time.time() * 1000)})
            self.chat = self.chat[-MAX_CHAT:]
            return None

        if not color:
            return 'Você está assistindo esta partida.'

        if kind == 'move':
            if g['result']:
                return 'A partida terminou.'
            if not all(self.seats.values()):
                return 'Aguardando oponente.'
            if g['turn'] != color:
                return 'Não é sua vez.'
            path = data.get('path')
            for m in checkers.legal_moves(g['board'], color, mandatory_capture=self.mandatory_capture):
                if m['path'] == path:
                    self.game = checkers.apply_move(g, m, mandatory_capture=self.mandatory_capture)
                    self.draw_offer = None
                    if self.game['result']:
                        res = self.game['result']
                        self.game['result'] = None
                        self.finish(res)
                    return None
            return 'Lance inválido.'

        if kind == 'resign':
            if g['result'] or not all(self.seats.values()):
                return 'Não há partida em andamento.'
            self.finish({'winner': checkers.other(color), 'reason': 'resign'})
            self.system_msg(f'{self.seats[color]["name"]} desistiu.')
            return None

        if kind == 'draw_offer':
            if g['result'] or not all(self.seats.values()):
                return 'Não há partida em andamento.'
            self.draw_offer = color
            self.system_msg(f'{self.seats[color]["name"]} propôs empate.')
            return None

        if kind == 'draw_reply':
            if self.draw_offer != checkers.other(color) or g['result']:
                return 'Não há proposta de empate.'
            if data.get('accept'):
                self.finish({'winner': None, 'reason': 'agreement'})
                self.system_msg('Empate aceito.')
            else:
                self.draw_offer = None
                self.system_msg(f'{self.seats[color]["name"]} recusou o empate.')
            return None

        if kind == 'rematch':
            if not g['result']:
                return 'A partida ainda não terminou.'
            self.rematch.add(color)
            if len(self.rematch) == 2:
                # nova partida trocando as cores
                self.seats['w'], self.seats['b'] = self.seats['b'], self.seats['w']
                self.game = checkers.new_game()
                self.rematch = set()
                self.draw_offer = None
                self.system_msg('Revanche! As cores foram trocadas.')
            return None

        return 'Ação desconhecida.'


def get_room(room_id):
    with rooms_lock:
        return rooms.get(str(room_id).upper())


def create_room(mandatory_capture=True):
    with rooms_lock:
        while True:
            rid = ''.join(secrets.choice(ROOM_ALPHABET) for _ in range(5))
            if rid not in rooms:
                rooms[rid] = Room(rid, mandatory_capture=mandatory_capture)
                return rid


def janitor():
    while True:
        time.sleep(600)
        now = time.time()
        with rooms_lock:
            for rid in list(rooms):
                r = rooms[rid]
                if not r.subscribers and now - r.last_activity > ROOM_TTL:
                    del rooms[rid]


class Handler(BaseHTTPRequestHandler):
    server_version = 'DamaOnline/1.0'

    def log_message(self, fmt, *args):
        if '/events' not in self.path:
            super().log_message(fmt, *args)

    # ----- helpers -----
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > 10000:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, UnicodeDecodeError):
            return {}

    def send_file(self, rel):
        path = os.path.normpath(os.path.join(PUBLIC, rel))
        if not path.startswith(PUBLIC) or not os.path.isfile(path):
            self.send_error(404)
            return
        with open(path, 'rb') as f:
            body = f.read()
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype.endswith('javascript'):
            ctype += '; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    # ----- rotas -----
    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split('/') if p]

        if len(parts) == 4 and parts[:2] == ['api', 'rooms'] and parts[3] == 'events':
            return self.stream(parts[2], parse_qs(url.query).get('token', [''])[0])
        if not parts or parts[0] == 'sala':
            return self.send_file('index.html')
        return self.send_file('/'.join(parts))

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split('/') if p]
        data = self.read_json()

        if parts == ['api', 'rooms']:
            mandatory = data.get('mandatoryCapture', True)
            return self.send_json({'room': create_room(mandatory_capture=mandatory)})

        if len(parts) == 4 and parts[:2] == ['api', 'rooms']:
            room = get_room(parts[2])
            if not room:
                return self.send_json({'error': 'Sala não encontrada.'}, 404)
            with room.lock:
                room.touch()
                if parts[3] == 'join':
                    token, color = room.join(data.get('token'), data.get('name'))
                    room.broadcast()
                    return self.send_json({'token': token, 'color': color})
                if parts[3] == 'action':
                    err = room.action(data.get('token'), data)
                    if err:
                        return self.send_json({'error': err}, 400)
                    room.broadcast()
                    return self.send_json({'ok': True})
        self.send_error(404)

    def stream(self, room_id, token):
        room = get_room(room_id)
        if not room:
            return self.send_json({'error': 'Sala não encontrada.'}, 404)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        q = queue.Queue()
        with room.lock:
            room.subscribers.append((token, q))
            room.broadcast()  # avisa todos que alguém ficou online
        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f'data: {msg}\n\n'.encode())
                except queue.Empty:
                    self.wfile.write(b': ping\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with room.lock:
                room.subscribers = [s for s in room.subscribers if s[1] is not q]
                room.touch()
                room.broadcast()


def main():
    port = int(os.environ.get('PORT', 8000))
    threading.Thread(target=janitor, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    server.daemon_threads = True
    print(f'Dama Online rodando em http://localhost:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
