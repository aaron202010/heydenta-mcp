// The HeyDenta API client the tools call. One place for auth, retries and errors.
//
// Auth: a per-clinic bearer key (hd_aria_...) read from the environment, sent as an
// Authorization header, never in a URL. Retries: network errors, 429 and 5xx are retried
// with exponential backoff; any other 4xx is returned at once (the caller made the mistake,
// a retry cannot fix it). POST retries are safe because create_booking carries an
// idempotency key the server honours (same patient + same slot = same booking).

export type ApiConfig = {
  baseUrl: string;
  apiKey: string;
  clinicSlug: string;
  clinicId: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
};

export type ApiResult<T = unknown> = { status: number; body: T };

export class ApiError extends Error {
  constructor(public readonly status: number | null, message: string, public readonly attempts: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const apiKey = (env.HEYDENTA_API_KEY || "").trim();
  if (!apiKey) throw new Error("HEYDENTA_API_KEY is not set (the clinic's hd_aria_ key)");
  const clinicId = Number(env.HEYDENTA_CLINIC_ID || "");
  if (!Number.isInteger(clinicId) || clinicId <= 0) throw new Error("HEYDENTA_CLINIC_ID must be a positive integer");
  const clinicSlug = (env.HEYDENTA_CLINIC_SLUG || "").trim();
  if (!clinicSlug) throw new Error("HEYDENTA_CLINIC_SLUG is not set");
  return {
    baseUrl: (env.HEYDENTA_BASE_URL || "https://app.heydenta.com").replace(/\/+$/, ""),
    apiKey,
    clinicSlug,
    clinicId,
  };
}

export type Availability = {
  closed: boolean;
  hours: string;
  reason: string;
  holidayReason: string | null;
  free: string[];
  dentists: Array<{ id: string; name: string }>;
  byDentist: Array<{ id: string; name: string; free: string[] }>;
};

export type CreateBookingInput = {
  idempotency_key: string;
  patient_name: string;
  patient_phone: string;
  date: string;
  time: string;
  procedure?: string;
  reason?: string;
  dentist?: string;
};

export type CreateBookingResponse =
  | { ok: true; event_id: number; scheduled_at_human: string; idempotent?: boolean; status?: string }
  | { ok: false; error: string; message?: string; suggested_slots?: string[] };

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HeyDentaApi {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly cfg: ApiConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = cfg.maxAttempts ?? 3;
    this.baseDelayMs = cfg.baseDelayMs ?? 300;
  }

  get clinicSlug() { return this.cfg.clinicSlug; }
  get clinicId() { return this.cfg.clinicId; }

  async availability(date: string, dentist?: string): Promise<Availability> {
    const q = new URLSearchParams({ slug: this.cfg.clinicSlug, date });
    if (dentist) q.set("dentist", dentist);
    const r = await this.request<Availability>("GET", `/api/intake/availability?${q}`);
    if (r.status !== 200) throw new ApiError(r.status, `availability returned ${r.status}`, 1);
    return r.body;
  }

  async createBooking(input: CreateBookingInput): Promise<ApiResult<CreateBookingResponse>> {
    return this.request<CreateBookingResponse>("POST", "/api/aria-tool/create-booking", {
      clinic_id: this.cfg.clinicId,
      customer_id: input.idempotency_key,
      customer_message: `mcp:${input.idempotency_key}`,
      patient_name: input.patient_name,
      patient_phone: input.patient_phone,
      preferred_date: input.date,
      preferred_time: input.time,
      procedure: input.procedure,
      reason: input.reason,
      dentist: input.dentist,
    });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
    const url = `${this.cfg.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${this.cfg.apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let lastError: unknown = null;
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        lastStatus = res.status;
        if (!RETRY_STATUSES.has(res.status)) {
          const text = await res.text();
          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
          return { status: res.status, body: parsed as T };
        }
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
        lastStatus = null;
      }
      if (attempt < this.maxAttempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
    }
    const why = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ApiError(lastStatus, `${method} ${path} failed after ${this.maxAttempts} attempts: ${why}`, this.maxAttempts);
  }
}
