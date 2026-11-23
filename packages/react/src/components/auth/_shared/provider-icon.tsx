import { GlobeIcon } from "lucide-react";
import { cn } from "@orbitid/ui";

export interface ProviderIconProps {
  provider: string;
  className?: string;
}

function normalize(provider: string): string {
  return provider
    .replace(/^oauth_/, "")
    .replace(/^custom_/, "")
    .toLowerCase();
}

/**
 * Inline brand marks for every social provider the server supports. No external images or icon
 * packages: the SVG is part of the component bundle.
 */
export function ProviderIcon({ provider, className }: ProviderIconProps) {
  const id = normalize(provider);
  const cls = cn("size-4 shrink-0", className);

  switch (id) {
    case "google":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <path
            fill="#4285F4"
            d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z"
          />
          <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29A12 12 0 0 0 0 12c0 1.94.47 3.76 1.29 5.38l3.98-3.09Z" />
          <path
            fill="#EA4335"
            d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
          />
        </svg>
      );
    case "github":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="currentColor">
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.084 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.045.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12Z" />
        </svg>
      );
    case "gitlab":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <path fill="#FC6D26" d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.387 9.452.045 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.624-8.443a.92.92 0 0 0 .331-1.024Z" />
          <path fill="#E24329" d="M12 23.054l4.418-13.604H7.582L12 23.054Z" />
        </svg>
      );
    case "discord":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#5865F2">
          <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.319 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.182 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.332-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.332-.946 2.418-2.157 2.418Z" />
        </svg>
      );
    case "microsoft":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <path fill="#F25022" d="M1 1h10v10H1z" />
          <path fill="#7FBA00" d="M13 1h10v10H13z" />
          <path fill="#00A4EF" d="M1 13h10v10H1z" />
          <path fill="#FFB900" d="M13 13h10v10H13z" />
        </svg>
      );
    case "apple":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="currentColor">
          <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11Z" />
        </svg>
      );
    case "facebook":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <path fill="#1877F2" d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.413c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.971H15.83c-1.491 0-1.956.93-1.956 1.886v2.264h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073Z" />
          <path fill="#fff" d="M16.671 15.563l.532-3.49h-3.328V9.809c0-.956.465-1.886 1.956-1.886h1.513V4.952s-1.374-.236-2.686-.236c-2.741 0-4.533 1.672-4.533 4.697v2.66H7.078v3.49h3.047V24a12.1 12.1 0 0 0 3.75 0v-8.437h2.796Z" />
        </svg>
      );
    case "twitter":
    case "x":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
        </svg>
      );
    case "linkedin":
    case "linkedin_oidc":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#0A66C2">
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125Zm1.782 13.019H3.555V9h3.564v11.452ZM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003Z" />
        </svg>
      );
    case "slack":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <rect x="9" y="2" width="3" height="8" rx="1.5" fill="#36C5F0" />
          <rect x="14" y="9" width="8" height="3" rx="1.5" fill="#2EB67D" />
          <rect x="12" y="14" width="3" height="8" rx="1.5" fill="#ECB22E" />
          <rect x="2" y="12" width="8" height="3" rx="1.5" fill="#E01E5A" />
        </svg>
      );
    case "twitch":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#9146FF">
          <path d="M4.3 0 1.15 3.8v16.4h5.68V24h3.57l3.32-3.8h4.42L23.6 15V0H4.3Zm16.8 13.8-3.9 4.2h-5.6l-3.4 3.7v-3.7H3.5V2.1h17.6v11.7Z" />
          <path d="M14.9 5.5h2.1v6h-2.1zM9.9 5.5h2.1v6H9.9z" />
        </svg>
      );
    case "spotify":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <circle cx="12" cy="12" r="12" fill="#1DB954" />
          <path
            d="M6.2 9.3c3.6-1.1 7.9-.8 10.9 1"
            fill="none"
            stroke="#fff"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path
            d="M6.9 12.5c3-.9 6.6-.6 9.1.9"
            fill="none"
            stroke="#fff"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path d="M7.6 15.5c2.4-.7 5.2-.4 7.1.7" fill="none" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case "bitbucket":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#0052CC">
          <path d="M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.891L.778 1.213ZM14.52 15.91H9.48l-1.35-7.05h7.74l-1.35 7.05Z" />
        </svg>
      );
    case "dropbox":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#0061FF">
          <path d="M6 1 0 4.9l6 3.9 6-3.9L6 1Zm12 0-6 3.9 6 3.9 6-3.9L18 1ZM0 12.7l6 3.9 6-3.9-6-3.9-6 3.9Zm18-3.9-6 3.9 6 3.9 6-3.9-6-3.9ZM6 17.9l6 3.9 6-3.9-6-3.9-6 3.9Z" />
        </svg>
      );
    case "notion":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <rect x="1" y="1" width="22" height="22" rx="3" fill="currentColor" />
          <path
            d="M7 6.6h2.9l4.9 6.5V6.6H17v10.8h-2.7L9.2 10.5v6.9H7V6.6Z"
            fill="var(--background, #fff)"
          />
        </svg>
      );
    case "hubspot":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#FF7A59">
          <circle cx="17" cy="7" r="3" />
          <circle cx="9" cy="17" r="3.2" />
          <path d="M9 13.8V9.5c0-2 1.6-3.6 3.6-3.6h1.2V4.3h1.9V6h-1.4a2 2 0 0 0-2 2v5.8H9Z" />
          <rect x="8" y="8" width="1.8" height="4" rx="0.9" />
        </svg>
      );
    case "tiktok":
      return (
        // A black mark, like GitHub's and X's: follow the text colour so it does not vanish on a dark button.
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="currentColor">
          <path d="M16.6 5.82A5.9 5.9 0 0 1 15.3 2h-3.2v13.4a2.65 2.65 0 1 1-1.9-2.55V9.6a5.9 5.9 0 1 0 5.1 5.84V8.9a8.4 8.4 0 0 0 4.7 1.44V7.2a5.3 5.3 0 0 1-3.4-1.38Z" />
        </svg>
      );
    case "coinbase":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <circle cx="12" cy="12" r="12" fill="#0052FF" />
          <rect x="7.4" y="7.4" width="9.2" height="9.2" rx="1.4" fill="#fff" />
        </svg>
      );
    case "line":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <rect x="1" y="2" width="22" height="20" rx="5" fill="#06C755" />
          <path
            d="M12 5.5c-4.4 0-8 3-8 6.7 0 3.3 2.9 6 6.6 6.5.3.1.7.2.8.5.1.3.1.7 0 1l-.1.9c0 .3-.2.9.7.5 1-.4 5.1-3 6.9-5.2 1.3-1.4 1.9-2.9 1.9-4.2 0-3.7-3.6-6.7-8.8-6.7Z"
            fill="#fff"
          />
          <path
            d="M7.4 9.3h1.1v4.2h2v1H7.4V9.3Zm4.2 0h1.2v5.2h-1.2V9.3Zm2.4 0h1.1l1.9 2.9V9.3h1.1v5.2h-1l-2-3v3h-1.1V9.3Z"
            fill="#06C755"
          />
        </svg>
      );
    case "linear":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#5E6AD2">
          <circle cx="12" cy="12" r="10" opacity="0.2" />
          <path d="M3.1 14.3 9.7 20.9A9.3 9.3 0 0 1 3.1 14.3Zm-.5-1.8L11.5 21.4a9.6 9.6 0 0 0 2.3-.3L2.9 10.2a9.6 9.6 0 0 0-.3 2.3Zm1.2-4.2L17 20.6a9.4 9.4 0 0 0 1.7-1.1L5 6.6a9.4 9.4 0 0 0-1.2 1.7Zm2.4-2.8L19.1 18.4a9.2 9.2 0 0 0 1.4-1.5L8.3 4.7a9.2 9.2 0 0 0-1.5 1.4Z" />
        </svg>
      );
    case "huggingface":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#FFD21E" />
          <circle cx="12" cy="13" r="6.2" fill="#FFD21E" stroke="#000" strokeWidth="1" />
          <circle cx="9.6" cy="11.6" r="1" fill="#000" />
          <circle cx="14.4" cy="11.6" r="1" fill="#000" />
          <path d="M9.7 14.4c.6.9 1.4 1.3 2.3 1.3s1.7-.4 2.3-1.3" fill="none" stroke="#000" strokeWidth="1" strokeLinecap="round" />
          <path d="M6.3 16.5c-1.3 1-2 2.2-1.5 2.9.6.9 2.4.2 4-.9M17.7 16.5c1.3 1 2 2.2 1.5 2.9-.6.9-2.4.2-4-.9" fill="#FFD21E" stroke="#000" strokeWidth="0.8" />
        </svg>
      );
    case "box":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#0061D5">
          <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.7 8 12 11.7 5.3 8 12 4.3ZM5 9.7l6 3.4v6.6l-6-3.4V9.7Zm8 10V13.1l6-3.4v6.6l-6 3.4Z" />
        </svg>
      );
    case "atlassian":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true" fill="#0052CC">
          <path d="M7.2 11.2c-.3-.5-.8-.5-1.1 0L.4 22.5c-.2.4.1.9.5.9h8c.2 0 .5-.1.6-.4 1.7-3.5.7-8.8-2.3-11.8ZM11.4.6c-2.8 4.4-2.6 9.2-.8 13.3l3.3 7.4c.1.2.3.4.6.4h8c.5 0 .8-.5.6-.9L12.6.6c-.2-.5-.9-.5-1.2 0Z" />
        </svg>
      );
    case "xero":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
          <circle cx="12" cy="12" r="12" fill="#13B5EA" />
          <path
            d="m7.2 7.8 3.5 4.2 3.5-4.2h2.2l-4.6 4.2 4.6 4.2h-2.2L12 12l-2.2 4.2H7.5l4.6-4.2-4.9-4.2Z"
            fill="#fff"
            transform="translate(1.8 0)"
          />
        </svg>
      );
    default:
      return <GlobeIcon className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
  }
}
