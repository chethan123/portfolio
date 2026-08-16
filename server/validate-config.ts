/**
 * Startup gate. The container entrypoint runs this before the server, so a
 * misconfigured instance fails immediately and loudly rather than hours later
 * on the first request that happens to need the bad setting.
 *
 * Run directly under Node 24's type stripping — no build step for operational
 * scripts (DESIGN.md §9).
 */
import { ConfigError, loadConfig } from "./config.ts";

try {
  loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

console.log("Configuration OK.");
