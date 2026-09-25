/** A domain refusal, caught and handed back typed: anything else still throws. */
import { ValidationError } from "~/lib/input.server";

export async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected a refusal, and there was none.");
}
