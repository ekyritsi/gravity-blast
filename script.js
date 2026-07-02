/* ============================================================
   GRAVITY SHIFT BLOCKS
   Vanilla JS single-file game logic.
   Sections:
     1. CONFIG        — tweak me!
     2. STATE
     3. PIECES
     4. BOARD HELPERS
     5. GRAVITY
     6. LINE CLEARING
     7. PLACEMENT / TURN FLOW
     8. RENDERING
     9. INPUT HANDLING
    10. INIT
   ============================================================ */

/* ---------- 1. CONFIG (safe to edit) ---------- */
const CONFIG = {
  BOARD_SIZE: 8,
  TRAY_SIZE: 3,
  NUM_COLORS: 8,   // colors 1..NUM_COLORS — pieces get a random color from this pool

  // Gravity rotates in this order after each placed piece.
  GRAVITY_ORDER: ['down', 'left', 'up', 'right'],

  // Scoring
  POINTS_PER_CELL_PLACED: 1,       // small reward for placing

  // Cluster clearing: N or more same-color blocks touching (up/down/left/right) clear together.
  MIN_CLUSTER:            6,
  POINTS_PER_CLUSTER_CELL: 5,      // per cleared cell
  // Bonus for large clusters — index by cluster size (capped at length-1).
  CLUSTER_SIZE_BONUS: [0, 0, 0, 0, 5, 15, 30, 55, 90, 140, 210, 300, 420, 560, 720, 900],
  CHAIN_MULTIPLIER_STEP:  1,       // (unused — combo now grows +1 per cluster cleared)
};

const ARROWS = { down: '↓', left: '←', up: '↑', right: '→' };

/* ---------- 2. STATE ---------- */
const state = {
  board: [],           // 2D [row][col] -> 0 (empty) or colorId 1..7
  tray: [],            // array of {piece, used}
  score: 0,
  highScore: 0,
  gravityIndex: 0,     // index into CONFIG.GRAVITY_ORDER
  nextGravityIndex: 1, // precomputed random next direction (shown in UI)
  combo: 1,
  selectedTrayIndex: -1,
  gameOver: false,
  animating: false,    // block input during animations
};

/* ---------- 3. PIECES ----------
   Each piece is a list of [row, col] offsets from its top-left origin,
   plus a color id (1..7). Add more freely.
------------------------------------------------- */
const PIECES = [
  // single block
  { name: 'dot',   color: 1, cells: [[0,0]] },
  // 2-block line horizontal & vertical
  { name: '2H',    color: 2, cells: [[0,0],[0,1]] },
  { name: '2V',    color: 2, cells: [[0,0],[1,0]] },
  // 3-block line horizontal & vertical
  { name: '3H',    color: 3, cells: [[0,0],[0,1],[0,2]] },
  { name: '3V',    color: 3, cells: [[0,0],[1,0],[2,0]] },
  // 2x2 square
  { name: 'sq',    color: 4, cells: [[0,0],[0,1],[1,0],[1,1]] },
  // L-shapes (4 rotations)
  { name: 'L1',    color: 5, cells: [[0,0],[1,0],[2,0],[2,1]] },
  { name: 'L2',    color: 5, cells: [[0,0],[0,1],[0,2],[1,0]] },
  { name: 'L3',    color: 5, cells: [[0,0],[0,1],[1,1],[2,1]] },
  { name: 'L4',    color: 5, cells: [[1,0],[1,1],[1,2],[0,2]] },
  // T-shapes (4 rotations)
  { name: 'T1',    color: 6, cells: [[0,0],[0,1],[0,2],[1,1]] },
  { name: 'T2',    color: 6, cells: [[0,0],[1,0],[2,0],[1,1]] },
  { name: 'T3',    color: 6, cells: [[1,0],[1,1],[1,2],[0,1]] },
  { name: 'T4',    color: 6, cells: [[0,1],[1,0],[1,1],[2,1]] },
  // Zig-zag (S / Z, two orientations each)
  { name: 'S1',    color: 7, cells: [[0,1],[0,2],[1,0],[1,1]] },
  { name: 'S2',    color: 7, cells: [[0,0],[1,0],[1,1],[2,1]] },
  { name: 'Z1',    color: 7, cells: [[0,0],[0,1],[1,1],[1,2]] },
  { name: 'Z2',    color: 7, cells: [[0,1],[1,0],[1,1],[2,0]] },
];

