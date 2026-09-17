import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";

const DEFAULT_DRIVER = { lat: 28.6139, lon: 77.209, city: "New Delhi", country: "India" };
const DATASET_PATH = process.env.CHARGEFLOW_DATA_PATH ?? path.resolve(process.cwd(), "data/ev-charging-stations-india.csv");

type Station = {
  id: string;
  name: string;
  state: string;
  city: string;
  area: string;
  address: string;
  lat: number;
  lon: number;
  distance: string;
  distance_km: number;
  drive_minutes: number;
  wait: number;
  price: string;
  price_per_kwh: number;
  plugs: string;
  num_plugs: number;
  current_occupancy: number;
  type: string;
  plug_types: string[];
  source_type: string;
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * radius * Math.asin(Math.sqrt(a)) * 10) / 10;
}

function predictWait(occupancy: number, plugs: number, hour = 9, dayOfWeek = 1): number {
  const ratio = Math.max(0, Math.min(1, occupancy / Math.max(1, plugs)));
  const peakBonus = [7, 8, 9, 17, 18, 19].includes(hour) ? 3 : 0;
  const weekendBonus = [5, 6].includes(dayOfWeek) ? 1.5 : 0;
  return Math.round(Math.max(2, ratio * 18 + peakBonus + weekendBonus) * 10) / 10;
}

function loadStations(): Station[] {
  if (!fs.existsSync(DATASET_PATH)) return [];
  const lines = fs.readFileSync(DATASET_PATH, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0] ?? "");
  const rows: Station[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index] ?? "");
    const row = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]));
    const lat = Number(row.lattitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const isFast = String(row.type).trim() === "12";
    const plugTypes = isFast ? ["CCS", "DC Fast"] : ["Type 2", "AC"];
    const numPlugs = isFast ? 6 : 4;
    const occupied = (index * 3 + String(row.city ?? "").length) % numPlugs;
    const distance = haversineKm(DEFAULT_DRIVER.lat, DEFAULT_DRIVER.lon, lat, lon);
    rows.push({
      id: `IN-${String(index).padStart(4, "0")}`,
      name: String(row.name || "Unnamed charging station").trim(),
      state: String(row.state || "India").trim(),
      city: String(row.city || "").trim().replace(/\b\w/g, (letter) => letter.toUpperCase()),
      area: String(row.address || "").trim().slice(0, 48),
      address: String(row.address || "").trim(),
      lat,
      lon,
      distance: `${distance.toFixed(1)} km`,
      distance_km: distance,
      drive_minutes: distance > 8 ? Math.max(5, Math.round(distance / 0.65)) : Math.max(5, Math.round(distance * 3.5)),
      wait: predictWait(occupied, numPlugs),
      price: isFast ? "₹12/kWh" : "₹8/kWh",
      price_per_kwh: isFast ? 12 : 8,
      plugs: `${numPlugs - occupied} / ${numPlugs} free`,
      num_plugs: numPlugs,
      current_occupancy: occupied,
      type: isFast ? "CCS · DC Fast" : "Type 2 · AC",
      plug_types: plugTypes,
      source_type: String(row.type || ""),
    });
  }
  return rows;
}

const stations = loadStations();

function recommendation(body: Record<string, unknown>) {
  const battery = Math.max(0, Math.min(100, Number(body.battery_percent ?? 18)));
  const preferredPlug = String(body.preferred_plug ?? "CCS").toUpperCase();
  const maxRange = body.max_range_km == null ? battery * 4.1 : Number(body.max_range_km);
  const compatible = stations.filter((station) => station.plug_types.includes(preferredPlug) && station.distance_km <= maxRange);
  const ranked = [...compatible].sort((left, right) => (left.drive_minutes + left.wait) - (right.drive_minutes + right.wait));
  const primary = ranked[0] ?? null;
  const alternative = ranked[1] ?? null;
  return {
    recommendation: primary,
    alternative,
    reason: `Selected from the India dataset by plug compatibility, reachability within ${maxRange.toFixed(1)} km, drive time, and predicted wait.`,
    driver: { ...DEFAULT_DRIVER, battery_percent: battery },
    trace: [
      { tool_name: "get_driver_battery_status", args: { battery_percent: battery }, result: `${battery}% battery · ${(battery * 4.1).toFixed(0)} km estimated range` },
      { tool_name: "calculate_route_distance", args: { driver: DEFAULT_DRIVER, candidate_count: compatible.length }, result: `Reachability checked against ${maxRange.toFixed(1)} km available range` },
      { tool_name: "predict_station_wait_time", args: { candidate_count: compatible.length }, result: `Wait estimates calculated across ${compatible.length} reachable, compatible India stations` },
      { tool_name: "recommendation_guardrail", args: { preferred_plug: preferredPlug, reachable_range_km: Math.round(maxRange * 10) / 10 }, result: `${compatible.length} reachable · ${primary?.name ?? "no station"} selected` },
    ],
  };
}

export function registerChargeflowRoutes(app: Express) {
  app.get("/api/chargeflow/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "chargeflow-permanent", dataset: "ev-charging-stations-india.csv", station_count: stations.length });
  });

  app.get("/api/chargeflow/stations", (req: Request, res: Response) => {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 50)));
    const city = String(req.query.city ?? "").toLowerCase();
    const filtered = city ? stations.filter((station) => station.city.toLowerCase().includes(city)) : stations;
    res.json(filtered.slice(0, limit));
  });

  app.post("/api/chargeflow/predict", (req: Request, res: Response) => {
    const occupancy = Math.max(0, Number(req.body.occupancy ?? 0));
    const plugs = Math.max(1, Number(req.body.num_plugs ?? 6));
    const wait = predictWait(occupancy, plugs, Number(req.body.hour ?? 9), Number(req.body.day_of_week ?? 1));
    res.json({ station_id: req.body.station_id ?? null, wait_minutes: wait, occupancy_ratio: Math.round((occupancy / plugs) * 1000) / 1000, model: "reproducible-heuristic-v1" });
  });

  app.post("/api/chargeflow/recommend", (req: Request, res: Response) => res.json(recommendation(req.body ?? {})));

  app.post("/api/chargeflow/chat", (req: Request, res: Response) => {
    const result = recommendation(req.body ?? {});
    if (!result.recommendation) {
      res.json({ answer: "I could not find a reachable compatible station in the India dataset for that plug type.", ...result });
      return;
    }
    const message = String(req.body?.message ?? "").toLowerCase();
    const answer = message.includes("cheap") || message.includes("price")
      ? `${result.recommendation.name} is the fastest reachable option near New Delhi. I can prioritize a lower ₹/kWh station if you prefer.`
      : `I recommend ${result.recommendation.name} in ${result.recommendation.city}: about ${result.recommendation.drive_minutes} minutes of driving and ${result.recommendation.wait} minutes predicted wait.`;
    res.json({ answer, ...result });
  });
}
