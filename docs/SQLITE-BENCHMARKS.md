# SQLite Storage Benchmarks

Measured on 2026-07-20 using Node.js 24.16.0 on Windows. Run from the
repository root:

```powershell
node tools/benchmark-storage.mjs --sizes 500,5000
node tools/benchmark-storage.mjs --include-50k
```

The benchmark compares the legacy full-file corpus search with SQLite FTS5,
and records database open/migration, initial import, artifact listing, reopen,
and unchanged reconciliation time. Synthetic corpora split artifacts evenly
between reports and social-post drafts.

| Corpus | Legacy file search | SQLite search | SQLite list | DB reopen | Unchanged reconcile | Initial import |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Current workspace (257 artifacts, 712 assets) | 245.43 ms | 85.16 ms | 11.72 ms | 7.27 ms | 166.98 ms | 195.65 ms |
| Synthetic 500 artifacts | 403.14 ms | 2.41 ms | 3.93 ms | 5.54 ms | 71.14 ms | 965.91 ms |
| Synthetic 5,000 artifacts | 1,985.01 ms | 30.29 ms | 35.44 ms | 5.67 ms | 558.00 ms | 6,403.21 ms |

Search result counts matched in every case. SQLite reduced measured search time
by about 65% on the current corpus, 99% at 500 artifacts, and 98% at 5,000
artifacts. Initial import is intentionally more expensive because it reads,
hashes, parses metadata, and indexes every artifact once. Subsequent process
reopen is about 5–7 ms; unchanged reconciliation remains linear in file count
because startup verifies file metadata for external changes.

The 50,000-artifact case is opt-in because creating and deleting that many
fixture files is inappropriate for the normal test suite. Run it before a
release that changes schema, FTS, reconciliation, or retention behavior.

## Live server cold path

The same harness starts the real Express server on an ephemeral loopback port
and measures first requests against the current workspace:

| Operation | Time |
| --- | ---: |
| Server ready (`/api/storage/status`) | 673.23 ms |
| First `/api/reports` | 235.43 ms |
| First report open | 28.65 ms |
| First normalized `/api/items` | 1,280.51 ms |
| First `/api/search?q=vector%20search` | 277.98 ms |

The first normalized-items request is the slowest measured path. Startup
primes the index asynchronously, so this number includes contention with or
completion of that cold hydration. Subsequent requests use the in-memory and
SQLite normalized snapshots. This is the primary target for a future startup
warmup optimization; it does not require returning to file-backed querying.

## Interpretation

- SQLite removes full Markdown reads from normal listing and search requests.
- The remaining scale-sensitive path is startup reconciliation (`stat` for
  every source artifact), not SQLite query performance.
- Generated images and browser captures add metadata checks during startup but
  their binary payloads are not stored in SQLite.
- Durable normalized-index hydration avoids reparsing report JSON/Markdown on
  restart when the content signature is unchanged.