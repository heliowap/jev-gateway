import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDump } from "./debug.js";
import { createAskJev } from "./jev.js";
import { createEventLog } from "./events.js";

const config = loadConfig();
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

// The switch changes what the user pays for, so it is logged, and the dashboard names the model
// that answers from then on rather than the one the gateway started with.
const askJev = createAskJev(config, fetch, (model, reason) => {
  log({ event: "jev_fallback", from: config.jevModel, to: model, reason });
  config.jevModel = model;
});

const app = createApp({
  config,
  askJev,
  dump: createDump(config.debugDumpDir),
  events: createEventLog({ historyFile: config.logFile }),
  log,
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, ({ port }) => {
  const fallback = config.jevFallbackModel ? ` → fallback ${config.jevFallbackModel}` : "";
  console.log(`jev-gateway listening on http://localhost:${port} → ${config.upstreamBaseUrl} (jev: ${config.jevModel}${fallback} via ${config.jevProvider})`);
  console.log(`dashboard: http://localhost:${port}/dashboard`);
});
