"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  clearCredentials,
  getIntegrations,
  installIntegration,
  setCredentials,
  setIntegrationEnabled,
  uninstallIntegration,
  type ActionOutcome,
} from "@/lib/client/integrations-client";
import {
  credentialValues,
  hasCredentialInput,
} from "@/lib/client/integrations-form";
import type {
  IntegrationView,
  IntegrationsView,
} from "@/lib/integrations/types";
import { cn } from "@/lib/utils";

/**
 * IntegrationsPanel: the admin settings page for the coding-agent CLIs.
 *
 * The panel renders what the server sent and posts explicit actions; it
 * decides NOTHING about whether an action may run. Every gate — allowlisted
 * spec, npm present, free disk, detected binary, stored credentials — is
 * enforced in the route, because a client check is a hint and the server's is
 * the rule. When one refuses, the server's message is what the card shows:
 * it names the missing step, which is the only useful thing to say.
 *
 * After a mutation the panel refetches the whole view. That is deliberate: a
 * toggle changes detection-derived state too (an install flips `version`,
 * `drift`, `statusReason` and the credential status of every later attempt),
 * and re-deriving that locally would be a second implementation that drifts.
 *
 * Credential inputs are uncontrolled by value on purpose: after submit the
 * field is cleared, so a secret never sits in React state longer than the
 * request that consumes it. Nothing in the returned view can echo it back.
 */

export interface IntegrationsPanelProps {
  initialView: IntegrationsView;
}

/** Which action is in flight, per provider — so one card's spinner is its own. */
type Pending = { id: string; action: "toggle" | "install" | "auth" | "clear" } | null;

