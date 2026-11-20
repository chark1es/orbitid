import { describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { errorMessage, retryAfterText } from "./errors";

function limited(headers: Record<string, string>, meta?: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ errors: [{ code: "rate_limit_exceeded", message: "Too many requests. Please try again later.", meta }] }),
    { status: 429, headers: { "Content-Type": "application/json", ...headers } },
  );
}

describe("rate-limited answers", () => {
  it("carries Retry-After on the error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(limited({ "Retry-After": "12" }));
    const error = await api("GET", "/users").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).retryAfter).toBe(12);
    expect(errorMessage(error)).toBe("Too many attempts. Try again in 12 seconds.");
  });

  it("falls back to the error's meta, and to a generic wait without either", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(limited({}, { retry_after: 90 }));
    expect((await api("GET", "/users").catch((cause: ApiError) => cause)).retryAfter).toBe(90);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(limited({}));
    const bare = await api("GET", "/users").catch((cause: ApiError) => cause);
    expect(bare.retryAfter).toBeUndefined();
    expect(errorMessage(bare)).toBe("Too many attempts. Try again in a moment.");
  });

  it("phrases the wait in seconds, then minutes", () => {
    expect(retryAfterText(1)).toBe("Try again in 1 second.");
    expect(retryAfterText(59)).toBe("Try again in 59 seconds.");
    expect(retryAfterText(60)).toBe("Try again in 1 minute.");
    expect(retryAfterText(300)).toBe("Try again in 5 minutes.");
    expect(retryAfterText(0)).toBe("Try again in a moment.");
  });

  it("leaves other errors' text alone", () => {
    expect(errorMessage(new ApiError(403, "not_allowed_access", "No console access"))).toBe("No console access");
  });
});
