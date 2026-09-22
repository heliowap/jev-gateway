import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import type { Config } from "./config.js";
import type { AskJev } from "./decide.js";
import table from "./providers.json" with { type: "json" };

/** One row of the provider table: where Jev runs, which key gets there, and what to call it. */
interface Provider {
  label: string;
  note: string;
  keyEnv: string;
  keyUrl: string;
  url: string;
  model: string;
  /** A model for the same endpoint to switch to once `model` stops answering; absent for most providers. */
  fallbackModel?: string;
}

/**
 * Where Jev can be reached. TypeSafe's own API, and gateways that resell it: all of them take
 * the same request body and return the same answers, so one transport serves them. The table is
 * JSON because the launchers' setup wizard (plain .mjs, no build step) reads the same file.
 */
const providers = table as Record<keyof typeof table, Provider>;
export type ProviderId = keyof typeof table;
export const PROVIDERS = providers;
export const isProvider = (value: string): value is ProviderId => value in providers;

type Env = Record<string, string | undefined>;
const present = (env: Env, name: string) => Boolean(env[name]?.trim());

/** An explicit JEV_PROVIDER wins; otherwise whichever key is there, TypeSafe's own first. */
export function resolveProvider(env: Env): ProviderId {
  const chosen = env.JEV_PROVIDER?.trim().toLowerCase();
  if (chosen) {
    if (!isProvider(chosen)) throw new Error(`JEV_PROVIDER must be one of ${Object.keys(providers).join(", ")}, got "${chosen}"`);
    return chosen;
  }
  return (Object.keys(providers) as ProviderId[]).find((id) => present(env, providers[id].keyEnv)) ?? "typesafe";
}

/**
 * Model ids live in different namespaces: TypeSafe's and OpenCode's have no slash (`jev-latest`,
 * `jev-1.13-free`), the reselling gateways' do (`typesafe/jev-1.13`). A JEV_MODEL written for one
 * provider is ignored under another, so switching provider never sends an id the new one cannot know.
 */
export function resolveModel(provider: ProviderId, requested: string | undefined): string {
  const fits = requested && requested.includes("/") === providers[provider].model.includes("/");
  return fits ? requested : providers[provider].model;
}

/**
 * JEV_URL replaces the endpoint outright. TYPESAFE_BASE_URL is the variable TypeSafe's own SDK
 * reads, kept so a local stand-in for Jev (scripts/mock-jev.mjs) plugs in the way it always did.
 */
export function resolveUrl(provider: ProviderId, env: Env): string {
  const explicit = env.JEV_URL?.trim();
  if (explicit) return explicit;
  const base = provider === "typesafe" ? env.TYPESAFE_BASE_URL?.trim() : undefined;
  return base ? `${base.replace(/\/+$/, "")}/v1/systemone` : providers[provider].url;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
/**
 * What says the model itself is gone, such as a free tier that ended. A timeout, a rate limit or a
 * server error says nothing about the model, and the switch lasts until the gateway restarts, so
 * those fail open as they always did.
 */
const MODEL_GONE = new Set([404, 410]);

/** Some gateways return choice answers without a confidence; the winning probability stands in. */
function normalize(result: SystemOneResult<Questions>): SystemOneResult<Questions> {
  const answers: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(result.answers ?? {})) {
    const probabilities = "probabilities" in answer ? Object.values(answer.probabilities as Record<string, number>) : [];
    answers[name] =
      answer.type !== "noul" && typeof answer.confidence !== "number" && probabilities.length
        ? { ...answer, confidence: Math.max(...probabilities) }
        : answer;
  }
  return { model: result.model, answers, usage: { input_tokens: result.usage?.input_tokens ?? 0, output_tokens: result.usage?.output_tokens ?? 0 } } as SystemOneResult<Questions>;
}

/**
 * The one call the gateway makes to Jev, for whichever provider is configured. `onFallback` hears
 * about the switch to the fallback model, which changes what the user pays for.
 */
export function createAskJev(
  config: Pick<Config, "jevProvider" | "jevApiKey" | "jevUrl" | "jevFallbackModel" | "jevTimeoutMs">,
  fetchImpl: typeof fetch = fetch,
  onFallback: (model: string, reason: string) => void = () => {},
): AskJev {
  const provider = providers[config.jevProvider];
  if (!config.jevApiKey) {
    throw new Error(`No API key for Jev: set ${provider.keyEnv} (${provider.label}), or run jev-codex --setup.`);
  }
  const fallback = config.jevFallbackModel;
  /** Set once the fallback has answered: the primary is not tried again until the gateway restarts. */
  let switched = false;
  const once = async (request: SystemOneRequest<Questions>, model?: string) => {
    const response = await fetchImpl(config.jevUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.jevApiKey}`,
        "content-type": "application/json",
        // OpenRouter attributes traffic by these; the others ignore them.
        "http-referer": "https://github.com/vinilana/jev-gateway",
        "x-title": "jev-gateway",
      },
      body: JSON.stringify(model === undefined ? request : { ...request, model }),
      signal: AbortSignal.timeout(config.jevTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw Object.assign(new Error(`${response.status} from ${provider.label}: ${detail}`), { status: response.status });
    }
    return normalize((await response.json()) as SystemOneResult<Questions>);
  };
  // One fast retry only: past that, failing open to the LLM is quicker.
  const attempt = async (request: SystemOneRequest<Questions>, model?: string) => {
    try {
      return await once(request, model);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== undefined && !RETRYABLE.has(status)) throw error;
      await new Promise((done) => setTimeout(done, 100));
      return once(request, model);
    }
  };
  return async (request) => {
    if (switched && fallback) return attempt(request, fallback);
    try {
      return await attempt(request);
    } catch (error) {
      const status = (error as { status?: number }).status;
      // The fallback is one plain call: the next request goes straight to it.
      if (!fallback || status === undefined || !MODEL_GONE.has(status)) throw error;
      const result = await once(request, fallback);
      switched = true;
      onFallback(fallback, error instanceof Error ? error.message : String(error));
      return result;
    }
  };
}
