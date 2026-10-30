import { EnvironmentHttpApi, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";

const client = Effect.gen(function* () {
  return yield* HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: resolvePrimaryEnvironmentHttpUrl("/"),
  });
});

export const listPrivateConnections = Effect.gen(function* () {
  return yield* (yield* client).privateConnect.list({ headers: {} });
}).pipe(
  Effect.timeout("10 seconds"),
  Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()),
);

export const bootstrapPrivateConnection = Effect.fn("PrivateConnect.bootstrap")(
  function* (environmentId: EnvironmentId) {
    return yield* (yield* client).privateConnect.bootstrap({
      headers: {},
      payload: { environmentId },
    });
  },
  Effect.timeout("15 seconds"),
  Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()),
);

export const removePrivateConnection = Effect.fn("PrivateConnect.remove")(
  function* (environmentId: EnvironmentId) {
    return yield* (yield* client).privateConnect.remove({
      headers: {},
      payload: { environmentId },
    });
  },
  Effect.timeout("10 seconds"),
  Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()),
);
