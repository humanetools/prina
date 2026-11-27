/**
 * The models a provider offers right now (31-IMPL) — fetched through the core with the user's key
 * (or a connected entry's stored key), never from the browser to the provider. Replaces the
 * hard-coded catalog that broke the day a provider retired a model.
 */
import { useCallback, useState } from "react";
import { api, apiErrorMessage } from "../../api/client";

export interface ModelInfo { id: string; label: string }
export interface ModelList { models: ModelInfo[]; source: "live" | "catalog"; note?: string }

export interface ModelListArgs {
  target: "lm" | "ss";
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  anthropicWorkspaceId?: string;
  entryId?: string;
}

export function useProviderModels() {
  const [list, setList] = useState<ModelList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (args: ModelListArgs) => {
    setLoading(true);
    setError(null);
    try {
      const out = await api<ModelList>("/api/ai/models", { method: "POST", body: args });
      setList(out);
      return out;
    } catch (e) {
      setError(apiErrorMessage(e, "Could not load the model list"));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  const reset = useCallback(() => { setList(null); setError(null); setLoading(false); }, []);
  return { list, loading, error, load, reset };
}
