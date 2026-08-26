type ZoomWheelEvent = {
  ctrlKey: boolean;
  target: unknown;
  preventDefault: () => void;
};

type ClosestTarget = {
  closest: (selector: string) => unknown;
};

function canFindAncestor(target: unknown): target is ClosestTarget {
  return typeof target === "object"
    && target !== null
    && "closest" in target
    && typeof target.closest === "function";
}

/** Keep trackpad pinch routed to React Flow instead of browser page zoom. */
export function preventBrowserZoomOutsideCanvas(event: ZoomWheelEvent) {
  if (!event.ctrlKey) return;
  if (canFindAncestor(event.target) && event.target.closest(".react-flow")) return;
  event.preventDefault();
}
