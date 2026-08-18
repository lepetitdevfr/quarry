/**
 * Raw segments of `text` split on top-level semicolons, as `[start, end)`
 * offsets with the semicolon itself excluded from the segment.
 *
 * A single left-to-right scan rather than a regex: comments and dollar
 * quotes nest or pair in ways a regex can't track across the string
 * (block comments nest; a dollar tag must match the one that opened it).
 */
function splitStatements(text: string): Array<{ start: number; end: number }> {
  const bounds: Array<{ start: number; end: number }> = [];
  let start = 0;

  // `standard_conforming_strings` has been on by default since Postgres
  // 9.1: backslashes are literal in a plain '...' string. Only an E'...'
  // string treats a backslash as an escape, so we track it separately.
  let inString = false;
  let stringIsEscaped = false;
  let inIdent = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let dollarTag: string | null = null; // e.g. "$$" or "$fn$", including delimiters

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      i++;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (c === "/" && text[i + 1] === "*") {
        blockCommentDepth++;
        i += 2;
        continue;
      }
      if (c === "*" && text[i + 1] === "/") {
        blockCommentDepth--;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (dollarTag !== null) {
      if (text.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      if (stringIsEscaped && c === "\\") {
        // A backslash escapes the next character in an E'...' string
        // only; skip both so an escaped quote can't end the string.
        i += 2;
        continue;
      }
      if (c === "'") {
        if (text[i + 1] === "'") {
          // A doubled quote is a literal quote character, in both
          // plain and E strings.
          i += 2;
          continue;
        }
        inString = false;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (inIdent) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          i += 2;
          continue;
        }
        inIdent = false;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Not inside any literal/comment: recognize the openers.
    if (c === "-" && text[i + 1] === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      blockCommentDepth = 1;
      i += 2;
      continue;
    }
    if (c === "'") {
      inString = true;
      // An E-string prefix is the letter immediately before this quote.
      const prev = text[i - 1];
      stringIsEscaped = prev === "e" || prev === "E";
      i++;
      continue;
    }
    if (c === '"') {
      inIdent = true;
      i++;
      continue;
    }
    if (c === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tagMatch) {
        dollarTag = tagMatch[0];
        i += dollarTag.length;
        continue;
      }
      // A lone `$` (parameter like $1, or part of an identifier like
      // a$b) is not a quote opener; treat it as an ordinary character.
      i++;
      continue;
    }
    if (c === ";") {
      bounds.push({ start, end: i });
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }

  // Whatever remains after the last semicolon (or the whole buffer, if
  // there was none) is a final segment, unless it's empty/whitespace.
  bounds.push({ start, end: n });
  return bounds;
}

/**
 * The offset of the first character in `text[start, end)` that isn't
 * leading whitespace or a leading comment, or `end` if the whole span
 * is whitespace/comments (i.e. holds no real statement).
 *
 * Used to tell "cursor sits on this statement's own text" apart from
 * "cursor sits in the gap before it" — the latter belongs to whatever
 * statement precedes, since the user just typed that one.
 */
function firstContentIndex(text: string, start: number, end: number): number {
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 || nl >= end ? end : nl + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < end && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    return i;
  }
  return end;
}

/**
 * The statement the cursor sits in, ready to send, or "" when there is
 * none (an empty buffer, or nothing but comments).
 *
 * `cursor` is an offset into `text`. The returned statement has its
 * terminating semicolon and surrounding whitespace stripped.
 */
export function statementAt(text: string, cursor: number): string {
  return statementRangeAt(text, cursor).sql;
}

/**
 * The same statement, with the offset it starts at in `text`.
 *
 * Postgres reports an error position as a 1-based offset into the
 * statement it was sent, and what it was sent is one statement out of a
 * buffer that may hold several. Without the offset that position cannot
 * be pointed at in the editor, which is the difference between "at
 * character 47" and the cursor landing on the word that broke.
 */
export function statementRangeAt(
  text: string,
  cursor: number,
): { sql: string; start: number } {
  const clamped = Math.max(0, Math.min(cursor, text.length));

  // Segments that hold no real content (pure whitespace/comments, e.g.
  // the tail after a trailing semicolon, or a comment-only buffer) are
  // not statements themselves — they're gaps that belong to whichever
  // real statement precedes them.
  const statements = splitStatements(text)
    .map((seg) => ({ ...seg, contentStart: firstContentIndex(text, seg.start, seg.end) }))
    .filter((seg) => seg.contentStart < seg.end);

  if (statements.length === 0) return { sql: "", start: 0 };

  for (const seg of statements) {
    if (clamped >= seg.contentStart && clamped <= seg.end) {
      return sliced(text, seg.start, seg.end);
    }
  }

  // Not inside any statement's own content span: it's either in a gap
  // between two statements (belongs to the preceding one) or before the
  // first statement's leading whitespace/comments (belongs to that
  // first one, since nothing precedes it).
  let preceding = statements[0];
  for (const seg of statements) {
    if (seg.contentStart <= clamped) preceding = seg;
  }
  return sliced(text, preceding.start, preceding.end);
}

/**
 * A segment as it is sent, plus where it really begins.
 *
 * `statementAt` trims the slice, so the offset has to move by however
 * much came off the front — otherwise every statement preceded by a
 * newline reports a position one character early.
 */
function sliced(text: string, start: number, end: number): { sql: string; start: number } {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  return { sql: raw.trim(), start: start + leading };
}
