export interface Settings {
  baseUrl: string;
  apiKey: string;
  demo: boolean;
}

const SETTINGS_KEY = 'overseer-recs:settings';
const SKIPPED_KEY = 'overseer-recs:skipped';

const store = (s?: Storage) => s ?? localStorage;

export function loadSettings(storage?: Storage): Settings {
  const empty: Settings = { baseUrl: '', apiKey: '', demo: false };
  try {
    const j = JSON.parse(store(storage).getItem(SETTINGS_KEY) ?? 'null');
    if (j && typeof j === 'object') {
      return { baseUrl: String(j.baseUrl ?? ''), apiKey: String(j.apiKey ?? ''), demo: j.demo === true };
    }
  } catch {
    /* fall through */
  }
  return empty;
}

export function saveSettings(s: Settings, storage?: Storage): void {
  store(storage).setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function clearSettings(storage?: Storage): void {
  store(storage).removeItem(SETTINGS_KEY);
}

export interface SkipStore {
  has(key: string): boolean;
  add(key: string): void;
  all(): Set<string>;
  clear(): void;
}

export function createSkipStore(storage?: Storage): SkipStore {
  const s = store(storage);
  const read = (): Set<string> => {
    try {
      const j = JSON.parse(s.getItem(SKIPPED_KEY) ?? '[]');
      return new Set(Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  };
  const write = (set: Set<string>) => {
    try {
      s.setItem(SKIPPED_KEY, JSON.stringify([...set]));
    } catch {
      /* storage full/blocked: skip stays in-session only */
    }
  };
  return {
    has: (k) => read().has(k),
    add: (k) => write(read().add(k)),
    all: read,
    clear: () => s.removeItem(SKIPPED_KEY),
  };
}
