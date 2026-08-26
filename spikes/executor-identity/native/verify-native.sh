#!/usr/bin/env bash
set -euo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$spike_dir/../../.." && pwd)"
run_root="$(mktemp -d)"
trap 'rm -rf "$run_root"' EXIT

mkdir -p "$run_root/fixtures"
cp "$spike_dir/fastp-fastqc.somite.json" "$run_root/"
cp "$spike_dir/fixtures/paired_R1.fastq" "$run_root/fixtures/"
cp "$spike_dir/fixtures/paired_R2.fastq" "$run_root/fixtures/"

cargo build --quiet --manifest-path "$repo_root/Cargo.toml" -p somite-cli

run_once() {
  (
    cd "$run_root"
    SOMITE_OPERATORS="$spike_dir/operators" \
      "$repo_root/target/debug/somite" cook "$run_root/fastp-fastqc.somite.json"
  )
}

first_run="$(run_once)"
grep -Fq $'reads\tdone\t' <<<"$first_run"
grep -Fq $'fastp\tdone\t' <<<"$first_run"
grep -Fq $'fastqc\tdone\t' <<<"$first_run"
grep -Fq 'clean_R1.fastq.gz' <<<"$first_run"
grep -Fq 'clean_R2.fastq.gz' <<<"$first_run"
grep -Fq 'clean_R1_fastqc.html' <<<"$first_run"
grep -Fq 'clean_R2_fastqc.html' <<<"$first_run"

test -s "$run_root/.somite/pixi.lock"
grep -Fq 'fastp' "$run_root/.somite/pixi.toml"
grep -Fq 'fastqc' "$run_root/.somite/pixi.toml"

second_run="$(run_once)"
grep -Fq $'reads\tcached\t' <<<"$second_run"
grep -Fq $'fastp\tcached\t' <<<"$second_run"
grep -Fq $'fastqc\tcached\t' <<<"$second_run"

printf '%s\n' "$first_run"
printf '%s\n' "$second_run"
