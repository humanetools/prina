/** React Query hooks — all data-fetching logic lives here (global rule: state/logic in hooks) */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  Asset,
  AssetDetail,
  ComponentDef,
  LicenseState,
  McpToken,
  McpToolDef,
  TemplateGetResult,
  ContentType,
  Entry,
  EntryDetail,
  Locale,
  Paginated,
  Role,
  TaxonomyNode,
  TaxonomyRow,
  TunnelStatus,
  UserRow,
  Workflow,
  Workspace,
} from "../api/types";

export function useContentTypes() {
  return useQuery({
    queryKey: ["content-types"],
    queryFn: () => api<ContentType[]>("/api/content-types"),
  });
}

export function useComponents() {
  return useQuery({
    queryKey: ["components"],
    queryFn: () => api<ComponentDef[]>("/api/components"),
  });
}

export function useEntries(
  typeUid: string | undefined,
  params: Record<string, string>,
) {
  const qs = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ["entries", typeUid, qs],
    queryFn: () => api<Paginated<Entry>>(`/api/content/${typeUid}?${qs}`),
    // Keep the previous page on filter/search changes — no table flash, fewer re-renders
    placeholderData: (prev: Paginated<Entry> | undefined) => prev,
    enabled: !!typeUid,
  });
}

export function useEntry(typeUid: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["entry", typeUid, id],
    queryFn: () => api<EntryDetail>(`/api/content/${typeUid}/${id}`),
    enabled: !!typeUid && !!id,
  });
}

export function useDocumentEntries(typeUid?: string, documentId?: string) {
  return useQuery({
    queryKey: ["document", typeUid, documentId],
    queryFn: () => api<Entry[]>(`/api/content/${typeUid}/document/${documentId}`),
    enabled: !!typeUid && !!documentId,
  });
}



export function useLocales() {
  return useQuery({ queryKey: ["locales"], queryFn: () => api<Locale[]>("/api/locales") });
}

export function useRoles() {
  return useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/api/roles") });
}

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => api<UserRow[]>("/api/users") });
}

export function useWorkflow() {
  return useQuery({
    queryKey: ["workflow"],
    queryFn: () => api<Workflow>("/api/workflow"),
  });
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/workspaces"),
  });
}

export function useTaxonomies() {
  return useQuery({
    queryKey: ["taxonomies"],
    queryFn: () => api<TaxonomyRow[]>("/api/taxonomies"),
  });
}

export function useTaxonomyTree(uid?: string) {
  return useQuery({
    queryKey: ["taxonomy-tree", uid],
    queryFn: () => api<TaxonomyNode[]>(`/api/taxonomies/${uid}/tree`),
    enabled: !!uid,
  });
}


export function useAssets(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ["assets", qs],
    queryFn: () => api<Paginated<Asset>>(`/api/assets?${qs}`),
  });
}

export function useAssetFolders() {
  return useQuery({
    queryKey: ["asset-folders"],
    queryFn: () => api<string[]>("/api/assets/folders"),
  });
}

export function useAsset(id?: string) {
  return useQuery({
    queryKey: ["asset", id],
    queryFn: () => api<AssetDetail>(`/api/assets/${id}`),
    enabled: !!id,
  });
}

export function useMcpTokens() {
  return useQuery({
    queryKey: ["mcp-tokens"],
    queryFn: () => api<McpToken[]>("/api/mcp/tokens"),
  });
}

export function useMcpTools(plane: string) {
  return useQuery({
    queryKey: ["mcp-tools", plane],
    queryFn: () => api<McpToolDef[]>(`/api/mcp/tools?plane=${plane}`),
  });
}

/** Public address (IMPL-public-tunnel) — polls while the connector is being provisioned */
export function useTunnelStatus() {
  return useQuery({
    queryKey: ["tunnel-status"],
    queryFn: () => api<TunnelStatus>("/api/tunnel/status"),
    // 502 when the tunnel service is unreachable — a stale panel is better than a retry storm
    retry: false,
  });
}

export function useTemplate(typeUid?: string) {
  return useQuery({
    queryKey: ["template", typeUid],
    queryFn: () => api<TemplateGetResult>(`/api/templates/${typeUid}`),
    enabled: !!typeUid,
  });
}

/** Mutation + related-query invalidation helper */
export function useInvalidatingMutation<TInput, TOutput = unknown>(
  fn: (input: TInput) => Promise<TOutput>,
  invalidate: string[][],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** License state (T8.3 unpatched banner) — the worker evaluates every 12h, so long staleness is fine */
export function useLicense() {
  return useQuery({
    queryKey: ["license"],
    queryFn: () => api<{ state: LicenseState | null }>("/api/license"),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });
}
