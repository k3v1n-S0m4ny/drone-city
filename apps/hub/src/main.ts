import { runBackfill } from "./backfill.ts";
import { ConfigError, readConfig } from "./config.ts";
import { loadDotEnv } from "./env.ts";
import { createHub } from "./server.ts";

async function main(): Promise<void> {
  const envFile = loadDotEnv();
  let config;
  try {
    config = readConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`hub: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const hub = createHub(config);
  const addr = await hub.listen();
  console.log(`hub: listening on http://${addr.host}:${addr.port}`);
  console.log(`hub: endpoints POST /v1/logs (OTLP/HTTP JSON only), GET /ws, GET /health`);
  console.log(
    `hub: config from ${envFile ? ".env + environment" : "environment"}; repo filter active`,
  );

  if (config.backfill) {
    const clock = { now: () => Date.now() };
    const s = await runBackfill(config, hub, clock);
    console.log(
      `hub: backfill scanned ${s.dirs} dirs, ${s.sessions} sessions, ${s.files} files: ` +
        `${s.events} events (${s.malformed} malformed lines, ${s.unreadable} unreadable files)`,
    );
  }

  const stop = (): void => {
    hub.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(`hub: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
