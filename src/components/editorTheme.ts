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

// Read from the stylesheet rather than restated here. The previous
// literals had drifted: the editor background was #1a1d23, which is
// neither --bg nor --panel, so the seam where the editor met the grid
// was a third dark the palette never defined.
const token = (name: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value === "" ? fallback : value;
};

// The editor is a content surface, like the grid and the inputs — so it
// sits on --bg, not on the chrome colour.
const BG = token("--bg", "#16181d");
const TEXT = token("--text", "#e5e7eb");
const MUTED = token("--muted", "#8b93a1");
const BORDER = token("--border", "#2c3038");
const ACCENT = token("--accent", "#4f8ef7");
const SELECTION = token("--selection", "#2d4a7c");
// Dimmer, for a selection left behind when focus moves elsewhere: still
// findable, but not competing with whatever now has the cursor.
const SELECTION_BLUR = token("--selection-blur", "#23344f");

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
    // Selection is drawn by CodeMirror, not by the browser: the
    // `drawSelection` extension in basicSetup forces the native
    // ::selection transparent at Prec.highest and paints
    // .cm-selectionBackground divs instead. So a ::selection rule here
    // is dead weight, and the div is the only thing worth styling.
    //
    // The focused selector has to be spelled out to this depth because
    // CodeMirror's own base theme claims
    // `&dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
    // — five classes. A shorter selector loses on specificity, and the
    // base colour it falls back to is #233, which on this background is
    // a highlight you cannot see.
    ".cm-selectionBackground": {
      backgroundColor: SELECTION_BLUR,
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      {
        backgroundColor: SELECTION,
      },
    ".cm-gutters": {
      backgroundColor: BG,
      color: MUTED,
      border: "none",
      borderRight: `1px solid ${BORDER}`,
    },
    // Translucent, not the flat #20242b it used to be. The active-line
    // decoration is painted on the line element, which sits above the
    // selection layer, and `highlightActiveLine` marks the line under
    // the selection's head whether or not the selection is empty. An
    // opaque colour there hides every selection that stays on one line
    // — the exact bug this replaced. CodeMirror's own defaults are
    // translucent for the same reason. 3% white over the editor
    // background lands on the same colour it was.
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.03)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: token("--hover", "#22262e"),
      color: TEXT,
    },
    ".cm-selectionMatch": {
      backgroundColor: SELECTION_BLUR,
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
