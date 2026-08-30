process ODGI_STATS {
    input:
    path paf

    output:
    path 'stats.txt', emit: report

    script:
    """
    printf '%s\\n' "${paf}" > stats.txt
    """
}
