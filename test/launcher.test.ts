import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");
const { detectOpencode, parseJsonc } = clients as any;

interface LauncherSpec {
  name: string;
  client: string;
  portEnv: string;
  defaultPort: number;
  upstream: () => string;
  upstreamHelp: string;
  args?: (origin: string) => string[];
  tailArgs?: (origin: string, argv: string[]) => string[];
  env?: (origin: string) => Record<string, string>;
  configHelp: (origin: string) => string;
}

const opencode = clients.opencode as LauncherSpec;
const codex = clients.codex as LauncherSpec;
const claude = clients.claude as LauncherSpec;

const origin = "http://127.0.0.1:8791";
const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));

const managedEnv = [
  "JEV_OPENCODE_UPSTREAM_BASE_URL",
  "JEV_OPENCODE_MODEL",
  "JEV_OPENCODE_PORT",
  "JEV_CODEX_UPSTREAM_BASE_URL",
  "JEV_CLAUDE_UPSTREAM_BASE_URL",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "PATH",
] as const;
const savedEnv: Record<string, string | undefined> = {};
let scratch: string;

beforeEach(() => {
  for (const key of managedEnv) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The developer's own ~/.config/opencode must not decide what these tests see.
  scratch = mkdtempSync(join(tmpdir(), "jev-opencode-"));
  process.env.XDG_CONFIG_HOME = join(scratch, "config");
  process.env.XDG_CACHE_HOME = join(scratch, "cache");
});

afterEach(() => {
  for (const key of managedEnv) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A project with its own opencode.jsonc; `.git` stops the walk up at the project root. */
const project = (config: string) => {
  const dir = join(scratch, "project");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "opencode.jsonc"), config);
  return dir;
};

const globalConfig = (config: object) => {
  mkdirSync(join(scratch, "config", "opencode"), { recursive: true });
  writeFileSync(join(scratch, "config", "opencode", "opencode.json"), JSON.stringify(config));
};

const cliProxy = {
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "sk-in-the-file" },
  models: { "custom-model": { name: "Custom" } },
};

const inlineConfig = (originOverride = origin) => {
  const env = opencode.env?.(originOverride);
  expect(env).toBeDefined();
  return JSON.parse(env!.OPENCODE_CONFIG_CONTENT as string) as any;
};

