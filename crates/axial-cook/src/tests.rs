use std::collections::BTreeMap;
use std::path::PathBuf;

use axial_ir::{Direction, Graph, Layout, Node, ParamValue, Port, PortType, SCHEMA_VERSION};
use axial_ops::Catalog;
use tempfile::tempdir;

use crate::{cook_graph, NodeState, Project};

#[test]
fn import_then_skip() {
    let dir = tempdir().unwrap();
    let testdata = dir.path().join("testdata");
    std::fs::create_dir(&testdata).unwrap();
    std::fs::write(testdata.join("t.fastq"), b"@s\nACGT\n+\nIIII\n").unwrap();
    let ops = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators");
    let cat = Catalog::load_dir(&ops).unwrap();
    assert!(cat.get("files.import").is_ok());
    let g = Graph {
        schema_version: SCHEMA_VERSION,
        nodes: vec![Node {
            id: "n1".into(),
            operator: "files.import".into(),
            ports: vec![Port {
                name: "file".into(),
                dir: Direction::Out,
                ty: PortType::Fastq,
                union: vec![],
                optional: false,
            }],
            params: {
                let mut m = BTreeMap::new();
                m.insert("path".into(), ParamValue::String("testdata/t.fastq".into()));
                m
            },
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
        }],
        edges: vec![],
    };
    g.validate().unwrap();
    let proj = Project::open(dir.path()).unwrap();
    let s1 = cook_graph(&proj, &cat, &g).unwrap();
    assert_eq!(s1.states.get("n1"), Some(&NodeState::Done));
    assert!(s1.artifacts.get("n1").unwrap().contains_key("file"));
    let s2 = cook_graph(&proj, &cat, &g).unwrap();
    assert_eq!(s2.states.get("n1"), Some(&NodeState::Cached));
}

#[test]
fn unbound_required_input_is_skipped() {
    let dir = tempdir().unwrap();
    let ops = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators");
    let cat = Catalog::load_dir(&ops).unwrap();
    let op = cat.get("qc.fastqc").unwrap();
    let g = Graph {
        schema_version: SCHEMA_VERSION,
        nodes: vec![Node {
            id: "fastqc1".into(),
            operator: "qc.fastqc".into(),
            ports: op.ir_ports(),
            params: BTreeMap::new(),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
        }],
        edges: vec![],
    };
    g.validate().unwrap();
    let proj = Project::open(dir.path()).unwrap();
    let r = cook_graph(&proj, &cat, &g).unwrap();
    assert_eq!(r.states.get("fastqc1"), Some(&NodeState::Skipped));
}

#[test]
fn import_then_rnaseq_sheet() {
    let dir = tempdir().unwrap();
    let testdata = dir.path().join("testdata");
    std::fs::create_dir(&testdata).unwrap();
    std::fs::write(testdata.join("t.fastq"), b"@s\nACGT\n+\nIIII\n").unwrap();
    let ops = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators");
    let cat = Catalog::load_dir(&ops).unwrap();
    let imp = cat.get("files.import").unwrap();
    let sh = cat.get("sheet.rnaseq").unwrap();
    let g = Graph {
        schema_version: SCHEMA_VERSION,
        nodes: vec![
            Node {
                id: "import1".into(),
                operator: "files.import".into(),
                ports: imp.ir_ports(),
                params: {
                    let mut m = BTreeMap::new();
                    m.insert("path".into(), ParamValue::String("testdata/t.fastq".into()));
                    m
                },
                layout: Layout { x: 0.0, y: 0.0 },
                note: None,
            },
            Node {
                id: "sheet1".into(),
                operator: "sheet.rnaseq".into(),
                ports: sh.ir_ports(),
                params: BTreeMap::new(),
                layout: Layout { x: 200.0, y: 0.0 },
                note: None,
            },
        ],
        edges: vec![axial_ir::Edge {
            id: "e1".into(),
            from_node: "import1".into(),
            from_port: "file".into(),
            to_node: "sheet1".into(),
            to_port: "r1".into(),
        }],
    };
    g.validate().unwrap();
    let proj = Project::open(dir.path()).unwrap();
    let r = cook_graph(&proj, &cat, &g).unwrap();
    assert_eq!(r.states.get("import1"), Some(&NodeState::Done));
    assert_eq!(r.states.get("sheet1"), Some(&NodeState::Done));
    let meta = r.artifacts.get("sheet1").unwrap().get("sheet").unwrap();
    assert_eq!(meta.declared_type, PortType::Table);
    let csv = std::fs::read_to_string(proj.cas_path(&meta.hash)).unwrap();
    assert!(csv.contains("sample,fastq_1,fastq_2,strandedness"), "{csv}");
    assert!(csv.contains("t.fastq"), "{csv}");
    assert!(csv.contains("sample1"), "{csv}");
}

#[test]
fn directory_inputs_are_staged_as_writable_copies() {
    let dir = tempdir().unwrap();
    let workflow = dir.path().join("workflow-project");
    std::fs::create_dir(&workflow).unwrap();
    std::fs::write(workflow.join("Snakefile"), b"rule all:\n    input: []\n").unwrap();

    let project = Project::open(dir.path()).unwrap();
    let (_hash, meta) = project.put_dir(&workflow, PortType::Directory).unwrap();
    let staged = project.stage(&meta, &dir.path().join("stage")).unwrap();
    std::fs::write(staged.join("results.txt"), b"complete\n").unwrap();

    assert!(staged.join("results.txt").is_file());
    assert!(!project.cas_path(&meta.hash).join("results.txt").exists());
}

#[test]
fn imports_a_workflow_directory_as_a_typed_artifact() {
    let dir = tempdir().unwrap();
    let workflow = dir.path().join("workflow-project");
    std::fs::create_dir(&workflow).unwrap();
    std::fs::write(workflow.join("Snakefile"), b"rule all:\n    input: []\n").unwrap();
    let ops = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../operators");
    let catalog = Catalog::load_dir(&ops).unwrap();
    let operator = catalog.get("files.import_directory").unwrap();
    let graph = Graph {
        schema_version: SCHEMA_VERSION,
        nodes: vec![Node {
            id: "workflow1".into(),
            operator: operator.id.clone(),
            ports: operator.ir_ports(),
            params: BTreeMap::from([(
                "path".into(),
                ParamValue::String(workflow.display().to_string()),
            )]),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
        }],
        edges: vec![],
    };

    let project = Project::open(dir.path()).unwrap();
    let report = cook_graph(&project, &catalog, &graph).unwrap();
    let artifact = &report.artifacts["workflow1"]["directory"];
    assert_eq!(artifact.declared_type, PortType::Directory);
    assert!(project.cas_path(&artifact.hash).join("Snakefile").is_file());
}
