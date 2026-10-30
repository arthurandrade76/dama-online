(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (r, c) => r + ',' + c;
  const samePos = (a, b) => a[0] === b[0] && a[1] === b[1];
  const isPrefix = (path, pre) => pre.length <= path.length && pre.every((p, i) => samePos(p, path[i]));
  const COLOR_NAME = { w: 'Brancas', b: 'Pretas' };

  const match = location.pathname.match(/^\/sala\/([A-Za-z0-9]+)/);
  const roomId = match ? match[1].toUpperCase() : null;
  const roomLink = roomId ? `${location.origin}/sala/${roomId}` : '';

  let token = null;
  let state = null;
  let es = null;
  let partial = [];          // caminho que o jogador está montando
  let pending = null;        // lance enviado aguardando confirmação
  let flipped = null;
  let chain = Promise.resolve();
  let lastChatLen = -1;
  let overlayDismissed = null;
  let animating = false;
  const pieceEls = new Map();
  let squaresEl = [];
  let piecesLayer = null;

  /* ---------------- utilidades ---------------- */
  function toast(text, ms = 2200) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Erro de conexão'), { status: res.status });
    return data;
  }

  const getName = () => localStorage.getItem('dama:name') || '';
  const setName = (n) => localStorage.setItem('dama:name', n.trim().slice(0, 20));

  /* ---------------- sons ---------------- */
  let actx = null;
  function beep(freq, dur, type = 'triangle', vol = 0.12, delay = 0) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = actx.currentTime + delay;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0);
      o.stop(t0 + dur);
    } catch (e) { /* sem áudio */ }
  }
  const sndMove = () => beep(440, 0.08);
  const sndCapture = () => { beep(330, 0.08, 'square', 0.07); beep(220, 0.12, 'square', 0.07, 0.07); };
  const sndKing = () => { beep(660, 0.1); beep(880, 0.16, 'triangle', 0.12, 0.09); };
  const sndEnd = () => [523, 659, 784].forEach((f, i) => beep(f, 0.2, 'triangle', 0.12, i * 0.12));

  /* ---------------- tela inicial ---------------- */
  function initHome() {
    $('#home').classList.remove('hidden');
    const nameInput = $('#home-name');
    nameInput.value = getName();

    $('#btn-create').onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); toast('Digite seu nome primeiro 🙂'); return; }
      setName(name);
      const mandatoryCapture = $('#home-mandatory').checked;
      try {
        const { room } = await api('/api/rooms', { mandatoryCapture });
        location.href = `/sala/${room}`;
      } catch (e) { toast(e.message); }
    };

    $('#join-form').onsubmit = (e) => {
      e.preventDefault();
      const code = $('#join-code').value.trim().toUpperCase();
      if (!code) return;
      if (nameInput.value.trim()) setName(nameInput.value);
      location.href = `/sala/${code}`;
    };
  }

  /* ---------------- sala ---------------- */
  function initRoom() {
    $('#room').classList.remove('hidden');
    $('#room-code').textContent = roomId;
    document.title = `Sala ${roomId} — Dama Online`;

    $('#btn-copy').onclick = copyLink;
    $('#chat-form').onsubmit = (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      act({ type: 'chat', text });
    };

    if (getName()) join();
    else {
      $('#name-modal').classList.remove('hidden');
      $('#modal-name').focus();
      $('#name-form').onsubmit = (e) => {
        e.preventDefault();
        const n = $('#modal-name').value.trim();
        if (!n) return;
        setName(n);
        $('#name-modal').classList.add('hidden');
        join();
      };
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) document.title = `Sala ${roomId} — Dama Online`;
    });
  }

  async function join() {
    try {
      const data = await api(`/api/rooms/${roomId}/join`, {
        token: localStorage.getItem('dama:tok:' + roomId),
        name: getName(),
      });
      token = data.token;
      localStorage.setItem('dama:tok:' + roomId, token);
      connect();
    } catch (e) {
      if (e.status === 404) {
        toast('Sala não encontrada. Voltando ao início...', 3000);
        setTimeout(() => (location.href = '/'), 2500);
      } else {
        toast('Sem conexão. Tentando novamente...');
        setTimeout(join, 2500);
      }
    }
  }

  function connect() {
    if (es) es.close();
    es = new EventSource(`/api/rooms/${roomId}/events?token=${encodeURIComponent(token)}`);
    es.onmessage = (e) => {
      const s = JSON.parse(e.data);
      chain = chain.then(() => applyState(s)).catch(console.error);
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setTimeout(join, 2000);
    };
  }

  async function act(body) {
    try {
      await api(`/api/rooms/${roomId}/action`, { token, ...body });
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(roomLink);
      toast('Link copiado! Mande para seu amigo 📨');
    } catch {
      prompt('Copie o link da sala:', roomLink);
    }
  }

  /* ---------------- estado ---------------- */
  async function applyState(s) {
    const prev = state;
    state = s;
    const g = s.game;
    const newFlip = s.you === 'b';

    if (flipped !== newFlip) {
      flipped = newFlip;
      buildBoard();
    }

    const isNextPly = prev && prev.game.plies + 1 === g.plies && g.lastMove;
    if (isNextPly) {
      const lm = g.lastMove;
      const alreadyAnimated = pending && JSON.stringify(pending) === JSON.stringify(lm.path);
      if (!alreadyAnimated) {
        animating = true;
        try { await animatePath(lm.path, lm.captured); } finally { animating = false; }
      }
      if (lm.promoted) sndKing();
      else if (!alreadyAnimated) (lm.captured.length ? sndCapture : sndMove)();
      if (g.result && !prev.game.result) sndEnd();
      partial = [];
    } else if (!prev || prev.game.plies !== g.plies) {
      partial = [];
    }
    if (!prev || prev.game.plies !== g.plies || prev.game.turn !== g.turn) pending = null;
    if (prev && !prev.game.result && g.result && !isNextPly) sndEnd();

    reconcile(g.board);
    renderUI(prev);
  }

  const myTurn = () =>
    state && state.you && state.ready && !state.game.result && state.game.turn === state.you && !pending && !animating;

  /* ---------------- tabuleiro ---------------- */
  function buildBoard() {
    const board = $('#board');
    board.innerHTML = '';
    squaresEl = [];
    pieceEls.clear();
    for (let i = 0; i < 8; i++) squaresEl.push([]);

    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const r = flipped ? 7 - dr : dr;
        const c = flipped ? 7 - dc : dc;
        const sq = document.createElement('div');
        sq.className = 'sq ' + ((r + c) % 2 ? 'dark' : 'light');
        if (dr === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${'abcdefgh'[c]}</span>`);
        if (dc === 0) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${8 - r}</span>`);
        sq.addEventListener('click', () => onSquareClick(r, c));
        squaresEl[r][c] = sq;
        board.appendChild(sq);
      }
    }
    piecesLayer = document.createElement('div');
    piecesLayer.className = 'pieces';
    board.appendChild(piecesLayer);
  }

  function place(el, r, c) {
    const dr = flipped ? 7 - r : r;
    const dc = flipped ? 7 - c : c;
    el.style.transform = `translate(${dc * 100}%, ${dr * 100}%)`;
  }

  function createPiece(p, r, c) {
    const el = document.createElement('div');
    el.className = `piece ${p.color}` + (p.king ? ' king' : '');
    el.innerHTML = '<div class="disc"></div>';
    el.dataset.color = p.color;
    place(el, r, c);
    piecesLayer.appendChild(el);
    return el;
  }

  function killPiece(el) {
    el.classList.add('dying');
    setTimeout(() => el.remove(), 320);
  }

  function reconcile(board) {
    for (const [k, el] of pieceEls) {
      const [r, c] = k.split(',').map(Number);
      const p = board[r][c];
      if (!p || p.color !== el.dataset.color) {
        killPiece(el);
        pieceEls.delete(k);
      } else {
        el.classList.toggle('king', p.king);
        place(el, r, c);
      }
    }
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && !pieceEls.has(key(r, c))) pieceEls.set(key(r, c), createPiece(p, r, c));
      }
    }
  }

  async function animatePath(path, captured) {
    const start = key(...path[0]);
    const el = pieceEls.get(start);
    if (!el) return;
    pieceEls.delete(start);
    el.classList.remove('movable', 'selected');
    el.classList.add('moving');
    for (let i = 1; i < path.length; i++) {
      place(el, ...path[i]);
      if (i < path.length - 1) await sleep(200);
    }
    await sleep(180);
    el.classList.remove('moving');
    for (const [r, c] of captured) {
      const ce = pieceEls.get(key(r, c));
      if (ce) { killPiece(ce); pieceEls.delete(key(r, c)); }
    }
    const end = key(...path[path.length - 1]);
    const existing = pieceEls.get(end);
    if (existing && existing !== el) existing.remove();
    pieceEls.set(end, el);
  }

  function onSquareClick(r, c) {
    if (!state) return;
    if (!myTurn()) {
      const p = state.game.board[r][c];
      if (state.you && p && p.color === state.you && !state.game.result) {
        toast(state.ready ? 'Aguarde sua vez ⏳' : 'Aguardando oponente entrar...');
      }
      return;
    }
    const moves = state.moves;
    const here = [r, c];

    if (partial.length) {
      const cand = [...partial, here];
      const matches = moves.filter((m) => isPrefix(m.path, cand));
      if (matches.length) {
        partial = cand;
        const done = matches.find((m) => m.path.length === cand.length);
        if (done) return sendMove(done);
        renderHighlights();
        return;
      }
    }

    const starts = moves.filter((m) => samePos(m.path[0], here));
    if (starts.length) {
      partial = partial.length === 1 && samePos(partial[0], here) ? [] : [here];
      // se só existe um destino possível para uma peça simples, não auto-joga: o jogador escolhe.
    } else {
      const p = state.game.board[r][c];
      if (state.mandatoryCapture && p && p.color === state.you && moves.length && moves[0].captured.length) {
        toast('Captura obrigatória! Use uma peça destacada.');
      }
      partial = [];
    }
    renderHighlights();
  }

  async function sendMove(move) {
    pending = move.path;
    partial = [];
    renderHighlights();
    const anim = animatePath(move.path, move.captured);
    (move.captured.length ? sndCapture : sndMove)();
    chain = chain.then(() => anim);
    const ok = await act({ type: 'move', path: move.path });
    if (!ok) {
      await anim;
      pending = null;
      // resincroniza com o estado do servidor
      pieceEls.forEach((el) => el.remove());
      pieceEls.clear();
      reconcile(state.game.board);
      renderHighlights();
    }
  }

  function renderHighlights() {
    if (!state) return;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        squaresEl[r][c].classList.remove('last', 'selected', 'target', 'clickable');
      }
    }
    pieceEls.forEach((el) => el.classList.remove('movable', 'selected', 'doomed'));

    const lm = state.game.lastMove;
    if (lm && !pending) {
      squaresEl[lm.path[0][0]][lm.path[0][1]].classList.add('last');
      const e = lm.path[lm.path.length - 1];
      squaresEl[e[0]][e[1]].classList.add('last');
    }
    if (!myTurn()) return;

    const moves = state.moves;
    if (!partial.length) {
      for (const m of moves) {
        const [r, c] = m.path[0];
        squaresEl[r][c].classList.add('clickable');
        pieceEls.get(key(r, c))?.classList.add('movable');
      }
      return;
    }

    const [sr, sc] = partial[0];
    squaresEl[sr][sc].classList.add('selected');
    pieceEls.get(key(sr, sc))?.classList.add('selected');
    const cands = moves.filter((m) => isPrefix(m.path, partial));
    for (const m of cands) {
      const [tr, tc] = m.path[partial.length];
      squaresEl[tr][tc].classList.add('target', 'clickable');
    }
    if (cands.length && partial.length > 1) {
      for (const [r, c] of cands[0].captured.slice(0, partial.length - 1)) {
        pieceEls.get(key(r, c))?.classList.add('doomed');
      }
    }
    // permite trocar de peça
    for (const m of moves) {
      const [r, c] = m.path[0];
      squaresEl[r][c].classList.add('clickable');
    }
  }

  /* ---------------- interface ---------------- */
  function countPieces(color) {
    let n = 0, k = 0;
    for (const row of state.game.board) {
      for (const p of row) if (p && p.color === color) { n++; if (p.king) k++; }
    }
    return { n, k };
  }

  function renderBar(el, color) {
    const p = state.players[color];
    const g = state.game;
    const isTurn = state.ready && !g.result && g.turn === color;
    el.classList.toggle('turn', isTurn);
    const { n, k } = countPieces(color);
    const esc = (t) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    el.innerHTML = `
      <span class="chip ${color}"></span>
      <div class="info">
        <span class="pname">
          ${p ? esc(p.name) : '<span style="color:var(--muted)">Aguardando jogador...</span>'}
          ${state.you === color ? '<span class="you-tag">VOCÊ</span>' : ''}
          ${p ? `<span class="dot ${p.online ? 'on' : ''}" title="${p.online ? 'online' : 'offline'}"></span>` : ''}
        </span>
        <span class="meta">${COLOR_NAME[color]}${p ? ` · ${p.wins} vitória${p.wins === 1 ? '' : 's'}` : ''}${isTurn ? ' · jogando...' : ''}</span>
      </div>
      <span class="count">${n} peça${n === 1 ? '' : 's'}${k ? ` · ${k}♛` : ''}</span>`;
  }

  function resultText() {
    const r = state.game.result;
    if (!r) return null;
    const reasons = {
      no_moves: 'O adversário ficou sem lances.',
      resign: 'Por desistência.',
      agreement: 'Empate por acordo.',
      draw_rule: '20 lances seguidos só com damas e sem capturas.',
    };
    let title;
    if (!r.winner) title = 'Empate! 🤝';
    else if (state.you === r.winner) title = 'Você venceu! 🎉';
    else if (state.you) title = 'Você perdeu 😕';
    else title = `${COLOR_NAME[r.winner]} venceram!`;
    return { title, reason: reasons[r.reason] || '' };
  }

  function renderUI(prev) {
    const g = state.game;
    const you = state.you;
    const bottom = you || 'w';
    const top = bottom === 'w' ? 'b' : 'w';
    renderBar($('#bar-bottom'), bottom);
    renderBar($('#bar-top'), top);
    renderHighlights();

    // Regra da sala
    const badge = $('#room-rule-badge');
    if (badge) {
      badge.textContent = state.mandatoryCapture ? 'Comer obrigatório' : 'Comer opcional';
      badge.title = state.mandatoryCapture ? 'Nesta sala a captura de peças é obrigatória' : 'Nesta sala comer peça é opcional';
    }

    // status
    const status = $('#status');
    const actions = $('#actions');
    actions.innerHTML = '';
    const res = resultText();
    const opp = you ? state.players[you === 'w' ? 'b' : 'w'] : null;

    if (res) {
      status.innerHTML = `${res.title}<small>${res.reason}</small>`;
    } else if (!state.ready) {
      status.innerHTML = `Aguardando oponente...<small>Envie o link abaixo para seu amigo entrar na sala.</small>
        <div class="invite">🔗 <b>${roomLink}</b></div>`;
      if (you) addBtn('Copiar link do convite', copyLink, 'primary');
    } else if (!you) {
      const turnName = state.players[g.turn]?.name || COLOR_NAME[g.turn];
      status.innerHTML = `👀 Você está assistindo<small>Vez de ${escapeHtml(turnName)} (${COLOR_NAME[g.turn].toLowerCase()})</small>`;
    } else if (g.turn === you) {
      const cap = state.mandatoryCapture && state.moves.length && state.moves[0].captured.length;
      status.innerHTML = `Sua vez!` + (cap
        ? `<small class="warn">⚠️ Captura obrigatória de ${cap} peça${cap > 1 ? 's' : ''}.</small>`
        : `<small>Clique numa peça destacada e depois no destino.</small>`);
    } else {
      status.innerHTML = `Vez de ${escapeHtml(opp?.name || 'oponente')}<small>Aguarde o lance do adversário...</small>`;
    }

    if (you && state.ready && !g.result) {
      if (state.drawOffer && state.drawOffer !== you) {
        status.innerHTML += `<small class="warn">🤝 ${escapeHtml(opp?.name || 'Oponente')} propôs empate.</small>`;
        addBtn('Aceitar empate', () => act({ type: 'draw_reply', accept: true }), 'primary');
        addBtn('Recusar', () => act({ type: 'draw_reply', accept: false }));
      } else if (state.drawOffer === you) {
        addBtn('Empate proposto...', null).disabled = true;
      } else {
        addBtn('🤝 Propor empate', () => act({ type: 'draw_offer' }));
      }
      addBtn('🏳️ Desistir', () => { if (confirm('Tem certeza que quer desistir?')) act({ type: 'resign' }); }, 'danger');
    }
    if (you && g.result) addRematchBtn(actions);

    // overlay de fim de jogo
    const overlay = $('#overlay');
    if (res) {
      overlay.classList.remove('hidden');
      overlay.innerHTML = `<div class="card"><h2>${res.title}</h2><p>${res.reason}</p><div class="ov-actions"></div>
        <button class="btn small" id="ov-close">Ver tabuleiro</button></div>`;
      if (you) addRematchBtn(overlay.querySelector('.ov-actions'));
      const gameKey = g.plies + ':' + JSON.stringify(g.result);
      if (overlayDismissed === gameKey) overlay.classList.add('hidden');
      $('#ov-close').onclick = () => {
        overlayDismissed = gameKey;
        overlay.classList.add('hidden');
      };
    } else {
      overlay.classList.add('hidden');
      overlayDismissed = null;
    }

    // notificação na aba
    if (document.hidden && myTurn() && (!prev || prev.game.turn !== g.turn)) {
      document.title = '🔔 Sua vez! — Dama Online';
    }

    renderChat();
  }

  function addBtn(label, onClick, cls = '') {
    const b = document.createElement('button');
    b.className = 'btn small ' + cls;
    b.textContent = label;
    if (onClick) b.onclick = onClick;
    $('#actions').appendChild(b);
    return b;
  }

  function addRematchBtn(container) {
    const b = document.createElement('button');
    b.className = 'btn primary';
    const me = state.you;
    const voted = state.rematch.includes(me);
    const oppVoted = state.rematch.some((c) => c !== me);
    b.textContent = voted ? 'Aguardando oponente...' : oppVoted ? '✅ Aceitar revanche' : '🔄 Revanche';
    b.disabled = voted;
    b.onclick = () => act({ type: 'rematch' });
    container.appendChild(b);
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function renderChat() {
    const log = $('#chat-log');
    const chat = state.chat;
    const key = chat.length + ':' + (chat[chat.length - 1]?.t || 0);
    if (key === lastChatLen) return;
    const isNew = lastChatLen !== -1;
    lastChatLen = key;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.innerHTML = '';
    for (const m of chat) {
      const div = document.createElement('div');
      div.className = 'msg' + (m.system ? ' system' : '');
      if (m.system) div.textContent = m.text;
      else {
        const who = document.createElement('span');
        who.className = 'who ' + (m.color || 's');
        who.textContent = m.name + ':';
        div.appendChild(who);
        div.appendChild(document.createTextNode(m.text));
      }
      log.appendChild(div);
    }
    if (nearBottom || !isNew) log.scrollTop = log.scrollHeight;
    if (isNew && chat.length && !chat[chat.length - 1].system && document.hidden) {
      document.title = '💬 Nova mensagem — Dama Online';
    }
  }

  /* ---------------- início ---------------- */
  if (roomId) initRoom();
  else initHome();
})();
