use std::collections::{BTreeMap, BTreeSet};

use somite_ir::{Graph, ParamValue};
use somite_nextflow::{compile, CompileError, CompileOptions};
use somite_ops::{Catalog, OpKind, Operator};

fn options() -> CompileOptions {
    CompileOptions {
        workflow_name: "somite-spike".into(),
        output_dir: "results".into(),
        platforms: vec!["linux-64".into()],
        nextflow_version: "26.04.4".into(),
        openjdk_version: "17.0.17".into(),
    }
}

fn paired_fixture() -> (Graph, Catalog) {
    let mut graph = serde_json::from_str(include_str!(
        "../../../spikes/executor-identity/native/fastp-fastqc.somite.json"
    ))
    .expect("paired graph fixture");
    let mut catalog = Catalog::default();
    for raw in [
        include_str!("../../../spikes/executor-identity/native/operators/files.import_paired.json"),
        include_str!("../../../spikes/executor-identity/native/operators/qc.fastp.json"),
        include_str!("../../../spikes/executor-identity/native/operators/qc.fastqc_paired.json"),
    ] {
        let operator: Operator = serde_json::from_str(raw).expect("operator fixture");
        catalog.ops.insert(operator.id.clone(), operator);
    }
    catalog.pin_graph(&mut graph).expect("pin paired graph");
    (graph, catalog)
}

#[test]
fn compiles_paired_fastp_fastqc_to_the_golden_workflow() {
    let (graph, catalog) = paired_fixture();
    let compiled = compile(&graph, &catalog, &options()).expect("compile paired graph");

    assert_eq!(compiled.main_nf, include_str!("golden/paired-main.nf"));
    assert!(compiled.nextflow_config.contains("cache = 'deep'"));
    assert!(compiled
        .nextflow_config
        .contains("file = '.somite/trace.tsv'"));
    assert!(compiled
        .nextflow_config
        .contains("fields = 'name,status,exit,hash'"));
    assert!(compiled.main_nf.contains("Somite: empty output"));
    assert!(compiled.main_nf.contains("gzip -t --"));
    assert!(compiled.pixi_toml.contains("nextflow = \"==26.04.4\""));
    assert!(compiled.pixi_toml.contains("openjdk = \"==17.0.17\""));
    assert!(compiled
        .pixi_toml
        .contains("nextflow run main.nf -params-file params.json -resume"));
    assert!(compiled.params_json.contains("fixtures/paired_R1.fastq"));
    let node_map: serde_json::Value =
        serde_json::from_str(&compiled.node_map_json).expect("node map JSON");
    let mapped_nodes = node_map["nodes"]
        .as_object()
        .expect("mapped nodes")
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let graph_nodes = graph
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(mapped_nodes, graph_nodes);
    let mut mapped_edges: Vec<somite_ir::Edge> =
        serde_json::from_value(node_map["edges"].clone()).expect("mapped edges");
    mapped_edges.sort_by(|left, right| left.id.cmp(&right.id));
    let mut graph_edges = graph.edges.clone();
    graph_edges.sort_by(|left, right| left.id.cmp(&right.id));
    assert_eq!(mapped_edges, graph_edges);
}

#[test]
fn hostile_values_remain_json_data_and_bash_env_values() {
    let (mut graph, mut catalog) = paired_fixture();
    let hostile = "reads/'\" $(touch SHOULD_NOT_EXIST)\nR1.fastq";
    graph.nodes[0]
        .params
        .insert("r1".into(), ParamValue::String(hostile.into()));
    graph.nodes[1].params.insert(
        "threads".into(),
        ParamValue::String("1; touch SHOULD_NOT_EXIST".into()),
    );
    catalog
        .ops
        .get_mut("qc.fastp")
        .expect("fastp")
        .params
        .get_mut("threads")
        .expect("threads")
        .ty = "string".into();
    graph.nodes[1].operator_revision = catalog.revision("qc.fastp").unwrap();
    let mut hostile_options = options();
    hostile_options.output_dir = "results/'\" $(touch ALSO_NOT)".into();

    let compiled = compile(&graph, &catalog, &hostile_options).expect("compile hostile data");

    assert!(compiled.params_json.contains("SHOULD_NOT_EXIST"));
    assert!(compiled.params_json.contains("\\nR1.fastq"));
    assert!(!compiled.main_nf.contains("SHOULD_NOT_EXIST"));
    assert!(!compiled.main_nf.contains("ALSO_NOT"));
    assert!(compiled.main_nf.contains("argv=("));
    assert!(compiled.main_nf.contains("script:\n    '''"));
    assert!(compiled.main_nf.contains("\"${SOMITE_PARAM_"));
    assert!(compiled.main_nf.contains("\"${argv[@]}\""));
}

