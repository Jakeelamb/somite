nextflow.enable.dsl = 2

include { FASTP as SOMITE_NODE_FASTP } from './.work/sources/modules/nf-core/fastp/main'
include { FASTQC as SOMITE_NODE_FASTQC } from './.work/sources/modules/nf-core/fastqc/main'

workflow {
    reads = Channel.of([
        [id: params.sample_id, single_end: false],
        [
            file(params.read_1, checkIfExists: true),
            file(params.read_2, checkIfExists: true)
        ],
        []
    ])

    SOMITE_NODE_FASTP(reads, false, false, false)
    SOMITE_NODE_FASTQC(SOMITE_NODE_FASTP.out.reads)
}
