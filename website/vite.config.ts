import { readFileSync } from "node:fs";
import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

function readHostingConfig(): { d1?: string; r2?: string } {
  try {
    return JSON.parse(
      readFileSync(new URL("./.openai/hosting.json", import.meta.url), "utf8"),
    );
  } catch (error) {
    // Public source checkouts do not include optional Sites hosting metadata.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

const { d1, r2 } = readHostingConfig();

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    // Vinext adds app/**/*.ts to each environment's dependency scan entries.
    // Keep those entries while excluding declaration files from runtime scans.
    environments: {
      client: { optimizeDeps: { entries: ["!**/*.d.ts"] } },
      ssr: { optimizeDeps: { entries: ["!**/*.d.ts"] } },
      rsc: { optimizeDeps: { entries: ["!**/*.d.ts"] } },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
