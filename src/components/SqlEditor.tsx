import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { keymap, type EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { useCallback, useMemo, useRef } from "react";
import { quarryEditorExtensions } from "./editorTheme";
import { statementAt } from "../lib/statements";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Runs `sql`, or the whole buffer when it is omitted. */
  onRun: (sql?: string) => void;
  busy: boolean;
  /** Table name → column names, from `buildCompletionSchema`. */
  completionSchema: Record<string, string[]>;
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  busy,
  completionSchema,
}: Props) {
  // The toolbar button has no key event to read a cursor from, so it
  // borrows the editor's own view. Held in a ref rather than state:
  // storing it would re-render on creation for a value that never
  // changes identity.
  const viewRef = useRef<EditorView | null>(null);

  const runStatement = useCallback(
    (view: EditorView) => {
      const sql = statementAt(
        view.state.doc.toString(),
        view.state.selection.main.head,
      );
      // An empty buffer, or one holding nothing but comments. Running it
      // would ask Postgres to prepare nothing and report an error for a
      // keypress that did not mean anything.
      if (sql) onRun(sql);
    },
    [onRun],
  );
  // Prec.highest ensures Cmd+Enter reaches us before CodeMirror's own
  // bindings. useMemo keeps the extension array stable across renders,
  // which stops CodeMirror from tearing down its state on every keystroke.
  const extensions = useMemo(
    () => [
      ...quarryEditorExtensions,
      sql({
        dialect: PostgreSQL,
        schema: completionSchema,
        // `public` is on the default search path, so unqualified names
        // should resolve there.
        defaultSchema: "public",
        upperCaseKeywords: false,
      }),
      Prec.highest(
        keymap.of([
          {
            key: "Tab",
            // Tab belongs to completion here, and to nothing else. It
            // accepts the highlighted suggestion, or asks for suggestions
            // when none are showing. It never indents — SQL is written,
            // not laid out — and it never moves focus, because leaving
            // the editor mid-statement is not what the key means inside
            // one.
            //
            // Always returns true, even when both commands decline:
            // returning false hands the key back to the browser, which
            // is exactly the focus jump this replaces.
            run: (view) => {
              acceptCompletion(view) || startCompletion(view);
              return true;
            },
          },
          {
            key: "Mod-Enter",
            // The statement the cursor is in, not the buffer. Postgres
            // refuses a multi-statement prepared statement, so sending
            // the buffer makes a two-statement scratchpad unrunnable —
            // which is the state this binding existed to avoid and
            // never did.
            run: (view) => {
              runStatement(view);
              return true;
            },
          },
          {
            key: "Shift-Mod-Enter",
            // The whole buffer, deliberately: still one statement's
            // worth or it fails. Kept because a selection-free "run
            // everything" is what you want on a single-statement tab.
            run: () => {
              onRun();
              return true;
            },
          },
        ]),
      ),
    ],
    [onRun, runStatement, completionSchema],
  );

  return (
    <div className="sql-editor">
      {/* theme="none" disables the wrapper's built-in light theme so
          quarryEditorTheme is the only one applied. */}
      <CodeMirror
        value={value}
        height="200px"
        theme="none"
        // Tab does not indent. It accepts a completion when one is open
        // (see the keymap above) and otherwise moves focus out of the
        // editor, which is what a Tab key does everywhere else and what
        // keyboard navigation expects. SQL here is written, not laid
        // out; nobody indents a WHERE clause by hand.
        indentWithTab={false}
        extensions={extensions}
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
      />
      <div className="editor-toolbar">
        <button
          // Same statement the chord would run: a button and its own
          // shortcut label doing different things is worse than either.
          onClick={() =>
            viewRef.current ? runStatement(viewRef.current) : onRun()
          }
          disabled={busy}
        >
          {busy ? "Running…" : "Run  ⌘↵"}
        </button>
      </div>
    </div>
  );
}
