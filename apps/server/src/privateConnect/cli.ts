import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthSessionId,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { PrivateConnectError, privateConnectOrigin } from "./PrivateConnect.ts";

const LINK_KEY = "private-connect-link";
const Link = Schema.fromJsonString(
  Schema.Struct({
    server: Schema.String,
    httpBaseUrl: Schema.String,
    environmentId: EnvironmentId,
    hubToken: Schema.String,
    sessionId: AuthSessionId,
  }),
);

const encodeStatus = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      mode: Schema.Literal("private"),
      server: Schema.String,
      address: Schema.String,
    }),
  ),
);
const decodeLink = Schema.decodeUnknownEffect(Link);
const encodeLink = Schema.encodeEffect(Link);

const readLink = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const raw = yield* store.get(LINK_KEY);
  return Option.isNone(raw) ? null : yield* decodeLink(new TextDecoder().decode(raw.value));
});

export const status = Effect.fn("PrivateConnectCli.status")(function* (json: boolean) {
  const linked = yield* readLink;
  if (linked === null) return false;
  if (json) {
    yield* Console.log(
      encodeStatus({ mode: "private", server: linked.server, address: linked.httpBaseUrl }),
    );
    return true;
  }
  yield* Console.log(
    `Private Connect\n  Server: ${linked.server}\n  This machine: ${linked.httpBaseUrl}\n  Access: direct HTTPS; no managed relay`,
  );
  return true;
});

export const link = Effect.fn("PrivateConnectCli.link")(
  function* (server: string, address: string) {
    const origins = yield* Effect.try({
      try: () => ({ server: privateConnectOrigin(server), address: privateConnectOrigin(address) }),
      catch: () => new PrivateConnectError({ reason: "endpoint" }),
    });
    const previous = yield* readLink;
    if (previous !== null && previous.server !== origins.server) {
      return yield* new PrivateConnectError({ reason: "linked" });
    }
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    const hub = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origins.server });
    let hubToken = previous?.hubToken;
    if (hubToken) {
      const session = yield* hub.auth
        .session({ headers: { authorization: `Bearer ${hubToken}` } })
        .pipe(Effect.timeout("10 seconds"));
      if (!session.authenticated) hubToken = undefined;
    }
    if (!hubToken) {
      yield* Console.log(
        `Create a pairing code on ${origins.server} using Settings → Connections → Pair a device, or t3 pair.`,
      );
      const code = yield* Prompt.run(
        Prompt.Password({ message: "Private Connect server pairing code" }),
      );
      const token = yield* hub.auth
        .token({
          headers: {},
          payload: {
            grant_type: AuthTokenExchangeGrantType,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            subject_token: Redacted.value(code),
            client_label: "Private Connect registration",
          },
        })
        .pipe(Effect.timeout("10 seconds"));
      hubToken = token.access_token;
    }
    const delegated = yield* auth.issueSession({
      ttl: Duration.days(365),
      scopes: AuthStandardClientScopes,
      subject: "private-connect",
      label: `Private Connect: ${origins.server}`,
    });
    let committed = false;
    yield* Effect.gen(function* () {
      const registration = yield* hub.privateConnect
        .register({
          headers: { authorization: `Bearer ${hubToken}` },
          payload: { environmentId, httpBaseUrl: origins.address, token: delegated.token },
        })
        .pipe(Effect.timeout("15 seconds"));
      yield* secrets.set(
        LINK_KEY,
        new TextEncoder().encode(
          yield* encodeLink({
            server: origins.server,
            httpBaseUrl: origins.address,
            environmentId,
            hubToken,
            sessionId: delegated.sessionId,
          }),
        ),
      );
      committed = true;
      if (previous !== null) yield* auth.revokeSession(previous.sessionId);
      yield* Console.log(
        `Registered ${registration.label} with ${origins.server}.\nOpen that server in each browser to share its connections.\nGrant expires ${DateTime.formatIso(delegated.expiresAt)}. Run this command again to renew it.`,
      );
    }).pipe(
      Effect.onError(() =>
        committed ? Effect.void : auth.revokeSession(delegated.sessionId).pipe(Effect.ignore),
      ),
    );
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
);

export const unlink = Effect.gen(function* () {
  const linked = yield* readLink;
  if (linked === null) return false;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // Revoke locally even when the directory is offline.
  yield* auth.revokeSession(linked.sessionId);
  const hub = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: linked.server });
  yield* hub.privateConnect
    .remove({
      headers: { authorization: `Bearer ${linked.hubToken}` },
      payload: { environmentId: linked.environmentId },
    })
    .pipe(
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        Console.log(
          "Local access revoked. Remove the machine from the Private Connect server when it is reachable.",
        ),
      ),
    );
  yield* secrets.remove(LINK_KEY);
  yield* Console.log(
    "Private Connect unlinked. Existing device sessions can be revoked in Connections → Client sessions.",
  );
  return true;
}).pipe(
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
);
