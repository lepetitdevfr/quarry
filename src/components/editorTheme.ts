import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * A dark theme matching the app palette in App.css.
 *
 * CodeMirror ships a light theme by default. Inside a dark window the
 * editor kept a white background while inheriting the app's light text
 * colour, which left the SQL nearly unreadable. The colours below are
 * the same tokens used in App.css — keep them in sync if that file's
 * palette changes.
 */

const BG = "#1a1d23";
const TEXT = "#e5e7eb";
const MUTED = "#8b93a1";
const BORDER = "#2c3038";
const ACCENT = "#4f8ef7";
const SELECTION = "#2d4a7c";

export const quarryEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: BG,
      color: TEXT,
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: ACCENT,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: ACCENT,
      borderLeftWidth: "2px",
    },
    // Both selectors are needed: CodeMirror uses the ::selection
    // pseudo-element when the editor has focus and .cm-selectionBackground
    // when it does not.
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: SELECTION,
      },
    ".cm-gutters": {
      backgroundColor: BG,
      color: MUTED,
      border: "none",
      borderRight: `1px solid ${BORDER}`,
    },
    ".cm-activeLine": {
      backgroundColor: "#20242b",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#20242b",
      color: TEXT,
    },
    ".cm-selectionMatch": {
      backgroundColor: "#2f3a4d",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      lineHeight: "1.5",
    },
  },
  { dark: true },
);

/** Syntax colours for SQL tokens. */
export const quarryHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#c792ea" },
  { tag: [tags.string, tags.special(tags.string)], color: "#98c379" },
  { tag: tags.number, color: "#f0a35e" },
  { tag: [tags.bool, tags.null], color: "#f0a35e" },
  { tag: tags.comment, color: MUTED, fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#61afef" },
  { tag: tags.operator, color: "#89ddff" },
  { tag: [tags.typeName, tags.className], color: "#e5c07b" },
  { tag: tags.propertyName, color: TEXT },
  { tag: tags.variableName, color: TEXT },
]);

/** Drop-in extension bundle: theme plus syntax colours. */
export const quarryEditorExtensions = [
  quarryEditorTheme,
  syntaxHighlighting(quarryHighlightStyle),
];
