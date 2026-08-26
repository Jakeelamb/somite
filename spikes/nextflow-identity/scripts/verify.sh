#!/usr/bin/env bash
set -euo pipefail

spike_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_root="$spike_root/.work"
run_root="$work_root/run"

bash "$spike_root/scripts/fetch.sh"

if [[ "$run_root" != "$spike_root/.work/run" ]]; then
    echo "refusing unexpected run root: $run_root" >&2
    exit 1
fi
rm -rf "$run_root"
mkdir -p "$run_root/inputs" "$run_root/evidence"
cp "$work_root/fixtures/test_1.fastq.gz" "$run_root/inputs/test_1.fastq.gz"
cp "$work_root/fixtures/test_2.fastq.gz" "$run_root/inputs/test_2.fastq.gz"

printf 'phase\twall_ms\n' > "$run_root/evidence/timings.tsv"
if [[ "${SOMITE_SKIP_NF_TEST:-0}" != "1" ]]; then
    nf_test_start=$(date +%s%N)
    (
        cd "$work_root/sources"
        NFT_WORKDIR="$run_root/nf-test" nf-test test \
            --ci \
            --junitxml "$run_root/evidence/nf-test.junit.xml" \
            modules/nf-core/fastp/tests/main.nf.test \
            modules/nf-core/fastqc/tests/main.nf.test
    )
    nf_test_end=$(date +%s%N)
    printf 'nf-test\t%s\n' "$(((nf_test_end - nf_test_start) / 1000000))" \
        >> "$run_root/evidence/timings.tsv"
fi

run_nextflow() {
    local label=$1
    shift
    local started ended
    started=$(date +%s%N)
    nextflow \
        -log "$run_root/evidence/$label.nextflow.log" \
        run "$spike_root/main.nf" \
        -work-dir "$run_root/work" \
        -with-trace "$run_root/evidence/$label.trace.tsv" \
        -with-report "$run_root/evidence/$label.report.html" \
        -with-timeline "$run_root/evidence/$label.timeline.html" \
        -with-dag "$run_root/evidence/$label.dag.dot" \
        "$@"
    ended=$(date +%s%N)
    printf '%s\t%s\n' "$label" "$(((ended - started) / 1000000))" \
        >> "$run_root/evidence/timings.tsv"
}

