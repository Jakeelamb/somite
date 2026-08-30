import manifest from "./package.json" with { type: "json" };

/** Application and provenance identities derived from release package metadata. */
export const SOMITE_VERSION = manifest.version;
export const SOMITE_NEXTFLOW_COMPILER_IDENTITY = `somite-nextflow@${SOMITE_VERSION}`;
export const SOMITE_TYPESCRIPT_RUNNER_IDENTITY = `somite-typescript-runner@${SOMITE_VERSION}`;
