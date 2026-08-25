//! Durable Library shortcuts behind one small interface.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::palette::Mode;

const MAX_RECENT: usize = 8;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct DiskState {
    mode: Mode,
    recent: Vec<String>,
    favorites: BTreeSet<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct LibraryState {
    path: PathBuf,
    state: DiskState,
}

impl LibraryState {
    pub(crate) fn load(path: PathBuf) -> Self {
        let state = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DiskState>(&bytes).ok())
            .map(normalize)
            .unwrap_or_default();
        Self { path, state }
    }

    pub(crate) fn mode(&self) -> Mode {
        self.state.mode
    }

    pub(crate) fn set_mode(&mut self, mode: Mode) -> Result<(), String> {
        if self.state.mode == mode {
            return Ok(());
        }
        self.state.mode = mode;
        self.persist()
    }

    pub(crate) fn recent(&self) -> &[String] {
        &self.state.recent
    }

    pub(crate) fn record(&mut self, operator_id: &str) -> Result<(), String> {
        self.state.recent.retain(|id| id != operator_id);
        self.state.recent.insert(0, operator_id.to_owned());
        self.state.recent.truncate(MAX_RECENT);
        self.persist()
    }

    pub(crate) fn favorites(&self) -> &BTreeSet<String> {
        &self.state.favorites
    }

    pub(crate) fn is_favorite(&self, operator_id: &str) -> bool {
        self.state.favorites.contains(operator_id)
    }

    pub(crate) fn toggle_favorite(&mut self, operator_id: &str) -> Result<bool, String> {
        let favorite = if self.state.favorites.remove(operator_id) {
            false
        } else {
            self.state.favorites.insert(operator_id.to_owned());
            true
        };
        self.persist()?;
        Ok(favorite)
    }

    fn persist(&self) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| format!("no parent directory for {}", self.path.display()))?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Library state filename is not valid UTF-8".to_owned())?;
        let staged = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
        let bytes = serde_json::to_vec_pretty(&self.state).map_err(|error| error.to_string())?;
        fs::write(&staged, bytes).map_err(|error| error.to_string())?;
        fs::rename(&staged, &self.path).map_err(|error| error.to_string())
    }
}

fn normalize(mut state: DiskState) -> DiskState {
    let mut seen = BTreeSet::new();
    state
        .recent
        .retain(|id| !id.is_empty() && seen.insert(id.clone()));
    state.recent.truncate(MAX_RECENT);
    state.favorites.retain(|id| !id.is_empty());
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn roundtrip_keeps_mode_favorites_and_bounded_recents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".axial/library-state.json");
        let mut state = LibraryState::load(path.clone());
        state.set_mode(Mode::Pipelines).unwrap();
        state.toggle_favorite("nf.rnaseq").unwrap();
        for index in 0..10 {
            state.record(&format!("op.{index}")).unwrap();
        }
        state.record("op.7").unwrap();

        let restored = LibraryState::load(path);
        assert_eq!(restored.mode(), Mode::Pipelines);
        assert!(restored.is_favorite("nf.rnaseq"));
        assert_eq!(restored.recent().len(), MAX_RECENT);
        assert_eq!(restored.recent()[0], "op.7");
        assert_eq!(
            restored.recent().iter().filter(|id| *id == "op.7").count(),
            1
        );
    }

    #[test]
    fn malformed_state_falls_back_to_a_clean_library() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("library-state.json");
        fs::write(&path, b"not json").unwrap();

        let state = LibraryState::load(path);
        assert_eq!(state.mode(), Mode::Build);
        assert!(state.recent().is_empty());
        assert!(state.favorites().is_empty());
    }
}
