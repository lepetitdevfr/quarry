import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { keymap, type EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { useCallback, useMemo, useRef } from "react";
import { quarryEditorExtensions } from "./editorTheme";
import { statementRangeAt } from "../lib/statements";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Runs `sql`, or the whole buffer when it is omitted. */
  onRun: (sql?: string) => void;
  busy: boolean;
  /** Table name → column names, from `buildCompletionSchema`. */
  completionSchema: Record<string, string[]>;
  /** Pane height in pixels, owned by the caller's drag handle. */
  height: number;
  /**
   * Handed a function that moves the cursor to a character offset
   * within the statement last run from this editor. The error panel
   * calls it; only the editor knows where that statement started in the
   * buffer, so the mapping cannot live in App.
   */
  onReady?: (goToPosition: (position: number) => void) => void;
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  busy,
  completionSchema,
  height,
  onReady,
}: Props) {
  // The toolbar button has no key event to read a cursor from, so it
  // borrows the editor's own view. Held in a ref rather than state:
  // storing it would re-render on creation for a value that never
  // changes identity.
  const viewRef = useRef<EditorView | null>(null);

  // `onRun` behind a ref so the extension array below does not depend on
  // it. A caller passing an inline arrow — which App does for the Data
  // tab — gives it a new identity on every render, and App re-renders
  // once a second while the guard countdown polls. Rebuilding the
  // extensions reconfigures CodeMirror, and a reconfigure closes an open
  // completion list: the suggestions appeared and vanished a second
  // later, in time with the cursor blink.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  // Where in the buffer the statement we last sent began. Postgres
  // reports an error position relative to the statement it received,
  // which is one statement out of this buffer — without this offset the
  // position points at the wrong place in anything but a single-statement
  // tab.
  const lastRunStart = useRef(0);

  const runStatement = useCallback((view: EditorView) => {
    const { sql, start } = statementRangeAt(
      view.state.doc.toString(),
      view.state.selection.main.head,
    );
    lastRunStart.current = start;
    // An empty buffer, or one holding nothing but comments. Running it
    // would ask Postgres to prepare nothing and report an error for a
    // keypress that did not mean anything.
    if (sql) onRunRef.current(sql);
  }, []);
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
              onRunRef.current();
              return true;
            },
          },
        ]),
      ),
    ],
    [runStatement, completionSchema],
  );

  return (
    // The height is dragged, so it is set here rather than on the
    // CodeMirror instance: the instance fills the pane (see .sql-editor
    // in App.css), and the pane is what the divider resizes.
    <div className="sql-editor" style={{ height: `${height}px` }}>
      {/* theme="none" disables the wrapper's built-in light theme so
          quarryEditorTheme is the only one applied. */}
      <CodeMirror
        value={value}
        height="100%"
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
          onReady?.((position) => {
            // Postgres counts from 1, and from the start of the
            // statement it was sent.
            const offset = Math.min(
              view.state.doc.length,
              Math.max(0, lastRunStart.current + position - 1),
            );
            view.dispatch({
              selection: { anchor: offset },
              scrollIntoView: true,
            });
            view.focus();
          });
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
