/* ------------------------------------------------------------------------------------------------
 * Frameworks
 * ---------------------------------------------------------------------------------------------- */

export const FRAMEWORKS = [
  { key: "nextjs", label: "Next.js", install: "bun add @orbitid/nextjs" },
  { key: "express", label: "Node (Express)", install: "bun add @orbitid/node express" },
  { key: "node", label: "Plain Node script", install: "bun add @orbitid/node" },
  { key: "react", label: "React + backend", install: "bun add @orbitid/react @orbitid/backend" },
] as const;

export type FrameworkKey = (typeof FRAMEWORKS)[number]["key"];

export const frameworkLabel = (key: FrameworkKey): string => FRAMEWORKS.find((item) => item.key === key)?.label ?? key;
export const frameworkInstall = (key: FrameworkKey): string => FRAMEWORKS.find((item) => item.key === key)?.install ?? "";

/* ------------------------------------------------------------------------------------------------
 * Values the page reads from the instance
 * ---------------------------------------------------------------------------------------------- */

export interface ConnectTarget {
  /** `pk_test_…` / `pk_live_…`, from the public health endpoint. */
  publishableKey: string;
  /** Frontend/Backend API origin the dashboard is pointed at. */
  apiUrl: string;
  /** Sign-in / sign-up paths on the operator's site, derived from the application home URL. */
  homeUrl: string;
  signInUrl: string;
  signUpUrl: string;
}

const trimSlash = (value: string): string => value.trim().replace(/\/+$/, "");

/** `https://app.example.com` → `https://app.example.com/sign-in`. */
export function signInUrlFor(homeUrl: string | undefined, path = "/sign-in"): string {
  const home = trimSlash(homeUrl ?? "");
  return home ? `${home}${path}` : `https://your-app.example.com${path}`;
}

/**
 * The dashboard never holds the secret key after sign-in, so the snippets carry a placeholder and say where
 * the key comes from. Copying a block can then never move a live credential into a chat or a ticket.
 */
export const SECRET_KEY_PLACEHOLDER = "sk_test_…";

export function connectTarget(input: {
  publishableKey: string;
  apiUrl: string;
  homeUrl: string | undefined;
}): ConnectTarget {
  const home = trimSlash(input.homeUrl ?? "");
  return {
    publishableKey: input.publishableKey.trim(),
    apiUrl: trimSlash(input.apiUrl),
    homeUrl: home,
    signInUrl: signInUrlFor(home || undefined, "/sign-in"),
    signUpUrl: signInUrlFor(home || undefined, "/sign-up"),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Copy-ready blocks
 * ---------------------------------------------------------------------------------------------- */

export interface EnvVariable {
  name: string;
  value: string;
  /** Rendered above the variable as a `#` line. */
  comment?: string;
  /** Rendered as a commented-out line: the variable exists but this project does not need it. */
  optional?: boolean;
}

export interface ConnectBlock {
  id: "browser" | "backend";
  heading: string;
  /** One line: where the values go. */
  where: string;
  filename: string;
  variables: EnvVariable[];
  note?: string;
}

export interface ConnectPlan {
  framework: FrameworkKey;
  label: string;
  install: string;
  blocks: ConnectBlock[];
  sample: { title: string; code: string };
}


/** `NAME=value` lines, with `#` comments, suitable for a `.env` file. */
export function renderEnvBlock(block: ConnectBlock): string {
  return block.variables
    .flatMap((variable) => {
      const lines = variable.comment ? [`# ${variable.comment}`] : [];
      const assignment = `${variable.name}=${variable.value}`;
      lines.push(variable.optional ? `# ${assignment}` : assignment);
      return lines;
    })
    .join("\n");
}

/** A block plus its neighbours, so "copy all" can paste a whole file. */
export function renderEnvBlocks(blocks: readonly ConnectBlock[]): string {
  return blocks.map((block) => renderEnvBlock(block)).join("\n\n");
}

/**
 * One labelled block with its heading and destination above it, so a copy pasted into a ticket or a
 * chat keeps the "where this goes" instruction attached.
 */
export function renderBlockWithHeader(block: ConnectBlock): string {
  return [`# ${block.heading}`, `# ${block.where}`, "", renderEnvBlock(block)].join("\n");
}
