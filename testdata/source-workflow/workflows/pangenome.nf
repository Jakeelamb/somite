include { WFMASH_MAP_ALIGN } from '../modules/wfmash'
include { ODGI_QC } from '../subworkflows/odgi_qc'

workflow PANGENOME {
    main:
    WFMASH_MAP_ALIGN()
    ODGI_QC(WFMASH_MAP_ALIGN.out.paf)

    emit:
    report = ODGI_QC.out.report
}
