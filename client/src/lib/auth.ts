export type SessionUser = {
  token: string;
  email: string;
  role: "user" | "admin";
};

const SESSION_KEY = "chargeflow-session";

export function getSession(): SessionUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: SessionUser) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}
