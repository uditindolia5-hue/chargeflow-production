import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Database, Gauge, LogOut, MapPinned, ShieldCheck, SlidersHorizontal, Users, Zap } from "lucide-react";
import { clearSession, getSession } from "@/lib/auth";

const API_BASE = "/python-api";

type Overview = { station_count: number; cities: number; dataset: string; active_sessions: number };
type Quality = { dataset: string; rows: number; cities: number; missing_coordinates: number; valid_coordinates: number; status: string };

export default function Admin() {
  const [, navigate] = useLocation();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [guardrails, setGuardrails] = useState({ compatibility: true, reachability: true });
  const session = getSession();

  useEffect(() => {
    if (!session || session.role !== "admin") { navigate("/login"); return; }
    const headers = { Authorization: `Bearer ${session.token}` };
    Promise.all([
      fetch(`${API_BASE}/admin/overview`, { headers }),
      fetch(`${API_BASE}/admin/data-quality`, { headers }),
    ]).then(async ([overviewResponse, qualityResponse]) => {
      if (!overviewResponse.ok || !qualityResponse.ok) throw new Error("Admin authorization required");
      setOverview((await overviewResponse.json()) as Overview);
      setQuality((await qualityResponse.json()) as Quality);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load controls"));
  }, [navigate, session]);

  const logout = async () => {
    if (session) await fetch(`${API_BASE}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${session.token}` } }).catch(() => undefined);
    clearSession();
    navigate("/login");
  };

  const toggleGuardrail = (key: "compatibility" | "reachability") => {
    setGuardrails((current) => {
      const next = { ...current, [key]: !current[key] };
      setNotice(`${key === "compatibility" ? "Plug compatibility" : "Reachability guardrail"} ${next[key] ? "enabled" : "disabled"} for this admin session.`);
      return next;
    });
  };

  const reviewQuality = () => {
    if (!quality) return;
    setNotice(`${quality.dataset}: ${quality.valid_coordinates} valid station coordinates across ${quality.cities} cities.`);
  };

  if (!session || session.role !== "admin") return null;

  return <div className="admin-shell"><header className="admin-topbar"><div className="brand-lockup"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><div className="brand-name">charge<span>flow</span></div><div className="brand-caption">Control room</div></div></div><div className="admin-user"><span className="admin-badge"><ShieldCheck size={13} /> ADMIN</span><span>{session.email}</span><button onClick={logout}><LogOut size={15} /> Sign out</button></div></header><main className="admin-content"><button className="back-link" onClick={() => navigate("/")}><ArrowLeft size={15} /> Back to dashboard</button><div className="admin-heading"><div><div className="eyebrow">Restricted controls</div><h1>Network control room</h1><p>Manage the India station intelligence layer and review system health.</p></div><div className="admin-live"><span /> Admin session active</div></div>{error && <div className="auth-error">{error}</div>}{notice && <div className="auth-success">{notice}</div>}<section className="admin-metrics"><div className="admin-stat"><Database size={18} /><span>Stations loaded</span><strong>{overview?.station_count ?? "—"}</strong><small>from India CSV</small></div><div className="admin-stat"><MapPinned size={18} /><span>Mapped cities</span><strong>{overview?.cities ?? "—"}</strong><small>with valid coordinates</small></div><div className="admin-stat"><Users size={18} /><span>Active sessions</span><strong>{overview?.active_sessions ?? "—"}</strong><small>current service process</small></div></section><section className="admin-grid"><div className="admin-card"><div className="admin-card-title"><Gauge size={17} /><h2>Model controls</h2></div><p>Control which guardrails apply to recommendations for this session.</p><div className="control-row"><div><strong>Prediction strategy</strong><span>Current serving mode</span></div><select defaultValue="heuristic-v1" onChange={(event) => setNotice(`Prediction strategy set to ${event.target.value}.`)}><option value="heuristic-v1">Reproducible heuristic</option><option value="random-forest">Random Forest (when trained)</option></select></div><div className="control-row"><div><strong>Require plug compatibility</strong><span>Filter incompatible connectors</span></div><button className={`toggle ${guardrails.compatibility ? "on" : ""}`} onClick={() => toggleGuardrail("compatibility")} aria-pressed={guardrails.compatibility}><span /></button></div><div className="control-row"><div><strong>Reachability guardrail</strong><span>Reject unsafe recommendations</span></div><button className={`toggle ${guardrails.reachability ? "on" : ""}`} onClick={() => toggleGuardrail("reachability")} aria-pressed={guardrails.reachability}><span /></button></div></div><div className="admin-card"><div className="admin-card-title"><SlidersHorizontal size={17} /><h2>Dataset controls</h2></div><p>Review the active source powering station search and recommendations.</p><div className="dataset-box"><div className="dataset-icon"><Database size={20} /></div><div><strong>{quality?.dataset ?? overview?.dataset ?? "ev-charging-stations-india.csv"}</strong><span>{quality ? `${quality.valid_coordinates} valid coordinates · ${quality.missing_coordinates} missing` : "Loading quality report"}</span></div><span className="dataset-status">{quality?.status?.toUpperCase() ?? "LOADING"}</span></div><button className="admin-action" onClick={reviewQuality}>Review data quality <ArrowLeft size={14} /></button></div></section></main></div>;
}
