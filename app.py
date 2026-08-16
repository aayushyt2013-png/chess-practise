import os
import io
import json
import uuid
import threading

import chess
import chess.engine
import chess.pgn
from flask import Flask, jsonify, request, render_template

app = Flask(__name__)

STOCKFISH_PATH = os.environ.get("STOCKFISH_PATH", "stockfish")

engine = None


def get_engine():
    global engine
    if engine is None:
        try:
            engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
        except FileNotFoundError:
            raise RuntimeError(
                f"Couldn't find a Stockfish binary at '{STOCKFISH_PATH}'. "
                "Install Stockfish and/or set the STOCKFISH_PATH environment variable."
            )
    return engine


board = chess.Board()
player_color = chess.WHITE
skill_level = 10
think_time = 0.6

# --- Puzzle tracking -------------------------------------------------
# Whenever the board is (re)set to a fresh starting position -- a normal
# new game, a pasted PGN, a pasted FEN, or a saved puzzle being reloaded --
# we remember that starting FEN (and, if it came from a PGN, the raw PGN
# text) so "Save Puzzle" always saves *where the puzzle began*, not
# whatever position the board happens to be in after moves are played.
puzzle_start_fen = chess.Board().fen()
puzzle_start_pgn = None

PUZZLES_FILE = os.environ.get("PUZZLES_FILE", os.path.join(os.path.dirname(__file__), "puzzles.json"))
_puzzles_lock = threading.Lock()


