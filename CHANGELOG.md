## [0.4.0](https://github.com/lepetitdevfr/quarry/compare/v0.3.0...v0.4.0) (2026-08-18)

### Features

* **grid:** stage new rows above the results, not below them ([99e7612](https://github.com/lepetitdevfr/quarry/commit/99e7612f96856abadeaa7e0fc4e9282efc3a60b1))
* **ui:** implement the UI/UX audit's P0 and P1 items ([7789e70](https://github.com/lepetitdevfr/quarry/commit/7789e7047253673245a1e68c0a0c6b284b6a84ef))

### Fixes

* **app:** suppress the webview's own context menu outside text fields ([f91b56d](https://github.com/lepetitdevfr/quarry/commit/f91b56dc48fabc2afc6dc9a7ceff8af65def1cb4))
* **grid:** make the header sticky, and pin staged rows beneath it ([d40dd6b](https://github.com/lepetitdevfr/quarry/commit/d40dd6bd4533a43046e9a1e39e717c206f8d7e89))
* **grid:** remove the gap between staged rows and the first result row ([3f3e74b](https://github.com/lepetitdevfr/quarry/commit/3f3e74bd9731bca03f2b32a27566a6d23aaed548))
* **ui:** make the grid menu's Delete row legible and stop tree rows selecting ([fd82ee0](https://github.com/lepetitdevfr/quarry/commit/fd82ee0f9e7fe6f9803d8c3588c616cc93a5ff6f))

## [0.3.0](https://github.com/lepetitdevfr/quarry/compare/v0.2.0...v0.3.0) (2026-08-17)

### Features

* **ui:** show and edit the query behind a Data tab ([882f988](https://github.com/lepetitdevfr/quarry/commit/882f9887a88f31a672ddf4c4906e3881c04fd051))
* **ui:** tell the user when a newer version is published ([f73248f](https://github.com/lepetitdevfr/quarry/commit/f73248fb262e0d4accad4bc540afe062c0ac5964))

### Fixes

* **ci:** repair the release workflow yaml ([06abe5e](https://github.com/lepetitdevfr/quarry/commit/06abe5e6349921e625bb1701d79f54725d4eea1d))
* **editor:** accept the completion with tab instead of indenting ([d1c0fb3](https://github.com/lepetitdevfr/quarry/commit/d1c0fb39454ba6d10a1b85bef004e847a4ed531f))
* **editor:** complete columns for a table named without its schema ([edeaceb](https://github.com/lepetitdevfr/quarry/commit/edeaceba8d10bbcd129070fd5e2aa6370e055bc4))
* **editor:** make tab open or accept suggestions, never leave the editor ([3a65ac3](https://github.com/lepetitdevfr/quarry/commit/3a65ac38a13bd5087532dc5d57d746d48ea06243))
* **editor:** stop a re-render from closing the suggestion list ([b44e150](https://github.com/lepetitdevfr/quarry/commit/b44e150b54eb30414a018348ec1b86934afc998b))
* **editor:** stop tab from indenting ([34a2260](https://github.com/lepetitdevfr/quarry/commit/34a22606838839dd62ae95296285c8208303e4bb))

## [0.2.0](https://github.com/lepetitdevfr/quarry/compare/v0.1.1...v0.2.0) (2026-08-16)

### Features

* **library:** move a query to another collection ([bc19fed](https://github.com/lepetitdevfr/quarry/commit/bc19fedbcb2dee5e28731b351594565cda4fd0e6))
* **schema:** show size, comment, triggers and dependent views ([064e6b4](https://github.com/lepetitdevfr/quarry/commit/064e6b46fd117755d9c9a3d2d8f29901bfc7164c))

### Fixes

* **connect:** stop re-saving a password read from the Keychain ([5457d55](https://github.com/lepetitdevfr/quarry/commit/5457d559a259dc025ef0154cc44b4c6d97a6a710))
* **edit:** stop offering an editor on a generated column ([29ae123](https://github.com/lepetitdevfr/quarry/commit/29ae123b537286aaa2d8c3a08f68ddb9406de082))
* **library:** size the move menu like the tree it sits in ([d22c5ee](https://github.com/lepetitdevfr/quarry/commit/d22c5ee56246bf9b9659361633640bfa5846606f))
* **secrets:** read the Keychain with one prompt, not two ([2219fbf](https://github.com/lepetitdevfr/quarry/commit/2219fbf69cc9b6afb7a66231ba21c4875e20fb3e))
* **state:** recover from a poisoned lock instead of panicking ([4a74640](https://github.com/lepetitdevfr/quarry/commit/4a746406bac588b6740ff58a8dfa7adf443d738a))

## [0.1.1](https://github.com/lepetitdevfr/quarry/compare/v0.1.0...v0.1.1) (2026-08-16)

### Internal

* **secrets:** store passwords through the keyring crate ([cb1e32b](https://github.com/lepetitdevfr/quarry/commit/cb1e32baec97888c7820f31b30f083d1b6bac11c))

### Build

* compile the menu only where it applies ([6717f16](https://github.com/lepetitdevfr/quarry/commit/6717f16b6f7eb7c339c65d310eb932615d0ecada))
