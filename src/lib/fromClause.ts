/**
 * Which tables a statement has in scope, read out of its FROM clause.
 *
 * `@codemirror/lang-sql` completes a column only after a qualifier —
 * `c.` — or from a `defaultTable` named once in the configuration.
 * Neither helps the ordinary case: `select * from customers where ` has
 * one table in scope and offered nothing but the names of every other
 * table in the database.
 *
 * A text scan rather than a walk of CodeMirror's syntax tree. The tree
 * is more precise, but a function taking a string and returning table
 * references is one that can be tested exhaustively without building an
 * editor, which is the trade this codebase makes everywhere else.
 */

/** One table a statement can take columns from. */
export interface TableRef {
  /** Null when the statement named the table without its schema. */
  schema: string | null;
  table: string;
  /** The alias the statement gave it, if it gave one. */
  alias: string | null;
}

/**
 * Words that introduce a table name.
 *
 * `update` and `into` are here because an UPDATE and an INSERT have a
 * table in scope exactly as a SELECT does, and a WHERE or a RETURNING
 * is written against its columns.
 */
const INTRODUCES_TABLE = new Set(["from", "join", "update", "into"]);

/**
 * Words that end a table reference.
 *
 * Everything that can follow a table in a FROM clause without being its
 * alias. `on` and `using` end a join's table; the rest end the clause.
 */
const NOT_AN_ALIAS = new Set([
  "as", "on", "using", "join", "inner", "left", "right", "full", "cross",
  "natural", "lateral", "where", "group", "having", "order", "limit",
  "offset", "fetch", "union", "intersect", "except", "set", "values",
  "returning", "select", "insert", "update", "delete", "with", "window",
  "for", "into", "from", "and", "or", "not", "tablesample",
]);

/**
 * The statement with comments and literals blanked out.
 *
 * Positions are preserved — every removed character becomes a space —
 * so nothing downstream has to map offsets back. A table name inside a
 * string is not a table reference, and a `--` comment holding the word
 * `from` is not a FROM clause.
 */
function mask(sql: string): string {
  const out = sql.split("");
  const n = sql.length;
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < Math.min(to, n); k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  while (i < n) {
    const c = sql[i];

    if (c === "-" && sql[i + 1] === "-") {
      let end = sql.indexOf("\n", i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      // Block comments nest in Postgres, so this counts rather than
      // looking for the first `*/`.
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (sql[k] === "/" && sql[k + 1] === "*") {
          depth++;
          k += 2;
        } else if (sql[k] === "*" && sql[k + 1] === "/") {
          depth--;
          k += 2;
        } else {
          k++;
        }
      }
      blank(i, k);
      i = k;
      continue;
    }

    if (c === "$") {
      // A dollar-quoted body ends only at the tag that opened it.
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? n : close + tag[0].length;
        blank(i, end);
        i = end;
        continue;
      }
    }

    if (c === "'") {
      let k = i + 1;
      while (k < n) {
        if (sql[k] === "'" && sql[k + 1] === "'") {
          k += 2;
          continue;
        }
        if (sql[k] === "'") {
          k++;
          break;
        }
        k++;
      }
      blank(i, k);
      i = k;
      continue;
    }

    i++;
  }

  return out.join("");
}

type Token = { text: string; word: string; quoted: boolean };

/**
 * Identifiers, punctuation, and nothing else.
 *
 * `word` is the lower-cased bare form used for keyword tests; a quoted
 * identifier keeps its case in `text` and is never read as a keyword,
 * because `"from"` is a table called from.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*|[.,()]/g;

  for (let m = pattern.exec(sql); m; m = pattern.exec(sql)) {
    const raw = m[0];
    if (raw.startsWith('"')) {
      tokens.push({
        text: raw.slice(1, -1).replace(/""/g, '"'),
        word: "",
        quoted: true,
      });
    } else {
      tokens.push({ text: raw, word: raw.toLowerCase(), quoted: false });
    }
  }

  return tokens;
}

function isName(token: Token | undefined): boolean {
  return token !== undefined && (token.quoted || /^[A-Za-z_]/.test(token.text));
}

/**
 * The tables `sql` can take columns from, in the order it names them.
 *
 * A subquery in the FROM clause is skipped rather than guessed at: its
 * columns are whatever its SELECT list produced, which is not something
 * the catalog can answer.
 *
 * Duplicates are kept — `orders o join orders p` really does have two —
 * because the alias is what tells them apart downstream.
 */
export function tablesInScope(sql: string): TableRef[] {
  const tokens = tokenize(mask(sql));
  const refs: TableRef[] = [];

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].quoted || !INTRODUCES_TABLE.has(tokens[i].word)) {
      i++;
      continue;
    }

    // `delete from`, `insert into`: the introducing word is the one that
    // matters, and the reference follows it.
    i++;

    // A comma-separated list, which is how a join was written before
    // JOIN existed and how plenty of SQL still is.
    for (;;) {
      // `from (select ...)`: a derived table, whose columns the catalog
      // does not know. Skip to the end of it rather than reading the
      // first name inside as a table.
      if (tokens[i]?.text === "(") {
        let depth = 0;
        while (i < tokens.length) {
          if (tokens[i].text === "(") depth++;
          if (tokens[i].text === ")") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
      } else {
        if (!isName(tokens[i])) break;
        if (!tokens[i].quoted && NOT_AN_ALIAS.has(tokens[i].word)) break;

        let schema: string | null = null;
        let table = tokens[i].text;
        i++;

        if (tokens[i]?.text === "." && isName(tokens[i + 1])) {
          schema = table;
          table = tokens[i + 1].text;
          i += 2;
        }

        // `as x`, or the bare `x` that means the same thing.
        let alias: string | null = null;
        if (tokens[i] && !tokens[i].quoted && tokens[i].word === "as") i++;
        if (isName(tokens[i]) && (tokens[i].quoted || !NOT_AN_ALIAS.has(tokens[i].word))) {
          alias = tokens[i].text;
          i++;
        }

        refs.push({ schema, table, alias });
      }

      if (tokens[i]?.text === ",") {
        i++;
        continue;
      }
      break;
    }
  }

  return refs;
}
