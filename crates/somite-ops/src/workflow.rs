//! Import engine-authored workflow graphs without pretending their processes are
//! already standalone Somite executables.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use somite_ir::{Direction, Edge, Graph, Layout, Node, ParamValue, Port, PortType, SCHEMA_VERSION};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DotFlavor {
    Nextflow,
    Snakemake,
}

#[derive(Clone, Debug)]
struct DotNode {
    label: String,
    component: bool,
}

pub fn graph_from_dot(
    flavor: DotFlavor,
    workflow: &str,
    revision: &str,
    reference_operator_revision: &str,
    dot: &str,
) -> Result<Graph, String> {
    let mut dot_nodes = BTreeMap::<String, DotNode>::new();
    let mut dot_edges = Vec::<(String, String)>::new();
    for line in dot.lines().map(str::trim) {
        if let Some((left, right)) = line.split_once("->") {
            let from = left.trim().trim_matches('"').to_owned();
            let to = right
                .split(['[', ';'])
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches('"')
                .to_owned();
            if !from.is_empty() && !to.is_empty() {
                dot_edges.push((from, to));
            }
            continue;
        }
        let Some(open) = line.find('[') else { continue };
        let id = line[..open].trim().trim_matches('"');
        let attributes = line[open + 1..].trim_end_matches(';').trim_end_matches(']');
        let Some(label) = quoted_attribute(attributes, "label") else {
            continue;
        };
        let component = match flavor {
            DotFlavor::Nextflow => {
                !attributes.contains("shape=point")
                    && !attributes.contains("shape = point")
                    && !attributes.contains("shape=circle")
                    && !attributes.contains("shape = circle")
                    && !label.is_empty()
            }
            DotFlavor::Snakemake => !label.is_empty(),
        };
        dot_nodes.insert(id.to_owned(), DotNode { label, component });
    }

    let components = dot_nodes
        .iter()
        .filter_map(|(id, node)| node.component.then_some(id.clone()))
        .collect::<BTreeSet<_>>();
    if components.is_empty() {
        return Err("workflow graph did not contain any process or rule nodes".to_owned());
    }
    let adjacency = adjacency(&dot_edges);
    let component_edges = match flavor {
        DotFlavor::Nextflow => collapse_intermediates(&components, &adjacency),
        DotFlavor::Snakemake => dot_edges
            .into_iter()
            .filter(|(from, to)| components.contains(from) && components.contains(to))
            .collect(),
    };
    build_graph(
        workflow,
        revision,
        reference_operator_revision,
        flavor,
        dot_nodes,
        components,
        component_edges,
    )
}

/// Upgrade structural graphs created before typed Nextflow read boundaries
/// were introduced. Existing connections to a generic boundary input are left
/// untouched so loading a project never invalidates a previously valid graph.
pub fn upgrade_reference_ports(graph: &mut Graph) -> usize {
    let nextflow_references = graph
        .nodes
        .iter()
        .filter(|node| {
            node.operator == "workflow.reference"
                && matches!(
                    node.params.get("engine"),
                    Some(ParamValue::String(engine)) if engine == "nextflow"
                )
        })
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let internal_targets = graph
        .edges
        .iter()
        .filter(|edge| {
            nextflow_references.contains(&edge.from_node)
                && nextflow_references.contains(&edge.to_node)
        })
        .map(|edge| edge.to_node.clone())
        .collect::<BTreeSet<_>>();
    let bound_generic_inputs = graph
        .edges
        .iter()
        .filter(|edge| edge.to_port == "in")
        .map(|edge| edge.to_node.clone())
        .collect::<BTreeSet<_>>();

    let mut upgraded = 0;
    for node in &mut graph.nodes {
        if !nextflow_references.contains(&node.id)
            || internal_targets.contains(&node.id)
            || bound_generic_inputs.contains(&node.id)
            || node.port("r1", Direction::In).is_some()
        {
            continue;
        }
        let Some(ParamValue::String(component)) = node.params.get("component") else {
            continue;
        };
        if accepts_reads(component) {
            node.ports = component_ports(DotFlavor::Nextflow, component, true, 0);
            upgraded += 1;
        }
    }
    upgraded
}

