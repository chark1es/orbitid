import { describe, expect, it } from "vitest";
import { rawSessionsFrom, skipMarkerFor } from "./session-markers";

describe("rawSessionsFrom", () => {
  it("reads the response envelope the Frontend API uses", () => {
    const sessions = rawSessionsFrom({
      response: [{ id: "sess_1", status: "active" }, { id: "sess_2", status: "ended" }],
    });
    expect(sessions.map((session) => session.id)).toEqual(["sess_1", "sess_2"]);
  });

  it("accepts a bare array and drops entries that are not objects", () => {
    expect(rawSessionsFrom([{ id: "sess_1" }, "nope", null])).toHaveLength(1);
  });

  it("returns an empty list for an error body", () => {
    expect(rawSessionsFrom({ errors: [{ code: "unauthorized" }] })).toEqual([]);
    expect(rawSessionsFrom(null)).toEqual([]);
  });
});

describe("skipMarkerFor", () => {
  const sessions = [
    { id: "sess_1", second_factor_skipped_by_trusted_device: true },
    { id: "sess_2" },
    { id: "sess_3", second_factor_skipped_by_trusted_device: false },
  ];

  it("marks only an explicit true as skipped", () => {
    expect(skipMarkerFor(sessions, "sess_1")).toBe("skipped");
    expect(skipMarkerFor(sessions, "sess_3")).toBe("not-skipped");
  });

  it("stays unknown when the field is absent or the session is not listed", () => {
    expect(skipMarkerFor(sessions, "sess_2")).toBe("not-skipped");
    expect(skipMarkerFor(sessions, "sess_missing")).toBe("unknown");
    expect(skipMarkerFor(sessions, null)).toBe("unknown");
  });
});
