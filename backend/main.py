import csv
import os
import secrets
import json
import hashlib
import base64
import hmac
import sqlite3
import time
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

def load_local_env() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env.local"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

load_local_env()

IS_PRODUCTION = os.getenv("NODE_ENV", "development").lower() == "production"
SESSION_SECRET_VALUE = os.getenv("CHARGEFLOW_SESSION_SECRET") or os.getenv("JWT_SECRET", "")
if IS_PRODUCTION and len(SESSION_SECRET_VALUE) < 32:
    raise RuntimeError("CHARGEFLOW_SESSION_SECRET must be set to at least 32 characters in production")

configured_frontends = {
    origin.strip().rstrip("/")
    for origin in os.getenv("CHARGEFLOW_FRONTEND_URL", "").split(",")
    if origin.strip()
}
if not IS_PRODUCTION:
    configured_frontends.update({"http://localhost:3000", "http://127.0.0.1:3000"})

app = FastAPI(title="ChargeFlow India API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(configured_frontends),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Accept", "Authorization", "Content-Type"],
)

DATASET_PATH = Path(__file__).resolve().parents[1] / "data" / "ev-charging-stations-india.csv"
DEFAULT_DRIVER = {"lat": 28.6139, "lon": 77.2090, "city": "New Delhi", "country": "India"}

class PredictionRequest(BaseModel):
    station_id: str | None = None
    occupancy: int = Field(ge=0)
    num_plugs: int = Field(gt=0)
    hour: int = Field(default=9, ge=0, le=23)
    day_of_week: int = Field(default=1, ge=0, le=6)

class RecommendationRequest(BaseModel):
    battery_percent: int = Field(default=18, ge=0, le=100)
    preferred_plug: str = Field(default="CCS", min_length=2, max_length=24)
    max_range_km: float | None = Field(default=None, gt=0, le=10000)
    driver_lat: float = Field(default=DEFAULT_DRIVER["lat"], ge=-90, le=90)
    driver_lon: float = Field(default=DEFAULT_DRIVER["lon"], ge=-180, le=180)
    city: str | None = None

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    battery_percent: int = Field(default=18, ge=0, le=100)
    preferred_plug: str = Field(default="CCS", min_length=2, max_length=24)
    city: str | None = None
    driver_lat: float = Field(default=DEFAULT_DRIVER["lat"], ge=-90, le=90)
    driver_lon: float = Field(default=DEFAULT_DRIVER["lon"], ge=-180, le=180)

class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=200)

class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=200)

class PasswordResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)

class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=16, max_length=200)
    password: str = Field(min_length=8, max_length=200)

SESSIONS: dict[str, dict[str, str]] = {}
REVOKED_SESSIONS: set[str] = set()
SESSION_SECRET = (SESSION_SECRET_VALUE or "local-development-session-secret").encode()
SESSION_TTL_SECONDS = 60 * 60 * 12
GOOGLE_STATES: set[str] = set()
AUTH_DB_PATH = Path(os.getenv("CHARGEFLOW_AUTH_DB_PATH", str(Path(__file__).resolve().parents[1] / "data" / "chargeflow_auth.sqlite3")))

def auth_db() -> sqlite3.Connection:
    AUTH_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(AUTH_DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS password_resets (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL)")
    connection.commit()
    return connection

def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120_000)
    return f"{salt.hex()}:{digest.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split(":", 1)
        expected = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 120_000).hex()
        return secrets.compare_digest(expected, digest_hex)
    except (ValueError, TypeError):
        return False

def configured_accounts() -> dict[str, dict[str, str]]:
    accounts: dict[str, dict[str, str]] = {}
    for role, prefix in (("user", "CHARGEFLOW_USER"), ("admin", "CHARGEFLOW_ADMIN")):
        email = os.getenv(f"{prefix}_EMAIL", "").strip().lower()
        password = os.getenv(f"{prefix}_PASSWORD", "")
        if email and password:
            accounts[role] = {"email": email, "password": password, "role": role}
    with auth_db() as connection:
        for row in connection.execute("SELECT email, name, password_hash, role FROM users").fetchall():
            accounts[row["email"]] = {"email": row["email"], "password": row["password_hash"], "role": row["role"], "name": row["name"], "hashed": "true"}
    return accounts

def create_session(email: str, role: str, name: str = "") -> str:
    payload = {"email": email, "role": role, "name": name, "exp": int(time.time()) + SESSION_TTL_SECONDS}
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(SESSION_SECRET, encoded.encode(), hashlib.sha256).hexdigest()
    token = f"{encoded}.{signature}"
    SESSIONS[token] = {"email": email, "role": role, "name": name}
    return token

