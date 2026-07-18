// Full observability for the reply pipeline (Personality Engine §17).
//
// The pipeline is a chain of steps that each cost time and can each be the
// reason a reply came out wrong — profile lookup, example selection, prompt
// build, generation, critique, rewrite, and finally what the user did with it.
// OpenTelemetry spans make that chain inspectable in any collector (Jaeger,
// Tempo, Grafana) instead of guessable from a log line.
//
// Off unless an OTLP endpoint is configured; the app never depends on the
// collector being reachable, and the local JSONL telemetry (§14) stays the
// source of truth for accept-rate analytics.

// The API package is tiny and always needed; the SDK, exporter and their
// dependencies are ~90kB and only matter when a collector is configured, so
// they load on demand — an app without tracing never pays for them.
import { context, trace, type Span, type Tracer, SpanStatusCode } from "@opentelemetry/api";

const SERVICE = "messages-personality-engine";

interface ShutdownProvider {
  shutdown(): Promise<void>;
}

let provider: ShutdownProvider | null = null;
let tracer: Tracer | null = null;
let configuredEndpoint: string | null = null;

/**
 * Point tracing at an OTLP/HTTP collector, or disable it with an empty string.
 * Safe to call repeatedly — only a changed endpoint rebuilds the provider.
 */
export function configureTracing(endpoint: string, appVersion = "dev"): void {
  const url = endpoint.trim().replace(/\/$/, "");
  if (url === (configuredEndpoint ?? "")) return;
  configuredEndpoint = url;

  void provider?.shutdown().catch(() => {});
  provider = null;
  tracer = null;
  if (!url) return;

  void (async () => {
    try {
      const [{ WebTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }, semconv] =
        await Promise.all([
          import("@opentelemetry/sdk-trace-web"),
          import("@opentelemetry/exporter-trace-otlp-http"),
          import("@opentelemetry/resources"),
          import("@opentelemetry/semantic-conventions"),
        ]);
      // The endpoint may have changed again while the SDK loaded.
      if (configuredEndpoint !== url) return;

      const p = new WebTracerProvider({
        resource: resourceFromAttributes({
          [semconv.ATTR_SERVICE_NAME]: SERVICE,
          [semconv.ATTR_SERVICE_VERSION]: appVersion,
        }),
        spanProcessors: [
          new BatchSpanProcessor(new OTLPTraceExporter({ url: `${url}/v1/traces` })),
        ],
      });
      p.register();
      provider = p;
      tracer = p.getTracer(SERVICE);
    } catch {
      // A missing or misconfigured collector must never break replying.
      provider = null;
      tracer = null;
    }
  })();
}

export function tracingEnabled(): boolean {
  return tracer !== null;
}

type Attrs = Record<string, string | number | boolean | undefined>;

function setAttrs(span: Span, attrs?: Attrs): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) span.setAttribute(k, v);
  }
}

/**
 * Run `fn` inside a span. Without a configured collector this is a direct call
 * with no allocation, so instrumentation costs nothing when tracing is off.
 */
export async function span<T>(
  name: string,
  attrs: Attrs | undefined,
  fn: (span: Span | null) => Promise<T>
): Promise<T> {
  if (!tracer) return fn(null);
  return tracer.startActiveSpan(name, async (s) => {
    setAttrs(s, attrs);
    try {
      const result = await fn(s);
      s.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      s.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      s.end();
    }
  });
}

/**
 * A root span kept open across the user's review: generation finishes long
 * before the user accepts, edits or rejects, and the interesting latency is
 * the whole round trip. The caller ends it from the composer.
 */
export interface PendingTrace {
  end(outcome: string, attrs?: Attrs): void;
}

const pending = new Map<string, { span: Span; ctx: ReturnType<typeof trace.setSpan> }>();

export function startReplyTrace(key: string, attrs?: Attrs): PendingTrace | null {
  if (!tracer) return null;
  const s = tracer.startSpan("ai.reply", { attributes: {} });
  setAttrs(s, attrs);
  pending.set(key, { span: s, ctx: trace.setSpan(context.active(), s) });
  return {
    end(outcome, endAttrs) {
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      setAttrs(entry.span, { "ai.outcome": outcome, ...endAttrs });
      entry.span.setStatus({ code: SpanStatusCode.OK });
      entry.span.end();
    },
  };
}

/** Close a review span from elsewhere (composer send / dismiss). */
export function endReplyTrace(key: string, outcome: string, attrs?: Attrs): void {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  setAttrs(entry.span, { "ai.outcome": outcome, ...attrs });
  entry.span.end();
}

/** Run `fn` as a child of a pending reply trace. */
export async function childSpan<T>(
  key: string,
  name: string,
  attrs: Attrs | undefined,
  fn: (span: Span | null) => Promise<T>
): Promise<T> {
  const entry = pending.get(key);
  if (!tracer || !entry) return span(name, attrs, fn);
  return context.with(entry.ctx, () => span(name, attrs, fn));
}