fn quoted_attribute(attributes: &str, key: &str) -> Option<String> {
    let index = attributes.find(key)? + key.len();
    let tail = attributes[index..].trim_start();
    let tail = tail.strip_prefix('=')?.trim_start();
    let tail = tail.strip_prefix('"')?;
    let mut escaped = false;
    let mut value = String::new();
    for character in tail.chars() {
        if escaped {
            value.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            return Some(value);
        } else {
            value.push(character);
        }
    }
    None
}

fn adjacency(edges: &[(String, String)]) -> BTreeMap<String, Vec<String>> {
    let mut result = BTreeMap::<String, Vec<String>>::new();
    for (from, to) in edges {
        result.entry(from.clone()).or_default().push(to.clone());
    }
    result
}

fn collapse_intermediates(
    components: &BTreeSet<String>,
    adjacency: &BTreeMap<String, Vec<String>>,
) -> Vec<(String, String)> {
    let mut result = BTreeSet::new();
    for source in components {
        let mut queue = VecDeque::from_iter(adjacency.get(source).into_iter().flatten().cloned());
        let mut visited = BTreeSet::new();
        while let Some(next) = queue.pop_front() {
            if !visited.insert(next.clone()) {
                continue;
            }
            if components.contains(&next) {
                if &next != source {
                    result.insert((source.clone(), next));
                }
                continue;
            }
            queue.extend(adjacency.get(&next).into_iter().flatten().cloned());
        }
    }
    result.into_iter().collect()
}

fn build_graph(
    workflow: &str,
    revision: &str,
    reference_operator_revision: &str,
    flavor: DotFlavor,
    dot_nodes: BTreeMap<String, DotNode>,
    components: BTreeSet<String>,
    component_edges: Vec<(String, String)>,
) -> Result<Graph, String> {
    let mut ids = BTreeMap::new();
    let mut used = BTreeSet::new();
    for dot_id in &components {
        let label = &dot_nodes[dot_id].label;
        let base = safe_id(label.rsplit(':').next().unwrap_or(label));
        let mut id = base.clone();
        let mut suffix = 2;
        while !used.insert(id.clone()) {
            id = format!("{base}-{suffix}");
            suffix += 1;
        }
        ids.insert(dot_id.clone(), id);
    }
    let ranks = ranks(&components, &component_edges);
    let incoming_counts = component_edges.iter().fold(
        BTreeMap::<String, usize>::new(),
        |mut counts, (_, target)| {
            *counts.entry(target.clone()).or_default() += 1;
            counts
        },
    );
    let targets = component_edges
        .iter()
        .map(|(_, target)| target.as_str())
        .collect::<BTreeSet<_>>();
    let mut rows = BTreeMap::<usize, usize>::new();
    let mut nodes = Vec::new();
    for dot_id in &components {
        let rank = *ranks.get(dot_id).unwrap_or(&0);
        let row = rows.entry(rank).or_default();
        let label = dot_nodes[dot_id].label.clone();
        nodes.push(Node {
            id: ids[dot_id].clone(),
            operator: "workflow.reference".to_owned(),
            operator_revision: reference_operator_revision.to_owned(),
            ports: component_ports(
                flavor,
                &label,
                !targets.contains(dot_id.as_str()),
                *incoming_counts.get(dot_id).unwrap_or(&0),
            ),
            params: BTreeMap::from([
                (
                    "engine".to_owned(),
                    ParamValue::String(
                        match flavor {
                            DotFlavor::Nextflow => "nextflow",
                            DotFlavor::Snakemake => "snakemake",
                        }
                        .to_owned(),
                    ),
                ),
                (
                    "workflow".to_owned(),
                    ParamValue::String(workflow.to_owned()),
                ),
                (
                    "revision".to_owned(),
                    ParamValue::String(revision.to_owned()),
                ),
                ("component".to_owned(), ParamValue::String(label.clone())),
            ]),
            layout: Layout {
                x: rank as f32 * 280.0,
                y: *row as f32 * 150.0,
            },
            note: Some(format!("Imported from {workflow}@{revision} · {label}")),
        });
        *row += 1;
    }
    let mut input_slots = BTreeMap::<String, usize>::new();
    let edges = component_edges
        .into_iter()
        .filter_map(|(from, to)| {
            let from_node = ids.get(&from)?.clone();
            let to_node = ids.get(&to)?.clone();
            let input_slot = input_slots.entry(to_node.clone()).or_default();
            let to_port = if *input_slot == 0 {
                "in".to_owned()
            } else {
                format!("in_{}", *input_slot + 1)
            };
            *input_slot += 1;
            Some(Edge {
                id: format!("e-{from_node}-out-{to_node}-{to_port}"),
                from_node,
                from_port: "out".to_owned(),
                to_node,
                to_port,
            })
        })
        .collect();
    let graph = Graph {
        schema_version: SCHEMA_VERSION,
        name: None,
        nodes,
        edges,
    };
    graph.validate().map_err(|error| error.to_string())?;
    Ok(graph)
}

