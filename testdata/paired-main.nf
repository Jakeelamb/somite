#!/usr/bin/env nextflow
nextflow.enable.dsl=2

process SOMITE_FASTP_7C5EAAC1 {
    tag 'SOMITE_FASTP_7C5EAAC1'
    cache 'deep'
    publishDir params.outdir + '/SOMITE_FASTP_7C5EAAC1', mode: 'copy', overwrite: true

    input:
    path input_0, name: 'somite_in_0.fastq'
    path input_1, name: 'somite_in_1.fastq'
    env 'SOMITE_PARAM_7C5EAAC1_THREADS'

    output:
    path 'somite_out/clean_R1.fastq.gz', emit: out_r1
    path 'somite_out/clean_R2.fastq.gz', emit: out_r2

    script:
    '''
    set -euo pipefail
    mkdir -p somite_out somite_tmp
    argv=(
      'fastp'
      '-i'
      'somite_in_0.fastq'
      '-o'
      'somite_out/clean_R1.fastq.gz'
      '-I'
      'somite_in_1.fastq'
      '-O'
      'somite_out/clean_R2.fastq.gz'
      '-w'
      "${SOMITE_PARAM_7C5EAAC1_THREADS}"
    )
    "${argv[@]}"
    somite_output_r1_count=0
    while IFS= read -r somite_artifact; do
      somite_output_r1_count=$(( somite_output_r1_count + 1 ))
      if [[ ! -s "$somite_artifact" ]]; then echo "Somite: empty output $somite_artifact" >&2; exit 74; fi
      gzip -t -- "$somite_artifact" || { echo "Somite: corrupt gzip $somite_artifact" >&2; exit 74; }
    done < <(compgen -G 'somite_out/clean_R1.fastq.gz' || true)
    if (( somite_output_r1_count == 0 )); then echo 'Somite: required output r1 was not created' >&2; exit 74; fi
    somite_output_r2_count=0
    while IFS= read -r somite_artifact; do
      somite_output_r2_count=$(( somite_output_r2_count + 1 ))
      if [[ ! -s "$somite_artifact" ]]; then echo "Somite: empty output $somite_artifact" >&2; exit 74; fi
      gzip -t -- "$somite_artifact" || { echo "Somite: corrupt gzip $somite_artifact" >&2; exit 74; }
    done < <(compgen -G 'somite_out/clean_R2.fastq.gz' || true)
    if (( somite_output_r2_count == 0 )); then echo 'Somite: required output r2 was not created' >&2; exit 74; fi
    '''
}

process SOMITE_FASTQC_AF430D22 {
    tag 'SOMITE_FASTQC_AF430D22'
    cache 'deep'
    publishDir params.outdir + '/SOMITE_FASTQC_AF430D22', mode: 'copy', overwrite: true

    input:
    path input_0, name: 'clean_R1.fastq.gz'
    path input_1, name: 'clean_R2.fastq.gz'

    output:
    path 'somite_out/clean_R1_fastqc.html', emit: out_report_r1
    path 'somite_out/clean_R2_fastqc.html', emit: out_report_r2

    script:
    '''
    set -euo pipefail
    mkdir -p somite_out somite_tmp
    argv=(
      'fastqc'
      'clean_R1.fastq.gz'
      'clean_R2.fastq.gz'
      '-o'
      'somite_out'
      '--extract'
    )
    "${argv[@]}"
    somite_output_report_r1_count=0
    while IFS= read -r somite_artifact; do
      somite_output_report_r1_count=$(( somite_output_report_r1_count + 1 ))
      if [[ ! -s "$somite_artifact" ]]; then echo "Somite: empty output $somite_artifact" >&2; exit 74; fi
    done < <(compgen -G 'somite_out/clean_R1_fastqc.html' || true)
    if (( somite_output_report_r1_count == 0 )); then echo 'Somite: required output report_r1 was not created' >&2; exit 74; fi
    somite_output_report_r2_count=0
    while IFS= read -r somite_artifact; do
      somite_output_report_r2_count=$(( somite_output_report_r2_count + 1 ))
      if [[ ! -s "$somite_artifact" ]]; then echo "Somite: empty output $somite_artifact" >&2; exit 74; fi
    done < <(compgen -G 'somite_out/clean_R2_fastqc.html' || true)
    if (( somite_output_report_r2_count == 0 )); then echo 'Somite: required output report_r2 was not created' >&2; exit 74; fi
    '''
}

workflow {
    main:
    ch_input_8935b4f3_r1 = channel.fromPath(params.inputs.INPUT_8935B4F3_R1, checkIfExists: true, glob: false)
    ch_input_8935b4f3_r2 = channel.fromPath(params.inputs.INPUT_8935B4F3_R2, checkIfExists: true, glob: false)
    SOMITE_FASTP_7C5EAAC1(ch_input_8935b4f3_r1, ch_input_8935b4f3_r2, params.values.PARAM_7C5EAAC1_THREADS.toString())
    SOMITE_FASTQC_AF430D22(SOMITE_FASTP_7C5EAAC1.out.out_r1, SOMITE_FASTP_7C5EAAC1.out.out_r2)
}
