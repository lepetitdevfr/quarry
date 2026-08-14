import type { SslMode, Tag } from "../types";

/** Default colours, matching `Tag::default_colour` in Rust. */
const TAG_COLOURS: Record<Tag, string> = {
  local: "#4ade80",
  staging: "#fbbf24",
  prod: "#f26d6d",
};

export function colourForTag(tag: Tag): string {
  return TAG_COLOURS[tag];
}

export interface ParsedUrl {
  host: string;
  port: number;
  user: string;
  dbname: string;
  sslmode: SslMode;
  password: string | null;
}

/**
 * Parse a `postgres://` URL into form fields.
 *
 * This mirrors `ConnectionConfig::from_url` in Rust so pasting a URL
 * fills the form. The Rust side remains the authority at connect time;
 * this is only for convenience while typing.
 */
export function parseConnectionUrl(raw: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;

  const dbname = url.pathname.replace(/^\//, "");
  if (dbname === "") return null;

  const sslmodeParam = url.searchParams.get("sslmode");
  const sslmode: SslMode =
    sslmodeParam === "disable"
      ? "disable"
      : sslmodeParam === "require" ||
          sslmodeParam === "verify-ca" ||
          sslmodeParam === "verify-full"
        ? "require"
        : "prefer";

  return {
    // An empty hostname means the URL had none, e.g. postgres:///mydb.
    host: url.hostname === "" ? "localhost" : decodeURIComponent(url.hostname),
    port: url.port === "" ? 5432 : Number(url.port),
    user: url.username === "" ? "postgres" : decodeURIComponent(url.username),
    dbname: decodeURIComponent(dbname),
    sslmode,
    password: url.password === "" ? null : decodeURIComponent(url.password),
  };
}
