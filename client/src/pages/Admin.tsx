import { FormEvent, useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, CheckCircle2, ClipboardList, Database, Gauge, KeyRound, LogOut, RefreshCw, Search, Server, ShieldCheck, SlidersHorizontal, UserCheck, UserX, Users, Zap } from "lucide-react";
import { clearSession, getSession } from "@/lib/auth";

const API_BASE = "/python-api";

type Overview = { station_count: number; cities: number; dataset: string; active_sessions: number; user_count: number; active_users: number };
type Quality = { dataset: string; rows: number; cities: number; missing_coordinates: number; valid_coordinates: number; status: string };
type AdminUser = { email: string; name: string; role: string; status: "active" | "suspended"; source: string; created_at: number | null; active_session: boolean };
type SystemStatus = { service: string; python: string; platform: string; database: { engine: string; path: string; exists: boolean; bytes: number; users: number; pending_resets: number; writable: boolean }; dataset: { path: string; exists: boolean; bytes: number; stations: number }; sessions: { active: number; revoked: number }; telemetry: { configured: boolean; provider: string; status: string; records: number; updated_at: number }; checked_at: number };
type AuditEvent = { id: number; actor_email: string; action: string; target_email: string | null; details: Record<string, unknown>; created_at: number };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Admin() {
  const [, navigate] = useLocation();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "" });
  const [guardrails, setGuardrails] = useState({ compatibility: true, reachability: true });
  const session = getSession();

  const headers: Record<string, string> = session ? { Authorization: `Bearer ${session.token}` } : {};
  const loadAdmin = useCallback(async (isRefresh = false) => {
    if (!session || session.role !== "admin") { navigate("/login"); return; }
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const query = search ? `?search=${encodeURIComponent(search)}` : "";
      const [overviewResponse, qualityResponse, usersResponse, systemResponse, auditResponse] = await Promise.all([
        fetch(`${API_BASE}/admin/overview`, { headers }),
        fetch(`${API_BASE}/admin/data-quality`, { headers }),
        fetch(`${API_BASE}/admin/users${query}`, { headers }),
        fetch(`${API_BASE}/admin/system-status`, { headers }),
        fetch(`${API_BASE}/admin/audit?limit=50`, { headers }),
      ]);
      if ([overviewResponse, qualityResponse, usersResponse, systemResponse, auditResponse].some((response) => response.status === 401 || response.status === 403)) {
        clearSession(); navigate("/login"); return;
      }
      if (![overviewResponse, qualityResponse, usersResponse, systemResponse, auditResponse].every((response) => response.ok)) throw new Error("One or more control-room services could not be loaded");
      setOverview((await overviewResponse.json()) as Overview);
      setQuality((await qualityResponse.json()) as Quality);
      setUsers((await usersResponse.json()) as AdminUser[]);
      setSystem((await systemResponse.json()) as SystemStatus);
      setAuditEvents((await auditResponse.json()) as AuditEvent[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load controls");
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [navigate, search, session]);

  useEffect(() => { void loadAdmin(); }, [loadAdmin]);

  const logout = async () => {
    if (session) await fetch(`${API_BASE}/auth/logout`, { method: "POST", headers }).catch(() => undefined);
    clearSession(); navigate("/login");
  };

  const updateUserStatus = async (user: AdminUser) => {
    const nextStatus = user.status === "active" ? "suspended" : "active";
    const response = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(user.email)}/status`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ status: nextStatus }) });
    const data = await response.json();
    if (!response.ok) { setError(data.detail ?? "Unable to update account status"); return; }
    setNotice(`${user.email} is now ${nextStatus}.`); void loadAdmin(true);
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setNotice("");
    const response = await fetch(`${API_BASE}/admin/password`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(passwords) });
    const data = await response.json();
    if (!response.ok) { setError(data.detail ?? "Unable to update admin password"); return; }
    setPasswords({ current_password: "", new_password: "" }); setNotice(data.message); setTimeout(() => { clearSession(); navigate("/login"); }, 900);
  };

  const toggleGuardrail = (key: "compatibility" | "reachability") => {
    setGuardrails((current) => { const next = { ...current, [key]: !current[key] }; setNotice(`${key === "compatibility" ? "Plug compatibility" : "Reachability guardrail"} ${next[key] ? "enabled" : "disabled"} for this admin session.`); return next; });
  };

  if (!session || session.role !== "admin") return null;

  return <div className="admin-shell">
    <header className="admin-topbar"><div className="brand-lockup"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><div className="brand-name">charge<span>flow</span></div><div className="brand-caption">Control room</div></div></div><div className="admin-user"><span className="admin-badge"><ShieldCheck size={13} /> ADMIN</span><span>{session.email}</span><button onClick={logout}><LogOut size={15} /> Sign out</button></div></header>
    <main className="admin-content">
      <div className="admin-toolbar"><button className="back-link" onClick={() => navigate("/")}><ArrowLeft size={15} /> Back to dashboard</button><button className="admin-refresh" onClick={() => void loadAdmin(true)} disabled={refreshing}><RefreshCw size={14} className={refreshing ? "spin" : ""} /> {refreshing ? "Refreshing" : "Refresh data"}</button></div>
      <div className="admin-heading"><div><div className="eyebrow">Restricted controls</div><h1>Network control room</h1><p>Monitor users, data integrity, sessions, and the recommendation service.</p></div><div className="admin-live"><span /> Admin session active</div></div>
      {error && <div className="auth-error">{error}</div>}{notice && <div className="auth-success">{notice}</div>}
      <section className="admin-metrics"><div className="admin-stat"><Database size={18} /><span>Stations loaded</span><strong>{overview?.station_count ?? "—"}</strong><small>from India CSV</small></div><div className="admin-stat"><Users size={18} /><span>Registered users</span><strong>{overview?.user_count ?? "—"}</strong><small>{overview?.active_users ?? "—"} active accounts</small></div><div className="admin-stat"><Server size={18} /><span>Service status</span><strong className="admin-status-value">{system?.service?.toUpperCase() ?? (loading ? "CHECKING" : "—")}</strong><small>{system ? `${system.sessions.active} active sessions` : "runtime health"}</small></div></section>
      <section className="admin-section"><div className="admin-section-heading"><div><div className="eyebrow">Account directory</div><h2>Users and access status</h2></div><div className="user-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadAdmin(true); }} placeholder="Search email or name" /><button onClick={() => void loadAdmin(true)}>Search</button></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Role</th><th>Source</th><th>Status</th><th>Session</th><th /></tr></thead><tbody>{users.length === 0 && !loading ? <tr><td colSpan={6} className="admin-empty">No users match this search.</td></tr> : users.map((user) => <tr key={user.email}><td><strong>{user.name}</strong><span>{user.email}</span></td><td><span className={`role-pill ${user.role}`}>{user.role}</span></td><td>{user.source}</td><td><span className={`status-pill ${user.status}`}>{user.status}</span></td><td>{user.active_session ? <span className="session-live"><span /> Active</span> : <span className="session-muted">No active session</span>}</td><td><button className="table-action" onClick={() => void updateUserStatus(user)} disabled={user.source === "environment" && user.status === "active"}>{user.status === "active" ? <><UserX size={13} /> Suspend</> : <><UserCheck size={13} /> Restore</>}</button></td></tr>)}</tbody></table></div></section>
      <section className="admin-section audit-section"><div className="admin-section-heading"><div><div className="eyebrow">Accountability</div><h2>Recent admin activity</h2></div><span className="audit-count">{auditEvents.length} events</span></div><div className="audit-list">{auditEvents.length === 0 ? <div className="admin-empty">No admin activity recorded yet.</div> : auditEvents.map((event) => <div className="audit-row" key={event.id}><div className="audit-icon"><ClipboardList size={15} /></div><div><strong>{event.action.replaceAll(".", " / ")}</strong><span>{event.actor_email}{event.target_email ? ` → ${event.target_email}` : ""}</span></div><time>{new Date(event.created_at * 1000).toLocaleString()}</time></div>)}</div></section>
      <section className="admin-grid"><div className="admin-card"><div className="admin-card-title"><Server size={17} /><h2>Database and runtime</h2></div><p>Live storage and service state for this ChargeFlow instance.</p><div className="health-list"><div><span>Auth database</span><strong className={system?.database.exists ? "healthy" : "warning"}><CheckCircle2 size={13} /> {system?.database.exists ? "Available" : "Not created"}</strong><small>{system?.database.engine ?? "—"} · {system ? formatBytes(system.database.bytes) : "—"}</small></div><div><span>Database writes</span><strong className={system?.database.writable ? "healthy" : "warning"}><CheckCircle2 size={13} /> {system?.database.writable ? "Writable" : "Read only"}</strong><small>{system?.database.users ?? 0} stored user records</small></div><div><span>Station dataset</span><strong className={system?.dataset.exists ? "healthy" : "warning"}><CheckCircle2 size={13} /> {system?.dataset.exists ? "Loaded" : "Missing"}</strong><small>{system?.dataset.stations ?? 0} stations · {system ? formatBytes(system.dataset.bytes) : "—"}</small></div><div><span>Python service</span><strong className="healthy"><CheckCircle2 size={13} /> Online</strong><small>Python {system?.python ?? "—"} · {system?.platform ?? "—"}</small></div><div><span>Live telemetry</span><strong className={system?.telemetry.status === "connected" ? "healthy" : "warning"}><CheckCircle2 size={13} /> {system?.telemetry.status === "connected" ? "Connected" : "Dataset fallback"}</strong><small>{system?.telemetry.configured ? `${system.telemetry.provider} · ${system.telemetry.records} records` : "Provider credentials not configured"}</small></div></div></div><div className="admin-card"><div className="admin-card-title"><KeyRound size={17} /><h2>Change admin password</h2></div><p>Rotation revokes active admin sessions and requires you to sign in again.</p><form className="admin-password-form" onSubmit={changePassword}><label>Current password<input type="password" value={passwords.current_password} onChange={(event) => setPasswords({ ...passwords, current_password: event.target.value })} required /></label><label>New password<input type="password" minLength={8} value={passwords.new_password} onChange={(event) => setPasswords({ ...passwords, new_password: event.target.value })} placeholder="At least 8 characters" required /></label><button className="admin-action primary" type="submit">Update password <ArrowLeft size={14} /></button></form></div></section>
      <section className="admin-grid"><div className="admin-card"><div className="admin-card-title"><Gauge size={17} /><h2>Model controls</h2></div><p>Control which guardrails apply to recommendations for this session.</p><div className="control-row"><div><strong>Prediction strategy</strong><span>Current serving mode</span></div><select defaultValue="heuristic-v1" onChange={(event) => setNotice(`Prediction strategy set to ${event.target.value}.`)}><option value="heuristic-v1">Reproducible heuristic</option><option value="random-forest">Random Forest (when trained)</option></select></div><div className="control-row"><div><strong>Require plug compatibility</strong><span>Filter incompatible connectors</span></div><button className={`toggle ${guardrails.compatibility ? "on" : ""}`} onClick={() => toggleGuardrail("compatibility")} aria-pressed={guardrails.compatibility}><span /></button></div><div className="control-row"><div><strong>Reachability guardrail</strong><span>Reject unsafe recommendations</span></div><button className={`toggle ${guardrails.reachability ? "on" : ""}`} onClick={() => toggleGuardrail("reachability")} aria-pressed={guardrails.reachability}><span /></button></div></div><div className="admin-card"><div className="admin-card-title"><SlidersHorizontal size={17} /><h2>Dataset quality</h2></div><p>Review the active source powering station search and recommendations.</p><div className="dataset-box"><div className="dataset-icon"><Database size={20} /></div><div><strong>{quality?.dataset ?? overview?.dataset ?? "ev-charging-stations-india.csv"}</strong><span>{quality ? `${quality.valid_coordinates} valid coordinates · ${quality.missing_coordinates} missing` : "Loading quality report"}</span></div><span className="dataset-status">{quality?.status?.toUpperCase() ?? "LOADING"}</span></div><button className="admin-action" onClick={() => setNotice(quality ? `${quality.dataset}: ${quality.valid_coordinates} valid station coordinates across ${quality.cities} cities.` : "Quality report is still loading.")}>Review data quality <ArrowLeft size={14} /></button></div></section>
    </main>
  </div>;
}
