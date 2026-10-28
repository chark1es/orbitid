import * as React from "react";
import { auth } from "./server-auth";
import { orbitIdClient } from "./backend-client";

interface ReactWithCache {
  cache?: <Fn extends (...args: never[]) => unknown>(fn: Fn) => Fn;
}

// React 18 and 19 type definitions disagree on `cache`; runtime presence is what matters here.
const reactWithCache = React as unknown as ReactWithCache;
const cacheAsync = reactWithCache.cache ?? (<Fn extends (...args: never[]) => unknown>(fn: Fn) => fn);

/** Current user fetched from the Backend API, cached per request through React `cache`. */
const memoizedCurrentUser = cacheAsync(async () => {
  const { userId } = await auth();
  if (!userId) return null;
  return orbitIdClient().users.getUser(userId);
});

export function currentUser() {
  return memoizedCurrentUser();
}