function randomPiece() {
  const p = PIECES[Math.floor(Math.random() * PIECES.length)];
  // Randomize color independently of shape — makes routing matches harder.
  const color = 1 + Math.floor(Math.random() * CONFIG.NUM_COLORS);
  return { name: p.name, color, cells: p.cells.map(c => [c[0], c[1]]) };
}

/* ---------- 4. BOARD HELPERS ---------- */
function makeEmptyBoard() {
  const N = CONFIG.BOARD_SIZE;
  const b = [];
  for (let r = 0; r < N; r++) {
    b.push(new Array(N).fill(0));
  }
  return b;
}

function pieceBounds(piece) {
  let maxR = 0, maxC = 0;
  for (const [r, c] of piece.cells) {
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return { h: maxR + 1, w: maxC + 1 };
}

function canPlace(board, piece, row, col) {
  const N = CONFIG.BOARD_SIZE;
  for (const [r, c] of piece.cells) {
    const rr = row + r, cc = col + c;
    if (rr < 0 || cc < 0 || rr >= N || cc >= N) return false;
    if (board[rr][cc] !== 0) return false;
  }
  return true;
}

function pieceFitsSomewhere(board, piece) {
  const N = CONFIG.BOARD_SIZE;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (canPlace(board, piece, r, c)) return true;
    }
  }
  return false;
}

function placePiece(board, piece, row, col) {
  for (const [r, c] of piece.cells) {
    board[row + r][col + c] = piece.color;
  }
}

/* ---------- 5. GRAVITY ----------
   Slide every filled cell as far as possible in the given direction.
   We rebuild the board per row or per column, packing non-zero
   values to the corresponding edge. This treats gravity as a
   whole-board settle step in one go.
------------------------------------------------- */
function applyGravity(board, direction) {
  const N = CONFIG.BOARD_SIZE;

  if (direction === 'down' || direction === 'up') {
    for (let c = 0; c < N; c++) {
      const stack = [];
      for (let r = 0; r < N; r++) {
        if (board[r][c] !== 0) stack.push(board[r][c]);
      }
      // clear column
      for (let r = 0; r < N; r++) board[r][c] = 0;
      if (direction === 'down') {
        // pack to bottom
        for (let i = 0; i < stack.length; i++) {
          board[N - stack.length + i][c] = stack[i];
        }
      } else {
        // pack to top
        for (let i = 0; i < stack.length; i++) {
          board[i][c] = stack[i];
        }
      }
    }
  } else {
    // 'left' or 'right'
    for (let r = 0; r < N; r++) {
      const stack = [];
      for (let c = 0; c < N; c++) {
        if (board[r][c] !== 0) stack.push(board[r][c]);
      }
      for (let c = 0; c < N; c++) board[r][c] = 0;
      if (direction === 'right') {
        for (let i = 0; i < stack.length; i++) {
          board[r][N - stack.length + i] = stack[i];
        }
      } else {
        for (let i = 0; i < stack.length; i++) {
          board[r][i] = stack[i];
        }
      }
    }
  }
}

/* ---------- 5b. GRAVITY ANIMATION (FLIP-style) ----------
   Compute per-tile old→new positions, then animate floating
   tiles from old rect to new rect. During the animation, the
   underlying board cells are hidden so we don't see doubles.
------------------------------------------------- */
function computeGravityMoves(board, direction) {
  const N = CONFIG.BOARD_SIZE;
  const moves = [];
  if (direction === 'down' || direction === 'up') {
    for (let c = 0; c < N; c++) {
      const occupied = [];
      for (let r = 0; r < N; r++) if (board[r][c]) occupied.push({ r, color: board[r][c] });
      occupied.forEach((o, i) => {
        const newR = (direction === 'down') ? (N - occupied.length + i) : i;
        moves.push({ oldR: o.r, oldC: c, newR, newC: c, color: o.color });
      });
    }
  } else {
    for (let r = 0; r < N; r++) {
      const occupied = [];
      for (let c = 0; c < N; c++) if (board[r][c]) occupied.push({ c, color: board[r][c] });
      occupied.forEach((o, i) => {
        const newC = (direction === 'right') ? (N - occupied.length + i) : i;
        moves.push({ oldR: r, oldC: o.c, newR: r, newC, color: o.color });
      });
    }
  }
  return moves;
}

