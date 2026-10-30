import { EnvironmentId, type PrivateConnectEnvironment } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { makePrivateConnectDiscovery } from "./privateConnect";

const mocks = vi.hoisted(() => ({
  list: vi.fn<
    () => Effect.Effect<ReadonlyArray<PrivateConnectEnvironment>, { readonly _tag: "NetworkError" }>
  >(),
  bootstrap: vi.fn(),
  descriptor: vi.fn(),
  exchange: vi.fn(),
}));

vi.mock("../rpc/privateConnect", async () => {
  const Effect = await import("effect/Effect");
  return {
    listPrivateConnections: Effect.suspend(() => mocks.list()),
    bootstrapPrivateConnection: (...args: unknown[]) => mocks.bootstrap(...args),
  };
});
vi.mock("@t3tools/client-runtime/environment", () => ({
  fetchRemoteEnvironmentDescriptor: (...args: unknown[]) => mocks.descriptor(...args),
}));
vi.mock("@t3tools/client-runtime/authorization", () => ({
  bootstrapRemoteBearerSession: (...args: unknown[]) => mocks.exchange(...args),
}));

function setup() {
  for (const mock of Object.values(mocks)) mock.mockReset();
  const environment = {
    environmentId: EnvironmentId.make("private-peer"),
    label: "Peer",
    httpBaseUrl: "https://peer.example",
    revision: "first",
    expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
  };
  mocks.list.mockReturnValue(Effect.succeed([environment]));
  mocks.descriptor.mockReturnValue(Effect.succeed({ environmentId: environment.environmentId }));
  mocks.bootstrap.mockReturnValue(
    Effect.succeed({ pairing: { credential: "one-use" }, scopes: [] }),
  );
  mocks.exchange.mockImplementation(() =>
    Effect.succeed({ access_token: `device-${mocks.exchange.mock.calls.length}`, expires_in: 120 }),
  );
  return environment;
}

it.effect("discovers the same directory independently and refreshes removals and revisions", () =>
  Effect.gen(function* () {
    const environment = setup();
    const desktop = yield* makePrivateConnectDiscovery;
    const phone = yield* makePrivateConnectDiscovery;
    const desktopRows = yield* desktop(undefined, { label: "Desktop" });
    const phoneRows = yield* phone(undefined, { label: "Phone" });
    expect(desktopRows[0]?.target.environmentId).toBe(environment.environmentId);
    expect(phoneRows[0]?.target.environmentId).toBe(environment.environmentId);
    expect(desktopRows[0]?.credential).not.toEqual(phoneRows[0]?.credential);
    yield* desktop(undefined, {});
    expect(mocks.exchange).toHaveBeenCalledTimes(2);

    yield* TestClock.adjust("31 seconds");
    mocks.list.mockReturnValue(Effect.succeed([{ ...environment, revision: "renewed" }]));
    const renewed = yield* desktop(undefined, {});
    expect(renewed[0]?.target.connectionId).toContain("renewed");
    expect(mocks.exchange).toHaveBeenCalledTimes(3);

    yield* TestClock.adjust("31 seconds");
    mocks.list.mockReturnValue(Effect.succeed([]));
    expect(yield* desktop(undefined, {})).toEqual([]);
    expect(yield* phone(undefined, {})).toEqual([]);
  }),
);

it.effect("keeps unexpired sessions during an outage and discards them at expiry", () =>
  Effect.gen(function* () {
    setup();
    const discover = yield* makePrivateConnectDiscovery;
    expect(yield* discover(undefined, {})).toHaveLength(1);
    mocks.list.mockReturnValue(Effect.fail({ _tag: "NetworkError" }));
    yield* TestClock.adjust("31 seconds");
    expect(yield* discover(undefined, {})).toHaveLength(1);
    yield* TestClock.adjust("90 seconds");
    expect(yield* discover(undefined, {})).toEqual([]);
  }),
);

it.effect("does not exchange a credential with a different environment", () =>
  Effect.gen(function* () {
    setup();
    mocks.descriptor.mockReturnValue(
      Effect.succeed({ environmentId: EnvironmentId.make("someone-else") }),
    );
    const discover = yield* makePrivateConnectDiscovery;
    expect(yield* discover(undefined, {})).toEqual([]);
    expect(mocks.exchange).not.toHaveBeenCalled();
  }),
);
