//! Pure canvas interaction primitives.
//!
//! The native UI owns pointer recognition and drawing. This module owns the
//! small, testable seam where gestures become graph edits or viewport changes.

use std::collections::BTreeSet;

use axial_ir::{compatible, Direction, Edge, Graph, IrError, Port};
use eframe::egui::{Pos2, Vec2};

const HISTORY_LIMIT: usize = 96;
pub(crate) const GRID_STEP: f32 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SnapSource {
    Grid,
    Node,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SnapGuide {
    pub(crate) coordinate: f32,
    pub(crate) source: SnapSource,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct SnapGuides {
    pub(crate) x: Option<SnapGuide>,
    pub(crate) y: Option<SnapGuide>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct DragSnap {
    pub(crate) delta: Vec2,
    pub(crate) guides: SnapGuides,
}

fn axis_snap(
    moving_min: f32,
    moving_size: f32,
    stationary: impl Iterator<Item = (f32, f32)>,
    grid_step: f32,
    alignment_threshold: f32,
    grid_threshold: f32,
) -> (f32, Option<SnapGuide>) {
    let moving_anchors = [
        moving_min,
        moving_min + moving_size * 0.5,
        moving_min + moving_size,
    ];
    let mut best_alignment: Option<(f32, f32)> = None;
    for (stationary_min, stationary_size) in stationary {
        let stationary_anchors = [
            stationary_min,
            stationary_min + stationary_size * 0.5,
            stationary_min + stationary_size,
        ];
        for (moving, target) in moving_anchors.into_iter().zip(stationary_anchors) {
            let correction = target - moving;
            if correction.abs() <= alignment_threshold
                && best_alignment.is_none_or(|(best, _)| correction.abs() < best.abs())
            {
                best_alignment = Some((correction, target));
            }
        }
    }
    if let Some((correction, target)) = best_alignment {
        return (
            correction,
            Some(SnapGuide {
                coordinate: target,
                source: SnapSource::Node,
            }),
        );
    }

    let grid_target = (moving_min / grid_step).round() * grid_step;
    let correction = grid_target - moving_min;
    if correction.abs() <= grid_threshold {
        return (
            correction,
            Some(SnapGuide {
                coordinate: grid_target,
                source: SnapSource::Grid,
            }),
        );
    }
    (0.0, None)
}

/// Magnetize a moving node to neighboring node edges/centers, then to the
/// canvas lattice. Thresholds are supplied in graph units so the caller can
/// keep the interaction distance visually stable at every zoom level.
pub(crate) fn snap_drag(
    anchor: eframe::egui::Rect,
    raw_delta: Vec2,
    stationary: &[eframe::egui::Rect],
    alignment_threshold: f32,
    grid_threshold: f32,
) -> DragSnap {
    let moved = anchor.translate(raw_delta);
    let (x_correction, x) = axis_snap(
        moved.min.x,
        moved.width(),
        stationary.iter().map(|rect| (rect.min.x, rect.width())),
        GRID_STEP,
        alignment_threshold,
        grid_threshold,
    );
    let (y_correction, y) = axis_snap(
        moved.min.y,
        moved.height(),
        stationary.iter().map(|rect| (rect.min.y, rect.height())),
        GRID_STEP,
        alignment_threshold,
        grid_threshold,
    );
    DragSnap {
        delta: raw_delta + Vec2::new(x_correction, y_correction),
        guides: SnapGuides { x, y },
    }
}

pub(crate) fn snap_point_to_grid(point: Pos2) -> Pos2 {
    Pos2::new(
        (point.x / GRID_STEP).round() * GRID_STEP,
        (point.y / GRID_STEP).round() * GRID_STEP,
    )
}

/// egui reports drag motion one frame at a time. Preserve the full gesture so
/// snapping can be resolved against the geometry captured at drag start.
pub(crate) fn advance_drag_delta(accumulated: Vec2, frame_delta: Vec2) -> Vec2 {
    accumulated + frame_delta
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SelectionMode {
    Replace,
    Add,
    Toggle,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Selection {
    nodes: BTreeSet<String>,
    primary: Option<String>,
    edge: Option<String>,
}

impl Selection {
    pub(crate) fn primary(&self) -> Option<&str> {
        self.primary.as_deref()
    }

    pub(crate) fn edge(&self) -> Option<&str> {
        self.edge.as_deref()
    }

    pub(crate) fn contains(&self, node: &str) -> bool {
        self.nodes.contains(node)
    }

    pub(crate) fn len(&self) -> usize {
        self.nodes.len()
    }

    pub(crate) fn nodes(&self) -> impl Iterator<Item = &str> {
        self.nodes.iter().map(String::as_str)
    }

    pub(crate) fn clear(&mut self) {
        self.nodes.clear();
        self.primary = None;
        self.edge = None;
    }

    pub(crate) fn select_edge(&mut self, edge: impl Into<String>) {
        self.nodes.clear();
        self.primary = None;
        self.edge = Some(edge.into());
    }

    pub(crate) fn select_node(&mut self, node: impl Into<String>, mode: SelectionMode) {
        let node = node.into();
        self.edge = None;
        match mode {
            SelectionMode::Replace => {
                self.nodes.clear();
                self.nodes.insert(node.clone());
                self.primary = Some(node);
            }
            SelectionMode::Add => {
                self.nodes.insert(node.clone());
                self.primary = Some(node);
            }
            SelectionMode::Toggle => {
                if self.nodes.remove(&node) {
                    if self.primary.as_deref() == Some(node.as_str()) {
                        self.primary = self.nodes.last().cloned();
                    }
                } else {
                    self.nodes.insert(node.clone());
                    self.primary = Some(node);
                }
            }
        }
    }

    pub(crate) fn select_many(
        &mut self,
        nodes: impl IntoIterator<Item = String>,
        mode: SelectionMode,
    ) {
        let item_mode = if mode == SelectionMode::Replace {
            SelectionMode::Add
        } else {
            mode
        };
        if mode == SelectionMode::Replace {
            self.clear();
        } else {
            self.edge = None;
        }
        for node in nodes {
            self.select_node(node, item_mode);
        }
    }

    pub(crate) fn retain_graph(&mut self, graph: &Graph) {
        self.nodes.retain(|id| graph.node(id).is_some());
        if self
            .primary
            .as_deref()
            .is_some_and(|id| !self.nodes.contains(id))
        {
            self.primary = self.nodes.last().cloned();
        }
        if self
            .edge
            .as_deref()
            .is_some_and(|id| !graph.edges.iter().any(|edge| edge.id == id))
        {
            self.edge = None;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WireStart {
    pub(crate) node: String,
    pub(crate) port: String,
    pub(crate) dir: Direction,
}

impl WireStart {
    pub(crate) fn new(node: impl Into<String>, port: impl Into<String>, dir: Direction) -> Self {
        Self {
            node: node.into(),
            port: port.into(),
            dir,
        }
    }

    pub(crate) fn accepts(&self, graph: &Graph, candidate: &Port) -> bool {
        let Some(source) = graph
            .node(&self.node)
            .and_then(|node| node.port(&self.port, self.dir))
        else {
            return false;
        };

        match (self.dir, candidate.dir) {
            (Direction::Out, Direction::In) => {
                compatible(source.ty, candidate.ty, &candidate.union)
            }
            (Direction::In, Direction::Out) => compatible(candidate.ty, source.ty, &source.union),
            _ => false,
        }
    }

    pub(crate) fn connection_to(
        &self,
        graph: &Graph,
        candidate_node: &str,
        candidate: &Port,
    ) -> Option<Connection> {
        if !self.accepts(graph, candidate) {
            return None;
        }
        Some(match self.dir {
            Direction::Out => {
                Connection::new(&self.node, &self.port, candidate_node, &candidate.name)
            }
            Direction::In => {
                Connection::new(candidate_node, &candidate.name, &self.node, &self.port)
            }
        })
    }

    pub(crate) fn best_connection_to(
        &self,
        graph: &Graph,
        candidate_node: &str,
        ports: &[Port],
    ) -> Option<Connection> {
        ports
            .iter()
            .find(|port| port.name == self.port)
            .and_then(|port| self.connection_to(graph, candidate_node, port))
            .or_else(|| {
                ports
                    .iter()
                    .find_map(|port| self.connection_to(graph, candidate_node, port))
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Connection {
    pub(crate) from_node: String,
    pub(crate) from_port: String,
    pub(crate) to_node: String,
    pub(crate) to_port: String,
}

impl Connection {
    pub(crate) fn new(
        from_node: impl Into<String>,
        from_port: impl Into<String>,
        to_node: impl Into<String>,
        to_port: impl Into<String>,
    ) -> Self {
        Self {
            from_node: from_node.into(),
            from_port: from_port.into(),
            to_node: to_node.into(),
            to_port: to_port.into(),
        }
    }
}

/// Replace a single occupied input only after the complete candidate graph
/// validates. A rejected snap therefore cannot destroy the previous wire.
pub(crate) fn connect(graph: &mut Graph, connection: &Connection) -> Result<bool, IrError> {
    let edge = Edge {
        id: format!(
            "e_{}_{}_{}_{}",
            connection.from_node, connection.from_port, connection.to_node, connection.to_port
        ),
        from_node: connection.from_node.clone(),
        from_port: connection.from_port.clone(),
        to_node: connection.to_node.clone(),
        to_port: connection.to_port.clone(),
    };
    let mut candidate = graph.clone();
    candidate.edges.retain(|existing| {
        !(existing.to_node == edge.to_node && existing.to_port == edge.to_port)
            && existing.id != edge.id
    });
    candidate.edges.push(edge);
    candidate.validate()?;
    if candidate.edges == graph.edges {
        return Ok(false);
    }
    graph.edges = candidate.edges;
    Ok(true)
}

/// A mate wire that should travel with a successful r1/r2 connection. This is
/// deliberately limited to identically named paired ports; other multi-input
/// tools remain fully manual.
pub(crate) fn paired_companion(graph: &Graph, connection: &Connection) -> Option<Connection> {
    let mate = match (connection.from_port.as_str(), connection.to_port.as_str()) {
        ("r1", "r1") => "r2",
        ("r2", "r2") => "r1",
        _ => return None,
    };
    let output = graph
        .node(&connection.from_node)?
        .port(mate, Direction::Out)?;
    let input = graph.node(&connection.to_node)?.port(mate, Direction::In)?;
    if graph.edges.iter().any(|edge| {
        edge.to_node == connection.to_node
            && edge.to_port == mate
            && (edge.from_node != connection.from_node || edge.from_port != mate)
    }) {
        return None;
    }
    compatible(output.ty, input.ty, &input.union)
        .then(|| Connection::new(&connection.from_node, mate, &connection.to_node, mate))
}

pub(crate) fn rename_node(graph: &mut Graph, old: &str, requested: &str) -> Result<bool, String> {
    let next = requested.trim();
    if next == old {
        return Ok(false);
    }
    if next.is_empty()
        || !next
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return Err("names use letters, numbers, _ or -".into());
    }
    if graph.node(next).is_some() {
        return Err(format!("node {next} already exists"));
    }

    let mut candidate = graph.clone();
    let Some(node) = candidate.nodes.iter_mut().find(|node| node.id == old) else {
        return Err(format!("node {old} no longer exists"));
    };
    node.id = next.into();
    for edge in &mut candidate.edges {
        if edge.from_node == old {
            edge.from_node = next.into();
        }
        if edge.to_node == old {
            edge.to_node = next.into();
        }
        edge.id = format!(
            "e_{}_{}_{}_{}",
            edge.from_node, edge.from_port, edge.to_node, edge.to_port
        );
    }
    candidate.validate().map_err(|error| error.to_string())?;
    *graph = candidate;
    Ok(true)
}

#[derive(Default)]
pub(crate) struct EditHistory {
    undo: Vec<Graph>,
    redo: Vec<Graph>,
}

impl EditHistory {
    pub(crate) fn remember(&mut self, graph: &Graph) {
        if self.undo.last() == Some(graph) {
            return;
        }
        self.undo.push(graph.clone());
        if self.undo.len() > HISTORY_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub(crate) fn undo(&mut self, graph: &mut Graph) -> bool {
        while let Some(previous) = self.undo.pop() {
            if previous != *graph {
                self.redo.push(std::mem::replace(graph, previous));
                return true;
            }
        }
        false
    }

    pub(crate) fn redo(&mut self, graph: &mut Graph) -> bool {
        while let Some(next) = self.redo.pop() {
            if next != *graph {
                self.undo.push(std::mem::replace(graph, next));
                return true;
            }
        }
        false
    }
}

/// Apply a zoom factor while keeping the graph point under `cursor` fixed.
pub(crate) fn zoom_about(
    pan: Vec2,
    zoom: f32,
    origin: Pos2,
    cursor: Pos2,
    factor: f32,
) -> (Vec2, f32) {
    let next = (zoom * factor).clamp(0.3, 2.8);
    if (next - zoom).abs() <= f32::EPSILON {
        return (pan, zoom);
    }
    let cursor_from_origin = cursor - origin;
    let scale = next / zoom;
    let next_pan = (pan - cursor_from_origin) * scale + cursor_from_origin;
    (next_pan, next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axial_ir::{Layout, Node, PortType, SCHEMA_VERSION};
    use std::collections::BTreeMap;

    fn port(name: &str, dir: Direction, ty: PortType) -> Port {
        Port {
            name: name.into(),
            dir,
            ty,
            union: Vec::new(),
            optional: false,
        }
    }

    fn node(id: &str, input: PortType, output: PortType) -> Node {
        Node {
            id: id.into(),
            operator: format!("test.{id}"),
            ports: vec![
                port("in", Direction::In, input),
                port("out", Direction::Out, output),
            ],
            params: BTreeMap::new(),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
        }
    }

    fn graph() -> Graph {
        Graph {
            schema_version: SCHEMA_VERSION,
            nodes: vec![
                node("a", PortType::Fastq, PortType::Fastq),
                node("b", PortType::Fastq, PortType::Fastq),
                node("c", PortType::Bam, PortType::Bam),
            ],
            edges: Vec::new(),
        }
    }

    #[test]
    fn rejected_rewire_preserves_the_previous_input() {
        let mut graph = graph();
        connect(&mut graph, &Connection::new("a", "out", "b", "in")).unwrap();
        let before = graph.edges.clone();

        assert!(connect(&mut graph, &Connection::new("c", "out", "b", "in")).is_err());
        assert_eq!(graph.edges, before);
    }

    #[test]
    fn continuation_only_offers_opposite_compatible_ports() {
        let graph = graph();
        let continuation = WireStart::new("a", "out", Direction::Out);
        let fastq_input = port("reads", Direction::In, PortType::Fastq);
        let bam_input = port("alignment", Direction::In, PortType::Bam);
        let fastq_output = port("reads", Direction::Out, PortType::Fastq);

        assert!(continuation.accepts(&graph, &fastq_input));
        assert!(!continuation.accepts(&graph, &bam_input));
        assert!(!continuation.accepts(&graph, &fastq_output));
    }

    #[test]
    fn matching_r1_connection_offers_an_r2_companion() {
        let paired = |id: &str, dir| Node {
            id: id.into(),
            operator: format!("test.{id}"),
            ports: vec![
                port("r1", dir, PortType::Fastq),
                port("r2", dir, PortType::Fastq),
            ],
            params: BTreeMap::new(),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
        };
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            nodes: vec![
                paired("reads", Direction::Out),
                paired("fastp", Direction::In),
            ],
            edges: Vec::new(),
        };

        assert_eq!(
            paired_companion(&graph, &Connection::new("reads", "r1", "fastp", "r1")),
            Some(Connection::new("reads", "r2", "fastp", "r2"))
        );
    }

    #[test]
    fn continuation_prefers_the_same_mate_name() {
        let paired = |id: &str, dir| Node {
            id: id.into(),
            operator: format!("test.{id}"),
            ports: vec![
                port("r1", dir, PortType::Fastq),
                port("r2", dir, PortType::Fastq),
            ],
            params: BTreeMap::new(),
            layout: Layout { x: 0.0, y: 0.0 },
            note: None,
        };
        let graph = Graph {
            schema_version: SCHEMA_VERSION,
            nodes: vec![
                paired("reads", Direction::Out),
                paired("fastp", Direction::In),
            ],
            edges: Vec::new(),
        };
        let continuation = WireStart::new("reads", "r2", Direction::Out);
        let target = graph.node("fastp").unwrap();

        assert_eq!(
            continuation.best_connection_to(&graph, "fastp", &target.ports),
            Some(Connection::new("reads", "r2", "fastp", "r2"))
        );
    }

    #[test]
    fn replacing_an_input_is_one_undoable_graph_change() {
        let mut graph = graph();
        connect(&mut graph, &Connection::new("a", "out", "b", "in")).unwrap();
        let mut history = EditHistory::default();
        history.remember(&graph);

        connect(&mut graph, &Connection::new("b", "out", "a", "in")).unwrap_err();
        assert!(!history.undo(&mut graph));

        graph.nodes[2].ports[1].ty = PortType::Fastq;
        history.remember(&graph);
        connect(&mut graph, &Connection::new("c", "out", "b", "in")).unwrap();
        assert!(history.undo(&mut graph));
        assert_eq!(graph.edges[0].from_node, "a");
        assert!(history.redo(&mut graph));
        assert_eq!(graph.edges[0].from_node, "c");
    }

    #[test]
    fn zoom_keeps_the_cursor_on_the_same_graph_point() {
        let origin = Pos2::new(200.0, 100.0);
        let cursor = Pos2::new(640.0, 430.0);
        let pan = Vec2::new(30.0, -20.0);
        let zoom = 0.8;
        let graph_before = (cursor - origin - pan) / zoom;

        let (next_pan, next_zoom) = zoom_about(pan, zoom, origin, cursor, 1.25);
        let graph_after = (cursor - origin - next_pan) / next_zoom;

        assert!((graph_before.x - graph_after.x).abs() < 0.001);
        assert!((graph_before.y - graph_after.y).abs() < 0.001);
    }

    #[test]
    fn zoom_controls_move_both_directions_and_stay_bounded() {
        let origin = Pos2::ZERO;
        let cursor = Pos2::new(400.0, 300.0);
        let pan = Vec2::ZERO;

        let (_, zoomed_in) = zoom_about(pan, 1.0, origin, cursor, 1.15);
        let (_, zoomed_out) = zoom_about(pan, 1.0, origin, cursor, 1.0 / 1.15);
        let (_, minimum) = zoom_about(pan, 0.3, origin, cursor, 0.01);
        let (_, maximum) = zoom_about(pan, 2.8, origin, cursor, 100.0);

        assert!(zoomed_in > 1.0);
        assert!(zoomed_out < 1.0);
        assert_eq!(minimum, 0.3);
        assert_eq!(maximum, 2.8);
    }

    #[test]
    fn drag_prefers_neighbor_alignment_over_the_grid() {
        let anchor = eframe::egui::Rect::from_min_size(Pos2::new(3.0, 4.0), Vec2::new(100.0, 60.0));
        let neighbor =
            eframe::egui::Rect::from_min_size(Pos2::new(151.0, 84.0), Vec2::new(100.0, 60.0));

        let snapped = snap_drag(anchor, Vec2::new(146.0, 77.0), &[neighbor], 8.0, 6.0);

        assert_eq!(snapped.delta, Vec2::new(148.0, 80.0));
        assert_eq!(
            snapped.guides.x,
            Some(SnapGuide {
                coordinate: 151.0,
                source: SnapSource::Node,
            })
        );
        assert_eq!(
            snapped.guides.y,
            Some(SnapGuide {
                coordinate: 84.0,
                source: SnapSource::Node,
            })
        );
    }

    #[test]
    fn drag_magnetizes_to_grid_when_no_neighbor_is_close() {
        let anchor = eframe::egui::Rect::from_min_size(Pos2::new(0.0, 0.0), Vec2::new(100.0, 60.0));

        let snapped = snap_drag(anchor, Vec2::new(37.0, 63.0), &[], 8.0, 4.0);

        assert_eq!(snapped.delta, Vec2::new(40.0, 60.0));
        assert_eq!(snapped.guides.x.unwrap().source, SnapSource::Grid);
        assert_eq!(snapped.guides.y.unwrap().source, SnapSource::Grid);
    }

    #[test]
    fn drag_remains_free_outside_the_magnetic_threshold() {
        let anchor = eframe::egui::Rect::from_min_size(Pos2::new(0.0, 0.0), Vec2::new(100.0, 60.0));

        let snapped = snap_drag(anchor, Vec2::new(31.0, 69.0), &[], 8.0, 4.0);

        assert_eq!(snapped.delta, Vec2::new(31.0, 69.0));
        assert_eq!(snapped.guides, SnapGuides::default());
        assert_eq!(
            snap_point_to_grid(Pos2::new(31.0, 69.0)),
            Pos2::new(40.0, 60.0)
        );
    }

    #[test]
    fn drag_accumulates_pointer_motion_across_frames() {
        let after_first = advance_drag_delta(Vec2::ZERO, Vec2::new(7.0, 3.0));
        let after_second = advance_drag_delta(after_first, Vec2::new(5.0, -1.0));

        assert_eq!(after_second, Vec2::new(12.0, 2.0));
    }

    #[test]
    fn selection_supports_replace_add_toggle_and_edges() {
        let mut selection = Selection::default();
        selection.select_many(["a".into(), "b".into()], SelectionMode::Replace);
        assert_eq!(selection.len(), 2);
        assert_eq!(selection.primary(), Some("b"));

        selection.select_node("c", SelectionMode::Add);
        selection.select_node("b", SelectionMode::Toggle);
        assert!(selection.contains("a"));
        assert!(!selection.contains("b"));
        assert!(selection.contains("c"));

        selection.select_edge("wire1");
        assert_eq!(selection.len(), 0);
        assert_eq!(selection.edge(), Some("wire1"));
    }

    #[test]
    fn rename_updates_node_and_edge_identity_transactionally() {
        let mut graph = graph();
        connect(&mut graph, &Connection::new("a", "out", "b", "in")).unwrap();

        assert!(rename_node(&mut graph, "b", "quality-check").unwrap());
        assert!(graph.node("b").is_none());
        assert!(graph.node("quality-check").is_some());
        assert_eq!(graph.edges[0].to_node, "quality-check");
        assert!(graph.edges[0].id.contains("quality-check"));

        let before = graph.clone();
        assert!(rename_node(&mut graph, "quality-check", "bad name").is_err());
        assert_eq!(graph, before);
    }
}
