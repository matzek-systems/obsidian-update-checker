/* Matzek Hub — dashboard + updater for Matzek Systems Obsidian plugins.
 *
 * Plain CommonJS on purpose: no build step, so the plugin's own release
 * assets are these exact source files. Auth rides the GitHub CLI (`gh`),
 * which every seat already has authenticated for org repo access — no
 * token storage in the plugin.
 */

const { ItemView, Plugin, Notice } = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const VIEW_TYPE = "matzek-hub";

/* One entry per distributed plugin. `assets` are the release asset names
 * pulled on update. `nativeDeps: true` = the plugin dir needs runtime
 * pieces (node_modules) a release does NOT carry — fresh installs of those
 * need a separate setup pass; updates are safe (assets only). */
const REGISTRY = [
  {
    id: "workspace-shell",
    name: "Workspace Shell",
    repo: "matzek-systems/workspace-shell",
    assets: ["main.js", "manifest.json", "styles.css"],
    nativeDeps: true,
    reloadNote: "Live terminal seats reconnect via resume-on-reattach after reload.",
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

class MatzekHubView extends ItemView {
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
    return "Matzek Hub";
  }

  getIcon() {
    return "layout-grid";
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
    this.contentEl.addClass("matzek-hub");
    this.render();
    await this.refreshAll();
  }

  async refreshAll() {
    for (const entry of REGISTRY) {
      const st = {
        installed: this.installedVersion(entry.id),
        latest: null,
        phase: "checking",
        error: null,
      };
      this.state.set(entry.id, st);
      this.render();
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
        st.phase = "error";
        st.error = /Not Found|404/.test(e.message)
          ? "no releases"
          : /auth|credentials|login/i.test(e.message)
            ? "gh not authenticated"
            : e.message.slice(0, 120) || "check failed";
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
      new Notice("The hub can't reload itself — toggle it in Community plugins or restart Obsidian.");
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

    const header = el.createDiv({ cls: "mh-header" });
    header.createEl("h3", { text: "Matzek Systems plugins" });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.onclick = () => void this.refreshAll();

    const table = el.createDiv({ cls: "mh-table" });
    for (const entry of REGISTRY) {
      const st = this.state.get(entry.id) || {
        installed: this.installedVersion(entry.id),
        latest: null,
        phase: "idle",
        error: null,
      };
      const row = table.createDiv({ cls: "mh-row" });

      const info = row.createDiv({ cls: "mh-info" });
      info.createDiv({ cls: "mh-name", text: entry.name });
      info.createDiv({ cls: "mh-repo", text: entry.repo });

      const ver = row.createDiv({ cls: "mh-versions" });
      ver.createDiv({
        text: `installed: ${st.installed || "not installed"}`,
      });
      ver.createDiv({
        text:
          st.phase === "checking"
            ? "latest: checking…"
            : `latest: ${st.latest || "?"}`,
      });

      const status = row.createDiv({ cls: "mh-status" });
      const actions = row.createDiv({ cls: "mh-actions" });

      if (st.phase === "error") {
        status.createDiv({ cls: "mh-error", text: st.error || "error" });
        const retry = actions.createEl("button", { text: "Retry" });
        retry.onclick = () => void this.refreshAll();
      } else if (st.phase === "updating") {
        status.createDiv({ text: "downloading…" });
      } else if (st.phase === "updated") {
        status.createDiv({ cls: "mh-ok", text: "downloaded — reload to activate" });
        const rb = actions.createEl("button", { cls: "mod-cta", text: "Reload plugin" });
        rb.onclick = () => void this.reload(entry);
        if (entry.reloadNote) row.createDiv({ cls: "mh-note", text: entry.reloadNote });
      } else if (st.latest && !st.installed) {
        status.createDiv({ text: "not installed" });
        const ib = actions.createEl("button", { text: "Install files" });
        ib.onclick = () => void this.update(entry);
        if (entry.nativeDeps)
          row.createDiv({
            cls: "mh-note",
            text: "Needs one-time native runtime setup beyond these files — see the repo README.",
          });
      } else if (st.latest && st.installed && semverLt(st.installed, st.latest)) {
        status.createDiv({ cls: "mh-update", text: "update available" });
        const ub = actions.createEl("button", { cls: "mod-cta", text: "Update" });
        ub.onclick = () => void this.update(entry);
      } else if (st.latest) {
        status.createDiv({ cls: "mh-ok", text: "up to date" });
      }
    }

    el.createDiv({
      cls: "mh-foot",
      text: "Updates download release assets via the GitHub CLI (gh). Auth = your gh login.",
    });
  }
}

class MatzekHubPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new MatzekHubView(leaf, this));

    this.addRibbonIcon("layout-grid", "Open Matzek Hub", () => void this.activateView());

    this.addCommand({
      id: "open",
      name: "Open Matzek Hub",
      callback: () => void this.activateView(),
    });
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  onunload() {}
}

module.exports = MatzekHubPlugin;
module.exports.default = MatzekHubPlugin;
