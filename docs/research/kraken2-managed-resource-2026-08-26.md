# Kraken2 database provisioning, 2026-08-26

## Conclusion

The Kraken2 executable and a Kraken2 database have separate lifecycles. Pixi
can install and lock the executable that downloads or builds a database, but
the resulting scientific data should live in a persistent, user-owned Somite
resource store with an explicit release, provenance manifest, and checksum.
It should not be written into `.pixi/envs`, hidden behind an ambient default,
or kept in `/tmp`.

## Verified findings

- A Kraken2 database is a directory with three required binary files:
  `hash.k2d`, `opts.k2d`, and `taxo.k2d`. Kraken2 installation does not create
  those files. The project documents `kraken2-build --standard --db PATH` for a
  standard build and estimates roughly 100 GB of temporary disk use during
  construction. [Kraken2 manual](https://github.com/DerrickWood/kraken2/wiki/Manual)
- Pixi can provide the build executable. A live `pixi search` against Bioconda
  on 2026-08-26 returned `kraken2` 2.17.1 as a 329.28 KiB package and found no
  `kraken2-db`, Kraken database, or MiniKraken package. This is package-registry
  evidence, not a claim that no database can ever be distributed through
  another channel.
- A Pixi task may produce and cache declared output files, so a locked Pixi
  environment can run a database materializer. Pixi also documents that
  `.pixi/envs` is recreated from the manifest and lock and may be deleted during
  cleanup. The database output therefore belongs outside the environment.
  [Pixi task caching](https://pixi.prefix.dev/latest/workspace/advanced_tasks/#caching),
  [Pixi environment structure](https://pixi.prefix.dev/latest/workspace/environment/#structure)
- The Kraken2 project directs users to the Langmead Lab prebuilt index zone.
  Its June 2026 release publishes dated HTTPS archives, archive checksums,
  inspection output, and library reports. Standard is 79.6 GB compressed and
  103.1 GB unpacked; Standard-8 is 5.5 GB compressed and 7.5 GB unpacked. The
  capped database trades sensitivity and accuracy for size, so Somite must
  expose that as a scientific choice rather than silently selecting it.
  [Kraken2 downloads](https://github.com/DerrickWood/kraken2/wiki),
  [Kraken2/Bracken index zone](https://benlangmead.github.io/aws-indexes/k2)
- On this host, `/tmp` is a user-writable mode-1777 tmpfs with 47 GB capacity;
  it cannot hold the current Standard archive, much less the unpacked index.
  The home filesystem has 616 GB free. The host has 93 GiB of physical memory,
  while the current Standard index is 103.1 GB. Kraken2 recommends enough free
  memory for the database and offers `--memory-mapping` when that is not
  possible, so full Standard should not be selected silently on this machine.
  Sudo is unnecessary and would create root-owned data that complicates normal
  execution and cleanup.

## Somite implications

Somite should use one requirements Interface for the UI and MCP agent:

1. classify an unbound specialized input as a Managed resource requirement;
2. offer compatible providers: register an existing database, download a
   dated prebuilt database, or build a custom database in a locked tool
   environment;
3. compare published disk and memory requirements with the selected machine
   before recommending a provider;
4. stage into a user-owned partial directory, verify expected structure and
   published checksums, then atomically publish into a persistent
   content-addressed store;
5. persist the logical resource identity and provenance rather than a hidden
   global environment variable;
6. bind a separate tiny reviewed fixture database for representative
   validation, with evidence that does not claim production-database validity.

Large download/build work should be one explicit size-aware action. Ordinary
Somite inspection and graph edits can remain automatically approved.
