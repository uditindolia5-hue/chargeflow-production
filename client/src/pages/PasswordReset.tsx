import { FormEvent, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, KeyRound, LockKeyhole } from "lucide-react";

const API_BASE = "/python-api";

export default function PasswordReset() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const requestReset = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    const response = await fetch(`${API_BASE}/auth/password-reset/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const data = await response.json();
    if (!response.ok) { setError(data.detail ?? "Unable to request reset"); return; }
    setMessage(data.development_token ? `Development reset token: ${data.development_token}` : data.message);
    if (data.development_token) setToken(data.development_token);
  };

  const confirmReset = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    const response = await fetch(`${API_BASE}/auth/password-reset/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }) });
    const data = await response.json();
    if (!response.ok) { setError(data.detail ?? "Unable to update password"); return; }
    setMessage(data.message); setTimeout(() => navigate("/login"), 900);
  };

  return <div className="auth-shell"><div className="auth-aside"><div className="brand-lockup"><div className="brand-mark"><KeyRound size={19} /></div><div><div className="brand-name">charge<span>flow</span></div><div className="brand-caption">Secure account recovery</div></div></div><div className="auth-promise"><div className="eyebrow">Account recovery</div><h1>Back on the<br /><em>right route.</em></h1><p>Request a secure reset token, choose a new password, and return to your India charging dashboard.</p></div></div><main className="auth-main"><div className="auth-card"><button className="back-link" onClick={() => navigate("/login")}><ArrowLeft size={15} /> Back to sign in</button><div className="auth-icon"><LockKeyhole size={20} /></div><div className="eyebrow">Password reset</div><h2>Recover your account</h2><p className="auth-intro">Enter your registered email to request a reset link.</p><form onSubmit={requestReset}><label>Email address<div className="auth-input"><KeyRound size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></div></label><button className="auth-submit">Request reset token <ArrowRight size={16} /></button></form><div className="reset-divider">Then choose a new password</div><form onSubmit={confirmReset}><label>Reset token<div className="auth-input"><KeyRound size={16} /><input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste your reset token" required /></div></label><label>New password<div className="auth-input"><LockKeyhole size={16} /><input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" required /></div></label><button className="google-button" type="submit">Update password</button></form>{message && <div className="auth-success">{message}</div>}{error && <div className="auth-error">{error}</div>}</div></main></div>;
}
