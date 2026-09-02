from __future__ import annotations

import json
import os
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from pathlib import Path
from threading import Lock

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder=".", static_url_path="")
data_lock = Lock()
data_file = Path(os.environ.get("RECORDS_FILE", "/var/data/delivery-records.json"))
slots = ("10時便", "12時便", "14時便", "16時便", "18時便")
origin_address = "ベイシアなめがわモール店, 埼玉県比企郡滑川町羽尾2780"


def google_json(url: str, *, data: dict | None = None, headers: dict[str, str] | None = None) -> dict:
    payload = json.dumps(data).encode("utf-8") if data is not None else None
    request = Request(url, data=payload, headers=headers or {}, method="POST" if payload else "GET")
    try:
        with urlopen(request, timeout=10) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ValueError("Google Maps API request failed.") from error


@app.post("/api/distance")
def distance():
    payload = request.get_json(silent=True)
    destination = payload.get("destination") if isinstance(payload, dict) else None
    api_key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not api_key:
        return jsonify(error="Google Maps API key is not configured."), 503
    if not isinstance(destination, str) or not destination.strip() or len(destination) > 160:
        return jsonify(error="Invalid destination."), 400
    try:
        def geocode(address: str) -> dict:
            result = google_json(f"https://maps.googleapis.com/maps/api/geocode/json?{urlencode({'address': address, 'key': api_key, 'region': 'jp'})}")
            if result.get("status") != "OK" or not result.get("results"):
                raise ValueError("Address could not be located.")
            return result["results"][0]["geometry"]["location"]

        origin = geocode(origin_address)
        target = geocode(destination)
        route = google_json(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            data={"origin": {"location": {"latLng": {"latitude": origin["lat"], "longitude": origin["lng"]}}}, "destination": {"location": {"latLng": {"latitude": target["lat"], "longitude": target["lng"]}}}, "travelMode": "DRIVE", "routingPreference": "TRAFFIC_UNAWARE"},
            headers={"Content-Type": "application/json", "X-Goog-Api-Key": api_key, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"},
        )
        if not route.get("routes"):
            return jsonify(error="No driving route was found."), 422
        return jsonify(distanceKm=round(route["routes"][0]["distanceMeters"] / 1000, 1), duration=route["routes"][0].get("duration"))
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Unable to calculate driving distance."), 502


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
