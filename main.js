/* Plugin Depot — dashboard + updater for Obsidian plugins distributed via
 * GitHub releases (outside the community marketplace).
 *
 * Plain CommonJS on purpose: no build step, so the plugin's own release
 * assets are these exact source files. Auth rides the GitHub CLI (`gh`) —
 * the depot never stores or handles tokens itself.
 *
 * Security posture (see SECURITY.md before changing any of this):
 *  - execFile only, never a shell — no argv string is interpolated.
 *  - No remote-controlled string is ever passed to a command. The only
 *    remote field consumed is the release tag_name, and it is only
 *    version-compared and rendered.
 *  - All rendering is text-node only (createEl/createDiv with text).
 *    Never innerHTML. Remote text (tag names, gh error output) is
 *    untrusted — including as prompt-injection payloads for any LLM that
 *    reads this UI or its logs.
 *  - Release notes / repo descriptions / issues / comments are deliberately
 *    NOT fetched. Adding them means adding an untrusted-content surface;
 *    don't, without updating SECURITY.md.
 */

const { ItemView, Plugin, Notice } = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const VIEW_TYPE = "plugin-depot";

/* Default registry — seed entries for this deployment. Overridden by a
 * `registry` array in the plugin's data.json (Settings storage), which is
 * how an open-source install configures its own list. Fields:
 *   id         plugin folder id under .obsidian/plugins/
 *   name       display name
 *   repo       owner/repo carrying GitHub releases
 *   assets     release asset filenames pulled on update
 *   nativeDeps true = plugin dir needs runtime pieces (node_modules) a
 *              release does not carry; fresh installs need separate setup
 *   reloadNote shown after an update downloads, before the user reloads
 */
const DEFAULT_REGISTRY = [
  {
    id: "workspace-shell",
    name: "Workspace Shell",
    repo: "matzek-systems/workspace-shell",
    assets: ["main.js", "manifest.json", "styles.css"],
    nativeDeps: true,
    reloadNote: "Live terminal seats reconnect via resume-on-reattach after reload.",
  },
  {
    id: "plugin-depot",
    name: "Plugin Depot",
    repo: "matzek-systems/plugin-depot",
    assets: ["main.js", "manifest.json", "styles.css"],
  },
  {
    id: "vault-toolkit",
    name: "Vault Toolkit",
    repo: "matzek-systems/vault-toolkit",
    assets: ["main.js", "manifest.json", "styles.css"],
  },
  {
    id: "vault-dashboard",
    name: "Vault Dashboard",
    repo: "matzek-systems/vault-dashboard",
    assets: ["main.js", "manifest.json", "styles.css"],
  },
  {
    id: "vault-search-indexer",
    name: "Vault Search Indexer",
    repo: "matzek-systems/vault-search-indexer",
    assets: ["main.js", "manifest.json", "styles.css"],
  },
];

const GH_FALLBACK = "C:\\Program Files\\GitHub CLI\\gh.exe";

function ghBinary() {
  return fs.existsSync(GH_FALLBACK) ? GH_FALLBACK : "gh";
}

function gh(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      ghBinary(),
      args,
      { windowsHide: true, cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || "").trim()));
        else resolve(stdout.trim());
      },
    );
  });
}

