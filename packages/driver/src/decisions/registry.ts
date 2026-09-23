// The one place a provider name becomes an implementation. Items 4-7 register here and
// nothing else in the seam changes: that is what makes the seam a seam.

import type { Provider } from "./provider.js";
import type { ProviderDescriptor } from "./contract.js";
import { noneProvider } from "./providers/none.js";
import { createJevProvider } from "./providers/jev.js";
import { createOpenRouterProvider } from "./providers/openrouter.js";
import { createVercelProvider } from "./providers/vercel.js";
import { createGenericProvider } from "./providers/generic.js";

/** A factory receives the descriptor and the environment the caller resolved with. Threading the
 *  env through matters for more than tests: it keeps ONE answer to "where does the key come from"
 *  for both the explicit path and the config path, instead of the config path silently reaching
 *  for the ambient process. */
export interface FactoryDeps {
  env?: NodeJS.ProcessEnv;
}
export type ProviderFactory = (descriptor: ProviderDescriptor, deps?: FactoryDeps) => Provider;

const REGISTRY = new Map<string, ProviderFactory>([
  ["none", () => noneProvider],
  ["jev", (d, deps) => createJevProvider(d, deps)],
  ["openrouter", (d, deps) => createOpenRouterProvider(d, deps)],
  ["vercel", (d, deps) => createVercelProvider(d, deps)],
  ["generic", (d, deps) => createGenericProvider(d, deps)],
]);

export function registerProvider(name: string, factory: ProviderFactory): void {
  REGISTRY.set(name, factory);
}

export function providerNames(): string[] {
  return [...REGISTRY.keys()].sort();
}

/** null when the config names a provider no build of this driver knows — a configuration
 *  error the caller reports as `no_provider`, never a crash. */
export function buildProvider(descriptor: ProviderDescriptor, deps?: FactoryDeps): Provider | null {
  const factory = REGISTRY.get(descriptor.name);
  return factory ? factory(descriptor, deps) : null;
}
