import { FormEvent, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Chrome, LockKeyhole, ShieldCheck, Sparkles, UserRound, Zap } from "lucide-react";
import { saveSession, type SessionUser } from "@/lib/auth";

const API_BASE = "/python-api";
type Mode = "login" | "register" | "verify";

export default function Login() {
  const [location, navigate] = useLocation();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    const token = params.get("token");
    const returnedEmail = params.get("email");
    const oauthError = params.get("error");
    if (oauthError) {
      setError(oauthError === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in could not be completed. Please try again.");
      window.history.replaceState({}, document.title, "/login");
    }
    if (token && returnedEmail) {
      saveSession({ token, email: returnedEmail, role: (params.get("role") as "user" | "admin") ?? "user" });
      window.history.replaceState({}, document.title, "/login");
      navigate("/");
    }
  }, [location, navigate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      if (mode === "verify") {
        const response = await fetch(`${API_BASE}/auth/register/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: pendingEmail, code }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? "Unable to verify your email");
        saveSession(data as SessionUser); navigate("/"); return;
      }
      const endpoint = mode === "register" ? "/auth/register" : "/auth/login";
      const body = mode === "register" ? { name, email, password } : { email, password };
      const response = await fetch(`${API_BASE}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "Unable to continue");
      if (data.verification_required) {
        setPendingEmail(data.email); setEmail(data.email); setMode("verify"); setNotice("We sent a 6-digit verification code to your email. It expires in 10 minutes."); return;
      }
      saveSession(data as SessionUser); navigate(data.role === "admin" ? "/admin" : "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to continue");
    } finally { setBusy(false); }
  };

  const resendCode = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${API_BASE}/auth/register/resend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: pendingEmail }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "Unable to resend code");
      setNotice("A new verification code was sent. It expires in 10 minutes.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to resend code"); }
    finally { setBusy(false); }
  };

  const startGoogle = async () => {
    setBusy(true); setError("");
    try {
      const callback = `${window.location.origin}${API_BASE}/auth/google/callback`;
      const configResponse = await fetch(`${API_BASE}/auth/google/config?redirect_uri=${encodeURIComponent(callback)}`);
      const config = await configResponse.json().catch(() => ({}));
      if (!config.enabled) throw new Error(config.redirect_uri_configured ? "Google sign-in is enabled for the published ChargeFlow domain. Open the published website to continue with Google." : "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the project secrets.");
      window.location.href = `${API_BASE}/auth/google/start?redirect_uri=${encodeURIComponent(callback)}`;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Google sign-in is unavailable right now."); setBusy(false); }
  };

  const switchMode = () => { setMode(mode === "register" || mode === "verify" ? "login" : "register"); setError(""); setNotice(""); setCode(""); };
  const isVerify = mode === "verify";

  return (
    <div className="auth-shell">
      <div className="auth-aside"><div className="brand-lockup"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><div className="brand-name">charge<span>flow</span></div><div className="brand-caption">EV intelligence, in motion</div></div></div><div className="auth-promise"><div className="eyebrow">India charging intelligence</div><h1>Every stop,<br /><em>better planned.</em></h1><p>Find a reachable charger, compare predicted waits, and make the next kilometre count.</p><div className="auth-proof"><span><ShieldCheck size={15} /> Dataset-backed recommendations</span><span><Sparkles size={15} /> Explainable decision trace</span></div></div><div className="auth-aside-foot">CHARGEFLOW / SECURE ACCESS</div></div>
      <main className="auth-main"><div className="auth-card"><div className="auth-icon"><LockKeyhole size={20} /></div><div className="eyebrow">{isVerify ? "Email verification" : mode === "register" ? "First-time user" : "Welcome back"}</div><h2>{isVerify ? "Verify your email" : mode === "register" ? "Create your ChargeFlow account" : "Sign in to ChargeFlow"}</h2><p className="auth-intro">{isVerify ? `Enter the code sent to ${pendingEmail}.` : mode === "register" ? "Create a free user account and start planning your next charge." : "Use your account to open the India network dashboard."}</p>
        <form onSubmit={submit}>{isVerify ? <label>6-digit verification code<div className="auth-input"><ShieldCheck size={16} /><input inputMode="numeric" pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Enter 6-digit code" minLength={6} maxLength={6} required /></div></label> : <>{mode === "register" && <label>Your name<div className="auth-input"><UserRound size={16} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" required /></div></label>}<label>Email address<div className="auth-input"><UserRound size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></div></label><label>Password<div className="auth-input"><LockKeyhole size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "register" ? "At least 8 characters" : "Enter your password"} minLength={mode === "register" ? 8 : undefined} required /></div></label></>}{error && <div className="auth-error">{error}</div>}{notice && <div className="auth-success">{notice}</div>}<button className="auth-submit" disabled={busy}>{busy ? "Please wait..." : isVerify ? "Verify email and continue" : mode === "register" ? "Continue with email verification" : "Continue to ChargeFlow"}<ArrowRight size={16} /></button></form>
        {isVerify ? <><button className="forgot-link" type="button" onClick={() => void resendCode()} disabled={busy}>Resend verification code</button><button className="auth-switch" type="button" onClick={() => { setMode("register"); setError(""); setNotice(""); }}>Use a different email</button></> : <><button className="forgot-link" type="button" onClick={() => navigate("/reset-password")}>Forgot your password?</button><div className="auth-divider"><span>or</span></div><button type="button" className="google-button" onClick={() => void startGoogle()} disabled={busy}><Chrome size={16} /> Continue with Google</button><div className="auth-switch">{mode === "register" ? "Already have an account?" : "New to ChargeFlow?"} <button type="button" onClick={switchMode}>{mode === "register" ? "Sign in" : "Create an account"}</button></div></>}
      </div></main>
    </div>
  );
}
