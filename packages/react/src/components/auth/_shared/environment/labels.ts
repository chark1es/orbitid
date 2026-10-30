const SOCIAL_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  discord: "Discord",
  microsoft: "Microsoft",
  apple: "Apple",
  facebook: "Facebook",
  twitter: "X",
  x: "X",
  linkedin_oidc: "LinkedIn",
  linkedin: "LinkedIn",
  slack: "Slack",
  twitch: "Twitch",
  spotify: "Spotify",
  bitbucket: "Bitbucket",
  dropbox: "Dropbox",
  notion: "Notion",
  hubspot: "HubSpot",
  tiktok: "TikTok",
  coinbase: "Coinbase",
  line: "LINE",
  linear: "Linear",
  huggingface: "Hugging Face",
  box: "Box",
  atlassian: "Atlassian",
  xero: "Xero",
};

export function socialProviderLabel(id: string): string {
  const clean = id.replace(/^oauth_/, "").replace(/^custom_/, "");
  return SOCIAL_LABELS[clean] ?? clean.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
