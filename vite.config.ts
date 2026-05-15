import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React and react-dom are pinned to their own "vendor-react" chunk because
// Univer's UI plugins also import react-dom; without this, Rollup folds
// react-dom into one of the lazy Univer chunks and the eagerly-loaded home
// screen ends up missing its renderer.
//
// All @univerjs/* packages collapse into ONE chunk. Splitting them per family
// (core / ui / sheets / misc) breaks Univer's internal circular imports:
// chunks evaluate before peer chunks' exports are populated, so accesses like
// `CommandType.OPERATION` from @univerjs/sheets hit `undefined` at startup
// and the whole bundle crashes before React mounts. Keeping all Univer in one
// chunk preserves the cycle inside a single module-evaluation pass.
function univerChunks(id: string): string | undefined {
  if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
    return "vendor-react";
  }
  if (id.includes("node_modules/@univerjs/")) {
    return "univer";
  }
  if (id.includes("node_modules/rxjs/")) return "rxjs";
  return undefined;
}

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  // Worktrees under .claude/worktrees/ hold in-flight agent branches.
  // Without this exclude, Vitest discovers their test files too and runs
  // every test 1–6× over.
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.claude/worktrees/**",
      "**/src-tauri/**",
      "**/dist/**",
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: univerChunks,
      },
    },
    // Vite's default modulePreload promotes any chunk reachable from the entry
    // to an eager <link rel="modulepreload">. With manualChunks above, Univer
    // chunks become statically named outputs and get preloaded — defeating the
    // React.lazy() boundary in App.tsx. Filter them out so they load only when
    // EditorScreen actually mounts; Vite's runtime __vitePreload helper still
    // requests them on demand.
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter((d) => !/(?:^|\/)(?:univer\b|rxjs-|vue\.runtime)/.test(d)),
    },
  },
}));
