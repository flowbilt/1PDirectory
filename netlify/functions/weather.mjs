// GET /api/weather?lat=33.5186&lon=-86.8104
// Uses the National Weather Service (api.weather.gov): free, no key, fine for commercial use, US only.
// Netlify's CDN caches each location for 10 minutes, so 20 screens make ~6 NWS calls an hour per location.
import { json } from "../lib/common.mjs";

const UA = `(Directory display, ${process.env.NWS_CONTACT || "admin@example.com"})`;

export function iconFor(text = "", isDaytime = true) {
  const t = text.toLowerCase();
  if (/thunder|t-storm|tstorm/.test(t)) return "storm";
  if (/snow|sleet|flurr|ice|wintry|freezing/.test(t)) return "snow";
  if (/rain|shower|drizzle/.test(t)) return "rain";
  if (/fog|haze|smoke|mist/.test(t)) return "fog";
  if (/partly|mostly sunny|mostly clear|few clouds|scattered clouds/.test(t)) return isDaytime ? "partly-day" : "partly-night";
  if (/cloud|overcast/.test(t)) return "cloud";
  return isDaytime ? "clear-day" : "clear-night";
}

async function nws(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`NWS ${res.status} for ${url}`);
  return res.json();
}

export default async (req) => {
  const url = new URL(req.url);
  const latRaw = url.searchParams.get("lat"), lonRaw = url.searchParams.get("lon");
  const lat = Number(latRaw), lon = Number(lonRaw);
  if (!latRaw || !lonRaw || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: "lat and lon are required." }, 400);
  }

  try {
    const point = await nws(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const hourlyUrl = point?.properties?.forecastHourly;
    if (!hourlyUrl) throw new Error("NWS returned no hourly forecast for this location.");
    const hourly = await nws(hourlyUrl);
    const p = hourly?.properties?.periods?.[0];
    if (!p) throw new Error("NWS hourly forecast was empty.");

    const tempF = p.temperatureUnit === "C" ? Math.round((p.temperature * 9) / 5 + 32) : Math.round(p.temperature);
    return json(
      { tempF, text: p.shortForecast || "", icon: iconFor(p.shortForecast, p.isDaytime), isDaytime: !!p.isDaytime, at: new Date().toISOString() },
      200,
      {
        "Cache-Control": "public, max-age=300",
        "Netlify-CDN-Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800",
        "Netlify-Vary": "query=lat|lon",
      }
    );
  } catch (e) {
    return json({ error: e.message }, 502);
  }
};

export const config = { path: "/api/weather" };
