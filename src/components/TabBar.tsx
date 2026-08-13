import { isDirty } from "../lib/tree";
import type { Query, Tab } from "../types";

interface Props {
  tabs: Tab[];
  queryById: (id: string | null) => Query | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function TabBar({ tabs, queryById, onActivate, onClose, onNew }: Props) {
  return (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const query = queryById(tab.query_id);
        const label = query?.name ?? "untitled";
        const dirty = query ? isDirty(query) : (tab.scratch_sql ?? "") !== "";

        return (
          <div
            key={tab.id}
            className={`tab${tab.is_active ? " active" : ""}`}
            onClick={() => onActivate(tab.id)}
            title={label}
          >
            <span className="tab-label">{label}</span>
            {dirty && <span className="dirty-dot">•</span>}
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
