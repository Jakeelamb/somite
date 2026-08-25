//! Interaction contract for the temporary surfaces opened from the tool rail.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Surface {
    Library,
    Machine,
    Paper,
    PaperReview,
    OpCreate,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct OverlayState {
    active: Option<Surface>,
}

impl OverlayState {
    pub(crate) fn active(self) -> Option<Surface> {
        self.active
    }

    pub(crate) fn is_open(self, surface: Surface) -> bool {
        self.active == Some(surface)
    }

    pub(crate) fn open(&mut self, surface: Surface) {
        self.active = Some(surface);
    }

    pub(crate) fn toggle(&mut self, surface: Surface) {
        if self.is_open(surface) {
            self.close();
        } else {
            self.open(surface);
        }
    }

    pub(crate) fn close(&mut self) {
        self.active = None;
    }

    pub(crate) fn dismiss_on_click_away(
        &mut self,
        surface: Surface,
        surface_at_frame_start: Option<Surface>,
        clicked_away: bool,
        activator_clicked: bool,
    ) -> bool {
        let should_close = clicked_away
            && !activator_clicked
            && surface_at_frame_start == Some(surface)
            && self.is_open(surface);
        if should_close {
            self.close();
        }
        should_close
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_click_closes_the_active_surface_without_escape() {
        let mut overlays = OverlayState::default();
        overlays.open(Surface::Paper);

        overlays.dismiss_on_click_away(Surface::Paper, Some(Surface::Paper), false, false);
        assert_eq!(overlays.active(), Some(Surface::Paper));

        overlays.dismiss_on_click_away(Surface::Paper, Some(Surface::Paper), true, false);
        assert_eq!(overlays.active(), None);
    }

    #[test]
    fn opening_another_rail_surface_switches_in_one_action() {
        let mut overlays = OverlayState::default();
        overlays.open(Surface::Library);
        overlays.open(Surface::Paper);

        assert_eq!(overlays.active(), Some(Surface::Paper));
    }

    #[test]
    fn active_surface_toggles_closed() {
        let mut overlays = OverlayState::default();
        overlays.toggle(Surface::Library);
        assert_eq!(overlays.active(), Some(Surface::Library));
        overlays.toggle(Surface::Library);
        assert_eq!(overlays.active(), None);
    }

    #[test]
    fn opening_click_does_not_immediately_dismiss_the_surface() {
        let mut overlays = OverlayState::default();
        overlays.open(Surface::Paper);

        overlays.dismiss_on_click_away(Surface::Paper, None, true, true);

        assert_eq!(overlays.active(), Some(Surface::Paper));
    }
}
