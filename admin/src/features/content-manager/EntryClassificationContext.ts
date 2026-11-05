/**
 * The taxonomy nodes of the entry being edited (25-IMPL). Media widgets sit deep inside field rows,
 * components and dynamic zones, so the asset picker reads this from context instead of a prop chain.
 * Outside the entry editor the default is empty and the picker behaves as a plain browser.
 */
import { createContext } from "react";

export interface EntryClassification {
  nodeId: string;
  name: string;
  /** `<taxonomyUid>:<node.path>` — the filter spec `GET /api/assets?taxonomy=` takes */
  spec: string;
}

export const EntryClassificationContext = createContext<EntryClassification[]>([]);