async function animateGravity(direction) {
  const N = CONFIG.BOARD_SIZE;
  const moves = computeGravityMoves(state.board, direction);
  const movers = moves.filter(m => m.oldR !== m.newR || m.oldC !== m.newC);

  if (movers.length === 0) {
    applyGravity(state.board, direction);
    render();
    return;
  }

  const DURATION = 380; // ms — tweak for taste
  const EASING = 'cubic-bezier(.22,.61,.36,1)';

  // Compute pixel deltas from each source cell to its target cell,
  // then translate the ACTUAL source cell (which is already colored)
  // to slide it into place.
  const animated = [];
  for (const m of movers) {
    const src = boardEl.children[m.oldR * N + m.oldC];
    const tgt = boardEl.children[m.newR * N + m.newC];
    const s = src.getBoundingClientRect();
    const t = tgt.getBoundingClientRect();
    const dx = t.left - s.left;
    const dy = t.top - s.top;
    src.style.transition = `transform ${DURATION}ms ${EASING}`;
    src.style.zIndex = '2';        // ride above stationary cells
    src.style.willChange = 'transform';
    animated.push({ cell: src, dx, dy });
  }

  // Trigger transitions on the next frame so the transition property has landed.
  await new Promise(r => requestAnimationFrame(r));
  for (const a of animated) {
    a.cell.style.transform = `translate(${a.dx}px, ${a.dy}px)`;
  }

  await sleep(DURATION + 20);

  // Commit synchronously so no paint sees the "snap back" of transforms.
  // Order:
  //   1. Kill transitions on movers so clearing transform doesn't animate back.
  //   2. Clear inline styles (transform, zIndex, willChange).
  //   3. Update board state + re-render class names.
  for (const a of animated) {
    a.cell.style.transition = 'none';
    a.cell.style.transform = '';
    a.cell.style.zIndex = '';
    a.cell.style.willChange = '';
  }
  applyGravity(state.board, direction);
  render();

  // Restore transitions after the commit paint.
  requestAnimationFrame(() => {
    for (const a of animated) a.cell.style.transition = '';
  });
}

