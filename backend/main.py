import csv
import os
import secrets
import json
import hashlib
import base64
import hmac
import platform
import sqlite3
import time
import smtplib
from email.message import EmailMessage
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
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

class AccountStatusRequest(BaseModel):
    status: Literal["active", "suspended"]

class AdminPasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)

class ProfileUpdateRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)

class DashboardSettingsRequest(BaseModel):
    vehicle_name: str = Field(min_length=2, max_length=120)
    preferred_plug: Literal["CCS", "Type 2", "NACS"]
    battery_percent: int = Field(ge=10, le=100)
    city: Literal["New Delhi", "Gurugram", "Bengaluru", "Mumbai"]

class VehicleRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    preferred_plug: Literal["CCS", "Type 2", "NACS"]
    battery_percent: int = Field(ge=10, le=100)



SESSIONS: dict[str, dict[str, str]] = {}
REVOKED_SESSIONS: set[str] = set()
SESSION_SECRET = (SESSION_SECRET_VALUE or "local-development-session-secret").encode()
SESSION_TTL_SECONDS = 60 * 60 * 12
GOOGLE_STATES: set[str] = set()
AUTH_DB_PATH = Path(os.getenv("CHARGEFLOW_AUTH_DB_PATH", str(Path(__file__).resolve().parents[1] / "data" / "chargeflow_auth.sqlite3")))
DATABASE_URL = os.getenv("CHARGEFLOW_DATABASE_URL", "")
TELEMETRY_URL = os.getenv("CHARGEFLOW_TELEMETRY_URL", "").strip()
TELEMETRY_KEY = os.getenv("CHARGEFLOW_TELEMETRY_API_KEY", "").strip()
TELEMETRY_STALE_SECONDS = max(60, int(os.getenv("CHARGEFLOW_TELEMETRY_STALE_SECONDS", "900")))
TELEMETRY_CACHE: dict[str, Any] = {"updated_at": 0, "status": "fallback", "records": {}, "last_error": None}

def mysql_url() -> str | None:
    return DATABASE_URL if DATABASE_URL.startswith(("mysql://", "mysql+pymysql://")) else None

def telemetry_status() -> dict[str, Any]:
    updated_at = float(TELEMETRY_CACHE["updated_at"] or 0)
    age_seconds = int(time.time() - updated_at) if updated_at else None
    stale = bool(updated_at and age_seconds is not None and age_seconds > TELEMETRY_STALE_SECONDS)
    status = "stale" if stale and TELEMETRY_CACHE["records"] else TELEMETRY_CACHE["status"]
    return {"configured": bool(TELEMETRY_URL and TELEMETRY_KEY), "provider": os.getenv("CHARGEFLOW_TELEMETRY_PROVIDER", "generic"), "status": status, "updated_at": updated_at, "age_seconds": age_seconds, "stale_after_seconds": TELEMETRY_STALE_SECONDS, "records": len(TELEMETRY_CACHE["records"]), "last_error": TELEMETRY_CACHE["last_error"]}

def refresh_telemetry(force: bool = False) -> dict[str, dict[str, Any]]:
    if not TELEMETRY_URL or not TELEMETRY_KEY:
        return {}
    if not force and time.time() - float(TELEMETRY_CACHE["updated_at"]) < 60:
        return TELEMETRY_CACHE["records"]
    try:
        request = UrlRequest(TELEMETRY_URL, headers={"Authorization": f"Bearer {TELEMETRY_KEY}", "Accept": "application/json"})
        with urlopen(request, timeout=5) as response:
            payload = json.loads(response.read(2 * 1024 * 1024).decode("utf-8"))
        rows = payload.get("stations", payload) if isinstance(payload, dict) else payload
        records: dict[str, dict[str, Any]] = {}
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict): continue
            station_id = str(row.get("station_id", row.get("id", ""))).strip()
            if station_id:
                records[station_id] = {key: row[key] for key in ("available_connectors", "occupied_connectors", "status", "updated_at") if key in row}
        TELEMETRY_CACHE.update({"updated_at": time.time(), "status": "connected", "records": records})
    except (OSError, URLError, ValueError, json.JSONDecodeError) as error:
        TELEMETRY_CACHE.update({"status": "stale" if TELEMETRY_CACHE["records"] else "fallback", "last_error": str(error)[:180]})
    return TELEMETRY_CACHE["records"]

