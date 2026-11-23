/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "@shared/IpcEvents";
import { parsePluginSource, PLUGIN_FOLDER_RE, PluginSourceManifest, SourcePlugin, SourcePluginSelection } from "@shared/pluginSources";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { existsSync } from "fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "fs/promises";
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

// Downloads each source repo once and installs the selected plugin folders in a single build
async function installFromSources(_: IpcMainInvokeEvent, selections: unknown) {
    assertCanInstall();
    if (!Array.isArray(selections) || !selections.length
        || !selections.every(s => typeof s?.url === "string" && typeof s?.folder === "string" && PLUGIN_FOLDER_RE.test(s.folder)))
        throw new Error("Invalid plugin selection");

    const byRepo = new Map<string, { source: ReturnType<typeof sourceFromUrl>; folders: string[]; }>();
    for (const { url, folder } of selections as SourcePluginSelection[]) {
        const source = sourceFromUrl(url);
        const entry = byRepo.get(source.url) ?? { source, folders: [] };
        entry.folders.push(folder);
        byRepo.set(source.url, entry);
    }

    return withTempDir(async tempDir => {
        const plugins: { root: string; name: string; }[] = [];
        for (const [i, { source, folders }] of [...byRepo.values()].entries()) {
            const repoName = `${source.owner}/${source.repo}`;
            const zip = await fetchBuffer(`https://codeload.github.com/${source.owner}/${source.repo}/zip/HEAD`, {
                headers: { "User-Agent": VENCORD_USER_AGENT },
                signal: AbortSignal.timeout(60_000)
            }).catch(err => {
                throw new Error(`Couldn't download ${repoName}`, { cause: err });
            });

            const outDir = join(tempDir, String(i));
            await extract(zip, outDir);

            // GitHub archives contain a single "<repo>-<ref>" folder
            const [top, ...rest] = await readdir(outDir);
            if (!top || rest.length) throw new Error(`Unexpected archive layout for ${repoName}`);

            for (const folder of folders) {
                const root = ensureSafePath(join(outDir, top, "plugins"), folder);
                if (!root || !existsSync(root) || !hasEntry(await readdir(root)))
                    throw new Error(`${repoName} has no plugin folder "plugins/${folder}"`);

                plugins.push({ root, name: folder });
            }
        }

        return installPluginDirs(plugins);
    });
}

// Replaces an installed user plugin with a new zip, restoring the old version if the build fails
async function updateUserPlugin(_: IpcMainInvokeEvent, folderName: unknown, file: unknown) {
    assertCanInstall();
    if (typeof folderName !== "string" || !isPluginFile(file)) throw new Error("Invalid plugin file");

    // folderName comes from PluginMeta, e.g. "src/userplugins/myPlugin.desktop"
    const name = basename(folderName);
    if (!FOLDER_NAME_RE.test(name)) throw new Error(`Invalid plugin folder name "${name}"`);

    const target = join(USER_PLUGINS_DIR, name);
    if (!existsSync(target)) throw new Error(`"${name}" is not installed in src/userplugins`);

    return withTempDir(async tempDir => {
        const { root } = await extractPlugin(file, join(tempDir, "new"));

        const backup = join(tempDir, "old");
        await cp(target, backup, { recursive: true });

        let built = false;
        try {
            await rm(target, { recursive: true, force: true });
            await cp(root, target, { recursive: true });
            built = await buildVencord();
        } finally {
            if (!built) {
                await rm(target, { recursive: true, force: true });
                await cp(backup, target, { recursive: true });
            }
        }
        if (!built) throw new Error("Build failed, so the previous version was kept");

        return name;
    });
}

ipcMain.handle(IpcEvents.INSTALL_USER_PLUGIN, serializeErrors(installUserPlugins));
ipcMain.handle(IpcEvents.UPDATE_USER_PLUGIN, serializeErrors(updateUserPlugin));
ipcMain.handle(IpcEvents.GET_PLUGIN_SOURCE, serializeErrors(getPluginSource));
ipcMain.handle(IpcEvents.INSTALL_FROM_PLUGIN_SOURCES, serializeErrors(installFromSources));
