import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDump } from "./debug.js";
import { createAskJev } from "./jev.js";
import { createEventLog } from "./events.js";

const config = loadConfig();
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const askJev = createAskJev(config);

const app = createApp({
  config,
  askJev,
  dump: createDump(config.debugDumpDir),
  events: createEventLog({ historyFile: config.logFile }),
  log,
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, ({ port }) => {
  console.log(`jev-gateway listening on http://localhost:${port} → ${config.upstreamBaseUrl} (jev: ${config.jevModel} via ${config.jevProvider})`);
  console.log(`dashboard: http://localhost:${port}/dashboard`);
});