fn component_ports(
    _flavor: DotFlavor,
    label: &str,
    boundary: bool,
    incoming_count: usize,
) -> Vec<Port> {
    let mut ports = if boundary && accepts_reads(label) {
        vec![
            Port {
                name: "r1".to_owned(),
                dir: Direction::In,
                ty: PortType::Fastq,
                union: vec![PortType::FastqGz],
                optional: false,
            },
            Port {
                name: "r2".to_owned(),
                dir: Direction::In,
                ty: PortType::Fastq,
                union: vec![PortType::FastqGz],
                optional: true,
            },
        ]
    } else {
        (0..incoming_count.max(1))
            .map(|index| Port {
                name: if index == 0 {
                    "in".to_owned()
                } else {
                    format!("in_{}", index + 1)
                },
                dir: Direction::In,
                ty: PortType::Directory,
                union: Vec::new(),
                optional: true,
            })
            .collect()
    };
    ports.push(Port {
        name: "out".to_owned(),
        dir: Direction::Out,
        ty: PortType::Directory,
        union: Vec::new(),
        optional: true,
    });
    ports
}

fn accepts_reads(label: &str) -> bool {
    let component = label
        .rsplit(':')
        .next()
        .unwrap_or(label)
        .to_ascii_uppercase();
    [
        "FASTQ",
        "FASTQC",
        "FASTP",
        "FQ_",
        "TRIMGALORE",
        "CUTADAPT",
        "BBSPLIT",
        "PORECHOP",
        "NANOPLOT",
        "FILTLONG",
        "CHOPPER",
        "UMITOOLS",
        "SEQKIT",
        "ALIGN",
    ]
    .iter()
    .any(|marker| component.contains(marker))
}

fn ranks(nodes: &BTreeSet<String>, edges: &[(String, String)]) -> BTreeMap<String, usize> {
    let mut indegree = nodes
        .iter()
        .map(|node| (node.clone(), 0usize))
        .collect::<BTreeMap<_, _>>();
    let adjacent = adjacency(edges);
    for (_, to) in edges {
        *indegree.entry(to.clone()).or_default() += 1;
    }
    let mut queue = VecDeque::from_iter(
        indegree
            .iter()
            .filter_map(|(node, degree)| (*degree == 0).then_some(node.clone())),
    );
    let mut rank = BTreeMap::new();
    while let Some(node) = queue.pop_front() {
        let source_rank = *rank.get(&node).unwrap_or(&0);
        for target in adjacent.get(&node).into_iter().flatten() {
            let target_rank = rank.entry(target.clone()).or_default();
            *target_rank = (*target_rank).max(source_rank + 1);
            if let Some(degree) = indegree.get_mut(target) {
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target.clone());
                }
            }
        }
    }
    rank
}

