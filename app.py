import os
import chess
import chess.engine
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