def current_session(authorization: str | None) -> dict[str, str]:
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token or token in REVOKED_SESSIONS:
        raise HTTPException(status_code=401, detail="You must log in first")
    cached = SESSIONS.get(token)
    if cached:
        return cached
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(SESSION_SECRET, encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid signature")
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode())
        if int(payload.get("exp", 0)) < int(time.time()):
            raise ValueError("expired")
        session = {"email": str(payload["email"]), "role": str(payload["role"]), "name": str(payload.get("name", ""))}
        SESSIONS[token] = session
        return session
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, base64.binascii.Error):
        raise HTTPException(status_code=401, detail="You must log in first")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    return round(2 * radius * asin(sqrt(a)), 1)


def infer_plugs(raw_type: str) -> tuple[list[str], str]:
    # The source uses 12/6-style charger type codes rather than plug names.
    # Treat 12 as DC fast charging and 6 as AC/Type 2 for the prototype.
    if str(raw_type).strip() == "12":
        return ["CCS", "DC Fast"], "CCS · DC Fast"
    return ["Type 2", "AC"], "Type 2 · AC"


def load_india_stations() -> list[dict[str, Any]]:
    if not DATASET_PATH.exists():
        return []
    rows: list[dict[str, Any]] = []
    with DATASET_PATH.open(newline="", encoding="utf-8-sig") as handle:
        for index, row in enumerate(csv.DictReader(handle)):
            try:
                lat = float(row["lattitude"])
                lon = float(row["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            plug_types, plug_label = infer_plugs(row.get("type", ""))
            distance = haversine_km(DEFAULT_DRIVER["lat"], DEFAULT_DRIVER["lon"], lat, lon)
            # Synthetic live state keeps the demo reproducible until occupancy telemetry is connected.
            num_plugs = 6 if "CCS" in plug_types else 4
            occupied = (index * 3 + len(row.get("city", ""))) % num_plugs
            wait = predict_wait(occupied, num_plugs, 9, 1)
            rows.append({
                "id": f"IN-{index + 1:04d}",
                "name": row.get("name", "Unnamed charging station").strip(),
                "state": row.get("state", "India").strip(),
                "city": row.get("city", "").strip().title(),
                "area": row.get("address", "").strip()[:48],
                "address": row.get("address", "").strip(),
                "lat": lat,
                "lon": lon,
                "distance": f"{distance:.1f} km",
                "distance_km": distance,
                "drive_minutes": max(5, round(distance / 0.65)) if distance > 8 else max(5, round(distance * 3.5)),
                "wait": wait,
                "price": "₹12/kWh" if "CCS" in plug_types else "₹8/kWh",
                "price_per_kwh": 12 if "CCS" in plug_types else 8,
                "plugs": f"{num_plugs - occupied} / {num_plugs} free",
                "num_plugs": num_plugs,
                "current_occupancy": occupied,
                "type": plug_label,
                "plug_types": plug_types,
                "source_type": row.get("type", ""),
            })
    return rows


def predict_wait(occupancy: int, num_plugs: int, hour: int = 9, day_of_week: int = 1) -> float:
    ratio = max(0.0, min(1.0, occupancy / max(1, num_plugs)))
    peak_bonus = 3.0 if hour in {7, 8, 9, 17, 18, 19} else 0.0
    weekend_bonus = 1.5 if day_of_week in {5, 6} else 0.0
    return round(max(2.0, ratio * 18 + peak_bonus + weekend_bonus), 1)

STATIONS = load_india_stations()

@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "chargeflow-india-python", "dataset": "ev-charging-stations-india.csv", "station_count": len(STATIONS), "auth": "enabled"}

@app.post("/auth/login")
def login(request: LoginRequest) -> dict[str, str]:
    normalized_email = request.email.strip().lower()
    account = next((value | {"role": value.get("role", role)} for role, value in configured_accounts().items() if value["email"].lower() == normalized_email and (verify_password(request.password, value["password"]) if value.get("hashed") else secrets.compare_digest(value["password"], request.password))), None)
    if not account:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_session(normalized_email, account["role"], account.get("name", ""))
    return {"token": token, "email": normalized_email, "role": account["role"]}

@app.post("/auth/register")
def register(request: RegisterRequest) -> dict[str, str]:
    normalized_email = request.email.strip().lower()
    if len(request.name.strip()) < 2 or "@" not in normalized_email:
        raise HTTPException(status_code=400, detail="Enter a valid name and email")
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if normalized_email in {value["email"].lower() for value in configured_accounts().values()}:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    with auth_db() as connection:
        connection.execute("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)", (normalized_email, request.name.strip(), hash_password(request.password), int(time.time())))
        connection.commit()
    token = create_session(normalized_email, "user", request.name.strip())
    return {"token": token, "email": normalized_email, "role": "user"}

@app.post("/auth/password-reset/request")
def request_password_reset(request: PasswordResetRequest) -> dict[str, str]:
    email = request.email.strip().lower()
    with auth_db() as connection:
        account_exists = connection.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone() is not None
    message = "If an account exists, a reset link has been created."
    response = {"message": message}
    if account_exists:
        token = secrets.token_urlsafe(28)
        with auth_db() as connection:
            connection.execute("DELETE FROM password_resets WHERE email = ?", (email,))
            connection.execute("INSERT INTO password_resets (token, email, expires_at) VALUES (?, ?, ?)", (token, email, int(time.time()) + 1800))
            connection.commit()
        # Do not expose reset tokens in production responses. Configure an email
        # provider before enabling account recovery for public users.
        if os.getenv("CHARGEFLOW_RESET_EMAIL_ENABLED", "false").lower() != "true" and os.getenv("NODE_ENV", "production") != "development":
            return {"message": message}
        response["reset_delivery"] = "configured"
    return response

@app.post("/auth/password-reset/confirm")
def confirm_password_reset(request: PasswordResetConfirm) -> dict[str, str]:
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    with auth_db() as connection:
        reset = connection.execute("SELECT email, expires_at FROM password_resets WHERE token = ?", (request.token,)).fetchone()
        if not reset or int(reset["expires_at"]) < int(time.time()):
            raise HTTPException(status_code=400, detail="This reset link is invalid or expired")
        connection.execute("UPDATE users SET password_hash = ? WHERE email = ?", (hash_password(request.password), reset["email"]))
        connection.execute("DELETE FROM password_resets WHERE token = ?", (request.token,))
        connection.commit()
    return {"message": "Password updated. You can now sign in."}

@app.get("/auth/google/start")
def google_start():
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/google/callback")
    if not client_id:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.")
    state = secrets.token_urlsafe(24)
    GOOGLE_STATES.add(state)
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code", "scope": "openid email profile", "state": state, "access_type": "online", "prompt": "select_account"}
    return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}")