def with_telemetry(station: dict[str, Any]) -> dict[str, Any]:
    item = dict(station)
    record = refresh_telemetry().get(str(station["id"]))
    if record:
        if "available_connectors" in record: item["available_connectors"] = record["available_connectors"]
        if "occupied_connectors" in record: item["current_occupancy"] = record["occupied_connectors"]
        if "status" in record: item["live_status"] = record["status"]
        item["telemetry_source"] = "live-stale" if telemetry_status()["status"] == "stale" else "live"
    else:
        item["telemetry_source"] = "dataset-fallback"
    return item

class MySQLCompatConnection:
    def __init__(self, connection: Any):
        self.connection = connection
        self.cursor = connection.cursor()

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        sql = sql.replace("?", "%s")
        sql = sql.replace("ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at", "ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), updated_at = VALUES(updated_at)")
        sql = sql.replace("ON CONFLICT(email) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at", "ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json), updated_at = VALUES(updated_at)")
        sql = sql.replace("ON CONFLICT(email) DO UPDATE SET avatar_data = excluded.avatar_data, avatar_mime = excluded.avatar_mime, updated_at = excluded.updated_at", "ON DUPLICATE KEY UPDATE avatar_data = VALUES(avatar_data), avatar_mime = VALUES(avatar_mime), updated_at = VALUES(updated_at)")
        sql = sql.replace("ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', status = 'active'", "ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin', status = 'active'")
        self.cursor.execute(sql, params)
        return self.cursor

    def commit(self) -> None:
        self.connection.commit()

    def close(self) -> None:
        self.cursor.close(); self.connection.close()

    def __enter__(self) -> "MySQLCompatConnection":
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if exc_type: self.connection.rollback()
        self.close()

