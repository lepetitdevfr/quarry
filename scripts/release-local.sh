#!/usr/bin/env bash
#
# Cut a release from this machine, without spending GitHub Actions minutes.
#
# The Release workflow does the same three things — pick the version, build the
# bundles, publish them to the public repo — across three runners. This does
# them here, and therefore only for macOS: a Mac cannot produce a .deb or an
# NSIS installer, so a local release ships the .dmg alone. Linux and Windows
# stay CI's job, and they are beta anyway.
#
#   scripts/release-local.sh                 cut, build, publish
#   scripts/release-local.sh --dry-run       build, publish nothing, tag nothing
#   scripts/release-local.sh --rebuild 0.6.0 rebuild and publish an existing tag
#   scripts/release-local.sh --skip-verify   skip the test suites (they ran already)
#
# Needs RELEASES_TOKEN in the environment: the same fine-grained PAT the
# workflow uses, scoped to the releases repo with Contents: read and write.
# Pushing the version commit and tag goes over the existing git remote, so the
# ssh key you already push with is enough for that half.

set -euo pipefail

RELEASES_REPO="lepetitdevfr/quarry-releases"
LABEL="aarch64-macos"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

dry_run=false
skip_verify=false
rebuild_tag=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --skip-verify) skip_verify=true ;;
    --rebuild) rebuild_tag="${2:?--rebuild needs a version, without the v}"; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
# Everything that can be wrong before any work happens is checked here, because
# discovering a missing token after a twenty-minute build is the whole reason
# this section exists.

say "Preflight"

command -v node >/dev/null || die "node is not on PATH"
command -v cargo >/dev/null || die "cargo is not on PATH"
[ "$(uname -s)" = "Darwin" ] || die "this script builds the macOS bundle; run it on the Mac"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"

if [ -z "$rebuild_tag" ]; then
  [ "$branch" = "main" ] || die "releases are cut from main, not $branch"
  git fetch --tags --quiet origin
  # semantic-release reads tag history to decide the next version, and pushes
  # a commit at the end. Both go wrong if this clone is behind origin.
  local_head="$(git rev-parse @)"
  remote_head="$(git rev-parse @{u})"
  [ "$local_head" = "$remote_head" ] || die "main and origin/main have diverged; pull or push first"
else
  git rev-parse --verify --quiet "refs/tags/v$rebuild_tag" >/dev/null \
    || die "no tag v$rebuild_tag in this clone"
fi

if [ "$dry_run" = false ]; then
  [ -n "${RELEASES_TOKEN:-}" ] || die "RELEASES_TOKEN is not set (fine-grained PAT for $RELEASES_REPO, Contents: read and write)"
fi

echo "branch:  $branch"
echo "mode:    $([ "$dry_run" = true ] && echo 'dry run' || echo 'publish')"
[ -n "$rebuild_tag" ] && echo "rebuild: v$rebuild_tag"

# --- verification ------------------------------------------------------------
# CI gates a release on these; a local release has no other gate. A rebuild
# skips them: that code was already released, and the tag is what it is.

if [ "$skip_verify" = false ] && [ -z "$rebuild_tag" ]; then
  say "Verifying"
  npm test
  npm run build
  (cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check)
fi

# --- version -----------------------------------------------------------------

previous_version="$(node -p "require('./package.json').version")"

if [ -n "$rebuild_tag" ]; then
  version="$rebuild_tag"
  # Build the code that was actually released, not the branch tip. The trap
  # puts the branch back however this exits.
  restore_ref="$branch"
  trap 'git checkout --quiet "$restore_ref" || true' EXIT
  say "Checking out v$version"
  git checkout --quiet "v$version"

elif [ "$dry_run" = true ]; then
  # Nothing is cut, so there is no new number. Rehearse against the current one.
  version="$previous_version"
  say "Dry run: rehearsing as $version (semantic-release not run)"

else
  say "Version and changelog"
  # --no-ci because semantic-release refuses to run outside a CI environment
  # unless told the caller knows what it is doing. The plugin list in .releaserc
  # has no @semantic-release/github, so this tags and pushes over git and
  # publishes nothing on its own — this script does the publishing.
  npx semantic-release --no-ci

  version="$(node -p "require('./package.json').version")"
  if [ "$version" = "$previous_version" ]; then
    say "Nothing to release"
    echo "No commit since v$previous_version asks for a version bump."
    exit 0
  fi
  echo "cut v$version"
fi

# --- build -------------------------------------------------------------------

say "Building $version for $LABEL"

