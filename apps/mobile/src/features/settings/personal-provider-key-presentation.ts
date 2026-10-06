import { PERSONAL_PROVIDER_KEY_CATALOGUE, orderProviderKeys, type PersonalProviderKeyCatalogueEntry } from "@nautilo/types";
import type { PersonalCredentialsData } from "./personal-account-controller";

export type PersonalProviderKeyRow = PersonalProviderKeyCatalogueEntry & {
  readonly catalogued: boolean;
  readonly available: boolean;
  readonly destination: string | null;
};

export function personalProviderKeyRows(data: PersonalCredentialsData | null): PersonalProviderKeyRow[] {
  const responseProviders = new Map(data?.providers.map((provider) => [provider.id, provider]) ?? []);
  const responseIds = new Set<string>([...responseProviders.keys()]
    .filter((id) => id !== "gateway" && id !== "nautilo-gateway"));
  const catalog = PERSONAL_PROVIDER_KEY_CATALOGUE.map((provider): PersonalProviderKeyRow => ({
    ...provider,
    destination: responseProviders.get(provider.id)?.destination ?? null,
    catalogued: true,
    available: Boolean(data && responseIds.has(provider.id)),
  }));
  const known = new Set<string>(catalog.map((provider) => provider.id));
  const newer = (data?.providers ?? [])
    .filter((provider) => !known.has(provider.id) && provider.id !== "gateway" && provider.id !== "nautilo-gateway")
    .map((provider): PersonalProviderKeyRow => ({
      ...provider, envVar: "", category: "llm", required: false,
      catalogued: true, available: true, destination: provider.destination ?? null,
    }));
  const legacy = (data?.credentials ?? [])
    .filter((credential) => !known.has(credential.provider) && !responseIds.has(credential.provider))
    .map((credential): PersonalProviderKeyRow => ({
      id: credential.provider, name: credential.provider, envVar: "", category: "llm", required: false,
      purpose: "Legacy saved provider outside the current catalogue", personalCapabilities: [],
      destination: credential.destination, catalogued: false, available: false,
    }));
  return orderProviderKeys([...catalog, ...newer, ...legacy]);
}