function semverParts(v) {
  return String(v || "")
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function semverLt(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

class PluginDepotView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    /* per-plugin runtime state: {installed, latest, phase, error} */
    this.state = new Map();
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Plugin Depot";
  }

  getIcon() {
    return "layout-grid";
  }

  registry() {
    return this.plugin.settings.registry;
  }

  vaultBase() {
    const ad = this.app.vault.adapter;
    return typeof ad.getBasePath === "function" ? ad.getBasePath() : ad.basePath;
  }

  pluginDir(id) {
    return path.join(this.vaultBase(), ".obsidian", "plugins", id);
  }

  installedVersion(id) {
    try {
      const mf = JSON.parse(
        fs.readFileSync(path.join(this.pluginDir(id), "manifest.json"), "utf8"),
      );
      return mf.version || null;
    } catch {
      return null;
    }
  }

  async onOpen() {
    this.contentEl.addClass("plugin-depot");
    this.render();
    await this.refreshAll();
  }

  async refreshAll() {
    for (const entry of this.registry()) {
      const st = {
        installed: this.installedVersion(entry.id),
        latest: null,
        phase: "checking",
        error: null,
      };
      this.state.set(entry.id, st);
      this.render();
      if (!entry.repo) {
        st.phase = "nochannel";
        this.render();
        continue;
      }
      try {
        const out = await gh([
          "api",
          `repos/${entry.repo}/releases/latest`,
          "--jq",
          ".tag_name",
        ]);
        st.latest = out.replace(/^v/, "");
        st.phase = "idle";
      } catch (e) {
        if (/Not Found|404/.test(e.message)) {
          st.phase = "nochannel";
        } else {
          st.phase = "error";
          st.error = /auth|credentials|login/i.test(e.message)
            ? "gh not authenticated"
            : e.message.slice(0, 120) || "check failed";
        }
      }
      this.render();
    }
  }

  async update(entry) {
    const st = this.state.get(entry.id);
    if (!st || !st.latest) return;
    st.phase = "updating";
    st.error = null;
    this.render();
    const dir = this.pluginDir(entry.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const args = ["release", "download", "-R", entry.repo, "-D", dir, "--clobber"];
      for (const a of entry.assets) args.push("-p", a);
      await gh(args);
      st.installed = this.installedVersion(entry.id);
      st.phase = "updated";
      new Notice(`${entry.name} ${st.installed} downloaded — reload to activate.`);
    } catch (e) {
      st.phase = "error";
      st.error = e.message.slice(0, 160) || "download failed";
    }
    this.render();
  }

  async reload(entry) {
    if (entry.id === this.plugin.manifest.id) {
      new Notice("The depot can't reload itself — toggle it in Community plugins or restart Obsidian.");
      return;
    }
    const plugins = this.app.plugins;
    try {
      await plugins.disablePlugin(entry.id);
      await plugins.enablePlugin(entry.id);
      const st = this.state.get(entry.id);
      if (st) st.phase = "idle";
      new Notice(`${entry.name} reloaded.`);
    } catch (e) {
      new Notice(`Reload failed: ${e.message}`);
    }
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();

    const header = el.createDiv({ cls: "pd-header" });
    header.createEl("h3", { text: "Managed plugins" });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.onclick = () => void this.refreshAll();

    const table = el.createDiv({ cls: "pd-table" });
    for (const entry of this.registry()) {
      const st = this.state.get(entry.id) || {
        installed: this.installedVersion(entry.id),
        latest: null,
        phase: "idle",
        error: null,
      };
      const row = table.createDiv({ cls: "pd-row" });

      const info = row.createDiv({ cls: "pd-info" });
      info.createDiv({ cls: "pd-name", text: entry.name });
      info.createDiv({ cls: "pd-repo", text: entry.repo });

      const ver = row.createDiv({ cls: "pd-versions" });
      ver.createDiv({
        text: `installed: ${st.installed || "not installed"}`,
      });
      ver.createDiv({
        text:
          st.phase === "checking"
            ? "latest: checking…"
            : `latest: ${st.latest || "?"}`,
      });

      const status = row.createDiv({ cls: "pd-status" });
      const actions = row.createDiv({ cls: "pd-actions" });

      if (st.phase === "nochannel") {
        status.createDiv({
          cls: "pd-muted",
          text: entry.repo ? "no release channel yet" : "local only",
        });
      } else if (st.phase === "error") {
        status.createDiv({ cls: "pd-error", text: st.error || "error" });
        const retry = actions.createEl("button", { text: "Retry" });
        retry.onclick = () => void this.refreshAll();
      } else if (st.phase === "updating") {
        status.createDiv({ text: "downloading…" });
      } else if (st.phase === "updated") {
        status.createDiv({ cls: "pd-ok", text: "downloaded — reload to activate" });
        const rb = actions.createEl("button", { cls: "mod-cta", text: "Reload plugin" });
        rb.onclick = () => void this.reload(entry);
        if (entry.reloadNote) row.createDiv({ cls: "pd-note", text: entry.reloadNote });
      } else if (st.latest && !st.installed) {
        status.createDiv({ text: "not installed" });
        const ib = actions.createEl("button", { text: "Install files" });
        ib.onclick = () => void this.update(entry);
        if (entry.nativeDeps)
          row.createDiv({
            cls: "pd-note",
            text: "Needs one-time native runtime setup beyond these files — see the repo README.",
          });
      } else if (st.latest && st.installed && semverLt(st.installed, st.latest)) {
        status.createDiv({ cls: "pd-update", text: "update available" });
        const ub = actions.createEl("button", { cls: "mod-cta", text: "Update" });
        ub.onclick = () => void this.update(entry);
      } else if (st.latest) {
        status.createDiv({ cls: "pd-ok", text: "up to date" });
      }
    }

    el.createDiv({
      cls: "pd-foot",
      text: "Updates download release assets via the GitHub CLI (gh). Auth = your gh login.",
    });
  }
}

const DEFAULT_SETTINGS = {
  registry: DEFAULT_REGISTRY,
};

class PluginDepotPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    this.registerView(VIEW_TYPE, (leaf) => new PluginDepotView(leaf, this));

    this.addRibbonIcon("layout-grid", "Open Plugin Depot", () => void this.activateView());

    this.addCommand({
      id: "open",
      name: "Open Plugin Depot",
      callback: () => void this.activateView(),
    });
  }

  async activateView() {
    // Socketed-app behavior (matches the dashboard's Process Status view):
    // open as a main-workspace tab, reveal the existing one if already open.
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
  }

  onunload() {}
}

module.exports = PluginDepotPlugin;
module.exports.default = PluginDepotPlugin;
