/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "@shared/IpcEvents";
import { parsePluginSource, PLUGIN_FOLDER_RE, PluginSourceManifest, SourcePlugin, SourcePluginSelection, SourcePluginUpdate } from "@shared/pluginSources";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { existsSync } from "fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";

import { serializeErrors } from "./updater/common";
import { buildVencord, VENCORD_SRC_DIR } from "./utils/buildVencord";
import { ensureSafePath } from "./utils/ensureSafePath";
import { extract } from "./utils/extensions";
import { fetchBuffer, fetchJson } from "./utils/http";

const USER_PLUGINS_DIR = join(VENCORD_SRC_DIR, "src", "userplugins");
const ENTRY_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];
const FOLDER_NAME_RE = /^[\w-][\w.-]*$/;

interface PluginFile {
    fileName: string;
    data: Uint8Array;
}

const hasEntry = (files: string[]) => ENTRY_FILES.some(f => files.includes(f));

function isPluginFile(file: unknown): file is PluginFile {
    return typeof file === "object" && file !== null
        && typeof (file as any).fileName === "string" && (file as any).data instanceof Uint8Array;
}

// Zips either contain the plugin files directly or a single top level folder (e.g. GitHub downloads)
async function findPluginRoot(dir: string, zipName: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (hasEntry(entries.map(e => e.name))) return { root: dir, name: zipName };

    const [first] = entries;
    if (entries.length === 1 && first.isDirectory()) {
        const root = join(dir, first.name);
        if (hasEntry(await readdir(root))) return { root, name: first.name };
    }

    throw new Error(`${zipName}.zip does not contain a plugin. Expected an index.ts or index.tsx file`);
}

async function extractPlugin({ fileName, data }: PluginFile, outDir: string) {
    await extract(Buffer.from(data), outDir).catch(err => {
        throw new Error(`${fileName}: ${err.message}`);
    });

    return findPluginRoot(outDir, fileName.replace(/\.zip$/i, ""));
}

function assertCanInstall() {
    if (IS_STANDALONE) throw new Error("Installing plugins requires Vencord to be installed from source");
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), "vencord-plugin-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

// All or nothing: one invalid plugin or a failed build installs none of them
async function installPluginDirs(plugins: { root: string; name: string; }[]) {
    for (const [i, { name }] of plugins.entries()) {
        if (!FOLDER_NAME_RE.test(name)) throw new Error(`Invalid plugin folder name "${name}"`);
        if (plugins.findIndex(p => p.name === name) !== i) throw new Error(`"${name}" was selected more than once`);
        if (existsSync(join(USER_PLUGINS_DIR, name)))
            throw new Error(`A plugin folder named "${name}" already exists in src/userplugins`);
    }

    await mkdir(USER_PLUGINS_DIR, { recursive: true });

    const installed: string[] = [];
    let built = false;
    try {
        for (const { root, name } of plugins) {
            installed.push(name);
            await cp(root, join(USER_PLUGINS_DIR, name), { recursive: true });
        }
        built = await buildVencord();
    } finally {
        // a broken plugin would otherwise break every future build
        if (!built) await Promise.all(installed.map(name => rm(join(USER_PLUGINS_DIR, name), { recursive: true, force: true })));
    }
    if (!built) throw new Error("Build failed, so no plugins were installed");

    return installed;
}

async function installUserPlugins(_: IpcMainInvokeEvent, files: unknown) {
    assertCanInstall();
    if (!Array.isArray(files) || !files.length || !files.every(isPluginFile)) throw new Error("Invalid plugin files");

    return withTempDir(async tempDir => {
        const plugins: { root: string; name: string; }[] = [];
        for (const [i, file] of files.entries())
            plugins.push(await extractPlugin(file, join(tempDir, String(i))));

        return installPluginDirs(plugins);
    });
}

function sourceFromUrl(url: unknown) {
    const source = typeof url === "string" ? parsePluginSource(url) : null;
    if (!source) throw new Error("Plugin sources must be GitHub repository links, like https://github.com/owner/repo");
    return source;
}

