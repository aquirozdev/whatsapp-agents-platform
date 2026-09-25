import type { ModelConfig } from "../core/types.js";
import type { ModelProvider, ModelProviderResolver } from "../ports/model.js";

export class ModelRegistry implements ModelProviderResolver {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(providers: ModelProvider[]) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  resolve(config: ModelConfig): ModelProvider {
    const provider = this.providers.get(config.provider);
    if (!provider) {
      throw new Error(`Model provider "${config.provider}" is not registered. Available: ${[...this.providers.keys()].join(", ")}`);
    }
    return provider;
  }

  capabilities(providerId: string) {
    return this.providers.get(providerId)?.capabilities;
  }
}