/* ---------- 6. CLUSTER CLEARING ----------
   Instead of clearing full rows/columns, we flood-fill connected
   (4-directional) groups of same-colored blocks. Any group with
   size >= CONFIG.MIN_CLUSTER clears together.
------------------------------------------------- */
function findClusters(board) {
  const N = CONFIG.BOARD_SIZE;
  const visited = [];
  for (let r = 0; r < N; r++) visited.push(new Array(N).fill(false));
  const clusters = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (board[r][c] === 0 || visited[r][c]) continue;
      const color = board[r][c];
      const cells = [];
      const stack = [[r, c]];
      visited[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        cells.push([cr, cc]);
        const neighbors = [[cr-1,cc],[cr+1,cc],[cr,cc-1],[cr,cc+1]];
        for (const [nr, nc] of neighbors) {
          if (nr < 0 || nc < 0 || nr >= N || nc >= N) continue;
          if (visited[nr][nc]) continue;
          if (board[nr][nc] === color) {
            visited[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
      if (cells.length >= CONFIG.MIN_CLUSTER) clusters.push({ color, cells });
    }
  }
  return clusters;
}

function clearClusters(board) {
  const N = CONFIG.BOARD_SIZE;
  const clusters = findClusters(board);
  const cellsCleared = new Set();
  let totalCells = 0;
  let totalBonus = 0;
  const bonusArr = CONFIG.CLUSTER_SIZE_BONUS;
  for (const cl of clusters) {
    for (const [r, c] of cl.cells) {
      cellsCleared.add(r * N + c);
      board[r][c] = 0;
      totalCells++;
    }
    totalBonus += bonusArr[Math.min(cl.cells.length, bonusArr.length - 1)] || 0;
  }
  return { clusters, cellsCleared, totalCells, totalBonus };
}

/* ---------- 7. TURN FLOW ---------- */
function currentGravity() {
  return CONFIG.GRAVITY_ORDER[state.gravityIndex];
}
function nextGravity() {
  return CONFIG.GRAVITY_ORDER[state.nextGravityIndex];
}
/** Pick a random gravity index that isn't `avoidIdx` (so it always changes). */
function randomGravityIndex(avoidIdx) {
  const n = CONFIG.GRAVITY_ORDER.length;
  if (n <= 1) return 0;
  let idx;
  do { idx = Math.floor(Math.random() * n); } while (idx === avoidIdx);
  return idx;
}

function refillTrayIfEmpty() {
  if (state.tray.every(t => t.used)) {
    state.tray = [];
    for (let i = 0; i < CONFIG.TRAY_SIZE; i++) {
      state.tray.push({ piece: randomPiece(), used: false });
    }
  }
}

function checkGameOver() {
  // If none of the remaining (unused) tray pieces fit anywhere -> game over
  const anyFits = state.tray.some(t => !t.used && pieceFitsSomewhere(state.board, t.piece));
  if (!anyFits) triggerGameOver();
}

function triggerGameOver() {
  state.gameOver = true;
  if (state.score > state.highScore) {
    state.highScore = state.score;
    localStorage.setItem('gsb_high', String(state.highScore));
  }
  document.getElementById('finalScore').textContent = state.score;
  document.getElementById('finalHigh').textContent = state.highScore;
  document.getElementById('gameOverOverlay').classList.remove('hidden');
}

/**
 * The full turn: place a piece, clear, shift gravity, settle, clear (chain).
 * Uses async delays so the player can see each animation phase.
 */
async function performTurn(trayIndex, row, col) {
  if (state.animating || state.gameOver) return;
  const slot = state.tray[trayIndex];
  if (!slot || slot.used) return;
  if (!canPlace(state.board, slot.piece, row, col)) return;

  state.animating = true;

  // (a) Lock piece
  placePiece(state.board, slot.piece, row, col);
  slot.used = true;
  addScore(slot.piece.cells.length * CONFIG.POINTS_PER_CELL_PLACED);
  render();
  // Trigger pop-in only on the freshly placed cells
  const N_ = CONFIG.BOARD_SIZE;
  for (const [dr, dc] of slot.piece.cells) {
    const cell = boardEl.children[(row + dr) * N_ + (col + dc)];
    if (cell) {
      cell.classList.add('pop-in');
      setTimeout(() => cell.classList.remove('pop-in'), 220);
    }
  }
  await sleep(140);

  // (b) Advance gravity — use the precomputed next, then roll a fresh next
  state.gravityIndex = state.nextGravityIndex;
  state.nextGravityIndex = randomGravityIndex(state.gravityIndex);
  animateGravityArrow();
  updateGravityUI();
  await sleep(180);

  // (c) Settle in new gravity — smooth slide animation
  await animateGravity(currentGravity());

  // (d) Clear clusters AFTER gravity settles (with chain support).
  //     Combo persists across turns; if this turn clears nothing, combo resets.
  const anyCleared = await clearLoop(/*allowChain*/ true);
  if (!anyCleared) {
    state.combo = 1;
    updateCombo();
  }

  // Tray refill / game over
  refillTrayIfEmpty();
  state.selectedTrayIndex = -1;
  render();
  updateScoreUI();

  state.animating = false;
  checkGameOver();
}

/** Repeatedly clear same-color clusters while any exist, applying combo scoring.
 *  After each clear, re-settle gravity so floating blocks drop into gaps,
 *  which may form new clusters → chain combo. */
async function clearLoop(allowChain) {
  const N = CONFIG.BOARD_SIZE;
  let didAnyClear = false;
  while (true) {
    const clusters = findClusters(state.board);
    if (clusters.length === 0) break;

    // Collect all cells to flash
    const allCells = new Set();
    for (const cl of clusters) for (const [r, c] of cl.cells) allCells.add(r * N + c);
    await animateClearCells(allCells);

    // Clear + score
    const { totalCells, totalBonus, clusters: clearedGroups } = clearClusters(state.board);
    const base = totalCells * CONFIG.POINTS_PER_CLUSTER_CELL;
    const gained = Math.round((base + totalBonus) * state.combo);
    addScore(gained);

    // Popup: highlight biggest cluster size + current combo
    const biggest = clearedGroups.reduce((m, cl) => Math.max(m, cl.cells.length), 0);
    const label = (state.combo > 1 ? `COMBO x${state.combo}  ` : '')
                + `+${gained}`
                + (biggest >= 6 ? `  ×${biggest}!` : '');
    showPopupAtBoardCenter(label, (state.combo > 1 || biggest >= 6) ? 'big' : 'small');

    // Combo grows by ONE per cluster cleared this step
    state.combo += clearedGroups.length;
    updateCombo();

    render();
    didAnyClear = true;
    if (!allowChain) break;

    await sleep(120);

    // Re-settle in the current gravity so floating blocks fall into the cleared gaps.
    await animateGravity(currentGravity());
    await sleep(80);
  }
  return didAnyClear;
}

function addScore(n) {
  state.score += n;
  if (state.score > state.highScore) {
    state.highScore = state.score;
    localStorage.setItem('gsb_high', String(state.highScore));
  }
  updateScoreUI();
}

/* ---------- 8. RENDERING ---------- */
const boardEl = document.getElementById('board');
const trayEl  = document.getElementById('tray');
const popupsEl = document.getElementById('popups');

function buildBoardDOM() {
  boardEl.innerHTML = '';
  const N = CONFIG.BOARD_SIZE;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      boardEl.appendChild(cell);
    }
  }
}

