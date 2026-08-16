const PIECE_SVG = {
  wp: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wp.png',
  wn: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wn.png',
  wb: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wb.png',
  wr: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wr.png',
  wq: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wq.png',
  wk: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wk.png',
  bp: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bp.png',
  bn: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bn.png',
  bb: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bb.png',
  br: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/br.png',
  bq: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bq.png',
  bk: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bk.png',
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const movesEl = document.getElementById('moves');
const sideSel = document.getElementById('side');
const strengthInput = document.getElementById('strength');
const strengthVal = document.getElementById('strength-val');
const timeInput = document.getElementById('think_time');
const timeVal = document.getElementById('time-val');

let currentFen = null;
let playerColor = 'w';
let selected = null;
let legalTargets = [];
let lastMove = null;
let checkSquare = null;
let thinking = false;
let boardFlipped = false;

strengthInput.addEventListener('input', ()=> strengthVal.textContent = strengthInput.value);
timeInput.addEventListener('input', ()=> timeVal.textContent = timeInput.value);

document.getElementById('newgame').addEventListener('click', startNewGame);
document.getElementById('undo').addEventListener('click', undoMove);
document.getElementById('flip').addEventListener('click', ()=>{ boardFlipped = !boardFlipped; renderBoardFromFen(); });
sideSel.addEventListener('change', startNewGame);

/* ----------------------------------------------------------------- *
 * Sound effects — synthesized with the Web Audio API, no audio files
 * needed. Falls back silently if the browser blocks audio before any
 * user gesture has happened.
 * ----------------------------------------------------------------- */

let audioCtx = null;
function getAudioCtx(){
  if(!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    audioCtx = new AC();
  }
  if(audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq, duration, type='sine', volume=0.14, delay=0){
  const ctx = getAudioCtx();
  if(!ctx) return;
  const startAt = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(volume, startAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

const SOUND = {
  move(delay=0){ playTone(440, 0.08, 'sine', 0.10, delay); },
  capture(delay=0){ playTone(300, 0.10, 'square', 0.12, delay); playTone(180, 0.12, 'square', 0.10, delay+0.03); },
  castle(delay=0){ playTone(330, 0.08, 'sine', 0.11, delay); playTone(415, 0.09, 'sine', 0.11, delay+0.07); },
  check(delay=0){ playTone(740, 0.16, 'sawtooth', 0.13, delay); },
  checkmate(delay=0){ playTone(523,0.16,'sine',0.14,delay); playTone(392,0.16,'sine',0.14,delay+0.15); playTone(261,0.28,'sine',0.14,delay+0.30); },
  draw(delay=0){ playTone(392,0.18,'sine',0.11,delay); playTone(349,0.24,'sine',0.11,delay+0.16); },
  undo(delay=0){ playTone(260,0.09,'triangle',0.09,delay); },
};

// Reads a SAN string (e.g. "Nxe5+", "O-O", "e8=Q#") and plays the
// matching sound.
function playSoundForSan(san, delay=0){
  if(!san) return;
  if(san.includes('#')){ SOUND.checkmate(delay); return; }
  if(san.startsWith('O-O')){ SOUND.castle(delay); return; }
  if(san.includes('x')){ SOUND.capture(delay); return; }
  if(san.includes('+')){ SOUND.check(delay); return; }
  SOUND.move(delay);
}

/* ----------------------------------------------------------------- */

async function postJSON(url, body){
  const res = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body||{})
  });
  if(!res.ok){
    const err = await res.json().catch(()=>({error:'request failed'}));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
}

async function startNewGame(){
  playerColor = sideSel.value;
  boardFlipped = (playerColor === 'b');
  selected = null; legalTargets = []; lastMove = null; checkSquare = null;
  setThinking(true);
  try{
    const state = await postJSON('/api/new_game', {
      side: playerColor,
      strength: parseInt(strengthInput.value,10)
    });
    applyState(state, {silent:true});
    // engine may have opened as White — play its move sound, if any
    if(state.engine_move) playSoundForSan(state.engine_move.san);
  }catch(e){
    showError(e.message);
  }
  setThinking(false);
}

async function undoMove(){
  if(thinking) return;
  try{
    const state = await postJSON('/api/undo', {});
    selected=null; legalTargets=[]; lastMove=null;
    applyState(state, {silent:true});
    SOUND.undo();
  }catch(e){ showError(e.message); }
}

function applyState(state, opts={}){
  currentFen = state.fen;
  playerColor = state.player_color;
  if(state.engine_move){
    lastMove = {from: state.engine_move.from, to: state.engine_move.to};
  }
  // else: leave lastMove as whatever the caller already set (e.g. the
  // player's own move) — don't clobber it with a stale engine move.
  checkSquare = state.in_check ? findKingSquare(state.fen, state.turn) : null;
  selected = null; legalTargets = [];
  renderBoardFromFen();
  renderMoves(state.moves_san);
  renderStatus(state);
}

function findKingSquare(fen, turn){
  const board = fenToBoard(fen);
  const target = turn === 'w' ? 'wk' : 'bk';
  for(let r=0;r<8;r++){
    for(let f=0;f<8;f++){
      if(board[r][f] === target) return squareId(f, r);
    }
  }
  return null;
}

function showError(msg){
  const isEngineError = /stockfish|engine/i.test(msg);
  statusEl.textContent = 'Error: ' + msg + (isEngineError ? ' — is Stockfish installed and STOCKFISH_PATH set?' : '');
  statusEl.className = 'status-line error';
}

function setThinking(val){
  thinking = val;
  if(val){
    statusEl.textContent = 'Engine is thinking…';
    statusEl.className = 'status-line think';
  }
}

function fenToBoard(fen){
  const rows = fen.split(' ')[0].split('/');
  const board = [];
  for(const row of rows){
    const line = [];
    for(const ch of row){
      if(/\d/.test(ch)){
        for(let i=0;i<parseInt(ch,10);i++) line.push(null);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        line.push(color + ch.toLowerCase());
      }
    }
    board.push(line);
  }
  return board;
}

function squareId(fileIdx, rankIdx){
  const file = 'abcdefgh'[fileIdx];
  const rank = 8 - rankIdx;
  return file + rank;
}

function renderBoardFromFen(){
  if(!currentFen) return;
  const board = fenToBoard(currentFen);
  boardEl.innerHTML = '';

  for(let r=0;r<8;r++){
    for(let f=0;f<8;f++){
      const rankIdx = boardFlipped ? 7-r : r;
      const fileIdx = boardFlipped ? 7-f : f;
      const sq = squareId(fileIdx, rankIdx);
      const div = document.createElement('div');
      const isLight = (fileIdx + rankIdx) % 2 === 0;
      div.className = 'sq ' + (isLight ? 'light':'dark');
      div.dataset.sq = sq;

      if(selected === sq) div.classList.add('selected');
      if(lastMove && (lastMove.from===sq || lastMove.to===sq)) div.classList.add('last');
      if(checkSquare === sq) div.classList.add('check');

      const piece = board[rankIdx][fileIdx];
      if(piece){
        const span = document.createElement('span');
        span.className = 'piece ' + piece[0];
        const img = document.createElement('img');
        img.src = PIECE_SVG[piece];
        img.alt = piece;
        img.draggable = false;
        span.appendChild(img);
        div.appendChild(span);
      }

      if(legalTargets.includes(sq)){
        div.classList.add('dot');
        if(piece) div.classList.add('capture');
      }

      if(f===0){
        const rc = document.createElement('span');
        rc.className='coords rank'; rc.textContent = 8-rankIdx;
        div.appendChild(rc);
      }
      if(r===7){
        const fc = document.createElement('span');
        fc.className='coords file'; fc.textContent = 'abcdefgh'[fileIdx];
        div.appendChild(fc);
      }

      div.addEventListener('click', onSquareClick);
      boardEl.appendChild(div);
    }
  }
}

async function onSquareClick(e){
  if(thinking) return;
  const sq = e.currentTarget.dataset.sq;
  const turn = currentFen.split(' ')[1];
  if(turn !== playerColor) return;

  if(selected && legalTargets.includes(sq)){
    const fromRank = selected[1];
    const promotingPawn = (playerColor==='w' && fromRank==='7' && sq[1]==='8') ||
                           (playerColor==='b' && fromRank==='2' && sq[1]==='1');
    const body = {from: selected, to: sq};
    if(promotingPawn) body.promotion = 'q';

    // Figure out the player's own move sound locally (capture / castle /
    // plain move) so it plays instantly, without waiting on the engine's
    // reply to come back.
    const boardBefore = fenToBoard(currentFen);
    const movingPiece = boardBefore[8-parseInt(selected[1],10)]['abcdefgh'.indexOf(selected[0])];
    const targetOccupied = boardBefore[8-parseInt(sq[1],10)]['abcdefgh'.indexOf(sq[0])] !== null;
    const isEnPassant = movingPiece && movingPiece[1]==='p' && selected[0]!==sq[0] && !targetOccupied;
    const isCastle = movingPiece && movingPiece[1]==='k' && Math.abs('abcdefgh'.indexOf(sq[0]) - 'abcdefgh'.indexOf(selected[0])) === 2;

    if(isCastle) SOUND.castle();
    else if(targetOccupied || isEnPassant) SOUND.capture();
    else SOUND.move();

    lastMove = {from: selected, to: sq};
    selected = null; legalTargets = [];
    setThinking(true);
    try{
      const state = await postJSON('/api/move', body);
      applyState(state, {silent:true});
      // If the engine replied, play its move sound shortly after ours.
      if(state.engine_move){
        playSoundForSan(state.engine_move.san, 0.18);
      } else if(state.is_checkmate){
        SOUND.checkmate(0.05);
      } else if(state.is_game_over){
        SOUND.draw(0.05);
      } else if(state.in_check){
        SOUND.check(0.05);
      }
    }catch(err){
      showError(err.message);
    }
    setThinking(false);
    return;
  }

  try{
    const res = await fetch(`/api/legal_moves?square=${sq}`);
    const data = await res.json();
    if(data.targets && data.targets.length){
      selected = sq;
      legalTargets = data.targets;
    } else {
      selected = null; legalTargets = [];
    }
  }catch(e){
    selected = null; legalTargets = [];
  }
  renderBoardFromFen();
}

function renderMoves(sanList){
  let html='';
  for(let i=0;i<sanList.length;i+=2){
    const num = i/2+1;
    const w = sanList[i]||'';
    const b = sanList[i+1]||'';
    html += `<div class="mv-row"><span class="num">${num}.</span><span class="w">${w}</span><span class="b">${b}</span></div>`;
  }
  movesEl.innerHTML = html;
  movesEl.scrollTop = movesEl.scrollHeight;
}

function renderStatus(state){
  statusEl.className = 'status-line';
  if(state.is_checkmate){
    const winner = state.turn === 'w' ? 'Black' : 'White';
    statusEl.textContent = `Checkmate — ${winner} wins.`;
    statusEl.classList.add('over');
    return;
  }
  if(state.is_stalemate || (state.is_game_over && !state.is_checkmate)){
    statusEl.textContent = 'Draw.';
    statusEl.classList.add('over');
    return;
  }
  const turnName = state.turn === 'w' ? 'White' : 'Black';
  let txt = `${turnName} to move.`;
  if(state.in_check) txt += ' Check.';
  if(state.engine_move) txt = `Engine played ${state.engine_move.san}. ` + txt;
  statusEl.textContent = txt;
}

startNewGame();

/* ----------------------------------------------------------------- *
 * Puzzles: paste a PGN (or FEN) to jump the board to that position,
 * and save the position the current puzzle/game started from.
 * ----------------------------------------------------------------- */

const puzzleInput = document.getElementById('puzzle-input');
const puzzleLoadBtn = document.getElementById('puzzle-load');
const puzzleNameInput = document.getElementById('puzzle-name');
const puzzleSaveBtn = document.getElementById('puzzle-save');
const puzzleStatusEl = document.getElementById('puzzle-status');
const puzzleListEl = document.getElementById('puzzle-list');

function setPuzzleStatus(msg, kind){
  if(!puzzleStatusEl) return;
  puzzleStatusEl.textContent = msg;
  puzzleStatusEl.className = kind ? kind : '';
}

async function loadPuzzleFromInput(){
  const text = puzzleInput.value.trim();
  if(!text){
    setPuzzleStatus('Paste a PGN or a FEN first.', 'error');
    return;
  }
  // FENs have slashes and no PGN-style move numbers ("1.")
  const looksLikeFen = text.includes('/') && !/\d+\./.test(text);
  const body = looksLikeFen ? {fen: text} : {pgn: text};

  setThinking(true);
  try{
    const state = await postJSON('/api/puzzle/load', body);
    lastMove = null;
    applyState(state, {silent:true});
    if(state.engine_move) playSoundForSan(state.engine_move.san);
    setPuzzleStatus('Puzzle loaded.', 'ok');
  }catch(e){
    setPuzzleStatus(e.message, 'error');
  }
  setThinking(false);
}

async function saveCurrentPuzzle(){
  const name = (puzzleNameInput.value || '').trim() || 'Untitled puzzle';
  try{
    const puzzle = await postJSON('/api/puzzle/save', {name});
    setPuzzleStatus(`Saved "${puzzle.name}".`, 'ok');
    puzzleNameInput.value = '';
    refreshPuzzleList();
  }catch(e){
    setPuzzleStatus(e.message, 'error');
  }
}

async function refreshPuzzleList(){
  if(!puzzleListEl) return;
  const res = await fetch('/api/puzzle/list');
  const data = await res.json();
  puzzleListEl.innerHTML = '';

  (data.puzzles || []).slice().reverse().forEach(p=>{
    const row = document.createElement('li');
    row.className = 'puzzle-row';

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'puzzle-row-load';
    loadBtn.textContent = `${p.name} — ${p.side_to_move === 'w' ? 'White' : 'Black'} to move`;
    loadBtn.addEventListener('click', async ()=>{
      setThinking(true);
      try{
        const state = await postJSON(`/api/puzzle/${p.id}/load`, {});
        lastMove = null;
        applyState(state, {silent:true});
        if(state.engine_move) playSoundForSan(state.engine_move.san);
        setPuzzleStatus(`Loaded "${p.name}".`, 'ok');
      }catch(e){
        setPuzzleStatus(e.message, 'error');
      }
      setThinking(false);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'puzzle-row-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete this saved puzzle';
    delBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      await fetch(`/api/puzzle/${p.id}`, {method:'DELETE'});
      refreshPuzzleList();
    });

    row.appendChild(loadBtn);
    row.appendChild(delBtn);
    puzzleListEl.appendChild(row);
  });
}

if(puzzleLoadBtn){
  puzzleLoadBtn.addEventListener('click', loadPuzzleFromInput);
  puzzleSaveBtn.addEventListener('click', saveCurrentPuzzle);
  refreshPuzzleList();
}