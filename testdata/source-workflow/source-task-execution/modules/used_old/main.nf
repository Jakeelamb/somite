process USED_OLD {
    conda "${moduleDir}/environment.yml"
    container 'quay.io/biocontainers/samtools:1.18--h50ea8bc_1'

    script:
    """
    samtools --version > old.txt
    """
}
