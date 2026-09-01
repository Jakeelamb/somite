nextflow.enable.dsl = 2

include { PREPARE } from './modules/prepare'
include { ALIGN } from './modules/align'

workflow {
    PREPARE()
    ALIGN()
}
