# Video bandwidth regression tests

Run from the repository root with Node 22.13 or newer. PGlite runs PostgreSQL in
memory; the tests never connect to the production database or start a video worker.

```powershell
npm.cmd install --prefix tmp/pg-regression --no-package-lock --no-save @electric-sql/pglite
$env:PGLITE_TEST_MODULE = ([System.Uri](Join-Path (Get-Location) 'tmp/pg-regression/node_modules/@electric-sql/pglite/dist/index.js')).AbsoluteUri
node --test tests/video-bandwidth.test.mjs tests/video-polling.test.mjs
```

The tests cover unchanged/partial writes, rollback, idle queue traffic, competing
claims, expired locks, session authorization, conditional job responses, and match
registration with ELO recalculation. PGlite uses one serialized connection, so the
claim test checks the stale-preflight behavior; PostgreSQL row locking is retained
in the production transaction.
