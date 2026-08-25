//! Axial's semantic color system.

use eframe::egui::Color32;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Palette {
    pub(crate) canvas: Color32,
    pub(crate) grid: Color32,
    pub(crate) grid_strong: Color32,
    pub(crate) surface: Color32,
    pub(crate) surface_raised: Color32,
    pub(crate) surface_sunken: Color32,
    pub(crate) surface_hover: Color32,
    pub(crate) surface_active: Color32,
    pub(crate) chrome: Color32,
    pub(crate) node: Color32,
    pub(crate) control: Color32,
    pub(crate) border: Color32,
    pub(crate) border_strong: Color32,
    pub(crate) text: Color32,
    pub(crate) text_muted: Color32,
    pub(crate) accent: Color32,
    pub(crate) accent_strong: Color32,
    pub(crate) on_accent: Color32,
    pub(crate) success: Color32,
    pub(crate) warning: Color32,
    pub(crate) danger: Color32,
}

/// Canvas-first dark studio palette inspired by Flora's near-black workspace.
/// Green marks interaction and workflow state; data colors remain categorical.
pub(crate) const GRAPHITE: Palette = Palette {
    canvas: Color32::from_rgb(5, 5, 5),
    grid: Color32::from_rgb(32, 32, 32),
    grid_strong: Color32::from_rgb(53, 53, 53),
    surface: Color32::from_rgb(17, 17, 17),
    surface_raised: Color32::from_rgb(27, 27, 27),
    surface_sunken: Color32::from_rgb(10, 10, 10),
    surface_hover: Color32::from_rgb(34, 34, 34),
    surface_active: Color32::from_rgb(43, 43, 43),
    chrome: Color32::from_rgb(7, 7, 7),
    node: Color32::from_rgb(25, 25, 25),
    control: Color32::from_rgb(14, 14, 14),
    border: Color32::from_rgb(43, 43, 43),
    border_strong: Color32::from_rgb(67, 67, 67),
    text: Color32::from_rgb(244, 244, 241),
    text_muted: Color32::from_rgb(148, 148, 142),
    accent: Color32::from_rgb(111, 212, 137),
    accent_strong: Color32::from_rgb(83, 188, 111),
    on_accent: Color32::from_rgb(5, 18, 9),
    success: Color32::from_rgb(111, 212, 137),
    warning: Color32::from_rgb(224, 174, 79),
    danger: Color32::from_rgb(235, 104, 100),
};

#[cfg(test)]
mod tests {
    use super::*;

    fn linear(channel: u8) -> f32 {
        let value = f32::from(channel) / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    }

    fn luminance(color: Color32) -> f32 {
        0.2126 * linear(color.r()) + 0.7152 * linear(color.g()) + 0.0722 * linear(color.b())
    }

    fn contrast(left: Color32, right: Color32) -> f32 {
        let (light, dark) = if luminance(left) >= luminance(right) {
            (luminance(left), luminance(right))
        } else {
            (luminance(right), luminance(left))
        };
        (light + 0.05) / (dark + 0.05)
    }

    #[test]
    fn graphite_text_roles_clear_accessible_contrast() {
        assert!(contrast(GRAPHITE.text, GRAPHITE.surface) >= 7.0);
        assert!(contrast(GRAPHITE.text_muted, GRAPHITE.surface) >= 4.5);
        assert!(contrast(GRAPHITE.on_accent, GRAPHITE.accent_strong) >= 4.5);
    }

    #[test]
    fn graphite_grid_is_visible_without_competing_with_nodes() {
        assert!(contrast(GRAPHITE.grid, GRAPHITE.canvas) >= 1.2);
        assert!(contrast(GRAPHITE.grid_strong, GRAPHITE.canvas) >= 1.5);
        assert!(
            contrast(GRAPHITE.border, GRAPHITE.canvas) > contrast(GRAPHITE.grid, GRAPHITE.canvas)
        );
    }
}
