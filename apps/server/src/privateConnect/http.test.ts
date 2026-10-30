import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthHttp from "../auth/http.ts";
import * as PrivateConnect from "./PrivateConnect.ts";
import * as PrivateHttp from "./http.ts";

const DEV_TOKEN = "private-connect-test-bootstrap-not-a-real-secret";
class TestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.privateConnect) {}

function environment(name: string, fetcher: typeof fetch) {
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const value = yield* ServerConfig.ServerConfig;
      return {
        ...value,
        mode: "web" as const,
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
      };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "private-connect-test-" })));
  const metadata = HttpApiBuilder.group(EnvironmentHttpApi, "metadata", (handlers) =>
    handlers.handle("descriptor", () =>
      Effect.succeed({
        environmentId: EnvironmentId.make(name),
        label: name,
        serverVersion: "0.1.2",
        platform: { os: "linux" as const, arch: "x64" as const },
        capabilities: { repositoryIdentity: false },
      }),
    ),
  );
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide([AuthHttp.layer, metadata, PrivateHttp.layer]),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(PrivateConnect.layer),
    Layer.provide(EnvironmentAuth.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetcher))),
    ),
    Layer.provide(config),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provideMerge(NodeServices.layer),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true });
}

const request = (path: string, token?: string, payload?: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });

async function tokenFor(
  handler: (request: Request) => Promise<Response>,
  credential = DEV_TOKEN,
  scope?: string,
) {
  const response = await handler(
    new Request("http://127.0.0.1/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        ...(scope ? { scope } : {}),
      }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

it("shares the directory across device sessions, enforces grants, and issues distinct one-time pairings", async () => {
  const peer = environment("peer", async () => {
    throw new Error("Unexpected outbound request");
  });
  const forwarded: Request[] = [];
  const hub = environment("hub", async (input, init) => {
    const outgoing = new Request(input, init);
    expect(new URL(outgoing.url).origin).toBe("http://127.0.0.1:4777");
    expect(outgoing.redirect).toBe("error");
    forwarded.push(outgoing);
    return peer.handler(outgoing);
  });
  try {
    const owner = await tokenFor(hub.handler);
    const iphone = await tokenFor(hub.handler);
    const viewer = await tokenFor(hub.handler, DEV_TOKEN, "relay:read");
    const peerToken = await tokenFor(peer.handler);
    const peerViewer = await tokenFor(peer.handler, DEV_TOKEN, "orchestration:read");
    const registration = {
      environmentId: "peer",
      httpBaseUrl: "http://127.0.0.1:4777",
      token: peerToken,
    };
    expect((await hub.handler(request("/api/private-connect/environments"))).status).toBe(401);
    expect(
      (await hub.handler(request("/api/private-connect/environments", viewer, registration)))
        .status,
    ).toBe(403);
    const added = await hub.handler(
      request("/api/private-connect/environments", owner, registration),
    );
    expect(added.status).toBe(200);
    expect(
      (
        await hub.handler(
          request("/api/private-connect/environments", owner, {
            ...registration,
            token: peerViewer,
          }),
        )
      ).status,
    ).toBe(403);
    const first = await (
      await hub.handler(request("/api/private-connect/environments", owner))
    ).json();
    const secondResponse = await hub.handler(request("/api/private-connect/environments", iphone));
    expect(secondResponse.headers.get("cache-control")).toBe("no-store");
    const second = await secondResponse.json();
    expect(secondResponse.status, JSON.stringify(second)).toBe(200);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).not.toContain(peerToken);
    expect(second).toHaveLength(1);
    expect(
      (
        await hub.handler(
          request("/api/private-connect/bootstrap", viewer, { environmentId: "peer" }),
        )
      ).status,
    ).toBe(403);
    const desktopPair = await hub.handler(
      request("/api/private-connect/bootstrap", owner, { environmentId: "peer" }),
    );
    const phonePair = await hub.handler(
      request("/api/private-connect/bootstrap", iphone, { environmentId: "peer" }),
    );
    expect(desktopPair.status).toBe(200);
    expect(phonePair.status).toBe(200);
    const desktop = (await desktopPair.json()) as { pairing: { credential: string } };
    const phone = (await phonePair.json()) as { pairing: { credential: string } };
    expect(desktop.pairing.credential).not.toBe(phone.pairing.credential);
    const desktopToken = await tokenFor(peer.handler, desktop.pairing.credential);
    const phoneToken = await tokenFor(peer.handler, phone.pairing.credential);
    expect(desktopToken).not.toBe(phoneToken);
    expect(desktopToken).not.toBe(peerToken);
    expect((await peer.handler(request("/api/auth/session", phoneToken))).status).toBe(200);
    const limited = await tokenFor(
      hub.handler,
      DEV_TOKEN,
      "relay:read access:write orchestration:read",
    );
    const limitedResponse = await hub.handler(
      request("/api/private-connect/bootstrap", limited, { environmentId: "peer" }),
    );
    expect(limitedResponse.status).toBe(200);
    const limitedPair = (await limitedResponse.json()) as {
      pairing: { credential: string };
      scopes: string[];
    };
    expect(limitedPair.scopes.toSorted()).toEqual([
      "access:write",
      "orchestration:read",
      "relay:read",
    ]);
    const limitedToken = await tokenFor(peer.handler, limitedPair.pairing.credential);
    const limitedSession = (await (
      await peer.handler(request("/api/auth/session", limitedToken))
    ).json()) as { scopes: string[] };
    expect(limitedSession.scopes).not.toContain("terminal:operate");

    const beforeMismatch = forwarded.length;
    expect(
      (
        await hub.handler(
          request("/api/private-connect/environments", owner, {
            ...registration,
            environmentId: "other",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      forwarded.slice(beforeMismatch).every((entry) => !entry.headers.has("authorization")),
    ).toBe(true);
    for (const httpBaseUrl of [
      "http://192.168.1.2",
      "https://name:password@example.test",
      "https://example.test/path",
      "https://example.test?token=secret",
      "file:///tmp/a",
    ]) {
      expect(
        (
          await hub.handler(
            request("/api/private-connect/environments", owner, { ...registration, httpBaseUrl }),
          )
        ).status,
      ).toBe(400);
    }
    const removed = await hub.handler(
      request("/api/private-connect/remove", owner, { environmentId: "peer" }),
    );
    expect(removed.status).toBe(200);
    expect(
      await (await hub.handler(request("/api/private-connect/environments", iphone))).json(),
    ).toEqual([]);
    expect(
      (
        await hub.handler(
          request("/api/private-connect/bootstrap", iphone, { environmentId: "peer" }),
        )
      ).status,
    ).toBe(400);
  } finally {
    await hub.dispose();
    await peer.dispose();
  }
});