@app.get("/auth/google/callback")
def google_callback(code: str, state: str):
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/google/callback")
    if not client_id or not client_secret or state not in GOOGLE_STATES:
        raise HTTPException(status_code=400, detail="Invalid or incomplete Google OAuth configuration")
    GOOGLE_STATES.discard(state)
    token_payload = urlencode({"code": code, "client_id": client_id, "client_secret": client_secret, "redirect_uri": redirect_uri, "grant_type": "authorization_code"}).encode()
    token_request = UrlRequest("https://oauth2.googleapis.com/token", data=token_payload, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urlopen(token_request, timeout=15) as token_response:
        access_token = json.loads(token_response.read().decode())["access_token"]
    profile_request = UrlRequest("https://openidconnect.googleapis.com/v1/userinfo", headers={"Authorization": f"Bearer {access_token}"})
    with urlopen(profile_request, timeout=15) as profile_response:
        profile = json.loads(profile_response.read().decode())
    email = str(profile["email"]).lower()
    token = create_session(email, "user", str(profile.get("name", "Google user")))
    frontend = os.getenv("CHARGEFLOW_FRONTEND_URL", "http://localhost:3000")
    return RedirectResponse(f"{frontend}/login?token={token}&email={urlencode({'email': email})[6:]}&role=user")

@app.get("/auth/me")
def me(authorization: str | None = Header(default=None)) -> dict[str, str]:
    return current_session(authorization)

@app.post("/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    token = (authorization or "").removeprefix("Bearer ").strip()
    SESSIONS.pop(token, None)
    if token:
        REVOKED_SESSIONS.add(token)
    return {"success": True}

@app.get("/admin/overview")
def admin_overview(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    if session["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return {"station_count": len(STATIONS), "cities": len({station["city"] for station in STATIONS}), "dataset": DATASET_PATH.name, "active_sessions": len(SESSIONS)}

@app.get("/admin/data-quality")
def admin_data_quality(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    if session["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    missing_coordinates = sum(1 for station in STATIONS if not station.get("lat") or not station.get("lon"))
    cities = sorted({station["city"] for station in STATIONS if station.get("city")})
    return {
        "dataset": DATASET_PATH.name,
        "rows": len(STATIONS),
        "cities": len(cities),
        "missing_coordinates": missing_coordinates,
        "valid_coordinates": len(STATIONS) - missing_coordinates,
        "status": "ready" if STATIONS and missing_coordinates == 0 else "review",
    }

@app.get("/stations")
def stations(limit: int = Query(default=50, ge=1, le=2000), city: str | None = None) -> list[dict[str, Any]]:
    filtered = STATIONS
    if city:
        filtered = [station for station in STATIONS if city.lower() in station["city"].lower()]
    return filtered[:limit]

@app.get("/network/summary")
def network_summary(city: str | None = None) -> dict[str, Any]:
    filtered = [station for station in STATIONS if not city or city.lower() in station["city"].lower()]
    if not filtered:
        return {"station_count": 0, "open_connectors": 0, "total_connectors": 0, "average_wait": 0, "low_wait_count": 0, "average_price": 0, "updated_at": int(time.time())}
    open_connectors = sum(max(0, int(station["num_plugs"]) - int(station["current_occupancy"])) for station in filtered)
    total_connectors = sum(int(station["num_plugs"]) for station in filtered)
    return {
        "station_count": len(filtered),
        "open_connectors": open_connectors,
        "total_connectors": total_connectors,
        "average_wait": round(sum(float(station["wait"]) for station in filtered) / len(filtered), 1),
        "low_wait_count": sum(1 for station in filtered if float(station["wait"]) <= 5),
        "average_price": round(sum(float(station["price_per_kwh"]) for station in filtered) / len(filtered), 2),
        "updated_at": int(time.time()),
    }

@app.post("/predict")
def predict(request: PredictionRequest) -> dict[str, Any]:
    wait = predict_wait(request.occupancy, request.num_plugs, request.hour, request.day_of_week)
    return {"station_id": request.station_id, "wait_minutes": wait, "occupancy_ratio": round(request.occupancy / request.num_plugs, 3), "model": "reproducible-heuristic-v1"}

@app.post("/recommend")
def recommend(request: RecommendationRequest) -> dict[str, Any]:
    compatible = [station for station in STATIONS if request.preferred_plug.upper() in station["plug_types"]]
    if request.city:
        city_matches = [station for station in compatible if request.city.lower() in station["city"].lower()]
        if city_matches:
            compatible = city_matches
    normalized: list[dict[str, Any]] = []
    for station in compatible:
        item = dict(station)
        item["distance_km"] = haversine_km(request.driver_lat, request.driver_lon, station["lat"], station["lon"])
        item["distance"] = f"{item['distance_km']:.1f} km"
        item["drive_minutes"] = max(3, round(item["distance_km"] * 1.45))
        normalized.append(item)
    compatible = normalized
    reachable_range = request.max_range_km if request.max_range_km is not None else request.battery_percent * 4.1
    compatible = [station for station in compatible if station["distance_km"] <= reachable_range]
    ranked = sorted(compatible, key=lambda station: station["drive_minutes"] + station["wait"])
    primary = ranked[0] if ranked else None
    alternative = ranked[1] if len(ranked) > 1 else None
    return {
        "recommendation": primary,
        "alternative": alternative,
        "reason": "Selected from the India dataset by plug compatibility, reachability, drive time, and predicted wait.",
        "driver": {**DEFAULT_DRIVER, "battery_percent": request.battery_percent},
        "trace": [
            {"tool_name": "get_driver_battery_status", "args": {"battery_percent": request.battery_percent}, "result": f"{request.battery_percent}% battery · {request.battery_percent * 4.1:.0f} km estimated range"},
            {"tool_name": "calculate_route_distance", "args": {"driver": DEFAULT_DRIVER, "candidate_count": len(compatible)}, "result": f"Reachability checked against {reachable_range:.1f} km available range"},
            {"tool_name": "predict_station_wait_time", "args": {"candidate_count": len(compatible)}, "result": f"Wait estimates calculated across {len(compatible)} reachable, compatible India stations"},
            {"tool_name": "recommendation_guardrail", "args": {"preferred_plug": request.preferred_plug, "reachable_range_km": round(reachable_range, 1)}, "result": f"{len(compatible)} reachable · {primary['name'] if primary else 'no station'} selected"},
        ],
    }

@app.post("/chat")
def chat(request: ChatRequest) -> dict[str, Any]:
    result = recommend(RecommendationRequest(battery_percent=request.battery_percent, preferred_plug=request.preferred_plug, city=request.city, driver_lat=request.driver_lat, driver_lon=request.driver_lon))
    primary = result["recommendation"]
    if not primary:
        return {"answer": "I could not find a compatible station in the India dataset for that plug type.", "recommendation": None, "trace": result["trace"]}
    if "cheap" in request.message.lower() or "price" in request.message.lower():
        answer = f"{primary['name']} is the fastest total-stop option near the default New Delhi context. I can prioritize a lower ₹/kWh option if you prefer."
    else:
        answer = f"I recommend {primary['name']} in {primary['city']}: about {primary['drive_minutes']} minutes of driving and {primary['wait']} minutes predicted wait."
    return {"answer": answer, "recommendation": primary, "alternative": result["alternative"], "trace": result["trace"]}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)
