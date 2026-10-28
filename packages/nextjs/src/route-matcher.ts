export interface RouteMatcherRequest {
  url: string;
  nextUrl?: { pathname?: string };
}

export type RouteMatcher = (req: RouteMatcherRequest) => boolean;
export type RouteMatcherPattern = string | RegExp;
export type RouteMatcherParam = RouteMatcherPattern | RouteMatcher | Array<RouteMatcherPattern | RouteMatcher>;

/**
 * Compile a Next.js-style path pattern into a RegExp.
 *
 * Supported syntax (a superset of what Clerk's `createRouteMatcher` accepts):
 * - `:param`          → one path segment           (`/api/:id`)
 * - `:param*`, `:param+` → rest of the path        (`/api/:path*`)
 * - `*`               → within one segment        (`/files/*.png`)
 * - `**`              → anything                   (`/admin/**`)
 * - `(.*)`            → inline regex group         (`/dashboard(.*)`)
 */
export function compileRoutePattern(pattern: string): RegExp {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "/" && pattern[i + 1] === ":") {
      let end = i + 2;
      while (end < pattern.length && /[A-Za-z0-9_]/.test(pattern[end]!)) end += 1;
      const modifier = pattern[end];
      if (modifier === "*") {
        source += "(?:/.*)?";
        i = end + 1;
        continue;
      }
      if (modifier === "+") {
        source += "/.+";
        i = end + 1;
        continue;
      }
    }
    if (char === ":") {
      let end = i + 1;
      while (end < pattern.length && /[A-Za-z0-9_]/.test(pattern[end]!)) end += 1;
      if (end === i + 1) {
        source += ":";
        i += 1;
        continue;
      }
      const modifier = pattern[end];
      if (modifier === "*") {
        source += ".*";
        i = end + 1;
      } else if (modifier === "+") {
        source += ".+";
        i = end + 1;
      } else {
        source += "[^/]+";
        i = end;
      }
      continue;
    }
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 2;
      } else {
        source += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (char === "(" || char === ")" || char === "?" || char === "|") {
      source += char;
      i += 1;
      continue;
    }
    if (char === "." && pattern[i + 1] === "*") {
      source += ".*";
      i += 2;
      continue;
    }
    if (char === ".") {
      source += "\\.";
      i += 1;
      continue;
    }
    if (char === "/" || /[A-Za-z0-9_\-~%]/.test(char)) {
      source += char;
      i += 1;
      continue;
    }
    source += `\\${char}`;
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

function pathnameOf(req: RouteMatcherRequest): string {
  if (req.nextUrl?.pathname) return req.nextUrl.pathname;
  try {
    return new URL(req.url).pathname;
  } catch {
    return req.url;
  }
}

/**
 * Create a matcher for middleware route protection.
 *
 * ```ts
 * const isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/api/:path*']);
 * const isAdminRoute = createRouteMatcher([/^\/admin(\/|$)/]);
 * ```
 */
export function createRouteMatcher(patterns: RouteMatcherParam): RouteMatcher {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const compiled = list.map((pattern) => {
    if (typeof pattern === "function") return pattern;
    if (pattern instanceof RegExp) return (req: RouteMatcherRequest) => pattern.test(pathnameOf(req));
    const regex = compileRoutePattern(pattern);
    return (req: RouteMatcherRequest) => regex.test(pathnameOf(req));
  });

  return (req: RouteMatcherRequest) => compiled.some((match) => match(req));
}
