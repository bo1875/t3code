import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { type AuthClientPresentationMetadata, type EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import { bootstrapPrivateConnection, listPrivateConnections } from "../rpc/privateConnect";

interface CachedRegistration {
  readonly revision: string;
  readonly expiresAt: number;
  readonly registration: BearerConnectionRegistration;
}

export const makePrivateConnectDiscovery = Effect.sync(() => {
  let cached = new Map<EnvironmentId, CachedRegistration>();
  let refreshAt = 0;
  return Effect.fn("privateConnect.discover")(function* (
    primaryEnvironmentId: EnvironmentId | undefined,
    metadata: AuthClientPresentationMetadata,
  ) {
    const now = yield* Clock.currentTimeMillis;
    cached = new Map([...cached].filter(([, entry]) => entry.expiresAt > now));
    if (now < refreshAt) return [...cached.values()].map((entry) => entry.registration);
    refreshAt = now + 30_000;
    const listed = yield* listPrivateConnections.pipe(
      Effect.map(Option.some),
      Effect.catch((error) => {
        if (
          error._tag === "EnvironmentAuthInvalidError" ||
          error._tag === "EnvironmentScopeRequiredError"
        )
          cached.clear();
        return Effect.succeedNone;
      }),
    );
    if (Option.isNone(listed)) return [...cached.values()].map((entry) => entry.registration);
    const next = new Map<EnvironmentId, CachedRegistration>();
    yield* Effect.forEach(
      listed.value,
      (environment) =>
        Effect.gen(function* () {
          if (
            environment.environmentId === primaryEnvironmentId ||
            DateTime.toEpochMillis(environment.expiresAt) <= now
          )
            return;
          const existing = cached.get(environment.environmentId);
          if (existing?.revision === environment.revision && existing.expiresAt > now + 60_000) {
            next.set(environment.environmentId, existing);
            return;
          }
          const registration = yield* Effect.gen(function* () {
            const bootstrap = yield* bootstrapPrivateConnection(environment.environmentId);
            const descriptor = yield* fetchRemoteEnvironmentDescriptor({
              httpBaseUrl: environment.httpBaseUrl,
            });
            if (descriptor.environmentId !== environment.environmentId) return null;
            const access = yield* bootstrapRemoteBearerSession({
              httpBaseUrl: environment.httpBaseUrl,
              credential: bootstrap.pairing.credential,
              scopes: bootstrap.scopes,
              clientMetadata: metadata,
            });
            const connectionId = `private-connect:${environment.environmentId}:${environment.revision}`;
            const ws = new URL(environment.httpBaseUrl);
            ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
            return {
              revision: environment.revision,
              expiresAt: now + access.expires_in * 1_000,
              registration: new BearerConnectionRegistration({
                target: new BearerConnectionTarget({
                  environmentId: environment.environmentId,
                  label: environment.label,
                  connectionId,
                }),
                profile: new BearerConnectionProfile({
                  environmentId: environment.environmentId,
                  label: environment.label,
                  connectionId,
                  httpBaseUrl: environment.httpBaseUrl,
                  wsBaseUrl: ws.toString(),
                }),
                credential: new BearerConnectionCredential({ token: access.access_token }),
              }),
            } satisfies CachedRegistration;
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (registration !== null) next.set(environment.environmentId, registration);
          else if (existing?.revision === environment.revision)
            next.set(environment.environmentId, existing);
        }),
      { concurrency: 4, discard: true },
    );
    cached = next;
    return [...cached.values()].map((entry) => entry.registration);
  }, Effect.provide(FetchHttpClient.layer));
});
