include { ALIGNER    } from "${projectDir}/modules/aligner/main"
include { statusText } from "${projectDir}/lib/status"
include { paramsSummaryMap } from 'plugin/nf-validation'

workflow ALIGN {
    main:
    ALIGNER()
    message = statusText()
    summary = paramsSummaryMap(workflow)
}