# `hdiutil: create failed - Resource busy` is the signature macOS failure: a
# disk image from an earlier attempt is still detaching. Same retry the
# workflow uses.
build_ok=false
for attempt in 1 2 3; do
  if npm run tauri build -- --bundles dmg; then
    build_ok=true
    break
  fi
  echo "warning: build attempt $attempt failed"
  hdiutil info | awk '/\/Volumes\/Quarry/ {print $1}' | while read -r dev; do
    echo "detaching stale volume $dev"
    hdiutil detach "$dev" -force || true
  done
  sleep 20
done
[ "$build_ok" = true ] || die "build failed after 3 attempts"

say "Collecting the bundle"
rm -rf dist-artifacts
mkdir -p dist-artifacts
asset="dist-artifacts/Quarry-$version-$LABEL.dmg"
found=false
for f in src-tauri/target/release/bundle/dmg/*.dmg; do
  [ -e "$f" ] || continue
  cp "$f" "$asset"
  found=true
  break
done
[ "$found" = true ] || die "the build produced no .dmg"
ls -lh "$asset"

if [ "$dry_run" = true ]; then
  say "Dry run complete"
  echo "Built $asset. Nothing was tagged, pushed, or published."
  exit 0
fi

# --- publish -----------------------------------------------------------------
# curl against the API rather than the gh CLI, which is not installed here.
# node does the JSON, so there is no jq dependency either.

say "Publishing to $RELEASES_REPO"

notes="$(awk -v v="$version" '
  $0 ~ "^#+ \\[?" v "\\]?" { inside = 1; next }
  inside && /^#+ \[?[0-9]+\.[0-9]+\.[0-9]+/ { exit }
  inside { print }
' CHANGELOG.md)"

[ -n "${notes//[[:space:]]/}" ] || notes="See CHANGELOG.md for v$version."

body="$notes

---

**Every build here is beta.** Quarry is pre-1.0, unsigned, and has been used in
earnest by one person. Back up anything you point it at, and keep the
write-guard on for production connections.

This release was built on a Mac rather than in CI, so it carries the
**macOS (Apple Silicon)** bundle only. Unsigned, so macOS quarantines it and
refuses the first open:

\`\`\`bash
xattr -dr com.apple.quarantine /Applications/Quarry.app
\`\`\`"

api() {
  local method="$1" url="$2"
  shift 2
  curl --silent --show-error --location \
    --request "$method" \
    --header "Authorization: Bearer $RELEASES_TOKEN" \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    "$@" "$url"
}

# A rebuild targets a release that already exists; a fresh cut does not. Ask
# before creating, so both paths land in the same place.
existing="$(api GET "https://api.github.com/repos/$RELEASES_REPO/releases/tags/v$version")"
release_id="$(printf '%s' "$existing" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { const r = JSON.parse(s); process.stdout.write(r.id ? String(r.id) : ""); }
    catch { process.stdout.write(""); }
  });
')"

if [ -z "$release_id" ]; then
  echo "creating release v$version"
  payload="$(BODY="$body" TAG="v$version" NAME="Quarry v$version" node -e '
    process.stdout.write(JSON.stringify({
      tag_name: process.env.TAG,
      name: process.env.NAME,
      body: process.env.BODY,
    }));
  ')"
  created="$(api POST "https://api.github.com/repos/$RELEASES_REPO/releases" --data "$payload")"
  release_id="$(printf '%s' "$created" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const r = JSON.parse(s);
      if (!r.id) { console.error("GitHub refused the release: " + s); process.exit(1); }
      process.stdout.write(String(r.id));
    });
  ')"
else
  echo "release v$version already exists (id $release_id); replacing its $LABEL asset"
  # An asset name cannot be reused while the old one is attached, and a rebuild
  # exists precisely to replace it.
  old_asset_id="$(printf '%s' "$existing" | ASSET="$(basename "$asset")" node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const r = JSON.parse(s);
      const hit = (r.assets || []).find(a => a.name === process.env.ASSET);
      process.stdout.write(hit ? String(hit.id) : "");
    });
  ')"
  if [ -n "$old_asset_id" ]; then
    api DELETE "https://api.github.com/repos/$RELEASES_REPO/releases/assets/$old_asset_id" >/dev/null
  fi
fi

echo "uploading $(basename "$asset")"
upload="$(curl --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $RELEASES_TOKEN" \
  --header "Accept: application/vnd.github+json" \
  --header "Content-Type: application/octet-stream" \
  --data-binary "@$asset" \
  "https://uploads.github.com/repos/$RELEASES_REPO/releases/$release_id/assets?name=$(basename "$asset")")"

printf '%s' "$upload" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const r = JSON.parse(s);
    if (r.state !== "uploaded") { console.error("upload failed: " + s); process.exit(1); }
    console.log("uploaded " + r.name + " (" + r.size + " bytes)");
  });
'

say "Released v$version"
echo "https://github.com/$RELEASES_REPO/releases/tag/v$version"
