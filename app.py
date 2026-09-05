from __future__ import annotations

import json
import os
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from pathlib import Path
from threading import Lock

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder=".", static_url_path="")
data_lock = Lock()
data_file = Path(os.environ.get("RECORDS_FILE", "/var/data/delivery-records.json"))
MAX_STATE_BYTES = 1_000_000
ROUTES_API_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"
MAX_ROUTE_STOPS = 18


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


@app.post("/api/route-matrix")
def route_matrix():
    payload = request.get_json(silent=True)
    origin = payload.get("origin") if isinstance(payload, dict) else None
    destinations = payload.get("destinations") if isinstance(payload, dict) else None
    if not isinstance(origin, str) or not origin.strip() or not isinstance(destinations, list):
        return jsonify(error="店舗拠点と配送先を指定してください。"), 400
    if not 2 <= len(destinations) <= MAX_ROUTE_STOPS or not all(isinstance(address, str) and address.strip() for address in destinations):
        return jsonify(error=f"配送先は2件から{MAX_ROUTE_STOPS}件まで指定してください。"), 400
    api_key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not api_key:
        return jsonify(error="Google Maps Routes APIキーが設定されていません。"), 503

    locations = [origin, *destinations]
    waypoints = [{"waypoint": {"address": address}} for address in locations]
    body = json.dumps({"origins": waypoints, "destinations": waypoints, "travelMode": "DRIVE", "routingPreference": "TRAFFIC_AWARE"}).encode("utf-8")
    api_request = Request(ROUTES_API_URL, data=body, headers={"Content-Type": "application/json", "X-Goog-Api-Key": api_key, "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,condition"}, method="POST")
    try:
        with urlopen(api_request, timeout=20) as response:
            entries = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        return jsonify(error=f"Routes APIエラー: {error.code}"), 502
    except (URLError, TimeoutError, json.JSONDecodeError):
        return jsonify(error="Routes APIから道路距離を取得できませんでした。"), 502
    if not isinstance(entries, list):
        return jsonify(error="Routes APIの応答形式が不正です。"), 502

    size = len(locations)
    matrix = [[None] * size for _ in range(size)]
    for entry in entries:
        origin_index = entry.get("originIndex")
        destination_index = entry.get("destinationIndex")
        distance = entry.get("distanceMeters")
        if isinstance(origin_index, int) and isinstance(destination_index, int) and 0 <= origin_index < size and 0 <= destination_index < size and isinstance(distance, int):
            matrix[origin_index][destination_index] = distance
    if any(distance is None for row in matrix for distance in row):
        return jsonify(error="道路経路が見つからない配送先があります。住所を確認してください。"), 422
    return jsonify(matrix=matrix)


@app.get("/")
def index():
    return send_from_directory(app.static_folder or ".", "index.html")


@app.get("/favicon.ico")
def favicon():
    return "", 204
