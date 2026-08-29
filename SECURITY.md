# Security policy

## Supported versions

Until Somite has its first tagged release, the latest commit on `main` is the
only supported line. After release, security fixes will target the latest
tagged version. Older development snapshots are not supported.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/Jakeelamb/somite/security/advisories/new)
to share:

- the affected version or commit;
- the smallest safe reproduction;
- the expected impact;
- any known mitigation; and
- whether disclosure is time-sensitive.

Remove credentials, private datasets, unpublished source material, and personal
information. The maintainers will acknowledge the report, validate its scope,
coordinate a fix, and agree on disclosure before publishing details. Please do
not disclose the issue publicly until that coordination is complete.

## Scope

Somite runs local tools and user-selected agents. Reports are especially useful
when they involve command execution, path traversal, unsafe archive handling,
cross-origin access to the local server, graph or revision authorization,
credential exposure, or provenance/evidence tampering.

Failures in third-party bioinformatics tools, Pixi packages, Nextflow, or an
external agent should be reported upstream unless Somite introduces or
amplifies the vulnerability.
