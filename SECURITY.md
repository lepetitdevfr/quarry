# Security Policy

Quarry connects to databases and stores their passwords, so a vulnerability
here can expose credentials or data. Reports are welcome and taken seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting —
[Security → Report a vulnerability](https://github.com/lepetitdevfr/quarry/security/advisories/new)
— which reaches the maintainer without disclosing anything.

Useful things to include: what an attacker can do, the steps to reproduce it,
and the version or commit you tested. A proof of concept helps but is not
required.

Expect a first response within a week. This is a personal project, not a
company with an on-call rotation, so please allow reasonable time for a fix
before public disclosure.

## What is in scope

- Anything that leaks a stored password or connection string
- Anything that lets a statement reach the database that the write-guard
  should have refused — the lock is a safety feature and treating it as one is
  the point
- SQL injection in the SQL Quarry generates itself (row editing builds
  `UPDATE`, `DELETE` and `INSERT` statements from grid input)
- Escaping the app's IPC boundary from the frontend into arbitrary command
  execution

## What is not

- SQL you typed yourself doing what you told it to. Quarry runs your
  statements; a `DROP TABLE` you wrote and confirmed is not a vulnerability.
- The write-guard being bypassable by someone who can already edit the app's
  own workspace database or your Keychain — at that point they have your
  machine.
- Missing hardening that has no exploit behind it. A concrete attack path
  makes a report actionable; a scanner's output usually does not.

## How credentials are handled

Passwords are stored in the macOS Keychain, never in the workspace database
and never in the `.sql` mirror files. The workspace database holds connection
metadata — host, port, user, database, TLS mode — but no secrets. TLS
verification uses `rustls` with bundled roots rather than the system store, and
`sslmode` is honoured as Postgres defines it.
