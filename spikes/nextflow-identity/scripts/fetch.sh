#!/usr/bin/env bash
set -euo pipefail

spike_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_root="$spike_root/.work"
modules_commit=fcc9c9adc59e6b0bfb91fc4b8855de00c81a9bd5
test_data_commit=30cbc341ad7721e2253e5e1517bd5544ea8b1ff7

mkdir -p "$work_root/sources/modules/nf-core/fastp/tests"
mkdir -p "$work_root/sources/modules/nf-core/fastqc/tests"
mkdir -p "$work_root/sources/tests/config"
mkdir -p "$work_root/fixtures"

for source in nf-test.config tests/config/nf-test.config; do
    target="$work_root/sources/$source"
    curl -fsSL --retry 3 --max-time 30 \
        "https://raw.githubusercontent.com/nf-core/modules/$modules_commit/$source" \
        -o "$target"
done

for module in fastp fastqc; do
    for source in main.nf meta.yml environment.yml tests/main.nf.test tests/main.nf.test.snap; do
        target="$work_root/sources/modules/nf-core/$module/$source"
        curl -fsSL --retry 3 --max-time 30 \
            "https://raw.githubusercontent.com/nf-core/modules/$modules_commit/modules/nf-core/$module/$source" \
            -o "$target"
    done
done

for source in nextflow.interleaved.config nextflow.save_failed.config; do
    target="$work_root/sources/modules/nf-core/fastp/tests/$source"
    curl -fsSL --retry 3 --max-time 30 \
        "https://raw.githubusercontent.com/nf-core/modules/$modules_commit/modules/nf-core/fastp/tests/$source" \
        -o "$target"
done

for fixture in test_1.fastq.gz test_2.fastq.gz; do
    curl -fsSL --retry 3 --max-time 30 \
        "https://raw.githubusercontent.com/nf-core/test-datasets/$test_data_commit/data/genomics/sarscov2/illumina/fastq/$fixture" \
        -o "$work_root/fixtures/$fixture"
done

(
    cd "$work_root"
    sha256sum --check "$spike_root/sources.sha256"
)
