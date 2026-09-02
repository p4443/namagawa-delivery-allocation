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
slots = ("10時便", "12時便", "14時便", "16時便", "18時便")


def empty_records() -> dict[str, list[dict]]:
    return {slot: [] for slot in slots}


def load_records() -> dict[str, list[dict]]:
    try:
        data = json.loads(data_file.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {slot: data.get(slot, []) if isinstance(data.get(slot, []), list) else [] for slot in slots}
    except (OSError, json.JSONDecodeError):
        pass
    return empty_records()


@app.get("/api/records")
def get_records():
    with data_lock:
        return jsonify(load_records())


@app.put("/api/records")
def put_records():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Invalid record format."), 400
    records = {slot: payload.get(slot, []) for slot in slots}
    if any(not isinstance(items, list) or len(items) > 200 for items in records.values()):
        return jsonify(error="Invalid record list."), 400
    with data_lock:
        data_file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=data_file.parent, delete=False) as temp:
            json.dump(records, temp, ensure_ascii=False, separators=(",", ":"))
            temp_name = temp.name
        os.replace(temp_name, data_file)
    return jsonify(records)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")
