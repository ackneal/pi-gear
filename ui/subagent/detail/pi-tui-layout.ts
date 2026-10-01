import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Resolve the internal module explicitly: Pi's loader aliases the package root
// to index.js, which breaks static subpath imports.
const require = createRequire(import.meta.url);
export const { renderLayoutFrame } = require(join(dirname(require.resolve("@earendil-works/pi-tui")), "layout.js")) as typeof import("@earendil-works/pi-tui/dist/layout.js");
