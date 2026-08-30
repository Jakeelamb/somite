include { ODGI_STATS } from '../modules/odgi_stats'

workflow ODGI_QC {
    take:
    paf

    main:
    ODGI_STATS(paf)

    emit:
    report = ODGI_STATS.out.report
}