function toSourcePlugin(p: any): SourcePlugin | null {
    if (typeof p !== "object" || p === null) return null;
    if (typeof p.name !== "string" || !p.name || typeof p.folder !== "string" || !PLUGIN_FOLDER_RE.test(p.folder)) return null;

    const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
    return {
        name: p.name,
        folder: p.folder,
        description: str(p.description),
        category: str(p.category, "Other"),
        version: str(p.version),
        authors: Array.isArray(p.authors)
            ? p.authors.filter((a: any) => typeof a?.name === "string").map((a: any) => ({ name: a.name, github: str(a.github) || undefined }))
            : [],
        target: typeof p.target === "string" ? p.target : null,
        requirements: Array.isArray(p.requirements) ? p.requirements.filter((r: unknown) => typeof r === "string") : []
    };
}

async function getPluginSource(_: IpcMainInvokeEvent, url: unknown): Promise<PluginSourceManifest> {
    const source = sourceFromUrl(url);

    let manifest: any;
    try {
        manifest = await fetchJson(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/HEAD/plugins.json`, {
            headers: { "User-Agent": VENCORD_USER_AGENT },
            signal: AbortSignal.timeout(15_000)
        });
    } catch (err) {
        throw new Error(`Couldn't load plugins.json from ${source.owner}/${source.repo}. Is it a public plugin source?`, { cause: err });
    }

    if (!Array.isArray(manifest?.plugins)) throw new Error(`${source.owner}/${source.repo} has an invalid plugins.json`);

    return {
        url: source.url,
        name: typeof manifest.name === "string" && manifest.name ? manifest.name : `${source.owner}/${source.repo}`,
        plugins: manifest.plugins.map(toSourcePlugin).filter((p: SourcePlugin | null): p is SourcePlugin => p !== null)
    };
}

const isSelection = (s: any): s is SourcePluginSelection =>
    typeof s?.url === "string" && typeof s?.folder === "string" && PLUGIN_FOLDER_RE.test(s.folder);

// Downloads each source repo once and returns the folder of every selected plugin, in order
async function downloadSourcePlugins(tempDir: string, selections: SourcePluginSelection[]) {
    const pluginDirs = new Map<string, string>();
    for (const { url } of selections) {
        const source = sourceFromUrl(url);
        if (pluginDirs.has(source.url)) continue;

        const repoName = `${source.owner}/${source.repo}`;
        const zip = await fetchBuffer(`https://codeload.github.com/${source.owner}/${source.repo}/zip/HEAD`, {
            headers: { "User-Agent": VENCORD_USER_AGENT },
            signal: AbortSignal.timeout(60_000)
        }).catch(err => {
            throw new Error(`Couldn't download ${repoName}`, { cause: err });
        });

        const outDir = join(tempDir, `source-${pluginDirs.size}`);
        await extract(zip, outDir);

        // GitHub archives contain a single "<repo>-<ref>" folder
        const [top, ...rest] = await readdir(outDir);
        if (!top || rest.length) throw new Error(`Unexpected archive layout for ${repoName}`);

        pluginDirs.set(source.url, join(outDir, top, "plugins"));
    }

    const roots: string[] = [];
    for (const { url, folder } of selections) {
        const source = sourceFromUrl(url);
        const pluginsDir = pluginDirs.get(source.url);
        const root = pluginsDir && ensureSafePath(pluginsDir, folder);
        if (!root || !existsSync(root) || !hasEntry(await readdir(root)))
            throw new Error(`${source.owner}/${source.repo} has no plugin folder "plugins/${folder}"`);

        roots.push(root);
    }
    return roots;
}

async function installFromSources(_: IpcMainInvokeEvent, selections: unknown) {
    assertCanInstall();
    if (!Array.isArray(selections) || !selections.length || !selections.every(isSelection))
        throw new Error("Invalid plugin selection");

    return withTempDir(async tempDir => {
        const roots = await downloadSourcePlugins(tempDir, selections);
        return installPluginDirs(selections.map(({ folder }, i) => ({ root: roots[i], name: folder })));
    });
}

// Swaps installed plugin folders for new versions in one build, restoring every old version if the build fails
async function replacePluginDirs(plugins: { root: string; name: string; }[], backupDir: string) {
    for (const [i, { name }] of plugins.entries()) {
        if (!FOLDER_NAME_RE.test(name)) throw new Error(`Invalid plugin folder name "${name}"`);
        if (plugins.findIndex(p => p.name === name) !== i) throw new Error(`"${name}" was selected more than once`);
        if (!existsSync(join(USER_PLUGINS_DIR, name))) throw new Error(`"${name}" is not installed in src/userplugins`);
    }

    for (const { name } of plugins)
        await cp(join(USER_PLUGINS_DIR, name), join(backupDir, name), { recursive: true });

    const replaced: string[] = [];
    let built = false;
    try {
        for (const { root, name } of plugins) {
            replaced.push(name);
            await rm(join(USER_PLUGINS_DIR, name), { recursive: true, force: true });
            await cp(root, join(USER_PLUGINS_DIR, name), { recursive: true });
        }
        built = await buildVencord();
    } finally {
        if (!built) {
            for (const name of replaced) {
                await rm(join(USER_PLUGINS_DIR, name), { recursive: true, force: true });
                await cp(join(backupDir, name), join(USER_PLUGINS_DIR, name), { recursive: true });
            }
        }
    }
    if (!built) throw new Error("Build failed, so the previous versions were kept");

    return plugins.map(p => p.name);
}

// Replaces an installed user plugin with a new zip
async function updateUserPlugin(_: IpcMainInvokeEvent, folderName: unknown, file: unknown) {
    assertCanInstall();
    if (typeof folderName !== "string" || !isPluginFile(file)) throw new Error("Invalid plugin file");

    return withTempDir(async tempDir => {
        const { root } = await extractPlugin(file, join(tempDir, "new"));
        // folderName comes from PluginMeta, e.g. "src/userplugins/myPlugin.desktop"
        const [name] = await replacePluginDirs([{ root, name: basename(folderName) }], join(tempDir, "backup"));
        return name;
    });
}

// Replaces installed user plugins with the latest version from their source, keeping the installed folder names
async function updateFromSources(_: IpcMainInvokeEvent, updates: unknown) {
    assertCanInstall();
    if (!Array.isArray(updates) || !updates.length
        || !updates.every(u => isSelection(u) && typeof (u as SourcePluginUpdate).installedFolder === "string"))
        throw new Error("Invalid plugin update");

    return withTempDir(async tempDir => {
        const list = updates as SourcePluginUpdate[];
        const roots = await downloadSourcePlugins(tempDir, list);
        return replacePluginDirs(list.map(({ installedFolder }, i) => ({ root: roots[i], name: installedFolder })), join(tempDir, "backup"));
    });
}

// Versions come from the plugin.json that marketplace plugins ship with; plugins without one report null
async function getUserPluginVersions() {
    const versions: Record<string, string | null> = {};
    if (!existsSync(USER_PLUGINS_DIR)) return versions;

    for (const entry of await readdir(USER_PLUGINS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
            const meta = JSON.parse(await readFile(join(USER_PLUGINS_DIR, entry.name, "plugin.json"), "utf8"));
            versions[entry.name] = typeof meta?.version === "string" ? meta.version : null;
        } catch {
            versions[entry.name] = null;
        }
    }
    return versions;
}

ipcMain.handle(IpcEvents.INSTALL_USER_PLUGIN, serializeErrors(installUserPlugins));
ipcMain.handle(IpcEvents.UPDATE_USER_PLUGIN, serializeErrors(updateUserPlugin));
ipcMain.handle(IpcEvents.GET_PLUGIN_SOURCE, serializeErrors(getPluginSource));
ipcMain.handle(IpcEvents.INSTALL_FROM_PLUGIN_SOURCES, serializeErrors(installFromSources));
ipcMain.handle(IpcEvents.UPDATE_FROM_PLUGIN_SOURCES, serializeErrors(updateFromSources));
ipcMain.handle(IpcEvents.GET_USER_PLUGIN_VERSIONS, serializeErrors(getUserPluginVersions));
