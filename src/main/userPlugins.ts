/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "@shared/IpcEvents";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import { existsSync } from "fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";

import { serializeErrors } from "./updater/common";
import { buildVencord, VENCORD_SRC_DIR } from "./utils/buildVencord";
import { extract } from "./utils/extensions";

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

// All or nothing: one bad zip or a failed build installs none of them
async function installUserPlugins(_: IpcMainInvokeEvent, files: unknown) {
    assertCanInstall();
    if (!Array.isArray(files) || !files.length || !files.every(isPluginFile)) throw new Error("Invalid plugin files");

    return withTempDir(async tempDir => {
        const plugins: { root: string; name: string; }[] = [];
        for (const [i, file] of files.entries()) {
            const plugin = await extractPlugin(file, join(tempDir, String(i)));
            if (!FOLDER_NAME_RE.test(plugin.name)) throw new Error(`Invalid plugin folder name "${plugin.name}"`);
            if (plugins.some(p => p.name === plugin.name)) throw new Error(`"${plugin.name}" was selected more than once`);
            if (existsSync(join(USER_PLUGINS_DIR, plugin.name)))
                throw new Error(`A plugin folder named "${plugin.name}" already exists in src/userplugins`);

            plugins.push(plugin);
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
