import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AuthEnvironmentScopes, AuthPairingCredentialResult } from "./auth.ts";

export const PrivateConnectEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type PrivateConnectEnvironment = typeof PrivateConnectEnvironment.Type;

export const PrivateConnectRegister = Schema.Struct({
  environmentId: EnvironmentId,
  httpBaseUrl: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
export type PrivateConnectRegister = typeof PrivateConnectRegister.Type;

export const PrivateConnectSelection = Schema.Struct({ environmentId: EnvironmentId });

export const PrivateConnectBootstrap = Schema.Struct({
  environment: PrivateConnectEnvironment,
  pairing: AuthPairingCredentialResult,
  scopes: AuthEnvironmentScopes,
});
export type PrivateConnectBootstrap = typeof PrivateConnectBootstrap.Type;
