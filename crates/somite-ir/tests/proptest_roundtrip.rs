use proptest::prelude::*;
use somite_ir::{Direction, Graph, Layout, Node, Port, PortType, SCHEMA_VERSION};

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
                layout: Layout { x: i as f32, y: 0.0 },
                note: None,
            })
            .collect();
        let g = Graph {
            schema_version: SCHEMA_VERSION,
            name: None,
            nodes,
            edges: vec![],
        };
        g.validate().unwrap();
        let s = serde_json::to_string(&g).unwrap();
        let h: Graph = serde_json::from_str(&s).unwrap();
        prop_assert_eq!(g.nodes.len(), h.nodes.len());
        h.validate().unwrap();
    }
}
