process USED_NEW {
    conda "${moduleDir}/environment.yml"
    container 'quay.io/biocontainers/samtools:1.19.2--h50ea8bc_1'

    script:
    """
    samtools --version > new.txt
    """
}
