nextflow.enable.dsl = 2

include { USED_OLD } from './modules/used_old'
include { USED_NEW } from './modules/used_new'

workflow {
    USED_OLD()
    USED_NEW()
}
