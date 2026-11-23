import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export const RELEASE_QUERY_KEY = ["instance", "version"];

const RELEASE_PAGE_PREFIX = "https://github.com/chark1es/orbitid/releases/";

/** `GET /instance`'s `version`: the running build and the server's last release check. */
export interface ReleaseStatus {
  /** Null when the server is too old to report it. */
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function parseRelease(response: unknown): ReleaseStatus {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const version =
    record.version && typeof record.version === "object" ? (record.version as Record<string, unknown>) : {};
  const latest = text(version.latest);
  const releaseUrl = text(version.release_url);
  return {
    current: text(version.current),
    latest,
    // The link must point at OrbitID's own release notes; anything else is not shown.
    releaseUrl: releaseUrl?.startsWith(RELEASE_PAGE_PREFIX) ? releaseUrl : null,
    updateAvailable: version.update_available === true && latest !== null,
  };
}

/** `v1.2.3` for display; the server reports bare semver. */
export function displayVersion(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}

/**
 * Whether a newer OrbitID release exists. The server checks GitHub on its own schedule and caches the answer, so
 * this read is cheap; a long stale time keeps the shell from asking on every navigation.
 */
export function useRelease() {
  return useQuery<ReleaseStatus>({
    queryKey: RELEASE_QUERY_KEY,
    queryFn: async ({ signal }) => parseRelease(await api<unknown>("GET", "/instance", undefined, signal)),
    staleTime: 10 * 60_000,
  });
}
