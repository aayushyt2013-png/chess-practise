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
let thinking = false;
let boardFlipped = false;

strengthInput.addEventListener('input', ()=> strengthVal.textContent = strengthInput.value);
timeInput.addEventListener('input', ()=> timeVal.textContent = timeInput.value);

document.getElementById('newgame').addEventListener('click', startNewGame);
document.getElementById('undo').addEventListener('click', undoMove);
document.getElementById('flip').addEventListener('click', ()=>{ boardFlipped = !boardFlipped; renderBoardFromFen(); });
sideSel.addEventListener('change', startNewGame);

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
  selected = null; legalTargets = []; lastMove = null;
  setThinking(true);
  try{
    const state = await postJSON('/api/new_game', {
      side: playerColor,
      strength: parseInt(strengthInput.value,10)
    });
    applyState(state);
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
    applyState(state);
  }catch(e){ showError(e.message); }
}

function applyState(state){
  currentFen = state.fen;
  playerColor = state.player_color;
  lastMove = state.engine_move ? {from:state.engine_move.from, to:state.engine_move.to} : lastMove;
  renderBoardFromFen();
  renderMoves(state.moves_san);
  renderStatus(state);
}

function showError(msg){
  statusEl.textContent = 'Error: ' + msg + ' — is Stockfish installed and STOCKFISH_PATH set?';
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
    selected = null; legalTargets = [];
    setThinking(true);
    try{
      const state = await postJSON('/api/move', body);
      applyState(state);
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