#[test]
fn rejects_unsupported_execution_honestly() {
    let (graph, mut catalog) = paired_fixture();

    let reference = Operator {
        id: "reference".into(),
        title: "Reference".into(),
        palette: vec![],
        kind: OpKind::Reference,
        cost: somite_ops::Cost::Low,
        bin: None,
        pixi: vec![],
        params: BTreeMap::new(),
        ports: Default::default(),
        argv: vec![],
        outputs: BTreeMap::new(),
    };
    catalog.ops.insert(reference.id.clone(), reference.clone());
    let mut rejected = graph.clone();
    rejected.nodes[1].operator = "reference".into();
    rejected.nodes[1].operator_revision = reference.revision().unwrap();
    assert!(matches!(
        compile(&rejected, &catalog, &options()),
        Err(CompileError::ReferenceNode { .. })
    ));

    let mut inprocess_catalog = catalog.clone();
    let mut unsupported = inprocess_catalog.ops["files.import_paired"].clone();
    unsupported.id = "sheet.rnaseq".into();
    inprocess_catalog
        .ops
        .insert(unsupported.id.clone(), unsupported.clone());
    let mut inprocess_graph = graph.clone();
    inprocess_graph.nodes[0].operator = unsupported.id.clone();
    inprocess_graph.nodes[0].operator_revision = unsupported.revision().unwrap();
    assert!(matches!(
        compile(&inprocess_graph, &inprocess_catalog, &options()),
        Err(CompileError::UnsupportedInprocess { .. })
    ));

    for binary in ["nextflow", "snakemake"] {
        let mut nested_catalog = catalog.clone();
        let mut nested = nested_catalog.ops["qc.fastp"].clone();
        nested.id = format!("nested.{binary}");
        nested.bin = Some(binary.into());
        nested.argv[0] = binary.into();
        nested_catalog.ops.insert(nested.id.clone(), nested.clone());
        let mut nested_graph = graph.clone();
        nested_graph.nodes[1].operator = nested.id.clone();
        nested_graph.nodes[1].operator_revision = nested.revision().unwrap();
        assert!(matches!(
            compile(&nested_graph, &nested_catalog, &options()),
            Err(CompileError::NestedEngine { .. })
        ));
    }

    let mut invalid_parameter = graph.clone();
    invalid_parameter.nodes[1]
        .params
        .insert("threads".into(), ParamValue::String("four".into()));
    assert!(matches!(
        compile(&invalid_parameter, &catalog, &options()),
        Err(CompileError::InvalidParameter { .. })
    ));

    let mut excluded_catalog = catalog.clone();
    excluded_catalog
        .ops
        .get_mut("qc.fastp")
        .expect("fastp")
        .outputs
        .get_mut("r1")
        .expect("r1 output")
        .exclude
        .push("ignored.fastq.gz".into());
    let mut excluded_graph = graph.clone();
    excluded_graph.nodes[1].operator_revision = excluded_catalog.revision("qc.fastp").unwrap();
    assert!(matches!(
        compile(&excluded_graph, &excluded_catalog, &options()),
        Err(CompileError::InvalidOutput { .. })
    ));

    let mut indirect_catalog = catalog.clone();
    let mut indirect = indirect_catalog.ops["qc.fastp"].clone();
    indirect.id = "nested.indirect".into();
    indirect.bin = Some("env".into());
    indirect.argv = vec!["env".into(), "nextflow".into()];
    indirect_catalog
        .ops
        .insert(indirect.id.clone(), indirect.clone());
    let mut indirect_graph = graph;
    indirect_graph.nodes[1].operator = indirect.id.clone();
    indirect_graph.nodes[1].operator_revision = indirect.revision().unwrap();
    assert!(matches!(
        compile(&indirect_graph, &indirect_catalog, &options()),
        Err(CompileError::NestedEngine { .. })
    ));
}