export function IntegrationsPanel({ initialView }: IntegrationsPanelProps) {
  const [view, setView] = useState(initialView);
  const [pending, setPending] = useState<Pending>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Guards against a stale in-flight refetch replacing a newer one.
  const refreshSeq = useRef(0);

  const reload = useCallback(async (refresh = false) => {
    const seq = ++refreshSeq.current;
    const result = await getIntegrations({ refresh });
    if (seq !== refreshSeq.current) return;
    if (result.ok) setView(result.view);
    else {
      toast.error(
        result.code === "forbidden"
          ? "You need admin access to change integrations."
          : "Could not reload integrations.",
      );
    }
  }, []);

  const checkAgain = useCallback(async () => {
    setRefreshing(true);
    await reload(true);
    setRefreshing(false);
  }, [reload]);

  const run = useCallback(
    async (
      id: string,
      action: NonNullable<Pending>["action"],
      work: () => Promise<ActionOutcome>,
      success: string,
    ) => {
      setPending({ id, action });
      const outcome = await work();
      setPending(null);
      if (outcome.ok) {
        toast.success(success);
        await reload();
        return;
      }
      toast.error(outcome.message ?? describeFailure(outcome.code));
    },
    [reload],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6 flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="font-heading text-xl leading-tight">Integrations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scoring CLIs this app can drive. Detection, installs and
            credentials are all server-side actions, recorded in the audit log.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          onClick={checkAgain}
          disabled={refreshing}
        >
          {refreshing ? "Checking…" : "Check again"}
        </Button>
      </header>

      {view.allowlistWarning && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {view.allowlistWarning}
        </p>
      )}

      {!view.installsEnabled && (
        <p className="mb-4 text-sm text-muted-foreground">
          Install and uninstall are off. Add the exact package spec to{" "}
          <code className="font-mono text-xs">INSTALL_ALLOWLIST</code> to
          enable them.
        </p>
      )}

      <ul className="flex flex-col gap-4">
        {view.integrations.map((integration) => (
          <li key={integration.id}>
            <IntegrationCard
              integration={integration}
              pending={pending}
              installsEnabled={view.installsEnabled}
              onToggle={(enabled) => {
                void run(
                  integration.id,
                  "toggle",
                  () => setIntegrationEnabled(integration.id, enabled),
                  enabled
                    ? `${integration.label} enabled`
                    : `${integration.label} disabled`,
                );
              }}
              onInstall={() => {
                void run(
                  integration.id,
                  "install",
                  () => installIntegration(integration.id),
                  `${integration.label} installed`,
                );
              }}
              onUninstall={() => {
                void run(
                  integration.id,
                  "install",
                  () => uninstallIntegration(integration.id),
                  `${integration.label} uninstalled`,
                );
              }}
              onSaveCredentials={(values) => {
                void run(
                  integration.id,
                  "auth",
                  () => setCredentials(integration.id, values),
                  "Credentials saved",
                );
              }}
              onClearCredentials={() => {
                void run(
                  integration.id,
                  "clear",
                  () => clearCredentials(integration.id),
                  "Credentials removed",
                );
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeFailure(code: string | undefined): string {
  switch (code) {
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    case "rate_limited":
      return "Too many attempts. Wait a moment before trying again.";
    case "not_installed":
      return "The CLI is not installed on this server yet.";
    case "not_authenticated":
      return "Add credentials before enabling this provider.";
    case "not_in_enabled_providers":
      return "This provider is not listed in ENABLED_PROVIDERS.";
    case "install_refused":
      return "The server refused the install — see the card for the reason.";
    default:
      return "That did not work. Try again.";
  }
}

// -- card ---------------------------------------------------------------------

interface CardProps {
  integration: IntegrationView;
  pending: Pending;
  installsEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  onInstall: () => void;
  onUninstall: () => void;
  onSaveCredentials: (values: Record<string, string>) => void;
  onClearCredentials: () => void;
}

function IntegrationCard({
  integration,
  pending,
  installsEnabled,
  onToggle,
  onInstall,
  onUninstall,
  onSaveCredentials,
  onClearCredentials,
}: CardProps) {
  const busy = pending?.id === integration.id ? pending.action : null;
  const anyPending = busy !== null;
  const isHostLogin = integration.authMethod === "host-login";
  const installed = integration.status !== "missing";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {integration.label}
          <StatusBadge integration={integration} />
          {integration.drift && (
            <Badge variant="outline" className="text-warning">
              version drift
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{integration.description}</CardDescription>

        {!isHostLogin && (
          <CardAction className="flex items-center gap-2">
            <Label
              htmlFor={`enable-${integration.id}`}
              className="text-xs text-muted-foreground"
            >
              Enabled
            </Label>
            <Switch
              id={`enable-${integration.id}`}
              checked={integration.enabled}
              disabled={anyPending}
              onCheckedChange={onToggle}
              aria-label={`Enable ${integration.label}`}
            />
          </CardAction>
        )}
      </CardHeader>

      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
          <Fact label="Version" value={integration.version ?? "—"} mono />
          <Fact label="Size" value={integration.sizeLabel} />
          <Fact label="Auth" value={AUTH_LABELS[integration.authMethod]} />
          <Fact
            label="Status"
            value={
              integration.active
                ? "In use"
                : integration.enabled
                  ? "Enabled"
                  : "Available"
            }
          />
        </dl>

        {integration.statusReason && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {integration.statusReason}
          </p>
        )}

        {integration.enabled && !integration.adapterAvailable && (
          <p className="rounded-md bg-clay-tint px-2.5 py-2 text-xs leading-relaxed text-foreground dark:bg-clay-tint/40">
            Enabled for this install, but its adapter has not landed in this
            build yet — chat will not offer it until it does.
          </p>
        )}

        <Separator />

        {isHostLogin ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Uses this host’s own Claude login. The app never stores or forwards
            an API key, so the subscription’s credential precedence is
            untouched.
          </p>
        ) : (
          <CredentialForm
            integration={integration}
            busy={busy}
            onSave={onSaveCredentials}
            onClear={onClearCredentials}
          />
        )}

        {integration.install.spec && (
          <InstallRow
            integration={integration}
            installsEnabled={installsEnabled}
            installed={installed}
            busy={busy}
            onInstall={onInstall}
            onUninstall={onUninstall}
          />
        )}

        <a
          href={integration.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {integration.label} documentation
        </a>
      </CardContent>
    </Card>
  );
}

const AUTH_LABELS: Record<IntegrationView["authMethod"], string> = {
  "host-login": "Host login",
  "device-code": "Device code or key",
  "api-key": "API key",
  "env-import": "Environment key",
  token: "Access token",
};

function StatusBadge({ integration }: { integration: IntegrationView }) {
  if (integration.status === "bundled") {
    return <Badge variant="secondary">Bundled</Badge>;
  }
  if (integration.status === "installed") {
    return (
      <Badge variant="outline" className="text-success">
        Installed
      </Badge>
    );
  }
  if (integration.status === "broken") {
    // On PATH but un-runnable — a stale shim, a bad shebang, a wrong-arch
    // binary. Distinct from "not installed" because the fix is different:
    // reinstall, not install.
    return (
      <Badge variant="outline" className="text-destructive">
        Found but broken
      </Badge>
    );
  }
  return <Badge variant="outline">Not installed</Badge>;
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-[13px]")} title={value}>
        {value}
      </dd>
    </div>
  );
}

// -- credentials --------------------------------------------------------------

function CredentialForm({
  integration,
  busy,
  onSave,
  onClear,
}: {
  integration: IntegrationView;
  busy: string | null;
  onSave: (values: Record<string, string>) => void;
  onClear: () => void;
}) {
  const [filled, setFilled] = useState(false);
  const configured = integration.credentials.configured;

  const readField = (form: HTMLFormElement | null, key: string): unknown => {
    const el = form?.elements.namedItem(key);
    return el instanceof HTMLInputElement ? el.value : undefined;
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = credentialValues(integration.credentialKeys, (key) =>
          readField(form, key),
        );
        if (Object.keys(values).length === 0) return;
        onSave(values);
        // Clear immediately: the value has been handed to the request and
        // must not linger in the DOM.
        form.reset();
        setFilled(false);
      }}
    >
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium">Authentication</p>
        <Badge variant={configured ? "secondary" : "outline"} className="text-[11px]">
          {configured ? "Configured" : "Not configured"}
        </Badge>
        {configured && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            disabled={busy !== null}
            onClick={onClear}
          >
            Remove
          </Button>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {integration.credentialKeys.map((key) => {
          const present = integration.credentials.presentKeys.includes(key);
          return (
            <div key={key} className="flex flex-col gap-1">
              <Label htmlFor={`cred-${integration.id}-${key}`} className="font-mono text-[11px]">
                {key}
                {present && (
                  <span className="font-sans text-[10px] text-muted-foreground">
                    set
                  </span>
                )}
              </Label>
              <Input
                id={`cred-${integration.id}-${key}`}
                name={key}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={present ? "•••••••• (unchanged)" : "Paste a value"}
                disabled={busy !== null}
                onChange={(event) => {
                  const form = event.currentTarget.form;
                  setFilled(
                    hasCredentialInput(integration.credentialKeys, (k) =>
                      readField(form, k),
                    ),
                  );
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="secondary" disabled={busy !== null || !filled}>
          {busy === "auth" ? "Saving…" : "Save credentials"}
        </Button>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Stored on this server in a 0600 file, never in the database and never
          sent back to the browser.
        </p>
      </div>
    </form>
  );
}

// -- install ------------------------------------------------------------------

function InstallRow({
  integration,
  installsEnabled,
  installed,
  busy,
  onInstall,
  onUninstall,
}: {
  integration: IntegrationView;
  installsEnabled: boolean;
  installed: boolean;
  busy: string | null;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { install } = integration;
  const blocked = !install.allowed;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="font-mono text-[11px] text-muted-foreground">{install.spec}</p>

      <div className="ml-auto flex items-center gap-2">
        {install.freeLabel && (
          <span className="text-[11px] text-muted-foreground">
            {install.freeLabel} free
          </span>
        )}
        {installed ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={onUninstall}
          >
            {busy === "install" ? "Removing…" : "Uninstall"}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy !== null || blocked || !installsEnabled}
            onClick={onInstall}
          >
            {busy === "install" ? "Installing…" : "Install"}
          </Button>
        )}
      </div>

      {!installed && blocked && install.reason && (
        <p className="basis-full text-[11px] leading-relaxed text-muted-foreground">
          {install.reason}
        </p>
      )}
    </div>
  );
}
