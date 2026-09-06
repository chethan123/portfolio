/** Startup gate: runs before the server so bad config fails at start, not on first request (DESIGN.md §9). */
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
