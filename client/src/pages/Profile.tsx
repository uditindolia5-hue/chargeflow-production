import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, LogOut, Save, UserRound } from "lucide-react";
import { useLocation } from "wouter";
import { clearSession, getSession } from "@/lib/auth";

const API_BASE = "/python-api";

export default function Profile() {
  const [, navigate] = useLocation();
  const session = getSession();
  const [displayName, setDisplayName] = useState("");
  const [vehicleName, setVehicleName] = useState("");
  const [preferredPlug, setPreferredPlug] = useState("CCS");
  const [batteryPercent, setBatteryPercent] = useState(18);
  const [city, setCity] = useState("New Delhi");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session) { navigate("/login"); return; }
    const headers = { Authorization: `Bearer ${session.token}` };
    void Promise.all([
      fetch(`${API_BASE}/account/profile`, { headers }).then((response) => response.json()),
      fetch(`${API_BASE}/account/settings`, { headers }).then((response) => response.json()),
    ]).then(([profile, settings]) => {
      setDisplayName(profile.display_name ?? session.email);
      setVehicleName(settings.vehicle_name ?? "Polestar 2 Long Range");
      setPreferredPlug(settings.preferred_plug ?? "CCS");
      setBatteryPercent(settings.battery_percent ?? 18);
      setCity(settings.city ?? "New Delhi");
    }).catch(() => setError("Unable to load your profile right now.")).finally(() => setLoading(false));
  }, [navigate, session?.token]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!session) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
      const [profileResponse, settingsResponse] = await Promise.all([
        fetch(`${API_BASE}/account/profile`, { method: "PUT", headers, body: JSON.stringify({ display_name: displayName }) }),
        fetch(`${API_BASE}/account/settings`, { method: "PUT", headers, body: JSON.stringify({ vehicle_name: vehicleName, preferred_plug: preferredPlug, battery_percent: batteryPercent, city }) }),
      ]);
      if (!profileResponse.ok || !settingsResponse.ok) throw new Error("Profile changes could not be saved");
      setNotice("Profile and dashboard settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save profile");
    } finally { setSaving(false); }
  };

  const logout = async () => {
    if (session) await fetch(`${API_BASE}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${session.token}` } }).catch(() => undefined);
    clearSession(); navigate("/login");
  };

  if (!session || loading) return <div className="profile-loading">Loading profile…</div>;

  return <div className="profile-shell">
    <header className="profile-topbar"><button className="back-link" onClick={() => navigate("/")}><ArrowLeft size={15} /> Back to dashboard</button><button className="profile-logout" onClick={() => void logout}><LogOut size={15} /> Sign out</button></header>
    <main className="profile-content">
      <div className="eyebrow">Account center</div>
      <h1>Your profile</h1>
      <p className="profile-intro">Keep your ChargeFlow identity and charging preferences ready on every device.</p>
      {error && <div className="auth-error">{error}</div>}{notice && <div className="auth-success"><CheckCircle2 size={15} /> {notice}</div>}
      <form className="profile-grid" onSubmit={save}>
        <section className="profile-card profile-identity"><div className="profile-icon"><UserRound size={24} /></div><div className="eyebrow">Signed-in account</div><h2>{session.email}</h2><span className="profile-role">{session.role}</span><p>Your account identity is used for dashboard settings and administrative access.</p></section>
        <section className="profile-card"><div className="profile-card-heading"><div><div className="eyebrow">Personal details</div><h2>Account identity</h2></div></div><label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={120} required /></label><label>Email address<input value={session.email} disabled /></label></section>
        <section className="profile-card"><div className="profile-card-heading"><div><div className="eyebrow">Charging setup</div><h2>Dashboard preferences</h2></div></div><label>Vehicle name<input value={vehicleName} onChange={(event) => setVehicleName(event.target.value)} minLength={2} required /></label><label>Preferred connector<select value={preferredPlug} onChange={(event) => setPreferredPlug(event.target.value)}><option>CCS</option><option>Type 2</option><option>NACS</option></select></label><label>Usual city<select value={city} onChange={(event) => setCity(event.target.value)}><option>New Delhi</option><option>Gurugram</option><option>Bengaluru</option><option>Mumbai</option></select></label><label>Current battery: {batteryPercent}%<input type="range" min="10" max="100" value={batteryPercent} onChange={(event) => setBatteryPercent(Number(event.target.value))} /></label></section>
        <div className="profile-actions"><button className="admin-action primary" type="submit" disabled={saving}><Save size={15} /> {saving ? "Saving…" : "Save changes"}</button></div>
      </form>
    </main>
  </div>;
}

void 0;

export { Profile };
