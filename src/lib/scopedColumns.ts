import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { tablesInScope } from "./fromClause";
import { scopedColumnCompletions } from "./schema";
import { statementRangeAt } from "./statements";
import type { Schema } from "../types";

/**
 * Completions for the columns the statement under the cursor already
 * has in scope.
 *
 * `@codemirror/lang-sql` completes a column only after a qualifier —
 * `c.` — or from a `defaultTable` fixed in the configuration. Neither
 * covers the ordinary case: `select * from customers where ` offered
 * the name of every table in the database and not one column of the
 * table the statement was about.
 *
 * Registered alongside lang-sql's own source rather than replacing it,
 * because the table names it offers are still the right answer just
 * after `from`. CodeMirror merges what several sources return.
 */
export function scopedColumnSource(
  schema: Schema | null,
): (context: CompletionContext) => CompletionResult | null {
  // Narrower than `CompletionSource`, which also allows a promise:
  // everything this needs is already in memory, and saying so keeps
  // callers — the test included — from having to await nothing.
  return (context) => {
    const word = context.matchBefore(/[\w$]*/);
    if (!word) return null;

    // Nothing typed yet, which is what lang-sql's own source declines
    // unless asked. Opening a list on every space would put one in
    // front of the cursor constantly; ⇥ still asks for it.
    if (word.from === word.to && !context.explicit) return null;

    // `c.` belongs to lang-sql, which resolves the alias itself. Two
    // sources answering there would offer every column twice.
    const before = context.state.doc.sliceString(
      Math.max(0, word.from - 1),
      word.from,
    );
    if (before === ".") return null;

    // The whole statement, not the part before the cursor: a FROM
    // clause is written after the select list that names its columns,
    // and just after `select ` is exactly where they are wanted.
    const { sql } = statementRangeAt(context.state.doc.toString(), context.pos);
    const options = scopedColumnCompletions(schema, tablesInScope(sql));
    if (options.length === 0) return null;

    return { from: word.from, options, validFor: /^[\w$]*$/ };
  };
}
