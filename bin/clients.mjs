// How each coding agent is pointed at a gateway. Shared by the launchers and the benchmark runner,
// so a benchmark drives an agent exactly the way `jev-codex`, `jev-claude`, and `jev-opencode` do.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Codex talks to a different backend depending on how the user logged in. */
function codexUpstream() {
  if (process.env.JEV_CODEX_UPSTREAM_BASE_URL) return process.env.JEV_CODEX_UPSTREAM_BASE_URL;
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    if (auth.auth_mode === "chatgpt" || (auth.tokens && !auth.OPENAI_API_KEY)) {
      return "https://chatgpt.com/backend-api/codex";
    }
  } catch {
    // No readable login: assume API-key usage.
  }
  return "https://api.openai.com/v1";
}

const codexProvider = (origin) => ({
  name: `"jev-gateway"`,
  base_url: `"${origin}/v1"`,
  wire_api: `"responses"`,
  // Reuse whatever login Codex already has; the gateway forwards it upstream untouched.
  requires_openai_auth: "true",
});

export const codex = {
  name: "jev-codex",
  client: "codex",
  portEnv: "JEV_CODEX_PORT",
  defaultPort: 8790,
  upstream: codexUpstream,
  upstreamHelp:
    "JEV_CODEX_UPSTREAM_BASE_URL   where Codex traffic goes; default follows your Codex login:\n" +
    "                                ChatGPT login → https://chatgpt.com/backend-api/codex\n" +
    "                                API key       → https://api.openai.com/v1",
  args: (origin) => [
    "-c",
    `model_provider="jev-gateway"`,
    ...Object.entries(codexProvider(origin)).flatMap(([key, value]) => ["-c", `model_providers.jev-gateway.${key}=${value}`]),
  ],
  configHelp: (origin) =>
    `# Save as ~/.codex/jev.config.toml, keep the gateway running (jev-codex --start),\n` +
    `# then use: codex --profile jev\n` +
    `model_provider = "jev-gateway"\n\n[model_providers.jev-gateway]\n` +
    Object.entries(codexProvider(origin))
      .map(([key, value]) => `${key} = ${value}`)
      .join("\n"),
};

export const claude = {
  name: "jev-claude",
  client: "claude",
  portEnv: "JEV_CLAUDE_PORT",
  defaultPort: 8789,
  upstream: () => process.env.JEV_CLAUDE_UPSTREAM_BASE_URL ?? "https://api.anthropic.com/v1",
  upstreamHelp: "JEV_CLAUDE_UPSTREAM_BASE_URL   where Claude traffic goes (default https://api.anthropic.com/v1)",
  // Only the base URL is set. With no gateway credential alongside it, Claude Code keeps using its
  // saved claude.ai login, so a Pro/Max subscription (or an existing API key) keeps working as is.
  env: (origin) => ({ ANTHROPIC_BASE_URL: origin }),
  configHelp: (origin) =>
    `# Keep the gateway running (jev-claude --start), then either:\n` +
    `#   ANTHROPIC_BASE_URL=${origin} claude\n` +
    `# or add to ~/.claude/settings.json:\n` +
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin } }, null, 2),
};

const OPENCODE_PROVIDER = "jev-gateway";
/** OpenCode Zen and OpenCode Go share this endpoint and key; the model id decides what is billed. */
const OPENCODE_ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_PROVIDERS = ["opencode", "opencode-go"];

/** JSONC as OpenCode accepts it: comments and trailing commas go, string contents stay. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
    } else {
      // Outside a string, a comma followed only by whitespace before a closing bracket is trailing.
      if (c === "}" || c === "]") out = out.replace(/,(\s*)$/, "$1");
      out += c;
    }
  }
  return JSON.parse(out);
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function mergeDeep(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = isObject(value) && isObject(out[key]) ? mergeDeep(out[key], value) : value;
  return out;
}

/**
 * The user's OpenCode config, merged the way OpenCode merges it: global files, then OPENCODE_CONFIG,
 * then project files from the repository root down to the working directory, then
 * OPENCODE_CONFIG_DIR. Only read, never written. A file that is missing or does not parse counts
 * as empty: detection is a convenience, and a broken file is OpenCode's to report.
 */
