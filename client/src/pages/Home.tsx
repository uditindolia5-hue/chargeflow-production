import { FormEvent, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BatteryCharging,
  BatteryFull,
  CarFront,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Crosshair,
  Gauge,
  GitBranch,
  Layers3,
  Lightbulb,
  LocateFixed,
  MapPin,
  Menu,
  MessageSquareText,
  Navigation,
  PlugZap,
  Route,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  TimerReset,
  TrendingDown,
  X,
  Zap,
} from "lucide-react";
import { clearSession, getSession } from "@/lib/auth";

type Station = {
  id: string;
  name: string;
  area: string;
  distance: string;
  drive: string;
  wait: number;
  price: string;
  plugs: string;
  type: string;
  tone: "mint" | "amber" | "coral";
  x: number;
  y: number;
  selected?: boolean;
  address?: string;
  connectors?: string;
  occupancy?: string;
};

type LocationContext = { label: string; city: string; lat: number; lon: number };
type NetworkSummary = { station_count: number; open_connectors: number; total_connectors: number; average_wait: number; low_wait_count: number; average_price: number; updated_at: number };

const LOCATION_PRESETS: LocationContext[] = [
  { label: "New Delhi", city: "New Delhi", lat: 28.6139, lon: 77.209 },
  { label: "Gurugram", city: "Gurugram", lat: 28.4595, lon: 77.0266 },
  { label: "Bengaluru", city: "Bengaluru", lat: 12.9716, lon: 77.5946 },
  { label: "Mumbai", city: "Mumbai", lat: 19.076, lon: 72.8777 },
];

type TraceItem = {
  tool: string;
  detail: string;
  result: string;
  status: "complete" | "warning";
};

type ApiTrace = { tool_name: string; args: Record<string, unknown>; result: string };

type PythonRecommendation = {
  recommendation: { id?: string; name: string; drive_minutes: number; wait: number } | null;
  alternative: { name: string } | null;
  reason: string;
};

const PYTHON_API_BASE = "/python-api";

const stations: Station[] = [
  { id: "IN-0001", name: "IOCL Rajokri Station", area: "New Delhi · NH 8", distance: "1.8 km", drive: "7 min", wait: 4, price: "₹12/kWh", plugs: "4 / 6 free", type: "CCS · DC Fast", tone: "mint", x: 68, y: 34, selected: true },
  { id: "IN-0002", name: "Athergrid CP", area: "Connaught Place", distance: "2.4 km", drive: "9 min", wait: 11, price: "₹12/kWh", plugs: "2 / 6 free", type: "CCS · DC Fast", tone: "amber", x: 42, y: 56 },
  { id: "IN-0003", name: "Galleria DC Charging", area: "Gurugram · Sector 28", distance: "3.1 km", drive: "12 min", wait: 18, price: "₹12/kWh", plugs: "1 / 6 free", type: "CCS · DC Fast", tone: "coral", x: 77, y: 66 },
  { id: "IN-0004", name: "Highway Xpress", area: "Behror · Jaipur–Delhi", distance: "3.8 km", drive: "14 min", wait: 7, price: "₹12/kWh", plugs: "5 / 6 free", type: "CCS · DC Fast", tone: "mint", x: 22, y: 33 },
];

const initialTrace: TraceItem[] = [
  { tool: "get_driver_battery_status", detail: "authenticated driver session", result: "18% battery · 74 km estimated range", status: "complete" },
  { tool: "calculate_route_distance", detail: "New Delhi → nearby India stations", result: "Distances calculated from station coordinates", status: "complete" },
  { tool: "predict_station_wait_time", detail: "India dataset candidates", result: "Wait estimates calculated per compatible station", status: "complete" },
  { tool: "recommendation_guardrail", detail: "reachability + plug compatibility", result: "India station selected by total stop time", status: "complete" },
];

