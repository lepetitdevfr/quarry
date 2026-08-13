import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { useMemo } from "react";
import { quarryEditorExtensions } from "./editorTheme";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  busy: boolean;
}

export function SqlEditor({ value, onChange, onRun, busy }: Props) {
  // Prec.highest ensures Cmd+Enter reaches us before CodeMirror's own
  // bindings. useMemo keeps the extension array stable across renders,
  // which stops CodeMirror from tearing down its state on every keystroke.
  const extensions = useMemo(
    () => [
      ...quarryEditorExtensions,
      sql({ dialect: PostgreSQL }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onRun();
              return true;
            },
          },
        ]),
      ),
    ],
    [onRun],
  );

  return (
    <div className="sql-editor">
      {/* theme="none" disables the wrapper's built-in light theme so
          quarryEditorTheme is the only one applied. */}
      <CodeMirror
        value={value}
        height="200px"
        theme="none"
        extensions={extensions}
        onChange={onChange}
      />
      <div className="editor-toolbar">
        <button onClick={onRun} disabled={busy}>
          {busy ? "Running…" : "Run  ⌘↵"}
        </button>
      </div>
    </div>
  );
}
