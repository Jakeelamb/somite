process ALIGN {
    conda "${moduleDir}/environment.yml"
    container "${ workflow.containerEngine == 'singularity' ?
        'https://depot.galaxyproject.org/singularity/bowtie2:2.5.4--he20e202_0' :
        'quay.io/biocontainers/bowtie2:2.5.4--he20e202_0' }"

    script:
    """
    true
    """
}
