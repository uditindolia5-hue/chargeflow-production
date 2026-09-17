import { FormEvent, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Chrome, LockKeyhole, ShieldCheck, Sparkles, UserRound, Zap } from "lucide-react";
import { saveSession, type SessionUser } from "@/lib/auth";

const API_BASE = "/python-api";
const GOOGLE_ENABLED = import.meta.env.VITE_GOOGLE_ENABLED === "true";

export default function Login() {
  const [location, navigate] = useLocation();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    const token = params.get("token");
    const returnedEmail = params.get("email");
    if (token && returnedEmail) {
      saveSession({ token, email: returnedEmail, role: (params.get("role") as "user" | "admin") ?? "user" });
      window.history.replaceState({}, document.title, "/login");
      navigate("/");
    }
  }, [location, navigate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const endpoint = mode === "register" ? "/auth/register" : "/auth/login";
      const body = mode === "register" ? { name, email, password } : { email, password };
      const response = await fetch(`${API_BASE}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "Unable to continue");
      saveSession(data as SessionUser);
      navigate(data.role === "admin" ? "/admin" : "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to continue");
    } finally {
      setBusy(false);
    }
  };

  const startGoogle = () => {
    if (!GOOGLE_ENABLED) { setError("Gmail sign-in is not configured yet. Add Google OAuth credentials to enable it."); return; }
    window.location.href = `${API_BASE}/auth/google/start`;
  };

  return (
    <div className="auth-shell">
      <div className="auth-aside"><div className="brand-lockup"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><div className="brand-name">charge<span>flow</span></div><div className="brand-caption">EV intelligence, in motion</div></div></div><div className="auth-promise"><div className="eyebrow">India charging intelligence</div><h1>Every stop,<br /><em>better planned.</em></h1><p>Find a reachable charger, compare predicted waits, and make the next kilometre count.</p><div className="auth-proof"><span><ShieldCheck size={15} /> Dataset-backed recommendations</span><span><Sparkles size={15} /> Explainable decision trace</span></div></div><div className="auth-aside-foot">CHARGEFLOW / SECURE ACCESS</div></div>
      <main className="auth-main"><div className="auth-card"><div className="auth-icon"><LockKeyhole size={20} /></div><div className="eyebrow">{mode === "register" ? "First-time user" : "Welcome back"}</div><h2>{mode === "register" ? "Create your ChargeFlow account" : "Sign in to ChargeFlow"}</h2><p className="auth-intro">{mode === "register" ? "Create a free user account and start planning your next charge." : "Use your account to open the India network dashboard."}</p><form onSubmit={submit}>{mode === "register" && <label>Your name<div className="auth-input"><UserRound size={16} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" required /></div></label>}<label>Email address<div className="auth-input"><UserRound size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></div></label><label>Password<div className="auth-input"><LockKeyhole size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "register" ? "At least 8 characters" : "Enter your password"} minLength={mode === "register" ? 8 : undefined} required /></div></label>{error && <div className="auth-error">{error}</div>}<button className="auth-submit" disabled={busy}>{busy ? "Please wait..." : mode === "register" ? "Create account and continue" : "Continue to ChargeFlow"}<ArrowRight size={16} /></button></form><button className="forgot-link" onClick={() => navigate("/reset-password")}>Forgot your password?</button><div className="auth-divider"><span>or</span></div><button className="google-button" onClick={startGoogle}><Chrome size={16} /> Continue with Gmail</button><div className="auth-switch">{mode === "register" ? "Already have an account?" : "New to ChargeFlow?"} <button onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Sign in" : "Create an account"}</button></div></div></main>
    </div>
  );
}