function readOpencodeConfig(env, cwd) {
  const globalDir = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const projectDirs = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    projectDirs.unshift(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  const files = [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((name) => join(globalDir, name)),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...projectDirs.flatMap((dir) => [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]),
    ...(env.OPENCODE_CONFIG_DIR ? [join(env.OPENCODE_CONFIG_DIR, "opencode.json"), join(env.OPENCODE_CONFIG_DIR, "opencode.jsonc")] : []),
  ];
  let config = {};
  for (const file of files) {
    try {
      const data = parseJsonc(readFileSync(file, "utf8"));
      if (isObject(data)) config = mergeDeep(config, data);
    } catch {
      // Missing or unreadable: see above.
    }
  }
  return config;
}

/** The gateway's own address, which must never become its upstream. */
function isGatewayAddress(url, env) {
  try {
    const { hostname, port } = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]"].includes(hostname) && port === String(env.JEV_OPENCODE_PORT ?? 8791);
  } catch {
    return false;
  }
}

/**
 * Where OpenCode traffic goes, and how the launched OpenCode is pointed at the gateway. Either
 * `model` is set, and a `jev-gateway` provider with that model is injected (the explicit and OpenAI
 * paths), or `rebind` lists the user's own providers whose `baseURL` is moved to the gateway. A
 * rebound provider keeps its key and models as the user set them, so no credential is copied here,
 * and the model the user picked, not the launcher, decides what is billed.
 */
export function detectOpencode(env = process.env, cwd = process.cwd()) {
  const override = env.JEV_OPENCODE_UPSTREAM_BASE_URL;
  const openai = { upstream: override ?? "https://api.openai.com/v1", model: env.JEV_OPENCODE_MODEL ?? "gpt-5" };
  const zen = { upstream: override ?? OPENCODE_ZEN_UPSTREAM, rebind: OPENCODE_ZEN_PROVIDERS };
  if (env.JEV_OPENCODE_MODEL) return openai;

  const config = readOpencodeConfig(env, cwd);
  const slash = typeof config.model === "string" ? config.model.indexOf("/") : -1;
  const id = slash > 0 ? config.model.slice(0, slash) : undefined;
  if (id && OPENCODE_ZEN_PROVIDERS.includes(id)) return zen;

  const provider = id && id !== OPENCODE_PROVIDER && isObject(config.provider) ? config.provider[id] : undefined;
  const baseURL = isObject(provider) && provider.npm === "@ai-sdk/openai-compatible" ? provider.options?.baseURL : undefined;
  if (typeof baseURL === "string") {
    const resolved = baseURL.replace(/\{env:([^}]+)\}/g, (_, name) => env[name] ?? "");
    // `{file:...}` and friends stay unresolved; an upstream that is not a URL would fail every request.
    if (/^https?:\/\//.test(resolved) && !resolved.includes("{") && !isGatewayAddress(resolved, env)) {
      return { upstream: override ?? resolved, rebind: [id] };
    }
  }

  // With no provider in the config to follow, an OpenAI key keeps the long-standing default, and an
  // OpenCode key alone, the one that may already pay for Jev, pays for the LLM as well.
  if (!env.OPENAI_API_KEY && env.OPENCODE_API_KEY) return zen;
  return openai;
}

/**
 * Config for the launched OpenCode process, injected through OPENCODE_CONFIG_CONTENT: inline config
 * merges over the user's global/project files, which are never written.
 *
 * A rebind only moves `baseURL`, so every agent and subagent on that provider goes through the
 * gateway with the credential OpenCode already has for it (`opencode auth login`, `{env:...}`, or a
 * key in the file), and the gateway forwards that credential untouched.
 *
 * Otherwise a `jev-gateway` provider is added. `@ai-sdk/openai-compatible` speaks
 * `/v1/chat/completions` off `${origin}/v1`, an endpoint the gateway already routes.
 * `{env:OPENAI_API_KEY}` reuses the user's own OpenAI credential untouched (resolving to empty when
 * unset, like OpenCode's own local-provider examples).
 *
 * Either way the launcher-spawned gateway forwards the client credential untouched: launcher.mjs
 * strips UPSTREAM_API_KEY/ROUTER_API_KEY by design, so no gateway key swap applies here. The key
 * for Jev only authorizes the Jev tool-selection call, even when it is the same OPENCODE_API_KEY.
 */