fn safe_id(label: &str) -> String {
    let id = label
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let compact = id
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if compact.is_empty() {
        "component".to_owned()
    } else {
        compact
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nextflow_channels_are_collapsed_between_processes() {
        let dot = r#"digraph workflow {
          v1 [label="PIPE:FASTQC"];
          v2 [shape=circle,label="",xlabel="map"];
          v3 [shape=point];
          v4 [label="PIPE:TRIMGALORE"];
          v1 -> v2;
          v2 -> v3;
          v3 -> v4 [label="reads"];
        }"#;
        let graph = graph_from_dot(
            DotFlavor::Nextflow,
            "nf-core/demo",
            "1.2.3",
            "test-revision",
            dot,
        )
        .expect("graph");
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].from_node, "fastqc");
        assert_eq!(graph.edges[0].to_node, "trimgalore");
    }

    #[test]
    fn snakemake_rulegraph_keeps_rules_and_dependencies() {
        let dot = r#"digraph snakemake_dag {
          0[label = "all", color = "0.1 0.6 0.85"];
          1[label = "align reads", color = "0.2 0.6 0.85"];
          1 -> 0
        }"#;
        let graph = graph_from_dot(
            DotFlavor::Snakemake,
            "owner/workflow",
            "v1",
            "test-revision",
            dot,
        )
        .expect("graph");
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].from_node, "align-reads");
        assert_eq!(graph.edges[0].to_node, "all");
    }

    #[test]
    fn workflow_fan_in_gets_one_scalar_port_per_dependency() {
        let dot = r#"digraph snakemake_dag {
          0[label = "prepare_a"];
          1[label = "prepare_b"];
          2[label = "all"];
          0 -> 2
          1 -> 2
        }"#;
        let graph = graph_from_dot(
            DotFlavor::Snakemake,
            "owner/workflow",
            "v1",
            "test-revision",
            dot,
        )
        .expect("graph");
        let target = graph.node("all").expect("target rule");
        assert!(target.port("in", Direction::In).is_some());
        assert!(target.port("in_2", Direction::In).is_some());
        assert_eq!(
            graph
                .edges
                .iter()
                .map(|edge| edge.to_port.as_str())
                .collect::<Vec<_>>(),
            vec!["in", "in_2"]
        );
    }

    #[test]
    fn nfcore_read_entry_process_accepts_separate_fastq_mates_only_at_the_boundary() {
        let dot = r#"digraph workflow {
          v0 [shape=point,label="",fixedsize=true,width=0.1,xlabel="channel.fromPath"];
          v1 [label="PIPE:READ_QC:CAT_FASTQ"];
          v2 [shape=circle,label="",fixedsize=true,width=0.1,xlabel="map"];
          v3 [label="PIPE:READ_QC:FASTQC"];
          v0 -> v1 [label="ch_reads"];
          v1 -> v2;
          v2 -> v3;
        }"#;
        let graph = graph_from_dot(
            DotFlavor::Nextflow,
            "nf-core/demo",
            "1.2.3",
            "test-revision",
            dot,
        )
        .expect("graph");
        let entry = graph.node("cat-fastq").expect("read entry");
        let r1 = entry.port("r1", Direction::In).expect("r1 input");
        let r2 = entry.port("r2", Direction::In).expect("r2 input");
        assert!(somite_ir::compatible(PortType::Fastq, r1.ty, &r1.union));
        assert!(somite_ir::compatible(PortType::FastqGz, r1.ty, &r1.union));
        assert!(r2.optional);

        let downstream = graph.node("fastqc").expect("downstream process");
        let input = downstream
            .port("in", Direction::In)
            .expect("internal input");
        assert!(!somite_ir::compatible(
            PortType::Fastq,
            input.ty,
            &input.union
        ));
    }

    #[test]
    fn old_nextflow_reference_graphs_gain_typed_read_boundaries_on_load() {
        let dot = r#"digraph workflow {
          v0 [shape=point,label=""];
          v1 [label="PIPE:READ_QC:CAT_FASTQ"];
          v2 [label="PIPE:READ_QC:FASTQC"];
          v0 -> v1;
          v1 -> v2;
        }"#;
        let mut graph = graph_from_dot(
            DotFlavor::Nextflow,
            "nf-core/demo",
            "1.2.3",
            "test-revision",
            dot,
        )
        .expect("graph");
        graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "cat-fastq")
            .expect("boundary")
            .ports = component_ports(DotFlavor::Nextflow, "generic", false, 1);

        assert_eq!(upgrade_reference_ports(&mut graph), 1);
        assert!(graph
            .node("cat-fastq")
            .expect("boundary")
            .port("r1", Direction::In)
            .is_some());
        assert!(graph
            .node("fastqc")
            .expect("internal")
            .port("r1", Direction::In)
            .is_none());
        graph.validate().expect("migrated graph remains valid");
    }
}