def _load_puzzles():
    if not os.path.exists(PUZZLES_FILE):
        return []
    try:
        with open(PUZZLES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _save_puzzles(puzzles):
    with open(PUZZLES_FILE, "w", encoding="utf-8") as f:
        json.dump(puzzles, f, indent=2)


def _mark_puzzle_start(fen, pgn=None):
    global puzzle_start_fen, puzzle_start_pgn
    puzzle_start_fen = fen
    puzzle_start_pgn = pgn


def board_state():
    return {
        "fen": board.fen(),
        "turn": "w" if board.turn == chess.WHITE else "b",
        "player_color": "w" if player_color == chess.WHITE else "b",
        "moves_san": [m for m in _san_history()],
        "in_check": board.is_check(),
        "is_checkmate": board.is_checkmate(),
        "is_stalemate": board.is_stalemate(),
        "is_game_over": board.is_game_over(),
        "result": board.result() if board.is_game_over() else None,
        "puzzle_start_fen": puzzle_start_fen,
    }


def _san_history():
    temp = chess.Board()
    history = []
    for mv in board.move_stack:
        history.append(temp.san(mv))
        temp.push(mv)
    return history


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/state")
def api_state():
    return jsonify(board_state())


@app.route("/api/new_game", methods=["POST"])
def api_new_game():
    global board, player_color, skill_level
    data = request.get_json(force=True, silent=True) or {}
    board = chess.Board()
    player_color = chess.WHITE if data.get("side", "w") == "w" else chess.BLACK
    skill_level = int(data.get("strength", skill_level))
    _mark_puzzle_start(board.fen(), pgn=None)

    state = board_state()
    if board.turn != player_color:
        engine_move = _make_engine_move()
        state = board_state()
        state["engine_move"] = engine_move
    return jsonify(state)


@app.route("/api/legal_moves")
def api_legal_moves():
    square_name = request.args.get("square")
    try:
        square = chess.parse_square(square_name)
    except ValueError:
        return jsonify({"targets": []})
    targets = [
        chess.square_name(m.to_square)
        for m in board.legal_moves
        if m.from_square == square
    ]
    return jsonify({"targets": targets})


@app.route("/api/move", methods=["POST"])
def api_move():
    data = request.get_json(force=True)
    from_sq, to_sq = data.get("from"), data.get("to")
    promotion = data.get("promotion")
    try:
        uci = from_sq + to_sq + (promotion or "")
        move = chess.Move.from_uci(uci)
    except ValueError:
        return jsonify({"error": "invalid move"}), 400

    if move not in board.legal_moves:
        return jsonify({"error": "illegal move"}), 400

    board.push(move)
    state = board_state()
    if not board.is_game_over() and board.turn != player_color:
        engine_move = _make_engine_move()
        state = board_state()
        state["engine_move"] = engine_move
    return jsonify(state)


@app.route("/api/undo", methods=["POST"])
def api_undo():
    if board.move_stack:
        board.pop()
    if board.move_stack and board.turn != player_color:
        board.pop()
    return jsonify(board_state())


@app.route("/api/set_strength", methods=["POST"])
def api_set_strength():
    global skill_level, think_time
    data = request.get_json(force=True)
    skill_level = max(0, min(20, int(data.get("strength", skill_level))))
    think_time = float(data.get("think_time", think_time))
    return jsonify({"skill_level": skill_level, "think_time": think_time})


# --- Puzzle routes -----------------------------------------------------

@app.route("/api/puzzle/load", methods=["POST"])
def api_puzzle_load():
    """Load a puzzle from a pasted PGN (or a raw FEN) and set the board
    to that position. The side to move at that point becomes the side
    the player controls, unless a side is explicitly given."""
    global board, player_color

    data = request.get_json(force=True, silent=True) or {}
    pgn_text = (data.get("pgn") or "").strip()
    fen_text = (data.get("fen") or "").strip()
    ply = data.get("ply")  # optional: stop after N half-moves instead of the whole PGN

    if not pgn_text and not fen_text:
        return jsonify({"error": "Provide a 'pgn' or a 'fen' to load a puzzle from."}), 400

    try:
        if fen_text:
            new_board = chess.Board(fen_text)
        else:
            game = chess.pgn.read_game(io.StringIO(pgn_text))
            if game is None:
                return jsonify({"error": "Couldn't parse that PGN."}), 400

            new_board = game.board()
            moves = list(game.mainline_moves())
            if ply is not None:
                try:
                    ply = max(0, int(ply))
                except (TypeError, ValueError):
                    return jsonify({"error": "'ply' must be an integer."}), 400
                moves = moves[:ply]

            for mv in moves:
                new_board.push(mv)
    except ValueError as exc:
        return jsonify({"error": f"Invalid position: {exc}"}), 400

    board = new_board
    side_arg = data.get("side")
    if side_arg in ("w", "b"):
        player_color = chess.WHITE if side_arg == "w" else chess.BLACK
    else:
        player_color = board.turn

    _mark_puzzle_start(board.fen(), pgn=pgn_text or None)

    state = board_state()
    if not board.is_game_over() and board.turn != player_color:
        engine_move = _make_engine_move()
        state = board_state()
        state["engine_move"] = engine_move
    return jsonify(state)


@app.route("/api/puzzle/save", methods=["POST"])
def api_puzzle_save():
    """Save the position the *current* puzzle/game started from -- not
    wherever the board currently is -- under a given name."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip() or "Untitled puzzle"

    puzzle = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "fen": puzzle_start_fen,
        "pgn": puzzle_start_pgn,
        "side_to_move": "w" if chess.Board(puzzle_start_fen).turn == chess.WHITE else "b",
    }

    with _puzzles_lock:
        puzzles = _load_puzzles()
        puzzles.append(puzzle)
        _save_puzzles(puzzles)

    return jsonify(puzzle)


@app.route("/api/puzzle/list")
def api_puzzle_list():
    with _puzzles_lock:
        puzzles = _load_puzzles()
    return jsonify({"puzzles": puzzles})


@app.route("/api/puzzle/<puzzle_id>/load", methods=["POST"])
def api_puzzle_load_saved(puzzle_id):
    """Load a previously-saved puzzle by id and set the board to its
    starting position."""
    global board, player_color

    with _puzzles_lock:
        puzzles = _load_puzzles()
    puzzle = next((p for p in puzzles if p["id"] == puzzle_id), None)
    if puzzle is None:
        return jsonify({"error": "Puzzle not found."}), 404

    try:
        board = chess.Board(puzzle["fen"])
    except ValueError as exc:
        return jsonify({"error": f"Saved puzzle has an invalid position: {exc}"}), 500

    player_color = board.turn
    _mark_puzzle_start(puzzle["fen"], pgn=puzzle.get("pgn"))

    state = board_state()
    if not board.is_game_over() and board.turn != player_color:
        engine_move = _make_engine_move()
        state = board_state()
        state["engine_move"] = engine_move
    return jsonify(state)


@app.route("/api/puzzle/<puzzle_id>", methods=["DELETE"])
def api_puzzle_delete(puzzle_id):
    with _puzzles_lock:
        puzzles = _load_puzzles()
        remaining = [p for p in puzzles if p["id"] != puzzle_id]
        if len(remaining) == len(puzzles):
            return jsonify({"error": "Puzzle not found."}), 404
        _save_puzzles(remaining)
    return jsonify({"deleted": puzzle_id})


def _make_engine_move():
    eng = get_engine()
    eng.configure({"Skill Level": skill_level})
    result = eng.play(board, chess.engine.Limit(time=think_time))
    if result.move is None:
        return None
    san = board.san(result.move)
    board.push(result.move)
    return {
        "uci": result.move.uci(),
        "san": san,
        "from": chess.square_name(result.move.from_square),
        "to": chess.square_name(result.move.to_square),
    }


@app.teardown_appcontext
def _shutdown_engine(exception=None):
    pass


import atexit


@atexit.register
def _close_engine():
    if engine is not None:
        try:
            engine.quit()
        except Exception:
            pass


if __name__ == "__main__":
    app.run(debug=True, port=5000)