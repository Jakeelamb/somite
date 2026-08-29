use proptest::prelude::*;
use somite_ir::{
    Direction, Graph, Layout, Node, ParamValue, Port, PortType, MAX_EXACT_JSON_INTEGER,
    MIN_EXACT_JSON_INTEGER, SCHEMA_VERSION,
};

proptest! {
    #[test]
    fn isolated_nodes_roundtrip(n in 0usize..8) {
        let nodes: Vec<Node> = (0..n)
            .map(|i| Node {
                id: format!("n_{i:032x}"),
                operator: "files.import".into(),
                operator_revision: "test-revision".into(),
                ports: vec![Port {
                    name: "out".into(),
                    dir: Direction::Out,
                    ty: PortType::Text,
                    union: vec![],
                    optional: false,
                }],
                params: Default::default(),
                source_workflow: None,
                layout: Layout { x: i as f32, y: 0.0 },
                note: None,
                color: None,
            })
            .collect();
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes,
            edges: vec![],
            annotations: vec![],
            variant_origin: None,
        };
        g.validate().unwrap();
        let s = serde_json::to_string(&g).unwrap();
        let h: Graph = serde_json::from_str(&s).unwrap();
        prop_assert_eq!(g.nodes.len(), h.nodes.len());
        h.validate().unwrap();
    }

    #[test]
    fn safe_integral_floats_canonicalize_to_exact_json_integers(
        value in MIN_EXACT_JSON_INTEGER..=MAX_EXACT_JSON_INTEGER,
    ) {
        let canonical = ParamValue::from_f64(value as f64);
        prop_assert_eq!(canonical, Some(ParamValue::Int(value)));
    }
}
