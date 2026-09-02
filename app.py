from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import Lock

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder=".", static_url_path="")
data_lock = Lock()
data_file = Path(os.environ.get("RECORDS_FILE", "/var/data/delivery-records.json"))
MAX_STATE_BYTES = 1_000_000


def load_state() -> dict:
    try:
        data = json.loads(data_file.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"revision": 0}


@app.get("/api/state")
def get_state():
    with data_lock:
        return jsonify(load_state())


@app.put("/api/state")
def put_state():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Invalid shared state."), 400
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_STATE_BYTES:
        return jsonify(error="Shared state is too large."), 413
    with data_lock:
        current = load_state()
        payload["revision"] = int(current.get("revision", 0)) + 1
        data_file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=data_file.parent, delete=False) as temp:
            json.dump(payload, temp, ensure_ascii=False, separators=(",", ":"))
            temp_name = temp.name
        os.replace(temp_name, data_file)
    return jsonify(payload)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")
