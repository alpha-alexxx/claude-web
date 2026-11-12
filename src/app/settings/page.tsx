import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/current-actor";
import { SIGN_IN_URL } from "@/lib/auth/routes";

/**
 * /settings — the hub for operator configuration.
 *
 * It exists so the shell has ONE stable settings destination: the sidebar's
 * account area can point here without knowing which sections this build
 * ships, and adding a section later is a row in `SECTIONS`, not a new entry
 * point in the navigation.
 *
 * Signed-in users always reach this page; it lists only the sections their
 * role can use, so the link never bounces. The sections themselves are
 * admin-gated and redirect — they hold operator data, and a navigation that
 * quietly returns you to chat is a better answer than rendering a 403 page.
 *
 * Client-side theme choice deliberately is NOT a row here: it lives in the
 * account strip, where it belongs to the person rather than the server.
 */

interface Section {
  href: string;
  title: string;
  description: string;
  adminOnly: boolean;
}

const SECTIONS: Section[] = [
  {
    href: "/settings/integrations",
    title: "Integrations",
    description:
      "Detect, install and authenticate the coding-agent CLIs this app can drive.",
    adminOnly: true,
  },
  {
    href: "/settings/mcp",
    title: "MCP servers",
    description:
      "One server list, generated into each tool's own config file.",
    adminOnly: true,
  },
  {
    href: "/settings/claude",
    title: "Claude Code settings",
    description: "~/.claude/settings.json, with secrets redacted.",
    adminOnly: true,
  },
  {
    href: "/settings/codex",
    title: "Codex settings",
    description: "~/.codex/config.toml, with secrets redacted.",
    adminOnly: true,
  },
  {
    href: "/settings/opencode",
    title: "OpenCode settings",
    description: "~/.config/opencode/opencode.json, with secrets redacted.",
    adminOnly: true,
  },
  {
    href: "/settings/qoder",
    title: "Qoder settings",
    description: "~/.qoder/settings.json, with secrets redacted.",
    adminOnly: true,
  },
];

export default function SettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<SettingsSkeleton />}>
        <SettingsSurface />
      </Suspense>
    </div>
  );
}

async function SettingsSurface() {
  const actor = await currentActor();
  if (!actor) redirect(SIGN_IN_URL);

  const sections = SECTIONS.filter((s) => !s.adminOnly || actor.role === "admin");

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-heading text-xl leading-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configuration for this server. Changes apply to everyone who uses it.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {sections.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className="flex flex-col gap-1 rounded-xl bg-card px-4 py-3 text-sm ring-1 ring-foreground/10 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="font-medium">{section.title}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {section.description}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {sections.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing here is available to your account. Ask an administrator.
        </p>
      )}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 h-6 w-32 animate-pulse rounded-md bg-muted" />
      <div className="h-16 animate-pulse rounded-xl bg-muted/60" />
    </div>
  );
}
