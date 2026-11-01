import { fileURLToPath } from "node:url";

// Development checkout root (dist/src -> repository). Not used by the packaged server.
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
