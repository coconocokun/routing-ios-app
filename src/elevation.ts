import { decode } from "fast-png";
import type { Point } from "./routes.ts";

const publicTiles = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const tileUrl = (process.env.EXPO_PUBLIC_TERRARIUM_URL?.trim() || publicTiles).replace(/\/+$/, "");
const zoom = 13;
const size = 256;
const worldTiles = 2 ** zoom;

export const demVersion = process.env.EXPO_PUBLIC_TERRARIUM_VERSION?.trim() ||
  (tileUrl === publicTiles ? `Mapzen Terrarium z${zoom} (public tiles)` : `Custom Terrarium z${zoom} (unversioned)`);

function pixel({ latitude, longitude }: Point) {
  const worldPixels = worldTiles * size;
  const mercator = Math.asinh(Math.tan(latitude * Math.PI / 180));
  // The tiles store samples at pixel centers.
  return { x: (longitude + 180) / 360 * worldPixels - 0.5,
    y: (1 - mercator / Math.PI) / 2 * worldPixels - 0.5 };
}

async function getTile(x: number, y: number, signal: AbortSignal) {
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(`${tileUrl}/${zoom}/${x}/${y}.png`, { signal });
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`Elevation tiles returned HTTP ${response.status}.`);
    bytes = await response.arrayBuffer();
  } catch (error) {
    if (error instanceof TypeError && !signal.aborted) throw new Error("Could not reach the elevation tiles. Check your connection and try again.");
    throw error;
  }
  try {
    const header = new DataView(bytes);
    if (header.getUint32(16) !== size || header.getUint32(20) !== size) throw new Error("Invalid dimensions");
    const { data, channels, depth } = decode(bytes, { checkCrc: true });
    if (depth !== 8 || (channels !== 3 && channels !== 4)) throw new Error("Invalid color format");
    const heights = new Float32Array(size * size);
    for (let i = 0; i < heights.length; i++) {
      const offset = i * channels;
      const height = data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32768;
      heights[i] = (channels === 4 && data[offset + 3] !== 255) || height < -500 || height > 9000 ? NaN : height;
    }
    return heights;
  } catch {
    throw new Error("The elevation service returned an invalid Terrarium tile.");
  }
}

const tileKey = (x: number, y: number) => `${(x + worldTiles) % worldTiles}/${y}`;

export async function loadElevation(points: Iterable<Point>, signal: AbortSignal) {
  const required = new Set<string>();
  for (const point of points) {
    const { x, y } = pixel(point);
    const left = Math.floor(x);
    const top = Math.floor(y);
    for (const column of [left, left + 1]) {
      for (const row of [top, top + 1]) required.add(tileKey(Math.floor(column / size), Math.floor(row / size)));
    }
  }
  if (required.size > 64) throw new Error("The routing area needs too many elevation tiles. Choose closer points.");
  const keys = [...required];
  const tiles = new Map<string, Float32Array>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++];
      const [x, y] = key.split("/").map(Number);
      const heights = await getTile(x, y, signal);
      if (heights) tiles.set(key, heights);
    }
  }));

  return (point: Point) => {
    const { x, y } = pixel(point);
    const left = Math.floor(x);
    const top = Math.floor(y);
    let height = 0;
    for (const column of [left, left + 1]) {
      for (const row of [top, top + 1]) {
        const weight = (1 - Math.abs(column - x)) * (1 - Math.abs(row - y));
        if (!weight) continue;
        const data = tiles.get(tileKey(Math.floor(column / size), Math.floor(row / size)));
        const sample = data?.[(row % size) * size + (column + size) % size] ?? NaN;
        height += weight * sample;
      }
    }
    return height;
  };
}