function render() {
  const N = CONFIG.BOARD_SIZE;
  const cells = boardEl.children;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const cell = cells[r * N + c];
      const v = state.board[r][c];
      // preserve animation classes when possible
      const wasClearing = cell.classList.contains('clearing');
      cell.className = 'cell' + (v ? ' filled color-' + v : '');
      if (wasClearing) cell.classList.add('clearing');
    }
  }
  renderTray();
  // Re-apply preview if a piece is selected + hover exists
  if (hover.row >= 0 && state.selectedTrayIndex >= 0) applyPreview();
}

function renderTray() {
  trayEl.innerHTML = '';
  state.tray.forEach((slot, i) => {
    const div = document.createElement('div');
    div.className = 'tray-slot';
    if (slot.used) {
      div.classList.add('empty');
      trayEl.appendChild(div);
      return;
    }
    if (!pieceFitsSomewhere(state.board, slot.piece)) div.classList.add('disabled');
    if (state.selectedTrayIndex === i) div.classList.add('selected');

    // Build a small preview grid
    const { h, w } = pieceBounds(slot.piece);
    const grid = document.createElement('div');
    grid.className = 'piece-grid';
    grid.style.gridTemplateColumns = `repeat(${w}, 20px)`;
    grid.style.gridTemplateRows    = `repeat(${h}, 20px)`;
    const filled = new Set(slot.piece.cells.map(([r,c]) => r + ',' + c));
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const pc = document.createElement('div');
        if (filled.has(r + ',' + c)) {
          pc.className = 'piece-cell';
          pc.style.background = `var(--c${slot.piece.color})`;
        } else {
          pc.className = 'piece-cell empty';
        }
        grid.appendChild(pc);
      }
    }
    div.appendChild(grid);
    div.addEventListener('click', () => selectTray(i));
    trayEl.appendChild(div);
  });
}

function updateScoreUI() {
  document.getElementById('scoreEl').textContent = state.score;
  document.getElementById('highScoreEl').textContent = state.highScore;
}
function updateCombo() {
  document.getElementById('comboEl').textContent = 'x' + state.combo;
}
function updateGravityUI() {
  document.getElementById('gravityArrow').textContent = ARROWS[currentGravity()];
  document.getElementById('nextGravity').textContent = ARROWS[nextGravity()];
}
function animateGravityArrow() {
  const el = document.getElementById('gravityArrow');
  el.classList.remove('pulse');
  // force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('pulse');
}

/* ---------- Preview ---------- */
const hover = { row: -1, col: -1 };

function clearPreview() {
  for (const cell of boardEl.children) {
    cell.classList.remove('preview-ok', 'preview-bad');
  }
}

function applyPreview() {
  clearPreview();
  if (state.selectedTrayIndex < 0) return;
  const slot = state.tray[state.selectedTrayIndex];
  if (!slot || slot.used) return;
  const N = CONFIG.BOARD_SIZE;
  const ok = canPlace(state.board, slot.piece, hover.row, hover.col);
  const cls = ok ? 'preview-ok' : 'preview-bad';
  for (const [dr, dc] of slot.piece.cells) {
    const r = hover.row + dr, c = hover.col + dc;
    if (r < 0 || c < 0 || r >= N || c >= N) continue;
    const idx = r * N + c;
    const cell = boardEl.children[idx];
    if (cell) cell.classList.add(cls);
  }
}

