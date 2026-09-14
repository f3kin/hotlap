import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

// npm's fff export is import-only; resolving its ESM entry before requiring
// it also works without our workspace patch. SEA cannot resolve external ESM
// specifiers, so its staged, patched package keeps the require export path.
const requireForFff = NodeModule.createRequire(import.meta.url);
export const { FileFinder } = requireForFff(
  NodeSea.isSea()
    ? "@ff-labs/fff-node"
    : NodeURL.fileURLToPath(import.meta.resolve("@ff-labs/fff-node")),
) as typeof import("@ff-labs/fff-node");
