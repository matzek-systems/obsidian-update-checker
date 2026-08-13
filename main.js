/* Update Checker — dashboard + updater for Obsidian plugins distributed via
 * GitHub releases (outside the community marketplace).
 *
 * Plain CommonJS on purpose: no build step, so the plugin's own release
 * assets are these exact source files. Auth rides the GitHub CLI (`gh`) —
 * the checker never stores or handles tokens itself.
 *
 * Baseline model: every successful update writes an assets-only baseline
 * ({asset -> sha256} at the installed version) into the vault's baseline
 * folder (default: 00_System/AI/Claude/System Operations/update-checker/).
 * "Modified" always means changed relative to what the INSTALLED edition
 * shipped — never relative to the newest release. Baselines are write-once
 * per update, not a running process.
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
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VIEW_TYPE = "update-checker";

/* Default registry — seed entries for this deployment. Overridden by a
 * `registry` array in the plugin's data.json (Settings storage), which is
 * how each install configures its own list. Fields:
 *   id         plugin folder id under .obsidian/plugins/
 *   name       display name
 *   repo       owner/repo carrying GitHub releases (null = local only)
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
    id: "update-checker",
    name: "Update Checker",
    repo: "matzek-systems/update-checker",
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

const DEFAULT_SETTINGS = {
  registry: DEFAULT_REGISTRY,
  /* vault-relative folder where per-plugin installed baselines live */
  baselineDir: "00_System/AI/Claude/System Operations/update-checker",
};

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

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function semverParts(v) {
  return String(v || "")
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function semverCmp(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

class UpdateCheckerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    /* per-plugin runtime state:
     * {installed, latest, phase, error, baseline: "clean"|"modified"|"none", changed: []} */
    this.state = new Map();
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Update Checker";
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

  baselinePath(id) {
    const parts = this.plugin.settings.baselineDir.split("/");
    return path.join(this.vaultBase(), ...parts, `${id}.json`);
  }

  installedVersion(id) {
    try {
      const raw = fs.readFileSync(path.join(this.pluginDir(id), "manifest.json"), "utf8");
      const mf = JSON.parse(raw.replace(/^\uFEFF/, ""));
      return mf.version || null;
    } catch {
      return null;
    }
  }

  /* Compare local assets against the stored baseline for this plugin.
   * Returns {state: "clean"|"modified"|"none", changed: [names]}.
   * "none" = no baseline recorded (or baseline is for a different version,
   * which means it predates/postdates this install and can't judge it). */
  baselineCheck(entry, installedVersion) {
    let baseline;
    try {
      baseline = JSON.parse(fs.readFileSync(this.baselinePath(entry.id), "utf8"));
    } catch {
      return { state: "none", changed: [] };
    }
    if (!baseline.files || (baseline.version && installedVersion && baseline.version !== installedVersion)) {
      return { state: "none", changed: [] };
    }
    const changed = [];
    for (const [name, hash] of Object.entries(baseline.files)) {
      const fp = path.join(this.pluginDir(entry.id), name);
      try {
        if (sha256File(fp) !== hash) changed.push(name);
      } catch {
        changed.push(`${name} (missing)`);
      }
    }
    return { state: changed.length ? "modified" : "clean", changed };
  }

  /* Write a fresh baseline for the plugin's current on-disk assets. */
  writeBaseline(entry) {
    const dir = this.pluginDir(entry.id);
    const files = {};
    const assets = entry.assets && entry.assets.length ? entry.assets : ["main.js", "manifest.json", "styles.css"];
    for (const a of assets) {
      const fp = path.join(dir, a);
      if (fs.existsSync(fp)) files[a] = sha256File(fp);
    }
    const out = {
      generated: new Date().toISOString(),
      id: entry.id,
      version: this.installedVersion(entry.id),
      files,
    };
    const bp = this.baselinePath(entry.id);
    fs.mkdirSync(path.dirname(bp), { recursive: true });
    fs.writeFileSync(bp, JSON.stringify(out, null, 2) + "\n", "utf8");
  }

  async onOpen() {
    this.contentEl.addClass("update-checker");
    this.render();
    await this.refreshAll();
  }

  async refreshAll() {
    for (const entry of this.registry()) {
      const installed = this.installedVersion(entry.id);
      const st = {
        installed,
        latest: null,
        phase: "checking",
        error: null,
        ...this.baselineCheck(entry, installed),
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
      this.writeBaseline(entry);
      Object.assign(st, this.baselineCheck(entry, st.installed));
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
      new Notice("The checker can't reload itself — toggle it in Community plugins or restart Obsidian.");
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

  /* Derive the status cell for a row that has completed its check. */
  renderIdleStatus(entry, st, status, actions, row) {
    const cmp = st.installed && st.latest ? semverCmp(st.installed, st.latest) : null;
    if (!st.installed) {
      status.createDiv({ text: "not installed" });
      const ib = actions.createEl("button", { text: "Install files" });
      ib.onclick = () => void this.update(entry);
      if (entry.nativeDeps)
        row.createDiv({
          cls: "uc-note",
          text: "Needs one-time native runtime setup beyond these files — see the repo README.",
        });
      return;
    }
    if (cmp === -1) {
      status.createDiv({ cls: "uc-update", text: "update available" });
      const ub = actions.createEl("button", { cls: "mod-cta", text: "Update" });
      ub.onclick = () => void this.update(entry);
      if (st.state === "modified")
        row.createDiv({
          cls: "uc-note",
          text: `Local modifications vs installed edition: ${st.changed.join(", ")} — updating overwrites them.`,
        });
      return;
    }
    if (cmp === 1) {
      status.createDiv({ cls: "uc-ahead", text: `ahead of release (${st.installed} > ${st.latest})` });
      return;
    }
    // same version as latest release
    if (st.state === "modified") {
      status.createDiv({ cls: "uc-modified", text: `modified (${st.changed.join(", ")})` });
      return;
    }
    status.createDiv({ cls: "uc-ok", text: st.state === "clean" ? "up to date · verified" : "up to date" });
  }

  render() {
    const el = this.contentEl;
    el.empty();

    const header = el.createDiv({ cls: "uc-header" });
    header.createEl("h3", { text: "Managed plugins" });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.onclick = () => void this.refreshAll();

    const table = el.createDiv({ cls: "uc-table" });
    for (const entry of this.registry()) {
      const st = this.state.get(entry.id) || {
        installed: this.installedVersion(entry.id),
        latest: null,
        phase: "idle",
        error: null,
        state: "none",
        changed: [],
      };
      const row = table.createDiv({ cls: "uc-row" });

      const info = row.createDiv({ cls: "uc-info" });
      info.createDiv({ cls: "uc-name", text: entry.name });
      info.createDiv({ cls: "uc-repo", text: entry.repo || "no remote" });

      const ver = row.createDiv({ cls: "uc-versions" });
      ver.createDiv({ text: `installed: ${st.installed || "—"}` });
      ver.createDiv({
        text:
          st.phase === "checking"
            ? "latest: checking…"
            : `latest: ${st.latest || "—"}`,
      });

      const status = row.createDiv({ cls: "uc-status" });
      const actions = row.createDiv({ cls: "uc-actions" });

      if (st.phase === "checking") {
        status.createDiv({ cls: "uc-muted", text: "checking…" });
      } else if (st.phase === "nochannel") {
        if (st.state === "modified") {
          status.createDiv({ cls: "uc-modified", text: `modified (${st.changed.join(", ")})` });
        } else if (st.state === "clean") {
          status.createDiv({ cls: "uc-ok", text: "matches baseline" });
        } else {
          status.createDiv({
            cls: "uc-muted",
            text: entry.repo ? "no release channel yet" : "local only",
          });
        }
      } else if (st.phase === "error") {
        status.createDiv({ cls: "uc-error", text: st.error || "error" });
        const retry = actions.createEl("button", { text: "Retry" });
        retry.onclick = () => void this.refreshAll();
      } else if (st.phase === "updating") {
        status.createDiv({ text: "downloading…" });
      } else if (st.phase === "updated") {
        status.createDiv({ cls: "uc-ok", text: "downloaded — reload to activate" });
        const rb = actions.createEl("button", { cls: "mod-cta", text: "Reload plugin" });
        rb.onclick = () => void this.reload(entry);
        if (entry.reloadNote) row.createDiv({ cls: "uc-note", text: entry.reloadNote });
      } else {
        this.renderIdleStatus(entry, st, status, actions, row);
      }
    }

    el.createDiv({
      cls: "uc-foot",
      text: "Checks via the GitHub CLI (gh); auth = your gh login. Baselines: " +
        this.plugin.settings.baselineDir,
    });
  }
}

class UpdateCheckerPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    this.registerView(VIEW_TYPE, (leaf) => new UpdateCheckerView(leaf, this));

    this.addRibbonIcon("layout-grid", "Open Update Checker", () => void this.activateView());

    this.addCommand({
      id: "open",
      name: "Open Update Checker",
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

module.exports = UpdateCheckerPlugin;
module.exports.default = UpdateCheckerPlugin;
