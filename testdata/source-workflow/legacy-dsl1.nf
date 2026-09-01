#!/usr/bin/env nextflow
// Reduced from nf-core/cageseq 1.0.2 at
// 838d2a5165edb86439d7ff0400bd385d6bcf6927.

process PREPARE_READS {
    input:
    file reads from input_reads

    output:
    file 'prepared.fastq' into prepared_reads

    script:
    """
    cp $reads prepared.fastq
    """
}

process REPORT_READS {
    input:
    file reads from prepared_reads

    script:
    """
    wc -l $reads
    """
}