assert_alias_statuses() {
    local trace=$1
    local expected_status=$2
    awk -F '\t' -v expected="$expected_status" '
        NR > 1 {
            tasks++
            if ($4 ~ /^SOMITE_NODE_FASTP([ (]|$)/) {
                fastp++
                if ($5 == expected) fastp_expected++
            }
            if ($4 ~ /^SOMITE_NODE_FASTQC([ (]|$)/) {
                fastqc++
                if ($5 == expected) fastqc_expected++
            }
        }
        END {
            exit !(tasks == 2 && fastp == 1 && fastqc == 1 &&
                   fastp_expected == 1 && fastqc_expected == 1)
        }
    ' "$trace"
}

run_nextflow fresh
if ! assert_alias_statuses "$run_root/evidence/fresh.trace.tsv" "COMPLETED"; then
    echo "fresh execution did not complete exactly the two mapped Somite nodes" >&2
    exit 1
fi

input_before_mutation=$(sha256sum "$run_root/inputs/test_1.fastq.gz" | awk '{print $1}')
output_before_mutation=$(gzip -dc \
    "$run_root/results/fastp/somite_spike_R1.fastp.fastq.gz" | sha256sum | awk '{print $1}')

run_nextflow resumed -resume

if ! assert_alias_statuses "$run_root/evidence/resumed.trace.tsv" "CACHED"; then
    echo "resumed execution did not cache exactly the two mapped Somite nodes" >&2
    exit 1
fi

original_mtime=$(stat -c '%y' "$run_root/inputs/test_1.fastq.gz")
gzip -dc "$run_root/inputs/test_1.fastq.gz" > "$run_root/inputs/test_1.fastq"
awk 'NR == 2 { sub(/A/, "C") } { print }' \
    "$run_root/inputs/test_1.fastq" > "$run_root/inputs/test_1.fastq.changed"
mv "$run_root/inputs/test_1.fastq.changed" "$run_root/inputs/test_1.fastq"
gzip -n -c "$run_root/inputs/test_1.fastq" > "$run_root/inputs/test_1.fastq.gz.changed"
mv "$run_root/inputs/test_1.fastq.gz.changed" "$run_root/inputs/test_1.fastq.gz"
touch -d "$original_mtime" "$run_root/inputs/test_1.fastq.gz"
input_after_mutation=$(sha256sum "$run_root/inputs/test_1.fastq.gz" | awk '{print $1}')
if [[ "$input_before_mutation" == "$input_after_mutation" ]]; then
    echo "same-path mutation did not change the input digest" >&2
    exit 1
fi

mv "$run_root/results" "$run_root/results-before-mutation"

run_nextflow mutated -resume

if ! assert_alias_statuses "$run_root/evidence/mutated.trace.tsv" "COMPLETED"; then
    echo "same-path content mutation did not rerun exactly the two mapped Somite nodes" >&2
    exit 1
fi

test -f "$run_root/results/fastp/somite_spike_R1.fastp.fastq.gz"
test -f "$run_root/results/fastp/somite_spike_R2.fastp.fastq.gz"
test -f "$run_root/results/fastp/somite_spike.fastp.json"
test -f "$run_root/results/fastp/somite_spike.fastp.html"
test -f "$run_root/results/fastqc/somite_spike_1_fastqc.html"
test -f "$run_root/results/fastqc/somite_spike_2_fastqc.html"
test -f "$run_root/results/fastqc/somite_spike_1_fastqc.zip"
test -f "$run_root/results/fastqc/somite_spike_2_fastqc.zip"
gzip -t "$run_root/results/fastp/somite_spike_R1.fastp.fastq.gz"
gzip -t "$run_root/results/fastp/somite_spike_R2.fastp.fastq.gz"
output_after_mutation=$(gzip -dc \
    "$run_root/results/fastp/somite_spike_R1.fastp.fastq.gz" | sha256sum | awk '{print $1}')
if [[ "$output_before_mutation" == "$output_after_mutation" ]]; then
    echo "same-path input mutation did not change the FASTP R1 artifact digest" >&2
    exit 1
fi

recovery_root="$run_root/recovery"
mkdir -p "$recovery_root/evidence"
failure_started=$(date +%s%N)
set +e
nextflow \
    -log "$recovery_root/evidence/failure.nextflow.log" \
    run "$spike_root/main.nf" \
    -work-dir "$recovery_root/work" \
    -c "$spike_root/failure.config" \
    --outdir "$recovery_root/results" \
    -with-trace "$recovery_root/evidence/failure.trace.tsv" \
    > "$recovery_root/evidence/failure.stdout.log" 2>&1
failure_status=$?
set -e
failure_ended=$(date +%s%N)
if [[ $failure_status -eq 0 ]]; then
    echo "deliberate FASTP failure unexpectedly succeeded" >&2
    exit 1
fi
if ! grep -Eq 'definitely-invalid-somite-spike-option|Failed to execute process' \
    "$recovery_root/evidence/failure.stdout.log"; then
    echo "deliberate FASTP failure was not observable" >&2
    exit 1
fi
if ! awk -F '\t' '
    NR > 1 {
        tasks++
        if ($4 ~ /^SOMITE_NODE_FASTP([ (]|$)/ && $5 == "FAILED") failed_fastp++
    }
    END { exit !(tasks == 1 && failed_fastp == 1) }
' "$recovery_root/evidence/failure.trace.tsv"; then
    echo "deliberate failure trace was not exactly one failed FASTP node" >&2
    exit 1
fi
printf 'failure\t%s\n' "$(((failure_ended - failure_started) / 1000000))" \
    >> "$run_root/evidence/timings.tsv"

recovery_started=$(date +%s%N)
nextflow \
    -log "$recovery_root/evidence/recovery.nextflow.log" \
    run "$spike_root/main.nf" \
    -work-dir "$recovery_root/work" \
    --outdir "$recovery_root/results" \
    -resume \
    -with-trace "$recovery_root/evidence/recovery.trace.tsv"
recovery_ended=$(date +%s%N)
printf 'recovery\t%s\n' "$(((recovery_ended - recovery_started) / 1000000))" \
    >> "$run_root/evidence/timings.tsv"
if ! assert_alias_statuses \
    "$recovery_root/evidence/recovery.trace.tsv" "COMPLETED"; then
    echo "clean recovery did not complete both Somite nodes" >&2
    exit 1
fi

cancel_root="$run_root/cancellation"
mkdir -p "$cancel_root/evidence"
cancel_started=$(date +%s%N)
setsid nextflow \
    -log "$cancel_root/evidence/cancel.nextflow.log" \
    -C "$spike_root/cancel.config" \
    run "$spike_root/cancel.nf" \
    -work-dir "$cancel_root/work" \
    --pid_file "$cancel_root/child.pid" \
    > "$cancel_root/evidence/cancel.stdout.log" 2>&1 &
nextflow_pid=$!
for _ in {1..45}; do
    if [[ -s "$cancel_root/child.pid" ]]; then
        break
    fi
    if ! kill -0 "$nextflow_pid" 2>/dev/null; then
        break
    fi
    sleep 1
done
if [[ ! -s "$cancel_root/child.pid" ]]; then
    kill -TERM "$nextflow_pid" 2>/dev/null || true
    wait "$nextflow_pid" 2>/dev/null || true
    echo "cancellation probe did not record its child process" >&2
    exit 1
fi
child_pid=$(cat "$cancel_root/child.pid")
if [[ ! "$child_pid" =~ ^[0-9]+$ || ! -r "/proc/$child_pid/stat" ]]; then
    echo "cancellation probe recorded an invalid child identity: $child_pid" >&2
    exit 1
fi
child_start_time=$(awk '{print $22}' "/proc/$child_pid/stat")
kill -TERM "$nextflow_pid"
for _ in {1..15}; do
    if ! kill -0 "$nextflow_pid" 2>/dev/null; then
        break
    fi
    sleep 1
done
if kill -0 "$nextflow_pid" 2>/dev/null; then
    kill -KILL "$nextflow_pid" 2>/dev/null || true
    wait "$nextflow_pid" 2>/dev/null || true
    echo "Nextflow did not stop within the cancellation bound" >&2
    exit 1
fi
set +e
wait "$nextflow_pid"
cancel_status=$?
set -e
cancel_ended=$(date +%s%N)
printf 'cancellation\t%s\n' "$(((cancel_ended - cancel_started) / 1000000))" \
    >> "$run_root/evidence/timings.tsv"
if [[ $cancel_status -eq 0 ]]; then
    echo "cancellation probe completed instead of being interrupted" >&2
    exit 1
fi
for _ in 1 2 3 4 5; do
    if [[ ! -r "/proc/$child_pid/stat" ]]; then
        break
    fi
    if [[ $(awk '{print $22}' "/proc/$child_pid/stat") != "$child_start_time" ]]; then
        break
    fi
    sleep 1
done
if [[ -r "/proc/$child_pid/stat" ]] &&
    [[ $(awk '{print $22}' "/proc/$child_pid/stat") == "$child_start_time" ]]; then
    echo "Nextflow cancellation left child process $child_pid alive" >&2
    kill "$child_pid" 2>/dev/null || true
    exit 1
fi

printf 'nextflow=%s\n' "$(nextflow -version 2>&1 | awk '/version/ {print $2; exit}')"
printf 'java=%s\n' "$(java -version 2>&1 | head -1)"
printf 'fastp=%s\n' "$(fastp --version 2>&1 | awk '{print $2; exit}')"
printf 'fastqc=%s\n' "$(fastqc --version 2>&1 | sed -n 's/^FastQC v//p')"
printf 'fresh_completed=%s\n' "$(awk -F '\t' 'NR > 1 && $5 == "COMPLETED" {n++} END {print n+0}' "$run_root/evidence/fresh.trace.tsv")"
printf 'resumed_cached=%s\n' "$(awk -F '\t' 'NR > 1 && $5 == "CACHED" {n++} END {print n+0}' "$run_root/evidence/resumed.trace.tsv")"
printf 'mutated_completed=%s\n' "$(awk -F '\t' 'NR > 1 && $5 == "COMPLETED" {n++} END {print n+0}' "$run_root/evidence/mutated.trace.tsv")"
printf 'failure_status=%s\n' "$failure_status"
printf 'recovery_completed=%s\n' "$(awk -F '\t' 'NR > 1 && $5 == "COMPLETED" {n++} END {print n+0}' "$recovery_root/evidence/recovery.trace.tsv")"
printf 'cancellation_status=%s\n' "$cancel_status"
printf 'cancellation_child_reaped=true\n'
cat "$run_root/evidence/timings.tsv"
