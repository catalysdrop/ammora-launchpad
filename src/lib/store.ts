/** Launches created through this app, kept in the browser's localStorage. */
export type SavedLaunch = {
  configId: string;
  configHash: string;
  token: string;
  curve: string;
  name: string;
  symbol: string;
  creator: string;
  createdBlock: string;
  configTx: string;
  launchTx: string;
  createdAt: string;
};

const KEY = "ammora-launchpad:launches:v1";

export function loadLaunches(): SavedLaunch[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedLaunch[]) : [];
  } catch {
    return [];
  }
}

export function saveLaunch(launch: SavedLaunch): SavedLaunch[] {
  const all = loadLaunches().filter((l) => l.curve.toLowerCase() !== launch.curve.toLowerCase());
  all.unshift(launch);
  localStorage.setItem(KEY, JSON.stringify(all.slice(0, 50)));
  return all;
}

export function removeLaunch(curve: string): SavedLaunch[] {
  const all = loadLaunches().filter((l) => l.curve.toLowerCase() !== curve.toLowerCase());
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}