describe("jev-opencode spec", () => {
  it("identifies itself as the opencode launcher on its own port", () => {
    expect(opencode.name).toBe("jev-opencode");
    // launcher.mjs spawns the gateway with JEV_CLIENT: spec.client, so this is what reaches it.
    expect(opencode.client).toBe("opencode");
    expect(opencode.portEnv).toBe("JEV_OPENCODE_PORT");
    expect(opencode.defaultPort).toBe(8791);
    expect([codex.defaultPort, claude.defaultPort]).not.toContain(opencode.defaultPort);
  });

  it("defaults upstream to OpenAI with a JEV_OPENCODE_UPSTREAM_BASE_URL override", () => {
    expect(opencode.upstream()).toBe("https://api.openai.com/v1");
    process.env.JEV_OPENCODE_UPSTREAM_BASE_URL = "https://llm.test/v1";
    expect(opencode.upstream()).toBe("https://llm.test/v1");
    expect(opencode.upstreamHelp).toContain("JEV_OPENCODE_UPSTREAM_BASE_URL");
  });

  it("selects jev-gateway/<model> by default with a JEV_OPENCODE_MODEL override", () => {
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5");
    expect(inlineConfig().small_model).toBe("jev-gateway/gpt-5");
    process.env.JEV_OPENCODE_MODEL = "gpt-5-mini";
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5-mini");
    expect(opencode.upstreamHelp).toContain("JEV_OPENCODE_MODEL");
  });

  it("injects a stable custom-provider config pointing at the gateway, not at TypeSafe", () => {
    const config = inlineConfig();
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    const provider = config.provider["jev-gateway"];
    // Chat Completions path: the gateway already routes POST /v1/chat/completions.
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe(`${origin}/v1`);
    // The user's own OpenAI credential flows through untouched; never a hardcoded secret.
    expect(provider.options.apiKey).toBe("{env:OPENAI_API_KEY}");
    expect(Object.keys(provider.models)).toEqual(["gpt-5"]);
    const raw = JSON.stringify(config);
    expect(raw.toLowerCase()).not.toContain("typesafe");
    expect(raw).not.toContain("/.config/");
    expect(raw).not.toContain("~");
  });

  it("keeps the experimental native LLM and code modes disabled for the launched process", () => {
    const env = opencode.env!(origin);
    expect(env.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBe("false");
    expect(env.OPENCODE_EXPERIMENTAL_CODE_MODE).toBe("false");
  });

  it("starts OpenCode v2 in a private server so it reads the injected gateway config", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const executable = join(bin, "opencode");
    writeFileSync(executable, "#!/bin/sh\nprintf 'opencode v2.0.16\\n'\n");
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${savedEnv.PATH}`;
    expect(opencode.tailArgs!(origin, ["run", "hi"])).toEqual(["--standalone"]);
    expect(opencode.tailArgs!(origin, [])).toEqual(["--standalone"]);
    expect(opencode.tailArgs!(origin, ["run", "hi", "--server", "http://127.0.0.1:4096"])).toEqual([]);
    expect(opencode.tailArgs!(origin, ["auth", "list"])).toEqual([]);
    writeFileSync(executable, "#!/bin/sh\nprintf '1.18.31\\n'\n");
    expect(opencode.tailArgs!(origin, ["run", "hi"])).toEqual([]);
    expect(opencode.args).toBeUndefined();
    expect(typeof opencode.env).toBe("function");
  });

  it("pins v2 Zen model endpoints after OpenCode loads provider settings", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const executable = join(bin, "opencode");
    writeFileSync(executable, "#!/bin/sh\nprintf 'opencode v2.0.16\\n'\n");
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${savedEnv.PATH}`;
    process.env.OPENCODE_API_KEY = "dummy-key";
    const cache = join(scratch, "cache", "opencode");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "models.json"), JSON.stringify({
      opencode: { models: { "claude-opus-5-5": {} } },
      "opencode-go": { models: { "gpt-5": {} } },
    }));

    const config = inlineConfig();
    expect(config.providers.opencode.models["claude-opus-5-5"].settings.baseURL).toBe(`${origin}/v1`);
    expect(config.providers["opencode-go"].models["gpt-5"].settings.baseURL).toBe(`${origin}/v1`);
    expect(config.provider.opencode.options.baseURL).toBe(`${origin}/v1`);
    const help = opencode.configHelp(origin);
    const printed = JSON.parse(help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1));
    expect(printed.providers.opencode.models["claude-opus-5-5"].settings.baseURL).toBe(`${origin}/v1`);
  });

  it("pins the selected Zen model before the v2 catalogue exists", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const executable = join(bin, "opencode");
    writeFileSync(executable, "#!/bin/sh\nprintf 'opencode v2.0.16\\n'\n");
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${savedEnv.PATH}`;
    globalConfig({ model: "opencode/claude-opus-5-5" });
    expect(inlineConfig().providers.opencode.models["claude-opus-5-5"].settings.baseURL).toBe(`${origin}/v1`);
    process.argv.push("-m", "opencode/claude-fable-5");
    try {
      expect(inlineConfig().providers.opencode.models["claude-fable-5"].settings.baseURL).toBe(`${origin}/v1`);
    } finally {
      process.argv.splice(-2);
    }
  });

  it("prints permanent wiring help rooted at the gateway", () => {
    const help = opencode.configHelp(origin);
    expect(help).toContain(`${origin}/v1`);
    expect(help).toContain("jev-gateway/gpt-5");
    expect(help).toContain("opencode.json");
    expect(help).toContain("jev-opencode --start");
    expect(help).toContain("--model jev-gateway/gpt-5");
    // The file workflow below needs no shell quoting; the JSON block must parse as-is.
    const jsonBlock = help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonBlock) as any;
    expect(parsed.model).toBe("jev-gateway/gpt-5");
    expect(parsed.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
    // No raw-JSON shell one-liner: single-quoting breaks on apostrophes in custom model IDs.
    expect(help).not.toContain("OPENCODE_CONFIG_CONTENT='");
    process.env.JEV_OPENCODE_MODEL = "other-model";
    expect(opencode.configHelp(origin)).toContain("jev-gateway/other-model");
  });

  it("stays safe when a custom model ID contains an apostrophe", () => {
    process.env.JEV_OPENCODE_MODEL = "o'brien";
    const config = inlineConfig();
    expect(config.model).toBe("jev-gateway/o'brien");
    expect(Object.keys(config.provider["jev-gateway"].models)).toEqual(["o'brien"]);
    const help = opencode.configHelp(origin);
    expect(help).not.toContain("OPENCODE_CONFIG_CONTENT='");
    const jsonBlock = help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1);
    expect(() => JSON.parse(jsonBlock)).not.toThrow();
    expect((JSON.parse(jsonBlock) as any).model).toBe("jev-gateway/o'brien");
  });
});

describe("jev-opencode follows the user's OpenCode config", () => {
  it("follows a v2 model selection and native provider settings", () => {
    globalConfig({ model: { providerID: "opencode", model: "gpt-5.1-codex" } });
    expect(detectOpencode(process.env, scratch)).toEqual({ upstream: "https://opencode.ai/zen/v1", rebind: ["opencode", "opencode-go"] });

    globalConfig({
      model: { providerID: "cli_proxy", model: "custom-model" },
      providers: { cli_proxy: { package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "sk-in-the-file" } } },
    });
    expect(detectOpencode(process.env, scratch)).toEqual({ upstream: "http://127.0.0.1:8317/v1", rebind: ["cli_proxy"] });
    process.env.OPENCODE_CONFIG = join(scratch, "config", "opencode", "opencode.json");
    expect(inlineConfig().provider).toEqual({ cli_proxy: { options: { baseURL: `${origin}/v1` } } });
    expect(opencode.env!(origin).OPENCODE_CONFIG_CONTENT).not.toContain("sk-in-the-file");
  });

  it("reads v2 project config from .opencode", () => {
    const dir = join(scratch, "project");
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, ".opencode"));
    writeFileSync(join(dir, ".opencode", "opencode.json"), JSON.stringify({ model: { providerID: "opencode", model: "gpt-5.1-codex" } }));
    expect(detectOpencode(process.env, dir).upstream).toBe("https://opencode.ai/zen/v1");
  });

  it("sends opencode/ and opencode-go/ models to Zen and moves only the baseURL of both providers", () => {
    for (const model of ["opencode/some-zen-model", "opencode-go/some-go-model"]) {
      globalConfig({ model });
      const setup = detectOpencode(process.env, scratch);
      expect(setup.upstream).toBe("https://opencode.ai/zen/v1");
      expect(setup.model).toBeUndefined();
      const config = inlineConfig();
      // The user's model stays the default, so the model id the user picked decides what is billed.
      expect(config.model).toBeUndefined();
      expect(config.provider).toEqual({
        opencode: { options: { baseURL: `${origin}/v1` } },
        "opencode-go": { options: { baseURL: `${origin}/v1` } },
      });
    }
  });

  it("forwards to a custom provider's own address and never copies its key", () => {
    const dir = project(`{
      // a local proxy, as OpenCode's docs configure one
      "model": "cli_proxy/custom-model",
      "provider": { "cli_proxy": ${JSON.stringify(cliProxy)}, },
    }`);
    expect(detectOpencode(process.env, dir)).toEqual({ upstream: "http://127.0.0.1:8317/v1", rebind: ["cli_proxy"] });
    // The spec reads from the working directory; OPENCODE_CONFIG reaches the same file from here.
    process.env.OPENCODE_CONFIG = join(dir, "opencode.jsonc");
    expect(inlineConfig().provider).toEqual({ cli_proxy: { options: { baseURL: `${origin}/v1` } } });
    const raw = opencode.env!(origin).OPENCODE_CONFIG_CONTENT as string;
    expect(raw).not.toContain("sk-in-the-file");
    expect(raw).not.toContain("{env:OPENAI_API_KEY}");
  });

  it("merges a project entry into the global one for the same provider", () => {
    globalConfig({ provider: { cli_proxy: cliProxy } });
    const dir = project(`{ "model": "cli_proxy/other", "provider": { "cli_proxy": { "models": { "other": {} } } } }`);
    expect(detectOpencode(process.env, dir).upstream).toBe("http://127.0.0.1:8317/v1");
  });

  it("resolves {env:...} in a baseURL and skips one it cannot turn into a URL", () => {
    const withEnv = { ...cliProxy, options: { baseURL: "{env:PROXY_URL}/v1" } };
    globalConfig({ model: "cli_proxy/custom-model", provider: { cli_proxy: withEnv } });
    expect(detectOpencode({ ...process.env, PROXY_URL: "http://10.0.0.2:4000" }, scratch).upstream).toBe("http://10.0.0.2:4000/v1");
    expect(detectOpencode(process.env, scratch).upstream).toBe("https://api.openai.com/v1");
  });

  it("never takes the gateway's own address, or its own provider, as the upstream", () => {
    const pointedAtGateway = { ...cliProxy, options: { baseURL: `${origin}/v1` } };
    globalConfig({ model: "cli_proxy/custom-model", provider: { cli_proxy: pointedAtGateway } });
    expect(detectOpencode(process.env, scratch).upstream).toBe("https://api.openai.com/v1");
    process.env.JEV_OPENCODE_PORT = "9100";
    expect(detectOpencode(process.env, scratch).upstream).toBe(`${origin}/v1`);
    delete process.env.JEV_OPENCODE_PORT;

    globalConfig({ model: "jev-gateway/gpt-5", provider: { "jev-gateway": { ...cliProxy, options: { baseURL: "http://127.0.0.1:9999/v1" } } } });
    expect(detectOpencode(process.env, scratch).upstream).toBe("https://api.openai.com/v1");
  });

  it("follows only the default model's provider, not any custom provider in the file", () => {
    globalConfig({ model: "anthropic/claude-sonnet", provider: { cli_proxy: cliProxy } });
    expect(detectOpencode(process.env, scratch)).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5" });
  });

  it("with no provider to follow, pays the LLM with an OpenCode key only when there is no OpenAI key", () => {
    process.env.OPENCODE_API_KEY = "zen-key";
    expect(detectOpencode(process.env, scratch).upstream).toBe("https://opencode.ai/zen/v1");
    expect(inlineConfig().provider.opencode.options).toEqual({ baseURL: `${origin}/v1` });
    process.env.OPENAI_API_KEY = "openai-key";
    expect(detectOpencode(process.env, scratch)).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5" });
  });

  it("lets the explicit settings win over the config", () => {
    globalConfig({ model: "opencode/some-zen-model" });
    process.env.JEV_OPENCODE_UPSTREAM_BASE_URL = "https://llm.test/v1";
    expect(detectOpencode(process.env, scratch)).toEqual({ upstream: "https://llm.test/v1", rebind: ["opencode", "opencode-go"] });
    process.env.JEV_OPENCODE_MODEL = "gpt-5-mini";
    expect(detectOpencode(process.env, scratch)).toEqual({ upstream: "https://llm.test/v1", model: "gpt-5-mini" });
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5-mini");
  });

  it("prints a rebind snippet, with the real address to start the gateway with for a custom provider", () => {
    globalConfig({ model: "opencode/some-zen-model" });
    const zenHelp = opencode.configHelp(origin);
    expect(JSON.parse(zenHelp.slice(zenHelp.indexOf("{"), zenHelp.lastIndexOf("}") + 1)).provider.opencode.options.baseURL).toBe(`${origin}/v1`);
    expect(zenHelp).not.toContain("JEV_OPENCODE_UPSTREAM_BASE_URL");

    globalConfig({ model: "cli_proxy/custom-model", provider: { cli_proxy: cliProxy } });
    const help = opencode.configHelp(origin);
    expect(help).toContain("JEV_OPENCODE_UPSTREAM_BASE_URL=http://127.0.0.1:8317/v1 jev-opencode --start");
    expect(help).not.toContain("sk-in-the-file");
  });

  it("reads JSONC without touching strings that look like comments or trailing commas", () => {
    const text = `{\n  // comment\n  "url": "https://opencode.ai/zen/v1", /* block */\n  "odd": "a,}\\"//",\n  "list": [1, 2,],\n}`;
    expect(parseJsonc(text)).toEqual({ url: "https://opencode.ai/zen/v1", odd: 'a,}"//', list: [1, 2] });
  });

  it("ignores a config file that does not parse", () => {
    const dir = project(`{ "model": "opencode/x", oops }`);
    expect(detectOpencode(process.env, dir).upstream).toBe("https://api.openai.com/v1");
  });
});

