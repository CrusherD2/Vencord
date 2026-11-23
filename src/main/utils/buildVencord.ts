/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile as cpExecFile } from "child_process";
import { join } from "path";
import { promisify } from "util";

const execFile = promisify(cpExecFile);

export const VENCORD_SRC_DIR = join(__dirname, "..");

export const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

export async function buildVencord() {
    const opts = { cwd: VENCORD_SRC_DIR };

    const command = isFlatpak ? "flatpak-spawn" : "node";
    const args = isFlatpak ? ["--host", "node", "scripts/build/build.mjs"] : ["scripts/build/build.mjs"];

    if (IS_DEV) args.push("--dev");

    const res = await execFile(command, args, opts);

    return !res.stderr.includes("Build failed");
}