def auth_db() -> sqlite3.Connection:
    url = mysql_url()
    if url:
        try:
            import pymysql
            from urllib.parse import urlparse
            parsed = urlparse(url.replace("mysql+pymysql://", "mysql://", 1))
            connection = pymysql.connect(host=parsed.hostname or "localhost", port=parsed.port or 3306, user=parsed.username, password=parsed.password, database=(parsed.path or "/").lstrip("/") or None, cursorclass=pymysql.cursors.DictCursor, autocommit=False)
            cursor = connection.cursor()
            cursor.execute("CREATE TABLE IF NOT EXISTS users (email VARCHAR(320) PRIMARY KEY, name VARCHAR(120) NOT NULL, password_hash TEXT NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'user', status VARCHAR(20) NOT NULL DEFAULT 'active', created_at BIGINT NOT NULL)")
            cursor.execute("CREATE TABLE IF NOT EXISTS password_resets (token VARCHAR(200) PRIMARY KEY, email VARCHAR(320) NOT NULL, expires_at BIGINT NOT NULL)")
            cursor.execute("CREATE TABLE IF NOT EXISTS profiles (email VARCHAR(320) PRIMARY KEY, display_name VARCHAR(120) NOT NULL, avatar_data LONGTEXT NULL, avatar_mime VARCHAR(80) NULL, updated_at BIGINT NOT NULL)")
            cursor.execute("CREATE TABLE IF NOT EXISTS user_settings (email VARCHAR(320) PRIMARY KEY, settings_json TEXT NOT NULL, updated_at BIGINT NOT NULL)")
            cursor.execute("CREATE TABLE IF NOT EXISTS user_vehicles (id BIGINT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(320) NOT NULL, name VARCHAR(120) NOT NULL, preferred_plug VARCHAR(24) NOT NULL, battery_percent INT NOT NULL, created_at BIGINT NOT NULL)")
            cursor.execute("CREATE TABLE IF NOT EXISTS audit_events (id BIGINT PRIMARY KEY AUTO_INCREMENT, actor_email VARCHAR(320) NOT NULL, action VARCHAR(120) NOT NULL, target_email VARCHAR(320) NULL, details TEXT NOT NULL, created_at BIGINT NOT NULL)")
            connection.commit()
            return MySQLCompatConnection(connection)
        except ImportError as error:
            raise RuntimeError("MySQL/TiDB is configured but pymysql is not installed") from error
    AUTH_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(AUTH_DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS password_resets (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS profiles (email TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar_data TEXT, avatar_mime TEXT, updated_at INTEGER NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS user_settings (email TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS user_vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT NOT NULL, preferred_plug TEXT NOT NULL, battery_percent INTEGER NOT NULL, created_at INTEGER NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_email TEXT NOT NULL, action TEXT NOT NULL, target_email TEXT, details TEXT NOT NULL, created_at INTEGER NOT NULL)")
    try:
        connection.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    except sqlite3.OperationalError:
        pass
    for column, definition in (("avatar_data", "TEXT"), ("avatar_mime", "TEXT")):
        try:
            connection.execute(f"ALTER TABLE profiles ADD COLUMN {column} {definition}")
        except sqlite3.OperationalError:
            pass
    connection.commit()
    return connection

def db_execute(connection: Any, sql: str, params: tuple[Any, ...] = ()) -> Any:
    if mysql_url():
        sql = sql.replace("?", "%s")
    return connection.execute(sql, params)

def record_audit(actor_email: str, action: str, target_email: str | None = None, details: dict[str, Any] | None = None) -> None:
    payload = details or {}
    with auth_db() as connection:
        connection.execute("INSERT INTO audit_events (actor_email, action, target_email, details, created_at) VALUES (?, ?, ?, ?, ?)", (actor_email.lower(), action, target_email.lower() if target_email else None, json.dumps(payload, separators=(",", ":")), int(time.time())))
        connection.commit()
    notify_admin_action(actor_email, action, target_email, payload)

def notify_admin_action(actor_email: str, action: str, target_email: str | None, details: dict[str, Any]) -> None:
    host = os.getenv("CHARGEFLOW_SMTP_HOST", "").strip()
    recipient = os.getenv("CHARGEFLOW_ALERT_EMAIL", "").strip()
    if not host or not recipient:
        return
    message = EmailMessage()
    message["Subject"] = f"ChargeFlow admin activity: {action}"
    message["From"] = os.getenv("CHARGEFLOW_SMTP_FROM", os.getenv("CHARGEFLOW_SMTP_USER", recipient))
    message["To"] = recipient
    message.set_content(f"Actor: {actor_email}\nAction: {action}\nTarget: {target_email or '—'}\nDetails: {json.dumps(details, indent=2)}")
    try:
        port = int(os.getenv("CHARGEFLOW_SMTP_PORT", "587"))
        with smtplib.SMTP(host, port, timeout=8) as smtp:
            smtp.starttls()
            username = os.getenv("CHARGEFLOW_SMTP_USER", "")
            password = os.getenv("CHARGEFLOW_SMTP_PASSWORD", "")
            if username and password: smtp.login(username, password)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException):
        # Notifications must never make an otherwise successful admin action fail.
        return

def default_settings() -> dict[str, Any]:
    return {"vehicle_name": "Polestar 2 Long Range", "preferred_plug": "CCS", "battery_percent": 18, "city": "New Delhi"}

def get_profile(email: str, fallback_name: str = "") -> dict[str, Any]:
    with auth_db() as connection:
        row = connection.execute("SELECT display_name, avatar_data, avatar_mime FROM profiles WHERE email = ?", (email.lower(),)).fetchone()
    avatar_url = None
    if row and row["avatar_data"] and row["avatar_mime"]:
        avatar_url = f"data:{row['avatar_mime']};base64,{row['avatar_data']}"
    return {"email": email.lower(), "display_name": row["display_name"] if row else (fallback_name or email.lower()), "avatar_url": avatar_url}

def get_settings(email: str) -> dict[str, Any]:
    with auth_db() as connection:
        row = connection.execute("SELECT settings_json FROM user_settings WHERE email = ?", (email.lower(),)).fetchone()
    if not row:
        return default_settings()
    try:
        return {**default_settings(), **json.loads(row["settings_json"])}
    except json.JSONDecodeError:
        return default_settings()

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

def environment_accounts() -> dict[str, dict[str, str]]:
    accounts: dict[str, dict[str, str]] = {}
    for role, prefix in (("user", "CHARGEFLOW_USER"), ("admin", "CHARGEFLOW_ADMIN")):
        email = os.getenv(f"{prefix}_EMAIL", "").strip().lower()
        password = os.getenv(f"{prefix}_PASSWORD", "")
        if email and password:
            accounts[role] = {"email": email, "password": password, "role": role, "status": "active"}
    return accounts

def configured_accounts() -> dict[str, dict[str, str]]:
    accounts = environment_accounts()
    with auth_db() as connection:
        for row in connection.execute("SELECT email, name, password_hash, role, status FROM users").fetchall():
            for key, account in list(accounts.items()):
                if account["email"].lower() == row["email"].lower():
                    accounts.pop(key, None)
            accounts[row["email"]] = {"email": row["email"], "password": row["password_hash"], "role": row["role"], "name": row["name"], "status": row["status"], "hashed": "true"}
    return accounts

def create_session(email: str, role: str, name: str = "") -> str:
    payload = {"email": email, "role": role, "name": name, "exp": int(time.time()) + SESSION_TTL_SECONDS}
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(SESSION_SECRET, encoded.encode(), hashlib.sha256).hexdigest()
    token = f"{encoded}.{signature}"
    REVOKED_SESSIONS.discard(token)
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

def require_admin(authorization: str | None) -> dict[str, str]:
    session = current_session(authorization)
    if session["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return session

def revoke_sessions_for_email(email: str) -> None:
    normalized = email.lower()
    for token, session in list(SESSIONS.items()):
        if session.get("email", "").lower() == normalized:
            SESSIONS.pop(token, None)
            REVOKED_SESSIONS.add(token)

def is_environment_account(email: str) -> bool:
    normalized = email.lower()
    return any(os.getenv(f"{prefix}_EMAIL", "").strip().lower() == normalized for prefix in ("CHARGEFLOW_USER", "CHARGEFLOW_ADMIN"))

def admin_user_rows() -> list[dict[str, Any]]:
    configured = environment_accounts()
    users: dict[str, dict[str, Any]] = {}
    for role, account in configured.items():
        email = account["email"].lower()
        users[email] = {
            "email": email,
            "name": account.get("name") or ("Configured admin" if role == "admin" else "Configured user"),
            "role": account.get("role", role),
            "status": account.get("status", "active"),
            "source": "environment",
            "created_at": None,
            "active_session": any(item.get("email", "").lower() == email for item in SESSIONS.values()),
        }
    with auth_db() as connection:
        for row in connection.execute("SELECT email, name, role, status, created_at FROM users ORDER BY created_at DESC").fetchall():
            email = row["email"].lower()
            if email not in users:
                users[email] = {
                    "email": email,
                    "name": row["name"],
                    "role": row["role"],
                    "status": row["status"],
                    "source": "sqlite",
                    "created_at": row["created_at"],
                    "active_session": any(item.get("email", "").lower() == email for item in SESSIONS.values()),
                }
    return list(users.values())


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
    account = next((value | {"role": value.get("role", role)} for role, value in configured_accounts().items() if value["email"].lower() == normalized_email and value.get("status", "active") == "active" and (verify_password(request.password, value["password"]) if value.get("hashed") else secrets.compare_digest(value["password"], request.password))), None)
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
        connection.execute("INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?)", (normalized_email, request.name.strip(), hash_password(request.password), int(time.time())))
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

@app.get("/account/profile")
def account_profile(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    return get_profile(session["email"], session.get("name", ""))

@app.put("/account/profile")
def update_account_profile(request: ProfileUpdateRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    email = session["email"].lower()
    with auth_db() as connection:
        connection.execute("INSERT INTO profiles (email, display_name, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at", (email, request.display_name.strip(), int(time.time())))
        connection.commit()
    session["name"] = request.display_name.strip()
    record_audit(email, "profile.updated", email, {"display_name": request.display_name.strip()})
    return get_profile(email, request.display_name.strip())

@app.put("/account/avatar")
def update_account_avatar(file: UploadFile = File(...), authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    if file.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=415, detail="Upload a PNG, JPEG, or WebP image")
    content = file.file.read(1024 * 1024 + 1)
    if len(content) > 1024 * 1024:
        raise HTTPException(status_code=413, detail="Avatar must be 1 MB or smaller")
    encoded = base64.b64encode(content).decode("ascii")
    email = session["email"].lower()
    with auth_db() as connection:
        connection.execute("INSERT INTO profiles (email, display_name, avatar_data, avatar_mime, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET avatar_data = excluded.avatar_data, avatar_mime = excluded.avatar_mime, updated_at = excluded.updated_at", (email, session.get("name", email), encoded, file.content_type, int(time.time())))
        connection.commit()
    record_audit(email, "profile.avatar_updated", email, {"mime": file.content_type})
    return get_profile(email, session.get("name", email))

@app.get("/account/settings")
def account_settings(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    return get_settings(session["email"])

@app.put("/account/settings")
def update_account_settings(request: DashboardSettingsRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    email = session["email"].lower()
    settings = request.model_dump()
    with auth_db() as connection:
        connection.execute("INSERT INTO user_settings (email, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at", (email, json.dumps(settings, separators=(",", ":")), int(time.time())))
        connection.commit()
    record_audit(email, "settings.updated", email, settings)
    return settings

@app.get("/account/vehicles")
def account_vehicles(authorization: str | None = Header(default=None)) -> list[dict[str, Any]]:
    session = current_session(authorization)
    with auth_db() as connection:
        rows = connection.execute("SELECT id, name, preferred_plug, battery_percent, created_at FROM user_vehicles WHERE email = ? ORDER BY created_at DESC", (session["email"].lower(),)).fetchall()
    return [dict(row) for row in rows]

@app.post("/account/vehicles")
def add_account_vehicle(request: VehicleRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    session = current_session(authorization)
    email = session["email"].lower()
    with auth_db() as connection:
        cursor = connection.execute("INSERT INTO user_vehicles (email, name, preferred_plug, battery_percent, created_at) VALUES (?, ?, ?, ?, ?)", (email, request.name.strip(), request.preferred_plug, request.battery_percent, int(time.time())))
        connection.commit()
        vehicle_id = cursor.lastrowid
    record_audit(email, "vehicle.added", email, {"name": request.name.strip()})
    return {"id": vehicle_id, "name": request.name.strip(), "preferred_plug": request.preferred_plug, "battery_percent": request.battery_percent}

@app.delete("/account/vehicles/{vehicle_id}")
def delete_account_vehicle(vehicle_id: int, authorization: str | None = Header(default=None)) -> dict[str, bool]:
    session = current_session(authorization)
    email = session["email"].lower()
    with auth_db() as connection:
        result = connection.execute("DELETE FROM user_vehicles WHERE id = ? AND email = ?", (vehicle_id, email))
        connection.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    record_audit(email, "vehicle.deleted", email, {"vehicle_id": vehicle_id})
    return {"success": True}

@app.post("/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    token = (authorization or "").removeprefix("Bearer ").strip()
    SESSIONS.pop(token, None)
    if token:
        REVOKED_SESSIONS.add(token)
    return {"success": True}

@app.get("/admin/overview")
def admin_overview(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_admin(authorization)
    users = admin_user_rows()
    return {"station_count": len(STATIONS), "cities": len({station["city"] for station in STATIONS}), "dataset": DATASET_PATH.name, "active_sessions": len(SESSIONS), "user_count": len(users), "active_users": sum(1 for user in users if user["status"] == "active")}

@app.get("/admin/users")
def admin_users(authorization: str | None = Header(default=None), search: str | None = None) -> list[dict[str, Any]]:
    require_admin(authorization)
    users = admin_user_rows()
    if search:
        needle = search.strip().lower()
        users = [user for user in users if needle in user["email"].lower() or needle in user["name"].lower()]
    return users

@app.patch("/admin/users/{email}/status")
def admin_update_user_status(email: str, request: AccountStatusRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    admin = require_admin(authorization)
    normalized_email = email.strip().lower()
    if is_environment_account(normalized_email) and request.status == "suspended":
        raise HTTPException(status_code=400, detail="Configured environment accounts cannot be suspended here; update the project secret instead")
    with auth_db() as connection:
        result = connection.execute("UPDATE users SET status = ? WHERE email = ?", (request.status, normalized_email))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="User account not found")
        connection.commit()
    if request.status == "suspended":
        revoke_sessions_for_email(normalized_email)
    record_audit(admin["email"], f"user.{request.status}", normalized_email, {"status": request.status})
    return {"email": normalized_email, "status": request.status}

@app.get("/admin/system-status")
def admin_system_status(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_admin(authorization)
    db_exists = AUTH_DB_PATH.exists()
    db_size = AUTH_DB_PATH.stat().st_size if db_exists else 0
    with auth_db() as connection:
        user_rows = connection.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
        reset_rows = connection.execute("SELECT COUNT(*) AS count FROM password_resets WHERE expires_at >= ?", (int(time.time()),)).fetchone()["count"]
    return {
        "service": "healthy",
        "python": platform.python_version(),
        "platform": platform.system(),
        "database": {"engine": "sqlite", "path": str(AUTH_DB_PATH), "exists": db_exists, "bytes": db_size, "users": user_rows, "pending_resets": reset_rows, "writable": os.access(AUTH_DB_PATH.parent, os.W_OK)},
        "dataset": {"path": str(DATASET_PATH), "exists": DATASET_PATH.exists(), "bytes": DATASET_PATH.stat().st_size if DATASET_PATH.exists() else 0, "stations": len(STATIONS)},
        "sessions": {"active": len(SESSIONS), "revoked": len(REVOKED_SESSIONS)},
        "telemetry": telemetry_status(),
        "checked_at": int(time.time()),
    }

@app.post("/admin/password")
def admin_change_password(request: AdminPasswordRequest, authorization: str | None = Header(default=None)) -> dict[str, str]:
    session = require_admin(authorization)
    email = session["email"].lower()
    account = next((account for account in configured_accounts().values() if account["email"].lower() == email), None)
    if not account:
        raise HTTPException(status_code=404, detail="Admin account not found")
    current_matches = verify_password(request.current_password, account["password"]) if account.get("hashed") else secrets.compare_digest(account["password"], request.current_password)
    if not current_matches:
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    with auth_db() as connection:
        connection.execute("INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', status = 'active'", (email, account.get("name", "Configured admin"), hash_password(request.new_password), int(time.time())))
        connection.commit()
    revoke_sessions_for_email(email)
    record_audit(email, "admin.password_changed", email, {})
    return {"message": "Admin password updated. Sign in again with the new password."}

@app.get("/admin/audit")
def admin_audit(limit: int = 50, authorization: str | None = Header(default=None)) -> list[dict[str, Any]]:
    require_admin(authorization)
    limit = max(1, min(200, limit))
    with auth_db() as connection:
        rows = connection.execute("SELECT id, actor_email, action, target_email, details, created_at FROM audit_events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    events: list[dict[str, Any]] = []
    for row in rows:
        try:
            details = json.loads(row["details"])
        except json.JSONDecodeError:
            details = {}
        events.append({"id": row["id"], "actor_email": row["actor_email"], "action": row["action"], "target_email": row["target_email"], "details": details, "created_at": row["created_at"]})
    return events

@app.get("/admin/data-quality")
def admin_data_quality(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_admin(authorization)
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
    return [with_telemetry(station) for station in filtered[:limit]]

@app.get("/telemetry/status")
def public_telemetry_status() -> dict[str, Any]:
    return telemetry_status()

@app.post("/admin/telemetry/refresh")
def admin_refresh_telemetry(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    admin = require_admin(authorization)
    refresh_telemetry(force=True)
    status = telemetry_status()
    record_audit(admin["email"], "telemetry.refreshed", None, {"status": status["status"], "records": status["records"]})
    return status

@app.get("/network/summary")
def network_summary(city: str | None = None) -> dict[str, Any]:
    filtered = [with_telemetry(station) for station in STATIONS if not city or city.lower() in station["city"].lower()]
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
    compatible = [with_telemetry(station) for station in STATIONS if request.preferred_plug.upper() in station["plug_types"]]
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
