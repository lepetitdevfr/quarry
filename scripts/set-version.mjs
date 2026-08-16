// Propagate the version semantic-release picked into the two files it does
// not know about. `@semantic-release/npm` handles package.json; Tauri reads
// its own version from tauri.conf.json, and the crate from Cargo.toml, and a
// mismatch between them names the .dmg after the wrong release.
//
// Deliberately a string edit rather than a TOML/JSON round-trip: rewriting
// those files through a parser reorders keys and drops comments, and
// Cargo.toml is heavily commented here.

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: set-version.mjs <version>");
  process.exit(1);
}

/** Replace the first match, and fail loudly if the pattern found nothing. */
function patch(path, pattern, replacement) {
  const before = readFileSync(path, "utf8");
  // Tested on the pattern, not on whether the text changed: re-running with
  // the version a file already holds is a no-op, not a failure, and treating
  // it as one would break any retry. A pattern that matches nothing is the
  // real failure — it would ship artifacts carrying the previous version.
  if (!pattern.test(before)) {
    console.error(`set-version: nothing matched ${pattern} in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, before.replace(pattern, replacement));
  console.log(`set-version: ${path} -> ${version}`);
}

patch(
  "src-tauri/tauri.conf.json",
  /("version"\s*:\s*)"[^"]+"/,
  `$1"${version}"`,
);

// Only the first `version =` in Cargo.toml, which is the package's own —
// dependency versions come later in the file.
patch("src-tauri/Cargo.toml", /^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