describe("jev-opencode entrypoint", () => {
  // No saved key in ~/.jev-gateway/.env and no OpenCode config of the developer's reach the launcher.
  const isolatedEnv = () => ({ PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), JEV_SKIP_PROJECT_ENV: "1" });

  it("is registered in package.json with a runnable script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-opencode"]).toBe("bin/jev-opencode.mjs");
    expect(pkg.scripts.opencode).toBe("node bin/jev-opencode.mjs");
  });

  it("--gateway-help describes the opencode launcher without starting anything", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--gateway-help"], { encoding: "utf8", timeout: 30_000, env: isolatedEnv() });
    expect(out).toContain("jev-opencode: opencode with tool selection routed through Jev");
    expect(out).toContain("--print-config");
  });

  it("--print-config prints the gateway-rooted provider config without starting anything", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--print-config"], { encoding: "utf8", timeout: 30_000, env: isolatedEnv() });
    expect(out).toContain("http://127.0.0.1:8791/v1");
    expect(out).toContain("jev-gateway");
  });
});

describe("existing launchers", () => {
  it("keeps the codex and claude specs intact", () => {
    expect(codex.name).toBe("jev-codex");
    expect(codex.client).toBe("codex");
    expect(codex.defaultPort).toBe(8790);
    // No readable login (CODEX_HOME is pointed at nothing): falls back to the API backend.
    process.env.CODEX_HOME = "/nonexistent-jev-test-dir";
    expect(codex.upstream()).toBe("https://api.openai.com/v1");
    expect(codex.args!(origin).join(" ")).toContain('model_provider="jev-gateway"');

    expect(claude.name).toBe("jev-claude");
    expect(claude.client).toBe("claude");
    expect(claude.defaultPort).toBe(8789);
    expect(claude.upstream()).toBe("https://api.anthropic.com/v1");
    expect(claude.env!(origin)).toEqual({ ANTHROPIC_BASE_URL: origin });
  });
});
