/**
 * Startup gate: the entrypoint runs this before the server, so a misconfigured
 * instance fails at start rather than hours later on the first request that
 * needs the bad setting. Runs under Node's type stripping (DESIGN.md §9).
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
