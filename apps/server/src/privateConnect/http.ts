import {
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import * as PrivateConnect from "./PrivateConnect.ts";

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);

const respond = <A, R>(operation: Effect.Effect<A, PrivateConnect.PrivateConnectError, R>) =>
  operation.pipe(
    Effect.mapError((error) => {
      if (error.reason === "permissions")
        return new EnvironmentHttpForbiddenError({ message: error.message });
      if (error.reason === "storage" || error.reason === "unavailable")
        return new EnvironmentHttpInternalServerError({ message: error.message });
      return new EnvironmentHttpBadRequestError({ message: error.message });
    }),
  );

export const layer = HttpApiBuilder.group(EnvironmentHttpApi, "privateConnect", (handlers) =>
  Effect.gen(function* () {
    const directory = yield* PrivateConnect.PrivateConnect;
    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayReadScope);
          yield* noStore;
          return yield* respond(directory.list);
        }),
      )
      .handle("register", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* noStore;
          return yield* respond(directory.register(payload));
        }),
      )
      .handle("remove", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* noStore;
          return { removed: yield* respond(directory.remove(payload.environmentId)) };
        }),
      )
      .handle("bootstrap", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayReadScope);
          const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* noStore;
          return yield* respond(directory.bootstrap(payload.environmentId, session.scopes));
        }),
      );
  }),
);
