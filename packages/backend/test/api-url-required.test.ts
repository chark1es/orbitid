import { describe, expect, it } from "vitest";
import { createOrbitIdClient } from "../src";

describe("the Backend API URL", () => {
  it("is required: there is no hosted default the secret key could be sent to", () => {
    expect(() => createOrbitIdClient({ secretKey: "sk_test_abc" } as never)).toThrow(/apiUrl/);
    expect(createOrbitIdClient({ secretKey: "sk_test_abc", apiUrl: "https://auth.example.com/" }).apiUrl).toBe("https://auth.example.com");
  });
});
