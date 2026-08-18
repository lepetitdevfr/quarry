import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { RenameInput } from "./RenameInput";
import { isDirty } from "../lib/tree";
import type { Query, Tab } from "../types";

interface Props {
  tabs: Tab[];
  queryById: (id: string | null) => Query | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
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
  onCloseOthers,
  onNew,
  namingTabId,
  onCommitName,
  onCancelName,
}: Props) {
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  function tabMenu(tab: Tab): MenuItem[] {
    return [
      { label: "Close", shortcut: "⌘W", onSelect: () => onClose(tab.id) },
      {
        label: "Close others",
        disabled: tabs.length < 2,
        onSelect: () => onCloseOthers(tab.id),
      },
    ];
  }

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => {
        const query = queryById(tab.query_id);
        const label = query?.name ?? tab.title ?? "untitled";
        const dirty = query ? isDirty(query) : (tab.scratch_sql ?? "") !== "";
        const naming = tab.id === namingTabId;

        return (
          <div
            key={tab.id}
            className={`tab${tab.is_active ? " active" : ""}${tab.is_preview ? " preview" : ""}`}
            role="tab"
            aria-selected={tab.is_active}
            tabIndex={tab.is_active ? 0 : -1}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(e) => openMenu(e, tabMenu(tab))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(tab.id);
              }
            }}
            onAuxClick={(e) => {
              // Middle-click closes, as it does in every browser and
              // editor with tabs.
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            title={
              tab.is_preview ? `${label} — preview tab, edit to keep it` : label
            }
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
                {dirty && <span className="dirty-dot" title="unsaved changes">•</span>}
              </>
            )}
            <button
              className="tab-close"
              title="Close tab (⌘W)"
              aria-label={`Close ${label}`}
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
      <button className="tab-new" title="New query tab (⌘T)" onClick={onNew}>
        +
      </button>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
