nextflow.enable.dsl = 2

process SOMITE_NODE_CANCELLATION_PROBE {
    input:
    val token

    output:
    path 'done.txt'

    script:
    """
    sleep 120 &
    child=\$!
    printf '%s\n' \$child > ${params.pid_file}
    wait \$child
    printf '%s\n' '$token' > done.txt
    """
}
workflow {
    SOMITE_NODE_CANCELLATION_PROBE(Channel.of('complete'))
}
