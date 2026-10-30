"""Regras da dama brasileira (tabuleiro 8x8).

- Peças comuns andam 1 casa na diagonal para frente e capturam para frente e para trás.
- Damas (reis) são "voadoras": andam e capturam a qualquer distância na diagonal.
- Captura é obrigatória e vale a lei da maioria: deve-se escolher a sequência
  que captura o maior número de peças.
- Peças capturadas só saem do tabuleiro ao fim do lance (não podem ser puladas duas vezes).
- A peça só é promovida se terminar o lance na última fileira.
- Perde quem não tiver lances válidos (sem peças ou bloqueado).
- Empate: 20 lances seguidos (de cada lado) apenas com damas e sem capturas.
"""

import copy

SIZE = 8
DIRS = [(-1, -1), (-1, 1), (1, -1), (1, 1)]
QUIET_KING_PLY_LIMIT = 40  # 20 lances de cada jogador


def other(color):
    return 'b' if color == 'w' else 'w'


def inside(r, c):
    return 0 <= r < SIZE and 0 <= c < SIZE


def initial_board():
    board = [[None] * SIZE for _ in range(SIZE)]
    for r in range(SIZE):
        for c in range(SIZE):
            if (r + c) % 2 == 1:
                if r < 3:
                    board[r][c] = {'color': 'b', 'king': False}
                elif r > 4:
                    board[r][c] = {'color': 'w', 'king': False}
    return board


def new_game():
    return {
        'board': initial_board(),
        'turn': 'w',            # brancas começam
        'result': None,         # {'winner': 'w'|'b'|None, 'reason': str}
        'lastMove': None,
        'plies': 0,
        'quietKingPlies': 0,
    }


def _captures_from(board, r, c):
    """Todas as sequências de captura completas a partir da peça em (r, c)."""
    piece = board[r][c]
    b = [row[:] for row in board]
    b[r][c] = None  # a peça em movimento não bloqueia a si mesma
    results = []

    def dfs(cr, cc, path, caps):
        extended = False
        capset = set(caps)
        for dr, dc in DIRS:
            if piece['king']:
                rr, c2 = cr + dr, cc + dc
                while inside(rr, c2) and b[rr][c2] is None:
                    rr += dr
                    c2 += dc
                if not inside(rr, c2):
                    continue
                target = b[rr][c2]
                if target['color'] == piece['color'] or (rr, c2) in capset:
                    continue
                lr, lc = rr + dr, c2 + dc
                while inside(lr, lc) and b[lr][lc] is None:
                    extended = True
                    dfs(lr, lc, path + [(lr, lc)], caps + [(rr, c2)])
                    lr += dr
                    lc += dc
            else:
                rr, c2 = cr + dr, cc + dc
                lr, lc = cr + 2 * dr, cc + 2 * dc
                if (inside(lr, lc) and b[rr][c2] is not None
                        and b[rr][c2]['color'] != piece['color']
                        and (rr, c2) not in capset
                        and b[lr][lc] is None):
                    extended = True
                    dfs(lr, lc, path + [(lr, lc)], caps + [(rr, c2)])
        if not extended and caps:
            results.append({
                'path': [list(p) for p in path],
                'captured': [list(p) for p in caps],
            })

    dfs(r, c, [(r, c)], [])
    return results


def legal_moves(board, color, mandatory_capture=True):
    captures = []
    for r in range(SIZE):
        for c in range(SIZE):
            p = board[r][c]
            if p and p['color'] == color:
                captures.extend(_captures_from(board, r, c))

    seen, unique_captures = set(), []
    if captures:
        best = max(len(m['captured']) for m in captures)
        for m in captures:
            # Se for captura obrigatória, filtra pela lei da maioria
            if mandatory_capture and len(m['captured']) != best:
                continue
            key = str(m['path'])
            if key not in seen:
                seen.add(key)
                unique_captures.append(m)

    if mandatory_capture and unique_captures:
        return unique_captures

    moves = []
    forward = -1 if color == 'w' else 1
    for r in range(SIZE):
        for c in range(SIZE):
            p = board[r][c]
            if not p or p['color'] != color:
                continue
            if p['king']:
                for dr, dc in DIRS:
                    rr, c2 = r + dr, c + dc
                    while inside(rr, c2) and board[rr][c2] is None:
                        moves.append({'path': [[r, c], [rr, c2]], 'captured': []})
                        rr += dr
                        c2 += dc
            else:
                for dc in (-1, 1):
                    rr, c2 = r + forward, c + dc
                    if inside(rr, c2) and board[rr][c2] is None:
                        moves.append({'path': [[r, c], [rr, c2]], 'captured': []})
    return unique_captures + moves


def apply_move(game, move, mandatory_capture=True):
    """Aplica um lance (já validado) e devolve o novo estado do jogo."""
    g = copy.deepcopy(game)
    board = g['board']
    (sr, sc), (er, ec) = move['path'][0], move['path'][-1]
    piece = board[sr][sc]
    was_king = piece['king']
    board[sr][sc] = None
    for r, c in move['captured']:
        board[r][c] = None

    promoted = False
    if not piece['king'] and ((piece['color'] == 'w' and er == 0) or
                              (piece['color'] == 'b' and er == SIZE - 1)):
        piece['king'] = True
        promoted = True
    board[er][ec] = piece

    mover = g['turn']
    g['plies'] += 1
    g['lastMove'] = {
        'path': move['path'],
        'captured': move['captured'],
        'color': mover,
        'promoted': promoted,
    }

    if was_king and not move['captured']:
        g['quietKingPlies'] += 1
    else:
        g['quietKingPlies'] = 0

    g['turn'] = other(mover)
    if not legal_moves(board, g['turn'], mandatory_capture=mandatory_capture):
        g['result'] = {'winner': mover, 'reason': 'no_moves'}
    elif g['quietKingPlies'] >= QUIET_KING_PLY_LIMIT:
        g['result'] = {'winner': None, 'reason': 'draw_rule'}
    return g
