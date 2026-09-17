import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, LogOut, Save, UserRound } from "lucide-react";
import { useLocation } from "wouter";
import { clearSession, getSession } from "@/lib/auth";

const API_BASE = "/python-api";
type Vehicle = { id: number; name: string; preferred_plug: string; battery_percent: number };

export default function Profile() {
  const [, navigate] = useLocation();
  const session = getSession();
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [newVehicle, setNewVehicle] = useState({ name: "", preferred_plug: "CCS", battery_percent: 50 });
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
      fetch(`${API_BASE}/account/vehicles`, { headers }).then((response) => response.json()),
    ]).then(([profile, settings, vehicleRows]) => {
      setDisplayName(profile.display_name ?? session.email);
      setAvatarUrl(profile.avatar_url ?? null);
      setVehicleName(settings.vehicle_name ?? "Polestar 2 Long Range");
      setPreferredPlug(settings.preferred_plug ?? "CCS");
      setBatteryPercent(settings.battery_percent ?? 18);
      setCity(settings.city ?? "New Delhi");
      setVehicles(vehicleRows as Vehicle[]);
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

  const uploadAvatar = async (file: File) => {
    if (!session) return;
    setError("");
    const body = new FormData(); body.append("file", file);
    const response = await fetch(`${API_BASE}/account/avatar`, { method: "PUT", headers: { Authorization: `Bearer ${session.token}` }, body });
    const data = await response.json();
    if (!response.ok) { setError(data.detail ?? "Unable to upload avatar"); return; }
    setAvatarUrl(data.avatar_url ?? null); setNotice("Profile photo updated.");
  };

  const addVehicle = async () => {
    if (!session || !newVehicle.name.trim()) return;
    const response = await fetch(`${API_BASE}/account/vehicles`, { method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...newVehicle, name: newVehicle.name.trim() }) });
    const data = await response.json();
    if (!response.ok) { setError(data.detail ?? "Unable to add vehicle"); return; }
    setVehicles((current) => [data as Vehicle, ...current]); setNewVehicle({ name: "", preferred_plug: "CCS", battery_percent: 50 }); setNotice("Vehicle added to your account.");
  };

  const deleteVehicle = async (vehicle: Vehicle) => {
    if (!session) return;
    const response = await fetch(`${API_BASE}/account/vehicles/${vehicle.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
    if (!response.ok) { setError("Unable to remove vehicle"); return; }
    setVehicles((current) => current.filter((item) => item.id !== vehicle.id)); setNotice(`${vehicle.name} removed.`);
  };

  const useVehicle = (vehicle: Vehicle) => {
    setVehicleName(vehicle.name); setPreferredPlug(vehicle.preferred_plug); setBatteryPercent(vehicle.battery_percent); setNotice(`${vehicle.name} selected. Save changes to make it your active dashboard vehicle.`);
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
        <section className="profile-card profile-identity"><label className="avatar-upload">{avatarUrl ? <img src={avatarUrl} alt="Profile avatar" /> : <div className="profile-icon"><UserRound size={24} /></div>}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); }} /><span>Change photo</span></label><div className="eyebrow">Signed-in account</div><h2>{session.email}</h2><span className="profile-role">{session.role}</span><p>Your account identity is used for dashboard settings and administrative access.</p></section>
        <section className="profile-card"><div className="profile-card-heading"><div><div className="eyebrow">Personal details</div><h2>Account identity</h2></div></div><label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={120} required /></label><label>Email address<input value={session.email} disabled /></label></section>
        <section className="profile-card"><div className="profile-card-heading"><div><div className="eyebrow">Charging setup</div><h2>Dashboard preferences</h2></div></div><label>Vehicle name<input value={vehicleName} onChange={(event) => setVehicleName(event.target.value)} minLength={2} required /></label><label>Preferred connector<select value={preferredPlug} onChange={(event) => setPreferredPlug(event.target.value)}><option>CCS</option><option>Type 2</option><option>NACS</option></select></label><label>Usual city<select value={city} onChange={(event) => setCity(event.target.value)}><option>New Delhi</option><option>Gurugram</option><option>Bengaluru</option><option>Mumbai</option></select></label><label>Current battery: {batteryPercent}%<input type="range" min="10" max="100" value={batteryPercent} onChange={(event) => setBatteryPercent(Number(event.target.value))} /></label></section>
        <section className="profile-card profile-vehicles"><div className="profile-card-heading"><div><div className="eyebrow">Garage</div><h2>Your vehicles</h2></div></div>{vehicles.length === 0 ? <p className="muted-copy">Add a second vehicle to switch charging preferences quickly.</p> : <div className="vehicle-list">{vehicles.map((vehicle) => <div className="vehicle-item" key={vehicle.id}><div><strong>{vehicle.name}</strong><span>{vehicle.preferred_plug} · {vehicle.battery_percent}% starting charge</span></div><div className="vehicle-actions"><button type="button" onClick={() => useVehicle(vehicle)}>Use</button><button type="button" onClick={() => void deleteVehicle(vehicle)}>Remove</button></div></div>)}</div>}<div className="vehicle-add"><input value={newVehicle.name} onChange={(event) => setNewVehicle({ ...newVehicle, name: event.target.value })} placeholder="Add vehicle name" /><select value={newVehicle.preferred_plug} onChange={(event) => setNewVehicle({ ...newVehicle, preferred_plug: event.target.value })}><option>CCS</option><option>Type 2</option><option>NACS</option></select><button type="button" onClick={() => void addVehicle()}>Add vehicle</button></div></section>
        <div className="profile-actions"><button className="admin-action primary" type="submit" disabled={saving}><Save size={15} /> {saving ? "Saving…" : "Save changes"}</button></div>
      </form>
    </main>
  </div>;
}

export { Profile };
