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
import { join } from "path";

import { serializeErrors } from "./updater/common";
import { buildVencord, VENCORD_SRC_DIR } from "./utils/buildVencord";
import { extract } from "./utils/extensions";

const USER_PLUGINS_DIR = join(VENCORD_SRC_DIR, "src", "userplugins");
const ENTRY_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

const hasEntry = (files: string[]) => ENTRY_FILES.some(f => files.includes(f));

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

function isPluginFile(file: unknown): file is { fileName: string; data: Uint8Array; } {
    return typeof file === "object" && file !== null
        && typeof (file as any).fileName === "string" && (file as any).data instanceof Uint8Array;
}

// All or nothing: one bad zip or a failed build installs none of them
async function installUserPlugins(_: IpcMainInvokeEvent, files: unknown) {
    if (IS_STANDALONE) throw new Error("Installing plugins requires Vencord to be installed from source");
    if (!Array.isArray(files) || !files.length || !files.every(isPluginFile)) throw new Error("Invalid plugin files");

    const tempDir = await mkdtemp(join(tmpdir(), "vencord-plugin-"));
    const installed: string[] = [];
    try {
        const plugins: { root: string; name: string; }[] = [];
        for (const [i, { fileName, data }] of files.entries()) {
            const outDir = join(tempDir, String(i));
            await extract(Buffer.from(data), outDir).catch(err => {
                throw new Error(`${fileName}: ${err.message}`);
            });

            const plugin = await findPluginRoot(outDir, fileName.replace(/\.zip$/i, ""));
            if (!/^[\w-][\w.-]*$/.test(plugin.name)) throw new Error(`Invalid plugin folder name "${plugin.name}"`);
            if (plugins.some(p => p.name === plugin.name)) throw new Error(`"${plugin.name}" was selected more than once`);
            if (existsSync(join(USER_PLUGINS_DIR, plugin.name)))
                throw new Error(`A plugin folder named "${plugin.name}" already exists in src/userplugins`);

            plugins.push(plugin);
        }

        await mkdir(USER_PLUGINS_DIR, { recursive: true });

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
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

ipcMain.handle(IpcEvents.INSTALL_USER_PLUGIN, serializeErrors(installUserPlugins));
