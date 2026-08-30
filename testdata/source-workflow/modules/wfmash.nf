process WFMASH_MAP_ALIGN {
    output:
    path 'mapped.paf', emit: paf

    script:
    """
    touch mapped.paf
    """
}
