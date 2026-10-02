/**
 * Provider platform assembly.
 *
 * The composition root asks for a registry; this module supplies one. It is the
 * only place that knows both a routing configuration and a concrete adapter
 * class, which is what keeps vendor names out of the core entirely.
 *
 * Every adapter gets its own simulator and that simulator is returned, not
 * hidden. A test has to be able to script a timeout on the primary provider and
 * a clean success on its failover, and a builder that swallowed the handles
 * would make that impossible.
 */

import {
  DefaultProviderRegistry,
  OTP_CAPABILITIES,
  VERIFICATION_CAPABILITIES,
  assertValidProviderPlatformConfig,
  capabilityPreferences,
  declaredCapabilitiesIn,
  merchantPins,
  purposePreferences,
  routableRequests,
  routingFor,
  type AnyProvider,
  type ProviderFamily,
  type ProviderFamilyRoutingConfig,
  type ProviderPlatformConfig,
  type ProviderRegistration,
  type ProviderResolutionRequest,
} from "../../application/providers/index.js";
import { MockCreditBureauProvider } from "../mocks/mock-credit-bureau.provider.js";
import {
  MockLendingProvider,
  MockLoanServicingProvider,
} from "../mocks/mock-lending.provider.js";
import { MockOtpProvider } from "../mocks/mock-otp.provider.js";
import { MockVerificationProvider } from "../mocks/mock-verification.provider.js";
import { ProviderSimulator } from "../mocks/simulator.js";
import { defaultProviderPlatformConfig } from "./default-provider-platform.js";

export interface BuildProviderPlatformOptions {
  /** Defaults to the mock platform, which keeps development and tests zero-config. */
  config?: ProviderPlatformConfig;
  /** Fixed clock, so scripted outcomes are reproducible. */
  now?: () => Date;
}

export interface ProviderPlatform {
  registry: DefaultProviderRegistry;
  /** `providerId` to its simulator. */
  simulators: ReadonlyMap<string, ProviderSimulator>;
  /** The (family, capability) pairs the configuration promises to serve. */
  routableRequests: readonly ProviderResolutionRequest[];
}

/** Builds the provider for one registration slot. */
type ProviderFactory = (input: {
  id: string;
  simulator: ProviderSimulator;
  now: () => Date;
}) => AnyProvider;

/**
 * Builds and validates the platform.
 *
 * Configuration is validated first, so a bad capability declaration fails with a
 * configuration error rather than a half-wired registry.
 */
export function buildProviderPlatform(
  options: BuildProviderPlatformOptions = {},
): ProviderPlatform {
  const config = options.config ?? defaultProviderPlatformConfig();
  assertValidProviderPlatformConfig(config);

  const now = options.now ?? ((): Date => new Date());
  const registry = new DefaultProviderRegistry({
    failureThreshold: config.health.failureThreshold,
    openDurationMs: config.health.openDurationMs,
    successThreshold: config.health.successThreshold,
  });
  const simulators = new Map<string, ProviderSimulator>();

  registerFamily(
    registry,
    simulators,
    config,
    "VERIFICATION",
    now,
    (input) =>
      new MockVerificationProvider({
        id: input.id,
        capabilities: declaredCapabilitiesIn(
          "VERIFICATION",
          VERIFICATION_CAPABILITIES,
          routingFor(config, "VERIFICATION"),
          input.id,
        ),
        simulator: input.simulator,
        now: input.now,
      }),
  );

  registerFamily(
    registry,
    simulators,
    config,
    "CREDIT_BUREAU",
    now,
    (input) =>
      new MockCreditBureauProvider({
        id: input.id,
        simulator: input.simulator,
        now: input.now,
      }),
  );

  registerFamily(
    registry,
    simulators,
    config,
    "LENDING",
    now,
    (input) =>
      new MockLendingProvider({
        id: input.id,
        simulator: input.simulator,
        now: input.now,
      }),
  );

  registerFamily(
    registry,
    simulators,
    config,
    "LOAN_MIRROR",
    now,
    (input) =>
      new MockLoanServicingProvider({
        id: input.id,
        simulator: input.simulator,
        now: input.now,
      }),
  );

  registerFamily(
    registry,
    simulators,
    config,
    "OTP",
    now,
    (input) =>
      new MockOtpProvider({
        id: input.id,
        capabilities: declaredCapabilitiesIn(
          "OTP",
          OTP_CAPABILITIES,
          routingFor(config, "OTP"),
          input.id,
        ),
        simulator: input.simulator,
        now: input.now,
      }),
  );

  // Every (family, capability) the configuration claims must be servable. A gap
  // is a deployment mistake and belongs at boot, not at the first customer.
  const requests = routableRequests(config);
  registry.assertRoutable(requests);

  return { registry, simulators, routableRequests: requests };
}

function registerFamily(
  registry: DefaultProviderRegistry,
  simulators: Map<string, ProviderSimulator>,
  config: ProviderPlatformConfig,
  family: ProviderFamily,
  now: () => Date,
  factory: ProviderFactory,
): void {
  const routing: ProviderFamilyRoutingConfig = routingFor(config, family);

  for (const providerId of routing.providerIds) {
    const simulator = new ProviderSimulator({ providerId, family, now });
    simulators.set(providerId, simulator);

    const registration: ProviderRegistration = {
      provider: factory({ id: providerId, simulator, now }),
      defaultForFamily: providerId === routing.defaultProviderId,
      purposes: purposePreferences(routing, providerId),
      capabilities: capabilityPreferences(routing, providerId),
      merchantIds: merchantPins(routing, providerId),
    };

    registry.register(registration);
  }
}