/* ---------- Popups & animations ---------- */
function showPopupAtBoardCenter(text, size = 'small') {
  const p = document.createElement('div');
  p.className = 'popup ' + size;
  p.textContent = text;
  const rect = boardEl.getBoundingClientRect();
  const wrapRect = popupsEl.getBoundingClientRect();
  p.style.left = (rect.width / 2 + (rect.left - wrapRect.left)) + 'px';
  p.style.top  = (rect.height / 2 + (rect.top - wrapRect.top)) + 'px';
  popupsEl.appendChild(p);
  setTimeout(() => p.remove(), 1200);
  playSound('clear');
}

async function animateClearCells(indices) {
  for (const idx of indices) boardEl.children[idx].classList.add('clearing');
  await sleep(340);
  for (const idx of indices) boardEl.children[idx].classList.remove('clearing');
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

/* ---------- 9. INPUT ---------- */
function selectTray(i) {
  if (state.animating || state.gameOver) return;
  const slot = state.tray[i];
  if (!slot || slot.used) return;
  if (!pieceFitsSomewhere(state.board, slot.piece)) return;
  state.selectedTrayIndex = (state.selectedTrayIndex === i) ? -1 : i;
  renderTray();
  applyPreview();
  playSound('select');
}

function attachBoardInput() {
  boardEl.addEventListener('mousemove', (e) => {
    const target = e.target.closest('.cell');
    if (!target) return;
    hover.row = +target.dataset.r;
    hover.col = +target.dataset.c;
    if (state.selectedTrayIndex >= 0) applyPreview();
  });
  boardEl.addEventListener('mouseleave', () => {
    hover.row = -1; hover.col = -1;
    clearPreview();
  });
  boardEl.addEventListener('click', (e) => {
    const target = e.target.closest('.cell');
    if (!target) return;
    if (state.selectedTrayIndex < 0) return;
    const r = +target.dataset.r, c = +target.dataset.c;
    const slot = state.tray[state.selectedTrayIndex];
    if (!slot || slot.used) return;
    if (!canPlace(state.board, slot.piece, r, c)) {
      shakeInvalid();
      playSound('bad');
      return;
    }
    playSound('place');
    performTurn(state.selectedTrayIndex, r, c);
  });

  // Touch: tap works via click. Add touchmove for preview.
  boardEl.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const cell = el && el.closest && el.closest('.cell');
    if (!cell || !boardEl.contains(cell)) return;
    hover.row = +cell.dataset.r;
    hover.col = +cell.dataset.c;
    if (state.selectedTrayIndex >= 0) { applyPreview(); e.preventDefault(); }
  }, { passive: false });
}

function shakeInvalid() {
  boardEl.animate(
    [{ transform: 'translateX(0)' },
     { transform: 'translateX(-6px)' },
     { transform: 'translateX(6px)' },
     { transform: 'translateX(0)' }],
    { duration: 180, easing: 'ease-in-out' }
  );
}

/* ---------- Sound hooks (placeholders) ----------
   Wire up real audio here later if desired.
------------------------------------------------- */
function playSound(kind) {
  // Placeholder for future sound hooks:
  // select | place | bad | clear | gameover
  // e.g. new Audio(`sounds/${kind}.mp3`).play();
}

/* ---------- 10. INIT ---------- */
function newGame() {
  state.board = makeEmptyBoard();
  state.tray = [];
  for (let i = 0; i < CONFIG.TRAY_SIZE; i++) {
    state.tray.push({ piece: randomPiece(), used: false });
  }
  state.score = 0;
  state.gravityIndex = Math.floor(Math.random() * CONFIG.GRAVITY_ORDER.length);
  state.nextGravityIndex = randomGravityIndex(state.gravityIndex);
  state.combo = 1;
  state.selectedTrayIndex = -1;
  state.gameOver = false;
  state.animating = false;
  document.getElementById('gameOverOverlay').classList.add('hidden');
  updateScoreUI();
  updateCombo();
  updateGravityUI();
  render();
}

function loadHighScore() {
  const v = parseInt(localStorage.getItem('gsb_high') || '0', 10);
  state.highScore = isFinite(v) ? v : 0;
  document.getElementById('highScoreEl').textContent = state.highScore;
}

function init() {
  loadHighScore();
  buildBoardDOM();
  attachBoardInput();
  document.getElementById('restartBtn').addEventListener('click', newGame);
  document.getElementById('playAgainBtn').addEventListener('click', newGame);
  newGame();
}

init();
