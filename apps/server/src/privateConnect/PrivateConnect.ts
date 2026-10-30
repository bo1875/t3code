import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  PrivateConnectEnvironment,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type PrivateConnectBootstrap,
  type PrivateConnectRegister,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class PrivateConnectError extends Schema.TaggedError<PrivateConnectError>()(
  "PrivateConnectError",
  {
    reason: Schema.Literals([
      "endpoint",
      "address-required",
      "server-required",
      "linked",
      "identity",
      "permissions",
      "unavailable",
      "missing",
      "expired",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "address-required":
        return "Private Connect requires --address with this machine's reachable HTTPS origin.";
      case "server-required":
        return "Use t3 connect --server https://your-directory --address https://this-machine for Private Connect.";
      case "linked":
        return "Run t3 connect unlink before changing Private Connect servers.";
      case "endpoint":
        return "Use an HTTPS origin, or a loopback HTTP origin for local testing.";
      case "identity":
        return "The address belongs to a different T3 environment.";
      case "permissions":
        return "This connection does not grant permission to pair devices.";
      case "unavailable":
        return "The registered machine could not be reached. Check its address and access grant.";
      case "missing":
        return "This machine is no longer registered with Private Connect.";
      case "expired":
        return "The machine's access grant expired. Run t3 connect --server again on that machine.";
      case "storage":
        return "The private connection directory could not be saved or loaded.";
    }
  }
}

export const privateConnectOrigin = (value: string): string => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new PrivateConnectError({ reason: "endpoint" });
  return url.origin;
};

const SavedEnvironment = Schema.Struct({
  ...PrivateConnectEnvironment.fields,
  expiresAt: Schema.DateTimeUtcFromString,
  token: Schema.String,
  scopes: Schema.Array(Schema.String),
});
const Directory = Schema.fromJsonString(Schema.Array(SavedEnvironment));
const decodeDirectory = Schema.decodeUnknownEffect(Directory);
const encodeDirectory = Schema.encodeEffect(Directory);
const DIRECTORY_KEY = "private-connect-directory";

function publicEnvironment(saved: typeof SavedEnvironment.Type): PrivateConnectEnvironment {
  return {
    environmentId: saved.environmentId,
    label: saved.label,
    httpBaseUrl: saved.httpBaseUrl,
    revision: saved.revision,
    expiresAt: saved.expiresAt,
  };
}

export class PrivateConnect extends Context.Service<
  PrivateConnect,
  {
    readonly list: Effect.Effect<ReadonlyArray<PrivateConnectEnvironment>, PrivateConnectError>;
    readonly register: (
      input: PrivateConnectRegister,
    ) => Effect.Effect<PrivateConnectEnvironment, PrivateConnectError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<boolean, PrivateConnectError>;
    readonly bootstrap: (
      environmentId: EnvironmentId,
      scopes: ReadonlySet<AuthEnvironmentScope>,
    ) => Effect.Effect<PrivateConnectBootstrap, PrivateConnectError>;
  }
>()("t3/privateConnect/PrivateConnect") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);

  const read = Effect.gen(function* () {
    const raw = yield* secrets.get(DIRECTORY_KEY);
    return Option.isNone(raw) ? [] : yield* decodeDirectory(new TextDecoder().decode(raw.value));
  }).pipe(Effect.mapError((cause) => new PrivateConnectError({ reason: "storage", cause })));
  const write = Effect.fn("PrivateConnect.persist")(
    function* (rows: ReadonlyArray<typeof SavedEnvironment.Type>) {
      yield* secrets.set(DIRECTORY_KEY, new TextEncoder().encode(yield* encodeDirectory(rows)));
    },
    Effect.mapError((cause) => new PrivateConnectError({ reason: "storage", cause })),
  );

  const remote = <A, E, R>(request: Effect.Effect<A, E, R>) =>
    request.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "error",
        credentials: "omit",
      }),
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new PrivateConnectError({ reason: "unavailable", cause })),
    );

  const register = Effect.fn("PrivateConnect.register")(function* (input: PrivateConnectRegister) {
    const httpBaseUrl = yield* Effect.try({
      try: () => privateConnectOrigin(input.httpBaseUrl),
      catch: () => new PrivateConnectError({ reason: "endpoint" }),
    });
    const inspected = yield* remote(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
        const descriptor = yield* client.metadata.descriptor();
        if (descriptor.environmentId !== input.environmentId) {
          return { descriptor, session: null };
        }
        const session = yield* client.auth.session({
          headers: { authorization: `Bearer ${input.token}` },
        });
        return { descriptor, session };
      }),
    );
    if (inspected.session === null) return yield* new PrivateConnectError({ reason: "identity" });
    const { session, descriptor } = inspected;
    const scopes = session.permissions ?? session.scopes ?? [];
    if (
      !session.authenticated ||
      !scopes.includes(AuthAccessWriteScope) ||
      session.expiresAt === undefined
    ) {
      return yield* new PrivateConnectError({ reason: "permissions" });
    }
    if (DateTime.toEpochMillis(session.expiresAt) <= (yield* Clock.currentTimeMillis)) {
      return yield* new PrivateConnectError({ reason: "expired" });
    }
    const revision = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => new PrivateConnectError({ reason: "storage", cause })));
    const row = {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl,
      revision,
      expiresAt: session.expiresAt,
      token: input.token,
      scopes,
    };
    yield* lock.withPermit(
      Effect.gen(function* () {
        const rows = yield* read;
        yield* write([...rows.filter((entry) => entry.environmentId !== row.environmentId), row]);
      }),
    );
    return publicEnvironment(row);
  });

  const remove = Effect.fn("PrivateConnect.remove")(function* (environmentId: EnvironmentId) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const rows = yield* read;
        const next = rows.filter((row) => row.environmentId !== environmentId);
        if (next.length === rows.length) return false;
        yield* write(next);
        return true;
      }),
    );
  });

  const bootstrap = Effect.fn("PrivateConnect.bootstrap")(function* (
    environmentId: EnvironmentId,
    callerScopes: ReadonlySet<AuthEnvironmentScope>,
  ) {
    if (!callerScopes.has(AuthAccessWriteScope))
      return yield* new PrivateConnectError({ reason: "permissions" });
    const row = (yield* read).find((entry) => entry.environmentId === environmentId);
    if (!row) return yield* new PrivateConnectError({ reason: "missing" });
    if (DateTime.toEpochMillis(row.expiresAt) <= (yield* Clock.currentTimeMillis)) {
      return yield* new PrivateConnectError({ reason: "expired" });
    }
    const scopes = AuthStandardClientScopes.filter(
      (scope) => callerScopes.has(scope) && row.scopes.includes(scope),
    );
    const pairing = yield* remote(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: row.httpBaseUrl });
        // Recheck identity before sending a credential to an address that may have changed hands.
        const descriptor = yield* client.metadata.descriptor();
        if (descriptor.environmentId !== row.environmentId)
          return yield* new PrivateConnectError({ reason: "identity" });
        return yield* client.auth.pairingCredential({
          headers: { authorization: `Bearer ${row.token}` },
          payload: { label: "Private Connect browser", scopes },
        });
      }),
    );
    return { environment: publicEnvironment(row), pairing, scopes };
  });

  return PrivateConnect.of({
    list: read.pipe(Effect.map((rows) => rows.map(publicEnvironment))),
    register,
    remove,
    bootstrap,
  });
});

export const layer = Layer.effect(PrivateConnect, make);
