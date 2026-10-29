import {
  AppWindow,
  Building2,
  Clock,
  Cpu,
  FileJson,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Mail,
  MailPlus,
  MonitorSmartphone,
  Palette,
  Plug,
  ScrollText,
  Share2,
  ShieldBan,
  ShieldCheck,
  UserCog,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  { items: [{ title: "Overview", href: "/", icon: LayoutDashboard }] },
  {
    label: "Manage",
    items: [
      { title: "Users", href: "/users", icon: Users },
      { title: "Organizations", href: "/organizations", icon: Building2 },
      { title: "Sessions", href: "/sessions", icon: MonitorSmartphone },
    ],
  },
  {
    label: "Access",
    items: [
      { title: "Invitations", href: "/invitations", icon: MailPlus },
      { title: "Waitlist", href: "/waitlist", icon: Clock },
      { title: "Restrictions", href: "/restrictions", icon: ShieldBan },
      { title: "Roles & permissions", href: "/roles", icon: UserCog },
    ],
  },
  {
    label: "Configure",
    items: [
      { title: "Authentication", href: "/settings/authentication", icon: LockKeyhole },
      { title: "Social connections", href: "/settings/social", icon: Share2 },
      { title: "Sessions", href: "/settings/sessions", icon: MonitorSmartphone },
      { title: "Organizations", href: "/settings/organizations", icon: Building2 },
      { title: "Email & SMS", href: "/settings/email-sms", icon: Mail },
      { title: "Appearance", href: "/settings/appearance", icon: Palette },
      { title: "JWT templates", href: "/jwt-templates", icon: FileJson },
    ],
  },
  {
    label: "Developers",
    items: [
      { title: "Connect your app", href: "/connect", icon: Plug },
      { title: "API keys", href: "/api-keys", icon: KeyRound },
      { title: "M2M", href: "/m2m", icon: Cpu },
      { title: "OAuth apps", href: "/oauth-apps", icon: AppWindow },
      { title: "Enterprise SSO", href: "/enterprise-sso", icon: ShieldCheck },
      { title: "Webhooks", href: "/webhooks", icon: Webhook },
      { title: "Audit logs", href: "/audit-logs", icon: ScrollText },
    ],
  },
];

export const ROUTE_LABELS: Record<string, string> = {
  "": "Overview",
  users: "Users",
  organizations: "Organizations",
  sessions: "Sessions",
  invitations: "Invitations",
  waitlist: "Waitlist",
  restrictions: "Restrictions",
  roles: "Roles & permissions",
  settings: "Configure",
  authentication: "Authentication",
  social: "Social connections",
  "email-sms": "Email & SMS",
  appearance: "Appearance",
  "jwt-templates": "JWT templates",
  connect: "Connect your app",
  "api-keys": "API keys",
  m2m: "M2M",
  "oauth-apps": "OAuth apps",
  "enterprise-sso": "Enterprise SSO",
  webhooks: "Webhooks",
  "audit-logs": "Audit logs",
};

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
