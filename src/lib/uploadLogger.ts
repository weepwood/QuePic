export type UploadLogPhase = 'prepared' | 'sent' | 'success' | 'error';
export type UploadLogLevel = 'info' | 'success' | 'error';

export type UploadLogValue =
  | string
  | number
  | boolean
  | null
  | UploadLogValue[]
  | { [key: string]: UploadLogValue };

export interface UploadLogEntry {
  id: string;
  request_id: string;
  created_at: string;
  phase: UploadLogPhase;
  level: UploadLogLevel;
  title: string;
  command: string;
  account_name: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  duration_ms: number | null;
  request: { [key: string]: UploadLogValue };
  response: UploadLogValue | null;
  error: string | null;
}

export interface UploadLogDraft {
  requestId: string;
  phase: UploadLogPhase;
  level?: UploadLogLevel;
  title: string;
  command?: string;
  accountName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  durationMs?: number | null;
  request?: unknown;
  response?: unknown;
  error?: string | null;
}

const STORAGE_KEY = 'quepic-upload-logs-v1';
const UPDATE_EVENT = 'quepic:upload-log-updated';
const MAX_LOG_ENTRIES = 300;
const MAX_STRING_LENGTH = 12_000;
const SECRET_KEY = /(authorization|cookie|token|ctoken|secret|password|credential|session)/i;
const URL_KEY = /(url|referer|origin|endpoint)/i;
const SECRET_FIELD_NAME = '[\\w-]*(?:authorization|cookie|token|ctoken|secret|password|credential|session)[\\w-]*';
const SECRET_ASSIGNMENT = new RegExp(
  `((?:"|'|)?${SECRET_FIELD_NAME}(?:"|'|)?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&}]+)`,
  'gi',
);
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

function sanitizeText(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]');
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return sanitizeText(url.toString());
  } catch {
    return sanitizeText(value);
  }
}

function sanitizeValue(value: unknown, key = ''): UploadLogValue {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalized = sanitizeText(URL_KEY.test(key) ? sanitizeUrl(value) : value);
    return normalized.length > MAX_STRING_LENGTH
      ? `${normalized.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`
      : normalized;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeValue(value.message, 'message'),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeValue(item));
  }
  if (typeof value === 'object') {
    const result: { [key: string]: UploadLogValue } = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childKey === 'bytes') {
        result.bytes = Array.isArray(childValue)
          ? `[OMITTED: ${childValue.length} bytes]`
          : '[OMITTED]';
        continue;
      }
      result[childKey] = sanitizeValue(childValue, childKey);
    }
    return result;
  }
  return sanitizeText(String(value));
}

function isUploadLogEntry(value: unknown): value is UploadLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<UploadLogEntry>;
  return typeof entry.id === 'string'
    && typeof entry.request_id === 'string'
    && typeof entry.created_at === 'string'
    && typeof entry.phase === 'string'
    && typeof entry.title === 'string';
}

export function listUploadLogs(): UploadLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUploadLogEntry).slice(0, MAX_LOG_ENTRIES);
  } catch {
    return [];
  }
}

function persistUploadLogs(entries: UploadLogEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_LOG_ENTRIES)));
  } catch {
    // 日志不能影响上传主流程；存储空间不足时静默保留当前上传行为。
  }
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
}

export function recordUploadLog(draft: UploadLogDraft): UploadLogEntry {
  const entry: UploadLogEntry = {
    id: crypto.randomUUID(),
    request_id: draft.requestId,
    created_at: new Date().toISOString(),
    phase: draft.phase,
    level: draft.level ?? (draft.phase === 'success' ? 'success' : draft.phase === 'error' ? 'error' : 'info'),
    title: draft.title,
    command: draft.command ?? 'upload_image',
    account_name: draft.accountName,
    file_name: draft.fileName,
    file_size: draft.fileSize,
    mime_type: draft.mimeType,
    duration_ms: draft.durationMs ?? null,
    request: sanitizeValue(draft.request ?? {}) as { [key: string]: UploadLogValue },
    response: draft.response === undefined ? null : sanitizeValue(draft.response),
    error: draft.error ? String(sanitizeValue(draft.error, 'error')) : null,
  };
  persistUploadLogs([entry, ...listUploadLogs()]);
  return entry;
}

export function clearUploadLogs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } finally {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
  }
}

export function subscribeUploadLogs(listener: (entries: UploadLogEntry[]) => void): () => void {
  const refresh = () => listener(listUploadLogs());
  const storageListener = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) refresh();
  };
  window.addEventListener(UPDATE_EVENT, refresh);
  window.addEventListener('storage', storageListener);
  return () => {
    window.removeEventListener(UPDATE_EVENT, refresh);
    window.removeEventListener('storage', storageListener);
  };
}
