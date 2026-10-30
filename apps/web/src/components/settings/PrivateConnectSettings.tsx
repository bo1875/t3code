import { useEffect, useState } from "react";
import type { PrivateConnectEnvironment } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { runtime } from "../../lib/runtime";
import { listPrivateConnections, removePrivateConnection } from "../../rpc/privateConnect";
import { isHostedStaticApp } from "../../hostedPairing";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export function PrivateConnectSettings() {
  const [environments, setEnvironments] = useState<ReadonlyArray<PrivateConnectEnvironment>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hosted = isHostedStaticApp();

  const refresh = async () => {
    setBusy(true);
    try {
      setEnvironments(await runtime.runPromise(listPrivateConnections));
      setError(null);
    } catch {
      setError(
        "Private Connect is unavailable. Open your fork's server directly and sign in with a session that can read connections.",
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (hosted) return;
    let active = true;
    void runtime.runPromise(listPrivateConnections).then(
      (rows) => {
        if (active) setEnvironments(rows);
      },
      () => {
        if (active)
          setError(
            "Private Connect is unavailable on this server or your session cannot read connections.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [hosted]);

  if (hosted) return null;

  return (
    <SettingsSection
      title="Private Connect"
      headerAction={
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Machines registered here appear in every browser that opens this server. On each machine,
        run:
      </p>
      <pre className="overflow-x-auto rounded-md border p-3 text-xs">
        t3 connect --server {window.location.origin} --address https://machine.example
      </pre>
      <p className="text-sm text-muted-foreground">
        Use addresses reachable from this server and your devices. Private Connect uses your own
        server and T3 pairing, without a cloud account or tunnel.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {environments.map((environment) => (
        <div
          key={environment.environmentId}
          className="flex items-center justify-between gap-4 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">{environment.label}</p>
            <p className="break-all text-xs text-muted-foreground">{environment.httpBaseUrl}</p>
            <p className="text-xs text-muted-foreground">
              Access expires {DateTime.toDate(environment.expiresAt).toLocaleDateString()}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void runtime
                .runPromise(removePrivateConnection(environment.environmentId))
                .then(refresh, () => {
                  setError(
                    "Could not remove the connection. Your session needs permission to manage access and connections.",
                  );
                  setBusy(false);
                });
            }}
          >
            Remove from directory
          </Button>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Removing a machine stops discovery for everyone. Revoke existing device sessions on that
        machine to end their access.
      </p>
    </SettingsSection>
  );
}
