// pi-tui does not publicly export its constrained layout renderer as of 0.84.3.
// Keep the private import isolated here until a public equivalent is available.
// package.json requires pi-tui >=0.84.2, where this layout contract and the
// overlay input routing needed by fullscreen wheel scrolling are available.
export { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