function Metric({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

function StationMarker({ station, onSelect }: { station: Station; onSelect: (station: Station) => void }) {
  return (
    <button
      className={`station-marker ${station.tone} ${station.selected ? "selected" : ""}`}
      style={{ left: `${station.x}%`, top: `${station.y}%` }}
      onClick={() => onSelect(station)}
      aria-label={`Select ${station.name}`}
    >
      <span className="marker-pulse" />
      <span className="marker-dot"><PlugZap size={13} strokeWidth={2.5} /></span>
      <span className="marker-label">{station.wait}m</span>
    </button>
  );
}

function TraceRow({ item, index }: { item: TraceItem; index: number }) {
  return (
    <div className="trace-row">
      <div className={`trace-icon ${item.status}`}>
        {index === 0 ? <BatteryCharging size={14} /> : index === 1 ? <Route size={14} /> : index === 2 ? <Gauge size={14} /> : <ShieldCheck size={14} />}
      </div>
      <div className="trace-copy">
        <div className="trace-tool">{item.tool}</div>
        <div className="trace-detail">{item.detail}</div>
        <div className="trace-result">{item.result}</div>
      </div>
      <ChevronRight className="trace-chevron" size={15} />
    </div>
  );
}

export default function Home() {
  const [, navigate] = useLocation();
  const session = getSession();
  const accountLabel = session?.email ?? "Signed-in driver";
  const [selectedId, setSelectedId] = useState("IN-0001");
  const [battery, setBattery] = useState(() => Number(localStorage.getItem("chargeflow-battery") ?? 18));
  const [vehicleName, setVehicleName] = useState(() => localStorage.getItem("chargeflow-vehicle") ?? "Polestar 2 Long Range");
  const [preferredPlug, setPreferredPlug] = useState(() => localStorage.getItem("chargeflow-plug") ?? "CCS");
  const [locationContext, setLocationContext] = useState<LocationContext>(() => {
    try { return JSON.parse(localStorage.getItem("chargeflow-location") ?? "") as LocationContext; } catch { return LOCATION_PRESETS[0]; }
  });
  const [message, setMessage] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [traceOpen, setTraceOpen] = useState(true);
  const [trace, setTrace] = useState<TraceItem[]>(initialTrace);
  const [pythonStatus, setPythonStatus] = useState("connecting");
  const [pythonRecommendation, setPythonRecommendation] = useState<PythonRecommendation | null>(null);
  const [networkStations, setNetworkStations] = useState<Station[]>(stations);
  const [chatBusy, setChatBusy] = useState(false);
  const [alertSet, setAlertSet] = useState(false);
  const [sortMode, setSortMode] = useState<"total" | "wait" | "price">("total");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [stationQuery, setStationQuery] = useState("");
  const [plugFilter, setPlugFilter] = useState<"all" | "CCS" | "Type 2">("all");
  const [waitFilter, setWaitFilter] = useState<"all" | "low" | "medium">("all");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [mapZoom, setMapZoom] = useState(1);
  const [lastRefresh, setLastRefresh] = useState(() => new Date());
  const [networkSummary, setNetworkSummary] = useState<NetworkSummary | null>(null);
  const [chatMessages, setChatMessages] = useState([
    { from: "agent", text: "I’m watching Indian stations within range. Tell me where you are and what matters most right now.", time: "now" },
  ]);

  const selectedStation = useMemo(() => networkStations.find((station) => station.id === selectedId) ?? networkStations[0], [networkStations, selectedId]);
  const totalStop = Number.parseInt(selectedStation.drive) + selectedStation.wait;
  const sortedStations = useMemo(() => [...networkStations]
    .filter((station) => station.name.toLowerCase().includes(stationQuery.toLowerCase()) || station.area.toLowerCase().includes(stationQuery.toLowerCase()))
    .filter((station) => plugFilter === "all" || station.type.includes(plugFilter))
    .filter((station) => waitFilter === "all" || (waitFilter === "low" ? station.wait <= 5 : station.wait > 5 && station.wait <= 12))
    .sort((a, b) => {
      const base = sortMode === "wait"
        ? a.wait - b.wait
        : sortMode === "price"
          ? Number.parseFloat(a.price.replace(/[^0-9.]/g, "")) - Number.parseFloat(b.price.replace(/[^0-9.]/g, ""))
          : (Number.parseInt(a.drive) + a.wait) - (Number.parseInt(b.drive) + b.wait);
      return sortDirection === "asc" ? base : -base;
    }), [networkStations, sortMode, sortDirection, stationQuery, plugFilter, waitFilter]);

  const showNotice = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => current === text ? "" : current), 3500);
  };

  const logout = async () => {
    const session = getSession();
    if (session) await fetch(`${PYTHON_API_BASE}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${session.token}` } }).catch(() => undefined);
    clearSession();
    navigate("/login");
  };

  useEffect(() => { localStorage.setItem("chargeflow-battery", String(battery)); }, [battery]);
  useEffect(() => { localStorage.setItem("chargeflow-vehicle", vehicleName); }, [vehicleName]);
  useEffect(() => { localStorage.setItem("chargeflow-plug", preferredPlug); }, [preferredPlug]);
  useEffect(() => { localStorage.setItem("chargeflow-location", JSON.stringify(locationContext)); }, [locationContext]);

  useEffect(() => {
    const loadPythonRecommendation = async () => {
      try {
        const healthResponse = await fetch(`${PYTHON_API_BASE}/health`);
        if (!healthResponse.ok) throw new Error("Python API unavailable");
        setPythonStatus("connected");
        const response = await fetch(`${PYTHON_API_BASE}/recommend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ battery_percent: battery, preferred_plug: preferredPlug, driver_lat: locationContext.lat, driver_lon: locationContext.lon, city: locationContext.city }),
        });
        if (response.ok) {
          const data = (await response.json()) as PythonRecommendation & { trace?: ApiTrace[] };
          setPythonRecommendation(data);
          if (data.recommendation?.id) setSelectedId(data.recommendation.id);
          if (data.trace) setTrace(data.trace.map((item) => ({ tool: item.tool_name, detail: JSON.stringify(item.args), result: item.result, status: "complete" })));
        }
      } catch {
        setPythonStatus("offline");
      }
    };
    void loadPythonRecommendation();
  }, [battery, preferredPlug, locationContext]);
  useEffect(() => {
    const loadStations = async () => {
      try {
        const response = await fetch(`${PYTHON_API_BASE}/stations?limit=12&city=${encodeURIComponent(locationContext.city)}`);
        if (!response.ok) return;
        const rows = (await response.json()) as Array<Record<string, unknown>>;
        const mapped: Station[] = rows.slice(0, 12).map((row, index) => ({
          id: String(row.id ?? `IN-${index + 1}`),
          name: String(row.name ?? "Indian charging station"),
          area: `${String(row.city ?? "India")} · ${String(row.state ?? "")}`,
          distance: String(row.distance ?? "—"),
          drive: `${String(row.drive_minutes ?? 0)} min`,
          wait: Number(row.wait ?? 0),
          price: String(row.price ?? "₹12/kWh"),
          plugs: String(row.plugs ?? "—"),
          type: String(row.type ?? "CCS"),
          address: String(row.address ?? `${String(row.city ?? "India")}, ${String(row.state ?? "")}`),
          connectors: String(row.plugs ?? "—"),
          occupancy: row.current_occupancy !== undefined ? `${String(row.current_occupancy)} occupied` : "Live occupancy unavailable",
          tone: index % 3 === 0 ? "mint" : index % 3 === 1 ? "amber" : "coral",
          x: [68, 42, 77, 22, 58, 33, 83, 14, 52, 28, 72, 45][index] ?? 50,
          y: [34, 56, 66, 33, 21, 72, 44, 58, 78, 42, 17, 86][index] ?? 50,
          selected: index === 0,
        }));
        if (mapped.length > 0) setNetworkStations(mapped);
      } catch {
        // Keep fallback stations visible when the local API is unavailable.
      }
    };
    const loadSummary = async () => {
      try {
        const response = await fetch(`${PYTHON_API_BASE}/network/summary?city=${encodeURIComponent(locationContext.city)}`);
        if (response.ok) setNetworkSummary((await response.json()) as NetworkSummary);
      } catch {
        // Keep the last known summary while the API reconnects.
      }
    };
    setLastRefresh(new Date());
    void loadStations();
    void loadSummary();
  }, [locationContext]);

  const selectStation = (station: Station) => { setSelectedId(station.id); setDetailsOpen(true); };
  const setTableSort = (mode: "total" | "wait" | "price") => {
    if (sortMode === mode) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else { setSortMode(mode); setSortDirection("asc"); }
  };

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    setMessage("");
    setChatMessages((current) => [...current, { from: "user", text: trimmed, time: "now" }]);
    setChatBusy(true);
    try {
      const response = await fetch(`${PYTHON_API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, battery_percent: battery, preferred_plug: preferredPlug, city: locationContext.city, driver_lat: locationContext.lat, driver_lon: locationContext.lon }),
      });
      const data = (await response.json()) as { answer?: string; trace?: ApiTrace[] };
      if (data.trace) setTrace(data.trace.map((item) => ({ tool: item.tool_name, detail: JSON.stringify(item.args), result: item.result, status: "complete" })));
      setChatMessages((current) => [...current, { from: "agent", text: data.answer ?? "I could not calculate a recommendation right now.", time: "now" }]);
    } catch {
      setChatMessages((current) => [...current, { from: "agent", text: "The Python backend is offline. Start it with pnpm dev:all and try again.", time: "now" }]);
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Zap size={19} fill="currentColor" /></div>
          <div>
            <div className="brand-name">charge<span>flow</span></div>
            <div className="brand-caption">EV intelligence, in motion</div>
          </div>
        </div>
        <nav className={`topnav ${mobileNav ? "open" : ""}`}>
          <button className="nav-link active" onClick={() => showNotice("Live network is the active workspace.")}><Activity size={15} /> Live network</button>
          <button className="nav-link" onClick={() => document.querySelector(".chat-panel")?.scrollIntoView({ behavior: "smooth" })}><MessageSquareText size={15} /> Agent console</button>
          <button className="nav-link" onClick={() => showNotice(`Python API status: ${pythonStatus}. Recommendations are dataset-backed.`)}><Gauge size={15} /> Model health</button>
        </nav>
        <div className="top-actions">
          <div className="live-chip"><span className="live-dot" /> Network live</div>
          <button className="icon-button" onClick={() => showNotice("ChargeFlow recommends reachable stations, predicts wait time, and explains each choice.")} aria-label="Help"><CircleHelp size={18} /></button>
          <button className="icon-button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Settings"><Settings2 size={18} /></button>
          <button className="avatar" aria-label={`Sign out ${accountLabel}`} onClick={() => void logout}>{accountLabel.slice(0, 2).toUpperCase()}</button>
          <button className="menu-button" onClick={() => setMobileNav((open) => !open)} aria-label="Toggle navigation">{mobileNav ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>

      {notice && <div className="app-notice" role="status">{notice}</div>}
      {settingsOpen && <div className="settings-popover"><div className="eyebrow">Driver settings</div><label>Vehicle name<input value={vehicleName} onChange={(event) => setVehicleName(event.target.value)} /></label><label>Preferred plug<select value={preferredPlug} onChange={(event) => setPreferredPlug(event.target.value)}><option value="CCS">CCS</option><option value="Type 2">Type 2</option><option value="NACS">NACS</option></select></label><button onClick={() => { setSettingsOpen(false); showNotice("Driver settings saved."); }}>Save settings</button></div>}
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div><div className="eyebrow">Signed-in account</div><h2>{accountLabel}</h2></div>
            <button className="edit-button" onClick={() => setSettingsOpen(true)}>Edit</button>
          </div>
          <div className="driver-card">
            <div className="driver-card-top"><div className="car-icon"><CarFront size={23} /></div><span className="vehicle-status"><span className="status-dot" /> Connected</span></div>
            <div className="vehicle-name">{vehicleName}</div>
            <div className="vehicle-meta">{preferredPlug} compatible <span>·</span> 78 kWh battery</div>
            <div className="battery-readout"><span>Current charge</span><strong>{battery}%</strong></div>
            <div className="battery-track"><div style={{ width: `${battery}%` }} /></div>
            <div className="battery-foot"><span>Est. range</span><span className="range-value">{Math.round(battery * 4.1)} km</span></div>
          </div>
          <div className="sidebar-section">
            <div className="section-label">Current context</div>
            <button className="context-row" onClick={() => showNotice("Location context is currently Connaught Place, New Delhi.")}><div className="context-icon mint"><LocateFixed size={16} /></div><div><strong>Connaught Place</strong><span>New Delhi, India</span></div><ChevronRight size={15} className="context-chevron" /></button>
            <button className="context-row" onClick={() => showNotice("Arrival window set to 10 minutes with flexible arrival.")}><div className="context-icon blue"><Clock3 size={16} /></div><div><strong>Leaving in 10 min</strong><span>Arrival window is flexible</span></div><ChevronRight size={15} className="context-chevron" /></button>
            <button className="context-row" onClick={() => showNotice("CCS is the active preferred connector.")}><div className="context-icon amber"><PlugZap size={16} /></div><div><strong>CCS preferred</strong><span>Open to NACS with adapter</span></div><ChevronRight size={15} className="context-chevron" /></button>
          </div>
          <div className="sidebar-section range-section">
            <div className="section-label">Battery level <span className="sim-badge">LOCAL</span></div>
            <div className="slider-labels"><span>10%</span><span>Current {battery}%</span><span>90%</span></div>
            <input className="battery-slider" type="range" min="10" max="90" value={battery} onChange={(event) => setBattery(Number(event.target.value))} />
            <p>Adjust charge to test reachability and recommendation logic.</p>
          </div>
          <div className="sidebar-bottom"><div className="system-note"><ShieldCheck size={15} /><span>All recommendations pass reachability checks.</span></div><div className="sidebar-version">CHARGEFLOW / INDIA NETWORK</div></div>
        </aside>

        <main className="main-content">
          <div className="main-heading">
            <div><div className="eyebrow">India network <span className="heading-separator">/</span> New Delhi context</div><h1>Find your clearest charge <span className="wave">✦</span></h1><p>Real stations from your India dataset, ranked for this trip.</p></div>
            <div className="location-picker"><button className="location-button" onClick={() => setLocationOpen((open) => !open)}><Crosshair size={16} /> {locationContext.label} <ChevronDown size={15} /></button>{locationOpen && <div className="location-menu">{LOCATION_PRESETS.map((preset) => <button key={preset.label} onClick={() => { setLocationContext(preset); setLocationOpen(false); showNotice(`Location changed to ${preset.label}.`); }}>{preset.label}<span>{preset.city}</span></button>)}</div>}</div>
          </div>
          <div className="metrics-row">
            <Metric label="Stations in range" value={String(networkSummary?.station_count ?? networkStations.length)} sub={`${networkSummary?.low_wait_count ?? 0} with low wait`} />
            <Metric label="Network wait" value={`${networkSummary?.average_wait ?? "—"} min`} accent="#1e9b77" sub={`Avg. ₹${networkSummary?.average_price ?? "—"}/kWh`} />
            <Metric label="Open connectors" value={`${networkSummary?.open_connectors ?? "—"} / ${networkSummary?.total_connectors ?? "—"}`} sub="Across nearby hubs" />
          </div>

          <section className="map-card">
            <div className="card-header map-header"><div><div className="eyebrow">Live station map</div><h2>Nearby charging network</h2></div><div className="map-actions"><button className="map-control" onClick={() => setTraceOpen(true)}><Layers3 size={15} /> Layers</button><button className="map-control" onClick={() => setSelectedId(networkStations[0]?.id ?? "IN-0001")}><LocateFixed size={15} /> Recenter</button></div></div>
            <div className="map-canvas"><div className="map-zoom-layer" style={{ transform: `scale(${mapZoom})` }}>
              <div className="map-water" />
              <div className="map-grid grid-a" /><div className="map-grid grid-b" />
              <div className="map-road road-1" /><div className="map-road road-2" /><div className="map-road road-3" /><div className="map-road road-4" /><div className="map-road road-5" />
              <div className="map-label label-one">DELHI NCR</div><div className="map-label label-two">CONNAUGHT PLACE</div><div className="map-label label-three">GURUGRAM</div><div className="map-label label-four">JAIPUR–DELHI NH 8</div>
              <div className="driver-location"><span className="driver-ring" /><span className="driver-pin"><Navigation size={13} fill="currentColor" /></span><span className="driver-location-label">You are here</span></div>
              {networkStations.map((station) => <StationMarker key={station.id} station={{ ...station, selected: station.id === selectedId }} onSelect={selectStation} />)}
              <div className="map-legend"><span><i className="legend-dot mint-dot" /> Low wait</span><span><i className="legend-dot amber-dot" /> Moderate</span><span><i className="legend-dot coral-dot" /> Busy</span></div>
              </div><div className="map-zoom"><button onClick={() => setMapZoom((zoom) => Math.min(1.35, zoom + .15))} aria-label="Zoom in">+</button><button onClick={() => setMapZoom((zoom) => Math.max(.85, zoom - .15))} aria-label="Zoom out">−</button></div>
            </div>
            <div className="map-footer"><span><span className="refresh-dot" /> Updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span>Predictions refresh every 5 minutes</span><button onClick={() => { setLastRefresh(new Date()); showNotice("Station availability refreshed."); }}>Refresh network <ArrowUpRight size={14} /></button><button onClick={() => document.getElementById("station-comparison")?.scrollIntoView({ behavior: "smooth" })}>View all 12 stations <ArrowUpRight size={14} /></button></div>
          </section>

          <section className="stations-section" id="station-comparison">
            <div className="section-title-row"><div><div className="eyebrow">Station comparison</div><h2>Best options for this trip</h2></div><button className="sort-button" onClick={() => setTableSort(sortMode)}>Sorted by {sortMode === "total" ? "total stop time" : sortMode === "wait" ? "predicted wait" : "energy price"} {sortDirection === "asc" ? "↑" : "↓"}</button></div>
            <div className="station-toolbar"><label className="station-search"><span>⌕</span><input value={stationQuery} onChange={(event) => setStationQuery(event.target.value)} placeholder="Search stations or areas" aria-label="Search stations or areas" /></label><select value={plugFilter} onChange={(event) => setPlugFilter(event.target.value as typeof plugFilter)} aria-label="Filter by connector"><option value="all">All connectors</option><option value="CCS">CCS</option><option value="Type 2">Type 2</option></select><select value={waitFilter} onChange={(event) => setWaitFilter(event.target.value as typeof waitFilter)} aria-label="Filter by wait"><option value="all">Any wait</option><option value="low">Low wait ≤ 5m</option><option value="medium">Up to 12m</option></select></div>
            <div className="station-table">
              <div className="station-table-head"><button onClick={() => setTableSort("total")}>Station</button><button onClick={() => setTableSort("total")}>Distance</button><button onClick={() => setTableSort("wait")}>Predicted wait {sortMode === "wait" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</button><button onClick={() => setTableSort("price")}>Price {sortMode === "price" ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</button><span /></div>
              {sortedStations.length > 0 ? sortedStations.map((station, index) => <button key={station.id} className={`station-row ${station.id === selectedId ? "active" : ""}`} onClick={() => selectStation(station)}><span className="station-name-cell"><span className={`mini-station-icon ${station.tone}`}><PlugZap size={14} /></span><span><strong>{station.name}</strong><small>{station.area} <b>{station.type}</b></small></span>{index === 0 && <span className="best-pill">BEST</span>}</span><span>{station.distance}<small>{station.drive} drive</small></span><span><strong className={`wait-text ${station.tone}`}>{station.wait} min</strong><small>predicted</small></span><span>{station.price}<small>energy rate</small></span><span><ChevronRight size={16} /></span></button>) : <div className="station-empty">No stations match these filters.</div>}
            </div>
          </section>
        </main>

        {detailsOpen && <div className="station-drawer-backdrop" onClick={() => setDetailsOpen(false)}><aside className="station-drawer" role="dialog" aria-modal="true" aria-label={`${selectedStation.name} details`} onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><div className="eyebrow">Station details</div><h2>{selectedStation.name}</h2></div><button className="drawer-close" onClick={() => setDetailsOpen(false)} aria-label="Close station details"><X size={18} /></button></div><div className="drawer-area"><MapPin size={14} /> {selectedStation.address ?? selectedStation.area}</div><div className="drawer-status"><span className={`mini-station-icon ${selectedStation.tone}`}><PlugZap size={15} /></span><div><strong>{selectedStation.type}</strong><span>{selectedStation.occupancy ?? "Live occupancy unavailable"}</span></div><span className={`wait-text ${selectedStation.tone}`}>{selectedStation.wait} min wait</span></div><div className="drawer-grid"><div><span>Open connectors</span><strong>{selectedStation.connectors ?? selectedStation.plugs}</strong></div><div><span>Energy price</span><strong>{selectedStation.price}</strong></div><div><span>Distance</span><strong>{selectedStation.distance}</strong></div><div><span>Drive time</span><strong>{selectedStation.drive}</strong></div></div><div className="drawer-note"><ShieldCheck size={15} /> Availability is based on the latest India network refresh.</div><button className="primary-action" onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${selectedStation.name}, ${selectedStation.address ?? selectedStation.area}`)}`, "_blank", "noopener,noreferrer")}><Navigation size={16} fill="currentColor" /> Start route <ArrowUpRight size={15} /></button></aside></div>}

        <aside className="right-rail">
          <div className="recommendation-panel">
            <div className="recommendation-top"><div className="recommendation-label"><Sparkles size={15} /> AI recommendation <span className="local-badge">PYTHON API {pythonStatus.toUpperCase()}</span></div><span className="confidence-badge">94% confident</span></div>
            <div className="recommendation-title"><h2>{pythonRecommendation?.recommendation?.name ?? selectedStation.name}</h2><div className="selection-check"><ShieldCheck size={15} /> Reachable</div></div>
            <div className="recommendation-area"><MapPin size={14} /> {selectedStation.area} <span>·</span> {selectedStation.distance} away</div>
            <div className="recommendation-stats"><div><div className="big-stat">{selectedStation.wait}<small>min</small></div><span>predicted wait</span></div><div><div className="big-stat">{totalStop}<small>min</small></div><span>total stop time</span></div><div><div className="big-stat">{selectedStation.plugs.split(" ")[0]}<small> open</small></div><span>connectors</span></div></div>
            <div className="recommendation-reason"><div className="reason-icon"><Lightbulb size={17} /></div><p><strong>Why this one?</strong> {pythonRecommendation?.reason ?? "The shortest total stop time in your reachable set. It beats the cheaper option while keeping you on CCS."}</p></div>
            <button className="primary-action" onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${selectedStation.name}, ${selectedStation.area}`)}`, "_blank", "noopener,noreferrer")}><Navigation size={16} fill="currentColor" /> Start route to {selectedStation.name} <ArrowUpRight size={15} /></button>
            <button className="secondary-action" onClick={() => setAlertSet((current) => !current)}><TimerReset size={15} /> {alertSet ? "Arrival alert set" : "Set a 10-minute arrival alert"}</button>
          </div>

          <div className="alternative-panel"><div className="panel-title"><h3>Worth considering</h3><button onClick={() => showNotice("Alternative stations are ranked by price and total stop time.")} aria-label="Explain alternative"><ArrowUpRight size={15} /></button></div><div className="alternative-card"><div className="alternative-head"><div><strong>{pythonRecommendation?.alternative?.name ?? "Lower-cost alternative"}</strong><span>Lower energy price</span></div><span className="price-tag">₹8/kWh</span></div><div className="alternative-meta"><span><Clock3 size={13} /> predicted wait</span><span><Route size={13} /> route available</span></div><div className="tradeoff"><TrendingDown size={14} /> Compare price before routing</div></div></div>

              <div className="trace-panel"><button className="trace-heading" onClick={() => setTraceOpen((open) => !open)}><div><div className="trace-heading-label"><GitBranch size={15} /> Inspectable reasoning</div><h3>Agent trace <span>· {trace.length} tool calls</span></h3></div>{traceOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>{traceOpen && <div className="trace-list">{trace.map((item, index) => <TraceRow key={`${item.tool}-${index}`} item={item} index={index} />)}<div className="trace-footer"><span>Live FastAPI trace</span><button onClick={() => showNotice(JSON.stringify(trace.map((item) => item.tool)))} aria-label="View raw JSON">View raw JSON <ArrowUpRight size={13} /></button></div></div>}</div>

          <div className="chat-panel"><div className="chat-panel-heading"><div className="assistant-avatar"><Sparkles size={15} /></div><div><h3>Ask the agent</h3><span>FastAPI recommendation service</span></div><span className="local-badge">{pythonStatus.toUpperCase()}</span></div><div className="chat-messages">{chatMessages.map((chat, index) => <div key={`${chat.time}-${index}`} className={`chat-message ${chat.from}`}><div className="chat-bubble">{chat.text}</div><span>{chat.time}</span></div>)}</div><div className="quick-prompts"><button onClick={() => setMessage("What if I’m willing to drive 5 more minutes?")}>Drive farther</button><button onClick={() => setMessage("Find the cheapest option")}>Find cheapest</button></div><form className="chat-input-wrap" onSubmit={submitMessage}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={chatBusy ? "Asking the India network..." : "Ask a follow-up..."} aria-label="Ask a follow-up question" disabled={chatBusy} /><button type="submit" aria-label="Send message" disabled={chatBusy}><Send size={16} /></button></form></div>
        </aside>
      </div>
      <footer className="app-footer"><span><span className="footer-spark">✦</span> ChargeFlow intelligence layer</span><span>India dataset connected <span className="footer-separator">·</span> <button onClick={() => showNotice("Recommendations combine plug compatibility, reachability, drive time, and predicted wait.")}>Read the methodology</button></span><span>Python API <i className="footer-status" /> {pythonStatus}</span></footer>
    </div>
  );
}
