process PREPARE {
    conda "${moduleDir}/environment.yml"
    container 'quay.io/biocontainers/coreutils:9.5--h4bc722e_0'

    script:
    """
    true
    """
}
