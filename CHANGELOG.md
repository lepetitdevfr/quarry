## [0.8.0](https://github.com/lepetitdevfr/quarry/compare/v0.7.1...v0.8.0) (2026-09-01)

### Features

* **autocomplete:** complete columns from the statement's FROM clause ([a8e8b38](https://github.com/lepetitdevfr/quarry/commit/a8e8b38b29d4b88b04323433d70939dc17c59d88))
* **autocomplete:** complete columns with their type and keys ([0402c41](https://github.com/lepetitdevfr/quarry/commit/0402c41a8d97f4ae1b5e9e343ac6f44095400b35))
* **tabs:** pin what the tree opens ([92b5fe8](https://github.com/lepetitdevfr/quarry/commit/92b5fe8dcaefa84b336e1706838351f3613efbc3))

### Fixes

* **tabs:** let a query name contain a space ([4d22672](https://github.com/lepetitdevfr/quarry/commit/4d22672345523578df26b4db744f5cd71c5b8f65))

## [0.7.1](https://github.com/lepetitdevfr/quarry/compare/v0.7.0...v0.7.1) (2026-08-25)

### Fixes

* **guard:** classify before the free-policy shortcut ([5d50de1](https://github.com/lepetitdevfr/quarry/commit/5d50de170ce8ce80f9e96aaa06578b2a64938276))

### Internal

* **library:** version the schema instead of converging on it ([727dd71](https://github.com/lepetitdevfr/quarry/commit/727dd71adf4c5805c4f3009e5a39883d502210ad))

## [0.7.0](https://github.com/lepetitdevfr/quarry/compare/v0.6.0...v0.7.0) (2026-08-21)

### Features

* **conn:** let Postgres end a transaction nobody is answering ([0eea8f2](https://github.com/lepetitdevfr/quarry/commit/0eea8f250c0e26ba29b41c49a6e9b490208d8532))
* **edit:** derive what would put a grid edit back ([a3f2a9a](https://github.com/lepetitdevfr/quarry/commit/a3f2a9aaf624b1ad8b1baacb707f8591ea644516))
* **edit:** send the values a batch is about to overwrite ([1372b77](https://github.com/lepetitdevfr/quarry/commit/1372b77dd0a0c41f530409778739295bc29ab4ea))
* **exec:** confirm a write before it commits ([f375e0c](https://github.com/lepetitdevfr/quarry/commit/f375e0cd0a9947a13cb15c551bf3a4a21af9d88b))
* **exec:** park a guarded write and resolve it by token ([e3a09ed](https://github.com/lepetitdevfr/quarry/commit/e3a09edf4945d0946058e3df134f018f086b8185))
* **exec:** record every write, and how it ended ([d9a6727](https://github.com/lepetitdevfr/quarry/commit/d9a6727aef6150505d10ad7c34f0f3133b58e1b9))
* **exec:** run a write in a transaction that waits for a decision ([823c057](https://github.com/lepetitdevfr/quarry/commit/823c057e16163fb5b0ece1e1cf8cdf8f0df30ae9))
* **guard:** decide what to do about a write before committing it ([75166ec](https://github.com/lepetitdevfr/quarry/commit/75166ec09f21ddb645672fc3b2d0e930ec6923e5))
* **guard:** name the kind of write from the parse we already do ([d904b1c](https://github.com/lepetitdevfr/quarry/commit/d904b1c15231fafa86ec23160dfe93ca5bb35750))
* **history:** read the records in a tab, not down the side ([abaa5b8](https://github.com/lepetitdevfr/quarry/commit/abaa5b8eb9db2ea40a1ae39544d90dfb4e936ee5))
* **history:** scope the records to the connection you are on ([70a84c7](https://github.com/lepetitdevfr/quarry/commit/70a84c7720e61c5183cd13241e1de2f914adf344))
* **history:** show what this app wrote ([97cbc6a](https://github.com/lepetitdevfr/quarry/commit/97cbc6a3ee7f1e396b2fab4f194c00843b53647f))
* **library:** add the writes table at schema version 6 ([69c69af](https://github.com/lepetitdevfr/quarry/commit/69c69af4d9142a673c2d55ec0952268b3475995c))
* **library:** record what this app wrote and how it ended ([9a79eea](https://github.com/lepetitdevfr/quarry/commit/9a79eea248200516bc5c3fc0dd68889360f1d9ed))
* **menu:** open the records from the View menu ([e43d355](https://github.com/lepetitdevfr/quarry/commit/e43d3558c78df358ca8c1f02b1de2b1aa8764963))

### Fixes

* **exec:** render the write confirmation where you can see it ([9649b47](https://github.com/lepetitdevfr/quarry/commit/9649b47b5c44918d1f824e0b0d53e55f5e13716f))
* **sidebar:** put creating behind one button so three tabs fit ([53f93e0](https://github.com/lepetitdevfr/quarry/commit/53f93e06db75f298e6f9cadef434724880322e4f))

## [0.6.0](https://github.com/lepetitdevfr/quarry/compare/v0.5.0...v0.6.0) (2026-08-20)

### Features

* **editor:** format the statement under the cursor ([5d49aca](https://github.com/lepetitdevfr/quarry/commit/5d49aca8c3aebf8629b6f845979b39b4e6bec0aa))
* **editor:** keep each clause with its keyword when formatting ([8357808](https://github.com/lepetitdevfr/quarry/commit/83578082baf4dd845452bd334993be337a5b21ec))
* **schema:** quote a generated name only where quoting changes it ([e2a1a32](https://github.com/lepetitdevfr/quarry/commit/e2a1a32d3b6fc785be6e1ea7e64dc6a54adc4f3b))

### Fixes

* **library:** save an untitled tab in place instead of replacing it ([437e395](https://github.com/lepetitdevfr/quarry/commit/437e395e21222468d35d96647aa2afb1a8bbbf8f))
* **tabs:** save the tab that asked to be saved ([f138552](https://github.com/lepetitdevfr/quarry/commit/f1385529b97f302842e4cde61f5a70bcaa4e25c6))

## [0.5.0](https://github.com/lepetitdevfr/quarry/compare/v0.4.1...v0.5.0) (2026-08-20)

### Features

* **history:** browse and recover recent work from the sidebar ([9bfd481](https://github.com/lepetitdevfr/quarry/commit/9bfd481bad74b4a540838688783a2d43d34a3f70))
* **history:** closing a tab keeps its unsaved text ([14f1948](https://github.com/lepetitdevfr/quarry/commit/14f19489cdf5f51260a346b762d016547460d0a6))
* **history:** decide the list's order and summary ([5d4bc85](https://github.com/lepetitdevfr/quarry/commit/5d4bc8522d6889af47473d06a00ded8a88bf08dd))
* **history:** expose recent work over IPC ([f735777](https://github.com/lepetitdevfr/quarry/commit/f73577771816abb9b8e0a479193bac13d2ee9163))
* **history:** record every statement the user runs ([9e2ace2](https://github.com/lepetitdevfr/quarry/commit/9e2ace2b06b7e1b7249c46d80f477c000dd4889c))
* **library:** add the recent table at schema version 5 ([d9f797e](https://github.com/lepetitdevfr/quarry/commit/d9f797e79398c9b0e33a7b836e1a02374b12273a))
* **library:** record and read recent work ([303e786](https://github.com/lepetitdevfr/quarry/commit/303e78640f872f4a3d468b8fad0236fc58f34ef1))
* **schema:** show views in the tree, and test a connection before saving ([c9456b9](https://github.com/lepetitdevfr/quarry/commit/c9456b99e7c7fff37ba94f9324dcef09da530fd1))
* **secrets:** keep every password in one Keychain item ([5a10a2d](https://github.com/lepetitdevfr/quarry/commit/5a10a2d995e2183e4ff060f46834f8c3ef05a118))
* **ui:** identify connections by name, not by their URL ([150b7e2](https://github.com/lepetitdevfr/quarry/commit/150b7e2aa4204314f4a187d72adce1e1129fb2b2))

### Fixes

* **history:** open recovered work into a tab that already holds it ([f4ed2bd](https://github.com/lepetitdevfr/quarry/commit/f4ed2bd48df2b349d17fae5eff81bbcde660795a))
* **tabs:** open onto a focused editor ([58f1add](https://github.com/lepetitdevfr/quarry/commit/58f1add226fe4b444026c47889c949fe1fc36204))
* **trust:** give every result a tab, and every connect a deadline ([529843d](https://github.com/lepetitdevfr/quarry/commit/529843dca3575b15d7fd823f6f74036635791909))
* **trust:** stop the status bar, refusals and picker from misleading ([5efacfb](https://github.com/lepetitdevfr/quarry/commit/5efacfb6b9d7e2795e9cd912f8c48a575cc6dabd))

## [0.4.1](https://github.com/lepetitdevfr/quarry/compare/v0.4.0...v0.4.1) (2026-08-19)

### Fixes

* **tabs:** make the tab shortcuts work on a non-US keyboard layout ([8e060bb](https://github.com/lepetitdevfr/quarry/commit/8e060bbfaeed19f94858eb7df1f95b13fc788349))
* **ui:** centre the new-tab button in the tab bar ([9c2a5a8](https://github.com/lepetitdevfr/quarry/commit/9c2a5a83c373114f39e48f4ee5efcfe0ffca5903))

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