function opencodeInlineConfig(origin, setup = detectOpencode()) {
  if (setup.rebind) {
    return {
      $schema: "https://opencode.ai/config.json",
      provider: Object.fromEntries(setup.rebind.map((id) => [id, { options: { baseURL: `${origin}/v1` } }])),
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE_PROVIDER}/${setup.model}`,
    small_model: `${OPENCODE_PROVIDER}/${setup.model}`,
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Jev Gateway",
        options: { baseURL: `${origin}/v1`, apiKey: "{env:OPENAI_API_KEY}" },
        models: { [setup.model]: { name: `Jev Gateway (${setup.model})` } },
      },
    },
  };
}

export const opencode = {
  name: "jev-opencode",
  client: "opencode",
  portEnv: "JEV_OPENCODE_PORT",
  defaultPort: 8791,
  upstream: () => detectOpencode().upstream,
  upstreamHelp:
    "JEV_OPENCODE_UPSTREAM_BASE_URL   where OpenCode traffic goes; default follows your OpenCode config:\n" +
    "                                   model on opencode/ or opencode-go/ → https://opencode.ai/zen/v1\n" +
    "                                   model on an openai-compatible provider → its baseURL\n" +
    "                                   otherwise https://api.openai.com/v1 (OpenCode Zen when\n" +
    "                                   OPENCODE_API_KEY is set and OPENAI_API_KEY is not)\n" +
    "  JEV_OPENCODE_MODEL               use jev-gateway/<model> on OpenAI instead of following the config",
  // No `args`: the model default comes from the user's config or the injected one, so a user
  // `-m provider/model` keeps its documented top priority and every other `opencode` flag forwards
  // untouched. The two experimental flags stay off for the launched process only (environment,
  // never a user file): the stable AI SDK provider path above is the supported one.
  env: (origin) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeInlineConfig(origin)),
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
    OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
  }),
  configHelp: (origin) => {
    // No OPENCODE_CONFIG_CONTENT one-liner here: single-quoting raw JSON breaks when a custom
    // model ID contains an apostrophe. The opencode.json file workflow below needs no shell
    // quoting and matches what `jev-opencode --print-config` documents.
    const setup = detectOpencode();
    const config = opencodeInlineConfig(origin, setup);
    if (setup.rebind) {
      // Once the file points a custom provider at the gateway, its real address is no longer in the
      // config to detect, so the gateway has to be told. Zen's address is fixed and needs no note.
      const upstreamNote =
        setup.rebind === OPENCODE_ZEN_PROVIDERS
          ? ""
          : `# That provider now points at the gateway, so start the gateway with its real address:\n` +
            `#   JEV_OPENCODE_UPSTREAM_BASE_URL=${setup.upstream} jev-opencode --start\n`;
      return (
        `# Keep the gateway running (jev-opencode --start), then add to opencode.json\n` +
        `# (project root or ~/.config/opencode/opencode.json), next to what is already there:\n` +
        `${JSON.stringify({ provider: config.provider }, null, 2)}\n` +
        upstreamNote
      );
    }
    const manual = JSON.stringify({ model: config.model, small_model: config.small_model, provider: config.provider }, null, 2);
    return (
      `# Keep the gateway running (jev-opencode --start), then add to opencode.json\n` +
      `# (project root or ~/.config/opencode/opencode.json):\n` +
      `${manual}\n` +
      `# then select it with: opencode --model ${config.model}`
    );
  },
};
export const gemini = {
  name: "jev-gemini",
  client: "gemini",
  portEnv: "JEV_GEMINI_PORT",
  defaultPort: 8788,
  upstream: () => process.env.JEV_GEMINI_UPSTREAM_BASE_URL ?? "https://generativelanguage.googleapis.com",
  upstreamHelp: "JEV_GEMINI_UPSTREAM_BASE_URL   where Gemini traffic goes (default https://generativelanguage.googleapis.com)",
  env: (origin) => ({
    GEMINI_API_BASE: origin,
    GOOGLE_GEMINI_BASE_URL: origin,
  }),
  configHelp: (origin) =>
    `# Point your Gemini client or SDK at:\n` +
    `#   GEMINI_API_BASE=${origin}\n` +
    `#   or endpoint: ${origin}/v1beta\n`,
};

