#!/usr/bin/env bash
set -uo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$spike_dir/../../.." && pwd)"
audit_root="$(mktemp -d)"
trap 'rm -rf "$audit_root"' EXIT

cargo build --quiet --manifest-path "$repo_root/Cargo.toml" -p somite-cli || exit 2

prepare_case() {
  local case_root="$1"
  mkdir -p "$case_root/fixtures"
  cp "$spike_dir/fastp-fastqc.somite.json" "$case_root/"
  cp "$spike_dir/fixtures/paired_R1.fastq" "$case_root/fixtures/"
  cp "$spike_dir/fixtures/paired_R2.fastq" "$case_root/fixtures/"
}

run_case() {
  local case_root="$1"
  (
    cd "$case_root" || exit
    SOMITE_OPERATORS="$spike_dir/operators" \
      "$repo_root/target/debug/somite" cook "$case_root/fastp-fastqc.somite.json"
  )
}

failures=0

expect_state() {
  local label="$1"
  local output="$2"
  local node="$3"
  local state="$4"
  if grep -Fq "$node"$'\t'"$state"$'\t' <<<"$output"; then
    printf 'PASS\t%s\t%s=%s\n' "$label" "$node" "$state"
  else
    printf 'FAIL\t%s\texpected %s=%s\n' "$label" "$node" "$state"
    failures=$((failures + 1))
  fi
}

mutation_root="$audit_root/mutation"
prepare_case "$mutation_root"
baseline_output="$(run_case "$mutation_root" 2>&1)"
expect_state "mutation setup" "$baseline_output" reads "done"
expect_state "mutation setup" "$baseline_output" fastp "done"
expect_state "mutation setup" "$baseline_output" fastqc "done"
cp "$spike_dir/fixtures/paired_R2_mutated.fastq" "$mutation_root/fixtures/paired_R2.fastq"
mutation_output="$(run_case "$mutation_root" 2>&1)"
expect_state "same-path R2 mutation" "$mutation_output" reads "done"
expect_state "same-path R2 mutation" "$mutation_output" fastp "done"
expect_state "same-path R2 mutation" "$mutation_output" fastqc "done"

parameter_root="$audit_root/parameter"
prepare_case "$parameter_root"
parameter_setup="$(run_case "$parameter_root" 2>&1)"
expect_state "parameter setup" "$parameter_setup" reads "done"
expect_state "parameter setup" "$parameter_setup" fastp "done"
expect_state "parameter setup" "$parameter_setup" fastqc "done"
sed -i 's/"threads": 1/"threads": 2/' "$parameter_root/fastp-fastqc.somite.json"
parameter_output="$(run_case "$parameter_root" 2>&1)"
expect_state "threads change cone" "$parameter_output" reads "cached"
expect_state "threads change cone" "$parameter_output" fastp "done"
expect_state "threads change cone" "$parameter_output" fastqc "cached"

recovery_root="$audit_root/recovery"
prepare_case "$recovery_root"
cp "$spike_dir/fixtures/paired_R2_invalid.fastq" "$recovery_root/fixtures/paired_R2.fastq"
recovery_failure="$(run_case "$recovery_root" 2>&1)"
recovery_failure_status=$?
if [[ "$recovery_failure_status" -ne 0 ]]; then
  printf 'PASS\tfailure setup\tCLI exit=%s\n' "$recovery_failure_status"
else
  printf 'FAIL\tfailure setup\texpected nonzero CLI exit\n'
  failures=$((failures + 1))
fi
expect_state "failure setup" "$recovery_failure" fastp "failed"
expect_state "failure setup" "$recovery_failure" fastqc "skipped"
cp "$spike_dir/fixtures/paired_R2.fastq" "$recovery_root/fixtures/paired_R2.fastq"
recovery_output="$(run_case "$recovery_root" 2>&1)"
expect_state "input repair" "$recovery_output" reads "done"
expect_state "input repair" "$recovery_output" fastp "done"
expect_state "input repair" "$recovery_output" fastqc "done"

printf 'BLOCKED\tcancellation\tnative RunHandle/cancel Interface does not exist; synchronous Command::output cannot be exercised through the CLI\n'
printf '\nMutation run report:\n%s\n' "$mutation_output"
printf '\nParameter run report:\n%s\n' "$parameter_output"
printf '\nFailure run report:\n%s\n' "$recovery_failure"
printf '\nRecovery run report:\n%s\n' "$recovery_output"

if [[ "$failures" -ne 0 ]]; then
  printf '\nSUMMARY\tFAIL\t%s deterministic gate assertion(s) failed\n' "$failures"
  exit 1
fi
printf '\nSUMMARY\tPASS\tall executable adversarial gates passed\n'
