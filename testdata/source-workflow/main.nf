#!/usr/bin/env nextflow

include { PANGENOME } from './workflows/pangenome'

workflow NFCORE_PANGENOME {
    main:
    PANGENOME()
}

workflow {
    NFCORE_PANGENOME()
}
