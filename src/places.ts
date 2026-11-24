import { validPoint, type Point } from "./routes.ts";

const photonUrl = (process.env.EXPO_PUBLIC_PHOTON_URL?.trim() || "https://photon.komoot.io").replace(/\/+$/, "");
const resultLimit = 6;

export type Place = { point: Point; name: string; detail?: string };

type PhotonFeature = {
  geometry?: { type?: string; coordinates?: unknown[] };
  properties?: Partial<Record<"name" | "street" | "housenumber" | "district" | "city" | "state" | "country", string>>;
};

export async function searchPlaces(query: string, center: Point, signal: AbortSignal): Promise<Place[]> {
  const url = `${photonUrl}/api/?q=${encodeURIComponent(query)}&limit=${resultLimit}` +
    `&lat=${center.latitude.toFixed(1)}&lon=${center.longitude.toFixed(1)}&zoom=9`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Place search is temporarily unavailable.");
  const data = await response.json() as { features?: PhotonFeature[] };
  if (!Array.isArray(data?.features)) throw new Error("Place search returned an invalid response.");

  return data.features.slice(0, resultLimit).flatMap((feature) => {
    if (feature?.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return [];
    const [longitude, latitude] = feature.geometry.coordinates;
    const point = { longitude, latitude };
    if (!validPoint(point)) return [];
    const { name, street, housenumber, district, city, state, country } = feature.properties ?? {};
    const address = [housenumber, street].filter(Boolean).join(" ");
    const label = name || address || city || district || state || country;
    if (typeof label !== "string" || !label.trim()) return [];
    const detail = [...new Set([address, district, city, state, country])]
      .filter((part) => typeof part === "string" && part && part !== label).join(", ");
    return [{ point, name: label, detail }];
  });
}
