import { RenameInput } from "./RenameInput";
import { isDirty } from "../lib/tree";
import type { Query, Tab } from "../types";

interface Props {
  tabs: Tab[];
  queryById: (id: string | null) => Query | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Id of the tab currently being named on save (untitled tabs only). */
  namingTabId: string | null;
  onCommitName: (name: string) => void;
  onCancelName: () => void;
}

export function TabBar({
  tabs,
  queryById,
  onActivate,
  onClose,
  onNew,
  namingTabId,
  onCommitName,
  onCancelName,
}: Props) {
  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const query = queryById(tab.query_id);
        const label = query?.name ?? "untitled";
        const dirty = query ? isDirty(query) : (tab.scratch_sql ?? "") !== "";
        const naming = tab.id === namingTabId;

        return (
          <div
            key={tab.id}
            className={`tab${tab.is_active ? " active" : ""}`}
            onClick={() => onActivate(tab.id)}
            title={label}
          >
            {naming ? (
              <RenameInput
                initial=""
                depth={0}
                placeholder="Query name"
                onCommit={onCommitName}
                onCancel={onCancelName}
              />
            ) : (
              <>
                <span className="tab-label">{label}</span>
                {dirty && <span className="dirty-dot">•</span>}
              </>
            )}
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="tab-new" title="New query tab" onClick={onNew}>
        +
      </button>
    </div>
  );
}
